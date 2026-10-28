import type { DonneeSensible, Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { chargerCles, type ClesCoffre } from "./cle";
import { empreinte } from "./chiffrement";
import { champSensible, classerValeur, masqueDepuisClair, texteDeColonne, type ChampSensible, type ModeleSensible } from "../domaine/champs";
import { masque as masqueNature, estNatureCoffre, type NatureCoffre } from "../domaine/natures";
import { lecteurDepuisSession } from "./lecteur";
import { peutLire, type LecteurCoffre, type TitulaireLu, type UsageLecture } from "../domaine/politique";

/**
 * LE CONTRÔLE D'ACCÈS AU COFFRE (refonte V2-E) — politique, journal, comparaison par empreinte. Il ne
 * DÉCHIFFRE pas : c'est `lecture.ts` qui le fait, pour les écrans. Les pièces générées par une action
 * (bon de commande, facture) passent par ici seulement (`lireSensiblesSansDechiffrer`) : ces actions sont
 * atteignables par l'assistant, qui ne doit jamais pouvoir importer ce qui déchiffre (`frontiere.test.ts`).
 *
 * Interrupteur `AppSetting.coffreLecture` FERMÉ : la colonne est rendue telle quelle, sans journal — le
 * comportement d'avant, à l'identique (les portes RBAC de chaque écran restent les siennes).
 *
 * OUVERT, pour chaque valeur demandée :
 *   1. la politique décide (`politique.ts` : RH, Finances, titulaire, Super Admin, pièce officielle pour le
 *      RIB d'une organisation ; jamais un modèle d'IA) ;
 *   2. la décision — accord COMME refus — est écrite au journal `AccesDonneeSensible` (qui, quand, quel
 *      geste, quelle colonne) AVANT que la moindre valeur soit rendue : si le journal échoue, rien ne sort ;
 *   3. accordée, la valeur est celle de la colonne (forme canonique), qui fait foi jusqu'au palier P5 ; la
 *      copie du coffre lui est comparée par empreinte — à jour, `lecture.ts` la déchiffre ; absente ou
 *      divergente (écriture double fermée), l'écart est signalé sans valeur et la reprise rejouée le résorbe ;
 *   4. refusée, seul le MASQUE part (« •••• 1234 », « •••••• DZD »).
 * Une colonne vide n'est pas une lecture : rien à décider, rien à journaliser.
 */

export interface LigneALire {
  /** Identifiant de la ligne d'origine (`Employee.id`…). */
  id: string;
  /** Les colonnes telles qu'en base, au moins celles de `champs`. */
  clair: Record<string, unknown>;
}

export interface ChampLu {
  /** La valeur à montrer ; `null` si la colonne est vide ou la lecture refusée. Forme canonique au coffre. */
  valeur: string | null;
  /** Ce qu'on montre à qui ne lit pas ; `null` si vide. */
  masque: string | null;
  /** `false` = refusée par la politique : n'afficher que le masque, ne pas proposer la saisie en clair. */
  lu: boolean;
}

export interface DemandeLecture {
  lecteur: LecteurCoffre;
  modele: ModeleSensible;
  lignes: readonly LigneALire[];
  champs: readonly string[];
  /** Le geste, en clair, tel qu'il paraîtra au journal : « Fiche employé — consultation ». */
  geste: string;
  usage?: UsageLecture;
}

export interface DependancesLecture {
  cles?: () => ClesCoffre;
  /** Interrupteur forcé (bancs) ; lu dans `AppSetting` sinon. */
  lectureActive?: boolean;
}

export type Lecture = Map<string, Record<string, ChampLu>>;

/** Un accord dont la copie au coffre correspond à la colonne : `lecture.ts` peut la déchiffrer. */
export interface CopieAJour {
  ligne: string;
  champ: string;
  copie: DonneeSensible & { nature: NatureCoffre };
}

function champs(modele: ModeleSensible, noms: readonly string[]): ChampSensible[] {
  return noms.map((n) => {
    const c = champSensible(modele, n);
    if (!c) throw new Error(`${modele}.${n} n'est pas une colonne du coffre.`);
    return c;
  });
}

/** Ce que la politique doit savoir du titulaire de chaque ligne : le compte du salarié, ou « une organisation ». */
async function titulaires(modele: ModeleSensible, ids: string[]): Promise<Map<string, TitulaireLu>> {
  if (modele !== "Employee") return new Map(ids.map((id) => [id, { genre: "ORGANISATION" } as const]));
  const rows = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true } });
  const compte = new Map(rows.map((r) => [r.id, r.userId]));
  return new Map(ids.map((id) => [id, { genre: "PERSONNE", userId: compte.get(id) ?? null } as const]));
}

export async function controlerLecture(d: DemandeLecture, dep: DependancesLecture = {}): Promise<{ lecture: Lecture; copiesAJour: CopieAJour[]; cles: ClesCoffre | null }> {
  const cs = champs(d.modele, d.champs);
  const lecture: Lecture = new Map();
  const active = dep.lectureActive ?? (await getAppSettings()).coffreLecture;

  if (!active) {
    for (const l of d.lignes) {
      lecture.set(l.id, Object.fromEntries(cs.map((c) => [c.champ, { valeur: texteDeColonne(l.clair[c.champ]), masque: masqueDepuisClair(c, l.clair[c.champ]), lu: true }])));
    }
    return { lecture, copiesAJour: [], cles: null };
  }

  const geste = d.geste.trim();
  if (!geste) throw new Error("Toute lecture du coffre dit pour quel geste elle est faite.");
  const ids = d.lignes.map((l) => l.id);
  const cles = (dep.cles ?? (() => chargerCles()))();
  if (!ids.length) return { lecture, copiesAJour: [], cles };
  const [copies, qui] = await Promise.all([
    prisma.donneeSensible.findMany({
      where: { origineModele: d.modele, origineId: { in: ids }, origineChamp: { in: cs.map((c) => c.champ) }, remplaceeLe: null },
    }),
    titulaires(d.modele, ids),
  ]);
  const copieDe = new Map(copies.map((c) => [`${c.origineId}\u0000${c.origineChamp}`, c]));

  const journal: Prisma.AccesDonneeSensibleCreateManyInput[] = [];
  const copiesAJour: CopieAJour[] = [];
  let ecarts = 0;

  for (const l of d.lignes) {
    const res: Record<string, ChampLu> = {};
    for (const c of cs) {
      const brut = texteDeColonne(l.clair[c.champ]);
      const k = classerValeur(c, l.clair[c.champ]);
      if (brut === null || (!k.ok && k.vide)) { res[c.champ] = { valeur: null, masque: null, lu: true }; continue; }
      const trouvee = copieDe.get(`${l.id}\u0000${c.champ}`);
      const copie = trouvee && estNatureCoffre(trouvee.nature) ? { ...trouvee, nature: trouvee.nature } : null;
      const nature: NatureCoffre = k.ok ? k.nature : copie ? copie.nature : c.natures[0];
      const decision = peutLire(d.lecteur, nature, qui.get(l.id) ?? { genre: "ORGANISATION" }, d.usage);
      journal.push({
        donneeSensibleId: copie?.id ?? null,
        titulaireType: copie?.titulaireType ?? null,
        titulaireId: copie?.titulaireId ?? null,
        origineModele: d.modele, origineId: l.id, origineChamp: c.champ,
        nature,
        userId: d.lecteur.genre === "UTILISATEUR" ? d.lecteur.userId : null,
        lecteurNom: d.lecteur.genre === "IA" ? d.lecteur.nom : null,
        geste,
        autorise: decision.autorise,
        motif: decision.motif,
      });
      const m = copie ? masqueNature(copie.nature, copie.derniersCaracteres) : masqueDepuisClair(c, l.clair[c.champ]);
      if (!decision.autorise) { res[c.champ] = { valeur: null, masque: m, lu: false }; continue; }
      res[c.champ] = { valeur: k.ok ? k.valeur : brut, masque: m, lu: true };
      if (copie && k.ok && copie.empreinteHmac === empreinte(cles, copie.nature, k.valeur)) copiesAJour.push({ ligne: l.id, champ: c.champ, copie });
      else ecarts++;
    }
    lecture.set(l.id, res);
  }

  // LE JOURNAL D'ABORD : une lecture sans trace n'existe pas — s'il échoue, rien ne sort.
  if (journal.length) await prisma.accesDonneeSensible.createMany({ data: journal });
  if (ecarts) console.warn(`[coffre] ${d.modele} : ${ecarts} valeur(s) lue(s) sur la colonne faute de copie à jour — rejouer la reprise « coffre ».`);
  return { lecture, copiesAJour, cles };
}

/** Politique + journal, la valeur de la colonne — pour une pièce générée par une action (jamais de déchiffrement). */
export async function lireSensiblesSansDechiffrer(d: DemandeLecture, dep?: DependancesLecture): Promise<Lecture> {
  return (await controlerLecture(d, dep)).lecture;
}

export function lireSensiblesSansDechiffrerPour(user: SessionUser, d: Omit<DemandeLecture, "lecteur">, dep?: DependancesLecture): Promise<Lecture> {
  return lireSensiblesSansDechiffrer({ ...d, lecteur: lecteurDepuisSession(user) }, dep);
}

/**
 * LE RIB IMPRIMÉ SUR UNE PIÈCE (bon de commande, devis, facture, ordre de virement) — contrôlé au GOULOT de la
 * fabrique, qui connaît la personne mais pas l'origine de la valeur (elle arrive dans la demande). Le coffre la
 * reconnaît par son EMPREINTE : chaque copie courante qui la porte est soumise à la politique (usage
 * PIECE_OFFICIELLE : le RIB d'une organisation s'imprime, celui d'une PERSONNE seulement pour qui le lit) et
 * journalisée. Un seul refus, et la pièce n'imprime que le masque. Une valeur inconnue du coffre (lue sur un
 * devis, jamais copiée) passe telle quelle : ce n'est pas une donnée du coffre.
 */
export async function controlerRibDePiece(
  user: SessionUser,
  rib: string | null | undefined,
  geste: string,
  dep: DependancesLecture = {},
): Promise<string | null | undefined> {
  const c = champSensible("CompanyContact", "rib")!;
  const k = classerValeur(c, rib);
  if (!k.ok) return rib;
  if (!(dep.lectureActive ?? (await getAppSettings()).coffreLecture)) return rib;
  const cles = (dep.cles ?? (() => chargerCles()))();
  const copies = await prisma.donneeSensible.findMany({
    where: { nature: k.nature, empreinteHmac: empreinte(cles, k.nature, k.valeur), remplaceeLe: null },
    select: { id: true, titulaireType: true, titulaireId: true, origineModele: true, origineId: true, origineChamp: true },
  });
  if (!copies.length) return rib;
  const lecteur = lecteurDepuisSession(user);
  const salaries = copies.filter((x) => x.origineModele === "Employee" && x.origineId).map((x) => x.origineId!);
  const comptes = new Map(
    (salaries.length ? await prisma.employee.findMany({ where: { id: { in: salaries } }, select: { id: true, userId: true } }) : []).map((e) => [e.id, e.userId]),
  );
  const decisions = copies.map((x) => {
    const personne = x.titulaireType === "PERSONNE" || x.origineModele === "Employee";
    const t: TitulaireLu = personne ? { genre: "PERSONNE", userId: x.origineId ? comptes.get(x.origineId) ?? null : null } : { genre: "ORGANISATION" };
    return { x, d: peutLire(lecteur, k.nature, t, "PIECE_OFFICIELLE") };
  });
  await prisma.accesDonneeSensible.createMany({
    data: decisions.map(({ x, d }) => ({
      donneeSensibleId: x.id, titulaireType: x.titulaireType, titulaireId: x.titulaireId,
      origineModele: x.origineModele, origineId: x.origineId, origineChamp: x.origineChamp,
      nature: k.nature, userId: user.id, geste: geste.trim() || "Pièce générée", autorise: d.autorise, motif: d.motif,
    })),
  });
  return decisions.every(({ d }) => d.autorise) ? k.valeur : masqueDepuisClair(c, rib);
}
