import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { STATUTS_ORDRE_ENGAGES, dateDeLaDepense, ordreEngage } from "@/lib/budget/engage";
import { depenseDuPoste, ordreEnCircuit, type DepensePoste, type FaitsDepensePoste } from "@/lib/budget/depense-poste";
import { contextesDesCategories, jugerEngagements } from "@/lib/queries/budget-integration";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI ENGAGE UNE ENVELOPPE, ET CE QUI DATE UNE DÉPENSE — les lectures derrière `budget/engage.ts` et
 * `budget/depense-poste.ts`.
 *
 * L'ENGAGÉ (promis, pas payé) d'une catégorie, sans compter deux fois le même dinar :
 *   • chaque poste Ad & Pro ACCORDÉ rangé dans la catégorie, selon l'état de SA DÉPENSE (`depenseDuPoste`, Direction
 *     10/2026) : engagé = la somme de ses BC signés une fois la Direction Marketing l'a IMPUTÉ ; consommé en circuit =
 *     ses ordres émis non réglés ; rien tant qu'il est « à imputer », rien une fois annulé ;
 *   • chaque ORDRE DE DÉPENSE émis non réglé qui n'appartient à aucun poste : sa catégorie posée, sinon celle où son
 *     règlement l'imputera (l'attribution automatique du règlement, `auto-category.ts`) ;
 * les remises de caisse d'avance et les virements de paie, qui ne sont pas des dépenses d'une enveloppe, en sont exclus.
 * Chaque détail dit sa NATURE : `ENGAGE` (imputé, pas consommé) ou `EN_CIRCUIT` (ordre émis, au centre de paiement ou
 * chez les Finances) — l'onglet Dépenses coupe le « non payé » de la vue d'ensemble en ces deux parts.
 *
 * LA DATE d'une écriture réglée : celle choisie à la saisie ; sinon le règlement ou la date de sa facture (réglée
 * directement, ou payée par l'ordre qui a écrit l'écriture) ; à défaut, le jour de la saisie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DetailEngagement {
  categoryId: string;
  montant: number;
  /** Le poste Ad & Pro qui engage (null pour un ordre hors poste). */
  posteId: string | null;
  /** La source de l'ordre hors poste (sponsoring, prise en charge…). */
  sourceType: EntityType | null;
  sourceId: string | null;
  /** `ENGAGE` : imputé, pas encore consommé ; `EN_CIRCUIT` : un ordre émis, pas encore réglé. */
  nature: "ENGAGE" | "EN_CIRCUIT";
  /** L'ordre émis d'un détail `EN_CIRCUIT` — la règle d'intégration le date par lui (`budget/integration-regle.ts`). */
  ordreId?: string | null;
}

export interface EngagementsEnveloppe {
  parCategorie: Map<string, number>;
  /** La part de `parCategorie` déjà consommée (ordres émis, pas réglés). */
  enCircuitParCategorie: Map<string, number>;
  details: DetailEngagement[];
}

const ENGAGES = [...STATUTS_ORDRE_ENGAGES] as ("PENDING" | "REVISION_REQUESTED")[];

/** Un poste tel que la lecture de sa dépense le demande. */
export interface PostePourDepense {
  id: string;
  status: string;
  expenseOrderId: string | null;
  amountGranted: unknown;
  depenseImputeeLe: Date | null;
  depenseAnnuleeLe: Date | null;
}

export interface BcLu { id: string; reference: string | null; titre: string; fournisseur: string | null; montant: number | null; signeLe: Date | null }
export interface OrdreLu { id: string; reference: string; montant: number; statut: string; centralStatus: string; budgetCategoryId: string | null; transactionId: string | null }

export interface DepenseLue {
  faits: FaitsDepensePoste;
  depense: DepensePoste;
  bcs: BcLu[];
  /** Les vrais ordres du poste (les factures réglées directement n'y sont pas). */
  ordres: OrdreLu[];
  /** Une facture vivante est-elle déposée sur le poste (ou sur l'un de ses ordres) ? */
  facture: { id: string; reference: string | null } | null;
}

/**
 * LA DÉPENSE DE CHAQUE POSTE, en lot : ses BC vivants (pièces du poste et demandes de BC acceptées), ses ordres (le
 * sien, ceux qui le désignent, ceux de ses factures), ses factures — puis l'état pur (`depenseDuPoste`). Une facture
 * réglée directement, sans ordre, a payé le BC elle aussi : elle compte comme un règlement.
 */
export async function depensesDesPostes(postes: readonly PostePourDepense[]): Promise<Map<string, DepenseLue>> {
  const out = new Map<string, DepenseLue>();
  if (postes.length === 0) return out;
  const posteIds = postes.map((p) => p.id);
  const [pieces, demandesBc] = await Promise.all([
    prisma.adProItemPiece.findMany({ where: { itemId: { in: posteIds }, nature: { in: ["BON_DE_COMMANDE", "FACTURE"] } }, select: { itemId: true, legalDocumentId: true, nature: true } }),
    prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: posteIds }, legalDocumentId: { not: null } }, select: { entityId: true, legalDocumentId: true } }),
  ]);
  const docsDuPoste = new Map<string, Set<string>>();
  for (const l of [...pieces.map((p) => ({ poste: p.itemId, doc: p.legalDocumentId })), ...demandesBc.map((d) => ({ poste: d.entityId, doc: d.legalDocumentId as string }))]) {
    docsDuPoste.set(l.poste, (docsDuPoste.get(l.poste) ?? new Set()).add(l.doc));
  }
  const docIds = [...new Set([...docsDuPoste.values()].flatMap((s) => [...s]))];
  const [bcs, factures] = docIds.length
    ? await Promise.all([
        prisma.legalDocument.findMany({
          where: { id: { in: docIds }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" }, cancelledAt: null },
          select: { id: true, reference: true, title: true, counterparty: true, amount: true, signedAt: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        prisma.legalDocument.findMany({
          where: { kind: "INVOICE", status: { not: "CANCELLED" }, OR: [{ chainFromId: { in: docIds } }, { id: { in: docIds } }] },
          select: { id: true, reference: true, chainFromId: true, amount: true, expenseOrderId: true, settlementTxId: true, paidDate: true },
        }),
      ])
    : [[], []];
  const bcParId = new Map(bcs.map((b) => [b.id, b]));

  const ordresDesFactures = factures.map((f) => f.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordresDesPostes = postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordres = await prisma.expenseOrder.findMany({
    where: {
      OR: [
        ...(ordresDesPostes.length + ordresDesFactures.length ? [{ id: { in: [...ordresDesPostes, ...ordresDesFactures] } }] : []),
        { sourceType: "AD_PRO_ITEM" as const, sourceId: { in: posteIds } },
      ],
    },
    select: { id: true, reference: true, amount: true, status: true, centralStatus: true, budgetCategoryId: true, transactionId: true, sourceType: true, sourceId: true },
  });
  const ordreParId = new Map(ordres.map((o) => [o.id, o]));

  for (const p of postes) {
    const docs = docsDuPoste.get(p.id) ?? new Set<string>();
    const sesBcs = [...docs].map((id) => bcParId.get(id)).filter((b): b is (typeof bcs)[number] => Boolean(b))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const sesFactures = factures.filter((f) => docs.has(f.id) || (f.chainFromId != null && docs.has(f.chainFromId)));
    const ids = new Set<string>([
      ...(p.expenseOrderId ? [p.expenseOrderId] : []),
      ...ordres.filter((o) => o.sourceType === "AD_PRO_ITEM" && o.sourceId === p.id).map((o) => o.id),
      ...sesFactures.map((f) => f.expenseOrderId).filter((x): x is string => Boolean(x)),
    ]);
    const sesOrdres: OrdreLu[] = [...ids].map((id) => ordreParId.get(id)).filter((o): o is (typeof ordres)[number] => Boolean(o)).map((o) => ({
      id: o.id, reference: o.reference, montant: toNumber(o.amount), statut: o.status, centralStatus: o.centralStatus,
      budgetCategoryId: o.budgetCategoryId, transactionId: o.transactionId,
    }));
    const regleesDirectement = sesFactures.filter((f) => !f.expenseOrderId && (f.settlementTxId || f.paidDate));
    const faits: FaitsDepensePoste = {
      accorde: p.status === "APPROVED",
      bcs: sesBcs.map((b) => ({ id: b.id, montant: b.amount == null ? null : toNumber(b.amount), signe: b.signedAt !== null, annule: false })),
      montantAccorde: p.amountGranted == null ? null : toNumber(p.amountGranted as Parameters<typeof toNumber>[0]),
      imputeeLe: p.depenseImputeeLe,
      annuleeLe: p.depenseAnnuleeLe,
      ordres: [
        ...sesOrdres.map((o) => ({ id: o.id, montant: o.montant, statut: o.statut, centralStatus: o.centralStatus })),
        ...regleesDirectement.map((f) => ({ id: `facture:${f.id}`, montant: f.amount == null ? 0 : toNumber(f.amount), statut: "PAID", centralStatus: null })),
      ],
    };
    const facture = sesFactures[0] ?? null;
    out.set(p.id, {
      faits,
      depense: depenseDuPoste(faits),
      bcs: sesBcs.map((b) => ({ id: b.id, reference: b.reference, titre: b.title, fournisseur: b.counterparty, montant: b.amount == null ? null : toNumber(b.amount), signeLe: b.signedAt })),
      ordres: sesOrdres,
      facture: facture ? { id: facture.id, reference: facture.reference } : null,
    });
  }
  return out;
}

/** Les engagements BRUTS (avant la règle d'intégration) — pour juger chacun, et lister ceux « absents du fichier ». */
export async function engagementsBruts(catIds: readonly string[], periodEnd: Date): Promise<EngagementsEnveloppe> {
  const parCategorie = new Map<string, number>();
  const enCircuitParCategorie = new Map<string, number>();
  const details: DetailEngagement[] = [];
  if (catIds.length === 0) return { parCategorie, enCircuitParCategorie, details };
  const dansLEnveloppe = new Set(catIds);
  const ajouter = (d: DetailEngagement) => {
    if (!(d.montant > 0)) return;
    details.push(d);
    parCategorie.set(d.categoryId, (parCategorie.get(d.categoryId) ?? 0) + d.montant);
    if (d.nature === "EN_CIRCUIT") enCircuitParCategorie.set(d.categoryId, (enCircuitParCategorie.get(d.categoryId) ?? 0) + d.montant);
  };

  // ── 1. Les postes accordés de l'enveloppe : l'état de leur dépense ───────────────────────────────────────
  const postes = await prisma.adProItem.findMany({
    where: { budgetCategoryId: { in: [...catIds] }, status: "APPROVED" },
    select: { id: true, status: true, budgetCategoryId: true, expenseOrderId: true, amountGranted: true, depenseImputeeLe: true, depenseAnnuleeLe: true },
  });
  const depenses = await depensesDesPostes(postes);
  const rattaches = new Set<string>();
  for (const p of postes) {
    const cat = p.budgetCategoryId;
    const lue = depenses.get(p.id);
    if (!lue) continue;
    for (const o of lue.ordres) rattaches.add(o.id);
    if (!cat || !dansLEnveloppe.has(cat)) continue;
    for (const o of lue.ordres) {
      if (ordreEnCircuit(o.statut)) ajouter({ categoryId: cat, montant: o.montant, posteId: p.id, sourceType: null, sourceId: null, nature: "EN_CIRCUIT", ordreId: o.id });
    }
    ajouter({ categoryId: cat, montant: lue.depense.engage, posteId: p.id, sourceType: null, sourceId: null, nature: "ENGAGE" });
  }

  // ── 2. Les ordres émis hors poste ───────────────────────────────────────────────────────────────────────
  const ordres = await prisma.expenseOrder.findMany({
    where: {
      OR: [
        { status: { in: ENGAGES }, budgetCategoryId: { in: [...catIds] } },
        { status: { in: ENGAGES }, budgetCategoryId: null, sourceType: { not: null }, createdAt: { lte: periodEnd } },
      ],
    },
    select: {
      id: true, status: true, amount: true, budgetCategoryId: true, sourceType: true, sourceId: true,
      pettyCashAllotment: { select: { id: true } }, payrollWire: { select: { id: true } },
    },
  });
  // Un ordre d'un poste accordé rangé dans une AUTRE enveloppe n'est pas hors poste : il pèse là où son poste est rangé.
  const autresPostes = ordres.length
    ? await prisma.adProItem.findMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) }, status: "APPROVED", budgetCategoryId: { not: null } }, select: { expenseOrderId: true } })
    : [];
  for (const a of autresPostes) if (a.expenseOrderId) rattaches.add(a.expenseOrderId);
  const sansCategorie = ordres.filter((o) => !rattaches.has(o.id) && ordreEngage(o.status) && !o.budgetCategoryId && !o.pettyCashAllotment && !o.payrollWire);
  let auto: ((m: string | null) => string | null) | null = null;
  if (sansCategorie.length) {
    const [envelopes, categories] = await Promise.all([
      prisma.budgetEnvelope.findMany({ where: { isActive: true }, select: { id: true, isActive: true, modules: true, module: true, periodStart: true } }),
      prisma.budgetCategoryLine.findMany({ where: { parentId: null, envelope: { isActive: true } }, select: { id: true, envelopeId: true, module: true, parentId: true, createdAt: true } }),
    ]);
    auto = (m) => pickAutoCategory(m, envelopes, categories);
  }
  for (const o of ordres) {
    if (rattaches.has(o.id) || !ordreEngage(o.status) || o.pettyCashAllotment || o.payrollWire) continue;
    const cat = o.budgetCategoryId ?? (auto && o.sourceType ? auto(ENTITY_MODULE[o.sourceType] ?? null) : null);
    if (!cat || !dansLEnveloppe.has(cat)) continue;
    ajouter({ categoryId: cat, montant: toNumber(o.amount), posteId: null, sourceType: o.sourceType, sourceId: o.sourceId, nature: "EN_CIRCUIT", ordreId: o.id });
  }
  return { parCategorie, enCircuitParCategorie, details };
}

/**
 * L'ENGAGÉ D'UNE LISTE DE CATÉGORIES — ce que lisent TOUS les écrans. Les engagements bruts, puis la règle d'intégration :
 * sur une enveloppe dont un lot est validé (Ad & Pro 2026), l'engagé né avant l'intégration et rattaché à une demande
 * intégrée est remplacé par le fichier ; un poste historique n'engage rien (`budget/integration-regle.ts`). Sans lot,
 * rien ne change.
 */
export async function engagementsDesCategories(catIds: readonly string[], periodEnd: Date): Promise<EngagementsEnveloppe> {
  const brut = await engagementsBruts(catIds, periodEnd);
  const ctxs = await contextesDesCategories(catIds);
  if (ctxs.length === 0) return brut;
  const { comptes } = await jugerEngagements(ctxs, brut.details);
  const parCat = new Map<string, number>();
  const enCircuit = new Map<string, number>();
  for (const d of comptes) {
    parCat.set(d.categoryId, (parCat.get(d.categoryId) ?? 0) + d.montant);
    if (d.nature === "EN_CIRCUIT") enCircuit.set(d.categoryId, (enCircuit.get(d.categoryId) ?? 0) + d.montant);
  }
  return { parCategorie: parCat, enCircuitParCategorie: enCircuit, details: comptes };
}

/**
 * LA DATE RÉELLE de chaque écriture (id → date), lue en lot : la facture réglée directement par l'écriture, ou celles
 * de l'ordre qui l'a écrite au règlement.
 */
export async function datesReellesDesEcritures(ecritures: readonly { id: string; date: Date; createdAt: Date }[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (ecritures.length === 0) return out;
  const ids = ecritures.map((e) => e.id);
  const [directes, ordres] = await Promise.all([
    prisma.legalDocument.findMany({ where: { settlementTxId: { in: ids } }, select: { settlementTxId: true, paidDate: true, startDate: true } }),
    prisma.expenseOrder.findMany({ where: { transactionId: { in: ids } }, select: { id: true, transactionId: true } }),
  ]);
  const parOrdre = ordres.length
    ? await prisma.legalDocument.findMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) }, kind: "INVOICE" }, select: { expenseOrderId: true, paidDate: true, startDate: true } })
    : [];
  const factureDe = new Map<string, { paidDate: Date | null; startDate: Date | null }>();
  for (const f of directes) if (f.settlementTxId) factureDe.set(f.settlementTxId, f);
  const ecritureDeLOrdre = new Map(ordres.map((o) => [o.id, o.transactionId]));
  for (const f of parOrdre) {
    const tx = f.expenseOrderId ? ecritureDeLOrdre.get(f.expenseOrderId) : null;
    if (tx && !factureDe.has(tx)) factureDe.set(tx, f);
  }
  for (const e of ecritures) {
    const f = factureDe.get(e.id);
    out.set(e.id, dateDeLaDepense({ date: e.date, createdAt: e.createdAt, facturePayeeLe: f?.paidDate ?? null, factureDu: f?.startDate ?? null }));
  }
  return out;
}
