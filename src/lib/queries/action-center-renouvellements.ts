import { prisma } from "@/lib/prisma";
import { hasRole, scopeRegulatory, userCan, type SessionUser } from "@/lib/rbac";
import { ajouterMois, PALIERS_ALERTE_MOIS, STATUT_VALIDITE, statutValidite } from "@/lib/regulatory/validite-enregistrement";
import type { ActionItem } from "./action-center";

/**
 * « AUJOURD'HUI » — LES DÉCISIONS D'ENREGISTREMENT À RENOUVELER (Super Admin, 24/11/2026).
 *
 * Une ligne par produit enregistré dont la fin de validité est à moins de 12 mois (premier palier d'alerte), ou
 * passée — au rouge alors. Pour le Responsable réglementaire, tout le portefeuille qu'il voit ; pour les autres, les
 * dossiers dont ils sont responsables. La ligne se tait dès qu'une nouvelle décision repousse la fin de validité.
 */
export async function lignesRenouvellements(user: SessionUser, maintenant = new Date()): Promise<ActionItem[]> {
  if (!userCan(user, "REGULATORY", "VIEW") && !userCan(user, "REGULATORY_PIPELINE", "VIEW")) return [];
  const chef = hasRole(user, "HEAD_OF_REGULATORY");
  const horizon = ajouterMois(maintenant, Math.max(...PALIERS_ALERTE_MOIS));
  const dossiers = await prisma.regulatoryProduct.findMany({
    where: { AND: [scopeRegulatory(user), { registrationValidUntil: { not: null, lte: horizon } }, chef ? {} : { responsibleId: user.id }] },
    select: { id: true, reference: true, dci: true, brandName: true, priority: true, registrationValidUntil: true, registrationDecisionNumber: true },
    orderBy: { registrationValidUntil: "asc" },
  });
  return dossiers.map((d) => {
    const statut = statutValidite(d.registrationValidUntil, maintenant) ?? "A_RENOUVELER";
    return {
      key: `reg-de-${d.id}`, objet: `REGULATORY_PRODUCT_DE:${d.id}`,
      title: `Renouveler la DE — ${d.brandName ?? d.dci}`,
      subtitle: `${d.reference}${d.registrationDecisionNumber ? ` · DE n° ${d.registrationDecisionNumber}` : ""}`,
      module: "Regulatory", href: `/regulatory/${d.id}#enregistrement`, kind: "regulatory" as const,
      priority: statut === "EXPIREE" ? "CRITICAL" : d.priority,
      deadline: d.registrationValidUntil!.toISOString(), depuis: null, owner: "",
      statusLabel: STATUT_VALIDITE[statut].label, statusTone: STATUT_VALIDITE[statut].tone,
    };
  });
}
