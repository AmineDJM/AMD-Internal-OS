import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TRANCHER UNE PROPOSITION DE DOUBLON — le geste HUMAIN (décision de la Direction : jamais d'office).
 *
 *   FUSIONNER  l'absorbée garde sa ligne, ses identifiants et ses fiches d'origine ; elle désigne la
 *              survivante par `fusionneeDansId`. La fiche 360° de la survivante réunit les deux. Rien
 *              n'est effacé : c'est ce qui rend le geste RÉVERSIBLE (`defaireFusion`).
 *   ÉCARTER    ce ne sont pas les mêmes : la paire n'est plus jamais reproposée.
 *
 * Qui tranche : le Super Admin (l'action le vérifie) — la Direction n'a pas encore dit si le responsable du
 * module le fera aussi (`refonte-donnees-et-monolithe-modulaire.md` §6, décision 2). L'audit est posé par
 * l'action, avec les deux noms.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export class RefusFusion extends Error {}

export interface FusionFaite { absorbee: { id: string; raisonSociale: string }; survivante: { id: string; raisonSociale: string } }

export async function fusionner(propositionId: string, survivanteId: string, acteurId: string): Promise<FusionFaite> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.propositionDoublonOrganisation.findUnique({ where: { id: propositionId } });
    if (!p) throw new RefusFusion("Proposition introuvable.");
    if (p.statut !== "PROPOSEE") throw new RefusFusion("Cette proposition a déjà été tranchée.");
    if (survivanteId !== p.organisationAId && survivanteId !== p.organisationBId) throw new RefusFusion("La fiche conservée doit être l'une des deux.");
    const absorbeeId = survivanteId === p.organisationAId ? p.organisationBId : p.organisationAId;
    const [survivante, absorbee] = await Promise.all([
      tx.organisation.findUnique({ where: { id: survivanteId }, select: { id: true, raisonSociale: true, fusionneeDansId: true } }),
      tx.organisation.findUnique({ where: { id: absorbeeId }, select: { id: true, raisonSociale: true, fusionneeDansId: true } }),
    ]);
    if (!survivante || !absorbee) throw new RefusFusion("Organisation introuvable.");
    if (survivante.fusionneeDansId || absorbee.fusionneeDansId) throw new RefusFusion("L'une des deux a déjà été fusionnée dans une autre fiche.");
    await tx.organisation.update({ where: { id: absorbeeId }, data: { fusionneeDansId: survivanteId } });
    await tx.propositionDoublonOrganisation.update({
      where: { id: propositionId }, data: { statut: "FUSIONNEE", decideeParId: acteurId, decideeLe: new Date() },
    });
    return { absorbee: { id: absorbee.id, raisonSociale: absorbee.raisonSociale }, survivante: { id: survivante.id, raisonSociale: survivante.raisonSociale } };
  });
}

export async function ecarter(propositionId: string, acteurId: string): Promise<{ a: string; b: string }> {
  const r = await prisma.propositionDoublonOrganisation.updateMany({
    where: { id: propositionId, statut: "PROPOSEE" }, data: { statut: "ECARTEE", decideeParId: acteurId, decideeLe: new Date() },
  });
  if (r.count === 0) throw new RefusFusion("Proposition introuvable ou déjà tranchée.");
  const p = await prisma.propositionDoublonOrganisation.findUniqueOrThrow({ where: { id: propositionId }, select: { organisationAId: true, organisationBId: true } });
  return { a: p.organisationAId, b: p.organisationBId };
}

/** DÉFAIRE UNE FUSION : l'absorbée redevient une fiche à part, la proposition redevient à trancher. */
export async function defaireFusion(organisationId: string): Promise<{ id: string; raisonSociale: string; survivanteId: string }> {
  return prisma.$transaction(async (tx) => {
    const o = await tx.organisation.findUnique({ where: { id: organisationId }, select: { id: true, raisonSociale: true, fusionneeDansId: true } });
    if (!o) throw new RefusFusion("Organisation introuvable.");
    if (!o.fusionneeDansId) throw new RefusFusion("Cette organisation n'est fusionnée dans aucune autre.");
    const survivanteId = o.fusionneeDansId;
    await tx.organisation.update({ where: { id: o.id }, data: { fusionneeDansId: null } });
    const [a, b] = o.id < survivanteId ? [o.id, survivanteId] : [survivanteId, o.id];
    await tx.propositionDoublonOrganisation.updateMany({
      where: { organisationAId: a, organisationBId: b, statut: "FUSIONNEE" }, data: { statut: "PROPOSEE", decideeParId: null, decideeLe: null },
    });
    return { id: o.id, raisonSociale: o.raisonSociale, survivanteId };
  });
}
