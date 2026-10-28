import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Génération de références séquentielles **robuste aux trous**. Les anciennes
 * références basées sur `count()+1` entraient en collision dès qu'un enregistrement
 * était supprimé (le compteur retombait sur une référence existante → violation de
 * contrainte d'unicité → exception non gérée « Application error »). On dérive
 * désormais le prochain numéro du **maximum** réellement présent, et on réessaie en
 * cas de collision concurrente.
 */

/** Prochain numéro à partir d'une liste de références « PREFIX-AAAA-NNN ». */
export function nextRefNumber(refs: string[]): number {
  let max = 0;
  for (const r of refs) {
    const m = /(\d+)\s*$/.exec(r);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** Référence « PREFIX-AAAA-NNN » à partir des références existantes. */
export function buildRef(prefix: string, year: number, existing: string[]): string {
  return `${prefix}-${year}-${String(nextRefNumber(existing)).padStart(3, "0")}`;
}

/**
 * Exécute une création en réessayant si une contrainte d'unicité (P2002) saute —
 * typiquement une collision de référence sous concurrence. `fn` doit recalculer la
 * référence à chaque tentative.
 */
export async function createWithRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SÉRIE, UNE CRÉATION À LA FOIS DANS CE PROCESSUS.
 *
 * `createWithRetry` est un verrou OPTIMISTE : chacun lit le maximum, écrit, et réessaie s'il a
 * perdu. Juste pour deux créations simultanées ; faux pour vingt-cinq. Tous les concurrents lisent
 * le MÊME maximum au même instant, un seul gagne chaque tour, et ils se relancent ensemble — le
 * k-ième a besoin de k essais. MESURÉ (§118.148) : dix bons de commande émis en parallèle, chacun
 * posant sa demande de validation `VAL-AAAA-NNN`, et au-delà du sixième la référence était encore
 * en collision : la demande n'était pas créée, et le BC sortait SANS PORTE, en silence.
 *
 * On ne relève pas le nombre d'essais — la file s'allongerait avec la charge, et le plafond ne
 * ferait que déplacer la mission qui échoue. On SÉRIALISE : les créations d'une même série
 * attendent leur tour ICI, avant d'ouvrir la moindre connexion (un verrou de base tiendrait une
 * connexion du pool pendant qu'il attend, et vingt-cinq attentes affameraient le reste du
 * processus). L'application tourne dans UN processus (`render.yaml`) ; entre deux processus — un
 * script lancé à côté, les workers de la suite de tests — `createWithRetry` reste le filet.
 *
 * Un échec ne bloque pas la file : le suivant passe quand le précédent a fini, bien ou mal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const files = new Map<string, Promise<void>>();

export async function enSerie<T>(serie: string, fn: () => Promise<T>): Promise<T> {
  const precedent = files.get(serie) ?? Promise.resolve();
  let liberer: () => void = () => undefined;
  const monTour = new Promise<void>((resolve) => { liberer = resolve; });
  const queue = precedent.then(() => monTour);
  files.set(serie, queue);
  await precedent;
  try {
    return await fn();
  } finally {
    liberer();
    // Le dernier de la file la retire : une série au repos ne garde rien en mémoire.
    if (files.get(serie) === queue) files.delete(serie);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉFÉRENCE SUIVANTE D'UNE SÉRIE — « OD-2026-137 » — par un COMPTEUR (audit 27/10/2026, DONNEES-12 / ADPRO-08).
 *
 * Chaque série se numérotait en chargeant toutes ses références de l'année puis en prenant le maximum + 1 :
 *   - un coût O(n) à chaque création, qui croît toute l'année ;
 *   - le maximum des lignes VIVANTES : une ligne mise à la corbeille libérait sa référence, une autre la reprenait,
 *     et la restauration échouait (« une référence a été réutilisée depuis ») — mesuré sur les déclarations
 *     d'information médicale et les demandes de paiement, par intermittence, sous la charge de la suite.
 *
 * Désormais une ligne `SerieReference` par série (modèle, préfixe, année) porte le dernier numéro :
 *   - avancé atomiquement par `UPDATE … RETURNING` — deux créations simultanées ne lisent jamais le même numéro,
 *     dans un processus comme entre deux (le verrou en mémoire `enSerie` ne tenait que dans un seul) ;
 *   - amorcé, la première fois, au maximum existant (`existantes`, lu UNE fois par série et par an) ;
 *   - jamais rendu : un numéro attribué ne revient pas, même si la ligne disparaît ou si la transaction qui le
 *     portait est perdue après coup (un trou dans la série vaut mieux qu'une référence reprise).
 *
 * Dans une transaction, passer son client (`client`) : le numéro et la ligne naissent ensemble, ou pas du tout.
 * TOUS les écrivains d'une série doivent passer par ici — un écrivain qui prendrait encore le maximum à la main
 * reprendrait un numéro que le compteur va donner.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type ClientSerie = Prisma.TransactionClient | typeof prisma;

/** Le prochain numéro de la série `cle` ; `plancher` (le maximum existant) n'est lu qu'à la naissance du compteur. */
export async function prochainNumeroDeSerie(cle: string, plancher: () => Promise<number>, client: ClientSerie = prisma): Promise<number> {
  const avance = await client.$queryRaw<{ dernier: number }[]>`
    UPDATE "SerieReference" SET "dernier" = "dernier" + 1, "updatedAt" = now() WHERE "cle" = ${cle} RETURNING "dernier"`;
  if (avance.length > 0) return Number(avance[0].dernier);
  const base = Math.max(0, await plancher());
  const ne = await client.$queryRaw<{ dernier: number }[]>`
    INSERT INTO "SerieReference" ("cle", "dernier", "updatedAt") VALUES (${cle}, ${base + 1}, now())
    ON CONFLICT ("cle") DO UPDATE SET "dernier" = GREATEST("SerieReference"."dernier" + 1, EXCLUDED."dernier"), "updatedAt" = now()
    RETURNING "dernier"`;
  return Number(ne[0].dernier);
}

/** La forme d'une référence de série : préfixe, année, numéro sur trois chiffres au moins. */
export function formaterReference(prefixe: string, annee: number, numero: number): string {
  return `${prefixe}-${annee}-${String(numero).padStart(3, "0")}`;
}

/**
 * LA RÉFÉRENCE SUIVANTE — `modele` nomme la table (deux tables peuvent partager un préfixe), `existantes` rend les
 * références déjà présentes de la série (lues une seule fois, pour amorcer le compteur).
 */
export async function referenceDeSerie(o: {
  modele: Prisma.ModelName;
  prefixe: string;
  annee: number;
  existantes: () => Promise<string[]>;
  client?: ClientSerie;
}): Promise<string> {
  const numero = await prochainNumeroDeSerie(
    `${o.modele}:${o.prefixe}-${o.annee}`,
    async () => nextRefNumber(await o.existantes()) - 1,
    o.client,
  );
  return formaterReference(o.prefixe, o.annee, numero);
}
