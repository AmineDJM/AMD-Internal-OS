/**
 * PRISE EN CHARGE — les POSTES et les PIÈCES de chaque personne, lus par les actions : le fichier d'une pièce et sa
 * case, l'hôtel pré-rempli d'après le billet, le poste saisi fusionné avec l'existant, et les listes des sélecteurs
 * (annuaire, matériels promotionnels).
 *
 * Sorti de `actions/care-actions.ts` (lot V4) : lectures et règles, aucune écriture.
 */
import { prisma } from "@/lib/prisma";
import { hotelPrerempli, type CellRow } from "@/lib/care-fiches";
import { loadRequest, type Scope } from "./demande";
import { CELL_FICHE_SELECT, versCellRow } from "./fiches";

/** Le fichier, et la pièce de prise en charge qu'il désigne (par son lien, ou par sa case `stepKey`). */
export async function fichierEtSaPiece(documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, name: true, entityType: true, entityId: true, stepKey: true } });
  if (!doc) return { ok: false as const, error: "Fichier introuvable." };
  const cell = await prisma.careCell.findFirst({
    where: { kind: "DOCUMENT", OR: [{ documentId: doc.id }, ...(doc.stepKey ? [{ id: doc.stepKey }] : [])] },
    select: { id: true, label: true, status: true, documentId: true, beneficiaryId: true },
  });
  if (!cell) return { ok: false as const, error: "Ce fichier n'est pas celui d'une pièce de prise en charge." };
  return { ok: true as const, doc, cell };
}

/** UN HÔTEL AJOUTÉ prend la ville de l'événement et les dates du billet principal (propositions, corrigeables). */
export async function hotelDeLaPersonne(
  scope: Scope, requestId: string, beneficiaryId: string,
): Promise<{ city: string | null; dateStart: Date | null; dateEnd: Date | null }> {
  const req = await loadRequest(scope, requestId);
  const billet = await prisma.careCell.findFirst({ where: { beneficiaryId, kind: "SERVICE", serviceKind: "TICKET" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: CELL_FICHE_SELECT });
  const p = hotelPrerempli({ city: req?.city ?? null }, billet ? versCellRow(billet) : null);
  const d = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
  return { city: p.city, dateStart: d(p.dateStart), dateEnd: d(p.dateEnd) };
}

/** Ce que le formulaire envoie d'un poste (un champ ABSENT vaut `undefined`). */
type PosteEnvoye = Partial<Record<
  "label" | "notes" | "dateStart" | "dateEnd" | "trajet" | "transport" | "fromCity" | "toCity" | "segments" | "hotelName"
  | "city" | "roomType" | "timeStart" | "address" | "amount", string
>>;

/** Le poste à relire : ce qui est envoyé l'emporte, un champ absent garde sa valeur d'avant. */
export function posteFusionne(envoye: PosteEnvoye, avant: CellRow) {
  return {
    label: envoye.label ?? avant.label, notes: envoye.notes ?? avant.notes ?? "",
    dateStart: envoye.dateStart ?? avant.dateStart ?? "", dateEnd: envoye.dateEnd ?? avant.dateEnd ?? "",
    trajet: envoye.trajet ?? avant.trajet ?? "", transport: envoye.transport ?? avant.transport ?? "",
    fromCity: envoye.fromCity ?? avant.fromCity ?? "", toCity: envoye.toCity ?? avant.toCity ?? "",
    segments: envoye.segments ?? JSON.stringify(avant.segments),
    hotelName: envoye.hotelName ?? avant.hotelName ?? "", city: envoye.city ?? avant.city ?? "", roomType: envoye.roomType ?? avant.roomType ?? "",
    timeStart: envoye.timeStart ?? avant.timeStart ?? "", address: envoye.address ?? avant.address ?? "",
    amount: envoye.amount ?? "",
  };
}

/** L'annuaire, pour le sélecteur de personnes. */
export async function praticiensDeLAnnuaire(): Promise<{ id: string; name: string; specialty: string | null; institution: string | null }[]> {
  const rows = await prisma.medicalDoctor.findMany({
    // 2 000 comme le sélecteur d'avant (`listBeneficiaryRefs`) : à 500, la recherche taisait le
    // cinq-cent-unième praticien, et « introuvable » se lisait « absent de l'annuaire » (§118.60).
    orderBy: { name: "asc" }, take: 2000,
    select: { id: true, name: true, specialty: true, institution: true },
  });
  return rows;
}

/** Les matériels promotionnels rattachables — pour le sélecteur. */
export async function materielsRattachables(): Promise<{ id: string; reference: string; title: string }[]> {
  const rows = await prisma.promoMaterial.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" }, take: 60,
    select: { id: true, reference: true, title: true },
  });
  return rows;
}
