/**
 * LES LIENS D'INFLUENCE ENTRE PRATICIENS — leur vocabulaire, les liens STRUCTURELS calculés sans modèle, et le
 * rapprochement d'un nom écrit dans un rapport avec une fiche de l'annuaire.
 *
 * Sens d'un lien : `from` INFLUENCE `to` (« Dr C. suit l'avis du Pr E. » = E → C). Un lien de co-orateurs n'a pas de sens :
 * il est rangé une seule fois, du plus petit identifiant vers le plus grand.
 *
 * Module PUR, zéro import de valeur : l'écran client peut lire les libellés.
 */

export const TYPES_STRUCTURE = ["HIERARCHIE", "PHARMACIE_SERVICE", "CO_ORATEUR"] as const;
export const TYPES_LUNA = ["SUIT_AVIS", "ELEVE_DE", "CO_ORATEUR", "COMITE", "DECIDE"] as const;
export type TypeRelation = (typeof TYPES_STRUCTURE)[number] | (typeof TYPES_LUNA)[number];

export const LIBELLE_RELATION: Record<TypeRelation, string> = {
  HIERARCHIE: "dirige",
  PHARMACIE_SERVICE: "pharmacie du service",
  CO_ORATEUR: "co-orateurs",
  SUIT_AVIS: "son avis est suivi",
  ELEVE_DE: "a formé",
  COMITE: "même comité",
  DECIDE: "décide pour",
};

export function estTypeLuna(v: unknown): v is (typeof TYPES_LUNA)[number] {
  return typeof v === "string" && (TYPES_LUNA as readonly string[]).includes(v);
}

export interface LienCalcule {
  from: string;
  to: string;
  type: TypeRelation;
}

export interface MembreService {
  doctorId: string;
  serviceId: string | null;
  grade: string | null;
  statut: string | null;
  decideurBesoin: boolean;
  pharmacien: boolean;
}

/** Un pharmacien : le titre de la fiche, ou une spécialité qui le dit. */
export function estPharmacien(grade: string | null, specialite: string | null | undefined): boolean {
  if (grade === "PHARMACIEN") return true;
  return !!specialite && /pharma/i.test(specialite);
}

/** Le ou les responsables d'un service : décideur d'un besoin annuel, statut Décideur, ou titre « chef de service ». */
export function chefsDuService(membres: readonly MembreService[]): string[] {
  return membres.filter((m) => !m.pharmacien && (m.decideurBesoin || m.statut === "DECIDEUR" || m.grade === "CHEF_DE_SERVICE")).map((m) => m.doctorId);
}

/**
 * LES LIENS STRUCTURELS — ce que l'annuaire et les demandes Ad & Pro disent déjà, sans Luna :
 *   • HIERARCHIE : chaque responsable du service → chacun des autres médecins du service ;
 *   • PHARMACIE_SERVICE : chaque responsable → le pharmacien du service ;
 *   • CO_ORATEUR : deux orateurs d'une même action (rangé une fois, plus petit identifiant d'abord).
 * Un service sans responsable n'a pas de hiérarchie : on ne la devine pas.
 */
export function relationsStructurelles(
  membres: readonly MembreService[],
  orateursParAction: ReadonlyMap<string, readonly string[]>,
): LienCalcule[] {
  const out = new Map<string, LienCalcule>();
  const put = (l: LienCalcule) => { if (l.from !== l.to) out.set(`${l.from}|${l.to}|${l.type}`, l); };
  const parService = new Map<string, MembreService[]>();
  for (const m of membres) if (m.serviceId) parService.set(m.serviceId, [...(parService.get(m.serviceId) ?? []), m]);
  for (const liste of parService.values()) {
    const chefs = new Set(chefsDuService(liste));
    for (const c of chefs) {
      for (const m of liste) {
        if (chefs.has(m.doctorId)) continue;
        put({ from: c, to: m.doctorId, type: m.pharmacien ? "PHARMACIE_SERVICE" : "HIERARCHIE" });
      }
    }
  }
  for (const ids of orateursParAction.values()) {
    const u = [...new Set(ids)].sort();
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) put({ from: u[i], to: u[j], type: "CO_ORATEUR" });
  }
  return [...out.values()];
}

// ─────────────────────────── Rapprochement d'un nom écrit ───────────────────────────

/** La clé d'un nom : casse, accents, titres (Dr, Pr…) et « épouse » mis de côté, mots triés. */
export function cleNom(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dr|pr|prof|docteur|professeur|pharm|pharmacien|pharmacienne)\b\.?/g, " ")
    .replace(/\b(ep|epouse|nee)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1)
    .sort()
    .join(" ");
}

export interface PraticienIndexable {
  id: string;
  name: string;
  lastName: string | null;
  firstName: string | null;
  institutionId: string | null;
}

export interface IndexPraticiens {
  parCle: Map<string, PraticienIndexable[]>;
  parMot: Map<string, PraticienIndexable[]>;
  motsDe: Map<string, Set<string>>;
}

export function indexerPraticiens(connus: readonly PraticienIndexable[]): IndexPraticiens {
  const parCle = new Map<string, PraticienIndexable[]>();
  const parMot = new Map<string, PraticienIndexable[]>();
  const motsDe = new Map<string, Set<string>>();
  const ajouter = (m: Map<string, PraticienIndexable[]>, k: string, p: PraticienIndexable) => {
    const l = m.get(k) ?? [];
    if (!l.some((x) => x.id === p.id)) l.push(p);
    m.set(k, l);
  };
  for (const p of connus) {
    const cles = new Set([cleNom(p.lastName, p.firstName), cleNom(p.name)].filter(Boolean));
    const mots = new Set<string>();
    for (const k of cles) { ajouter(parCle, k, p); for (const t of k.split(" ")) mots.add(t); }
    for (const t of mots) ajouter(parMot, t, p);
    motsDe.set(p.id, mots);
  }
  return { parCle, parMot, motsDe };
}

export type Resolution =
  | { statut: "SUR"; doctorId: string }
  | { statut: "A_VERIFIER"; doctorId: string | null; candidats: string[] };

/**
 * UN NOM ÉCRIT → UNE FICHE. SÛR : le nom complet désigne une seule fiche (ou une seule dans l'établissement du rapport),
 * ou le seul nom de famille désigne une seule fiche DANS l'établissement du rapport. À VÉRIFIER : le seul nom de famille
 * désigne une fiche ailleurs (la fiche est retenue, le lien le dira), ou plusieurs fiches (aucune n'est retenue).
 * Aucun candidat : null.
 */
export function resoudreNom(nom: string, index: IndexPraticiens, institutionId: string | null): Resolution | null {
  const cle = cleNom(nom);
  if (!cle) return null;
  const exacts = index.parCle.get(cle) ?? [];
  if (exacts.length === 1) return { statut: "SUR", doctorId: exacts[0].id };
  if (exacts.length > 1) {
    const meme = institutionId ? exacts.filter((p) => p.institutionId === institutionId) : [];
    if (meme.length === 1) return { statut: "SUR", doctorId: meme[0].id };
    return { statut: "A_VERIFIER", doctorId: null, candidats: exacts.map((p) => p.id).slice(0, 5) };
  }
  const mots = cle.split(" ");
  const premiers = index.parMot.get(mots[0]) ?? [];
  const partiels = premiers.filter((p) => mots.every((t) => index.motsDe.get(p.id)?.has(t)));
  if (partiels.length === 0) return null;
  const meme = institutionId ? partiels.filter((p) => p.institutionId === institutionId) : [];
  if (meme.length === 1) return { statut: "SUR", doctorId: meme[0].id };
  if (partiels.length === 1) return { statut: "A_VERIFIER", doctorId: partiels[0].id, candidats: [partiels[0].id] };
  return { statut: "A_VERIFIER", doctorId: null, candidats: partiels.map((p) => p.id).slice(0, 5) };
}

/** Le libellé court d'un praticien sur le graphe : « Pr Benali », « Dr K. ». */
export function libelleCourt(nom: string, grade: string | null): string {
  const t = nom.replace(/^\s*(dr|pr|prof|docteur|professeur)\.?\s+/i, "").trim();
  const mots = t.split(/\s+/).filter(Boolean);
  const famille = mots[0] ?? t;
  const prefixe = grade === "PROFESSEUR" ? "Pr" : grade === "PHARMACIEN" ? "Ph." : "Dr";
  return `${prefixe} ${famille.length > 12 ? famille.slice(0, 11) + "." : famille}`;
}
