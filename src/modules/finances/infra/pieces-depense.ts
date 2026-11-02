import { prisma } from "@/lib/prisma";
import { entityHref } from "@/lib/entity-href";
import { dossierHrefByOrder } from "./expense-orders";
import { fichiersEmis, lienFichierEmis } from "@/lib/lecteurs/fichiers-emis";
import { ENTITY_TYPE_LABELS } from "@/lib/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE DÉPENSE « À IMPUTER » (Direction, 06/10) — « pour rattacher, j'ai besoin d'avoir les documents liés à
 * ces différentes choses pour que je comprenne mieux ».
 *
 * Une écriture de trésorerie (`FinanceTransaction`) ne porte rien elle-même : ce qui l'explique est AILLEURS, par lien.
 *   • la FACTURE réglée directement (`LegalDocument.settlementTxId`) ;
 *   • l'ORDRE DE DÉPENSE payé par elle (`ExpenseOrder.transactionId`), sa source (poste Ad & Pro, demande de
 *     paiement…), son dossier de paiement, et les factures qui lui sont rattachées (`LegalDocument.expenseOrderId`) ;
 *   • les fichiers de tout cela (`Document` sur l'écriture, l'ordre ou la facture ; Word/PDF émis par la fabrique).
 * Tout se lit EN LOT pour les lignes affichées — jamais une requête par ligne (§118.102b).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LienDepense { libelle: string; href: string }
export interface PieceDepense { id: string; nom: string; href: string }
export interface PiecesDeDepense {
  /** Payée ou non, dit par l'écriture et par l'ordre qu'elle règle — en clair. */
  paiement: string;
  liens: LienDepense[];
  pieces: PieceDepense[];
}

const STATUT_ECRITURE: Record<string, string> = { SETTLED: "Réglée (sortie de trésorerie)", PENDING: "À payer", CANCELLED: "Annulée" };
const STATUT_ORDRE: Record<string, string> = { PENDING: "ordre au centre de paiement", REVISION_REQUESTED: "ordre renvoyé pour révision", PAID: "ordre payé", CANCELLED: "ordre annulé" };

export async function piecesDesEcritures(ecritures: readonly { id: string; status: string }[]): Promise<Map<string, PiecesDeDepense>> {
  const res = new Map<string, PiecesDeDepense>();
  if (ecritures.length === 0) return res;
  const ids = ecritures.map((e) => e.id);
  const [factures, ordres] = await Promise.all([
    prisma.legalDocument.findMany({ where: { settlementTxId: { in: ids } }, select: { id: true, title: true, reference: true, settlementTxId: true, custom: true, paidDate: true } }),
    prisma.expenseOrder.findMany({ where: { transactionId: { in: ids } }, select: { id: true, reference: true, transactionId: true, status: true, sourceType: true, sourceId: true } }),
  ]);
  const ordreIds = ordres.map((o) => o.id);
  const [facturesDesOrdres, dossiers] = await Promise.all([
    ordreIds.length > 0
      ? prisma.legalDocument.findMany({ where: { expenseOrderId: { in: ordreIds } }, select: { id: true, title: true, reference: true, expenseOrderId: true, custom: true, paidDate: true } })
      : Promise.resolve([]),
    dossierHrefByOrder(ordreIds),
  ]);
  const toutesFactures = [...factures, ...facturesDesOrdres];
  const docs = await prisma.document.findMany({
    where: {
      OR: [
        { entityType: "FINANCE_TRANSACTION", entityId: { in: ids } },
        ...(ordreIds.length > 0 ? [{ entityType: "EXPENSE_ORDER" as const, entityId: { in: ordreIds } }] : []),
        ...(toutesFactures.length > 0 ? [{ entityType: "LEGAL_DOCUMENT" as const, entityId: { in: toutesFactures.map((f) => f.id) } }] : []),
      ],
    },
    select: { id: true, name: true, entityType: true, entityId: true },
    orderBy: { createdAt: "asc" },
  });
  const docsDe = (type: string, id: string): PieceDepense[] =>
    docs.filter((d) => d.entityType === type && d.entityId === id).map((d) => ({ id: d.id, nom: d.name, href: `/api/documents/${d.id}` }));
  const piecesDeFacture = (f: { id: string; custom: unknown; reference: string | null; title: string }): PieceDepense[] => {
    const emis = fichiersEmis(f.custom);
    return [
      ...docsDe("LEGAL_DOCUMENT", f.id),
      ...(emis.pdf ? [{ id: `${f.id}-pdf`, nom: `${f.reference ?? f.title} (PDF)`, href: lienFichierEmis(f.id, "pdf") }] : []),
      ...(emis.docx ? [{ id: `${f.id}-docx`, nom: `${f.reference ?? f.title} (Word)`, href: lienFichierEmis(f.id, "docx") }] : []),
    ];
  };

  for (const e of ecritures) {
    const liens: LienDepense[] = [];
    const pieces: PieceDepense[] = [...docsDe("FINANCE_TRANSACTION", e.id)];
    let paiement = STATUT_ECRITURE[e.status] ?? e.status;
    for (const f of factures.filter((x) => x.settlementTxId === e.id)) {
      liens.push({ libelle: `Facture ${f.reference ?? f.title}`, href: `/legal/${f.id}` });
      pieces.push(...piecesDeFacture(f));
      if (f.paidDate) paiement += ` — facture marquée payée le ${f.paidDate.toLocaleDateString("fr-FR")}`;
    }
    for (const o of ordres.filter((x) => x.transactionId === e.id)) {
      paiement += ` — ${STATUT_ORDRE[o.status] ?? o.status} (${o.reference})`;
      const dossier = dossiers.get(o.id);
      if (dossier) liens.push({ libelle: `Dossier de paiement ${o.reference}`, href: dossier });
      const source = entityHref(o.sourceType, o.sourceId);
      if (source && o.sourceType) liens.push({ libelle: `Origine : ${ENTITY_TYPE_LABELS[o.sourceType] ?? "élément"}`, href: source });
      pieces.push(...docsDe("EXPENSE_ORDER", o.id));
      for (const f of facturesDesOrdres.filter((x) => x.expenseOrderId === o.id)) {
        liens.push({ libelle: `Facture ${f.reference ?? f.title}`, href: `/legal/${f.id}` });
        pieces.push(...piecesDeFacture(f));
      }
    }
    res.set(e.id, { paiement, liens, pieces });
  }
  return res;
}
