/**
 * PRISE EN CHARGE — les CASES lues pour les règles des fiches voyageur (dates en AAAA-MM-JJ) et les personnes
 * d'une demande avec leurs cases.
 *
 * Sorti de `actions/care-actions.ts` (lot V4) : lectures seulement.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { beneficiaryName } from "@/lib/care";
import { detailsStockes, etapesDuBillet, etapesStockees, type CellRow } from "@/lib/care-fiches";
import { parentWhere, type Scope } from "./demande";

/** Une case lue pour les règles des fiches (dates en AAAA-MM-JJ). */
export const CELL_FICHE_SELECT = {
  id: true, kind: true, serviceKind: true, label: true, notes: true, status: true, amountDzd: true, amount: true, currency: true,
  expenseOrderId: true, promoMaterialId: true, documentId: true, dateStart: true, dateEnd: true, trajet: true, transport: true,
  fromCity: true, toCity: true, segments: true, hotelName: true, city: true, roomType: true,
  issuedDocumentId: true, bookingRef: true, legDetails: true, timeStart: true, address: true,
} as const;

export type CellFicheDb = Prisma.CareCellGetPayload<{ select: typeof CELL_FICHE_SELECT }>;

export function versCellRow(c: CellFicheDb): CellRow {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const base = {
    id: c.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, notes: c.notes, status: c.status,
    amountDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null, amount: c.amount != null ? toNumber(c.amount) : null,
    currency: c.currency, expenseOrderId: c.expenseOrderId, promoMaterialId: c.promoMaterialId, documentId: c.documentId,
    promoMaterial: null, dateStart: iso(c.dateStart), dateEnd: iso(c.dateEnd), trajet: c.trajet, transport: c.transport,
    fromCity: c.fromCity, toCity: c.toCity, segments: etapesStockees(c.segments), hotelName: c.hotelName, city: c.city, roomType: c.roomType,
    issuedDocumentId: c.issuedDocumentId, bookingRef: c.bookingRef, timeStart: c.timeStart, address: c.address,
  };
  return { ...base, legDetails: detailsStockes(c.legDetails, c.serviceKind === "TICKET" ? etapesDuBillet(base).length : 0) };
}

/** Les personnes d'une demande, avec leurs cases lues pour les règles des fiches. */
export async function fichesDeLaDemande(scope: Scope, requestId: string) {
  const rows = await prisma.careBeneficiary.findMany({
    where: parentWhere(scope, requestId),
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, status: true, doctorId: true, firstName: true, lastName: true, cells: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: CELL_FICHE_SELECT } },
  });
  const ids = rows.map((r) => r.doctorId).filter((x): x is string => Boolean(x));
  const docs = ids.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(docs.map((d) => [d.id, d.name]));
  return rows.map((r) => ({
    id: r.id, status: r.status,
    nom: beneficiaryName({ ...r, doctorName: r.doctorId ? nomDe.get(r.doctorId) ?? null : null }),
    cells: r.cells.map(versCellRow),
  }));
}
