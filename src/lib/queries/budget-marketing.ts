import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { contextesDesCategories } from "@/lib/queries/budget-integration";
import { lienDemande } from "@/lib/budget-marketing/integration-vue";
import type { PosteVue } from "@/lib/budget-marketing/demandes-vue";

/**
 * BUDGET MARKETING — ce que Budgets ne montrait pas : QUELLES DEMANDES Ad & Pro consomment l'enveloppe.
 *
 * Un poste Ad & Pro accordé est rangé dans une (sous-)catégorie d'enveloppe (`AdProItem.budgetCategoryId`). On remonte
 * de la catégorie au poste, puis à sa demande (sponsoring, congrès, événement…) et à son ordre de dépense : accordé,
 * engagé (ordre émis, non payé), réglé. L'accès à l'enveloppe est vérifié par l'appelant (`getBudgetOverview`).
 */

/**
 * Un poste Ad & Pro rangé dans l'enveloppe. Il porte de quoi le regrouper sous SA demande (`cleDemande`) et le filtrer
 * par catégorie (`categorieId`, sous-catégories comprises) — `budget-marketing/demandes-vue.ts`.
 */
export interface LigneDemandeAdPro extends PosteVue {
  /** Un poste HISTORIQUE (intégration Ad & Pro 2026) : payé, sans circuit — sa ligne du fichier. */
  historique?: { ligne: number | null } | null;
}

const STATUT_POSTE: Record<string, string> = {
  DRAFT: "En préparation", PENDING: "Soumis", REVISION: "À revoir", APPROVED: "Accordé", REJECTED: "Refusé",
};

export async function demandesAdProDeLEnveloppe(categories: readonly { id: string; name: string; parentId?: string | null }[]): Promise<LigneDemandeAdPro[]> {
  if (categories.length === 0) return [];
  const parId = new Map(categories.map((c) => [c.id, c]));
  // L'imputation se lit « Tête › Sous-catégorie » : la sous-catégorie seule ne dit pas où l'argent est compté.
  const imputation = (id: string | null) => {
    const c = id ? parId.get(id) : undefined;
    if (!c) return "—";
    const parent = c.parentId ? parId.get(c.parentId) : undefined;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };
  const postes = await prisma.adProItem.findMany({
    where: { budgetCategoryId: { in: [...parId.keys()] } },
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: {
      id: true, label: true, status: true, amountGranted: true, amountEstimated: true, budgetCategoryId: true, expenseOrderId: true, createdAt: true,
      sponsoring: { select: { id: true, reference: true, institution: true, city: true, requesterId: true } },
      congressNational: { select: { id: true, name: true, city: true, requesterId: true } },
      congressInternational: { select: { id: true, name: true, city: true, requesterId: true } },
      event: { select: { id: true, name: true, city: true, requesterId: true } },
      training: { select: { id: true, title: true, location: true, requesterId: true } },
      promoMaterialParent: { select: { id: true, reference: true, title: true, requesterId: true } },
      declarationInfoMed: { select: { id: true, reference: true, label: true, requesterId: true } },
      montantPayeHistorique: true, historiqueLigne: true, historiqueLotId: true, historiquePayeLe: true,
    },
  });
  // Un poste historique ne compte que tant que son lot est actif (la règle d'intégration le lit de la même façon).
  const lotsActifs = new Set((await contextesDesCategories([...parId.keys()])).map((c) => c.regle.lotId));
  const ordreIds = postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x));
  const demandeurIds = [...new Set(postes.map((p) => (p.sponsoring ?? p.congressNational ?? p.congressInternational ?? p.event ?? p.training ?? p.promoMaterialParent ?? p.declarationInfoMed)?.requesterId).filter((x): x is string => Boolean(x)))];
  const [ordresLus, demandeurs] = await Promise.all([
    ordreIds.length ? prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, status: true, amount: true } }) : [],
    demandeurIds.length ? prisma.user.findMany({ where: { id: { in: demandeurIds } }, select: { id: true, name: true } }) : [],
  ]);
  const ordres = new Map(ordresLus.map((o) => [o.id, o]));
  const nomDemandeur = new Map(demandeurs.map((u) => [u.id, u.name]));
  return postes.map((p) => {
    const parent = p.sponsoring
      ? { cleDemande: `SPONSORING:${p.sponsoring.id}`, demande: `${p.sponsoring.reference} — ${p.sponsoring.institution}`, nature: "Sponsoring", href: `/sponsoring/${p.sponsoring.id}`, lieu: p.sponsoring.city, requesterId: p.sponsoring.requesterId }
      : p.congressNational
        ? { cleDemande: `CONGRESS_NATIONAL:${p.congressNational.id}`, demande: p.congressNational.name, nature: "Congrès national", href: `/congress-national/${p.congressNational.id}`, lieu: p.congressNational.city, requesterId: p.congressNational.requesterId }
        : p.congressInternational
          ? { cleDemande: `CONGRESS_INTERNATIONAL:${p.congressInternational.id}`, demande: p.congressInternational.name, nature: "Congrès international", href: `/congress-international/${p.congressInternational.id}`, lieu: p.congressInternational.city, requesterId: p.congressInternational.requesterId }
          : p.event
            ? { cleDemande: `EVENT:${p.event.id}`, demande: p.event.name, nature: "Événement", href: `/events/${p.event.id}`, lieu: p.event.city, requesterId: p.event.requesterId }
            : p.promoMaterialParent
              ? { cleDemande: `PROMO_MATERIAL:${p.promoMaterialParent.id}`, demande: `${p.promoMaterialParent.reference} — ${p.promoMaterialParent.title}`, nature: "Matériel promotionnel", href: `/promo-material/${p.promoMaterialParent.id}`, lieu: null, requesterId: p.promoMaterialParent.requesterId }
              : p.declarationInfoMed
                ? { cleDemande: `MEDICAL_INFO_DECLARATION:${p.declarationInfoMed.id}`, demande: `${p.declarationInfoMed.reference} — ${p.declarationInfoMed.label}`, nature: "Information médicale", href: `/information-medicale/${p.declarationInfoMed.id}`, lieu: null, requesterId: p.declarationInfoMed.requesterId }
                : p.training
                  ? { cleDemande: `TRAINING:${p.training.id}`, demande: p.training.title, nature: "Formation", href: lienDemande("TRAINING", p.training.id), lieu: p.training.location, requesterId: p.training.requesterId }
                  : { cleDemande: `POSTE:${p.id}`, demande: p.label, nature: "Poste Ad & Pro", href: null, lieu: null, requesterId: null };
    const { requesterId, ...demande } = parent;
    const commun = {
      id: p.id, ...demande, demandeur: requesterId ? nomDemandeur.get(requesterId) ?? null : null,
      poste: p.label, categorieId: p.budgetCategoryId, categorie: imputation(p.budgetCategoryId),
    };
    const historique = p.montantPayeHistorique != null && p.historiqueLotId != null && lotsActifs.has(p.historiqueLotId);
    if (historique) {
      const montant = toNumber(p.montantPayeHistorique);
      return {
        ...commun, date: (p.historiquePayeLe ?? p.createdAt).toISOString(),
        statutCle: "HISTORIQUE", statut: "Payé — Historique 2026", accorde: montant, engage: 0, regle: montant, historique: { ligne: p.historiqueLigne },
      };
    }
    const ordre = p.expenseOrderId ? ordres.get(p.expenseOrderId) : undefined;
    const montantOrdre = ordre ? toNumber(ordre.amount) : 0;
    return {
      ...commun,
      date: p.createdAt.toISOString(),
      statutCle: p.status,
      statut: STATUT_POSTE[p.status] ?? p.status,
      accorde: toNumber(p.amountGranted ?? p.amountEstimated),
      engage: ordre && ordre.status === "PENDING" ? montantOrdre : 0,
      regle: ordre && ordre.status === "PAID" ? montantOrdre : 0,
      historique: null,
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
