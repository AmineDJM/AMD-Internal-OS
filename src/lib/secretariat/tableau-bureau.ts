import { estOuverte, type LigneBureau } from "./ligne-bureau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DU BUREAU — ses règles d'AFFICHAGE, pures (maquette validée le 24/11/2026).
 *
 *   • `periodeCourte`     — la colonne « Dates » (« 11 → 14 déc. ») ;
 *   • `echeanceAffichee`  — la colonne « Échéance » : la date (rouge, « en retard », si elle est passée),
 *                           sinon « depuis n j » pour une ligne ouverte sans échéance ;
 *   • `masqueeParDefaut`  — les closes de plus de 30 jours ne s'affichent que sur demande ;
 *   • `correspondRecherche` — l'unique recherche : objet, référence, demandeur, personne.
 *
 * Les dates se lisent à l'heure d'Alger (UTC+1, sans heure d'été) et les mois s'écrivent à la main : le
 * serveur et le navigateur rendent le même texte, sans écart d'hydratation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const JOUR_MS = 86_400_000;
const ALGER_MS = 3_600_000;
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function jourAlger(iso: string): { j: number; m: number; a: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + ALGER_MS);
  return { j: d.getUTCDate(), m: d.getUTCMonth(), a: d.getUTCFullYear() };
}

/** « 2 déc. » */
export function jourCourt(iso: string | null | undefined): string | null {
  const d = iso ? jourAlger(iso) : null;
  return d ? `${d.j} ${MOIS[d.m]}` : null;
}

/**
 * LA COLONNE « DATES » — « 11 → 14 déc. » (même mois), « 28 nov. → 3 déc. », « 11 déc. » (un seul jour ou
 * pas de fin), `null` sans début.
 */
export function periodeCourte(debut: string | null | undefined, fin: string | null | undefined): string | null {
  const a = debut ? jourAlger(debut) : null;
  const b = fin ? jourAlger(fin) : null;
  if (!a) return b ? `→ ${b.j} ${MOIS[b.m]}` : null;
  if (!b || (a.j === b.j && a.m === b.m && a.a === b.a)) return `${a.j} ${MOIS[a.m]}`;
  if (a.m === b.m && a.a === b.a) return `${a.j} → ${b.j} ${MOIS[b.m]}`;
  return `${a.j} ${MOIS[a.m]} → ${b.j} ${MOIS[b.m]}`;
}

/** En retard : ouverte, et le JOUR de son échéance est passé (l'échéance du jour n'est pas encore en retard). */
export function ligneEnRetard(l: Pick<LigneBureau, "etat" | "echeance">, maintenant: number): boolean {
  if (!l.echeance || !estOuverte(l.etat)) return false;
  const t = Date.parse(l.echeance);
  return Number.isFinite(t) && t + JOUR_MS <= maintenant;
}

/** LA COLONNE « ÉCHÉANCE » — `retard` colore la cellule ; une ligne close sans échéance lit « — ». */
export function echeanceAffichee(l: Pick<LigneBureau, "etat" | "echeance" | "depuis">, maintenant: number): { texte: string; retard: boolean } {
  if (l.echeance) {
    const retard = ligneEnRetard(l, maintenant);
    const jour = jourCourt(l.echeance) ?? "—";
    return { texte: retard ? `${jour} · en retard` : jour, retard };
  }
  if (!estOuverte(l.etat)) return { texte: "—", retard: false };
  const t = Date.parse(l.depuis);
  if (!Number.isFinite(t)) return { texte: "—", retard: false };
  const n = Math.max(0, Math.floor((maintenant - t) / JOUR_MS));
  return { texte: n === 0 ? "depuis aujourd'hui" : `depuis ${n} j`, retard: false };
}

/** Le délai au-delà duquel une ligne close ne s'affiche plus d'office. */
export const JOURS_TERMINEES_VISIBLES = 30;

/** Close depuis plus de 30 jours : masquée tant qu'on ne demande pas « Voir plus de terminées ». */
export function masqueeParDefaut(l: Pick<LigneBureau, "etat" | "depuis" | "termineeLe">, maintenant: number): boolean {
  if (estOuverte(l.etat)) return false;
  const t = Date.parse(l.termineeLe ?? l.depuis);
  return Number.isFinite(t) && maintenant - t > JOURS_TERMINEES_VISIBLES * JOUR_MS;
}

/** Sans accent, sans casse, espaces resserrés : « Hôtel » se trouve en tapant « hotel ». */
export function plier(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** L'UNIQUE RECHERCHE — chaque mot tapé doit se trouver quelque part dans la ligne (type, objet, référence, demandeur, personne). */
export function correspondRecherche(l: Pick<LigneBureau, "type" | "objet" | "reference" | "demandeur" | "recherche">, requete: string): boolean {
  const mots = plier(requete).split(" ").filter(Boolean);
  if (mots.length === 0) return true;
  const texte = plier([l.type, l.objet, l.reference, l.demandeur, l.recherche].filter(Boolean).join(" "));
  return mots.every((m) => texte.includes(m));
}
