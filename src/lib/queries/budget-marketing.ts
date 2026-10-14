import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { contextesDesCategories } from "@/lib/queries/budget-integration";
import { lienDemande } from "@/lib/budget-marketing/integration-vue";

/**
 * BUDGET MARKETING — ce que Budgets ne montrait pas : QUELLES DEMANDES Ad & Pro consomment l'enveloppe.
 *
 * Un poste Ad & Pro accordé est rangé dans une (sous-)catégorie d'enveloppe (`AdProItem.budgetCategoryId`). On remonte
 * de la catégorie au poste, puis à sa demande (sponsoring, congrès, événement…) et à son ordre de dépense : accordé,
 * engagé (ordre émis, non payé), réglé. L'accès à l'enveloppe est vérifié par l'appelant (`getBudgetOverview`).
 */

export interface LigneDemandeAdPro {
  id: string;
  demande: string;
  nature: string;
  href: string | null;
  poste: string;
  categorie: string;
  statut: string;
  accorde: number;
  engage: number;
  regle: number;
  /** Un poste HISTORIQUE (intégration Ad & Pro 2026) : payé, sans circuit — sa ligne du fichier. */
  historique?: { ligne: number | null } | null;
}

const STATUT_POSTE: Record<string, string> = {
  DRAFT: "En préparation", PENDING: "Soumis", REVISION: "À revoir", APPROVED: "Accordé", REJECTED: "Refusé",
};

export async function demandesAdProDeLEnveloppe(categories: readonly { id: string; name: string }[]): Promise<LigneDemandeAdPro[]> {
  if (categories.length === 0) return [];
  const nomCategorie = new Map(categories.map((c) => [c.id, c.name]));
  const postes = await prisma.adProItem.findMany({
    where: { budgetCategoryId: { in: [...nomCategorie.keys()] } },
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: {
      id: true, label: true, status: true, amountGranted: true, amountEstimated: true, budgetCategoryId: true, expenseOrderId: true,
      sponsoring: { select: { id: true, reference: true, institution: true } },
      congressNational: { select: { id: true, name: true } },
      congressInternational: { select: { id: true, name: true } },
      event: { select: { id: true, name: true } },
      training: { select: { id: true, title: true } },
      promoMaterialParent: { select: { id: true, reference: true, title: true } },
      declarationInfoMed: { select: { id: true, reference: true, label: true } },
      montantPayeHistorique: true, historiqueLigne: true, historiqueLotId: true,
    },
  });
  // Un poste historique ne compte que tant que son lot est actif (la règle d'intégration le lit de la même façon).
  const lotsActifs = new Set((await contextesDesCategories([...nomCategorie.keys()])).map((c) => c.regle.lotId));
  const ordreIds = postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordres = new Map(
    (ordreIds.length ? await prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, status: true, amount: true } }) : [])
      .map((o) => [o.id, o]),
  );
  return postes.map((p) => {
    const parent = p.sponsoring
      ? { demande: `${p.sponsoring.reference} — ${p.sponsoring.institution}`, nature: "Sponsoring", href: `/sponsoring/${p.sponsoring.id}` }
      : p.congressNational
        ? { demande: p.congressNational.name, nature: "Congrès national", href: `/congress-national/${p.congressNational.id}` }
        : p.congressInternational
          ? { demande: p.congressInternational.name, nature: "Congrès international", href: `/congress-international/${p.congressInternational.id}` }
          : p.event
            ? { demande: p.event.name, nature: "Événement", href: `/events/${p.event.id}` }
            : p.promoMaterialParent
              ? { demande: `${p.promoMaterialParent.reference} — ${p.promoMaterialParent.title}`, nature: "Matériel promotionnel", href: `/promo-material/${p.promoMaterialParent.id}` }
              : p.declarationInfoMed
                ? { demande: `${p.declarationInfoMed.reference} — ${p.declarationInfoMed.label}`, nature: "Information médicale", href: `/information-medicale/${p.declarationInfoMed.id}` }
                : { demande: p.training?.title ?? "—", nature: "Formation", href: p.training ? lienDemande("TRAINING", p.training.id) : null };
    const historique = p.montantPayeHistorique != null && p.historiqueLotId != null && lotsActifs.has(p.historiqueLotId);
    if (historique) {
      const montant = toNumber(p.montantPayeHistorique);
      return {
        id: p.id, ...parent, poste: p.label, categorie: nomCategorie.get(p.budgetCategoryId ?? "") ?? "—",
        statut: "Payé — Historique 2026", accorde: montant, engage: 0, regle: montant, historique: { ligne: p.historiqueLigne },
      };
    }
    const ordre = p.expenseOrderId ? ordres.get(p.expenseOrderId) : undefined;
    const montantOrdre = ordre ? toNumber(ordre.amount) : 0;
    return {
      id: p.id,
      ...parent,
      poste: p.label,
      categorie: nomCategorie.get(p.budgetCategoryId ?? "") ?? "—",
      statut: STATUT_POSTE[p.status] ?? p.status,
      accorde: toNumber(p.amountGranted ?? p.amountEstimated),
      engage: ordre && ordre.status === "PENDING" ? montantOrdre : 0,
      regle: ordre && ordre.status === "PAID" ? montantOrdre : 0,
    };
  });
}

export interface OptionsRattachement {
  businessUnits: { id: string; nom: string }[];
  produits: { id: string; nom: string }[];
}

/** Les BU et produits actifs auxquels une enveloppe marketing peut se rattacher (facultatif). */
export async function optionsRattachement(): Promise<OptionsRattachement> {
  const [bus, produits] = await Promise.all([
    prisma.businessUnit.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { isActive: true }, orderBy: { canonicalName: "asc" }, take: 500, select: { id: true, canonicalName: true } }),
  ]);
  return {
    businessUnits: bus.map((b) => ({ id: b.id, nom: b.name })),
    produits: produits.map((p) => ({ id: p.id, nom: p.canonicalName })),
  };
}

/** Libellé « BU · produit » d'une enveloppe, `null` quand elle n'est rattachée à rien. */
export async function libelleRattachement(e: { businessUnitId: string | null; productId: string | null }): Promise<string | null> {
  const [bu, produit] = await Promise.all([
    e.businessUnitId ? prisma.businessUnit.findUnique({ where: { id: e.businessUnitId }, select: { name: true } }) : null,
    e.productId ? prisma.product.findUnique({ where: { id: e.productId }, select: { canonicalName: true } }) : null,
  ]);
  const parts = [bu?.name, produit?.canonicalName].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
