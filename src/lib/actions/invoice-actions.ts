"use server";

import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { companyIdForNew } from "@/lib/company";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { attachFormFiles } from "@/lib/documents";
import { invoiceDirection, canMarkPaidDirectly, dateDeReglementAEcrire } from "@/lib/finances/settlement";
import { legalWriteAllowed } from "@/lib/legal/invoices";
import { syncInvoiceSettlement } from "@/lib/finance/settle-invoice";
import { refusMaillonAmont } from "@/lib/legal/chaine";
import { refusPieceARanger, rangerPiece } from "@/lib/legal/adoption";
import type { CurrentUser } from "@/lib/session";

/**
 * LES FACTURES — DES DOCUMENTS LÉGAUX DE NATURE « FACTURE », et rien d'autre.
 *
 * ── CE QUI A CHANGÉ, ET POURQUOI CE FICHIER EXISTE ENCORE ───────────────────────────────────
 *
 * Une facture n'a plus de table à elle : c'est un `LegalDocument` de nature `INVOICE`, dans le
 * registre où vivent déjà les devis et les bons de commande dont elle découle (§17 : pas de
 * second registre).
 *
 * Ce fichier garde ses gestes parce qu'ils ont des APPELANTS RÉELS et un vocabulaire à eux :
 * « enregistrer la facture reçue de ce fournisseur » depuis la fiche qui la fait naître, et les
 * opérations d'Adam. Ce sont des adaptateurs : ils traduisent le vocabulaire d'une facture vers
 * celui du registre, et n'ont AUCUNE règle qui leur soit propre — la porte d'écriture, l'état du
 * règlement et l'écriture comptable vivent dans `lib/legal/`.
 *
 *   n° de facture     → `reference`        objet   → `title`
 *   date d'émission   → `startDate`        échéance → `endDate`
 *   destinataire/payeur → `counterparty` (celui des deux qui n'est pas nous, désigné par le SENS)
 *
 * ── QUI ÉCRIT ───────────────────────────────────────────────────────────────────────────────
 *
 * Legal tient le registre ; la COMPTABILITÉ tient les factures. Fondre les deux écrans aurait
 * pu fermer la porte à celle qui vient y lire ce qui reste à payer : `legalWriteAllowed` l'ouvre
 * pour la seule nature « facture », et pour elle seule.
 */

/** La porte d'écriture d'une facture — la même règle que l'écran, tenue par le serveur. */
function peutEcrire(user: CurrentUser, verb: "CREATE" | "UPDATE" | "DELETE"): boolean {
  return legalWriteAllowed({
    onLegal: userCan(user, "LEGAL", verb),
    onFinances: userCan(user, "FINANCES", verb),
    kind: "INVOICE",
  });
}

function readFields(formData: FormData) {
  return {
    title: fdStr(formData, "title"),
    reference: fdStr(formData, "number") ?? fdStr(formData, "reference"),
    startDate: fdDate(formData, "issueDate"),
    endDate: fdDate(formData, "dueDate"),
    paidDate: fdDate(formData, "paidDate"),
    amount: fdStr(formData, "amount") ? Number(fdStr(formData, "amount")) : null,
    // LA PARTIE EN FACE. Le formulaire peut la nommer « destinataire » ou « payeur » selon le
    // sens ; le registre n'en garde qu'une — l'autre, c'est nous, et `companyId` le dit déjà.
    counterparty: fdStr(formData, "counterparty") ?? fdStr(formData, "recipient") ?? fdStr(formData, "payer"),
    // Sens de l'argent — jamais deviné d'un nom de société : voir `invoiceDirection`.
    direction: invoiceDirection(fdStr(formData, "direction")),
    notes: fdStr(formData, "notes"),
  };
}

export async function createInvoice(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutEcrire(user, "CREATE")) return { ok: false, error: "Non autorisé." };

  const { title, ...f } = readFields(formData);
  if (!title) return { ok: false, error: "L'objet de la facture est obligatoire." };
  if (f.amount !== null && !Number.isFinite(f.amount)) return { ok: false, error: "Montant invalide." };
  // LA DATE DE RÈGLEMENT SE POSE PAR QUI RÈGLE AUX FINANCES (audit Assistante de direction, 10/2026).
  const datation = dateDeReglementAEcrire({ avant: null, demandee: f.paidDate, champEnvoye: true, financesModifier: userCan(user, "FINANCES", "UPDATE") });
  if (!datation.ok) return { ok: false, error: datation.error };

  // LE BON DE COMMANDE DONT ELLE DÉCOULE (§118.161) — le « → » de la chaîne d'une fiche. C'est ce
  // lien qui fait attendre la validation du BC avant de payer la facture (§118.148) ; une facture
  // créée depuis une fiche sans lui échappait à cette porte.
  const chainFromId = fdStr(formData, "chainFromId");
  const refusAmont = await refusMaillonAmont(chainFromId);
  if (refusAmont) return { ok: false, error: refusAmont };

  // Le type ne se pose QUE si la cible existe : un « PCH_ORDER » sans identifiant serait un lien
  // qui pointe nulle part (le select « Bon de commande » peut rester vide).
  const sourceId = fdStr(formData, "sourceId");
  const source = { type: sourceId ? ((fdStr(formData, "sourceType") as EntityType | null) ?? null) : null, id: sourceId };
  // « CRÉER SA FICHE » : le fichier déjà déposé sur la demande est RANGÉ dans la facture créée —
  // vérifié AVANT d'écrire, pour ne pas laisser une facture sans son fichier.
  const pieceExistanteId = fdStr(formData, "pieceExistanteId");
  const refusRangement = await refusPieceARanger(user, pieceExistanteId, source);
  if (refusRangement) return { ok: false, error: refusRangement };

  const created = await prisma.legalDocument.create({
    data: {
      ...f, title,
      kind: "INVOICE",
      companyId: await companyIdForNew(user.id),
      chainFromId,
      sourceType: source.type,
      sourceId: source.id,
      createdById: user.id, updatedById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: created.id,
    summary: `Facture « ${title} »${f.reference ? ` (n° ${f.reference})` : ""}`,
  });
  // Une facture créée DÉJÀ réglée (saisie a posteriori) inscrit son mouvement aussitôt.
  await syncInvoiceSettlement(created.id, user.id);

  // LE SCAN PART AVEC LA FACTURE. On enregistrait sinon une ligne, puis on repartait la chercher
  // pour y téléverser le PDF : trois écrans pour un fichier qu'on avait sous la main, et en
  // pratique un justificatif qui reste dans la boîte mail.
  const files = await attachFormFiles(user.id, "LEGAL_DOCUMENT", created.id, formData);
  const range = pieceExistanteId ? await rangerPiece(user, pieceExistanteId, source, created.id) : null;

  revalidatePath("/legal");
  revalidatePath("/finances");
  // Née rattachée à un bon de commande PCH : la fiche marché l'affiche aussi.
  if (fdStr(formData, "sourceType") === "PCH_ORDER") revalidatePath("/pch");
  // Le rangement se DIT, dans les deux sens : un fichier qui n'a pas suivi ne se lit pas comme rangé.
  const rangement = pieceExistanteId
    ? (range ? `« ${range} » est rangé dans la facture.` : "Le fichier n'a pas pu être rangé : il n'était plus sur la fiche d'origine.")
    : null;
  const fichiers = files.failed.length
    ? `${files.attached} pièce(s) jointe(s) ; échec sur : ${files.failed.map((x) => x.name).join(", ")}.`
    : null;
  return fichiers || rangement
    ? { ok: true, id: created.id, message: ["Facture créée.", fichiers, rangement].filter(Boolean).join(" ") }
    : { ok: true, id: created.id };
}

/** La pièce visée existe-t-elle, et est-elle bien une facture ? */
async function laFacture(id: string) {
  if (!id) return null;
  const doc = await prisma.legalDocument.findUnique({
    where: { id },
    select: { id: true, title: true, reference: true, kind: true, expenseOrderId: true, paidDate: true },
  });
  return doc && doc.kind === "INVOICE" ? doc : null;
}

export async function updateInvoice(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutEcrire(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const doc = await laFacture(fdStr(formData, "id") ?? "");
  if (!doc) return { ok: false, error: "Facture introuvable." };

  const { title, ...f } = readFields(formData);
  if (!title) return { ok: false, error: "L'objet de la facture est obligatoire." };
  // QUI RÈGLE DATE LE RÈGLEMENT (audit Assistante de direction, 10/2026) : absente du formulaire, la date garde sa valeur.
  const datation = dateDeReglementAEcrire({
    avant: doc.paidDate, demandee: f.paidDate, champEnvoye: formData.has("paidDate"), financesModifier: userCan(user, "FINANCES", "UPDATE"),
  });
  if (!datation.ok) return { ok: false, error: datation.error };
  f.paidDate = datation.paidDate;
  // LE CIRCUIT POSSÈDE LA DATE DE RÈGLEMENT des factures qu'il porte (§118.148). La ligne du
  // tableau (`setInvoicePaid`) et la fiche Legal (`updateLegalDocument`) le refusaient déjà ; ce
  // formulaire-ci l'acceptait, et une date posée ici sur une facture partie au centre de paiement
  // écrivait une écriture de règlement en plus de celle que l'ordre écrira à son paiement — le
  // même dinar sorti deux fois, dont une sans que le centre l'ait vu. Une règle, trois portes.
  const reglement = canMarkPaidDirectly({ paidDate: f.paidDate, expenseOrderId: doc.expenseOrderId });
  if (!reglement.ok) return { ok: false, error: reglement.error };

  await prisma.legalDocument.update({
    where: { id: doc.id },
    // Changer l'échéance rouvre la surveillance : le dernier rappel s'efface pour que la
    // nouvelle date soit annoncée à son tour.
    data: { ...f, title, lastRemindedAt: null, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: doc.id,
    summary: `Facture « ${title} » mise à jour`,
  });
  // La date de règlement peut avoir été posée ou retirée depuis la fiche : l'écriture suit.
  await syncInvoiceSettlement(doc.id, user.id);
  revalidatePath("/legal");
  revalidatePath(`/legal/${doc.id}`);
  revalidatePath("/finances");
  return { ok: true };
}

/**
 * RATTACHER une facture EXISTANTE à un bon de commande PCH (ou l'en détacher) — le geste
 * a posteriori : la facture arrivée avant que le lien soit fait. C'est ce lien
 * (`sourceType = PCH_ORDER`) qui la fait apparaître sous SON bon dans la fiche marché, et qui
 * répond à « quelle facture correspond à quel BC ».
 */
export async function setInvoiceOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutEcrire(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const doc = await laFacture(fdStr(formData, "id") ?? "");
  if (!doc) return { ok: false, error: "Facture introuvable." };

  const orderId = fdStr(formData, "pchOrderId");
  let orderLabel: string | null = null;
  if (orderId) {
    const o = await prisma.pchOrder.findUnique({ where: { id: orderId }, select: { reference: true, tender: { select: { reference: true } } } });
    if (!o) return { ok: false, error: "Bon de commande introuvable." };
    orderLabel = `BC ${o.reference ?? "s/n"} — ${o.tender.reference}`;
  }
  await prisma.legalDocument.update({
    where: { id: doc.id },
    data: { sourceType: orderId ? "PCH_ORDER" : null, sourceId: orderId, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: doc.id,
    summary: orderId
      ? `Facture « ${doc.title} » rattachée au ${orderLabel}`
      : `Facture « ${doc.title} » détachée de son bon de commande`,
  });
  revalidatePath("/legal");
  revalidatePath("/pch");
  return { ok: true };
}

/** Marquer réglée / à régler depuis la ligne du tableau — le geste le plus fréquent. */
export async function setInvoicePaid(input: { id: string; paidDate: string | null }): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutEcrire(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const doc = await laFacture(input.id);
  if (!doc) return { ok: false, error: "Facture introuvable." };
  const paid = input.paidDate ? new Date(input.paidDate) : null;
  if (input.paidDate && Number.isNaN(paid!.getTime())) return { ok: false, error: "Date invalide." };
  // MARQUER RÉGLÉE (ou dé-marquer), C'EST ÉCRIRE AU LIVRE : le geste de qui règle aux Finances (audit Assistante de direction, 10/2026).
  const datation = dateDeReglementAEcrire({ avant: doc.paidDate, demandee: paid, champEnvoye: true, financesModifier: userCan(user, "FINANCES", "UPDATE") });
  if (!datation.ok) return { ok: false, error: datation.error };

  // LE CIRCUIT A LA PRIORITÉ. Une facture partie au règlement sera soldée par le paiement de son
  // ordre : la marquer réglée à la main poserait la date d'un virement qui n'a pas encore eu
  // lieu, et l'écran dirait « réglée » sur un dossier que les Finances tiennent encore ouvert.
  // La règle vit dans `canMarkPaidDirectly` — elle était RECOPIÉE ici, mot pour mot, et c'est la
  // copie oubliée ailleurs qui a laissé le formulaire d'édition la contourner (§118.5).
  const reglement = canMarkPaidDirectly({ paidDate: paid, expenseOrderId: doc.expenseOrderId });
  if (!reglement.ok) return { ok: false, error: reglement.error };

  await prisma.legalDocument.update({ where: { id: doc.id }, data: { paidDate: paid, updatedById: user.id } });
  // L'ARGENT PASSE PAR LES FINANCES : marquer réglée y inscrit le mouvement, dé-marquer le retire.
  await syncInvoiceSettlement(doc.id, user.id);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: doc.id, field: "paidDate",
    summary: paid ? `Facture « ${doc.title} » marquée réglée` : `Facture « ${doc.title} » remise à régler`,
  });
  revalidatePath("/legal");
  revalidatePath(`/legal/${doc.id}`);
  revalidatePath("/finances");
  return { ok: true };
}

export async function deleteInvoice(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutEcrire(user, "DELETE")) return { ok: false, error: "Non autorisé." };
  const doc = await laFacture(fdStr(formData, "id") ?? "");
  if (!doc) return { ok: false, error: "Facture introuvable." };

  await prisma.legalDocument.delete({ where: { id: doc.id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: doc.id,
    summary: `Facture « ${doc.title} » supprimée`,
  });
  revalidatePath("/legal");
  return { ok: true };
}
