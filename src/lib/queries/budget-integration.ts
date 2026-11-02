import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  consommationHistorique, plusAncienne, regleDuLot, verdictSource,
  type PosteHistorique, type RegleIntegration, type SourceBudget, type Verdict,
} from "@/lib/budget/integration-regle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES DERRIÈRE LA RÈGLE D'INTÉGRATION (`budget/integration-regle.ts`) — le lot actif d'une enveloppe, ses
 * postes historiques, et l'origine de chaque source (écriture, ligne budgétaire, engagement) : sa date de naissance, sa
 * demande Ad & Pro, son poste.
 *
 * TOUT lecteur de budget passe par ici (le cliquet `integration-regle.cliquet.test.ts` le vérifie). Sans lot actif sur
 * l'enveloppe, rien ne change : chaque fonction rend ce qu'elle reçoit, et le chemin rapide (les agrégats) reste celui
 * des lecteurs.
 *
 * LECTURE SEULE : rien ici n'écrit — ni le livre de trésorerie, ni les ordres, ni les postes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ContexteIntegration {
  regle: RegleIntegration;
  /** Les catégories (et sous-catégories) de l'enveloppe du lot. */
  categories: Set<string>;
  postes: PosteHistorique[];
  /** Les écritures de trésorerie RELIÉES à une demande du lot (lecture seule) : elles sont cette dépense, jamais une autre. */
  ecrituresReliees?: Map<string, string>;
  /**
   * LES DÉPENSES RATTACHÉES PAR LE RAPPROCHEMENT (`AdProRapprochement` acceptés) — par clé de source (`TX:`, `LIGNE:`,
   * `ORDRE:`) : la demande du lot et, s'il est connu, le poste dont elles sont la preuve de paiement. Comme une écriture
   * reliée, elles sont CETTE dépense : le fichier (ou le poste historique) la porte, elles ne comptent pas une seconde fois.
   */
  sourcesReliees?: Map<string, { demande: string; posteId: string | null }>;
}

const TYPES_DEMANDE = new Set(["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "AD_PRO_OTHER", "TRAINING", "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION"]);

/** Les colonnes parentes d'un poste, en clé de demande — les sept porteurs. */
export interface ParentsPoste {
  sponsoringId: string | null;
  congressNationalId: string | null;
  congressInternationalId: string | null;
  eventId: string | null;
  /** La demande « autre » (27/10/2026, décision #17). */
  otherRequestId?: string | null;
  trainingId: string | null;
  promoMaterialParentId?: string | null;
  declarationInfoMedId?: string | null;
}
export const SELECT_PARENTS_POSTE = {
  sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true,
  promoMaterialParentId: true, declarationInfoMedId: true,
} as const;

export function cleDemandeDuPoste(p: ParentsPoste): string | null {
  if (p.sponsoringId) return `SPONSORING:${p.sponsoringId}`;
  if (p.congressNationalId) return `CONGRESS_NATIONAL:${p.congressNationalId}`;
  if (p.congressInternationalId) return `CONGRESS_INTERNATIONAL:${p.congressInternationalId}`;
  if (p.eventId) return `EVENT:${p.eventId}`;
  if (p.otherRequestId) return `AD_PRO_OTHER:${p.otherRequestId}`;
  if (p.trainingId) return `TRAINING:${p.trainingId}`;
  if (p.promoMaterialParentId) return `PROMO_MATERIAL:${p.promoMaterialParentId}`;
  if (p.declarationInfoMedId) return `MEDICAL_INFO_DECLARATION:${p.declarationInfoMedId}`;
  return null;
}

async function construire(lot: { id: string; envelopeId: string; integreLe: Date }): Promise<ContexteIntegration> {
  const [demandes, decisions, postes, cats, rapprochees] = await Promise.all([
    prisma.adProIntegrationDemande.findMany({ where: { lotId: lot.id }, select: { demandeType: true, demandeId: true, ecritureId: true } }),
    prisma.adProIntegrationDecision.findMany({ where: { lotId: lot.id }, select: { cleSource: true, decision: true } }),
    prisma.adProItem.findMany({
      where: { historiqueLotId: lot.id, montantPayeHistorique: { not: null } },
      select: { id: true, budgetCategoryId: true, montantPayeHistorique: true, historiquePayeLe: true, kind: true, label: true, historiqueLigne: true, ...SELECT_PARENTS_POSTE },
    }),
    prisma.budgetCategoryLine.findMany({ where: { envelopeId: lot.envelopeId }, select: { id: true } }),
    prisma.adProRapprochement.findMany({
      where: { lotId: lot.id, sens: "DEPENSE", decision: "ACCEPTEE", annuleLe: null, demandeType: { not: null }, demandeId: { not: null } },
      select: { source: true, demandeType: true, demandeId: true, posteId: true },
    }),
  ]);
  return {
    regle: regleDuLot({
      lotId: lot.id, enveloppeId: lot.envelopeId, integreLe: lot.integreLe,
      demandes: demandes.map((d) => ({ type: d.demandeType, id: d.demandeId })),
      postesHistoriques: postes.map((p) => p.id),
      decisions,
    }),
    categories: new Set(cats.map((c) => c.id)),
    ecrituresReliees: new Map(demandes.filter((d) => d.ecritureId).map((d) => [d.ecritureId as string, `${d.demandeType}:${d.demandeId}`])),
    sourcesReliees: new Map(rapprochees.map((r) => [r.source, { demande: `${r.demandeType}:${r.demandeId}`, posteId: r.posteId }])),
    postes: postes.map((p) => ({
      id: p.id, categoryId: p.budgetCategoryId, montant: toNumber(p.montantPayeHistorique),
      payeLe: p.historiquePayeLe ?? lot.integreLe, kind: p.kind, libelle: p.label,
      demande: cleDemandeDuPoste(p), ligne: p.historiqueLigne,
    })),
  };
}

/** Le contexte du lot ACTIF d'une enveloppe, ou `null` — le cas de toutes les enveloppes sans intégration. */
export async function contexteDeLEnveloppe(envelopeId: string): Promise<ContexteIntegration | null> {
  const lot = await prisma.adProIntegrationLot.findFirst({ where: { envelopeId, annuleLe: null }, select: { id: true, envelopeId: true, integreLe: true } });
  return lot ? construire(lot) : null;
}

/** Les contextes des lots actifs qui touchent ces catégories (une lecture, puis un contexte par enveloppe concernée). */
export async function contextesDesCategories(catIds: readonly string[]): Promise<ContexteIntegration[]> {
  if (catIds.length === 0) return [];
  const lots = await prisma.adProIntegrationLot.findMany({
    where: { annuleLe: null, envelope: { categories: { some: { id: { in: [...catIds] } } } } },
    select: { id: true, envelopeId: true, integreLe: true },
  });
  return Promise.all(lots.map(construire));
}

/** Le contexte qui gouverne une catégorie, parmi ceux chargés. */
export function contexteDe(ctxs: readonly ContexteIntegration[], categoryId: string | null | undefined): ContexteIntegration | null {
  if (!categoryId) return null;
  return ctxs.find((c) => c.categories.has(categoryId)) ?? null;
}

// ─────────────────────────────── L'origine des sources ───────────────────────────────

interface OrigineOrdre { ordreCree: Date | null; demande: string | null; posteId: string | null }

/** L'origine de chaque écriture (id → ordre qui l'a écrite, demande, poste), lue en lot. */
async function originesDesEcritures(ids: readonly string[]): Promise<Map<string, OrigineOrdre>> {
  const out = new Map<string, OrigineOrdre>();
  if (ids.length === 0) return out;
  const [ordres, factures] = await Promise.all([
    prisma.expenseOrder.findMany({ where: { transactionId: { in: [...ids] } }, select: { id: true, transactionId: true, createdAt: true, sourceType: true, sourceId: true } }),
    prisma.legalDocument.findMany({ where: { settlementTxId: { in: [...ids] } }, select: { id: true, settlementTxId: true, createdAt: true } }),
  ]);
  const parOrdre = await originesDesOrdres(ordres);
  for (const o of ordres) {
    if (!o.transactionId) continue;
    const r = parOrdre.get(o.id);
    out.set(o.transactionId, { ordreCree: o.createdAt, demande: r?.demande ?? null, posteId: r?.posteId ?? null });
  }
  // Une facture réglée DIRECTEMENT par l'écriture : son poste, par les pièces du poste.
  if (factures.length) {
    const pieces = await prisma.adProItemPiece.findMany({ where: { legalDocumentId: { in: factures.map((f) => f.id) } }, select: { legalDocumentId: true, itemId: true } });
    const postes = pieces.length ? await prisma.adProItem.findMany({ where: { id: { in: pieces.map((p) => p.itemId) } }, select: { id: true, ...SELECT_PARENTS_POSTE } }) : [];
    for (const f of factures) {
      if (!f.settlementTxId || out.has(f.settlementTxId)) continue;
      const piece = pieces.find((p) => p.legalDocumentId === f.id);
      const poste = piece ? postes.find((p) => p.id === piece.itemId) : undefined;
      out.set(f.settlementTxId, { ordreCree: f.createdAt, demande: poste ? cleDemandeDuPoste(poste) : null, posteId: poste?.id ?? null });
    }
  }
  return out;
}

/** La demande et le poste de chaque ordre : son poste (par l'ordre ou par la source), ses cases de prise en charge, sa source. */
export async function originesDesOrdres(ordres: readonly { id: string; sourceType: string | null; sourceId: string | null }[]): Promise<Map<string, { demande: string | null; posteId: string | null }>> {
  const out = new Map<string, { demande: string | null; posteId: string | null }>();
  if (ordres.length === 0) return out;
  const ids = ordres.map((o) => o.id);
  const sourcesPoste = ordres.filter((o) => o.sourceType === "AD_PRO_ITEM" && o.sourceId).map((o) => o.sourceId as string);
  const [postes, cases, declarations, promos] = await Promise.all([
    prisma.adProItem.findMany({
      where: { OR: [{ expenseOrderId: { in: ids } }, ...(sourcesPoste.length ? [{ id: { in: sourcesPoste } }] : [])] },
      select: { id: true, expenseOrderId: true, ...SELECT_PARENTS_POSTE },
    }),
    prisma.careCell.findMany({ where: { expenseOrderId: { in: ids } }, select: { expenseOrderId: true, beneficiary: { select: { congressNationalId: true, congressInternationalId: true } } } }),
    prisma.medicalInfoDeclaration.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true, expenseOrderId: true } }),
    prisma.promoMaterial.findMany({ where: { OR: [{ paymentOrderId: { in: ids } }, { settlementOrderId: { in: ids } }] }, select: { id: true, paymentOrderId: true, settlementOrderId: true } }),
  ]);
  for (const o of ordres) {
    const poste = postes.find((p) => p.expenseOrderId === o.id || (o.sourceType === "AD_PRO_ITEM" && p.id === o.sourceId));
    if (poste) { out.set(o.id, { demande: cleDemandeDuPoste(poste), posteId: poste.id }); continue; }
    const cas = cases.find((c) => c.expenseOrderId === o.id);
    if (cas?.beneficiary.congressInternationalId) { out.set(o.id, { demande: `CONGRESS_INTERNATIONAL:${cas.beneficiary.congressInternationalId}`, posteId: null }); continue; }
    if (cas?.beneficiary.congressNationalId) { out.set(o.id, { demande: `CONGRESS_NATIONAL:${cas.beneficiary.congressNationalId}`, posteId: null }); continue; }
    const decl = declarations.find((d) => d.expenseOrderId === o.id);
    if (decl) { out.set(o.id, { demande: `MEDICAL_INFO_DECLARATION:${decl.id}`, posteId: null }); continue; }
    const promo = promos.find((p) => p.paymentOrderId === o.id || p.settlementOrderId === o.id);
    if (promo) { out.set(o.id, { demande: `PROMO_MATERIAL:${promo.id}`, posteId: null }); continue; }
    out.set(o.id, { demande: o.sourceType && o.sourceId && TYPES_DEMANDE.has(o.sourceType) ? `${o.sourceType}:${o.sourceId}` : null, posteId: null });
  }
  return out;
}

// ─────────────────────────────── Ce que comptent les écritures et les lignes ───────────────────────────────

export interface EcritureLue {
  id: string;
  date: Date;
  createdAt: Date;
  amount: unknown;
  status: string;
  budgetCategoryId: string | null;
  label: string;
  reference: string;
  counterparty: string | null;
  category?: string;
}
export interface LigneBudgetLue { id: string; date: Date; createdAt: Date; amount: unknown; categoryId: string; reference: string }

export interface SourceJugee extends SourceBudget {
  verdict: Verdict;
  libelle: string;
  reference: string;
  montant: number;
  categoryId: string | null;
  date: Date;
  nature: "ECRITURE" | "LIGNE" | "ENGAGEMENT";
}

/**
 * LES ÉCRITURES d'une enveloppe sous la règle de son lot : celles qui comptent, et le verdict de chacune (pour la liste
 * « absentes du fichier » et pour dire pourquoi une écriture ne compte plus). Une écriture hors des catégories d'un lot
 * passe telle quelle.
 */
export async function jugerEcritures<T extends EcritureLue>(ctxs: readonly ContexteIntegration[], ecritures: readonly T[]): Promise<{ comptees: T[]; jugees: SourceJugee[] }> {
  const concernees = ecritures.filter((e) => contexteDe(ctxs, e.budgetCategoryId));
  if (concernees.length === 0) return { comptees: [...ecritures], jugees: [] };
  const origines = await originesDesEcritures(concernees.map((e) => e.id));
  const comptees: T[] = [];
  const jugees: SourceJugee[] = [];
  for (const e of ecritures) {
    const ctx = contexteDe(ctxs, e.budgetCategoryId);
    if (!ctx) { comptees.push(e); continue; }
    const o = origines.get(e.id);
    // Une écriture RELIÉE à une demande du lot (ou rattachée par le Rapprochement) est cette dépense : remplacée par la
    // ligne du fichier — ou portée par le poste historique —, quelle que soit sa date.
    const rapprochee = ctx.sourcesReliees?.get(`TX:${e.id}`) ?? null;
    const reliee = ctx.ecrituresReliees?.get(e.id) ?? rapprochee?.demande ?? null;
    const source: SourceBudget = { cle: `TX:${e.id}`, neeLe: reliee ? new Date(0) : plusAncienne(e.createdAt, o?.ordreCree), demande: reliee ?? o?.demande ?? null, posteId: rapprochee?.posteId ?? o?.posteId ?? null };
    const verdict = verdictSource(ctx.regle, source);
    if (verdict.compte) comptees.push(e);
    jugees.push({ ...source, verdict, libelle: e.label, reference: e.reference, montant: toNumber(e.amount as Parameters<typeof toNumber>[0]), categoryId: e.budgetCategoryId, date: e.date, nature: "ECRITURE" });
  }
  return { comptees, jugees };
}

/** LES LIGNES BUDGÉTAIRES d'une enveloppe sous la règle : saisies à la main, elles n'ont ni demande ni poste. */
export function jugerLignes<T extends LigneBudgetLue>(ctxs: readonly ContexteIntegration[], lignes: readonly T[]): { comptees: T[]; jugees: SourceJugee[] } {
  const comptees: T[] = [];
  const jugees: SourceJugee[] = [];
  for (const l of lignes) {
    const ctx = contexteDe(ctxs, l.categoryId);
    if (!ctx) { comptees.push(l); continue; }
    // Une ligne RATTACHÉE par le Rapprochement est la dépense d'une demande du lot : le fichier la porte.
    const rapprochee = ctx.sourcesReliees?.get(`LIGNE:${l.id}`) ?? null;
    const source: SourceBudget = { cle: `LIGNE:${l.id}`, neeLe: rapprochee ? new Date(0) : l.createdAt, demande: rapprochee?.demande ?? null, posteId: rapprochee?.posteId ?? null };
    const verdict = verdictSource(ctx.regle, source);
    if (verdict.compte) comptees.push(l);
    jugees.push({ ...source, verdict, libelle: l.reference, reference: l.reference, montant: toNumber(l.amount as Parameters<typeof toNumber>[0]), categoryId: l.categoryId, date: l.date, nature: "LIGNE" });
  }
  return { comptees, jugees };
}

/** Un engagement (`budget-sources.ts`) — juste ce que la règle demande. */
export interface EngagementAJuger {
  categoryId: string;
  montant: number;
  posteId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** L'ordre émis (`EN_CIRCUIT`), quand l'engagement en est un. */
  ordreId?: string | null;
  nature: "ENGAGE" | "EN_CIRCUIT";
}

/**
 * LES ENGAGEMENTS sous la règle. L'engagé d'un poste est né à son imputation (à défaut, à sa création) ; un ordre émis,
 * à sa création. Un poste historique n'engage jamais rien : il est déjà payé, au budget par sa ligne du fichier.
 */
export async function jugerEngagements<T extends EngagementAJuger>(ctxs: readonly ContexteIntegration[], details: readonly T[]): Promise<{ comptes: T[]; jugees: SourceJugee[] }> {
  const concernes = details.filter((d) => contexteDe(ctxs, d.categoryId));
  if (concernes.length === 0) return { comptes: [...details], jugees: [] };
  const posteIds = [...new Set(concernes.map((d) => d.posteId).filter((x): x is string => Boolean(x)))];
  const ordreIds = [...new Set(concernes.map((d) => d.ordreId).filter((x): x is string => Boolean(x)))];
  const [postes, ordres] = await Promise.all([
    posteIds.length ? prisma.adProItem.findMany({ where: { id: { in: posteIds } }, select: { id: true, label: true, createdAt: true, depenseImputeeLe: true, ...SELECT_PARENTS_POSTE } }) : [],
    ordreIds.length ? prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, reference: true, label: true, createdAt: true, sourceType: true, sourceId: true } }) : [],
  ]);
  const origineOrdre = await originesDesOrdres(ordres);
  const comptes: T[] = [];
  const jugees: SourceJugee[] = [];
  for (const d of details) {
    const ctx = contexteDe(ctxs, d.categoryId);
    if (!ctx) { comptes.push(d); continue; }
    const poste = d.posteId ? postes.find((p) => p.id === d.posteId) : undefined;
    const ordre = d.ordreId ? ordres.find((o) => o.id === d.ordreId) : undefined;
    const o = ordre ? origineOrdre.get(ordre.id) : undefined;
    // Un ordre hors poste RATTACHÉ par le Rapprochement est la dépense d'une demande du lot : il n'engage pas une seconde fois.
    const rapproche = ordre ? ctx.sourcesReliees?.get(`ORDRE:${ordre.id}`) ?? null : null;
    const source: SourceBudget = {
      cle: ordre ? `ORDRE:${ordre.id}` : `POSTE:${d.posteId ?? `${d.sourceType}:${d.sourceId}`}`,
      neeLe: rapproche ? new Date(0) : ordre ? ordre.createdAt : plusAncienne(poste?.depenseImputeeLe ?? poste?.createdAt ?? null),
      demande: rapproche?.demande ?? (poste ? cleDemandeDuPoste(poste) : o?.demande ?? (d.sourceType && d.sourceId && TYPES_DEMANDE.has(d.sourceType) ? `${d.sourceType}:${d.sourceId}` : null)),
      posteId: rapproche?.posteId ?? d.posteId ?? o?.posteId ?? null,
    };
    const verdict = verdictSource(ctx.regle, source);
    if (verdict.compte) comptes.push(d);
    jugees.push({
      ...source, verdict, libelle: ordre?.label ?? poste?.label ?? "Engagement", reference: ordre?.reference ?? "Engagé",
      montant: d.montant, categoryId: d.categoryId, date: source.neeLe, nature: "ENGAGEMENT",
    });
  }
  return { comptes, jugees };
}

// ─────────────────────────────── La consommation d'une enveloppe, règle appliquée ───────────────────────────────

const SELECT_ECRITURE = { id: true, date: true, createdAt: true, amount: true, status: true, budgetCategoryId: true, label: true, reference: true, counterparty: true, category: true } as const;

export interface ConsommationIntegree {
  /** Les écritures (OUT, réglées ou à payer) qui comptent. */
  ecritures: EcritureLue[];
  lignes: LigneBudgetLue[];
  /** Les postes historiques de la période, dans les catégories demandées. */
  historiques: PosteHistorique[];
  historiqueParCategorie: Map<string, number>;
  jugees: SourceJugee[];
}

/**
 * LA CONSOMMATION D'UNE LISTE DE CATÉGORIES, RÈGLE APPLIQUÉE — pour les lecteurs qui agrègent (vue d'ensemble, total des
 * enveloppes, pré-remplissage, risques). Sans contexte, ne lit rien : l'appelant garde son agrégat.
 */
export async function consommationIntegree(
  ctxs: readonly ContexteIntegration[], catIds: readonly string[], from?: Date | null, to?: Date | null,
  opts: { statuts?: readonly string[] } = {},
): Promise<ConsommationIntegree> {
  const vide: ConsommationIntegree = { ecritures: [], lignes: [], historiques: [], historiqueParCategorie: new Map(), jugees: [] };
  const ids = catIds.filter((id) => contexteDe(ctxs, id));
  if (ids.length === 0) return vide;
  const periode = from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
  const [ecritures, lignes] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: { direction: "OUT", status: { in: [...(opts.statuts ?? ["SETTLED", "PENDING"])] as ("SETTLED" | "PENDING")[] }, budgetCategoryId: { in: ids }, ...periode },
      select: SELECT_ECRITURE,
    }),
    prisma.budgetExpenseLine.findMany({ where: { categoryId: { in: ids }, ...periode }, select: { id: true, date: true, createdAt: true, amount: true, categoryId: true, reference: true } }),
  ]);
  const [e, l] = await Promise.all([jugerEcritures(ctxs, ecritures), Promise.resolve(jugerLignes(ctxs, lignes))]);
  const historiques: PosteHistorique[] = [];
  const historiqueParCategorie = new Map<string, number>();
  const voulues = new Set(ids);
  for (const ctx of ctxs) {
    const h = consommationHistorique(ctx.postes, voulues, from, to);
    historiques.push(...h.lignes);
    for (const [k, v] of h.parCategorie) historiqueParCategorie.set(k, (historiqueParCategorie.get(k) ?? 0) + v);
  }
  return { ecritures: e.comptees, lignes: l.comptees, historiques, historiqueParCategorie, jugees: [...e.jugees, ...l.jugees] };
}

/** Les catégories gouvernées par un lot, parmi celles-ci (l'appelant retire leurs agrégats rapides). */
export function categoriesGouvernees(ctxs: readonly ContexteIntegration[], catIds: readonly string[]): Set<string> {
  return new Set(catIds.filter((id) => contexteDe(ctxs, id)));
}

