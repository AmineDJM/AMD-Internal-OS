import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { chargerCles, type ClesCoffre } from "./cle";
import { empreinte, ErreurDechiffrement } from "./chiffrement";
import { dechiffrer, recomposer } from "./dechiffrement";
import { champSensible, classerValeur, masqueDepuisClair, texteDeColonne, type ChampSensible, type ModeleSensible } from "./champs";
import { masque as masqueNature, estNatureCoffre, type NatureCoffre } from "./natures";
import { lecteurDepuisSession } from "./lecteur";
import { peutLire, type LecteurCoffre, type TitulaireLu, type UsageLecture } from "./politique";

/**
 * LA DOUBLE LECTURE DU COFFRE (refonte V2-E) — le seul chemin par lequel un écran, un export ou une pièce
 * générée obtient la valeur d'une colonne sensible.
 *
 * Interrupteur `AppSetting.coffreLecture` FERMÉ : la colonne est rendue telle quelle, sans journal — le
 * comportement d'avant, à l'identique (les portes RBAC de chaque écran restent les siennes).
 *
 * OUVERT, pour chaque valeur demandée :
 *   1. la politique décide (`politique.ts` : RH, Finances, titulaire, Super Admin ; jamais un modèle d'IA) ;
 *   2. la décision — accord COMME refus — est écrite au journal `AccesDonneeSensible` (qui, quand, quel
 *      geste, quelle colonne) AVANT que la moindre valeur soit rendue : si le journal échoue, rien ne sort ;
 *   3. accordée, la valeur est DÉCHIFFRÉE du coffre quand la copie y correspond à la colonne ; sinon (pas
 *      encore copiée, ou divergente parce que l'écriture double était fermée) la colonne fait foi jusqu'au
 *      palier P5 — l'écart est signalé (sans valeur) et la reprise rejouée le résorbe ;
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

type Lecture = Map<string, Record<string, ChampLu>>;

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

export async function lireSensibles(d: DemandeLecture, dep: DependancesLecture = {}): Promise<Lecture> {
  const cs = champs(d.modele, d.champs);
  const out: Lecture = new Map();
  const active = dep.lectureActive ?? (await getAppSettings()).coffreLecture;

  if (!active) {
    for (const l of d.lignes) {
      out.set(l.id, Object.fromEntries(cs.map((c) => [c.champ, { valeur: texteDeColonne(l.clair[c.champ]), masque: masqueDepuisClair(c, l.clair[c.champ]), lu: true }])));
    }
    return out;
  }

  const geste = d.geste.trim();
  if (!geste) throw new Error("Toute lecture du coffre dit pour quel geste elle est faite.");
  const ids = d.lignes.map((l) => l.id);
  if (!ids.length) return out;
  const cles = (dep.cles ?? (() => chargerCles()))();
  const [copies, qui] = await Promise.all([
    prisma.donneeSensible.findMany({
      where: { origineModele: d.modele, origineId: { in: ids }, origineChamp: { in: cs.map((c) => c.champ) }, remplaceeLe: null },
    }),
    titulaires(d.modele, ids),
  ]);
  const copieDe = new Map(copies.map((c) => [`${c.origineId}\u0000${c.origineChamp}`, c]));

  type Accord = { ligne: string; champ: string; copie: (typeof copies)[number] | null; canonique: string | null; brut: string };
  const lignesJournal: Prisma.AccesDonneeSensibleCreateManyInput[] = [];
  const accordes: Accord[] = [];
  let ecarts = 0;

  for (const l of d.lignes) {
    const res: Record<string, ChampLu> = {};
    for (const c of cs) {
      const brut = texteDeColonne(l.clair[c.champ]);
      const k = classerValeur(c, l.clair[c.champ]);
      if (brut === null || (!k.ok && k.vide)) { res[c.champ] = { valeur: null, masque: null, lu: true }; continue; }
      const copie = copieDe.get(`${l.id}\u0000${c.champ}`) ?? null;
      const nature: NatureCoffre = k.ok ? k.nature : copie && estNatureCoffre(copie.nature) ? copie.nature : c.natures[0];
      const decision = peutLire(d.lecteur, nature, qui.get(l.id) ?? { genre: "ORGANISATION" }, d.usage);
      lignesJournal.push({
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
      const m = copie && estNatureCoffre(copie.nature) ? masqueNature(copie.nature, copie.derniersCaracteres) : masqueDepuisClair(c, l.clair[c.champ]);
      res[c.champ] = { valeur: null, masque: m, lu: decision.autorise };
      if (decision.autorise) accordes.push({ ligne: l.id, champ: c.champ, copie, canonique: k.ok ? k.valeur : null, brut });
    }
    out.set(l.id, res);
  }

  // LE JOURNAL D'ABORD : une lecture sans trace n'existe pas.
  if (lignesJournal.length) await prisma.accesDonneeSensible.createMany({ data: lignesJournal });

  for (const a of accordes) {
    let valeur = a.canonique ?? a.brut;
    const copie = a.copie && estNatureCoffre(a.copie.nature) ? { ...a.copie, nature: a.copie.nature } : null;
    if (copie && a.canonique !== null && copie.empreinteHmac === empreinte(cles, copie.nature, a.canonique)) {
      try {
        valeur = dechiffrer(cles, copie.nature, copie.id, recomposer(copie));
      } catch (err) {
        if (!(err instanceof ErreurDechiffrement)) throw err;
        ecarts++;
      }
    } else {
      ecarts++;
    }
    out.get(a.ligne)![a.champ].valeur = valeur;
  }
  if (ecarts) console.warn(`[coffre] ${d.modele} : ${ecarts} valeur(s) lue(s) sur la colonne faute de copie à jour — rejouer la reprise « coffre ».`);
  return out;
}

/** La même lecture, pour la personne connectée. */
export function lireSensiblesPour(user: SessionUser, d: Omit<DemandeLecture, "lecteur">, dep?: DependancesLecture): Promise<Lecture> {
  return lireSensibles({ ...d, lecteur: lecteurDepuisSession(user) }, dep);
}
