/**
 * CE QU'UNE ACTION ÉCRIT — les appels Prisma d'écriture lus dans un corps, et les faits d'écriture
 * d'un délégué IMPORTÉ (un niveau, le corps de la fonction appelée seulement).
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import { fonctionsLocales, sansCommentaires } from "./decoupage";

/** Une action qui touche la base — lu sur les appels réellement présents. */
export const RE_ECRITURE = /prisma\s*\.\s*[A-Za-z0-9_]+\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw|\$transaction/;
const RE_MODELE_ECRIT = /(?:prisma|tx)\s*\.\s*([A-Za-z0-9_]+)\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

/** Les modèles Prisma qu'une action ÉCRIT — `prisma.user.update` comme `tx.rowGrant.createMany`. */
export function modelesEcrits(corps: string): string[] {
  const vus = new Set<string>();
  for (const m of corps.matchAll(RE_MODELE_ECRIT)) vus.add(m[1]!);
  return [...vus].sort();
}

/**
 * LES SYMBOLES IMPORTÉS D'UN MODULE DU PROJET — `{ a, b as c }` depuis `@/lib/...` ou
 * `@/platform/...`.
 *
 * On ne retient que le code du DÉPÔT : un import de bibliothèque n'écrit pas dans notre base, et
 * lire `node_modules` pour s'en assurer coûterait un scan du monde à chaque dérivation. Le pont
 * de plateforme (`@/platform/in-process/…`) en fait partie — c'est là que vivent les écrivains
 * qu'Adam et l'ERP partagent, la fabrique documentaire la première : une action qui émet une
 * facture par `emettreDocumentDrive` sortait `ecrit: false`, et la carte de confirmation disait
 * « aucune écriture en base détectée » sur un geste qui inscrit une pièce au registre Legal et
 * consomme un numéro (§118.116, par l'autre porte).
 */
export function importsProjet(source: string): Record<string, string> {
  const table: Record<string, string> = {};
  const re = /import\s*\{([^}]*)\}\s*from\s*"(@\/(?:lib|platform|modules)\/[^"]+)"/g;
  for (const m of sansCommentaires(source).matchAll(re)) {
    for (const brut of m[1]!.split(",")) {
      const t = brut.trim();
      if (!t || t.startsWith("type ")) continue; // un TYPE n'écrit rien
      const nom = (t.includes(" as ") ? t.split(" as ")[1]! : t).trim();
      if (nom) table[nom] = m[2]!;
    }
  }
  return table;
}

/**
 * LES FAITS D'ÉCRITURE D'UN DÉLÉGUÉ IMPORTÉ — et c'est un AUTRE mécanisme que la délégation de
 * formulaire, exactement comme l'en-tête de `decrireAction` l'annonçait.
 *
 * ── POURQUOI IL FALLAIT L'AJOUTER ────────────────────────────────────────────────────────
 *
 * `deleguesDuCorps` ne suit un appel que lorsqu'il reçoit le FORMULAIRE — c'est ce qui lui
 * permet d'en lire les CHAMPS. Une action qui sort son écriture dans un module de domaine
 * (`creerDemandeEtatStock({ actorId, … })`) ne passe aucun formulaire : elle sortait donc
 * `ecrit: false`, `modelesEcrits: []`, `audit: false` — c'est-à-dire un MENSONGE sur une action
 * qui crée une tâche, notifie une personne et journalise.
 *
 * Ce que ce mensonge coûte, mesuré : `executer.ts` lit `contrat.ecrit` pour décider s'il faut
 * RELIRE la ligne écrite (§118.81) — « c'est fait » redevient une parole à croire. 49 actions du
 * parc étaient déjà dans cet état avant ce mécanisme.
 *
 * ── CE QU'IL NE FAIT PAS, ET POURQUOI ────────────────────────────────────────────────────
 *
 * Il n'union QUE les trois faits d'écriture, jamais la liste des CHAMPS : les champs restent
 * gouvernés par la délégation de formulaire, qui seule sait qu'un formulaire a voyagé. Les
 * mélanger ferait déclarer, sur une action, des champs qu'aucun formulaire ne lui apporte.
 *
 * Et il ne suit QU'UN NIVEAU. Une chaîne de délégations est un autre problème : la suivre sans
 * borne ferait lire la moitié du dépôt pour décrire une action, et le premier cycle
 * (`a → b → a`) bouclerait. Un niveau non suivi laisse `ecrit: false` — le même défaut, plus
 * loin — mais jamais un fait FAUX.
 *
 * ── IL LIT LE CORPS DE LA FONCTION APPELÉE, JAMAIS LE MODULE ENTIER ──────────────────────
 *
 * La première version lisait le module en entier, avec une justification qui sonnait juste : un
 * écrivain de domaine découpe souvent son écriture en aides internes. Elle était RUINEUSE, et
 * la mesure l'a dit tout de suite : `requireUser` vient de `@/lib/session`, un module qui écrit
 * `UserSession` — donc **593 actions sur 732 se sont mises à déclarer qu'elles touchaient aux
 * sessions**, un modèle que `generique.ts` INTERDIT. Le chemin générique aurait refusé 604
 * actions sur 732. Un refus à tort est pire que le défaut qu'on corrige (§118.27), et celui-là
 * aurait fermé presque tout l'ERP à Adam pour réparer la description de 46 actions.
 *
 * Ce qu'on lit est donc le CORPS de la fonction effectivement appelée, avec la même mécanique
 * que la délégation locale. Le prix est nommé : si cette fonction délègue à son tour dans son
 * propre module, on ne la suit pas. C'est un fait manquant, pas un fait faux — et la seule des
 * deux erreurs qu'on accepte.
 */
export function faitsEcritureImportes(
  corps: string,
  imports: Readonly<Record<string, string>>,
  /** Le source de chaque module importé, par spécificateur. Fourni par le scanner. */
  sources: Readonly<Record<string, string>>,
): { ecrit: boolean; modelesEcrits: string[]; audit: boolean } {
  const vide = { ecrit: false, modelesEcrits: [] as string[], audit: false };
  const noms = Object.keys(imports);
  if (noms.length === 0) return vide;
  const propre = sansCommentaires(corps);
  const modeles = new Set<string>();
  let ecrit = false;
  let audit = false;
  for (const nom of noms) {
    const spec = imports[nom]!;
    const src = sources[spec];
    if (!src) continue; // module non fourni : on ne devine pas ce qu'il fait
    // L'APPEL doit être présent dans le corps, et pas seulement l'import : une action qui
    // importe un écrivain sans l'appeler n'écrit rien.
    const appel = new RegExp(`(?<![.\\w$])${nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
    if (!appel.test(propre)) continue;
    // LE CORPS DE LA FONCTION APPELÉE, et lui seul. Lire le module entier attribuait à chaque
    // action les écritures de `@/lib/session` par le seul fait qu'elle appelle `requireUser`.
    const corpsDelegue = fonctionsLocales(src)[nom]?.corps;
    if (!corpsDelegue) continue; // le symbole n'est pas une fonction de ce module : on ne devine pas
    if (RE_ECRITURE.test(corpsDelegue)) ecrit = true;
    for (const m of modelesEcrits(corpsDelegue)) modeles.add(m);
    if (/recordAudit\s*\(/.test(corpsDelegue)) audit = true;
  }
  return { ecrit, modelesEcrits: [...modeles].sort(), audit };
}
