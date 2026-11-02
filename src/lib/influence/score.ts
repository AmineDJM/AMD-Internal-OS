
export interface EntreeScore {
  /** Titre / grade de la fiche (`DoctorTitle`). */
  grade: string | null;
  /** Statut stratégique de la Segmentation (DECIDEUR · INFLUENCEUR · REFERENT · PRESCRIPTEUR), nul = non renseigné. */
  statut: string | null;
  /** Désigné décideur d'un besoin annuel de service. */
  decideurBesoin: boolean;
  /** Médecins de son service (lui exclu) — pour dire « dirige un service de N médecins ». */
  nbCollegues: number;
  /** Interventions comme orateur sur 12 mois, avec leur nom (pour le détail). */
  orateur: { nom: string }[];
  /** Liens d'influence où il est la SOURCE (« suit l'avis de… ») : confirmés, et proposés (confiance 0–1). */
  citationsConfirmees: number;
  citationsProposees: number[];
  /** Boîtes distribuées par les DR à son établissement sur 12 mois — null = aucune donnée PCH. */
  volumeEtablissement: number | null;
  /** Praticiens distincts reliés à lui (liens non rejetés, toutes sources). */
  tailleReseau: number;
}

export type CodeRaison = "HIERARCHIE" | "GRADE" | "ORATEUR" | "CITATIONS" | "VOLUME" | "RESEAU";

export interface Raison {
  code: CodeRaison;
  libelle: string;
  detail: string;
  points: number;
}

export interface ScoreInfluence {
  score: number;
  raisons: Raison[];
}

const nb = (n: number) => n.toLocaleString("fr-FR").replace(/[  ]/g, " ");

/** Dirige-t-il son service ? Chef de service (titre), décideur d'un besoin annuel, ou statut Décideur. */
export function dirigeLeService(e: Pick<EntreeScore, "grade" | "statut" | "decideurBesoin">): boolean {
  return e.grade === "CHEF_DE_SERVICE" || e.statut === "DECIDEUR" || e.decideurBesoin;
}

/** Les points du volume : des paliers lisibles plutôt qu'une courbe. */
export function pointsVolume(volume: number | null): number {
  if (volume === null || !(volume > 0)) return 0;
  if (volume >= 5000) return 15;
  if (volume >= 1000) return 10;
  if (volume >= 200) return 5;
  return 2;
}

/** Le poids des citations : confirmé = 1, proposé = confiance × 0,5 (une confiance hors 0–1 est bornée). */
export function poidsCitations(confirmees: number, proposees: readonly number[]): number {
  const p = proposees.reduce((s, c) => s + Math.max(0, Math.min(1, Number.isFinite(c) ? c : 0)) * 0.5, 0);
  return Math.max(0, confirmees) + p;
}

export function scoreInfluence(e: EntreeScore): ScoreInfluence {
  const raisons: Raison[] = [];
  if (dirigeLeService(e)) {
    const pourquoi = e.decideurBesoin ? "fixe le besoin annuel" : e.statut === "DECIDEUR" ? "statut Décideur" : "chef de service";
    raisons.push({
      code: "HIERARCHIE", libelle: "Dirige le service", points: 30,
      detail: e.nbCollegues > 0 ? `${pourquoi} · ${e.nbCollegues} médecin${e.nbCollegues > 1 ? "s" : ""} dans le service` : pourquoi,
    });
  } else if (e.grade === "PROFESSEUR" || e.grade === "MAITRE_CONFERENCES") {
    raisons.push({ code: "GRADE", libelle: e.grade === "PROFESSEUR" ? "Professeur" : "Maître de conférences", detail: "grade hospitalo-universitaire", points: 15 });
  }
  if (e.orateur.length > 0) {
    const noms = [...new Set(e.orateur.map((o) => o.nom))].slice(0, 2).join(", ");
    raisons.push({
      code: "ORATEUR", libelle: `Orateur ${e.orateur.length} fois en 12 mois`, detail: noms,
      points: Math.min(20, 10 * e.orateur.length),
    });
  }
  const poids = poidsCitations(e.citationsConfirmees, e.citationsProposees);
  if (poids > 0) {
    const n = e.citationsConfirmees + e.citationsProposees.length;
    const detail = [
      e.citationsConfirmees ? `${e.citationsConfirmees} confirmé${e.citationsConfirmees > 1 ? "s" : ""}` : null,
      e.citationsProposees.length ? `${e.citationsProposees.length} proposé${e.citationsProposees.length > 1 ? "s" : ""} par Luna` : null,
    ].filter(Boolean).join(" · ");
    raisons.push({ code: "CITATIONS", libelle: `Cité comme influence par ${n} lien${n > 1 ? "s" : ""}`, detail, points: Math.min(25, Math.round(poids * 6)) });
  }
  const pv = pointsVolume(e.volumeEtablissement);
  if (pv > 0) {
    raisons.push({ code: "VOLUME", libelle: pv >= 10 ? "Établissement à fort volume" : "Établissement consommateur", detail: `${nb(Math.round(e.volumeEtablissement!))} boîtes distribuées / 12 mois (DR)`, points: pv });
  }
  if (e.tailleReseau > 0) {
    raisons.push({ code: "RESEAU", libelle: `Réseau de ${e.tailleReseau} praticien${e.tailleReseau > 1 ? "s" : ""}`, detail: "liens non rejetés", points: Math.min(10, 2 * e.tailleReseau) });
  }
  const score = Math.max(0, Math.min(100, raisons.reduce((s, r) => s + r.points, 0)));
  return { score, raisons };
}

/**
 * « PASSER EN INFLUENCEUR ? » — une SUGGESTION, jamais un changement : le praticien n'est ni Influenceur ni Décideur, son
 * score atteint 50, et un signal d'influence au-delà de son rang existe (orateur ou cité par d'autres).
 */
export function suggererInfluenceur(statut: string | null, s: ScoreInfluence): boolean {
  if (statut === "INFLUENCEUR" || statut === "DECIDEUR") return false;
  if (s.score < 50) return false;
  return s.raisons.some((r) => r.code === "ORATEUR" || r.code === "CITATIONS");
}

export interface MembreEntree {
  doctorId: string;
  nom: string;
  grade: string | null;
  statut: string | null;
  decideurBesoin: boolean;
  pharmacien: boolean;
  score: number;
  /** Prescripteurs du service qu'il influence (liens sortants non rejetés vers des membres du service). */
  influences: number;
}

export interface EtapeEntree {
  doctorId: string;
  nom: string;
  role: "DECIDEUR" | "INFLUENCEUR" | "PHARMACIE";
  pourquoi: string;
}

/**
 * L'ORDRE D'ENTRÉE dans un service avec un produit : le décideur d'abord, puis celui qui influence les prescripteurs, puis
 * la pharmacie. Trois lignes au plus, chacune dit pourquoi. Un rôle sans titulaire est sauté — jamais inventé.
 */
export function ordreDEntree(membres: readonly MembreEntree[]): EtapeEntree[] {
  const out: EtapeEntree[] = [];
  const pris = new Set<string>();
  const decideurs = membres.filter((m) => !m.pharmacien && dirigeLeService(m)).sort((a, b) => Number(b.decideurBesoin) - Number(a.decideurBesoin) || b.score - a.score);
  const d = decideurs[0];
  if (d) {
    out.push({ doctorId: d.doctorId, nom: d.nom, role: "DECIDEUR", pourquoi: d.decideurBesoin ? "fixe le besoin annuel du service" : "dirige le service" });
    pris.add(d.doctorId);
  }
  const influenceur = membres
    .filter((m) => !pris.has(m.doctorId) && !m.pharmacien && (m.influences > 0 || m.statut === "INFLUENCEUR"))
    .sort((a, b) => b.influences - a.influences || b.score - a.score)[0];
  if (influenceur) {
    out.push({
      doctorId: influenceur.doctorId, nom: influenceur.nom, role: "INFLUENCEUR",
      pourquoi: influenceur.influences > 0 ? `influence ${influenceur.influences} prescripteur${influenceur.influences > 1 ? "s" : ""} du service` : "statut Influenceur",
    });
    pris.add(influenceur.doctorId);
  }
  const pharma = membres.filter((m) => !pris.has(m.doctorId) && m.pharmacien).sort((a, b) => b.score - a.score)[0];
  if (pharma) out.push({ doctorId: pharma.doctorId, nom: pharma.nom, role: "PHARMACIE", pourquoi: "passe les commandes du service" });
  return out.slice(0, 3);
}
