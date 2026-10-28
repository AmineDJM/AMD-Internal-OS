/**
 * PRISE EN CHARGE — les CORPS des gestes de saisie : l'avis et la décision sur une personne, une pièce déposée, une case ajoutée, un poste de
 * la fiche enregistré, un billet émis, un poste de groupe modifié, un matériel rattaché.
 *
 * Sortis de `actions/care-actions.ts` (lot V4). Chaque action garde sa porte (session, droits, fiche) et passe
 * ensuite le FORMULAIRE à son corps : pour le contrat des actions, ce corps est celui du fichier d'actions
 * (`contrat/internes.ts`) — ses champs, ses écritures et ses écrivains importés comptent pour l'action.
 */
import { Prisma, type CareCellKind, type CareCellStatus, type CareOpinion, type CareServiceKind } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { defaultCells, OPINION_LABELS, SERVICE_KIND_LABELS } from "@/lib/care";
import { deposerFichiersSurLaPiece } from "@/lib/care-pieces-db";
import { phraseDepot } from "@/lib/care-pieces";
import {
  deviseDuPoste, etapesDuBillet, lireDetailsTrajets, libelleNouveauPoste, lirePosteSaisi, montantLisible, versDzd,
  type typePoste,
} from "@/lib/care-fiches";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { persistUploadedDocument } from "@/lib/documents";
import { noterModificationFiche } from "@/lib/reservation-fiche/serveur";
import {
  SPEC, loadRequest, nameOf, parentWhere, revalidate, tauxDe, type chargerPosteGroupe, type scopeOfBeneficiary,
} from "@/lib/actions/internes/care/demande";
import { versCellRow, type CELL_FICHE_SELECT } from "@/lib/actions/internes/care/fiches";
import { hotelDeLaPersonne, posteFusionne } from "@/lib/actions/internes/care/postes";
import { exclureOuReinclure } from "@/lib/actions/internes/care/demande-suite";
import { journaliser as audit } from "./journal";

/** La personne et le périmètre de sa demande, tels que l'action les a chargés et ouverts. */
type Trouvee = NonNullable<Awaited<ReturnType<typeof scopeOfBeneficiary>>>;
/** Un poste de la fiche, tel que l'action l'a chargé (`CELL_FICHE_SELECT` + sa personne). */
type PosteCharge = Prisma.CareCellGetPayload<{ select: typeof CELL_FICHE_SELECT & { beneficiaryId: true } }>;

/** `setCareOpinion`, après la porte : l'avis du demandeur sur cette personne, et sa note. */
export async function noterLAvis(formData: FormData, ctx: { user: SessionUser; id: string; found: Trouvee }): Promise<ActionResult> {
  const { user, id, found } = ctx;
  const opinion = (fdStr(formData, "opinion") ?? "NONE") as CareOpinion;
  if (!(opinion in OPINION_LABELS)) return { ok: false, error: "Avis inconnu." };

  await prisma.careBeneficiary.update({
    where: { id },
    data: { requesterOpinion: opinion, requesterNote: fdStr(formData, "note"), updatedById: user.id },
  });
  await audit(user, found.scope, found.requestId, "UPDATE",
    `Avis « ${OPINION_LABELS[opinion]} » porté sur ${await nameOf(found.beneficiary)}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id };
}

/** `deposerPiecePriseEnCharge`, après la porte : le lot de fichiers, déposé sur SA case. */
export async function deposerLesFichiers(
  formData: FormData,
  ctx: {
    user: SessionUser; cell: { id: string; label: string; status: CareCellStatus; documentId: string | null }; found: Trouvee;
    module: (typeof SPEC)[Trouvee["scope"]]["module"];
  },
): Promise<ActionResult> {
  const { user, cell, found, module } = ctx;
  const fichiers = formData.getAll("file").filter((v): v is File => v instanceof File);
  if (fichiers.length === 0) return { ok: false, error: "Aucun fichier sélectionné." };

  const r = await deposerFichiersSurLaPiece(user.id, cell, { entityType: module, entityId: found.requestId }, fichiers);
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${await nameOf(found.beneficiary)} — « ${cell.label} » reçue${r.ids.length > 1 ? ` (${r.ids.length} fichiers)` : ""}.`);
  revalidate(found.scope, found.requestId);
  const manques = r.echecs.length > 0 ? ` Non joint : ${r.echecs.join(" ")}` : "";
  return { ok: true, id: cell.id, message: `${phraseDepot(cell.label, r.ids.length)}${manques}` };
}

/** `decideCareBeneficiary`, après la porte : la décision, et la pièce d'identité d'une personne accordée. */
export async function trancherLaPersonne(
  formData: FormData, ctx: { user: SessionUser; id: string; decision: "APPROVED" | "REJECTED"; found: Trouvee },
): Promise<ActionResult> {
  const { user, id, decision, found } = ctx;
  const name = await nameOf(found.beneficiary);
  try {
    await prisma.careBeneficiary.update({
      where: { id },
      data: {
        status: decision, decidedById: user.id, decidedAt: new Date(),
        decisionNote: fdStr(formData, "note"), updatedById: user.id,
      },
    });

    if (decision === "APPROVED") {
      // Idempotent : re-accorder une personne ne recrée pas sa pièce d'identité en double. Seules les PIÈCES
      // comptent : la fiche naît avec sa billetterie et son hôtellerie, qui ne sont pas des pièces.
      const existing = await prisma.careCell.count({ where: { beneficiaryId: id, kind: "DOCUMENT" } });
      if (existing === 0) {
        await prisma.careCell.createMany({
          data: defaultCells(found.scope === "NATIONAL" ? "NATIONAL" : "INTERNATIONAL").map((c, i) => ({
            beneficiaryId: id, kind: c.kind, serviceKind: c.serviceKind, label: c.label,
            requestedById: user.id, position: i + 1,
          })),
        });
      }
    }

    await audit(user, found.scope, found.requestId, "UPDATE",
      `${name} : ${decision === "APPROVED" ? "prise en charge ACCORDÉE" : "prise en charge ÉCARTÉE"}${fdStr(formData, "note") ? ` — ${fdStr(formData, "note")}` : ""}.`);
    revalidate(found.scope, found.requestId);
    return { ok: true, id };
  } catch (err) {
    console.error("[care] décision impossible", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/** `addCareCell`, après la porte : la nature de la case, son libellé, l'hôtel prérempli, l'écriture. */
export async function ajouterLaCase(
  formData: FormData,
  c: { user: SessionUser; beneficiaryId: string; type: ReturnType<typeof typePoste>; found: Trouvee },
): Promise<ActionResult> {
  const { user, beneficiaryId, type, found } = c;
  const kind = (type ? "SERVICE" : fdStr(formData, "kind") ?? "DOCUMENT") as CareCellKind;
  if (kind !== "DOCUMENT" && kind !== "SERVICE") return { ok: false, error: "Nature inconnue." };
  const serviceKind = type ? type.serviceKind : kind === "SERVICE" ? ((fdStr(formData, "serviceKind") ?? "OTHER") as CareServiceKind) : null;
  if (serviceKind && !(serviceKind in SERVICE_KIND_LABELS)) return { ok: false, error: "Nature de prestation inconnue." };
  const memeNature = serviceKind ? await prisma.careCell.count({ where: { beneficiaryId, kind: "SERVICE", serviceKind } }) : 0;
  const label = fdStr(formData, "label") ?? (type ? libelleNouveauPoste(type, memeNature) : null);
  if (!label) return { ok: false, error: "Le libellé est obligatoire." };

  // UN HÔTEL AJOUTÉ prend la ville de l'événement et les dates du billet principal (propositions, corrigeables).
  let prerempli: { city: string | null; dateStart: Date | null; dateEnd: Date | null } = { city: null, dateStart: null, dateEnd: null };
  if (serviceKind === "HOTEL") prerempli = await hotelDeLaPersonne(found.scope, found.requestId, beneficiaryId);

  try {
    const last = await prisma.careCell.findFirst({ where: { beneficiaryId }, orderBy: { position: "desc" }, select: { position: true } });
    const created = await prisma.careCell.create({
      data: {
        beneficiaryId, kind, serviceKind, label,
        notes: fdStr(formData, "notes"),
        requestedById: user.id,
        position: (last?.position ?? 0) + 1,
        ...(serviceKind ? { currency: deviseDuPoste(found.scope, serviceKind) } : {}),
        ...prerempli,
      },
      select: { id: true },
    });
    await audit(user, found.scope, found.requestId, "CREATE",
      `${await nameOf(found.beneficiary)} — élément demandé : ${label}${serviceKind ? ` (${SERVICE_KIND_LABELS[serviceKind]})` : ""}.`);
    revalidate(found.scope, found.requestId);
    return { ok: true, id: created.id };
  } catch (err) {
    console.error("[care] ajout de case impossible", err);
    return { ok: false, error: "L'élément n'a pas pu être ajouté." };
  }
}

/** `modifierPosteFiche`, après la porte : la saisie fusionnée à l'existant, relue, puis écrite. */
export async function enregistrerLePoste(
  formData: FormData, c: { user: SessionUser; id: string; cell: PosteCharge & { serviceKind: CareServiceKind }; found: Trouvee },
): Promise<ActionResult> {
  const { user, id, cell, found } = c;
  const nom = await nameOf(found.beneficiary);
  const avant = versCellRow(cell);
  // Un champ ABSENT du formulaire garde sa valeur : on ne vide jamais en silence ce que l'écran n'a pas montré.
  // (Noms de champs ÉCRITS EN CLAIR : le contrat des actions les lit dans la source.)
  const envoye = {
    label: formData.has("label") ? String(formData.get("label") ?? "") : undefined,
    notes: formData.has("notes") ? String(formData.get("notes") ?? "") : undefined,
    dateStart: formData.has("dateStart") ? String(formData.get("dateStart") ?? "") : undefined,
    dateEnd: formData.has("dateEnd") ? String(formData.get("dateEnd") ?? "") : undefined,
    trajet: formData.has("trajet") ? String(formData.get("trajet") ?? "") : undefined,
    transport: formData.has("transport") ? String(formData.get("transport") ?? "") : undefined,
    fromCity: formData.has("fromCity") ? String(formData.get("fromCity") ?? "") : undefined,
    toCity: formData.has("toCity") ? String(formData.get("toCity") ?? "") : undefined,
    segments: formData.has("segments") ? String(formData.get("segments") ?? "") : undefined,
    hotelName: formData.has("hotelName") ? String(formData.get("hotelName") ?? "") : undefined,
    city: formData.has("city") ? String(formData.get("city") ?? "") : undefined,
    roomType: formData.has("roomType") ? String(formData.get("roomType") ?? "") : undefined,
    timeStart: formData.has("timeStart") ? String(formData.get("timeStart") ?? "") : undefined,
    address: formData.has("address") ? String(formData.get("address") ?? "") : undefined,
    amount: formData.has("amount") ? String(formData.get("amount") ?? "") : undefined,
  };
  const lu = lirePosteSaisi(cell.serviceKind, nom, posteFusionne(envoye, avant));
  if (!lu.ok) return { ok: false, error: lu.error };
  const p = lu.poste;

  const req = await loadRequest(found.scope, found.requestId);
  const devise = deviseDuPoste(found.scope, cell.serviceKind);
  const amountDzd = versDzd(p.amount, devise, tauxDe(found.scope, req));
  // LE MONTANT NE S'ÉCRIT QUE S'IL EST ENVOYÉ : un montant d'avant (en DZD, sans montant saisi) reste tel quel.
  const ancien = avant.amount ?? (avant.currency === devise ? avant.amountDzd : null);
  const montantEnvoye = envoye.amount !== undefined && (p.amount ?? null) !== (ancien ?? null);
  if (cell.expenseOrderId && montantEnvoye) {
    return { ok: false, error: "Une dépense a été engagée sur ce poste : son montant ne change plus d'ici." };
  }

  await prisma.careCell.update({
    where: { id },
    data: {
      label: p.label ?? cell.label, notes: p.notes,
      dateStart: p.dateStart, dateEnd: p.dateEnd,
      trajet: p.trajet, transport: p.transport, fromCity: p.fromCity, toCity: p.toCity,
      segments: p.segments && p.segments.length ? (p.segments as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      hotelName: p.hotelName, city: p.city, roomType: p.roomType, timeStart: p.timeStart, address: p.address,
      ...(montantEnvoye ? { amount: p.amount, currency: devise, amountDzd } : {}),
    },
  });
  // LA FICHE CHEZ L'ASSISTANTE (14/10) : un billet / un hôtel modifié après l'envoi passe « à renvoyer ».
  if (cell.serviceKind === "TICKET" || cell.serviceKind === "HOTEL") await noterModificationFiche("CARE_CELL", id, user.id);
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${nom} — poste « ${p.label ?? cell.label} » enregistré${montantEnvoye && p.amount != null ? ` (${montantLisible(p.amount, devise)}${devise === "USD" && amountDzd != null ? ` = ${montantLisible(amountDzd)}` : ""})` : ""}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id, message: "Poste enregistré." };
}

/** `enregistrerBilletEmis`, après la porte : les trajets, la référence, le fichier, puis l'écriture. */
export async function enregistrerLeBillet(
  formData: FormData, c: { user: SessionUser; id: string; cell: PosteCharge; found: Trouvee },
): Promise<ActionResult> {
  const { user, id, cell, found } = c;
  const billet = cell.serviceKind === "TICKET";
  const avant = versCellRow(cell);
  let legDetails: Prisma.InputJsonValue | undefined;
  if (billet && formData.has("legDetails")) {
    const lus = lireDetailsTrajets(fdStr(formData, "legDetails") ?? "", etapesDuBillet(avant).length);
    if (!lus.ok) return { ok: false, error: lus.error };
    legDetails = lus.details as unknown as Prisma.InputJsonValue;
  }
  const bookingRef = formData.has("bookingRef") ? (fdStr(formData, "bookingRef")?.slice(0, 60) ?? null) : undefined;

  const fichier = formData.get("file");
  let issuedDocumentId: string | undefined;
  if (fichier instanceof File && fichier.size > 0) {
    const r = await persistUploadedDocument(user.id, {
      entityType: SPEC[found.scope].module, entityId: found.requestId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: cell.id, file: fichier,
    });
    if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le fichier n'a pas pu être enregistré." };
    issuedDocumentId = r.documentId;
  }
  if (legDetails === undefined && bookingRef === undefined && issuedDocumentId === undefined) return { ok: false, error: "Rien à enregistrer." };

  await prisma.careCell.update({
    where: { id },
    data: {
      ...(legDetails !== undefined ? { legDetails } : {}),
      ...(bookingRef !== undefined ? { bookingRef } : {}),
      ...(issuedDocumentId ? { issuedDocumentId } : {}),
    },
  });
  const nom = await nameOf(found.beneficiary);
  const quoi = billet ? "billet émis" : "confirmation d'hôtel";
  await audit(user, found.scope, found.requestId, "UPDATE", `${nom} — ${quoi}${issuedDocumentId ? " déposé" : " mis à jour"}${bookingRef ? ` (réf. ${bookingRef})` : ""}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id, message: billet ? "Billet émis enregistré." : "Confirmation d'hôtel enregistrée." };
}

/** `modifierPosteGroupe`, après la porte : exclure / réinclure une personne, ou réécrire le poste. */
export async function modifierLePosteDeGroupe(
  formData: FormData, c: { user: SessionUser; id: string; found: NonNullable<Awaited<ReturnType<typeof chargerPosteGroupe>>> },
): Promise<ActionResult> {
  const { user, id } = c;
  const { g, scope, requestId } = c.found;
  const exclure = fdStr(formData, "exclure");
  const inclure = fdStr(formData, "inclure");
  if (exclure || inclure) {
    const qui = (exclure ?? inclure)!;
    const appartient = await prisma.careBeneficiary.count({ where: { id: qui, ...parentWhere(scope, requestId) } });
    if (!appartient) return { ok: false, error: "Personne introuvable sur cette demande." };
    await exclureOuReinclure(g, qui, Boolean(exclure), user.id);
    await audit(user, scope, requestId, "UPDATE", `Poste de groupe « ${g.label} » : une personne ${exclure ? "exclue" : "réincluse"}.`);
    revalidate(scope, requestId);
    return { ok: true, id, message: exclure ? "Personne exclue de ce poste." : "Personne réincluse dans ce poste." };
  }

  const req = await loadRequest(scope, requestId);
  const lu = lirePosteSaisi("OTHER", req?.name ?? "", {
    label: formData.has("label") ? fdStr(formData, "label") : g.label,
    notes: formData.has("notes") ? fdStr(formData, "notes") : g.notes,
    dateStart: formData.has("date") ? fdStr(formData, "date") : (g.date ? g.date.toISOString().slice(0, 10) : null),
    amount: formData.has("unitAmount") ? fdStr(formData, "unitAmount") : (g.unitAmount != null ? String(toNumber(g.unitAmount)) : null),
    timeStart: formData.has("timeStart") ? fdStr(formData, "timeStart") : g.timeStart,
    address: formData.has("address") ? fdStr(formData, "address") : g.address,
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const status = fdStr(formData, "status") as CareCellStatus | null;
  if (status && !["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"].includes(status)) return { ok: false, error: "État inconnu." };
  const devise = deviseDuPoste(scope, g.serviceKind);
  await prisma.careGroupPoste.update({
    where: { id },
    data: {
      label: lu.poste.label ?? g.label, notes: lu.poste.notes, date: lu.poste.dateStart,
      timeStart: lu.poste.timeStart, address: lu.poste.address,
      unitAmount: lu.poste.amount, currency: devise, unitAmountDzd: versDzd(lu.poste.amount, devise, tauxDe(scope, req)),
      ...(status ? { status } : {}), updatedById: user.id,
    },
  });
  await audit(user, scope, requestId, "UPDATE", `Poste de groupe « ${lu.poste.label ?? g.label} » modifié.`);
  revalidate(scope, requestId);
  return { ok: true, id, message: "Poste de groupe enregistré." };
}

/** `linkCareCellPromoMaterial`, après la porte : rattacher le matériel désigné, ou détacher. */
export async function rattacherLeMateriel(
  formData: FormData, c: { user: SessionUser; id: string; cell: { label: string }; found: Trouvee },
): Promise<ActionResult> {
  const { user, id, cell, found } = c;
  const promoMaterialId = fdStr(formData, "promoMaterialId");
  if (promoMaterialId) {
    const pm = await prisma.promoMaterial.findUnique({ where: { id: promoMaterialId }, select: { reference: true } });
    if (!pm) return { ok: false, error: "Matériel promotionnel introuvable." };
    await prisma.careCell.update({
      where: { id },
      data: { promoMaterialId, kind: "SERVICE", serviceKind: "PROMO_MATERIAL" },
    });
    await audit(user, found.scope, found.requestId, "UPDATE",
      `${await nameOf(found.beneficiary)} — « ${cell.label} » rattaché au matériel ${pm.reference}.`);
  } else {
    await prisma.careCell.update({ where: { id }, data: { promoMaterialId: null } });
    await audit(user, found.scope, found.requestId, "UPDATE",
      `${await nameOf(found.beneficiary)} — « ${cell.label} » détaché de son matériel promotionnel.`);
  }

  revalidate(found.scope, found.requestId);
  return { ok: true, id };
}
