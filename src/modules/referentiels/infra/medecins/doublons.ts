import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { clePaire, proposerFusionsMedecins, type FicheMedecinComparee, type PropositionFusionMedecin } from "../../domaine/medecins/doublons";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PROPOSITIONS DE FUSION DE FICHES MÉDECINS — pour le SUPER ADMIN SEUL (lot T2, décision 0062).
 *
 * Elles se CALCULENT à chaque lecture sur l'annuaire vivant (fiches non archivées) ; la décision seule s'écrit
 * (`DecisionFusionMedecin`). Une paire FUSIONNÉE ne revient pas (la fiche absorbée est archivée) ; une paire ÉCARTÉE
 * ne revient que si son empreinte a changé (l'une des deux fiches a été modifiée depuis). Toute autre personne reçoit
 * une liste VIDE — la fonction ne se laisse même pas deviner.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const peutDeciderFusionMedecins = (user: Pick<SessionUser, "role"> & { impersonatedBy?: unknown }): boolean =>
  user.role === "SUPER_ADMIN" && !user.impersonatedBy;

/** Les fiches comparées : l'annuaire vivant, avec ce qui leur est rattaché. */
async function fichesComparees(ids?: readonly string[]): Promise<FicheMedecinComparee[]> {
  const ds = await prisma.medicalDoctor.findMany({
    where: { archivedAt: null, ...(ids ? { id: { in: [...ids] } } : {}) },
    select: {
      id: true, name: true, phone: true, email: true, wilaya: true, specialty: true, institution: true,
      specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } }, delegate: { select: { name: true } },
      _count: { select: { visits: true, fieldReports: true, adProMedecins: true, promoRemises: true, segmentationFiches: true, segmentationObservations: true } },
    },
    take: 20_000,
  });
  return ds.map((d) => ({
    id: d.id, name: d.name, phone: d.phone, email: d.email, wilaya: d.wilaya,
    specialite: d.specialtyRef?.name ?? d.specialty ?? null, etablissement: d.institutionRef?.name ?? d.institution ?? null, delegue: d.delegate?.name ?? null,
    rattaches: {
      visites: d._count.visits, rapportsTerrain: d._count.fieldReports, demandesAdPro: d._count.adProMedecins,
      remisesMateriel: d._count.promoRemises, segmentation: d._count.segmentationFiches + d._count.segmentationObservations,
    },
  }));
}

/** Les propositions ouvertes : calculées, moins celles déjà tranchées (écartée sans changement, ou fusionnée). */
export async function propositionsFusionMedecins(user: Pick<SessionUser, "role"> & { impersonatedBy?: unknown }): Promise<PropositionFusionMedecin[]> {
  if (!peutDeciderFusionMedecins(user)) return [];
  const propositions = proposerFusionsMedecins(await fichesComparees());
  if (!propositions.length) return [];
  const decisions = await prisma.decisionFusionMedecin.findMany({ where: { cle: { in: propositions.map((p) => p.cle) } }, select: { cle: true, decision: true, empreinte: true } });
  const parCle = new Map(decisions.map((d) => [d.cle, d]));
  return propositions.filter((p) => {
    const d = parCle.get(p.cle);
    return !d || (d.decision === "ECARTEE" && d.empreinte !== p.empreinte);
  });
}

/** LA proposition d'une paire, relue au moment du clic (ce que la personne a vu doit être ce qui s'exécute). */
export async function propositionDeLaPaire(a: string, b: string): Promise<PropositionFusionMedecin | null> {
  const cle = clePaire(a, b);
  return proposerFusionsMedecins(await fichesComparees([a, b])).find((p) => p.cle === cle) ?? null;
}
