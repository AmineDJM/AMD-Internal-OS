"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { businessUnitDuDemandeur } from "@/lib/ad-pro/business-unit-auto";
import { refusCategoriePourLaDemande } from "@/lib/ad-pro/categorie-budgetaire-serveur";
import { peutImputerMaterielPromo, refusImputationPromo, REFUS_IMPUTATION_PROMO } from "@/lib/promo-material/budget";
import { depensesDesDossiersPromo } from "@/lib/queries/promo-budget";
import { DOMAINES } from "@/lib/budget/domaines";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * IMPUTER UN MATÉRIEL PROMOTIONNEL À UN BUDGET (Direction, 27/10 — point 21).
 *
 * « Matériel promotionnel hors budget » : la Direction Marketing choisit la (sous-)catégorie du Budget Marketing qui
 * porte le dossier. La catégorie doit convenir au matériel promotionnel, à l'exercice de la demande et à sa gamme
 * (`ad-pro/categorie-budgetaire.ts`). Ses BC signés y comptent en engagé, ses ordres fournisseur en consommé
 * (`queries/budget-sources.ts`) ; les ordres déjà nés et les écritures qu'ils ont réglées SUIVENT la catégorie, comme
 * pour un poste Ad & Pro (`budget-depense-poste-actions.ts`).
 *
 * La gamme du dossier : un dossier né avant le 27/10 n'en portait aucune. Elle s'écrit ici quand elle se lit sur le
 * demandeur — à coup sûr (`businessUnitDuDemandeur`) —, avant le contrôle de la catégorie.
 */
export async function imputerBudgetMaterielPromo(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutImputerMaterielPromo(user)) return { ok: false, error: REFUS_IMPUTATION_PROMO };
  const id = fdStr(formData, "promoMaterialId");
  const cibleId = fdStr(formData, "budgetCategoryId");
  if (!id) return { ok: false, error: "Dossier non précisé." };
  const pm = await prisma.promoMaterial.findUnique({
    where: { id },
    select: {
      id: true, reference: true, title: true, status: true, circuitState: true, requesterId: true, businessUnitId: true,
      budgetCategoryId: true, paymentOrderId: true, settlementOrderId: true, updatedAt: true,
    },
  });
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const cible = cibleId
    ? await prisma.budgetCategoryLine.findUnique({ where: { id: cibleId }, select: { id: true, name: true, envelope: { select: { name: true, domaine: true } } } })
    : null;
  if (cibleId && !cible) return { ok: false, error: "Catégorie budgétaire introuvable." };
  const refus = refusImputationPromo({
    dossierRefuse: pm.circuitState === "REFUSED" || pm.status === "CANCELLED",
    cible: cible ? { id: cible.id, domaine: cible.envelope.domaine } : null,
    actuelleId: pm.budgetCategoryId,
  });
  if (refus || !cible) return { ok: false, error: refus ?? "Choisissez une catégorie du Budget Marketing." };

  // La gamme du demandeur, si le dossier n'en porte pas encore et qu'elle se lit à coup sûr.
  if (!pm.businessUnitId && pm.requesterId) {
    const demandeur = await prisma.user.findUnique({ where: { id: pm.requesterId }, select: { id: true, role: true, secondaryRole: true } });
    const bu = demandeur ? await businessUnitDuDemandeur(demandeur) : null;
    if (bu) await prisma.promoMaterial.updateMany({ where: { id, businessUnitId: null }, data: { businessUnitId: bu.id } });
  }
  const refusCat = await refusCategoriePourLaDemande(cible.id, "PROMO_MATERIAL", id);
  if (refusCat) return { ok: false, error: refusCat };

  const lue = (await depensesDesDossiersPromo([pm])).get(pm.id);
  const ordres = (lue?.ordres ?? []).filter((o) => o.statut !== "CANCELLED");
  const ecritures = ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x));
  const fait = await prisma.$transaction(async (tx) => {
    // CONDITIONNELLE : deux imputations croisées n'en posent qu'une.
    const prise = await tx.promoMaterial.updateMany({
      where: { id, budgetCategoryId: pm.budgetCategoryId, updatedAt: pm.updatedAt },
      data: { budgetCategoryId: cible.id, budgetImputeLe: new Date(), budgetImputeParId: user.id, updatedById: user.id },
    });
    if (prise.count === 0) return false;
    if (ordres.length) await tx.expenseOrder.updateMany({ where: { id: { in: ordres.map((o) => o.id) } }, data: { budgetCategoryId: cible.id } });
    if (ecritures.length) await tx.financeTransaction.updateMany({ where: { id: { in: ecritures } }, data: { budgetCategoryId: cible.id } });
    return true;
  });
  if (!fait) return { ok: false, error: "Ce dossier vient de changer : rouvrez la fiche." };

  const nom = `${cible.envelope.name} › ${cible.name}`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id,
    field: "budgetCategoryId", oldValue: pm.budgetCategoryId, newValue: cible.id,
    summary: `${pm.reference} imputé au budget « ${nom} »${ordres.length ? ` (${ordres.length} ordre${ordres.length > 1 ? "s" : ""} fournisseur suivent)` : ""}.`,
  }).catch(() => undefined);
  revalidatePath(`/promo-material/${id}`);
  revalidatePath(DOMAINES.MARKETING.chemin);
  revalidatePath("/budgets");
  const engage = lue?.engage ?? 0;
  return {
    ok: true, id,
    message: `Imputé sur « ${cible.name} »${engage > 0 ? ` : ${Math.round(engage).toLocaleString("fr-FR")} DZD engagés (BC signés)` : " : les BC signés y compteront en engagé"}.`,
  };
}
