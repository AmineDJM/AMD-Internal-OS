import { jours, montantLisible, pourcent, type ContenuRecette, type EtapePlanRecette, type EtapeRecette, type SeuilRecette } from "./contenu";
import type { DescriptionCircuit } from "./processus";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTION D'UNE RECETTE (J10, décision 0028) — pur : des dossiers réels en entrée, une PROPOSITION ou RIEN.
 *
 * ── LA RÈGLE QUI GOUVERNE CE FICHIER : PAS DE RECETTE SANS OCCURRENCES ───────────────────
 *
 * Une recette n'est proposée qu'à partir d'un nombre minimal de dossiers RÉELS clos et acceptés (`seuil`, réglable
 * par processus). En dessous, la fonction rend `null` — pas une recette « probable », pas une recette écrite d'avance :
 * rien. Trois dossiers ne disent pas comment on fait ; ils disent comment ça s'est passé trois fois.
 *
 * ── CE QU'ON LIT DANS UN DOSSIER ────────────────────────────────────────────────────────
 *
 * Le journal du circuit (comme le process mining, `lib/process/mining.ts`) : chaque mouvement (accord, franchissement
 * automatique, renvoi, refus, clôture) ferme un segment ; le temps écoulé depuis le mouvement précédent revient à
 * l'étape de ce mouvement. Un commentaire ne ferme rien. Les étapes s'ordonnent par leur rang moyen dans les dossiers.
 *
 * ── LES SEUILS ───────────────────────────────────────────────────────────────────────────
 *
 * D'abord le RÉGLAGE du circuit (`autoSkipMaxAmount` : « franchie automatiquement jusqu'à X ») — c'est la règle, pas
 * une déduction. À défaut, une étape qui n'apparaît QUE dans les dossiers au-dessus d'un montant (au moins deux de
 * chaque côté, séparation nette) donne un seuil OBSERVÉ, arrondi et dit comme tel.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureEvenement = "debut" | "avance" | "auto" | "renvoi" | "resoumission" | "refus" | "fin" | "autre";

export interface EvenementDossier {
  quand: Date;
  etape: string;
  libelle?: string | null;
  nature: NatureEvenement;
  /** Le RÔLE de qui a agi (code `UserRole`) — jamais son nom. */
  role?: string | null;
  note?: string | null;
}

export type IssueDossier = "ACCEPTE" | "REFUSE" | "ANNULE" | "EN_COURS";

export interface DossierObserve {
  id: string;
  debut: Date;
  fin: Date | null;
  issue: IssueDossier;
  montant: number | null;
  evenements: EvenementDossier[];
  /** Les natures des pièces rattachées (`Piece.nature`). */
  pieces: string[];
}

export interface EtapeDefinie {
  cle: string;
  libelle: string;
  roles: string[];
  seuilAutoMax: number | null;
}

export interface OptionsExtraction {
  /** Le nombre minimal de dossiers clos ACCEPTÉS. */
  seuil: number;
  libelleRole?: (role: string) => string;
}

const JOUR = 86_400_000;
const MOUVEMENTS = new Set<NatureEvenement>(["avance", "auto", "renvoi", "refus", "fin"]);
const FREQUENCE_MIN_ETAPE = 0.2;
const FREQUENCE_PIECE = 0.5;

const duree = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / JOUR);

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const mediane = (v: readonly number[]) => percentile(v, 0.5);

/** Un motif de renvoi, montrable : chiffres masqués (montants, téléphones), adresses retirées, court. */
export function motifMontrable(note: string): string | null {
  const t = note
    .replace(/\S+@\S+/g, "…")
    .replace(/\d[\d\s.,]*/g, "… ")
    .replace(/(…\s*)+/g, "… ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:!\s]+$/, "")
    .slice(0, 120);
  return t.replace(/[…\s]/g, "").length >= 6 ? t : null;
}
const cleMotif = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z…]+/g, " ").trim();

/** Les paliers d'un seuil, du plus rond au moins rond (× une puissance de dix). */
const PALIERS = [1, 5, 2, 2.5, 3, 4, 6, 7.5, 8, 1.5, 1.2, 7, 9];

/**
 * LE SEUIL OBSERVÉ, ARRONDI À UN PALIER — strictement entre le plus haut montant qui ne traverse pas l'étape et le plus
 * bas qui la traverse. Jamais le montant d'un dossier : « au-delà de 1,1 M » recopierait le montant d'une demande
 * précise. Aucun palier dans l'intervalle → pas de seuil (l'étape est dite « pas systématique »).
 */
export function seuilRond(maxSans: number, minAvec: number): number | null {
  if (!(maxSans < minAvec)) return null;
  let meilleur: { v: number; rang: number; ordre: number } | null = null;
  for (let k = 0; k <= 12; k++) {
    const p = 10 ** k;
    PALIERS.forEach((m, rang) => {
      const v = m * p;
      if (v <= maxSans || v >= minAvec) return;
      const ordre = -k * 100 + rang; // la plus haute puissance de dix d'abord, puis le palier le plus rond
      if (!meilleur || ordre < meilleur.ordre) meilleur = { v, rang, ordre };
    });
  }
  return (meilleur as { v: number } | null)?.v ?? null;
}

interface Passage { cle: string; libelle: string; nature: NatureEvenement; jours: number; rang: number; role: string | null }

/** Les passages d'un dossier, dans l'ordre (comme `segmentsOf` du process mining, réduit à ce qu'une recette lit). */
export function passagesDe(d: DossierObserve): { passages: Passage[]; renvois: { etape: string; note: string | null }[]; refus: string | null } {
  const evts = [...d.evenements].sort((a, b) => a.quand.getTime() - b.quand.getTime());
  let curseur = d.debut;
  const passages: Passage[] = [];
  const renvois: { etape: string; note: string | null }[] = [];
  let refus: string | null = null;
  for (const e of evts) {
    if (e.nature === "debut") { if (e.quand > curseur) curseur = e.quand; continue; }
    if (e.nature === "resoumission") { curseur = e.quand; continue; }
    if (!MOUVEMENTS.has(e.nature)) continue;
    if (e.nature === "renvoi") renvois.push({ etape: e.etape, note: e.note ?? null });
    if (e.nature === "refus") refus = e.note ?? "";
    if (e.nature === "avance" || e.nature === "auto") {
      passages.push({ cle: e.etape, libelle: e.libelle || e.etape, nature: e.nature, jours: duree(curseur, e.quand), rang: passages.length, role: e.role ?? null });
    }
    curseur = e.quand;
  }
  return { passages, renvois, refus };
}

interface StatEtape { cle: string; libelle: string; dossiers: Set<string>; manuels: Set<string>; durees: number[]; rangs: number[]; roles: Map<string, number> }

/** L'étape est-elle séparée par un montant ? Rend le plus haut montant des dossiers qui ne la traversent pas (seuil observé). */
function seuilObserve(avec: number[], sans: number[]): number | null {
  if (avec.length < 2 || sans.length < 2) return null;
  return seuilRond(Math.max(...sans), Math.min(...avec));
}

/**
 * LA RECETTE D'UN CIRCUIT — ou `null` (moins de `seuil` dossiers clos acceptés).
 */
export function extraireRecette(
  desc: DescriptionCircuit, dossiers: readonly DossierObserve[], definition: readonly EtapeDefinie[] | null, opts: OptionsExtraction,
): ContenuRecette | null {
  const role = opts.libelleRole ?? ((r: string) => r);
  const clos = dossiers.filter((d) => d.issue !== "EN_COURS" && d.fin);
  const acceptes = clos.filter((d) => d.issue === "ACCEPTE");
  if (acceptes.length < Math.max(1, opts.seuil)) return null;

  const defParCle = new Map((definition ?? []).map((e) => [e.cle, e]));
  const stats = new Map<string, StatEtape>();
  const montantsAvec = new Map<string, number[]>();
  for (const d of acceptes) {
    const { passages } = passagesDe(d);
    for (const p of passages) {
      const s: StatEtape = stats.get(p.cle) ?? { cle: p.cle, libelle: p.libelle, dossiers: new Set(), manuels: new Set(), durees: [], rangs: [], roles: new Map() };
      if (!s.dossiers.has(d.id)) s.rangs.push(p.rang);
      s.dossiers.add(d.id);
      if (p.nature === "avance") {
        s.manuels.add(d.id);
        s.durees.push(p.jours);
        if (p.role) s.roles.set(p.role, (s.roles.get(p.role) ?? 0) + 1);
      }
      stats.set(p.cle, s);
    }
  }
  for (const s of stats.values()) {
    montantsAvec.set(s.cle, acceptes.filter((d) => s.manuels.has(d.id) && d.montant !== null).map((d) => d.montant!));
  }

  const n = acceptes.length;
  const seuils: SeuilRecette[] = [];
  const etapes: EtapeRecette[] = [...stats.values()]
    .filter((s) => s.dossiers.size / n >= FREQUENCE_MIN_ETAPE)
    .map((s) => ({ s, rang: s.rangs.reduce((a, b) => a + b, 0) / s.rangs.length }))
    .sort((a, b) => a.rang - b.rang)
    .map(({ s }) => {
      const def = defParCle.get(s.cle);
      const libelle = def?.libelle || s.libelle;
      const observes = [...s.roles.entries()].sort((a, b) => b[1] - a[1]);
      const totalRoles = observes.reduce((a, [, k]) => a + k, 0);
      const validateurs = def?.roles.length ? [...def.roles] : observes.filter(([, k]) => k / totalRoles >= 0.3).map(([r]) => r);
      const frequence = s.manuels.size / n;
      let condition: string | null = null;
      if (def?.seuilAutoMax) {
        condition = `franchie automatiquement jusqu'à ${montantLisible(def.seuilAutoMax)} ; au-delà, ${validateurs.map(role).join(" ou ") || "validée"}`;
        seuils.push({ etape: s.cle, libelle, montant: def.seuilAutoMax, source: "DEFINITION", texte: `${libelle} : au-delà de ${montantLisible(def.seuilAutoMax)}` });
      } else if (frequence < 0.95) {
        const sans = acceptes.filter((d) => !s.manuels.has(d.id) && d.montant !== null).map((d) => d.montant!);
        const seuil = seuilObserve(montantsAvec.get(s.cle) ?? [], sans);
        if (seuil !== null) {
          condition = `seulement au-delà d'environ ${montantLisible(seuil)} (observé)`;
          seuils.push({ etape: s.cle, libelle, montant: seuil, source: "OBSERVE", texte: `${libelle} : au-delà d'environ ${montantLisible(seuil)} (observé)` });
        } else {
          condition = `pas systématique : ${pourcent(frequence)} des dossiers`;
        }
      }
      return { cle: s.cle, libelle, validateurs, frequence, dureeMedianeJours: mediane(s.durees), condition };
    });
  if (etapes.length === 0) return null;

  const piecesCompte = new Map<string, number>();
  for (const d of acceptes) for (const p of new Set(d.pieces)) piecesCompte.set(p, (piecesCompte.get(p) ?? 0) + 1);
  const pieces = [...piecesCompte.entries()].filter(([, k]) => k / n >= FREQUENCE_PIECE).sort((a, b) => b[1] - a[1]).map(([nature, k]) => ({ nature, frequence: k / n }));

  const finale = [...etapes].reverse().find((e) => e.frequence >= 0.5) ?? null;
  const durees = acceptes.map((d) => duree(d.debut, d.fin!));
  const medianeJours = mediane(durees);
  const p90Jours = durees.length >= 5 ? percentile(durees, 0.9) : null;

  // ── Les pièges : ce qui revient, compté sur des dossiers DISTINCTS ──
  const pieges: { texte: string; occurrences: number }[] = [];
  const parMotif = new Map<string, { texte: string; dossiers: Set<string> }>();
  const renvoisParEtape = new Map<string, number>();
  let renvoyes = 0;
  let refuses = 0;
  const motifsRefus = new Map<string, { texte: string; dossiers: Set<string> }>();
  for (const d of clos) {
    const { renvois, refus } = passagesDe(d);
    if (renvois.length) renvoyes++;
    for (const r of renvois) {
      renvoisParEtape.set(r.etape, (renvoisParEtape.get(r.etape) ?? 0) + 1);
      const t = r.note ? motifMontrable(r.note) : null;
      if (!t) continue;
      const k = cleMotif(t);
      const m = parMotif.get(k) ?? { texte: t, dossiers: new Set() };
      m.dossiers.add(d.id);
      parMotif.set(k, m);
    }
    if (d.issue === "REFUSE") {
      refuses++;
      const t = refus ? motifMontrable(refus) : null;
      if (t) {
        const k = cleMotif(t);
        const m = motifsRefus.get(k) ?? { texte: t, dossiers: new Set() };
        m.dossiers.add(d.id);
        motifsRefus.set(k, m);
      }
    }
  }
  const tauxRenvoi = clos.length ? renvoyes / clos.length : null;
  const tauxRefus = clos.length ? refuses / clos.length : null;
  const libelleDe = (cle: string) => etapes.find((e) => e.cle === cle)?.libelle ?? defParCle.get(cle)?.libelle ?? cle;
  if (tauxRenvoi && tauxRenvoi > 0) {
    const [etapeRenvoi] = [...renvoisParEtape.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    pieges.push({ texte: `${pourcent(tauxRenvoi)} des dossiers sont renvoyés pour correction${etapeRenvoi ? `, surtout à « ${libelleDe(etapeRenvoi)} »` : ""}`, occurrences: renvoyes });
  }
  for (const m of [...parMotif.values()].filter((x) => x.dossiers.size >= 2).sort((a, b) => b.dossiers.size - a.dossiers.size).slice(0, 3)) {
    pieges.push({ texte: `Renvoi fréquent : « ${m.texte} »`, occurrences: m.dossiers.size });
  }
  if (tauxRefus && tauxRefus > 0) {
    const [motif] = [...motifsRefus.values()].filter((x) => x.dossiers.size >= 2).sort((a, b) => b.dossiers.size - a.dossiers.size);
    pieges.push({ texte: `${pourcent(tauxRefus)} des dossiers sont refusés${motif ? ` — motif le plus fréquent : « ${motif.texte} »` : ""}`, occurrences: refuses });
  }
  const avecDuree = etapes.filter((e) => e.dureeMedianeJours !== null);
  const totalEtapes = avecDuree.reduce((a, e) => a + (e.dureeMedianeJours ?? 0), 0);
  const lente = avecDuree.reduce<EtapeRecette | null>((m, e) => (!m || (e.dureeMedianeJours ?? 0) > (m.dureeMedianeJours ?? 0) ? e : m), null);
  if (lente && totalEtapes > 0 && avecDuree.length > 1 && (lente.dureeMedianeJours ?? 0) / totalEtapes >= 0.35) {
    pieges.push({ texte: `« ${lente.libelle} » est l'étape la plus lente (${pourcent((lente.dureeMedianeJours ?? 0) / totalEtapes)} du temps, médiane ${jours(lente.dureeMedianeJours)}) : relancer tôt`, occurrences: n });
  }

  const debuts = acceptes.map((d) => d.debut.getTime());
  const fins = acceptes.map((d) => d.fin!.getTime());
  const jourIso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const seuilDg = seuils.find((s) => /\bdg\b|direct/i.test(s.libelle)) ?? seuils[0];
  const resume = [
    `${desc.libelle} chez nous : ${etapes.length} étape${etapes.length > 1 ? "s" : ""}`,
    pieces.length ? `pièces habituelles : ${pieces.map((p) => p.nature.toLowerCase().replace(/_/g, " ")).join(", ")}` : null,
    finale ? `décision finale : ${finale.libelle}${finale.validateurs.length ? ` (${finale.validateurs.map(role).join(" ou ")})` : ""}` : null,
    seuilDg ? seuilDg.texte : null,
    `durée médiane ${jours(medianeJours)}${p90Jours !== null ? ` (9 sur 10 en moins de ${jours(p90Jours)})` : ""}`,
    `tiré de ${n} dossier${n > 1 ? "s" : ""} accepté${n > 1 ? "s" : ""}`,
  ].filter(Boolean).join(" ; ") + ".";

  return {
    titre: desc.libelle,
    resume,
    etapes,
    pieces,
    validationFinale: finale ? { libelle: finale.libelle, validateurs: finale.validateurs } : null,
    seuils,
    duree: { medianeJours, p90Jours, dossiers: n },
    pieges,
    tauxRenvoi,
    tauxRefus,
    // Les mots du CIRCUIT seulement : les libellés d'étapes (« Superviseur national », « Direction ») sont communs à plusieurs circuits et brouilleraient la correspondance.
    motsCles: desc.motsCles.toLowerCase(),
    observation: { occurrences: n, du: jourIso(Math.min(...debuts)), au: jourIso(Math.max(...fins)) },
    formePlan: null,
  };
}

// ───────────────────────────── Les travaux qui ont réussi (J2) ─────────────────────────────

export interface TravailReussi {
  id: string;
  titre: string;
  debut: Date;
  fin: Date;
  etapes: EtapePlanRecette[];
}

/** La forme d'un plan : la suite des (type, outil) — deux travaux de même forme ont réussi de la même façon. */
export const formeDuPlan = (etapes: readonly EtapePlanRecette[]): string =>
  etapes.map((e) => `${e.type}${e.outil ? `(${e.outil})` : ""}${e.attente ? "[attente]" : ""}`).join(" → ");

/** La recette d'une forme de travail réussie au moins `seuil` fois — la forme du plan le plus récent, sans ses entrées. */
export function extraireRecetteTravail(desc: DescriptionCircuit, travaux: readonly TravailReussi[], opts: OptionsExtraction): ContenuRecette | null {
  if (travaux.length < Math.max(1, opts.seuil)) return null;
  const tries = [...travaux].sort((a, b) => b.fin.getTime() - a.fin.getTime());
  const modele = tries[0];
  const durees = travaux.map((t) => duree(t.debut, t.fin));
  const titres = new Map<string, number>();
  for (const t of travaux) titres.set(t.titre, (titres.get(t.titre) ?? 0) + 1);
  const [titre] = [...titres.entries()].sort((a, b) => b[1] - a[1])[0];
  const medianeJours = mediane(durees);
  const etapes: EtapeRecette[] = modele.etapes.map((e) => ({
    cle: e.cle, libelle: e.titre, validateurs: [], frequence: 1, dureeMedianeJours: null,
    condition: e.si ? `seulement si « ${e.si.etape} » finit en ${e.si.issue}` : null,
  }));
  return {
    titre,
    resume: `${titre} : ${etapes.length} étapes (${formeDuPlan(modele.etapes)}) ; durée médiane ${jours(medianeJours)} ; réussi ${travaux.length} fois.`,
    etapes,
    pieces: [],
    validationFinale: null,
    seuils: [],
    duree: { medianeJours, p90Jours: durees.length >= 5 ? percentile(durees, 0.9) : null, dossiers: travaux.length },
    pieges: [],
    tauxRenvoi: null,
    tauxRefus: null,
    motsCles: [titre, ...modele.etapes.map((e) => e.titre)].join(" ").toLowerCase(),
    observation: {
      occurrences: travaux.length,
      du: new Date(Math.min(...travaux.map((t) => t.debut.getTime()))).toISOString().slice(0, 10),
      au: new Date(Math.max(...travaux.map((t) => t.fin.getTime()))).toISOString().slice(0, 10),
    },
    formePlan: modele.etapes.map(({ cle, titre: t, type, apres, outil, consigne, attente, si }) => ({
      cle, titre: t, type, ...(apres?.length ? { apres } : {}), ...(outil ? { outil } : {}), ...(consigne ? { consigne } : {}),
      ...(attente ? { attente } : {}), ...(si ? { si } : {}),
    })),
  };
}

/** La recette d'une forme de mission d'Adam VALIDÉE (`MissionPlanPattern`) : une fiche, sans plan de travail. */
export function extraireRecetteForme(desc: DescriptionCircuit, forme: { forme: string[]; succes: number; profil: string; depuis: Date; jusque: Date }, opts: OptionsExtraction): ContenuRecette | null {
  if (forme.succes < Math.max(1, opts.seuil) || forme.forme.length === 0) return null;
  const lisible = (f: string) => f.replace(/^CAPABILITY\(([^)]+)\)/, "$1").replace(/\[éventail\]/, " (pour chaque élément)").replace(/_/g, " ");
  const etapes: EtapeRecette[] = forme.forme.map((f, i) => ({ cle: `e${i + 1}`, libelle: lisible(f), validateurs: [], frequence: 1, dureeMedianeJours: null, condition: null }));
  const titre = `Mission ${forme.profil.toLowerCase()} : ${etapes.map((e) => e.libelle).slice(0, 3).join(", ")}`;
  return {
    titre,
    resume: `${desc.libelle} validée par la répétition : ${etapes.length} étapes, réussie ${forme.succes} fois.`,
    etapes, pieces: [], validationFinale: null, seuils: [],
    duree: { medianeJours: null, p90Jours: null, dossiers: forme.succes },
    pieges: [], tauxRenvoi: null, tauxRefus: null,
    motsCles: etapes.map((e) => e.libelle).join(" ").toLowerCase(),
    observation: { occurrences: forme.succes, du: forme.depuis.toISOString().slice(0, 10), au: forme.jusque.toISOString().slice(0, 10) },
    formePlan: null,
  };
}
