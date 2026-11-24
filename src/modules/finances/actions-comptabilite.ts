"use server";

import { revalidatePath } from "next/cache";
import type { DocumentCategory } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { ouvrirPourEcrire } from "@/lib/queries/porte-ecriture";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { annulable } from "@/lib/effets/ecran";
import { formatMontant } from "@/lib/utils";
import { categorieDuTypePiece, motifDeContrePassation, REFUS_CONTRE_PASSATION_SANS_MOTIF } from "./domaine/comptabilite-vue";
import { CHAMP_DEMANDE_PIECE } from "./infra/requetes/comptabilite";
import { dossierHrefByOrder } from "./infra/expense-orders";
import { entityHref } from "@/lib/entity-href";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DU PANNEAU D'UNE ÉCRITURE (Comptabilité, maquette validée le 24/11/2026).
 *
 * « Modifier » reste `updateTransaction` (actions-tresorerie) ; ici, les trois gestes qu'aucune action ne portait :
 *   • CONTRE-PASSER, motif obligatoire — une écriture inverse (même sens, montant opposé, datée du jour, liée par
 *     `compensationDeId`), la forme que l'annulation d'un geste d'argent pose déjà (`lib/effets/argent.ts`) : l'originale
 *     reste au livre, barrée ;
 *   • JOINDRE UN JUSTIFICATIF — un fichier posé SUR l'écriture (`attachFiles`, le chemin de toutes les pièces), ou une
 *     facture du registre Legal rattachée (`justificatifFactureId`, jamais `settlementTxId` : voir la migration) ;
 *   • DEMANDER LA PIÈCE — une notification au demandeur (ou à qui a saisi l'écriture), tracée au journal : c'est la
 *     trace qui fait lire « ✕ manquant · demandé » sur la ligne. Volontairement simple : la boucle questions/réponses
 *     Finances ↔ demandeur (lot « Banque & paiements ») l'absorbera à la fusion.
 *
 * La porte de chacun : le droit « Modifier » de la Comptabilité ET la société de l'écriture (`ouvrirPourEcrire`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CHEMIN = "/finances/comptabilite";

/** Une référence libre pour l'écriture inverse : « FIN-2026-0042-CP », puis « …-CP2 »… */
async function referenceLibre(base: string): Promise<string> {
  for (let i = 1; i < 50; i += 1) {
    const ref = i === 1 ? base : `${base}${i}`;
    if (!(await prisma.financeTransaction.count({ where: { reference: ref } }))) return ref;
  }
  return `${base}-${Date.now()}`;
}

class DejaCompensee extends Error {}

/**
 * CONTRE-PASSER UNE ÉCRITURE — le livre se corrige par une écriture de CORRECTION, jamais en effaçant (ARGENT-05).
 * Seule une écriture RÉALISÉE se contre-passe (une écriture prévue se modifie ou se supprime) ; une contre-passation ne
 * se contre-passe pas ; une écriture ne l'est qu'UNE fois — vérifié sous verrou de ligne, deux clics n'en font pas deux.
 */
export async function contrePasserEcriture(formData: FormData): Promise<ActionResult> { return annulable("comptabilite-actions:contrePasserEcriture", "Contre-passer une écriture", async () => {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Écriture introuvable." };
  const porte = await ouvrirPourEcrire(user, "FINANCE_TRANSACTION", id, "UPDATE");
  if (!porte.ok) return porte;
  const motif = motifDeContrePassation(fdStr(formData, "motif"), fdStr(formData, "precision"));
  if (!motif) return { ok: false, error: REFUS_CONTRE_PASSATION_SANS_MOTIF };

  const a = await prisma.financeTransaction.findUnique({ where: { id } });
  if (!a) return { ok: false, error: "Écriture introuvable." };
  if (a.status !== "SETTLED") return { ok: false, error: "Seule une écriture réalisée se contre-passe : une écriture prévue se modifie (ou se supprime) depuis « Modifier »." };
  if (a.compensation) return { ok: false, error: `${a.reference} corrige déjà une autre écriture : on ne contre-passe pas une contre-passation. Saisissez une nouvelle écriture si besoin.` };

  const reference = await referenceLibre(`${a.reference}-CP`);
  let inverseId: string;
  try {
    inverseId = await prisma.$transaction(async (t) => {
      // Le verrou de la ligne : la vérification « pas déjà compensée » et l'écriture inverse se font sous lui.
      await t.$queryRaw`SELECT id FROM "FinanceTransaction" WHERE id = ${id} FOR UPDATE`;
      if (await t.financeTransaction.count({ where: { compensationDeId: id, status: { not: "CANCELLED" } } })) throw new DejaCompensee();
      const inverse = await t.financeTransaction.create({
        data: {
          reference, date: new Date(), category: a.category, method: a.method, direction: a.direction,
          amount: a.amount.negated(), status: "SETTLED",
          label: `Contre-passation — ${a.label}`.slice(0, 300),
          account: a.account, counterparty: a.counterparty, invoiceRef: a.invoiceRef, companyId: a.companyId,
          employeeId: a.employeeId, budgetCategoryId: a.budgetCategoryId, treasuryAccountId: a.treasuryAccountId,
          notes: `Contre-passation de ${a.reference} — motif : ${motif}`.slice(0, 1000),
          createdById: user.id, compensationDeId: id, compensation: "CONTRE_PASSATION",
        },
        select: { id: true },
      });
      return inverse.id;
    });
  } catch (e) {
    if (e instanceof DejaCompensee) return { ok: false, error: `${a.reference} est déjà contre-passée : son écriture inverse est au livre.` };
    throw e;
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: inverseId,
    summary: `Contre-passation ${reference} de ${a.reference} (${formatMontant(Number(a.amount))} DZD) — motif : ${motif}`,
  });
  revalidatePath(CHEMIN);
  return { ok: true, id: inverseId, message: `${a.reference} contre-passée. Écriture inverse ${reference} créée.` };
}); }

/**
 * JOINDRE UN JUSTIFICATIF À UNE ÉCRITURE — un fichier (PDF, photo), ou une facture du registre Legal de la même société
 * qui n'est encore liée à aucun paiement. Le rattachement est CONDITIONNEL (§118.151) : la facture n'est liée que si
 * aucun paiement ne la porte encore, et l'écriture que si aucune facture ne la justifie déjà.
 */
export async function joindreJustificatifEcriture(formData: FormData): Promise<ActionResult> { return annulable("comptabilite-actions:joindreJustificatifEcriture", "Joindre un justificatif à une écriture", async () => {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Écriture introuvable." };
  const porte = await ouvrirPourEcrire(user, "FINANCE_TRANSACTION", id, "UPDATE");
  if (!porte.ok) return porte;
  const ecriture = await prisma.financeTransaction.findUnique({ where: { id }, select: { reference: true, companyId: true, direction: true, justificatifFactureId: true } });
  if (!ecriture) return { ok: false, error: "Écriture introuvable." };

  const factureId = fdStr(formData, "factureId");
  if (factureId) {
    if (ecriture.justificatifFactureId) return { ok: false, error: `${ecriture.reference} est déjà justifiée par une facture du registre : joignez plutôt un fichier.` };
    const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
    const facture = await prisma.legalDocument.findFirst({
      where: { AND: [{ id: factureId, kind: "INVOICE", status: { not: "CANCELLED" }, companyId: ecriture.companyId }, ...(lecteurs ? [lecteurs] : [])] },
      select: { id: true, title: true, reference: true, paidDate: true, settlementTxId: true, expenseOrderId: true },
    });
    if (!facture) return { ok: false, error: "Facture introuvable dans le registre de cette société, ou hors de votre accès." };
    if (facture.paidDate || facture.settlementTxId || facture.expenseOrderId) {
      return { ok: false, error: `« ${facture.title} » est déjà payée ou envoyée au règlement : elle ne justifie pas un second paiement.` };
    }
    const dejaUtilisee = await prisma.financeTransaction.findFirst({ where: { justificatifFactureId: facture.id }, select: { reference: true } });
    if (dejaUtilisee) return { ok: false, error: `« ${facture.title} » justifie déjà le paiement ${dejaUtilisee.reference} : elle ne se rattache qu'une fois.` };
    // LE LIEN, POSÉ À CONDITION : l'écriture n'a pas (encore) de facture, et la facture ne justifie (encore) rien (l'index
    // unique tranche la course de deux clics).
    try {
      const pose = await prisma.financeTransaction.updateMany({ where: { id, justificatifFactureId: null }, data: { justificatifFactureId: facture.id } });
      if (pose.count === 0) return { ok: false, error: `${ecriture.reference} vient d'être justifiée par une autre facture : rechargez le panneau.` };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { ok: false, error: `« ${facture.title} » justifie déjà un autre paiement : elle ne se rattache qu'une fois.` };
      throw e;
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: id,
      field: "justificatifFactureId", newValue: facture.id,
      summary: `Justificatif rattaché à ${ecriture.reference} : facture ${facture.reference ?? facture.title}`,
    });
    revalidatePath(CHEMIN);
    return { ok: true, message: `Pièce jointe à ${ecriture.reference} : facture ${facture.reference ?? facture.title}.` };
  }

  const fichiers = formData.getAll("fichier").filter((f): f is File => f instanceof File && f.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Choisissez un fichier (PDF, photo) ou une facture du registre." };
  const refus = await validateAttachments(fichiers);
  if (refus) return { ok: false, error: refus };
  const r = await attachFiles({
    files: fichiers, entityType: "FINANCE_TRANSACTION", entityId: id, uploadedById: user.id,
    category: categorieDuTypePiece(fdStr(formData, "typePiece")) as DocumentCategory,
  });
  if (r.saved === 0) return { ok: false, error: r.error ?? "Le fichier n'a pas pu être enregistré." };
  await recordAudit({
    actorId: user.id, action: "UPLOAD", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: id,
    summary: `Justificatif joint à ${ecriture.reference} : ${fichiers.map((f) => f.name).join(", ")}`,
  });
  revalidatePath(CHEMIN);
  return { ok: true, message: r.error ? `Pièce jointe à ${ecriture.reference}, mais ${r.error}` : `Pièce jointe à ${ecriture.reference}.` };
}); }

/**
 * DEMANDER LA PIÈCE — au demandeur de l'ordre que l'écriture règle, ou à qui a saisi l'écriture (seuls destinataires
 * possibles : on ne relance pas n'importe qui au nom des Finances). Redemander, c'est relancer : chaque demande est
 * tracée, le panneau dit « demandée à … · relancée n fois ».
 */
export async function demanderPieceEcriture(formData: FormData): Promise<ActionResult> { return annulable("comptabilite-actions:demanderPieceEcriture", "Demander la pièce d'une écriture", async () => {
  const user = await requireUser();
  if (!userCan(user, "FINANCES_COMPTABILITE", "UPDATE")) return { ok: false, error: "Demander une pièce demande « Modifier » sur Comptabilité — un Super Admin l'accorde dans Administration › Accès." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Écriture introuvable." };
  const porte = await ouvrirPourEcrire(user, "FINANCE_TRANSACTION", id, "UPDATE");
  if (!porte.ok) return porte;
  const ecriture = await prisma.financeTransaction.findUnique({ where: { id }, select: { reference: true, label: true, amount: true, date: true, createdById: true } });
  if (!ecriture) return { ok: false, error: "Écriture introuvable." };
  const ordre = await prisma.expenseOrder.findFirst({ where: { transactionId: id }, select: { id: true, requestedById: true, sourceType: true, sourceId: true } });
  const permis = [ordre?.requestedById, ecriture.createdById].filter((x): x is string => Boolean(x));
  const destinataire = fdStr(formData, "destinataireId") ?? permis[0] ?? null;
  if (!destinataire || !permis.includes(destinataire)) {
    return { ok: false, error: "Cette écriture n'a ni demandeur ni auteur connu à qui demander la pièce : joignez-la vous-même depuis « Joindre un justificatif »." };
  }
  const message = (fdStr(formData, "message") ?? "").slice(0, 600)
    || `Merci de déposer le justificatif du paiement « ${ecriture.label} » (${formatMontant(Number(ecriture.amount))} DZD).`;
  await notifyUser({
    userId: destinataire, type: "ASSIGNMENT", title: `Pièce demandée — ${ecriture.reference}`, body: message,
    // LE DEMANDEUR VA LÀ OÙ IL PEUT DÉPOSER — le dossier de son paiement (comme `requestInvoice`), pas l'écran des Finances
    // qu'il n'ouvre pas ; l'auteur d'une saisie (un financier) revient sur l'écriture.
    link: (ordre && destinataire === ordre.requestedById
      ? (await dossierHrefByOrder([ordre.id])).get(ordre.id) ?? entityHref(ordre.sourceType, ordre.sourceId)
      : null) ?? `${CHEMIN}?ecriture=${id}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: id,
    field: CHAMP_DEMANDE_PIECE, newValue: destinataire, summary: `Pièce demandée pour ${ecriture.reference} — ${message}`.slice(0, 500),
  });
  revalidatePath(CHEMIN);
  return { ok: true, message: "Demande envoyée : elle apparaît dans ses notifications." };
}); }
