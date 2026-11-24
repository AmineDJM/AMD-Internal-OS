import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import { bornesAnnee } from "@/lib/budget/domaines";
import { STATUTS_ACCEPTES, estPoleAdministration, estStatutProposition, montantRetenu, nomEnveloppe, planEnveloppe, type LignePourEnveloppe } from "./regles";

/**
 * VALIDÉ = OUVERT — l'enveloppe de l'année d'un pôle, créée ou mise à jour depuis sa proposition validée.
 *
 * IDEMPOTENTE, et c'est sa raison d'être : une proposition porte AU PLUS une enveloppe (`envelopeId` unique), chaque
 * ligne retient sa catégorie (`categoryLineId`), et `planEnveloppe` ne rend rien quand l'enveloppe dit déjà la
 * proposition. Rejouée (clôture de la campagne après l'acceptation, double clic, deux serveurs), elle ne double rien.
 * Un rectificatif met à jour les allocations, une piste d'audit par catégorie changée (ancien → nouveau montant).
 */

export async function ouvrirEnveloppeDeLaProposition(proposalId: string, actorId: string | null): Promise<
  { ok: true; envelopeId: string; cree: boolean; changements: number } | { ok: false; error: string }
> {
  return enSerie(`campagne-enveloppe:${proposalId}`, async () => {
    const p = await prisma.budgetProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true, status: true, poleLabel: true, domaine: true, envelopeId: true, currentVersion: true, estRectificatif: true,
        campaign: { select: { year: true, title: true, companyId: true } },
        department: { select: { companyId: true, name: true, code: true, head: { select: { userId: true } }, deputy: { select: { userId: true } } } },
        lines: { select: { id: true, key: true, label: true, categoryKey: true, categoryLineId: true, propose: true, ajuste: true, decision: true } },
        versions: { select: { lines: true } },
      },
    });
    if (!p) return { ok: false, error: "Proposition introuvable." };
    if (!estStatutProposition(p.status) || !STATUTS_ACCEPTES.includes(p.status)) return { ok: false, error: "Seule une proposition validée ouvre son enveloppe." };

    const lignes: LignePourEnveloppe[] = p.lines.map((l) => ({
      key: l.key, label: l.label, categoryKey: l.categoryKey, categoryLineId: l.categoryLineId,
      montant: montantRetenu({ propose: toNumber(l.propose), ajuste: l.ajuste === null ? null : toNumber(l.ajuste), decision: l.decision }),
    }));
    // Les catégories liées par une version précédente : une ligne retirée depuis (rectificatif) remet la sienne à zéro.
    const liees = new Set<string>(p.lines.map((l) => l.categoryLineId).filter((x): x is string => Boolean(x)));
    for (const v of p.versions) {
      if (!Array.isArray(v.lines)) continue;
      for (const l of v.lines as unknown[]) {
        const id = l && typeof l === "object" ? (l as { categoryLineId?: unknown }).categoryLineId : null;
        if (typeof id === "string") liees.add(id);
      }
    }

    const existante = p.envelopeId
      ? await prisma.budgetEnvelope.findUnique({ where: { id: p.envelopeId }, select: { id: true, totalAmount: true, categories: { select: { id: true, name: true, cle: true, allocated: true, parentId: true } } } })
      : null;

    let envelopeId = existante?.id ?? null;
    let cree = false;
    if (!existante) {
      const { debut, fin } = bornesAnnee(p.campaign.year);
      const lecteurs = [p.department?.head?.userId, p.department?.deputy?.userId].filter((x): x is string => Boolean(x));
      // L'ENVELOPPE NAÎT ET SE LIE DANS LA MÊME TRANSACTION : si une autre l'a liée entre-temps, celle-ci est annulée.
      const r = await prisma.$transaction(async (tx) => {
        const env = await tx.budgetEnvelope.create({
          data: {
            name: nomEnveloppe(p.campaign.year, p.poleLabel), domaine: p.domaine,
            companyId: p.campaign.companyId ?? p.department?.companyId ?? null,
            periodStart: debut, periodEnd: fin, totalAmount: 0, isActive: true,
            accessUserIds: lecteurs,
            // LE BUDGET DE L'ADMINISTRATION est tenu par les FINANCES, pas par le DG (Super Admin, 24/11/2026).
            ...(p.department && estPoleAdministration(p.department.name, p.department.code) ? { managerRoles: ["FINANCE_BUDGET_MANAGER"] } : {}),
            notes: `Ouverte par la campagne budgétaire « ${p.campaign.title} » (v${p.currentVersion}).`,
            createdById: actorId,
          },
          select: { id: true },
        });
        const lie = await tx.budgetProposal.updateMany({ where: { id: p.id, envelopeId: null }, data: { envelopeId: env.id } });
        if (lie.count === 0) throw new Error("DEJA_LIEE");
        return env.id;
      }).catch((err: unknown) => (err instanceof Error && err.message === "DEJA_LIEE" ? null : Promise.reject(err)));
      if (!r) {
        const relu = await prisma.budgetProposal.findUnique({ where: { id: p.id }, select: { envelopeId: true } });
        if (!relu?.envelopeId) return { ok: false, error: "Enveloppe impossible à lier — réessayez." };
        envelopeId = relu.envelopeId;
      } else {
        envelopeId = r;
        cree = true;
      }
    }
    const env = await prisma.budgetEnvelope.findUnique({
      where: { id: envelopeId! },
      select: { id: true, totalAmount: true, categories: { select: { id: true, name: true, cle: true, allocated: true, parentId: true } } },
    });
    if (!env) return { ok: false, error: "Enveloppe introuvable." };

    const plan = planEnveloppe(lignes, env.categories.map((c) => ({ ...c, allocated: toNumber(c.allocated) })), [...liees]);
    const idParLigne = new Map(p.lines.map((l) => [l.key, l.id]));
    await prisma.$transaction(async (tx) => {
      for (const c of plan.creer) {
        const cat = await tx.budgetCategoryLine.create({ data: { envelopeId: env.id, name: c.nom, cle: c.cle, allocated: c.allocated }, select: { id: true } });
        const ligneId = idParLigne.get(c.key);
        if (ligneId) await tx.budgetProposalLine.update({ where: { id: ligneId }, data: { categoryLineId: cat.id } });
      }
      for (const m of plan.majCategories) await tx.budgetCategoryLine.update({ where: { id: m.categoryId }, data: { allocated: m.a } });
      for (const l of plan.liens) {
        const ligneId = idParLigne.get(l.key);
        if (ligneId) await tx.budgetProposalLine.update({ where: { id: ligneId }, data: { categoryLineId: l.categoryId } });
      }
      if (toNumber(env.totalAmount) !== plan.total) await tx.budgetEnvelope.update({ where: { id: env.id }, data: { totalAmount: plan.total } });
    });

    // LA PISTE D'AUDIT — chaque allocation changée, ancien → nouveau (rectificatif compris).
    for (const m of plan.majCategories) {
      await recordAudit({
        actorId, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: env.id, field: "allocated",
        oldValue: String(m.de), newValue: String(m.a),
        summary: `${p.estRectificatif ? "Rectificatif" : "Campagne budgétaire"} — « ${m.nom} » : ${m.de} → ${m.a} DZD (${p.poleLabel})`,
      });
    }
    if (cree || plan.creer.length > 0) {
      await recordAudit({
        actorId, action: "CREATE", module: "Budgets", entityType: "BUDGET", entityId: env.id,
        summary: `Campagne budgétaire — enveloppe ${nomEnveloppe(p.campaign.year, p.poleLabel)} : ${plan.creer.length} catégorie(s) créée(s), total ${plan.total} DZD`,
      });
    }
    return { ok: true, envelopeId: env.id, cree, changements: plan.creer.length + plan.majCategories.length + plan.liens.length };
  });
}
