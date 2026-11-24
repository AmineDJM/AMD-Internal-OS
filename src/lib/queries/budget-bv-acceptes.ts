import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { CLE_BV_25, CLE_BV_75, ETAPES_BV, natureDuLibelle } from "@/lib/budget-regulatory/bv";
import {
  categorieDuBvAccepte, dateDuPaiement, encadreBudgetBv, imputationDesBvAcceptes,
  type BvAccepte, type BvDuDossier, type CategorieBvCandidate, type ImputationBvAcceptes, type LigneEncadreBv,
} from "@/lib/budget-regulatory/bv-acceptes";
import { demandeQuiDitLEtat, natureDeLObjetBv, OBJETS_BV_REGULATORY } from "@/lib/regulatory/bv-validation";
import { ordreQuiDitLEtat } from "@/lib/regulatory/bv-circuit";
import { ordreEngage } from "@/lib/budget/engage";

/**
 * LES BV ACCEPTÉS AU CENTRE DE VALIDATIONS, LUS POUR LE BUDGET REGULATORY — les règles sont pures
 * (`budget-regulatory/bv-acceptes.ts`) ; ici on lit les demandes acceptées, l'étape de paiement de leur dossier et les
 * catégories BV des enveloppes Regulatory. Rien n'est écrit : l'engagé et le consommé se déduisent à chaque lecture.
 */

type Workflow = Record<string, { status?: string; date?: string } | undefined> | null;

/** Les catégories BV (1er niveau) de toutes les enveloppes Regulatory — celles entre lesquelles on choisit. */
export async function categoriesBvCandidates(): Promise<CategorieBvCandidate[]> {
  const cats = await prisma.budgetCategoryLine.findMany({
    where: { cle: { in: [CLE_BV_25, CLE_BV_75] }, parentId: null, envelope: { domaine: "REGULATORY" } },
    select: {
      id: true, name: true, cle: true,
      envelope: { select: { id: true, name: true, companyId: true, isActive: true, periodStart: true, periodEnd: true } },
    },
  });
  return cats.map((c) => ({
    id: c.id, nom: c.name, cle: c.cle,
    enveloppe: { id: c.envelope.id, nom: c.envelope.name, companyId: c.envelope.companyId, isActive: c.envelope.isActive, periodStart: c.envelope.periodStart, periodEnd: c.envelope.periodEnd },
  }));
}

/** Les BV acceptés (tous dossiers, ou ceux donnés), chacun rangé dans sa catégorie. */
export async function lireBvAcceptes(productIds?: readonly string[]): Promise<BvAccepte[]> {
  const demandes = await prisma.validationRequest.findMany({
    where: {
      objectType: { in: [...OBJETS_BV_REGULATORY] }, status: "APPROVED", entityType: "REGULATORY_PRODUCT",
      ...(productIds ? { entityId: { in: [...productIds] } } : {}),
    },
    select: { id: true, objectType: true, entityId: true, amount: true, decidedAt: true, updatedAt: true },
  });
  if (demandes.length === 0) return [];
  const ids = [...new Set(demandes.map((d) => d.entityId).filter((x): x is string => Boolean(x)))];
  const [dossiers, candidates] = await Promise.all([
    prisma.regulatoryProduct.findMany({ where: { id: { in: ids } }, select: { id: true, workflow: true, companyId: true } }),
    categoriesBvCandidates(),
  ]);
  const parId = new Map(dossiers.map((d) => [d.id, d]));
  const out: BvAccepte[] = [];
  for (const d of demandes) {
    const nature = natureDeLObjetBv(d.objectType);
    const dossier = d.entityId ? parId.get(d.entityId) : null;
    if (!nature || !dossier) continue;
    const accepteLe = d.decidedAt ?? d.updatedAt;
    const etape = (dossier.workflow as Workflow)?.[ETAPES_BV[nature].paiement] ?? null;
    const paiementFait = etape?.status === "DONE";
    out.push({
      validationId: d.id, productId: dossier.id, companyId: dossier.companyId, nature, montant: d.amount === null ? 0 : toNumber(d.amount), accepteLe,
      paiementFait, payeLe: paiementFait ? dateDuPaiement(etape, accepteLe) : null,
      categoryId: categorieDuBvAccepte(nature, accepteLe, candidates, dossier.companyId)?.id ?? null,
    });
  }
  return out;
}

/**
 * CE QUE LES BV ACCEPTÉS PÈSENT SUR CES CATÉGORIES — lu par la vue d'ensemble d'une enveloppe (`getBudgetOverview`) et
 * par le total des enveloppes, au même titre que les notes de frais ou la paie. Sans catégorie BV dans la liste, aucune
 * lecture.
 */
export async function bvAcceptesConsumption(catIds: readonly string[], from?: Date | null, to?: Date | null): Promise<ImputationBvAcceptes> {
  const vide: ImputationBvAcceptes = { consumed: new Map(), committed: new Map(), rows: [] };
  if (catIds.length === 0) return vide;
  const bvCats = await prisma.budgetCategoryLine.count({ where: { id: { in: [...catIds] }, cle: { in: [CLE_BV_25, CLE_BV_75] } } });
  if (bvCats === 0) return vide;
  return imputationDesBvAcceptes(await lireBvAcceptes(), new Set(catIds), from, to);
}

/** Les ordres de l'ancien circuit, tels que la fiche les lit déjà. */
export interface OrdreBvDuDossier {
  label: string; amount: unknown; status: string; centralStatus: string; createdAt: Date;
  budgetCategoryId: string | null; transactionId: string | null;
}

/**
 * L'ENCADRÉ « BUDGET » DE LA FICHE DOSSIER — BV 25 % / 75 % : demandé, engagé, consommé, et l'enveloppe concernée,
 * quel que soit le circuit du BV (centre de validations, ou ancien ordre de dépense qui finit son parcours). Les
 * chiffres sont ceux que la page Budget Regulatory lit pour ce dossier.
 */
export async function budgetBvDuDossier(
  dossier: { id: string; status: string },
  ordres: readonly OrdreBvDuDossier[],
): Promise<LigneEncadreBv[]> {
  const [demandes, acceptes, candidates] = await Promise.all([
    prisma.validationRequest.findMany({
      where: { objectType: { in: [...OBJETS_BV_REGULATORY] }, entityType: "REGULATORY_PRODUCT", entityId: dossier.id },
      select: { id: true, objectType: true, status: true, amount: true, createdAt: true },
    }),
    lireBvAcceptes([dossier.id]),
    categoriesBvCandidates(),
  ]);
  const nomDe = new Map(candidates.map((c) => [c.id, `${c.enveloppe.nom} › ${c.nom}`]));
  const txIds = ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x));
  const categorieEcriture = txIds.length
    ? new Map((await prisma.financeTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, budgetCategoryId: true } })).map((t) => [t.id, t.budgetCategoryId]))
    : new Map<string, string | null>();
  const nomsAutres = new Map((await prisma.budgetCategoryLine.findMany({
    where: { id: { in: [...ordres.map((o) => o.budgetCategoryId), ...categorieEcriture.values()].filter((x): x is string => Boolean(x) && !nomDe.has(x as string)) } },
    select: { id: true, name: true, envelope: { select: { name: true } } },
  })).map((c) => [c.id, `${c.envelope.name} › ${c.name}`]));
  const nom = (id: string | null | undefined) => (id ? nomDe.get(id) ?? nomsAutres.get(id) ?? null : null);

  const bvs: BvDuDossier[] = [];
  for (const nature of ["25", "75"] as const) {
    // LE NOUVEAU CIRCUIT D'ABORD : une demande au centre de validations (même refusée) est l'histoire récente du BV.
    const lue = demandeQuiDitLEtat(demandes.filter((d) => natureDeLObjetBv(d.objectType) === nature));
    const accepte = acceptes.find((a) => a.nature === nature && a.validationId === lue?.demande.id);
    if (lue && (lue.etat !== "REFUSE" || !ordreQuiDitLEtat(ordres, nature))) {
      bvs.push({
        nature, circuit: "VALIDATION", demande: lue.demande.amount === null ? 0 : toNumber(lue.demande.amount),
        engage: accepte && !accepte.paiementFait ? accepte.montant : 0,
        consomme: accepte?.paiementFait ? accepte.montant : 0,
        enveloppe: accepte ? nom(accepte.categoryId) : null,
      });
      continue;
    }
    // L'ANCIEN CIRCUIT : l'ordre qui dit l'état — engagé tant qu'il n'est ni payé ni refusé, consommé une fois payé.
    const o = ordreQuiDitLEtat(ordres, nature)?.ordre;
    if (!o || natureDuLibelle(o.label) !== nature) continue;
    const montant = toNumber(o.amount as Parameters<typeof toNumber>[0]);
    bvs.push({
      nature, circuit: "ORDRE", demande: montant,
      engage: ordreEngage(o.status, o.centralStatus) ? montant : 0,
      consomme: o.status === "PAID" ? montant : 0,
      enveloppe: nom(o.status === "PAID" && o.transactionId ? categorieEcriture.get(o.transactionId) : o.budgetCategoryId),
    });
  }
  const enCours = !["DECISION_OBTAINED", "CLOSED"].includes(dossier.status);
  return encadreBudgetBv(bvs, enCours);
}
