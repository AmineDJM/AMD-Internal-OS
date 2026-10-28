"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { companyIdForNew } from "@/lib/company";
import { getManagerOfUser } from "@/lib/departments";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import {
  cleanLines, estimatedTotal, summarize, purchaseStage, canWithdraw, type PurchaseLine,
} from "@/lib/general-means/purchase-request";
import { journaliserDemandeAchat } from "@/lib/general-means/purchase-journal";
import { annulerDemandeSecretariat } from "@/lib/secretariat/annulation";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * DEMANDER UN ACHAT — ouvert à tout le monde, adressé à son directeur.
 *
 * La demande est une DEMANDE ADMINISTRATIVE de type « achat » : le même objet que celui du
 * bureau du secrétariat, avec son circuit, son fil et son imputation budgétaire à la clôture.
 * En créer un second aurait produit deux files d'achats, deux références et deux endroits où
 * chercher une commande — pour exactement le même besoin.
 *
 * Ce qui change, c'est la PORTE : on la dépose depuis les Moyens généraux, en cochant dans le
 * catalogue, sans connaître le circuit ni passer par l'assistante. Et le validateur n'est pas
 * choisi : c'est le responsable hiérarchique du demandeur, résolu par l'organigramme.
 */

const PATH = "/moyens-generaux";

/** Lit les lignes envoyées par le formulaire (JSON), sans jamais faire confiance au client. */
function readLines(raw: FormDataEntryValue | null): PurchaseLine[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return cleanLines(
      parsed.map((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        return {
          articleId: typeof o.articleId === "string" ? o.articleId : null,
          label: typeof o.label === "string" ? o.label : "",
          quantity: Number(o.quantity ?? 1),
          unitPrice: o.unitPrice == null ? null : Number(o.unitPrice),
        };
      }),
    );
  } catch {
    return [];
  }
}

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "AdministrativeRequest", prefixe: "REQ", annee: year,
    existantes: async () => (await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: `REQ-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

export async function createPurchaseRequest(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  // Pas de garde de module : DEMANDER un achat est un geste de tout employé. Ce qui reste
  // fermé, c'est le budget — il n'apparaît nulle part dans ce circuit.
  const user = await requireUser();

  const lines = readLines(formData.get("lines"));
  if (lines.length === 0) {
    return { ok: false, error: "Indiquez au moins un article — du catalogue, ou décrit en clair." };
  }

  // LE VALIDATEUR NE SE CHOISIT PAS : c'est le responsable du demandeur, résolu par
  // l'organigramme (manager explicite, puis responsable de département, puis au-dessus).
  // Laisser choisir reviendrait à laisser choisir qui vous dit oui.
  const manager = await getManagerOfUser(user.id);
  if (!manager?.userId) {
    return {
      ok: false,
      error: "Aucun responsable hiérarchique n'est rattaché à votre fiche : demandez aux ressources humaines de la compléter, sinon la demande n'aurait personne à qui aller.",
    };
  }

  const employee = await prisma.employee.findUnique({
    where: { userId: user.id },
    select: { departmentId: true },
  });

  const title = fdStr(formData, "title") || summarize(lines);
  const amount = estimatedTotal(lines);
  const companyId = await companyIdForNew(user.id);

  // LA RÉFÉRENCE SE RECALCULE SOUS COLLISION (§118.175, lot E5) : deux achats déposés à la même seconde lisaient le
  // même maximum, et le second échouait sur une erreur brute — après avoir rempli le panier. Seule la référence se
  // recalcule ; l'entité est lue une fois, avant l'essai.
  const created = await createWithRetry(async () => prisma.administrativeRequest.create({
    data: {
      reference: await nextRef(), title, type: "PURCHASE",
      status: "AWAITING_VALIDATION",
      description: fdStr(formData, "description"),
      priority: "MEDIUM",
      departmentId: employee?.departmentId ?? null,
      // Le détail voyage dans `fields` : c'est ce qui permet de relire six mois plus tard
      // CE QUI a été demandé, et pas seulement combien ça a coûté.
      fields: { purchaseLines: lines as unknown as Prisma.InputJsonValue, estimatedTotal: amount },
      requesterId: user.id,
      createdById: user.id,
      validatorId: manager.userId,
      companyId,
    },
    select: { id: true, reference: true },
  }));
  const reference = created.reference;

  await prisma.adminApproval.create({
    data: {
      requestId: created.id, requestedById: user.id, validatorId: manager.userId,
      status: "PENDING",
      // Le montant est INDICATIF (prix du catalogue). On ne le pose PAS comme montant à payer :
      // ce champ déclenche un ordre de dépense à l'approbation, et l'on ne fait pas payer un
      // prix de catalogue à la place d'une facture réelle.
      comment: amount != null ? `Estimation catalogue : ${amount.toLocaleString("fr-FR")} DZD` : null,
    },
  });

  await notifyUser({
    userId: manager.userId, type: "VALIDATION_REQUIRED",
    title: "Demande d'achat à valider",
    body: `${reference} — ${title}${amount != null ? ` (~${amount.toLocaleString("fr-FR")} DZD)` : ""}`,
    link: `/demandes/${created.id}`,
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Moyens généraux",
    entityType: "ADMIN_REQUEST", entityId: created.id,
    summary: `Demande d'achat ${reference} — ${title} · validateur ${manager.fullName}`,
  });

  // LE JOURNAL DU SUPER ADMIN — la demande y est copiée ENTIÈREMENT, dès son dépôt. Il vit à
  // part de la demande, qui peut être retirée ou supprimée ; lui ne s'efface pas.
  await journaliserDemandeAchat({ requestId: created.id, event: "SUBMITTED", actorId: user.id });

  revalidatePath(PATH);
  revalidatePath("/demandes");
  revalidatePath("/demandes/approvals");
  return { ok: true, id: created.id, message: `Demande envoyée à ${manager.fullName}.` };
}

/** Le signal d'un retrait à défaire : la demande a changé entre la lecture et l'écriture (non exporté). */
const DEMANDE_CHANGEE_EN_ROUTE = "demande-changee-pendant-le-retrait";

/**
 * RETIRER SA DEMANDE — tant que le directeur n'a pas tranché, ou qu'il l'a renvoyée « à modifier ».
 *
 * Après, elle appartient au circuit : la retirer effacerait une décision, et l'on ne saurait
 * plus pourquoi un achat a été lancé. On l'annule alors plutôt qu'on ne la supprime.
 */
export async function withdrawPurchaseRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };

  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    select: {
      id: true, reference: true, requesterId: true, status: true, validatorId: true, type: true, deletedAt: true,
      approvals: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true } },
    },
  });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  if (req.requesterId !== user.id) return { ok: false, error: "Seul l'auteur retire sa demande." };
  // CE GESTE RETIRE UN ACHAT, ET RIEN D'AUTRE (lot E5) : sur une autre demande dont on est l'auteur, il l'annulait
  // sans retirer ce qui en dépend — une validation, un paiement en attente —, la porte d'à côté de l'annulation
  // commune (§118.71, §118.187).
  if (req.type !== "PURCHASE") {
    return { ok: false, error: "Ce geste retire une demande d'achat. Une autre demande s'annule depuis sa fiche — « Annuler ma demande », avec son motif." };
  }

  const lue = req.approvals[0] ?? null;
  const stage = purchaseStage(req.status, lue);
  if (!canWithdraw(stage)) {
    return {
      ok: false,
      error: stage === "DONE" ? "L'achat est déjà effectué : la demande ne se retire plus."
        : stage === "REJECTED" ? "Votre directeur a refusé cette demande : il n'y a plus rien à retirer."
        : "Cette demande est déjà annulée.",
    };
  }

  // VALIDÉE MAIS PAS EXÉCUTÉE (décision du 04/10) : le retrait passe par l'ANNULATION COMMUNE d'une
  // demande au secrétariat — un paiement réglé refuse avant toute écriture, la demande se clôt sous
  // condition, puis ses approbations et ses ordres non réglés partent, et le secrétariat est prévenu.
  if (stage === "APPROVED") {
    const motif = fdStr(formData, "motif") ?? "achat retiré après la validation du directeur";
    const res = await annulerDemandeSecretariat(id, { acteurId: user.id, motif, cause: "par son demandeur" });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.annulee) return { ok: false, error: "Cette demande vient de changer — rechargez la page pour voir où elle en est." };
    if (req.validatorId && req.validatorId !== user.id) {
      await notifyUser({ userId: req.validatorId, type: "GENERIC", title: "Demande d'achat retirée", body: `${req.reference} — retirée après votre validation : ${motif}`, link: `/demandes/${id}` }).catch(() => undefined);
    }
    await journaliserDemandeAchat({ requestId: id, event: "WITHDRAWN", actorId: user.id });
    revalidatePath(PATH);
    revalidatePath("/demandes");
    revalidatePath("/demandes/approvals");
    return {
      ok: true,
      message: res.reserve ?? (res.ordresAnnules.length ? `Demande retirée — paiement(s) annulé(s) : ${res.ordresAnnules.join(", ")}.` : "Demande retirée — le secrétariat est prévenu."),
    };
  }

  // SOUS CONDITION DE CE QUI A ÉTÉ LU (lot E5). Le retrait écrivait « annulée » sans condition : le directeur qui
  // validait à la même seconde voyait sa décision tomber sur une demande annulée — et l'assistante, prévenue « à
  // traiter », achetait pour une demande retirée. L'approbation lue « en attente » doit l'être encore, la demande
  // doit être dans l'état lu ; sinon RIEN ne s'écrit (la transaction est défaite).
  let issue: "retiree" | "tranchee" | "changee";
  try {
    issue = await prisma.$transaction(async (tx) => {
      if (lue?.status === "PENDING") {
        const retiree = await tx.adminApproval.deleteMany({ where: { id: lue.id, status: "PENDING" } });
        if (retiree.count === 0) return "tranchee" as const;
      }
      await tx.adminApproval.deleteMany({ where: { requestId: id, status: "PENDING" } });
      const posee = await tx.administrativeRequest.updateMany({
        where: { id, status: req.status, deletedAt: null },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      if (posee.count === 0) throw new Error(DEMANDE_CHANGEE_EN_ROUTE);
      return "retiree" as const;
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== DEMANDE_CHANGEE_EN_ROUTE) throw e;
    issue = "changee";
  }
  if (issue === "tranchee") return { ok: false, error: "Votre directeur vient de trancher cette demande — rechargez la page pour voir sa décision." };
  if (issue === "changee") return { ok: false, error: "Cette demande vient de changer — rechargez la page pour voir où elle en est." };

  if (req.validatorId) {
    await notifyUser({
      userId: req.validatorId, type: "GENERIC", title: "Demande d'achat retirée",
      body: req.reference, link: `/demandes/${id}`,
    }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Moyens généraux",
    entityType: "ADMIN_REQUEST", entityId: id,
    summary: `Demande d'achat ${req.reference} retirée par son auteur`,
  });
  await journaliserDemandeAchat({ requestId: id, event: "WITHDRAWN", actorId: user.id });
  revalidatePath(PATH);
  revalidatePath("/demandes/approvals");
  return { ok: true };
}
