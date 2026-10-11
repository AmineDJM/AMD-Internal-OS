import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { STATUTS_ORDRE_ENGAGES, dateDeLaDepense, ordreEngage, surplusDuBc } from "@/lib/budget/engage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI ENGAGE UNE ENVELOPPE, ET CE QUI DATE UNE DÉPENSE — les lectures derrière `budget/engage.ts`.
 *
 * L'ENGAGÉ (promis, pas payé) d'une catégorie, sans compter deux fois le même dinar :
 *   • chaque poste Ad & Pro ACCORDÉ rangé dans la catégorie : max(ordres en attente, BC émis − déjà payé) ;
 *   • chaque ORDRE DE DÉPENSE émis non réglé qui n'appartient à aucun poste : sa catégorie posée, sinon celle où son
 *     règlement l'imputera (l'attribution automatique du règlement, `auto-category.ts`) ;
 * les remises de caisse d'avance et les virements de paie, qui ne sont pas des dépenses d'une enveloppe, en sont exclus.
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
}

export interface EngagementsEnveloppe {
  parCategorie: Map<string, number>;
  details: DetailEngagement[];
}

const ENGAGES = [...STATUTS_ORDRE_ENGAGES] as ("PENDING" | "REVISION_REQUESTED")[];

export async function engagementsDesCategories(catIds: readonly string[], periodEnd: Date): Promise<EngagementsEnveloppe> {
  const parCategorie = new Map<string, number>();
  const details: DetailEngagement[] = [];
  if (catIds.length === 0) return { parCategorie, details };
  const dansLEnveloppe = new Set(catIds);
  const ajouter = (d: DetailEngagement) => {
    if (!(d.montant > 0)) return;
    details.push(d);
    parCategorie.set(d.categoryId, (parCategorie.get(d.categoryId) ?? 0) + d.montant);
  };

  // ── 1. Les postes accordés de l'enveloppe, leurs BC émis et les factures de ces BC ──────────────────────
  const postes = await prisma.adProItem.findMany({
    where: { budgetCategoryId: { in: [...catIds] }, status: "APPROVED" },
    select: { id: true, budgetCategoryId: true, expenseOrderId: true, amountGranted: true },
  });
  const posteIds = postes.map((p) => p.id);
  const [pieces, demandesBc] = posteIds.length
    ? await Promise.all([
        prisma.adProItemPiece.findMany({ where: { itemId: { in: posteIds }, nature: "BON_DE_COMMANDE" }, select: { itemId: true, legalDocumentId: true } }),
        prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: posteIds }, legalDocumentId: { not: null } }, select: { entityId: true, legalDocumentId: true } }),
      ])
    : [[], []];
  const bcDuPoste = new Map<string, Set<string>>();
  for (const l of [...pieces.map((p) => ({ poste: p.itemId, doc: p.legalDocumentId })), ...demandesBc.map((d) => ({ poste: d.entityId, doc: d.legalDocumentId as string }))]) {
    bcDuPoste.set(l.poste, (bcDuPoste.get(l.poste) ?? new Set()).add(l.doc));
  }
  const docIds = [...new Set([...bcDuPoste.values()].flatMap((s) => [...s]))];
  const [bcs, factures] = docIds.length
    ? await Promise.all([
        prisma.legalDocument.findMany({ where: { id: { in: docIds }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } }, select: { id: true, amount: true } }),
        prisma.legalDocument.findMany({
          where: { chainFromId: { in: docIds }, kind: "INVOICE", status: { not: "CANCELLED" } },
          select: { id: true, chainFromId: true, amount: true, expenseOrderId: true, settlementTxId: true, paidDate: true },
        }),
      ])
    : [[], []];
  const montantBc = new Map(bcs.map((b) => [b.id, b.amount == null ? null : toNumber(b.amount)]));

  // ── 2. Les ordres : ceux des postes (directs, par source, par facture) et ceux, émis, des catégories ──────
  const ordresDesFactures = factures.map((f) => f.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordresDesPostes = postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordres = await prisma.expenseOrder.findMany({
    where: {
      OR: [
        ...(ordresDesPostes.length + ordresDesFactures.length ? [{ id: { in: [...ordresDesPostes, ...ordresDesFactures] } }] : []),
        ...(posteIds.length ? [{ sourceType: "AD_PRO_ITEM" as const, sourceId: { in: posteIds } }] : []),
        { status: { in: ENGAGES }, budgetCategoryId: { in: [...catIds] } },
        { status: { in: ENGAGES }, budgetCategoryId: null, sourceType: { not: null }, createdAt: { lte: periodEnd } },
      ],
    },
    select: {
      id: true, status: true, amount: true, budgetCategoryId: true, sourceType: true, sourceId: true,
      pettyCashAllotment: { select: { id: true } }, payrollWire: { select: { id: true } },
    },
  });
  const ordreParId = new Map(ordres.map((o) => [o.id, o]));
  const rattaches = new Set<string>();

  for (const p of postes) {
    const cat = p.budgetCategoryId;
    if (!cat || !dansLEnveloppe.has(cat)) continue;
    const bcIds = [...(bcDuPoste.get(p.id) ?? [])].filter((id) => montantBc.has(id));
    const facturesDuPoste = factures.filter((f) => f.chainFromId && bcIds.includes(f.chainFromId));
    const sesOrdres = new Set<string>([
      ...(p.expenseOrderId ? [p.expenseOrderId] : []),
      ...ordres.filter((o) => o.sourceType === "AD_PRO_ITEM" && o.sourceId === p.id).map((o) => o.id),
      ...facturesDuPoste.map((f) => f.expenseOrderId).filter((x): x is string => Boolean(x)),
    ]);
    let paye = 0, enAttente = 0;
    for (const id of sesOrdres) {
      const o = ordreParId.get(id);
      if (!o) continue;
      rattaches.add(id);
      if (o.status === "PAID") paye += toNumber(o.amount);
      else if (ordreEngage(o.status)) {
        enAttente += toNumber(o.amount);
        ajouter({ categoryId: cat, montant: toNumber(o.amount), posteId: p.id, sourceType: null, sourceId: null });
      }
    }
    // Une facture réglée directement (sans ordre) a payé le BC, elle aussi.
    for (const f of facturesDuPoste) if (!f.expenseOrderId && (f.settlementTxId || f.paidDate)) paye += toNumber(f.amount);
    // Un BC sans montant lisible vaut le montant accordé du poste — une donnée du poste, jamais une estimation.
    const montants = bcIds.map((id) => montantBc.get(id) ?? null);
    const bc = bcIds.length === 0 ? 0 : montants.every((m) => m == null) ? toNumber(p.amountGranted) : montants.reduce<number>((a, m) => a + (m ?? 0), 0);
    // Les ordres en attente sont déjà comptés : le BC n'ajoute que ce qu'il promet au-delà (`engagementDuPoste`).
    ajouter({ categoryId: cat, montant: surplusDuBc({ bc, paye, enAttente }), posteId: p.id, sourceType: null, sourceId: null });
  }

  // ── 3. Les ordres émis hors poste ───────────────────────────────────────────────────────────────────────
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
    ajouter({ categoryId: cat, montant: toNumber(o.amount), posteId: null, sourceType: o.sourceType, sourceId: o.sourceId });
  }
  return { parCategorie, details };
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
