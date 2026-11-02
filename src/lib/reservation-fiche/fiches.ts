import type { AdProTrajet, AdProTransport, CareCell, EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { beneficiaryName, manquesBillet, manquesHotel, personnePasseport, personneVivante, etapesStockees, resumeBillet, resumeHotel, type CellRow, type Perimetre, manquesPourReserver, nomComplet, lireEtapes, TRAJET_LIBELLE, TRANSPORT_LIBELLE, type EtapeTrajet, nuitsLisibles } from "@/modules/ad-pro/partage";
import {
  empreinteBillet, empreinteHotel, jourFr, manquesHebergement,
  type Empreinte, type NatureFiche, type SourceFiche,
} from "@/lib/reservation-fiche/etat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE, LUES UNE FOIS POUR TROIS ORIGINES (Direction, 14/10/2026).
 *
 * Un seul circuit pour les voyageurs d'un poste Ad & Pro (`AdProVoyageur`), les fiches hôtellerie
 * (`AdProHebergement`) et les billets / hôtels des prises en charge de congrès (`CareCell`). Chacune
 * garde SES règles (ce qui manque pour réserver, qui accorde) — on les APPELLE ici, on ne les recopie
 * pas — et sort sous une forme commune : ce que l'assistante lit, l'empreinte, l'accord, l'opération.
 *
 * Module SERVEUR (base). L'écran n'en importe que les types, par `etat.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'opération qui porte la fiche — sponsoring, prise en charge nationale / internationale, événement. */
export interface OperationDeFiche {
  type: EntityType;
  id: string;
  /** Ce qui l'identifie à l'écran : la référence d'un sponsoring, le nom d'un congrès. */
  ref: string;
  companyId: string | null;
  requesterId: string | null;
  /** La page de l'opération (demandeur). */
  chemin: string;
}

export interface FicheReservation {
  source: SourceFiche;
  id: string;
  nature: NatureFiche;
  nom: string;
  /** « aller-retour · Alger → Constantine · avion », « Hôtel Ibis, Constantine · 2 nuits · chambre Single ». */
  resume: string;
  /** « 22/10/2026 → 26/10/2026 », ou « à préciser ». */
  dates: string;
  empreinte: Empreinte;
  /** Ce qui manque pour l'envoyer (vide : elle part). */
  manques: string[];
  /** Le poste (ou la personne, en prise en charge) est ACCORDÉ : la réservation est permise. */
  accorde: boolean;
  /** Refusé / écarté : on n'envoie plus rien pour lui. */
  refus: string | null;
  itemId: string | null;
  careBeneficiaryId: string | null;
  /** Le poste : « Prise en charge de la billetterie » (Ad & Pro), « Billetterie » (prise en charge). */
  poste: string;
  /** Le montant accordé au poste (Ad & Pro), pour le panneau de l'assistante. */
  budget: number | null;
  fournisseur: string | null;
  operation: OperationDeFiche;
  /** Le sujet (DOS) qui sert de fil — celui du poste, ou de la prise en charge. */
  sujetId: string | null;
  /** Où vivent les pièces de la fiche (passeport, billet émis) : `Document.entityType / entityId`, `stepKey` = la fiche. */
  pieces: { entityType: string; entityId: string };
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const CHEMIN: Record<string, string> = {
  SPONSORING: "/sponsoring", CONGRESS_NATIONAL: "/congress-national", CONGRESS_INTERNATIONAL: "/congress-international", EVENT: "/events",
  AD_PRO_OTHER: "/ad-pro/autres",
};

/** Le MODULE de droits de chaque opération (pour `userCan`). */
export const MODULE_OPERATION: Record<string, "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENTS" | "AD_PRO_OTHER"> = {
  SPONSORING: "SPONSORING", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", EVENT: "EVENTS",
  AD_PRO_OTHER: "AD_PRO_OTHER",
};

export const cheminOperation = (type: string, id: string) => `${CHEMIN[type] ?? "/"}/${id}`;

/** Les opérations, en lot — une requête par famille, jamais une par fiche. */
async function operations(ids: { type: EntityType; id: string }[]): Promise<Map<string, OperationDeFiche & { sujetPriseEnCharge: string | null }>> {
  const par = (t: string) => [...new Set(ids.filter((x) => x.type === t).map((x) => x.id))];
  const [spo, cn, ci, ev, aut] = await Promise.all([
    par("SPONSORING").length ? prisma.sponsoringRequest.findMany({ where: { id: { in: par("SPONSORING") } }, select: { id: true, reference: true, institution: true, companyId: true, requesterId: true } }) : [],
    par("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: par("CONGRESS_NATIONAL") } }, select: { id: true, name: true, companyId: true, requesterId: true, careReservationDossierId: true } }) : [],
    par("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: par("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true, companyId: true, requesterId: true, careReservationDossierId: true } }) : [],
    par("EVENT").length ? prisma.event.findMany({ where: { id: { in: par("EVENT") } }, select: { id: true, name: true, companyId: true, requesterId: true } }) : [],
    par("AD_PRO_OTHER").length ? prisma.adProOtherRequest.findMany({ where: { id: { in: par("AD_PRO_OTHER") } }, select: { id: true, reference: true, title: true, companyId: true, requesterId: true } }) : [],
  ]);
  const m = new Map<string, OperationDeFiche & { sujetPriseEnCharge: string | null }>();
  for (const r of spo) m.set(`SPONSORING:${r.id}`, { type: "SPONSORING", id: r.id, ref: `${r.reference} · ${r.institution}`, companyId: r.companyId, requesterId: r.requesterId, chemin: cheminOperation("SPONSORING", r.id), sujetPriseEnCharge: null });
  for (const r of cn) m.set(`CONGRESS_NATIONAL:${r.id}`, { type: "CONGRESS_NATIONAL", id: r.id, ref: r.name, companyId: r.companyId, requesterId: r.requesterId, chemin: cheminOperation("CONGRESS_NATIONAL", r.id), sujetPriseEnCharge: r.careReservationDossierId });
  for (const r of ci) m.set(`CONGRESS_INTERNATIONAL:${r.id}`, { type: "CONGRESS_INTERNATIONAL", id: r.id, ref: r.name, companyId: r.companyId, requesterId: r.requesterId, chemin: cheminOperation("CONGRESS_INTERNATIONAL", r.id), sujetPriseEnCharge: r.careReservationDossierId });
  for (const r of ev) m.set(`EVENT:${r.id}`, { type: "EVENT", id: r.id, ref: r.name, companyId: r.companyId, requesterId: r.requesterId, chemin: cheminOperation("EVENT", r.id), sujetPriseEnCharge: null });
  for (const r of aut) m.set(`AD_PRO_OTHER:${r.id}`, { type: "AD_PRO_OTHER", id: r.id, ref: `${r.reference} · ${r.title}`, companyId: r.companyId, requesterId: r.requesterId, chemin: cheminOperation("AD_PRO_OTHER", r.id), sujetPriseEnCharge: null });
  return m;
}

const POSTE_SELECT = {
  id: true, label: true, status: true, amountGranted: true, supplier: true, reservationDossierId: true,
  sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
} as const;
type PosteLu = Prisma.AdProItemGetPayload<{ select: typeof POSTE_SELECT }>;

function operationDuPoste(p: PosteLu): { type: EntityType; id: string } | null {
  if (p.sponsoringId) return { type: "SPONSORING", id: p.sponsoringId };
  if (p.congressNationalId) return { type: "CONGRESS_NATIONAL", id: p.congressNationalId };
  if (p.congressInternationalId) return { type: "CONGRESS_INTERNATIONAL", id: p.congressInternationalId };
  if (p.eventId) return { type: "EVENT", id: p.eventId };
  if (p.otherRequestId) return { type: "AD_PRO_OTHER", id: p.otherRequestId };
  return null;
}

function refusDuPoste(status: string): string | null {
  return status === "REJECTED" ? "Ce poste a été refusé par la Direction : on ne réserve rien pour lui." : null;
}

const resumeTrajet = (trajet: AdProTrajet, de: string | null, vers: string | null, etapes: readonly EtapeTrajet[], transport: AdProTransport | null) => {
  const lieux = trajet === "MULTI_DESTINATIONS"
    ? (etapes.length ? [etapes[0]?.de ?? "?", ...etapes.map((e) => e.vers ?? "?")].join(" → ") : "étapes à préciser")
    : de || vers ? `${de ?? "?"} → ${vers ?? "?"}` : "trajet à préciser";
  return [lieux, TRAJET_LIBELLE[trajet], transport ? TRANSPORT_LIBELLE[transport] : "mode à préciser"].join(" · ");
};
const datesDe = (a: string | null, b: string | null, simple = false) =>
  !a && !b ? "à préciser" : simple ? jourFr(a) : `${jourFr(a)} → ${jourFr(b)}`;

export interface CleFiches {
  voyageurIds?: readonly string[];
  hebergementIds?: readonly string[];
  careCellIds?: readonly string[];
}

/** La clé d'une fiche dans les cartes rendues : `VOYAGEUR:<id>`… */
export const cleFiche = (source: SourceFiche, id: string) => `${source}:${id}`;

/**
 * LES FICHES, EN LOT — trois requêtes de fiches, une pour leurs pièces d'identité, une par famille
 * d'opérations. Une fiche introuvable est simplement absente de la carte rendue.
 */
export async function chargerFiches(cles: CleFiches): Promise<Map<string, FicheReservation>> {
  const vIds = [...new Set(cles.voyageurIds ?? [])];
  const hIds = [...new Set(cles.hebergementIds ?? [])];
  const cIds = [...new Set(cles.careCellIds ?? [])];
  const [voyageurs, hebergements, cellules] = await Promise.all([
    vIds.length ? prisma.adProVoyageur.findMany({ where: { id: { in: vIds } }, include: { item: { select: POSTE_SELECT } } }) : [],
    hIds.length ? prisma.adProHebergement.findMany({ where: { id: { in: hIds } }, include: { item: { select: POSTE_SELECT } } }) : [],
    cIds.length
      ? prisma.careCell.findMany({
          where: { id: { in: cIds }, kind: "SERVICE", serviceKind: { in: ["TICKET", "HOTEL"] } },
          include: {
            beneficiary: {
              select: {
                id: true, status: true, doctorId: true, firstName: true, lastName: true, congressNationalId: true, congressInternationalId: true,
                cells: { where: { kind: "DOCUMENT" }, select: { kind: true, label: true, status: true } },
              },
            },
          },
        })
      : [],
  ]);
  const ficheIdsAdPro = [...voyageurs.map((v) => v.id)];
  const passeports = ficheIdsAdPro.length
    ? new Set((await prisma.document.findMany({
        where: { entityType: "AD_PRO_ITEM", stepKey: { in: ficheIdsAdPro }, category: "ID_DOCUMENT" }, select: { stepKey: true },
      })).map((d) => d.stepKey))
    : new Set<string | null>();
  const docteurs = cellules.map((c) => c.beneficiary.doctorId).filter((x): x is string => Boolean(x));
  const nomsDocteurs = docteurs.length
    ? new Map((await prisma.medicalDoctor.findMany({ where: { id: { in: docteurs } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
    : new Map<string, string>();

  const refsOp: { type: EntityType; id: string }[] = [
    ...[...voyageurs, ...hebergements].map((f) => operationDuPoste(f.item)).filter((x): x is { type: EntityType; id: string } => Boolean(x)),
    ...cellules.map((c) => c.beneficiary.congressNationalId
      ? { type: "CONGRESS_NATIONAL" as EntityType, id: c.beneficiary.congressNationalId }
      : { type: "CONGRESS_INTERNATIONAL" as EntityType, id: c.beneficiary.congressInternationalId ?? "" }),
  ];
  const ops = await operations(refsOp);
  const out = new Map<string, FicheReservation>();

  for (const v of voyageurs) {
    const ref = operationDuPoste(v.item);
    const op = ref ? ops.get(`${ref.type}:${ref.id}`) : undefined;
    if (!op) continue;
    const lues = lireEtapes(v.segments);
    const etapes = lues.ok ? lues.etapes : [];
    const passeport = passeports.has(v.id);
    const simple = v.trajet === "ALLER_SIMPLE";
    out.set(cleFiche("VOYAGEUR", v.id), {
      source: "VOYAGEUR", id: v.id, nature: "BILLET", nom: nomComplet(v),
      resume: resumeTrajet(v.trajet, v.villeDepart, v.villeArrivee, etapes, v.transport),
      dates: datesDe(iso(v.dateDepart), iso(v.dateRetour), simple),
      empreinte: empreinteBillet({
        nom: nomComplet(v), trajet: TRAJET_LIBELLE[v.trajet], villeDepart: v.villeDepart, villeArrivee: v.villeArrivee,
        dateDepart: iso(v.dateDepart), dateRetour: iso(v.dateRetour), etapes: v.trajet === "MULTI_DESTINATIONS" ? etapes : [],
        transport: v.transport ? TRANSPORT_LIBELLE[v.transport] : null, notes: v.notes,
      }),
      manques: manquesPourReserver({
        nom: v.nom, prenom: v.prenom, segments: etapes, villeDepart: v.villeDepart, villeArrivee: v.villeArrivee,
        dateDepart: v.dateDepart, dateRetour: v.dateRetour, passeport, notes: v.notes, trajet: v.trajet, transport: v.transport,
      }),
      accorde: v.item.status === "APPROVED", refus: refusDuPoste(v.item.status),
      itemId: v.item.id, careBeneficiaryId: null, poste: v.item.label,
      budget: v.item.amountGranted != null ? toNumber(v.item.amountGranted) : null, fournisseur: v.item.supplier,
      operation: op, sujetId: v.item.reservationDossierId,
      pieces: { entityType: "AD_PRO_ITEM", entityId: v.item.id },
    });
  }

  for (const h of hebergements) {
    const ref = operationDuPoste(h.item);
    const op = ref ? ops.get(`${ref.type}:${ref.id}`) : undefined;
    if (!op) continue;
    const arrivee = iso(h.dateArrivee);
    const depart = iso(h.dateDepart);
    out.set(cleFiche("HEBERGEMENT", h.id), {
      source: "HEBERGEMENT", id: h.id, nature: "HOTEL", nom: nomComplet(h),
      resume: [
        [h.hotel, h.ville].filter(Boolean).join(", ") || "hôtel à préciser",
        nuitsLisibles({ dateArrivee: h.dateArrivee, dateDepart: h.dateDepart }),
        h.typeChambre ? `chambre ${h.typeChambre}` : null,
      ].filter(Boolean).join(" · "),
      dates: datesDe(arrivee, depart),
      empreinte: empreinteHotel({ nom: nomComplet(h), hotel: h.hotel, ville: h.ville, dateArrivee: arrivee, dateDepart: depart, typeChambre: h.typeChambre, notes: h.notes }),
      manques: manquesHebergement({ hotel: h.hotel, ville: h.ville, dateArrivee: arrivee, dateDepart: depart }),
      accorde: h.item.status === "APPROVED", refus: refusDuPoste(h.item.status),
      itemId: h.item.id, careBeneficiaryId: null, poste: h.item.label,
      budget: h.item.amountGranted != null ? toNumber(h.item.amountGranted) : null, fournisseur: h.item.supplier,
      operation: op, sujetId: h.item.reservationDossierId,
      pieces: { entityType: "AD_PRO_ITEM", entityId: h.item.id },
    });
  }

  for (const c of cellules) {
    const b = c.beneficiary;
    const type: EntityType = b.congressNationalId ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";
    const opId = b.congressNationalId ?? b.congressInternationalId;
    const op = opId ? ops.get(`${type}:${opId}`) : undefined;
    if (!op || !opId) continue;
    const scope: Perimetre = type === "CONGRESS_NATIONAL" ? "NATIONAL" : "INTERNATIONAL";
    const nom = beneficiaryName({ doctorId: b.doctorId, firstName: b.firstName, lastName: b.lastName, doctorName: b.doctorId ? nomsDocteurs.get(b.doctorId) ?? null : null });
    const row = versCellule(c);
    const passeport = personnePasseport(b.cells as unknown as CellRow[]);
    const billet = c.serviceKind === "TICKET";
    const trajet = c.trajet ?? "ALLER_RETOUR";
    out.set(cleFiche("CARE_CELL", c.id), {
      source: "CARE_CELL", id: c.id, nature: billet ? "BILLET" : "HOTEL", nom,
      resume: billet ? resumeBillet(row) : resumeHotel(row),
      dates: datesDe(row.dateStart, row.dateEnd, billet && trajet === "ALLER_SIMPLE"),
      empreinte: billet
        ? empreinteBillet({
            nom, trajet: TRAJET_LIBELLE[trajet], villeDepart: c.fromCity, villeArrivee: c.toCity, dateDepart: row.dateStart, dateRetour: row.dateEnd,
            etapes: trajet === "MULTI_DESTINATIONS" ? row.segments : [], transport: c.transport ? TRANSPORT_LIBELLE[c.transport] : null, notes: c.notes,
          })
        : empreinteHotel({ nom, hotel: c.hotelName, ville: c.city, dateArrivee: row.dateStart, dateDepart: row.dateEnd, typeChambre: c.roomType, notes: c.notes }),
      manques: c.status === "WAIVED"
        ? ["poste déclaré sans objet"]
        : billet ? manquesBillet(scope, nom, row, passeport) : manquesHotel(row),
      accorde: b.status === "APPROVED",
      refus: personneVivante(b.status) ? null : "Cette personne n'est plus prise en charge (écartée ou retirée) : on ne réserve rien pour elle.",
      itemId: null, careBeneficiaryId: b.id, poste: c.label, budget: null, fournisseur: null,
      operation: op, sujetId: op.sujetPriseEnCharge,
      pieces: { entityType: type, entityId: opId },
    });
  }
  return out;
}

/** Une case lue pour les règles des fiches — la forme de `care-fiches.ts` (dates AAAA-MM-JJ). */
function versCellule(c: CareCell): CellRow {
  return {
    id: c.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, notes: c.notes, status: c.status,
    amountDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null, amount: c.amount != null ? toNumber(c.amount) : null,
    currency: c.currency, expenseOrderId: c.expenseOrderId, promoMaterialId: c.promoMaterialId, documentId: c.documentId,
    promoMaterial: null, dateStart: iso(c.dateStart), dateEnd: iso(c.dateEnd), trajet: c.trajet, transport: c.transport,
    fromCity: c.fromCity, toCity: c.toCity, segments: etapesStockees(c.segments), hotelName: c.hotelName, city: c.city, roomType: c.roomType,
    issuedDocumentId: c.issuedDocumentId, bookingRef: c.bookingRef, legDetails: [], timeStart: c.timeStart, address: c.address,
  };
}

/** UNE fiche. */
export async function chargerFiche(source: SourceFiche, id: string): Promise<FicheReservation | null> {
  const m = await chargerFiches(
    source === "VOYAGEUR" ? { voyageurIds: [id] } : source === "HEBERGEMENT" ? { hebergementIds: [id] } : { careCellIds: [id] },
  );
  return m.get(cleFiche(source, id)) ?? null;
}

/** La source et l'identifiant de fiche d'une demande lue en base. */
export function ficheDeLaDemande(d: { voyageurId: string | null; hebergementId: string | null; careCellId: string | null }): { source: SourceFiche; id: string } | null {
  if (d.voyageurId) return { source: "VOYAGEUR", id: d.voyageurId };
  if (d.hebergementId) return { source: "HEBERGEMENT", id: d.hebergementId };
  if (d.careCellId) return { source: "CARE_CELL", id: d.careCellId };
  return null;
}

/** La colonne de la demande qui désigne cette fiche — pour `findUnique` / `create`. */
export function colonneFiche(source: SourceFiche, id: string): { voyageurId: string } | { hebergementId: string } | { careCellId: string } {
  return source === "VOYAGEUR" ? { voyageurId: id } : source === "HEBERGEMENT" ? { hebergementId: id } : { careCellId: id };
}
