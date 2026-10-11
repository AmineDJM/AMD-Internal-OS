import type { CareMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { beneficiaryName, beneficiarySubtitle } from "@/lib/care";
import { detailsStockes, etapesDuBillet, etapesStockees, tauxDeLaDemande, type BeneficiaryRow, type GroupPosteRow, type QuoteRow } from "@/lib/care-fiches";
import { statutDuDossier } from "@/lib/promo-material/statut";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: unknown) => (v != null ? toNumber(v) : null);

/**
 * Lecture du dossier de prise en charge — personnes (leurs fiches voyageur), leurs cases, les devis,
 * les postes de groupe, et les réglages de la demande (mode, taux figé, sujet de l'assistante).
 *
 * Une seule fonction pour les deux périmètres : la question est la même, la réponse doit
 * l'être. Les noms venant de l'annuaire sont résolus **en une requête** plutôt qu'une par
 * personne — un dossier de vingt participants ne doit pas coûter vingt allers-retours.
 */
export async function getCareDossier(scope: "NATIONAL" | "INTERNATIONAL", requestId: string): Promise<{
  beneficiaries: BeneficiaryRow[];
  quotes: QuoteRow[];
  groupPostes: GroupPosteRow[];
  reglages: { mode: CareMode; taux: number | null; reservation: { id: string; reference: string } | null; city: string | null };
}> {
  const where = scope === "NATIONAL" ? { congressNationalId: requestId } : { congressInternationalId: requestId };

  const [rows, quotes, groupes, demande] = await Promise.all([
    prisma.careBeneficiary.findMany({
      where,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, doctorId: true, firstName: true, lastName: true, jobTitle: true, institution: true,
        requesterOpinion: true, requesterNote: true, status: true, decisionNote: true,
        cells: {
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, kind: true, serviceKind: true, label: true, notes: true, status: true, amountDzd: true, expenseOrderId: true, promoMaterialId: true, documentId: true,
            dateStart: true, dateEnd: true, trajet: true, transport: true, fromCity: true, toCity: true, segments: true,
            hotelName: true, city: true, roomType: true, amount: true, currency: true,
            issuedDocumentId: true, bookingRef: true, legDetails: true, timeStart: true, address: true,
          },
        },
      },
    }),
    prisma.careQuote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, supplier: true, reference: true, amountDzd: true, status: true, note: true, documentId: true,
        amount: true, currency: true, serviceKind: true, retainedAt: true, bcRequestedAt: true,
        cells: { select: { cellId: true, cell: { select: { label: true } } } },
      },
    }),
    prisma.careGroupPoste.findMany({ where, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    scope === "NATIONAL"
      ? prisma.congressNational.findUnique({ where: { id: requestId }, select: { careMode: true, usdDzdRate: true, careReservationDossierId: true, city: true } })
      : prisma.congressInternational.findUnique({ where: { id: requestId }, select: { careMode: true, usdDzdRate: true, careReservationDossierId: true, city: true } }),
  ]);

  // Le matériel promotionnel rattaché à des cases, en UNE requête.
  const promoIds = rows.flatMap((r) => r.cells.map((c) => c.promoMaterialId)).filter((x): x is string => Boolean(x));
  const promos = promoIds.length
    ? await prisma.promoMaterial.findMany({ where: { id: { in: [...new Set(promoIds)] } }, select: { id: true, reference: true, title: true, status: true, circuitState: true, circuitVersion: true, returnedAt: true } })
    : [];
  const promoById = new Map(promos.map((p) => [p.id, { reference: p.reference, title: p.title, status: statutDuDossier(p).libelle }]));

  // Les noms de l'annuaire, en UNE requête.
  const doctorIds = rows.map((r) => r.doctorId).filter((x): x is string => Boolean(x));
  const doctors = doctorIds.length
    ? await prisma.medicalDoctor.findMany({ where: { id: { in: doctorIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(doctors.map((d) => [d.id, d.name]));

  const sujet = demande?.careReservationDossierId
    ? await prisma.dossier.findUnique({ where: { id: demande.careReservationDossierId }, select: { id: true, reference: true } })
    : null;

  return {
    beneficiaries: rows.map((r) => {
      const identity = { ...r, doctorName: r.doctorId ? nameById.get(r.doctorId) ?? null : null };
      return {
        id: r.id,
        name: beneficiaryName(identity),
        subtitle: beneficiarySubtitle(identity),
        fromDirectory: Boolean(r.doctorId),
        requesterOpinion: r.requesterOpinion,
        requesterNote: r.requesterNote,
        status: r.status,
        decisionNote: r.decisionNote,
        cells: r.cells.map((c) => {
          const base = {
            id: c.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, notes: c.notes,
            status: c.status,
            amountDzd: num(c.amountDzd),
            amount: num(c.amount),
            currency: c.currency,
            expenseOrderId: c.expenseOrderId,
            promoMaterialId: c.promoMaterialId,
            documentId: c.documentId,
            promoMaterial: c.promoMaterialId ? promoById.get(c.promoMaterialId) ?? null : null,
            dateStart: iso(c.dateStart), dateEnd: iso(c.dateEnd),
            trajet: c.trajet, transport: c.transport, fromCity: c.fromCity, toCity: c.toCity,
            segments: etapesStockees(c.segments),
            hotelName: c.hotelName, city: c.city, roomType: c.roomType,
            issuedDocumentId: c.issuedDocumentId, bookingRef: c.bookingRef, timeStart: c.timeStart, address: c.address,
          };
          return { ...base, legDetails: detailsStockes(c.legDetails, c.serviceKind === "TICKET" ? etapesDuBillet(base).length : 0) };
        }),
      };
    }),
    quotes: quotes.map((q) => ({
      id: q.id, supplier: q.supplier, reference: q.reference,
      amountDzd: toNumber(q.amountDzd), amount: num(q.amount), currency: q.currency, serviceKind: q.serviceKind,
      status: q.status, note: q.note, documentId: q.documentId,
      retained: q.retainedAt != null, bcRequested: q.bcRequestedAt != null,
      cellIds: q.cells.map((c) => c.cellId),
      cellLabels: q.cells.map((c) => c.cell.label),
    })),
    groupPostes: groupes.map((g) => ({
      id: g.id, serviceKind: g.serviceKind, label: g.label, notes: g.notes, date: iso(g.date), timeStart: g.timeStart, address: g.address,
      unitAmount: num(g.unitAmount), currency: g.currency, unitAmountDzd: num(g.unitAmountDzd),
      excludedBeneficiaryIds: g.excludedBeneficiaryIds, status: g.status,
    })),
    reglages: {
      mode: demande?.careMode ?? "INDIVIDUAL",
      taux: tauxDeLaDemande(scope, num(demande?.usdDzdRate)),
      reservation: sujet,
      city: demande?.city ?? null,
    },
  };
}
