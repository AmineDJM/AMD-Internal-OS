"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type CareCellStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { beneficiaryName, piecesADemander, deviseDuPoste, etapesDuBillet, lireDetailsTrajets, peutTeleverserBillet, lirePosteSaisi, montantLisible, typePoste, versDzd, phraseDepot } from "@/modules/ad-pro/partage";
import { deposerFichiersSurLaPiece, retirerFichierDeLaPiece, refusEngagementPriseEnCharge, refusSiPorteDgFermee, signalerPorteDgSiBesoin } from "@/modules/ad-pro/api";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { persistUploadedDocument } from "@/lib/documents";
import { noterModificationFiche } from "@/lib/reservation-fiche/serveur";
import { sansBloquer } from "@/lib/journal";
import { type Scope, SPEC, isScope, revalidate, canEdit, audit, loadRequest, tauxDe, CELL_FICHE_SELECT, versCellRow, ecrireAAssistante, parentWhere, scopeOfBeneficiary, nameOf, rolesDe } from "./infra/prise-en-charge/actions-commun";

/**
 * PRISE EN CHARGE — LA LOGISTIQUE : les pièces de chaque professionnel, la fiche d'un poste et le billet émis,
 * le devis retenu par l'assistante, la réservation et le BC par l'assistante de direction, les postes de groupe,
 * et les listes des sélecteurs (annuaire, matériel promotionnel).
 * Morceau de la clé `care-actions` (voir `actions-prise-en-charge.ts`).
 */

// ───────────────────────────── Les pièces de chaque professionnel ─────────────────────────────

/**
 * DEMANDER LES PIÈCES — ce que le bloc « Personnes prises en charge » faisait d'un seul bouton, mais
 * PAR PERSONNE et SUIVI : chaque professionnel proposé ou accordé reçoit une case par pièce attendue
 * (national : passeport ; international : passeport, visa, informations de voyage — `piecesAttendues`),
 * et le demandeur est prévenu. Une pièce déjà demandée, reçue ou déclarée sans objet n'est jamais
 * redemandée ; un professionnel écarté ou retiré ne reçoit rien.
 *
 * Deux clics simultanés ne doublent rien : le calcul et l'écriture se font sous un verrou consultatif
 * propre à la demande, et le second relit les cases que le premier vient d'écrire.
 */
export async function demanderPiecesPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  if (!isScope(scopeRaw)) return { ok: false, error: "Périmètre inconnu." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande non précisée." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const bilan = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('care-pieces'), hashtext(${requestId}))`;
    const personnes = await tx.careBeneficiary.findMany({
      where: { ...parentWhere(scopeRaw, requestId), status: { in: ["PROPOSED", "APPROVED"] } },
      select: { id: true, cells: { select: { kind: true, label: true, position: true } } },
    });
    let cases = 0;
    let concernees = 0;
    for (const p of personnes) {
      const manquent = piecesADemander(scopeRaw, p.cells);
      if (manquent.length === 0) continue;
      concernees += 1;
      const pos = p.cells.reduce((m, c) => Math.max(m, c.position), 0);
      await tx.careCell.createMany({
        data: manquent.map((m, i) => ({
          beneficiaryId: p.id, kind: "DOCUMENT" as const, serviceKind: null, label: m.label,
          requestedById: user.id, position: pos + i + 1,
        })),
      });
      cases += manquent.length;
    }
    return { cases, concernees, personnes: personnes.length };
  });

  if (bilan.personnes === 0) return { ok: false, error: "Aucun professionnel proposé : ajoutez d'abord les personnes à prendre en charge." };
  if (bilan.cases === 0) return { ok: true, message: "Rien à demander : toutes les pièces attendues sont déjà demandées, reçues ou sans objet." };

  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({
      userId: req.requesterId, type: "ASSIGNMENT", title: "Pièces demandées — prise en charge",
      body: `${req.name} — ${bilan.cases} pièce(s) à joindre pour ${bilan.concernees} professionnel(s).`,
      link: `${SPEC[scopeRaw].path}/${requestId}`,
    }).catch(sansBloquer("care-actions.demanderPiecesPriseEnCharge.notifyUser"));
  }
  await audit(user, scopeRaw, requestId, "UPDATE", `Pièces demandées : ${bilan.cases} pour ${bilan.concernees} professionnel(s).`);
  revalidate(scopeRaw, requestId);
  return { ok: true, message: `${bilan.cases} pièce(s) demandée(s) pour ${bilan.concernees} professionnel(s).` };
}

/**
 * DÉPOSER LA PIÈCE D'UN PROFESSIONNEL — le fichier rejoint les documents de la demande (catégorie
 * « pièce d'identité », rattaché à SA case par `stepKey`), et la case passe « reçue ». Le téléverseur
 * générique d'avant déposait les pièces en vrac : « Pièces d'identité reçues 2/5 » ne disait ni
 * lesquelles ni de qui.
 *
 * Une pièce déjà VALIDÉE ou déclarée SANS OBJET ne se remplace pas d'ici : l'état se rouvre d'abord
 * depuis la case. L'écriture de l'état est conditionnelle ; perdue, le fichier déposé est retiré.
 *
 * PLUSIEURS FICHIERS (Direction, 10/2026) : recto, verso, pages, visa — `file` peut se répéter, en un
 * geste ou en plusieurs ; chaque fichier s'ajoute aux autres (`lib/care-pieces`). Le lot est contrôlé
 * entier AVANT d'écrire (limites des réglages).
 */
export async function deposerPiecePriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cellId = fdStr(formData, "cellId");
  if (!cellId) return { ok: false, error: "Pièce non précisée." };
  const cell = await prisma.careCell.findUnique({ where: { id: cellId }, select: { id: true, kind: true, label: true, status: true, beneficiaryId: true, documentId: true } });
  if (!cell || cell.kind !== "DOCUMENT") return { ok: false, error: "Pièce introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const module = SPEC[found.scope].module;
  if (!(await canAccessEntity(user, module, found.requestId, "UPLOAD"))) return { ok: false, error: "Vous n'êtes pas autorisé à déposer une pièce sur cette demande." };
  if (cell.status === "SETTLED") return { ok: false, error: `« ${cell.label} » est déjà validée : rouvrez son état avant d'en déposer une autre.` };
  if (cell.status === "WAIVED") return { ok: false, error: `« ${cell.label} » est déclarée sans objet : rouvrez son état avant de la déposer.` };
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

/**
 * RETIRER UN FICHIER D'UNE PIÈCE (Direction, 10/2026) — la page en trop, le scan illisible. Le dernier
 * retiré, la pièce redevient attendue : « passeport manquant » revient, sans qu'on le déclare.
 *
 * Signature `(id, path?)` : celle que l'aperçu des documents (`DocumentPreview.supprimer`) appelle — son
 * bouton, sa confirmation et son rafraîchissement sont ceux de tous les documents. Le fichier doit être
 * celui d'une pièce de CETTE demande (la case désignée par le fichier, sur l'entité de la demande) ; la
 * porte est celle du dépôt. Une pièce validée ou sans objet ne se touche pas d'ici.
 */
export async function retirerFichierPiecePriseEnCharge(documentId: string, _path?: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!documentId) return { ok: false, error: "Fichier non précisé." };
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, name: true, entityType: true, entityId: true, stepKey: true } });
  if (!doc) return { ok: false, error: "Fichier introuvable." };
  const cell = await prisma.careCell.findFirst({
    where: { kind: "DOCUMENT", OR: [{ documentId: doc.id }, ...(doc.stepKey ? [{ id: doc.stepKey }] : [])] },
    select: { id: true, label: true, status: true, documentId: true, beneficiaryId: true },
  });
  if (!cell) return { ok: false, error: "Ce fichier n'est pas celui d'une pièce de prise en charge." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const module = SPEC[found.scope].module;
  if (doc.entityType !== module || doc.entityId !== found.requestId) return { ok: false, error: "Ce fichier n'appartient pas à cette demande." };
  if (!(await canAccessEntity(user, module, found.requestId, "UPLOAD"))) return { ok: false, error: "Vous n'êtes pas autorisé à retirer une pièce de cette demande." };
  if (cell.status === "SETTLED") return { ok: false, error: `« ${cell.label} » est validée : rouvrez son état avant d'en retirer un fichier.` };
  if (cell.status === "WAIVED") return { ok: false, error: `« ${cell.label} » est déclarée sans objet : rouvrez son état avant d'en retirer un fichier.` };

  const r = await retirerFichierDeLaPiece(cell, doc.id, { entityType: module, entityId: found.requestId });
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${await nameOf(found.beneficiary)} — « ${cell.label} » : fichier « ${doc.name} » retiré${r.restants === 0 ? " — pièce de nouveau attendue" : ""}.`);
  revalidate(found.scope, found.requestId);
  return {
    ok: true, id: cell.id,
    message: r.restants === 0 ? `${cell.label} : plus aucun fichier, la pièce est de nouveau attendue.` : `Fichier retiré (${r.restants} restant${r.restants > 1 ? "s" : ""}).`,
  };
}

/**
 * ENREGISTRER UN POSTE DE LA FICHE — le billet (trajet, étapes, mode, dates), l'hôtel (hôtel, ville, dates,
 * chambre), ou un autre poste (détail, date) ; et son montant, dans la devise du poste : le dollar à
 * l'international sauf pour la billetterie (`deviseDuPoste`), converti au taux FIGÉ de la demande.
 *
 * Les règles de lecture sont celles du sponsoring (`lirePosteSaisi` → `lireVoyageur` / `lireHebergement`) :
 * un retour avant l'aller, un départ d'hôtel avant l'arrivée se refusent en le disant. Un poste dont la
 * dépense est engagée garde son montant : la dépense, elle, a eu lieu.
 */
export async function modifierPosteFiche(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const cell = await prisma.careCell.findUnique({ where: { id }, select: { ...CELL_FICHE_SELECT, beneficiaryId: true } });
  if (!cell || cell.kind !== "SERVICE" || !cell.serviceKind) return { ok: false, error: "Poste introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

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
  const lu = lirePosteSaisi(cell.serviceKind, nom, {
    label: envoye.label ?? avant.label, notes: envoye.notes ?? avant.notes ?? "",
    dateStart: envoye.dateStart ?? avant.dateStart ?? "", dateEnd: envoye.dateEnd ?? avant.dateEnd ?? "",
    trajet: envoye.trajet ?? avant.trajet ?? "", transport: envoye.transport ?? avant.transport ?? "",
    fromCity: envoye.fromCity ?? avant.fromCity ?? "", toCity: envoye.toCity ?? avant.toCity ?? "",
    segments: envoye.segments ?? JSON.stringify(avant.segments),
    hotelName: envoye.hotelName ?? avant.hotelName ?? "", city: envoye.city ?? avant.city ?? "", roomType: envoye.roomType ?? avant.roomType ?? "",
    timeStart: envoye.timeStart ?? avant.timeStart ?? "", address: envoye.address ?? avant.address ?? "",
    amount: envoye.amount ?? "",
  });
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

/**
 * LE BILLET ÉMIS / LA CONFIRMATION D'HÔTEL (Direction, 10/2026) — sur le billet : l'e-billet (PDF), la
 * référence de réservation (PNR) et, pour CHAQUE trajet (aller, retour, ou chaque étape), le n° de vol / train
 * et les heures ; sur l'hôtel : le voucher et le n° de confirmation. C'est ce que lira le livret de séjour.
 *
 * Ouvert à l'assistante de direction (qui réserve), au demandeur, à la Direction Marketing, au Super Admin et
 * à la Direction (`peutTeleverserBillet`). Le fichier rejoint les documents de la demande (`stepKey` = la case) ;
 * un nouveau fichier remplace le lien, l'ancien reste dans les documents (rien ne s'efface en silence).
 */
export async function enregistrerBilletEmis(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const cell = await prisma.careCell.findUnique({ where: { id }, select: { ...CELL_FICHE_SELECT, beneficiaryId: true } });
  if (!cell || cell.kind !== "SERVICE" || (cell.serviceKind !== "TICKET" && cell.serviceKind !== "HOTEL")) {
    return { ok: false, error: "Seuls un billet ou un hôtel portent un billet émis ou une confirmation." };
  }
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const req = await loadRequest(found.scope, found.requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!peutTeleverserBillet({ id: user.id, roles: rolesDe(user), vueGlobale: hasGlobalView(user) }, { requesterId: req.requesterId })) {
    return { ok: false, error: "Le billet émis se dépose par l'assistante de direction, le demandeur, la Direction Marketing ou le Super Admin." };
  }
  // LA DIRECTION MARKETING, PAR SA FICHE : elle dépose sur les demandes qu'elle voit — pas sur un identifiant deviné.
  // L'assistante de direction réserve pour TOUTES les demandes (elle n'a pas le module : sa porte est son rôle).
  const sansFiche = hasRole(user, "DIRECTION_ASSISTANT") || hasRole(user, "SUPER_ADMIN") || hasGlobalView(user) || req.requesterId === user.id;
  if (!sansFiche && !(await canAccessEntity(user, SPEC[found.scope].module, found.requestId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  if (cell.status === "WAIVED") return { ok: false, error: "Ce poste est déclaré sans objet : rouvrez-le avant d'y joindre un billet." };

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

/**
 * RETENIR UNE PROPOSITION — comme au sponsoring : le demandeur choisit le devis qui convient parmi ceux
 * reçus ; un autre devis retenu qui couvre les mêmes postes cesse de l'être (au plus une proposition retenue
 * par poste). Une fois le BC demandé, le choix ne change plus d'ici. `annuler` retire le choix.
 */
export async function retenirDevisPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Devis non précisé." };
  const quote = await prisma.careQuote.findUnique({
    where: { id },
    select: { id: true, supplier: true, status: true, retainedAt: true, bcRequestedAt: true, congressNationalId: true, congressInternationalId: true, cells: { select: { cellId: true } } },
  });
  if (!quote) return { ok: false, error: "Devis introuvable." };
  const scope: Scope = quote.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = quote.congressNationalId ?? quote.congressInternationalId;
  if (!requestId) return { ok: false, error: "Devis orphelin." };
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  if (quote.status !== "PENDING") return { ok: false, error: "Ce devis est déjà tranché par la Direction : son choix ne change plus." };
  if (quote.bcRequestedAt) return { ok: false, error: "Le BC de ce devis est déjà demandé : le choix ne change plus d'ici." };
  const annuler = fdStr(formData, "annuler") === "on";

  if (annuler) {
    await prisma.careQuote.updateMany({ where: { id, bcRequestedAt: null }, data: { retainedAt: null, retainedById: null } });
    await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} : n'est plus la proposition retenue.`);
    revalidate(scope, requestId);
    return { ok: true, id, message: "Le devis n'est plus retenu." };
  }

  const cellIds = quote.cells.map((c) => c.cellId);
  const rivaux = await prisma.careQuote.findMany({
    where: { ...parentWhere(scope, requestId), id: { not: id }, status: "PENDING", retainedAt: { not: null }, cells: { some: { cellId: { in: cellIds } } } },
    select: { id: true, supplier: true, bcRequestedAt: true },
  });
  const engage = rivaux.find((r) => r.bcRequestedAt);
  if (engage) return { ok: false, error: `Le devis ${engage.supplier}, déjà retenu pour ces postes, a son BC demandé : il reste le choix.` };
  await prisma.$transaction([
    prisma.careQuote.updateMany({ where: { id: { in: rivaux.map((r) => r.id) }, bcRequestedAt: null }, data: { retainedAt: null, retainedById: null } }),
    prisma.careQuote.update({ where: { id }, data: { retainedAt: new Date(), retainedById: user.id } }),
  ]);
  await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} RETENU${rivaux.length ? ` (à la place de ${rivaux.map((r) => r.supplier).join(", ")})` : ""}.`);
  await signalerPorteDgSiBesoin(SPEC[scope].module, requestId);
  revalidate(scope, requestId);
  return { ok: true, id, message: `Devis ${quote.supplier} retenu${rivaux.length ? " — l'autre proposition est écartée" : ""}. Demandez le BC quand tout est prêt.` };
}

/** L'annuaire, pour le sélecteur de personnes. */
export async function careDirectoryOptions(): Promise<{ id: string; name: string; specialty: string | null; institution: string | null }[]> {
  await requireUser();
  const rows = await prisma.medicalDoctor.findMany({
    // 2 000 comme le sélecteur d'avant (`listBeneficiaryRefs`) : à 500, la recherche taisait le
    // cinq-cent-unième praticien, et « introuvable » se lisait « absent de l'annuaire » (§118.60).
    orderBy: { name: "asc" }, take: 2000,
    select: { id: true, name: true, specialty: true, institution: true },
  });
  return rows;
}

// ───────────────────────────── Réservation et BC — l'assistante de direction ─────────────────────────────

/** Les personnes d'une demande, avec leurs cases lues pour les règles des fiches. */
async function fichesDeLaDemande(scope: Scope, requestId: string) {
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

/**
 * DEMANDER LA RÉSERVATION EN BLOC — FERMÉ (Direction, 27/10). La réservation d'une prise en charge se fait FICHE
 * PAR FICHE (`DemandeReservation`, `reservation-fiche-actions.ts`) : chaque billet ou hôtel part seul et a son état.
 * Ce geste n'écrit plus rien et le dit ; les envois en bloc déjà faits ont été repris en fiches (migration
 * `20270131120000_reservation_par_fiche_seule`).
 */
export async function demanderReservationPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  return {
    ok: false,
    error: "La réservation se demande désormais fiche par fiche : envoyez chaque billet ou hôtel à l'assistante depuis la fiche voyageur (« Envoyer », ou « Envoyer les fiches prêtes »).",
  };
}

/**
 * DEMANDER LE BC — d'après les devis RETENUS (comme `demanderBCBilletterie`) : la liste part dans le sujet de
 * l'assistante de direction, chaque devis est marqué « BC demandé » (son choix ne change plus), et la Direction
 * est prévenue qu'il reste à l'accepter — c'est l'acceptation qui émet l'ordre de dépense, en DZD.
 * `quoteIds` restreint la demande (le BC d'une fiche) ; sans lui, tous les devis retenus en attente partent.
 */
export async function demanderBCPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const voulus = formData.getAll("quoteIds").map(String).filter(Boolean);
  const retenus = await prisma.careQuote.findMany({
    where: { ...parentWhere(scopeRaw, requestId), status: "PENDING", retainedAt: { not: null }, bcRequestedAt: null, ...(voulus.length ? { id: { in: voulus } } : {}) },
    select: { id: true, supplier: true, reference: true, amount: true, currency: true, amountDzd: true, cells: { select: { cellId: true, cell: { select: { label: true, beneficiaryId: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  if (retenus.length === 0) return { ok: false, error: "Retenez d'abord un devis : le bon de commande s'établit d'après les propositions retenues." };
  // Pas de BC avant la prévalidation de la demande ni l'accord de chaque personne couverte (27/10/2026).
  const refusEngagement = await refusEngagementPriseEnCharge(scopeRaw, requestId, retenus.flatMap((q) => q.cells.map((c) => c.cellId)));
  if (refusEngagement) return { ok: false, error: refusEngagement };
  // Ni BC au-dessus du seuil sans la validation du TOTAL par le DG (27/10/2026) — les devis retenus y sont.
  const refusDg = await refusSiPorteDgFermee(SPEC[scopeRaw].module, requestId);
  if (refusDg) {
    await signalerPorteDgSiBesoin(SPEC[scopeRaw].module, requestId);
    return { ok: false, error: refusDg };
  }

  const fiches = await fichesDeLaDemande(scopeRaw, requestId);
  const nomDe = new Map(fiches.map((f) => [f.id, f.nom]));
  const liste = retenus.map((q) => {
    const qui = [...new Set(q.cells.map((c) => nomDe.get(c.cell.beneficiaryId) ?? "?"))];
    const montant = q.amount != null && q.currency === "USD"
      ? `${montantLisible(toNumber(q.amount), "USD")} = ${montantLisible(toNumber(q.amountDzd))}`
      : montantLisible(toNumber(q.amountDzd));
    return `• ${q.supplier}${q.reference ? ` (${q.reference})` : ""} — ${montant} — ${[...new Set(q.cells.map((c) => c.cell.label))].join(", ")} — ${qui.join(", ")}`;
  });
  const total = retenus.reduce((s, q) => s + toNumber(q.amountDzd), 0);
  const corps = [
    `Devis retenus (${retenus.length}) — total ${montantLisible(Math.round(total * 100) / 100)} :`,
    ...liste,
    ...(fdStr(formData, "note") ? [`Note : ${fdStr(formData, "note")}`] : []),
    `Fiche de la demande : ${SPEC[scopeRaw].path}/${requestId}`,
  ].join("\n");

  const sujet = await ecrireAAssistante(scopeRaw, req, user, "Demande de bon de commande.", corps);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  const marques = await prisma.careQuote.updateMany({
    where: { id: { in: retenus.map((q) => q.id) }, status: "PENDING", bcRequestedAt: null },
    data: { bcRequestedAt: new Date(), bcRequestedById: user.id },
  });
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Prise en charge — devis retenus à accepter",
    body: `${req.name} — ${marques.count} devis retenu(s), BC demandé à l'assistante de direction.`,
    link: `${SPEC[scopeRaw].path}/${requestId}`,
  }).catch(sansBloquer("care-actions.demanderBCPriseEnCharge.notifyRoles"));
  await audit(user, scopeRaw, requestId, "UPDATE", `BC demandé pour ${marques.count} devis retenu(s) — sujet ${sujet.reference}.`);
  revalidate(scopeRaw, requestId);
  revalidatePath("/dossiers");
  const depasse = req.finalAmount != null && total > toNumber(req.finalAmount)
    ? ` Les devis retenus (${montantLisible(Math.round(total * 100) / 100)}) dépassent l'enveloppe accordée : la Direction le verra.`
    : "";
  return { ok: true, id: sujet.id, message: `BC demandé pour ${marques.count} devis — sujet ${sujet.reference}, l'assistante de direction est prévenue.${depasse}` };
}

// ───────────────────────────── Postes de groupe ─────────────────────────────

/** Charge un poste de groupe, son périmètre et sa demande. */
async function chargerPosteGroupe(id: string) {
  const g = await prisma.careGroupPoste.findUnique({ where: { id } });
  if (!g) return null;
  const scope: Scope = g.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = g.congressNationalId ?? g.congressInternationalId;
  return requestId ? { g, scope, requestId } : null;
}

/**
 * AJOUTER UN POSTE DE GROUPE — « repas 100 par personne » (Direction, 10/2026) : un montant PAR PERSONNE qui
 * s'applique à chacun ; en dollars à l'international (sauf billetterie), converti au taux figé de la demande.
 */
export async function ajouterPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  const type = typePoste(fdStr(formData, "posteType"));
  if (!type) return { ok: false, error: "Choisissez la catégorie du poste." };
  const lu = lirePosteSaisi(type.serviceKind === "TICKET" || type.serviceKind === "HOTEL" ? "OTHER" : type.serviceKind, req.name, {
    label: fdStr(formData, "label"), notes: fdStr(formData, "notes"), dateStart: fdStr(formData, "date"), amount: fdStr(formData, "unitAmount"),
    timeStart: fdStr(formData, "timeStart"), address: fdStr(formData, "address"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const devise = deviseDuPoste(scopeRaw, type.serviceKind);
  const last = await prisma.careGroupPoste.findFirst({ where: parentWhere(scopeRaw, requestId), orderBy: { position: "desc" }, select: { position: true } });
  const created = await prisma.careGroupPoste.create({
    data: {
      ...parentWhere(scopeRaw, requestId),
      serviceKind: type.serviceKind, label: lu.poste.label ?? type.libelle, notes: lu.poste.notes, date: lu.poste.dateStart,
      timeStart: lu.poste.timeStart, address: lu.poste.address,
      unitAmount: lu.poste.amount, currency: devise, unitAmountDzd: versDzd(lu.poste.amount, devise, tauxDe(scopeRaw, req)),
      position: (last?.position ?? 0) + 1, createdById: user.id, updatedById: user.id,
    },
    select: { id: true, label: true },
  });
  await audit(user, scopeRaw, requestId, "CREATE", `Poste de groupe « ${created.label} »${lu.poste.amount != null ? ` — ${montantLisible(lu.poste.amount, devise)} par personne` : ""}.`);
  revalidate(scopeRaw, requestId);
  return { ok: true, id: created.id, message: "Poste de groupe ajouté — il s'applique à chaque personne." };
}

/**
 * MODIFIER UN POSTE DE GROUPE — son libellé, sa date, son montant par personne, son état ; et EXCLURE ou
 * réinclure UNE personne (`exclure` / `inclure` = l'identifiant de la fiche), sans toucher aux autres.
 */
export async function modifierPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await chargerPosteGroupe(id);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { g, scope, requestId } = found;
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };

  const exclure = fdStr(formData, "exclure");
  const inclure = fdStr(formData, "inclure");
  if (exclure || inclure) {
    const qui = (exclure ?? inclure)!;
    const appartient = await prisma.careBeneficiary.count({ where: { id: qui, ...parentWhere(scope, requestId) } });
    if (!appartient) return { ok: false, error: "Personne introuvable sur cette demande." };
    const liste = new Set(g.excludedBeneficiaryIds);
    if (exclure) liste.add(qui); else liste.delete(qui);
    await prisma.careGroupPoste.update({ where: { id }, data: { excludedBeneficiaryIds: [...liste], updatedById: user.id } });
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

export async function retirerPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await chargerPosteGroupe(id);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { g, scope, requestId } = found;
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  if (g.status === "SETTLED") return { ok: false, error: "Ce poste est réglé : déclarez-le plutôt « sans objet » s'il n'a plus lieu d'être." };
  await prisma.careGroupPoste.delete({ where: { id } });
  await audit(user, scope, requestId, "DELETE", `Poste de groupe « ${g.label} » retiré.`);
  revalidate(scope, requestId);
  return { ok: true, message: "Poste de groupe retiré." };
}

/** Les matériels promotionnels rattachables — pour le sélecteur. */
export async function carePromoOptions(): Promise<{ id: string; reference: string; title: string }[]> {
  await requireUser();
  const rows = await prisma.promoMaterial.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" }, take: 60,
    select: { id: true, reference: true, title: true },
  });
  return rows;
}
