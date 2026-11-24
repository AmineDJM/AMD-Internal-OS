/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GRAPHE D'INFLUENCE QUAND DEUX FICHES MÉDECIN FUSIONNENT — la part PURE (lien L4 du recensement).
 *
 * La fusion repointait visites, rapports, Ad & Pro, segmentation… mais PAS les liens d'influence : ils restaient sur la
 * fiche absorbée, archivée — invisibles de la fiche gardée, et perdus si l'on purgeait un jour les archives (la clé
 * étrangère est en cascade). Le plan, lien par lien :
 *   • DÉPLACER — l'absorbée devient la gardée, de part ou d'autre du lien ;
 *   • DOUBLON — la gardée porte DÉJÀ le même lien (même autre médecin, même type) : on garde le sien ; si l'humain avait
 *     tranché sur le lien absorbé (confirmé, rejeté) et pas sur celui de la gardée, sa décision passe sur le lien gardé ;
 *   • BOUCLE — un lien entre les deux fiches fusionnées deviendrait « X influence X » : il n'a plus de sens.
 * Le geste de fusion retire doublons et boucles (il est réversible d'un coup) ; le CONTRÔLE des clés, lui, ne retire rien
 * et les signale.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LienInfluenceLu {
  id: string;
  fromDoctorId: string;
  toDoctorId: string;
  type: string;
  statut: string;
}

export interface PlanRepointage {
  deplacer: { id: string; fromDoctorId: string; toDoctorId: string }[];
  doublons: { retirerId: string; garderId: string; reprendreDecision: boolean }[];
  boucles: string[];
}

const DECIDE = new Set(["CONFIRMEE", "REJETEE"]);

/** `liens` : tous les liens qui touchent l'absorbée OU la gardée. */
export function planRepointage(liens: readonly LienInfluenceLu[], absorbeId: string, gardeId: string): PlanRepointage {
  const plan: PlanRepointage = { deplacer: [], doublons: [], boucles: [] };
  if (!absorbeId || !gardeId || absorbeId === gardeId) return plan;
  const cle = (from: string, to: string, type: string) => `${from}→${to}|${type}`;
  const existants = new Map<string, LienInfluenceLu>();
  for (const l of liens) if (l.fromDoctorId !== absorbeId && l.toDoctorId !== absorbeId) existants.set(cle(l.fromDoctorId, l.toDoctorId, l.type), l);
  for (const l of liens) {
    if (l.fromDoctorId !== absorbeId && l.toDoctorId !== absorbeId) continue;
    const from = l.fromDoctorId === absorbeId ? gardeId : l.fromDoctorId;
    const to = l.toDoctorId === absorbeId ? gardeId : l.toDoctorId;
    if (from === to) { plan.boucles.push(l.id); continue; }
    const deja = existants.get(cle(from, to, l.type));
    if (deja) {
      plan.doublons.push({ retirerId: l.id, garderId: deja.id, reprendreDecision: DECIDE.has(l.statut) && !DECIDE.has(deja.statut) });
      continue;
    }
    plan.deplacer.push({ id: l.id, fromDoctorId: from, toDoctorId: to });
    // Deux liens absorbés ne peuvent tomber sur la même clé (l'unicité (from, to, type) les distinguait déjà) ; on la
    // réserve tout de même, pour qu'un lien de la gardée lu plus loin ne passe pas pour libre.
    existants.set(cle(from, to, l.type), { ...l, fromDoctorId: from, toDoctorId: to });
  }
  return plan;
}

/**
 * LA FICHE QUI RESTE au bout d'une chaîne de fusions (A absorbée dans B, B absorbée plus tard dans C → C). Une boucle
 * (données incohérentes) s'arrête au premier retour : on ne repointe pas vers une fiche qu'on ne sait pas désigner.
 */
export function ficheFinale(id: string, gardeDe: ReadonlyMap<string, string>): string | null {
  const vus = new Set<string>([id]);
  let courant = id;
  for (;;) {
    const suivant = gardeDe.get(courant);
    if (!suivant) return courant === id ? null : courant;
    if (vus.has(suivant)) return null;
    vus.add(suivant);
    courant = suivant;
  }
}
