/**
 * Moteur de workflow — LA PRISE DU CIRCUIT : un seul geste à la fois sur une instance, avec
 * péremption d'une prise orpheline.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN GESTE À LA FOIS SUR UN CIRCUIT (§118.186).
 *
 * Approuver, refuser, sauter, renvoyer, resoumettre, retirer, relancer, faire appel : chaque
 * geste PREND le circuit avant son premier effet et le REND à la fin, même en échec.
 *
 * ── LE DÉFAUT QUE LA PRISE FERME ─────────────────────────────────────────────────────────
 *
 * Les écritures du moteur n'étaient pas conditionnelles : deux clics à une seconde d'intervalle
 * sur « Approuver » à l'étape qui tranche lisaient le même état, et chacun émettait son ordre de
 * dépense. Le renvoi pour correction a rendu le défaut plus probable — un validateur renvoie
 * pendant qu'un autre approuve, et les deux s'appliquent : la demande est « à corriger » chez son
 * demandeur ET approuvée.
 *
 * ── POURQUOI UNE CONDITION SUR L'ÉTAT NE SUFFIT PAS ─────────────────────────────────────
 *
 * L'approbation ne déplace l'étape qu'à sa FIN (après l'émission, la projection, les
 * franchissements). Un second geste lu pendant ce temps voit l'étape INCHANGÉE et la croit
 * libre : une condition `currentSlug = étape` le laisserait passer. Il faut un fait posé AU
 * DÉBUT et retiré à la fin — c'est la prise, écrite conditionnellement : celui qui la pose gagne,
 * l'autre trouve le circuit pris (ou déjà déplacé) et le dit.
 *
 * ── CE QUI EMPÊCHE UNE PANNE DE BLOQUER UN CIRCUIT ──────────────────────────────────────
 *
 * Une prise plus vieille que deux minutes est réputée abandonnée (processus tombé en plein
 * geste) et se reprend. Le geste le plus long du moteur — une approbation qui émet — dure une
 * fraction de seconde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PRISE_PERIMEE_MS = 2 * 60_000;

export const CIRCUIT_PRIS = "La demande vient de changer, ou quelqu'un agit dessus au même instant : rouvrez-la pour voir où elle en est.";

/**
 * LA PRISE ET SA RESTITUTION — leurs ARGUMENTS, partagés par tous les gestes, qui gardent chacun
 * l'APPEL Prisma dans leur propre corps (même raison que `clotureDuCircuit` : la dérivation des
 * contrats ne suit qu'un niveau). La prise ne se pose que si le circuit est dans l'`etat` attendu
 * ET libre (ou abandonné) : `count === 0` dit qu'un autre geste l'a, ou que l'état a changé.
 */
export function argsPrise(instanceId: string, etat: Prisma.WorkflowInstanceWhereInput, maintenant: Date) {
  return {
    where: { AND: [{ id: instanceId }, etat, { OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(maintenant.getTime() - PRISE_PERIMEE_MS) } }] }] },
    data: { claimedAt: maintenant },
  } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

/** Rend la prise — la SIENNE seulement : une prise reprise après abandon appartient à un autre. */
export function argsRendre(instanceId: string, prise: Date) {
  return { where: { id: instanceId, claimedAt: prise }, data: { claimedAt: null } } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

/**
 * Prendre en ATTENDANT qu'un geste en cours se termine — réservé aux suites d'une écriture déjà
 * faite (une modification enregistrée doit encore rouvrir sa porte). Un geste humain, lui, ne
 * patiente pas : il refuse tout de suite et le dit.
 */
export async function prendreLeCircuitEnAttendant(instanceId: string, etat: Prisma.WorkflowInstanceWhereInput, patienceMs: number): Promise<Date | null> {
  const fin = Date.now() + patienceMs;
  for (;;) {
    const maintenant = new Date();
    const posee = await prisma.workflowInstance.updateMany(argsPrise(instanceId, etat, maintenant));
    if (posee.count > 0) return maintenant;
    if (Date.now() >= fin) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
