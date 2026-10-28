"use server";

import { revalidatePath } from "next/cache";
import type { PchTenderStatus, PchOrderStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { referenceDeSerie } from "@/lib/refs";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { recordAudit } from "@/lib/audit";
import { refreshLinkLabels } from "@/lib/links/store";
import { persistUploadedDocument } from "@/lib/documents";
import { fdStr, fdNum, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { entitePermisePourFiche } from "@/lib/company";
import { peutAgirSurLeMarche } from "@/lib/pch/porte-marche";

const TENDER_STATUSES: PchTenderStatus[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "SUSPENDED", "LOST"];
const ORDER_STATUSES: PchOrderStatus[] = ["PENDING", "VALIDATED", "DELIVERED", "PAID", "CANCELLED"];
const int = (formData: FormData, key: string) => Math.max(0, Math.round(fdNum(formData, key) ?? 0));

// ───────────────────────────── Appels d'offres ─────────────────────────────

/**
 * La prochaine référence « AO-AAAA-NNN » — le compteur de la série (DONNEES-12). Une référence SAISIE à la main peut
 * avoir pris un numéro que le compteur donne ensuite : on passe au suivant, borné.
 */
async function prochaineReferenceAO(): Promise<string> {
  const year = new Date().getFullYear();
  let reference = "";
  for (let essai = 0; essai < 5; essai++) {
    reference = await referenceDeSerie({
      modele: "PchTender", prefixe: "AO", annee: year,
      existantes: async () => (await prisma.pchTender.findMany({ where: { reference: { startsWith: `AO-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
    });
    if ((await prisma.pchTender.count({ where: { reference } })) === 0) break;
  }
  return reference;
}

export async function createTender(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "CREATE")) return { ok: false, error: "Non autorisé." };
  let reference = fdStr(formData, "reference");
  if (!reference) reference = await prochaineReferenceAO();
  const exists = await prisma.pchTender.findUnique({ where: { reference }, select: { id: true } });
  if (exists) return { ok: false, error: "Cette référence existe déjà." };
  // L'ENTITÉ DU MARCHÉ est l'une de celles que le formulaire propose (`getMyCompanies`) — un identifiant
  // forgé rangeait un marché chez une société que la personne ne voit pas, et qu'elle ne retrouvait
  // donc plus (§118.184 — audit 360°, S11).
  const companyId = fdStr(formData, "companyId") || null;
  if (!(await entitePermisePourFiche(user.id, companyId))) return { ok: false, error: "Cette entité ne vous est pas ouverte." };
  const statusRaw = fdStr(formData, "status");

  const created = await prisma.pchTender.create({
    data: {
      reference,
      title: fdStr(formData, "title"),
      products: fdStr(formData, "products"),
      supplier: fdStr(formData, "supplier"),
      supplierCountry: fdStr(formData, "supplierCountry"),
      quantity: int(formData, "quantity"),
      value: fdNum(formData, "value"),
      client: fdStr(formData, "client") ?? "PCH",
      status: (statusRaw && TENDER_STATUSES.includes(statusRaw as PchTenderStatus) ? statusRaw : "NOT_STARTED") as PchTenderStatus,
      internalReference: fdStr(formData, "internalReference"),
      publishedAt: fdDate(formData, "publishedAt"),
      submissionDeadline: fdDate(formData, "submissionDeadline"),
      responsibleId: fdStr(formData, "responsibleId"),
      businessUnitId: fdStr(formData, "businessUnitId"),
      awardDate: fdDate(formData, "awardDate"),
      cautionAmount: fdNum(formData, "cautionAmount"),
      cautionDeposited: fdCase(formData, "cautionDeposited") ?? false,
      cautionStart: fdDate(formData, "cautionStart"),
      cautionEnd: fdDate(formData, "cautionEnd"),
      notes: fdStr(formData, "notes"),
      companyId,
      createdById: user.id,
    },
  });
  // Pièces de l'appel d'offres jointes à la création (optionnel) : enregistrées comme documents
  // du marché (best-effort — une pièce en échec n'annule pas la création du marché déjà fait).
  const files = formData.getAll("tenderDoc").filter((f): f is File => f instanceof File && f.size > 0);
  for (const file of files) {
    try {
      await persistUploadedDocument(user.id, { entityType: "PCH_TENDER", entityId: created.id, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: null, file });
    } catch (err) {
      console.error("[pch] appel d'offres upload failed", err);
    }
  }

  await recordAudit({ actorId: user.id, action: "CREATE", module: "PCH", summary: `Appel d'offres ${reference}${files.length ? ` (${files.length} pièce·s jointe·s)` : ""}` });
  revalidatePath("/pch");
  return { ok: true, id: created.id };
}

export async function updateTender(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const statusRaw = fdStr(formData, "status");
  if (!(await peutAgirSurLeMarche(user, id, "UPDATE"))) return { ok: false, error: "Appel d'offres introuvable." };

  const avant = await prisma.pchTender.findUnique({ where: { id }, select: { reference: true, title: true } });
  if (!avant) return { ok: false, error: "Appel d'offres introuvable." };

  // LA RÉFÉRENCE SE CORRIGE — elle est saisie à la main le jour de la publication, et une
  // coquille dans le numéro d'un marché se paie pendant des années (on ne retrouve plus le
  // dossier, et le rapprochement avec les pièces du client tombe à côté).
  //
  // Elle reste UNIQUE : deux marchés qui portent le même numéro rendent la question « de quel
  // marché parle-t-on ? » sans réponse. Le refus NOMME le marché qui la porte déjà — « référence
  // déjà utilisée » oblige à la chercher à la main.
  const refSaisie = fdStr(formData, "reference");
  let nouvelleRef: string | undefined;
  if (refSaisie && refSaisie !== avant.reference) {
    const conflit = await prisma.pchTender.findFirst({
      where: { reference: refSaisie, id: { not: id } },
      select: { id: true, title: true, client: true },
    });
    if (conflit) {
      return {
        ok: false,
        error: `La référence « ${refSaisie} » est déjà celle d'un autre marché : ${conflit.title || "sans intitulé"}${conflit.client ? ` (${conflit.client})` : ""}. Deux marchés ne peuvent pas porter la même.`,
      };
    }
    nouvelleRef = refSaisie;
  }

  await prisma.pchTender.update({
    where: { id },
    data: {
      // `undefined` laisse le champ intact : un formulaire qui ne propose pas la référence
      // (ou qui la renvoie inchangée) ne doit pas pouvoir l'effacer.
      reference: nouvelleRef,
      // CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c, trouvé en écrivant le banc S11) :
      // chaque champ absent était remis à vide — corriger l'intitulé par un appel partiel effaçait la date
      // limite de dépôt, et le rappel d'échéance cessait de sonner sans un mot. L'écran porte les vingt
      // champs ; seul un appelant partiel (une op, un script) voit la différence. Chaque clé est écrite en
      // LITTÉRAL : passée par une variable, elle rendrait l'action illisible à la dérivation (§118.79b).
      title: formData.has("title") ? fdStr(formData, "title") : undefined,
      products: formData.has("products") ? fdStr(formData, "products") : undefined,
      supplier: formData.has("supplier") ? fdStr(formData, "supplier") : undefined,
      supplierCountry: formData.has("supplierCountry") ? fdStr(formData, "supplierCountry") : undefined,
      quantity: formData.has("quantity") ? int(formData, "quantity") : undefined,
      value: formData.has("value") ? fdNum(formData, "value") : undefined,
      client: formData.has("client") ? (fdStr(formData, "client") ?? "PCH") : undefined,
      status: (statusRaw && TENDER_STATUSES.includes(statusRaw as PchTenderStatus) ? (statusRaw as PchTenderStatus) : undefined),
      internalReference: formData.has("internalReference") ? fdStr(formData, "internalReference") : undefined,
      publishedAt: formData.has("publishedAt") ? fdDate(formData, "publishedAt") : undefined,
      submissionDeadline: formData.has("submissionDeadline") ? fdDate(formData, "submissionDeadline") : undefined,
      responsibleId: formData.has("responsibleId") ? fdStr(formData, "responsibleId") : undefined,
      businessUnitId: formData.has("businessUnitId") ? fdStr(formData, "businessUnitId") : undefined,
      awardDate: formData.has("awardDate") ? fdDate(formData, "awardDate") : undefined,
      cautionAmount: formData.has("cautionAmount") ? fdNum(formData, "cautionAmount") : undefined,
      // Une case décochée n'envoie rien : le témoin caché de l'écran dit « non » (§118.172).
      cautionDeposited: fdCase(formData, "cautionDeposited"),
      cautionStart: formData.has("cautionStart") ? fdDate(formData, "cautionStart") : undefined,
      cautionEnd: formData.has("cautionEnd") ? fdDate(formData, "cautionEnd") : undefined,
      notes: formData.has("notes") ? fdStr(formData, "notes") : undefined,
      updatedById: user.id,
    },
  });
  if (nouvelleRef) {
    // La référence est l'IDENTITÉ du marché : les liens d'affaire en portent une photo, qui
    // deviendrait fausse. On la remet à jour — c'est une correction, pas un renommage.
    await refreshLinkLabels("PCH_TENDER", id);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "PCH",
      entityType: "PCH_TENDER", entityId: id,
      field: "Référence", oldValue: avant.reference, newValue: nouvelleRef,
      summary: `Référence du marché corrigée : ${avant.reference} → ${nouvelleRef}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "PCH",
    entityType: "PCH_TENDER", entityId: id,
    summary: `Appel d'offres ${nouvelleRef ?? avant.reference} mis à jour`,
  });
  revalidatePath("/pch");
  revalidatePath(`/pch/${id}`);
  return { ok: true };
}

export async function deleteTender(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  if (!(await peutAgirSurLeMarche(user, id, "DELETE"))) return { ok: false, error: "Appel d'offres introuvable." };
  // À LA CORBEILLE, AVEC SES BRANCHES (audit 360°, I17) : la suppression partait en cascade — lots,
  // bons, livraisons — sans instantané ni retour. Le cœur réversible (§118.162) instantane tout le
  // lot, l'audite, refuse ce qui a quitté l'ERP, et le Super Admin peut tout restaurer d'un geste.
  const r = await supprimerReversible("PCH_TENDER", id, user.id, "Appel d'offres supprimé (corbeille)");
  if (!r.ok) return { ok: false, error: r.error ?? "Suppression impossible." };
  revalidatePath("/pch");
  return { ok: true };
}

// ───────────────────────────── Bons de commande ─────────────────────────────

export async function createOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "CREATE")) return { ok: false, error: "Non autorisé." };
  const tenderId = fdStr(formData, "tenderId");
  if (!tenderId) return { ok: false, error: "Appel d'offres manquant." };
  if (!(await peutAgirSurLeMarche(user, tenderId, "CREATE"))) return { ok: false, error: "Appel d'offres introuvable." };
  const statusRaw = fdStr(formData, "status");

  // Le CONTRAT du bon, quand il est connu : c'est lui qui ouvre le contrôle du restant
  // contractuel sur les lignes. Vérifié : il doit appartenir au même marché.
  const contractId = fdStr(formData, "contractId");
  if (contractId) {
    const contract = await prisma.legalDocument.findUnique({ where: { id: contractId }, select: { tenderId: true } });
    if (!contract) return { ok: false, error: "Contrat introuvable." };
    if (contract.tenderId !== tenderId) return { ok: false, error: "Ce contrat appartient à un autre marché." };
  }

  await prisma.pchOrder.create({
    data: {
      tenderId,
      contractId,
      reference: fdStr(formData, "reference"),
      products: fdStr(formData, "products"),
      quantity: int(formData, "quantity"),
      value: fdNum(formData, "value"),
      status: (statusRaw && ORDER_STATUSES.includes(statusRaw as PchOrderStatus) ? statusRaw : "PENDING") as PchOrderStatus,
      receivedDate: fdDate(formData, "receivedDate"),
      paymentDate: fdDate(formData, "paymentDate"),
      notes: fdStr(formData, "notes"),
      // BC D'AVENANT : commandé au-delà du volume attribué par l'AO (Ventes PCH › Contrats le compte à part).
      estAvenant: fdCase(formData, "estAvenant") ?? false,
      createdById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "PCH", summary: "Bon de commande PCH" });
  revalidatePath(`/pch/${tenderId}`);
  revalidatePath("/pch");
  return { ok: true };
}

export async function updateOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const order = await prisma.pchOrder.findUnique({ where: { id }, select: { tenderId: true } });
  if (!order || !(await peutAgirSurLeMarche(user, order.tenderId, "UPDATE"))) return { ok: false, error: "Bon de commande introuvable." };
  const statusRaw = fdStr(formData, "status");

  await prisma.pchOrder.update({
    where: { id },
    data: {
      reference: fdStr(formData, "reference"),
      products: fdStr(formData, "products"),
      quantity: int(formData, "quantity"),
      value: fdNum(formData, "value"),
      status: (statusRaw && ORDER_STATUSES.includes(statusRaw as PchOrderStatus) ? (statusRaw as PchOrderStatus) : undefined),
      receivedDate: fdDate(formData, "receivedDate"),
      paymentDate: fdDate(formData, "paymentDate"),
      notes: fdStr(formData, "notes"),
      // Une case décochée n'envoie rien : le témoin caché de l'écran dit « non » ; absent = inchangé.
      estAvenant: fdCase(formData, "estAvenant"),
    },
  });
  revalidatePath(`/pch/${order.tenderId}`);
  return { ok: true };
}

export async function deleteOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "PCH", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const order = await prisma.pchOrder.findUnique({ where: { id }, select: { tenderId: true } });
  if (!order || !(await peutAgirSurLeMarche(user, order.tenderId, "DELETE"))) return { ok: false, error: "Bon de commande introuvable." };
  await prisma.pchOrder.delete({ where: { id } });
  revalidatePath(`/pch/${order.tenderId}`);
  return { ok: true };
}
