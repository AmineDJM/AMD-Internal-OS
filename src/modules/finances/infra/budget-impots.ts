import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import {
  CATEGORIES_BUDGET_IMPOTS, CATEGORIES_SOUS_NATURES, CODE_ENVELOPPE_IMPOTS, nomEnveloppeImpots, type CleLigneBudgetImpots,
  type CleSousNatureTaxe,
} from "../domaine/budget-impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENVELOPPE « IMPÔTS & TAXES » D'UNE SOCIÉTÉ POUR UNE ANNÉE — trouvée, sinon ouverte d'office (Super Admin, 24/11/2026).
 *
 * Sur le modèle des enveloppes de pôle (`lib/budget/enveloppes-pole.ts`) : une `BudgetEnvelope` ordinaire (domaine
 * GENERAL : Budgets la lit avec les autres), reconnue par son code `module = IMPOTS_TAXES`, ses lignes par leur `cle`
 * stable (`domaine/budget-impots.ts`) — les sous-natures des autres taxes en SOUS-CATÉGORIES de `AUTRES_TAXES` —,
 * montants à 0 : la campagne budgétaire les fixe. Idempotent : une ligne qui existe
 * (même clé, ou même nom créé à la main) n'est pas recréée ; l'ouverture est sérialisée dans le processus (deux envois
 * simultanés n'ouvrent pas deux enveloppes). C'est l'IMPUTATION d'un ordre qui la demande, pas un geste de gestion.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function lignesBudgetImpots(
  companyId: string, date: Date, actorId: string | null,
): Promise<Map<CleLigneBudgetImpots | CleSousNatureTaxe, string>> {
  const annee = date.getUTCFullYear();
  return enSerie(`enveloppe-impots:${companyId}:${annee}`, async () => {
    let enveloppe = await prisma.budgetEnvelope.findFirst({
      where: { companyId, module: CODE_ENVELOPPE_IMPOTS, periodStart: { lte: date }, periodEnd: { gte: date } },
      orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
      select: { id: true },
    });
    if (!enveloppe) {
      enveloppe = await prisma.budgetEnvelope.create({
        data: {
          name: nomEnveloppeImpots(annee), companyId, module: CODE_ENVELOPPE_IMPOTS, modules: ["FINANCES_IMPOTS"], domaine: "GENERAL",
          periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59, 59)), totalAmount: 0,
          createdById: actorId,
        },
        select: { id: true },
      });
      await recordAudit({
        actorId, action: "CREATE", module: "Budgets", entityId: enveloppe.id,
        summary: `Enveloppe « ${nomEnveloppeImpots(annee)} » ouverte d'office pour l'imputation des impôts et cotisations — montants à fixer par la campagne budgétaire`,
      });
    }
    const toutes = await prisma.budgetCategoryLine.findMany({
      where: { envelopeId: enveloppe.id }, select: { id: true, name: true, cle: true, parentId: true },
    });
    const existantes = toutes.filter((c) => c.parentId === null);
    const out = new Map<CleLigneBudgetImpots | CleSousNatureTaxe, string>();
    for (const c of CATEGORIES_BUDGET_IMPOTS) {
      const deja = existantes.find((e) => e.cle === c.cle) ?? existantes.find((e) => !e.cle && e.name === c.nom);
      if (deja) {
        // Une ligne du même nom, créée à la main, devient la ligne reconnue (sa clé), sans doublon.
        if (!deja.cle) await prisma.budgetCategoryLine.updateMany({ where: { id: deja.id, cle: null }, data: { cle: c.cle } });
        out.set(c.cle, deja.id);
        continue;
      }
      const cree = await prisma.budgetCategoryLine.create({ data: { envelopeId: enveloppe.id, name: c.nom, cle: c.cle, allocated: 0 }, select: { id: true } });
      out.set(c.cle, cree.id);
    }
    // Les sous-natures des autres taxes : des sous-catégories de AUTRES_TAXES, à clé stable.
    const mere = out.get("AUTRES_TAXES")!;
    const filles = toutes.filter((c) => c.parentId === mere);
    for (const c of CATEGORIES_SOUS_NATURES) {
      const deja = filles.find((e) => e.cle === c.cle) ?? filles.find((e) => !e.cle && e.name === c.nom);
      if (deja) {
        if (!deja.cle) await prisma.budgetCategoryLine.updateMany({ where: { id: deja.id, cle: null }, data: { cle: c.cle } });
        out.set(c.cle, deja.id);
        continue;
      }
      const cree = await prisma.budgetCategoryLine.create({ data: { envelopeId: enveloppe.id, parentId: mere, name: c.nom, cle: c.cle, allocated: 0 }, select: { id: true } });
      out.set(c.cle, cree.id);
    }
    return out;
  });
}
