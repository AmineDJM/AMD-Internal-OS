"use server";

import { refusDuRetraitValidation, validateursSollicites } from "@/lib/validations/retrait";
import { revalidatePath } from "next/cache";
import { FinanceCategory } from "@prisma/client";
import type { AdminRequestType, AdminRequestStatus, Priority, AdminApprovalStatus, DriverMissionStatus, Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, isTopManagement, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { journaliserDemandeAchat } from "@/lib/general-means/purchase-journal";
import { companyIdForNew } from "@/lib/company";
import { formatAlgiers } from "@/lib/calendar-tz";
import { archiveProcessedRequest } from "@/lib/archive";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS } from "@/lib/labels";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/lib/expense-orders";
import { createDirectValidation, retirerValidationSansObjet } from "@/lib/validation";
import { buildRef, createWithRetry } from "@/lib/refs";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { dejaPorteParSaFiche } from "@/lib/ad-pro/unified";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { fieldLabels, REQUEST_TYPES } from "@/lib/admin-requests";
import {
  porteDuDemandeur, refusDeModification, changementsDeLaDemande, suitLaDemandeDeBcDuPoste, refusDemandeDeBcDuPoste, type ContenuDemande,
} from "@/lib/secretariat/porte-demandeur";
import { annulerDemandeSecretariat, prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { ramenerSiPlusDeDemandeDevis } from "@/lib/promo-material/retrait-devis";
import { refusDuStatutManuel, refusDeReouverture } from "@/lib/secretariat/statut-manuel";
import { estDecisionDApprobation, refusSansMotif, interditSurSaPropreDemande, LIBELLE_DECISION, peutTrancherApprobation, refusValidateursPieceChiffree } from "@/lib/secretariat/decision-approbation";
import { refusFinApresDecision, refusFinDevisPromo } from "@/lib/secretariat/traitement";
import { ficheAFacture } from "@/lib/finance/facture-ordre";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { refusFinBCEnRoute } from "@/lib/secretariat/devis-natif";
import { joindreFactureALaDemande } from "@/lib/secretariat/facture-jointe";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { sansBloquer } from "@/lib/journal";

const DENIED: ActionResult = { ok: false, error: "Non autorisé." };

/**
 * Archive une demande administrative TERMINÉE dans le Drive du traitant
 * (« Dossier traité / Bureau du secrétariat ») : récapitulatif + copie des pièces.
 * Une seule fois par demande ; ne fait jamais échouer le traitement.
 */
async function archiveAdminRequestIfDone(id: string, actorId: string): Promise<void> {
  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    include: { requester: { select: { name: true } }, assignedTo: { select: { name: true } } },
  });
  if (!req || req.archivedNodeId || req.status !== "DONE") return;

  const docs = await prisma.document.findMany({
    where: { entityType: "ADMIN_REQUEST", entityId: id },
    select: { name: true, fileKey: true, mimeType: true },
  });
  const lines = [
    `Demande administrative — ${req.reference}`,
    `Titre : ${req.title}`,
    `Type : ${ADMIN_REQUEST_TYPE[req.type] ?? req.type}${req.subtype ? ` (${req.subtype})` : ""}`,
    req.requester?.name ? `Demandeur : ${req.requester.name}` : null,
    req.assignedTo?.name ? `Traitée par : ${req.assignedTo.name}` : null,
    req.description ? `Description : ${req.description}` : null,
    `Créée le : ${formatAlgiers(req.createdAt, { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    `Terminée le : ${formatAlgiers(req.completedAt ?? new Date(), { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean).join("\n");

  const day = new Date().toISOString().slice(0, 10);
  const nodeId = await archiveProcessedRequest({
    bureau: "Bureau du secrétariat",
    folderName: `${day} — ${req.reference} — ${req.title}`,
    summary: lines,
    attachments: docs.map((d) => ({ name: d.name, fileKey: d.fileKey, mimeType: d.mimeType })),
    ownerId: actorId,
  });
  if (nodeId) {
    await prisma.administrativeRequest.update({ where: { id }, data: { archivedNodeId: nodeId } });
    revalidatePath("/drive");
  }
}

/** Référence robuste (dérivée du maximum réel, pas de `count()+1` fragile). */
async function nextRequestRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.administrativeRequest.findMany({
    where: { reference: { startsWith: `REQ-${year}-` } },
    select: { reference: true },
  });
  return buildRef("REQ", year, refs.map((r) => r.reference));
}

/**
 * UNE DEMANDE TERMINÉE OU ANNULÉE NE SE TRAITE PLUS (§118.187 — audit 360°, R08). Depuis qu'un demandeur
 * peut annuler sa demande au-delà de trente minutes, une demande annulée reste VISIBLE au bureau (elle
 * n'est plus effacée) : « Commencer », « Demander une validation » et « Fin de la demande » l'auraient
 * ressuscitée, ou payée. Une demande TERMINÉE se rouvre par `rouvrirDemande`, avec son motif ; une
 * demande ANNULÉE ne se rouvre pas (§118.191) — ce qui en dépendait a été retiré avec elle.
 */
/** Une demande qui se TRAITE encore — la condition de toute écriture qui la fait avancer (§118.187). */
const OUVERTE = { deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] as AdminRequestStatus[] } } satisfies Prisma.AdministrativeRequestWhereInput;
const DEMANDE_CHANGEE = "Cette demande vient d'être annulée ou terminée : rouvrez-la pour voir où elle en est.";

function refusDemandeClose(status: AdminRequestStatus): string | null {
  if (status === "CANCELLED") return "Cette demande a été annulée : elle ne se traite plus, et ne se rouvre pas — déposez-en une nouvelle.";
  if (status === "DONE") return "Cette demande est terminée : elle ne se traite plus. Si elle doit reprendre, rouvrez-la (« Rouvrir », avec son motif).";
  return null;
}

/** Type-specific fields are submitted as `f_<name>` and stored in `fields` JSON. */
function collectFields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("f_") && typeof v === "string" && v.trim()) out[k.slice(2)] = v.trim();
  }
  return out;
}

function isManager(user: SessionUser, assignedToId: string | null): boolean {
  return hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE") || assignedToId === user.id;
}

// ─────────────────────────────── Création ───────────────────────────────

export async function createRequest(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "ADMIN_REQUESTS", "CREATE")) return DENIED;
  const type = fdStr(formData, "type") as AdminRequestType | null;
  const title = fdStr(formData, "title");
  if (!type || !title) return { ok: false, error: "Type et titre obligatoires." };
  // Seuls les types du catalogue se créent : « Mission chauffeur » et « Demande RH » se relisent, ne se créent plus.
  if (!REQUEST_TYPES.some((t) => t.value === type)) return { ok: false, error: "Ce type de demande ne se crée plus." };

  // LA DEMANDE VA DIRECTEMENT À L'ASSISTANTE DE DIRECTION (Direction, 10/2026) : le formulaire ne porte plus
  // « Personne concernée » ni « Responsable ». Le demandeur peut ajouter des PARTICIPANTS (`fields.participantIds`).
  const participantIds = [...new Set(formData.getAll("participantIds").map((v) => String(v).trim()).filter((v) => v && v !== user.id))];
  const participants = participantIds.length
    ? (await prisma.user.findMany({ where: { id: { in: participantIds }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];

  // LES PIÈCES JOINTES — tout type (Excel, PDF, Word, images, archives…) sauf ce qui s'exécute, et jugées
  // AVANT de créer : refusées après, la demande existerait déjà et serait recréée au second essai.
  const pieces = formData.getAll("files").filter((f): f is File => f instanceof File);
  const piecesRefusees = await validateAttachments(pieces);
  if (piecesRefusees) return { ok: false, error: `${piecesRefusees} Aucune demande n'a été créée.` };

  // LA RÉFÉRENCE SE RECALCULE SOUS COLLISION (§118.175, lot E5) : deux demandes déposées à la même seconde lisaient le
  // même maximum, et la seconde échouait sur une erreur brute — mesuré quand deux bancs déposaient ensemble. Le lot
  // (`createRequestBatch`) portait déjà ce filet ; la création unitaire, non. L'entité se lit UNE fois, hors de l'essai.
  const companyId = await companyIdForNew(user.id);
  const created = await createWithRetry(async () => prisma.administrativeRequest.create({
    data: {
      reference: await nextRequestRef(),
      title, type,
      description: fdStr(formData, "description"),
      priority: (fdStr(formData, "priority") as Priority) ?? "MEDIUM",
      deadline: fdDate(formData, "deadline"),
      departmentId: fdStr(formData, "departmentId"),
      fields: { ...collectFields(formData), ...(participants.length ? { participantIds: participants } : {}) },
      requesterId: user.id,
      createdById: user.id,
      companyId,
    },
    select: { id: true, reference: true },
  }));
  const jointes = await attachFiles({
    files: pieces, entityType: "ADMIN_REQUEST", entityId: created.id, uploadedById: user.id, category: "SUPPORTING_DOC",
  });

  // LE SECRÉTARIAT EST PRÉVENU (audit 360°, I10) : chaque assistante de direction ; celle qui commence le
  // traitement en devient responsable (`startRequestProcessing`).
  await notifyRoles(["DIRECTION_ASSISTANT"], { type: "ASSIGNMENT", title: "Nouvelle demande au secrétariat", body: `${created.reference} — ${title}`, link: `/demandes/${created.id}` }).catch(sansBloquer("admin-request-actions.createRequest.notifyRoles"));
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: created.id, summary: `Demande ${created.reference} — ${title}${jointes.saved > 0 ? ` (${jointes.saved} pièce(s) jointe(s))` : ""}` });
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true, id: created.id, ...(jointes.error ? { message: `Demande créée. ${jointes.error}` } : {}) };
}

// ─────────────────────────────── Traitement ───────────────────────────────

/**
 * CHANGER LE STATUT À LA MAIN — seulement ce qui n'a pas d'autre geste (§118.191, audit 360° R12) :
 * attendre un tiers ou un document, être bloqué (et dire pourquoi), reprendre. Le menu offrait les neuf
 * statuts sans condition : « Terminée » contournait la fin gardée, « Annulée » l'annulation commune, et
 * une demande annulée se ressuscitait d'un clic. La règle vit dans `secretariat/statut-manuel.ts`.
 *
 * DEPUIS 10/2026, ELLE REFUSE TOUT (Direction) : l'assistante n'a que deux gestes, « Commencer le
 * traitement » et « Fin du traitement ». La porte reste pour répondre — en nommant ces deux gestes — à
 * qui l'appelle encore (l'assistant, un ancien lien).
 */
export async function updateRequestStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as AdminRequestStatus | null;
  if (!id || !status) return { ok: false, error: "Paramètres manquants." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, requesterId: true, reference: true, status: true, deletedAt: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;

  const motif = fdStr(formData, "blockedReason");
  const refus = refusDuStatutManuel({ courant: req.status, cible: status, motif });
  if (refus) return { ok: false, error: refus };

  // Conditionnelle sur le statut LU : une demande terminée, annulée ou mise en validation entre-temps
  // ne change pas de statut en douce.
  const ecrit = await prisma.administrativeRequest.updateMany({
    where: { id, status: req.status, deletedAt: null },
    data: { status, blockedReason: status === "BLOCKED" ? motif : null },
  });
  if (ecrit.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };

  // Ce que le demandeur lit : le statut par son NOM — jamais l'énumération brute —, et le motif d'un blocage.
  const libelle = ADMIN_REQUEST_STATUS[status]?.label ?? status;
  const phrase = status === "BLOCKED" ? `Demande bloquée — ${motif}` : `Statut : ${libelle}`;
  // Le motif d'un blocage va au FIL de la demande — par l'écrivain du fil, hors du corps de l'action :
  // deux écritures en ligne feraient renoncer la dérivation des contrats à dire ce que `id` désigne.
  if (status === "BLOCKED") {
    await ecrireAuFil({ entityType: "ADMIN_REQUEST", entityId: id, authorId: user.id, body: phrase }).catch(sansBloquer("admin-request-actions.updateRequestStatus.ecrireAuFil"));
  }
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({
      userId: req.requesterId, type: "GENERIC",
      title: status === "BLOCKED" ? "Demande bloquée" : "Demande mise à jour",
      body: `${req.reference} — ${status === "BLOCKED" ? motif : libelle}`, link: `/demandes/${id}`,
    });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: id, field: "status", newValue: status, summary: phrase });
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true };
}

/**
 * ROUVRIR UNE DEMANDE TERMINÉE — avec son motif (§118.191, audit 360° R12). La fin déclarée trop tôt
 * (« la livraison n'est jamais arrivée ») n'avait pas d'autre retour que le menu libre, qui rouvrait
 * aussi une demande ANNULÉE. Seule une demande terminée se rouvre : une annulée a perdu avec elle ses
 * validations et ses paiements, la ressusciter les laisserait derrière. La date de fin part avec la
 * fin ; l'imputation déjà faite reste (la fin suivante ne débite pas une seconde fois).
 */
export async function rouvrirDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, requesterId: true, reference: true, status: true, deletedAt: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const motif = fdStr(formData, "motif");
  const refus = refusDeReouverture({ courant: req.status, motif });
  if (refus) return { ok: false, error: refus };

  const r = await prisma.administrativeRequest.updateMany({ where: { id, status: "DONE", deletedAt: null }, data: { status: "IN_PROGRESS", completedAt: null } });
  if (r.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };
  await ecrireAuFil({ entityType: "ADMIN_REQUEST", entityId: id, authorId: user.id, body: `Demande rouverte — ${motif}` }).catch(sansBloquer("admin-request-actions.rouvrirDemande.ecrireAuFil"));
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Demande rouverte", body: `${req.reference} — ${motif}`, link: `/demandes/${id}` });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, field: "status", newValue: "IN_PROGRESS", summary: `Demande ${req.reference} rouverte — ${motif}` });
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true, message: "Demande rouverte — le demandeur est prévenu." };
}

/**
 * ANNULER UNE DEMANDE, PAR LE SECRÉTARIAT — avec son motif, par l'annulation commune (§118.191, R12) :
 * elle retire aussi la validation, l'approbation et le paiement qui en dépendent (§118.187). Le menu
 * libre écrivait « annulée » et laissait tout le reste vivant. Le demandeur est prévenu : c'est sa
 * demande qui s'arrête.
 */
/**
 * UNE DEMANDE DE DEVIS DE MATÉRIEL PROMOTIONNEL RETIRÉE D'ICI (audit du 04/10, constat 35) : annulée par le
 * secrétariat, par son demandeur, ou supprimée — et que plus aucune demande de devis ne vit pour ce dossier,
 * il revient à l'étape d'avant au lieu de rester « devis demandés » pour toujours. Toutes les portes qui
 * retirent une demande d'ici l'appellent : en oublier une rouvrirait la porte d'à côté (§118.71).
 */
async function apresRetraitDevisPromo(
  req: { linkedEntityType: string | null; linkedEntityId: string | null; type: string }, auteurId: string, motif: string,
): Promise<void> {
  if (req.linkedEntityType !== "PROMO_MATERIAL" || !req.linkedEntityId || req.type !== "QUOTE") return;
  const r = await ramenerSiPlusDeDemandeDevis(req.linkedEntityId, auteurId, motif);
  if (r.ramene) revalidatePath(`/promo-material/${req.linkedEntityId}`);
}

export async function annulerDemandeAuSecretariat(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, requesterId: true, reference: true, status: true, deletedAt: true, linkedEntityType: true, linkedEntityId: true, type: true, title: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };
  // La demande de BC d'un poste Ad & Pro se retire DEPUIS LE POSTE : l'annuler d'ici laisserait le
  // poste attendre un bon de commande que personne n'établira (§118.187).
  if (suitLaDemandeDeBcDuPoste(req)) return { ok: false, error: refusDemandeDeBcDuPoste("annuler") };
  const motif = fdStr(formData, "motif");
  if (motif === null) return { ok: false, error: "Dites pourquoi vous annulez : c'est ce que lira le demandeur." };

  const a = await annulerDemandeSecretariat(id, { acteurId: user.id, motif, cause: "par le secrétariat" });
  if (!a.ok) return { ok: false, error: a.error };
  if (!a.annulee) return { ok: false, error: "Cette demande vient d'être terminée ou annulée : rouvrez-la pour voir où elle en est." };
  await apresRetraitDevisPromo(req, user.id, motif);
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Demande annulée par le secrétariat", body: `${req.reference} — ${motif}`, link: `/demandes/${id}` });
  }
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  if (a.ordresAnnules.length > 0 || a.retraits > 0) revalidatePath("/validations");
  if (a.ordresAnnules.length > 0) revalidatePath("/finances/paiements-a-faire");
  return {
    ok: true,
    message: `Demande ${a.reference} annulée — le demandeur est prévenu${a.ordresAnnules.length ? ` ; paiement(s) ${a.ordresAnnules.join(", ")} annulé(s)` : ""}.${a.reserve ? ` Attention : ${a.reserve}` : ""}`,
  };
}

export async function assignRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const assignedToId = fdStr(formData, "assignedToId");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, reference: true } });
  if (!req || !isManager(user, req.assignedToId)) return DENIED;
  await prisma.administrativeRequest.update({ where: { id }, data: { assignedToId } });
  if (assignedToId && assignedToId !== user.id) {
    await notifyUser({ userId: assignedToId, type: "ASSIGNMENT", title: "Demande qui vous est assignée", body: req.reference, link: `/demandes/${id}` });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: id, summary: "Responsable modifié" });
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes/assistant");
  return { ok: true };
}

// ─────────────────────────────── Validations ───────────────────────────────

export async function requestApproval(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const requestId = fdStr(formData, "requestId");
  const validatorId = fdStr(formData, "validatorId");
  if (!requestId || !validatorId) return { ok: false, error: "Validateur requis." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id: requestId }, select: { assignedToId: true, reference: true, status: true, deletedAt: true } });
  if (!req || req.deletedAt || !isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };

  const amount = fdNum(formData, "amount");
  const approbation = await prisma.adminApproval.create({
    data: { requestId, requestedById: user.id, validatorId, status: "PENDING", comment: fdStr(formData, "comment"), amount: amount ?? undefined },
    select: { id: true },
  });
  // CONDITIONNELLE, puis COMPENSÉE (§118.187) : une annulation passée entre la lecture et l'écriture a
  // déjà retiré les approbations qu'elle voyait — celle-ci, née après, paierait une demande annulée.
  const posee = await prisma.administrativeRequest.updateMany({ where: { id: requestId, ...OUVERTE }, data: { validatorId, status: "AWAITING_VALIDATION" } });
  if (posee.count === 0) {
    await prisma.adminApproval.deleteMany({ where: { id: approbation.id, status: "PENDING" } });
    return { ok: false, error: DEMANDE_CHANGEE };
  }
  // UNE DEMANDE, UNE APPROBATION EN ATTENTE (lot E5). Redemander la validation à quelqu'un d'autre laissait la
  // précédente EN FILE chez son premier validateur : il pouvait encore la trancher — deux accords chiffrés font
  // deux ordres de dépense —, et la fiche, désormais adressée au second, lui refusait l'ouverture. Elle est
  // retirée, sous condition (tranchée entre-temps, elle reste ce qu'elle est), et son validateur le sait.
  const precedentes = await prisma.adminApproval.findMany({
    where: { requestId, status: "PENDING", id: { not: approbation.id } },
    select: { id: true, validatorId: true },
  });
  if (precedentes.length > 0) {
    const nouveau = await prisma.user.findUnique({ where: { id: validatorId }, select: { name: true } });
    for (const p of precedentes) {
      const retiree = await prisma.adminApproval.deleteMany({ where: { id: p.id, status: "PENDING" } });
      if (retiree.count === 0 || !p.validatorId || p.validatorId === user.id || p.validatorId === validatorId) continue;
      await notifyUser({
        userId: p.validatorId, type: "GENERIC", title: "Validation retirée",
        body: `${req.reference} — redemandée à ${nouveau?.name ?? "une autre personne"}`, link: "/demandes/approvals",
      }).catch(sansBloquer("admin-request-actions.requestApproval.notifyUser"));
    }
  }
  await notifyUser({ userId: validatorId, type: "VALIDATION_REQUIRED", title: "Validation demandée", body: `${req.reference}${amount ? ` — ${amount.toLocaleString("fr-FR")} DZD` : ""}`, link: `/demandes/${requestId}` });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: requestId, summary: "Validation demandée" });
  revalidatePath(`/demandes/${requestId}`);
  revalidatePath("/demandes/approvals");
  return { ok: true };
}

/** La phrase d'une validation dont la demande a été annulée — dite avant comme après la prise. */
const VALIDATION_SANS_OBJET = "Cette demande a été annulée : la validation n'a plus d'objet.";

export async function decideApproval(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const approvalId = fdStr(formData, "approvalId");
  const decision = fdStr(formData, "decision") as AdminApprovalStatus | null;
  // UNE DÉCISION ILLISIBLE N'EST PAS UNE DÉCISION (lot E5) : « PENDING », une faute de frappe, un champ perdu en
  // route sont refusés ici — jamais envoyés tels quels à la base, qui les rejetait en erreur brute.
  if (!approvalId || !decision || !estDecisionDApprobation(decision)) return { ok: false, error: "Décision invalide." };
  const approval = await prisma.adminApproval.findUnique({
    where: { id: approvalId },
    include: {
      validator: { select: { name: true } },
      request: { select: { id: true, title: true, requesterId: true, assignedToId: true, reference: true, fields: true, status: true, deletedAt: true } },
    },
  });
  if (!approval) return { ok: false, error: "Validation introuvable." };
  // UNE DEMANDE ANNULÉE OU EFFACÉE NE S'APPROUVE PLUS (§118.187) — l'approbation d'un montant émet un
  // ordre de dépense : sans cette garde, une validation restée en file payait une demande retirée.
  if (approval.request.deletedAt || approval.request.status === "CANCELLED") return { ok: false, error: VALIDATION_SANS_OBJET };
  // LE VALIDATEUR NOMMÉ, SON INTÉRIMAIRE (§118.185 — audit 360°, I18) OU LE SOMMET — jamais sur sa propre
  // demande : remplacer son directeur ne donne pas le droit de s'approuver un achat. Le droit « Valider » du
  // module ne suffit plus (audit du 14/10/2026) : l'assistante tranchait l'achat adressé au N+1 d'un autre.
  const parDroit = approval.validatorId === user.id || isTopManagement(user);
  const parInterim = !parDroit && approval.validatorId !== null && approval.request.requesterId !== user.id
    && (await actsForUser(user.id, approval.validatorId));
  if (!peutTrancherApprobation({ estValidateur: approval.validatorId === user.id, parInterim, sommet: isTopManagement(user) })) {
    return { ok: false, error: `Cette validation est adressée à ${approval.validator?.name ?? "une autre personne"} : seul le validateur, son intérimaire ou la Direction la tranche.` };
  }
  // … ET PERSONNE D'AUTRE NE S'AUTO-VALIDE (lot E5) : le droit « Valider » du module n'en dispense pas — une
  // assistante de direction ou un Directeur des opérations validait son propre achat. Le sommet garde la main,
  // comme dans les circuits de congé et de formation (`approval-chain.ts`).
  if (interditSurSaPropreDemande({ estDemandeur: approval.request.requesterId === user.id, sommet: isTopManagement(user) })) {
    return {
      ok: false,
      error: approval.validatorId === user.id
        ? "On ne valide pas sa propre demande : le secrétariat doit l'adresser à quelqu'un d'autre."
        : `On ne valide pas sa propre demande : c'est à ${approval.validator?.name ?? "la personne désignée"} de trancher.`,
    };
  }
  if (approval.status !== "PENDING") return { ok: false, error: "Cette validation a déjà été tranchée — rechargez la page." };

  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18 — audit des managers, M15). Refuser ou demander une modification
  // renvoie la balle au demandeur : sans motif, il ne sait ni pourquoi, ni quoi corriger — les boutons partaient
  // d'un clic, sans un mot. La règle vit dans `secretariat/decision-approbation.ts`, lue aussi par les boutons ;
  // elle est ICI parce qu'une requête forgée ignore un écran.
  const note = fdStr(formData, "comment");
  const sansMotif = refusSansMotif(decision, note);
  if (sansMotif) return { ok: false, error: sansMotif };

  // UNE SEULE ÉCRITURE, SOUS CONDITION DE TOUT CE QUI A ÉTÉ LU (lot E5) : l'approbation encore en attente ET sa
  // demande encore vivante, au même instant. Une décision prise entre la lecture et le clic ne se prend pas une
  // seconde fois (elle ferait partir un second ordre de dépense) ; une demande annulée entre-temps ne s'approuve pas.
  // QUI A TRANCHÉ (M14) : la décision porte son auteur — le validateur nommé, son intérimaire, l'assistante ou la
  // Direction. Sa parole va dans `decisionNote`, plus dans `comment` : celui-ci est la parole du demandeur
  // (l'estimation du catalogue, la note de l'assistante), que la décision écrasait, ou qu'elle laissait se lire
  // comme l'avis du directeur quand elle n'avait rien à dire.
  const pris = await prisma.adminApproval.updateMany({
    where: { id: approvalId, status: "PENDING", request: { deletedAt: null, status: { not: "CANCELLED" } } },
    data: { status: decision, decisionNote: note, decidedById: user.id, decidedAt: new Date() },
  });
  if (pris.count === 0) {
    const apres = await prisma.adminApproval.findUnique({ where: { id: approvalId }, select: { status: true } });
    return {
      ok: false,
      error: !apres
        ? "Cette validation vient d'être retirée : la demande a été annulée, retirée par son auteur ou redemandée à quelqu'un d'autre — rechargez la page."
        : apres.status !== "PENDING"
          ? "Cette validation vient d'être tranchée par quelqu'un d'autre — rechargez la page."
          : VALIDATION_SANS_OBJET,
    };
  }

  const req = approval.request;
  let reqStatus: AdminRequestStatus = "IN_PROGRESS";
  let ordre: { id: string } | null = null;
  if (decision === "APPROVED") {
    const amt = approval.amount ? Number(approval.amount) : 0;
    if (amt > 0) {
      const fields = (req.fields as Record<string, unknown> | null) ?? {};
      ordre = await createExpenseOrder({
        label: `Demande ${req.reference} — ${req.title}`,
        amount: amt, category: "AUTRE",
        beneficiary: (fields.beneficiaire as string) ?? req.title,
        sourceType: "ADMIN_REQUEST", sourceId: req.id, requestedById: user.id,
      });
      reqStatus = "AWAITING_PAYMENT";
    }
  } else if (decision === "REJECTED") {
    reqStatus = "BLOCKED";
  }
  // Jamais une demande TERMINÉE (§118.187) : une approbation tranchée après la fin ne la ressuscite pas
  // — la même règle que la validation (`decideValidation`). L'ordre de dépense, lui, part : le montant
  // a bien été autorisé.
  const suivie = await prisma.administrativeRequest.updateMany({ where: { id: req.id, ...OUVERTE }, data: { status: reqStatus } });
  // UNE ANNULATION ARRIVÉE PENDANT LA DÉCISION (lot E5 — R2). La prise ci-dessus a lu une demande vivante ; une
  // annulation passée APRÈS elle, mais avant la naissance de l'ordre, ne pouvait pas voir cet ordre — il serait
  // resté payable pour une demande retirée. On relit la demande : annulée, l'ordre émis est annulé par la porte
  // unique (conditionnelle : un ordre déjà réglé n'est jamais défait), et la décision le DIT.
  if (suivie.count === 0 && ordre) {
    const maintenant = await prisma.administrativeRequest.findUnique({ where: { id: req.id }, select: { status: true, deletedAt: true } });
    if (!maintenant || maintenant.deletedAt || maintenant.status === "CANCELLED") {
      const retrait = await annulerOrdreNonRegle(ordre.id, { acteurId: user.id, motif: `demande ${req.reference} annulée pendant la décision` });
      return {
        ok: false,
        error: retrait.ok
          ? "La demande vient d'être annulée pendant votre décision : votre accord est enregistré, mais le paiement qu'il émettait a été annulé — rechargez la page."
          : `La demande vient d'être annulée pendant votre décision, et le paiement qu'il émettait n'a pas pu être annulé : ${retrait.error}`,
      };
    }
  }

  // CE QUE LE DEMANDEUR LIT : la décision par son nom, et le motif — ce qu'il doit corriger, ou comprendre.
  // Une seule notification quand le demandeur est aussi le responsable de la demande.
  for (const uid of new Set([req.assignedToId, req.requesterId])) {
    if (uid && uid !== user.id) await notifyUser({ userId: uid, type: "GENERIC", title: LIBELLE_DECISION[decision], body: `${req.reference}${note ? ` — ${note}` : ""}`, link: `/demandes/${req.id}` });
  }
  // UNE DEMANDE VALIDÉE SANS RESPONSABLE REVIENT AU SECRÉTARIAT (audit 360°, I10) : le N+1 disait
  // oui, et personne au bureau ne l'apprenait — l'achat attendait qu'on tombe dessus.
  if (decision === "APPROVED" && !req.assignedToId) {
    await notifyRoles(["DIRECTION_ASSISTANT"], { type: "ASSIGNMENT", title: "Demande validée — à traiter", body: `${req.reference} — ${req.title}`, link: `/demandes/${req.id}` }).catch(sansBloquer("admin-request-actions.decideApproval.notifyRoles"));
  }
  await recordAudit({
    actorId: user.id,
    action: decision === "APPROVED" ? "VALIDATE" : decision === "REJECTED" ? "REFUSE" : "UPDATE",
    module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: req.id,
    // Le journal DIT qu'une décision a été prise au titre d'un intérim — la mention de `decideValidation` : sans
    // elle, on relirait « Untel a validé » sans comprendre pourquoi ce n'est pas le validateur désigné.
    summary: `${LIBELLE_DECISION[decision]}${note ? ` — ${note}` : ""}${parInterim ? ` (par l'intérimaire de ${approval.validator?.name ?? "la personne désignée"})` : ""}`,
  });
  // LE JOURNAL DES ACHATS suit la décision, pas seulement le dépôt : « qui a dit oui » est la
  // moitié de la question qu'on lui pose. Il ignore de lui-même les demandes d'une autre nature.
  await journaliserDemandeAchat({
    requestId: req.id,
    event: decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "CHANGES_REQUESTED",
    actorId: user.id,
    note,
  });
  revalidatePath(`/demandes/${req.id}`);
  revalidatePath("/demandes/approvals");
  revalidatePath("/finances/paiements-a-faire");
  return { ok: true };
}

// ─────────────────────────────── Missions chauffeur ───────────────────────────────

// LES MISSIONS CHAUFFEUR NE SE CRÉENT PLUS (Direction, 10/2026) — `createMission` est retirée. Les courses déjà
// posées se lisent, et le chauffeur les mène à leur terme (`toggleMissionStop`, `updateMission`).

/** Coche / décoche un point de passage d'une course (chauffeur assigné ou gestionnaire). */
export async function toggleMissionStop(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const stop = await prisma.driverMissionStop.findUnique({
    where: { id },
    select: { done: true, mission: { select: { id: true, assignedToId: true } } },
  });
  if (!stop) return { ok: false, error: "Point introuvable." };
  const allowed = stop.mission.assignedToId === user.id || hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  if (!allowed) return DENIED;
  const done = !stop.done;
  await prisma.driverMissionStop.update({ where: { id }, data: { done, doneAt: done ? new Date() : null } });
  revalidatePath("/demandes/driver");
  revalidatePath("/demandes/courses");
  return { ok: true };
}

export async function updateMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as DriverMissionStatus | null;
  if (!id || !status) return { ok: false, error: "Paramètres manquants." };
  const mission = await prisma.driverMission.findUnique({ where: { id }, select: { assignedToId: true, requestId: true, title: true } });
  if (!mission) return { ok: false, error: "Mission introuvable." };
  const allowed = mission.assignedToId === user.id || hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  if (!allowed) return DENIED;

  const data: { status: DriverMissionStatus; proofComment?: string | null; startedAt?: Date; completedAt?: Date } = { status, proofComment: fdStr(formData, "proofComment") };
  if (status === "EN_ROUTE" || status === "ACCEPTED") data.startedAt = new Date();
  if (status === "DONE") data.completedAt = new Date();
  await prisma.driverMission.update({ where: { id }, data });

  if ((status === "DONE" || status === "PROBLEM") && mission.requestId) {
    const req = await prisma.administrativeRequest.findUnique({ where: { id: mission.requestId }, select: { assignedToId: true, reference: true } });
    if (req?.assignedToId && req.assignedToId !== user.id) {
      await notifyUser({ userId: req.assignedToId, type: "GENERIC", title: `Mission ${status === "DONE" ? "terminée" : "— problème"}`, body: mission.title, link: `/demandes/${mission.requestId}` });
    }
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Demandes administratives", entityType: "DRIVER_MISSION", entityId: id, field: "status", newValue: status, summary: `Mission → ${status}` });
  revalidatePath("/demandes/driver");
  if (mission.requestId) revalidatePath(`/demandes/${mission.requestId}`);
  return { ok: true };
}

// ─────────────────────────────── Commentaires ───────────────────────────────

export async function addRequestComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const requestId = fdStr(formData, "requestId");
  const body = fdStr(formData, "body");
  if (!requestId || !body) return { ok: false, error: "Commentaire vide." };
  // LA CLAUSE DE LA FICHE (§118.184 — audit 360°, S12) : sans elle, n'importe quel compte commentait toute
  // demande par son identifiant, et la notification partait chez le demandeur. Hors de portée, la même
  // phrase que l'absence.
  const req = await prisma.administrativeRequest.findFirst({ where: await clauseDemandeLisible(user, requestId), select: { requesterId: true, assignedToId: true } });
  if (!req) return { ok: false, error: "Demande introuvable." };

  await prisma.comment.create({ data: { entityType: "ADMIN_REQUEST", entityId: requestId, body, authorId: user.id } });
  // QUI LIT CE COMMENTAIRE (audit 360°, R09). Le demandeur parle au SECRÉTARIAT : son responsable
  // désigné, sinon chaque assistante — les demandes ouvertes par un poste naissent sans responsable,
  // et notifier le seul `assignedToId` revenait à ne prévenir personne sur le seul canal de correction
  // qui restait. Quelqu'un d'autre (l'assistante, un validateur) parle au demandeur ET au responsable.
  const avis = { type: "GENERIC" as const, title: "Nouveau commentaire", body: body.slice(0, 80), link: `/demandes/${requestId}` };
  if (user.id === req.requesterId) {
    await prevenirLeSecretariat(req.assignedToId, avis, user.id);
  } else {
    for (const uid of new Set([req.requesterId, req.assignedToId])) {
      if (uid && uid !== user.id) await notifyUser({ userId: uid, ...avis });
    }
  }
  revalidatePath(`/demandes/${requestId}`);
  return { ok: true };
}

// LA DEMANDE MULTIPLE N'EXISTE PLUS (Direction, 10/2026) — `createRequestBatch` est retirée : une demande par
// besoin. Les lots déjà déposés se lisent : chaque demande garde son `batchId`, la fiche montre ses voisines.

// ─────────────────────────── Le demandeur corrige ou annule (§118.187) ───────────────────────────

const PRIORITIES_DEMANDE: readonly Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const enTexte = (f: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));

/**
 * LE DEMANDEUR CORRIGE SA DEMANDE tant qu'elle n'est ni terminée ni annulée (audit 360°, R08). Dans
 * les trente premières minutes, si personne ne l'a commencée, sans déranger personne ; au-delà,
 * l'assistante est prévenue et la discussion garde ce qui a changé. Fermé, avec son remède : pendant
 * une validation, et quand un paiement est déjà émis (`refusDeModification`).
 *
 * CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c). L'ancien remplacement intégral des
 * champs saisis effaçait tout ce qui vit dans le même JSON sans être un champ du formulaire — les
 * LIGNES d'une demande d'achat, son total estimé —, et une correction de l'échéance effaçait la
 * description et remettait la priorité à « moyenne ». Une clé portée vide efface, une clé absente garde.
 */
export async function editOwnRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    select: {
      requesterId: true, status: true, createdAt: true, processingStartedAt: true, deletedAt: true, assignedToId: true,
      reference: true, type: true, title: true, description: true, priority: true, deadline: true, fields: true, linkedEntityType: true,
    },
  });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  const porte = porteDuDemandeur(req, user.id, Date.now());
  if (!porte.ok) return { ok: false, error: porte.raison };
  if (suitLaDemandeDeBcDuPoste(req)) return { ok: false, error: refusDemandeDeBcDuPoste("corriger") };
  const [validations, approbations, ordres] = await Promise.all([
    prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id, documentId: null, status: "PENDING" } }),
    prisma.adminApproval.count({ where: { requestId: id, status: "PENDING" } }),
    prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: { not: "CANCELLED" } } }),
  ]);
  const refus = refusDeModification({ validationEnCours: validations + approbations > 0, paiementEmis: ordres > 0 });
  if (refus) return { ok: false, error: refus };

  const title = formData.has("title") ? fdStr(formData, "title") : req.title;
  if (title === null) return { ok: false, error: "Le titre est obligatoire." };
  const prioriteLue = formData.has("priority") ? fdStr(formData, "priority") : null;
  const priority = PRIORITIES_DEMANDE.find((p) => p === prioriteLue) ?? req.priority;
  const description = formData.has("description") ? fdStr(formData, "description") : req.description;
  const deadline = formData.has("deadline") ? fdDate(formData, "deadline") : req.deadline;
  const existants = req.fields && typeof req.fields === "object" && !Array.isArray(req.fields) ? (req.fields as Record<string, unknown>) : {};
  const fields: Record<string, unknown> = { ...existants };
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("f_") || typeof v !== "string") continue;
    const val = v.trim();
    if (val) fields[k.slice(2)] = val;
    else delete fields[k.slice(2)];
  }

  const avant: ContenuDemande = { title: req.title, description: req.description, priority: req.priority, deadline: jour(req.deadline), fields: enTexte(existants) };
  const apres: ContenuDemande = { title, description, priority, deadline: jour(deadline), fields: enTexte(fields) };
  const changes = changementsDeLaDemande(avant, apres, fieldLabels(req.type));
  if (changes.length === 0) return { ok: true, message: "Rien n'a changé." };

  // Sous condition : annulée ou terminée entre la lecture et l'écriture, elle ne se réécrit plus.
  const ecrite = await prisma.administrativeRequest.updateMany({
    where: { id, ...OUVERTE },
    data: { title, description, priority, deadline, fields: fields as Prisma.InputJsonValue },
  });
  if (ecrite.count === 0) return { ok: false, error: DEMANDE_CHANGEE };
  const quoi = changes.join(", ");
  const resoumise = await resoumettreApresModification(id, req.reference, user.id, quoi);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id,
    summary: `Demande ${req.reference} corrigée par son demandeur${porte.discret ? " (fenêtre discrète)" : ""} — ${quoi}`,
  });
  if (!porte.discret) {
    await prisma.comment.create({ data: { entityType: "ADMIN_REQUEST", entityId: id, body: `Demande corrigée par son demandeur : ${quoi}.`, authorId: user.id } });
    await prevenirLeSecretariat(req.assignedToId, {
      type: "GENERIC", title: "Demande corrigée par son demandeur", body: `${req.reference} — ${quoi}`, link: `/demandes/${id}`,
    }, user.id);
  }
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  if (resoumise) {
    revalidatePath("/demandes/approvals");
    return { ok: true, message: `Demande corrigée — elle repart chez ${resoumise} pour validation.` };
  }
  return { ok: true, message: porte.discret ? "Demande modifiée." : `Demande modifiée — l'assistante est prévenue (${quoi}).` };
}

/**
 * LA CORRECTION REPART CHEZ LE VALIDATEUR (audit du 14/10/2026). Après « modification demandée », la demande corrigée
 * revenait à l'assistante, qui pouvait acheter sans nouvelle validation. Quand la DERNIÈRE approbation demandait une
 * modification, la correction du demandeur rouvre une approbation EN ATTENTE chez le même validateur, au même montant.
 * Conditionnelle puis compensée, comme `requestApproval` : une demande close entre-temps ne repart pas.
 * Rend le nom du validateur quand la demande est repartie, `null` sinon.
 */
async function resoumettreApresModification(requestId: string, reference: string, auteurId: string, quoi: string): Promise<string | null> {
  const derniere = await prisma.adminApproval.findFirst({
    where: { requestId }, orderBy: { createdAt: "desc" },
    select: { status: true, validatorId: true, amount: true, comment: true, validator: { select: { name: true, isActive: true } } },
  });
  if (!derniere || derniere.status !== "CHANGES_REQUESTED" || !derniere.validatorId || derniere.validator?.isActive === false) return null;
  const nouvelle = await prisma.adminApproval.create({
    data: {
      requestId, requestedById: auteurId, validatorId: derniere.validatorId, status: "PENDING",
      comment: derniere.comment, amount: derniere.amount ?? undefined,
    },
    select: { id: true },
  });
  const posee = await prisma.administrativeRequest.updateMany({
    where: { id: requestId, ...OUVERTE }, data: { validatorId: derniere.validatorId, status: "AWAITING_VALIDATION" },
  });
  if (posee.count === 0) {
    await prisma.adminApproval.deleteMany({ where: { id: nouvelle.id, status: "PENDING" } });
    return null;
  }
  await notifyUser({
    userId: derniere.validatorId, type: "VALIDATION_REQUIRED", title: "Demande corrigée — à revalider",
    body: `${reference} — ${quoi}`, link: `/demandes/${requestId}`,
  }).catch(sansBloquer("admin-request-actions.resoumettreApresModification.notifyUser"));
  await recordAudit({
    actorId: auteurId, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: requestId,
    summary: `Demande ${reference} corrigée et resoumise à ${derniere.validator?.name ?? "son validateur"}`,
  });
  return derniere.validator?.name ?? "son validateur";
}

/**
 * LE DEMANDEUR RETIRE SA DEMANDE (audit 360°, R08). Dans la fenêtre discrète, elle s'efface sans bruit,
 * comme avant : personne n'y a rien fait. Au-delà, elle se CLÔT avec son motif — elle n'est plus effacée,
 * parce que quelqu'un a peut-être déjà travaillé dessus — et ce qui en dépend part avec elle : validations
 * en attente, approbations, paiement non réglé (`annulerDemandeSecretariat`). Un paiement réglé refuse.
 */
export async function deleteOwnRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    select: { requesterId: true, status: true, createdAt: true, processingStartedAt: true, reference: true, deletedAt: true, linkedEntityType: true, linkedEntityId: true, type: true, title: true },
  });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  const porte = porteDuDemandeur(req, user.id, Date.now());
  if (!porte.ok) return { ok: false, error: porte.raison };
  if (suitLaDemandeDeBcDuPoste(req)) return { ok: false, error: refusDemandeDeBcDuPoste("annuler") };

  if (porte.discret) {
    const r = await prisma.administrativeRequest.updateMany({
      where: { id, deletedAt: null, status: "NEW", processingStartedAt: null },
      data: { deletedAt: new Date(), deletedById: user.id, deletionReason: "Supprimée par le demandeur (≤ 30 min)", status: "CANCELLED", cancelledAt: new Date() },
    });
    if (r.count === 0) return { ok: false, error: "L'assistante vient de commencer cette demande : rouvrez-la — elle s'annule désormais avec un motif." };
    await recordAudit({ actorId: user.id, action: "DELETE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, summary: `Demande ${req.reference} supprimée par le demandeur` });
    await apresRetraitDevisPromo(req, user.id, "demande supprimée par son demandeur");
    revalidatePath("/demandes");
    revalidatePath("/demandes/assistant");
    return { ok: true };
  }

  const motif = fdStr(formData, "motif");
  if (motif === null) return { ok: false, error: "Dites pourquoi vous annulez : l'assistante a peut-être déjà commencé, et c'est ce qu'elle lira." };
  const a = await annulerDemandeSecretariat(id, { acteurId: user.id, motif, cause: "par son demandeur" });
  if (!a.ok) return { ok: false, error: a.error };
  if (!a.annulee) return { ok: false, error: "Cette demande vient d'être terminée ou annulée : rouvrez-la pour voir où elle en est." };
  await apresRetraitDevisPromo(req, user.id, motif);
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  if (a.ordresAnnules.length > 0 || a.retraits > 0) revalidatePath("/validations");
  if (a.ordresAnnules.length > 0) revalidatePath("/finances/paiements-a-faire");
  const suites = [
    a.retraits > 0 ? `${a.retraits} validation${a.retraits > 1 ? "s" : ""} retirée${a.retraits > 1 ? "s" : ""}` : null,
    a.ordresAnnules.length > 0 ? `paiement${a.ordresAnnules.length > 1 ? "s" : ""} ${a.ordresAnnules.join(", ")} annulé${a.ordresAnnules.length > 1 ? "s" : ""}` : null,
  ].filter(Boolean);
  return {
    ok: true,
    message: `Demande ${a.reference} annulée — l'assistante est prévenue${suites.length ? ` ; ${suites.join(", ")}` : ""}.${a.reserve ? ` Attention : ${a.reserve}` : ""}`,
  };
}

// ─────────────────────────── Suppression traçable (assistante) ───────────────────────────

/** L'assistante supprime une ou plusieurs demandes — soft delete + motif obligatoire. */
export async function deleteRequests(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE"))) return DENIED;
  const ids = (fdStr(formData, "ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Aucune demande sélectionnée." };
  const reason = fdStr(formData, "reason");
  if (!reason) return { ok: false, error: "Le motif de suppression est obligatoire (traçabilité)." };

  const lues = await prisma.administrativeRequest.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, reference: true, linkedEntityType: true, linkedEntityId: true, type: true, title: true, status: true } });
  if (lues.length === 0) return { ok: false, error: "Demande(s) introuvable(s)." };

  // SUPPRIMER, C'EST D'ABORD ANNULER CE QUI EN DÉPEND (audit du 14/10/2026). La suppression posait `deletedAt` et
  // laissait vivre l'ordre de dépense et les validations : l'ordre restait payable au centre pour une demande que
  // plus personne ne voyait. Une demande encore ouverte passe donc par la MÊME porte que l'annulation
  // (`annulerDemandeSecretariat` : validations et approbations retirées, ordres non réglés annulés) ; un paiement
  // déjà réglé la refuse, comme il refuse l'annulation. Une demande close ne garde aucun ordre en vol.
  const targets: typeof lues = [];
  const refus: string[] = [];
  for (const t of lues) {
    if (suitLaDemandeDeBcDuPoste(t)) { refus.push(`${t.reference} : ${refusDemandeDeBcDuPoste("annuler")}`); continue; }
    if (t.status !== "DONE" && t.status !== "CANCELLED") {
      const a = await annulerDemandeSecretariat(t.id, { acteurId: user.id, motif: reason, cause: "par sa suppression" });
      if (!a.ok) { refus.push(a.error); continue; }
    } else {
      const enVol = await prisma.expenseOrder.findFirst({
        where: { sourceType: "ADMIN_REQUEST", sourceId: t.id, status: { notIn: ["CANCELLED", "PAID"] } }, select: { reference: true },
      });
      if (enVol) { refus.push(`${t.reference} : son paiement ${enVol.reference} est encore en cours — annulez-le au centre de paiement d'abord.`); continue; }
    }
    targets.push(t);
  }
  if (targets.length === 0) return { ok: false, error: refus.join(" ") };

  await prisma.administrativeRequest.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { deletedAt: new Date(), deletedById: user.id, deletionReason: reason },
  });
  for (const t of targets) {
    await recordAudit({ actorId: user.id, action: "DELETE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: t.id, newValue: reason, summary: `Demande ${t.reference} supprimée — motif : ${reason}` });
    await apresRetraitDevisPromo(t, user.id, reason);
  }
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  revalidatePath("/validations");
  revalidatePath("/finances/paiements-a-faire");
  if (refus.length > 0) return { ok: true, message: `${targets.length} demande(s) supprimée(s). Non supprimée(s) : ${refus.join(" ")}` };
  return { ok: true };
}

/** Restaure une demande supprimée (assistante / super admin). */
export async function restoreRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE"))) return DENIED;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { reference: true, status: true, requesterId: true, deletedById: true, processingStartedAt: true } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  // RESTAURER N'EST PAS RESSUSCITER (§118.191). La restauration remettait TOUTE demande « nouvelle » :
  // une demande terminée redevenait à traiter, une demande annulée — dont l'annulation avait retiré les
  // validations et les paiements — repartait sans eux. Seule la suppression DISCRÈTE du demandeur
  // (≤ 30 min, jamais commencée) passait la demande « annulée » en la supprimant : elle seule revient
  // « nouvelle ». Toute autre demande revient dans l'état où on l'a supprimée.
  const suppressionDiscrete = req.status === "CANCELLED" && req.deletedById === req.requesterId && req.processingStartedAt === null;
  await prisma.administrativeRequest.update({
    where: { id },
    data: { deletedAt: null, deletedById: null, deletionReason: null, ...(suppressionDiscrete ? { status: "NEW", cancelledAt: null } : {}) },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, summary: `Demande ${req.reference} restaurée` });
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true };
}

// ─────────────────────────── Flux de traitement (assistante) ───────────────────────────

/** « Commencer le traitement » : passe la demande en cours et fige la fenêtre demandeur. */
export async function startRequestProcessing(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, requesterId: true, status: true, reference: true, deletedAt: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };

  // QUI COMMENCE EN DEVIENT RESPONSABLE, si personne ne l'était (audit 360°, R09) : sans responsable, le
  // commentaire du demandeur repartait vers tout le secrétariat alors qu'une personne précise avait la main.
  const r = await prisma.administrativeRequest.updateMany({
    where: { id, ...OUVERTE },
    data: { status: "IN_PROGRESS", processingStartedAt: new Date(), ...(req.assignedToId ? {} : { assignedToId: user.id }) },
  });
  if (r.count === 0) return { ok: false, error: DEMANDE_CHANGEE };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, field: "status", newValue: "IN_PROGRESS", summary: req.assignedToId ? "Traitement démarré" : "Traitement démarré — responsable : la personne qui l'a commencé" });
  // LE DEMANDEUR LIT « EN COURS — chez l'assistante de direction » (Direction, 10/2026).
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Demande en cours", body: `${req.reference} — en cours, chez l'assistante de direction`, link: `/demandes/${id}` }).catch(sansBloquer("admin-request-actions.startRequestProcessing.notifyUser"));
  }
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true };
}

/**
 * « Demande de validation des Finances » (flux achat). Crée une demande de
 * validation dans le bureau central « Demandes de validations » à destination de
 * l'équipe Finances, rattachée à la demande. Va-et-vient possible : en cas de refus
 * ou de modification demandée, l'assistante peut renvoyer une nouvelle validation.
 */
export async function requestFinanceValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, reference: true, title: true, status: true } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };

  // Validateurs Finances : choisis dans le formulaire, sinon tous les responsables Finances.
  let validatorIds = [fdStr(formData, "validatorId"), fdStr(formData, "validator2Id")].filter((v): v is string => Boolean(v));
  if (validatorIds.length === 0) {
    const finance = await prisma.user.findMany({ where: { isActive: true, role: "FINANCE_BUDGET_MANAGER" }, select: { id: true } });
    validatorIds = finance.map((f) => f.id);
  }
  if (validatorIds.length === 0) return { ok: false, error: "Aucun responsable Finances disponible. Choisissez un validateur." };

  const amount = fdNum(formData, "amount");
  const note = fdStr(formData, "comment");
  const res = await createDirectValidation({
    requesterId: user.id,
    title: `Achat — ${req.reference} : ${req.title}`,
    description: [note, amount ? `Montant estimé : ${amount.toLocaleString("fr-FR")} DZD` : null].filter(Boolean).join(" — ") || null,
    module: "Finances",
    link: `/demandes/${id}`,
    validatorIds,
    entityType: "ADMIN_REQUEST",
    entityId: id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // CONDITIONNELLE, puis COMPENSÉE (§118.187) : annulée entre la lecture et l'écriture, la demande a
  // déjà retiré les validations qu'elle voyait — celle-ci, née après, resterait en file pour rien.
  const posee = await prisma.administrativeRequest.updateMany({ where: { id, ...OUVERTE }, data: { status: "AWAITING_VALIDATION" } });
  if (posee.count === 0) {
    if (res.requestId) await retirerValidationSansObjet(res.requestId);
    return { ok: false, error: DEMANDE_CHANGEE };
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, summary: `Validation Finances demandée (${res.reference})` });
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/validations");
  return { ok: true };
}

/**
 * « Demander une validation » (flux hors achat). L'assistante estime qui doit
 * valider (opérations, direction, autre) — ou personne. Routé vers le bureau
 * central « Demandes de validations ».
 */
export async function requestInternalValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({ where: { id }, select: { assignedToId: true, reference: true, title: true, status: true } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };

  const validatorIds = [fdStr(formData, "validatorId"), fdStr(formData, "validator2Id")].filter((v): v is string => Boolean(v));
  if (validatorIds.length === 0) return { ok: false, error: "Choisissez au moins un validateur." };

  const res = await createDirectValidation({
    requesterId: user.id,
    title: `${req.reference} : ${req.title}`,
    description: fdStr(formData, "comment"),
    module: "Bureau du secrétariat",
    link: `/demandes/${id}`,
    validatorIds,
    entityType: "ADMIN_REQUEST",
    entityId: id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // CONDITIONNELLE, puis COMPENSÉE (§118.187) : annulée entre la lecture et l'écriture, la demande a
  // déjà retiré les validations qu'elle voyait — celle-ci, née après, resterait en file pour rien.
  const posee = await prisma.administrativeRequest.updateMany({ where: { id, ...OUVERTE }, data: { status: "AWAITING_VALIDATION" } });
  if (posee.count === 0) {
    if (res.requestId) await retirerValidationSansObjet(res.requestId);
    return { ok: false, error: DEMANDE_CHANGEE };
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, summary: `Validation interne demandée (${res.reference})` });
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/validations");
  return { ok: true };
}

/**
 * « Fin de la demande ». Pour un achat, exige la facture finale — là où l'écran de la demande la range (lot E5) :
 * un fichier « Facture » dans « Documents », une facture du registre créée par « Pièces liées → Facture » ou qui
 * suit un bon de commande de la demande, ou la facture de l'un de ses ordres de dépense.
 */
export async function finishRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    select: { assignedToId: true, requesterId: true, type: true, reference: true, title: true, linkedEntityType: true, linkedEntityId: true, status: true },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!isManager(user, req.assignedToId)) return DENIED;
  const close = refusDemandeClose(req.status);
  if (close) return { ok: false, error: close };
  // LA DERNIÈRE DÉCISION DU VALIDATEUR FAIT FOI (audit du 14/10/2026) : un achat refusé ne se termine pas (il
  // s'imputait au budget), un achat renvoyé pour modification ne s'achète pas avant d'être revalidé.
  const derniere = await prisma.adminApproval.findFirst({ where: { requestId: id }, orderBy: { createdAt: "desc" }, select: { status: true } });
  const apresDecision = refusFinApresDecision(derniere);
  if (apresDecision) return { ok: false, error: apresDecision };
  if (req.linkedEntityType === "PROMO_MATERIAL" && req.linkedEntityId && req.type === "QUOTE") {
    const dossier = await prisma.promoMaterial.findUnique({ where: { id: req.linkedEntityId }, select: { circuitState: true } });
    const devisPromo = refusFinDevisPromo(dossier?.circuitState ?? null);
    if (devisPromo) return { ok: false, error: devisPromo };
  }

  // « TERMINER » ATTEND LA SIGNATURE DU BC (devis natifs, Direction 10/2026) : un bon de commande de la demande encore
  // au centre, à signer ou renvoyé n'engage pas la société — la demande se termine une fois le BC « signé et validé ».
  const bcsDeLaDemande = await prisma.legalDocument.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, kind: "PURCHASE_ORDER" }, select: { id: true } });
  if (bcsDeLaDemande.length > 0) {
    const etats = await etatsDesBC(bcsDeLaDemande.map((b) => b.id));
    const refusBC = refusFinBCEnRoute([...etats.values()].map((e) => ({ reference: e.reference, etape: e.etape, annule: e.annule })));
    if (refusBC) return { ok: false, error: refusBC };
  }

  // LA FACTURE DANS LA MÊME FENÊTRE (refonte du bureau, 10/2026) : « Terminer » demande la facture et l'imputation
  // ensemble. Jointe ici, elle est rangée parmi les pièces de la demande (catégorie « Facture ») AVANT la règle
  // ci-dessous, qui la trouve donc là où elle la cherche déjà.
  const factureJointe = formData.getAll("facture").find((v): v is File => v instanceof File && v.size > 0) ?? null;
  if (factureJointe) {
    const refusFacture = await joindreFactureALaDemande(user, id, factureJointe);
    if (refusFacture) return { ok: false, error: refusFacture.error, ...(refusFacture.factureConnue ? { factureConnue: refusFacture.factureConnue } : {}) };
  }

  // LA FACTURE SE LIT LÀ OÙ L'ÉCRAN LA RANGE (lot E5). La règle ne regardait que les fichiers « Facture » de la
  // demande ; la même fiche propose « Pièces liées → Facture » (« elle restera liée à cette demande »), qui la
  // range AU REGISTRE avec son PDF — une demande dont la facture était parfaitement rangée là ne se terminait
  // jamais : « uploadez d'abord la facture » à qui l'avait jointe. Une seule règle, celle des ordres
  // (`finance/facture-ordre.ts`) : une facture annulée, ou sans son fichier, ne compte pas.
  if (req.type === "PURCHASE" && !(await ficheAFacture({ entityType: "ADMIN_REQUEST", entityId: id }))) {
    return {
      ok: false,
      error: "Pour un achat, joignez la facture finale : dans cette fenêtre, ou dans « Pièces » (« + Ajouter une pièce » → Facture) — une facture au registre (« Pièces liées → Facture ») compte aussi, avec son PDF. Une facture annulée, ou enregistrée sans son fichier, ne compte pas.",
    };
  }

  // IMPUTATION AUX MOYENS GÉNÉRAUX — le geste qui manquait entre « la demande est faite » et
  // « le budget le sait ».
  //
  // Terminer un achat sans dire QUI le paie laissait le budget des moyens généraux intact
  // pendant que l'argent, lui, était sorti. L'assistante choisit donc le département à
  // débiter : le sien, ou celui qui a demandé — chaque département a SES moyens généraux, et
  // c'est le demandeur qui les consomme, pas le secrétariat qui exécute.
  //
  // EXCEPTION : ce qui vient d'Ad & Pro est déjà porté par le budget de l'opération (poste,
  // ordre de dépense). L'imputer une seconde fois le compterait deux fois.
  //
  // La liste était écrite À LA MAIN ici — cinq natures — pendant que la page de la même demande
  // en lisait huit : sur un achat lié à un POSTE, l'écran masquait l'imputation et cette action
  // l'exigeait, donc la demande ne pouvait plus être terminée (§118.150). Une seule fonction.
  const fromAdPro = dejaPorteParSaFiche(req.linkedEntityType);
  const departmentId = fdStr(formData, "budgetDepartmentId");
  const amount = fdNum(formData, "budgetAmount");
  const alreadyImputed = await prisma.departmentBudgetExpense.count({ where: { adminRequestId: id } });

  if (req.type === "PURCHASE" && !fromAdPro && alreadyImputed === 0 && (!departmentId || !amount)) {
    return {
      ok: false,
      error: "Choisissez le budget de moyens généraux à débiter (le vôtre ou celui du département concerné) et le montant réellement dépensé.",
    };
  }

  const imputer = departmentId != null && amount != null && alreadyImputed === 0;
  if (imputer && amount < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const dept = imputer ? await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true } }) : null;
  if (imputer && !dept) return { ok: false, error: "Département introuvable." };

  // LA DEMANDE EST PRISE AVANT L'IMPUTATION, sous condition (§118.187) : annulée entre la lecture et
  // l'écriture, elle ne repasse pas « terminée », et aucun budget n'est débité pour elle.
  const prise = await prisma.administrativeRequest.updateMany({ where: { id, ...OUVERTE }, data: { status: "DONE", completedAt: new Date() } });
  if (prise.count === 0) return { ok: false, error: DEMANDE_CHANGEE };

  if (imputer && dept) {
    await prisma.departmentBudgetExpense.create({
      data: {
        departmentId: dept.id,
        year: new Date().getFullYear(),
        kind: "OPERATING",
        label: `${req.reference} — ${req.title}`,
        amount,
        notes: fdStr(formData, "budgetNote"),
        adminRequestId: id,
        createdById: user.id,
      },
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Bureau du secrétariat",
      entityType: "ADMIN_REQUEST", entityId: id,
      summary: `Imputée aux moyens généraux de ${dept.name} — ${amount} DZD`,
    });
    revalidatePath("/moyens-generaux");
    revalidatePath("/budgets/departements");
  }

  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id, field: "status", newValue: "DONE", summary: "Fin du traitement" });
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Demande traitée", body: `${req.reference} — ${req.title}`, link: `/demandes/${id}` }).catch(sansBloquer("admin-request-actions.finishRequest.notifyUser"));
  }
  // L'ARCHIVE DANS LE DRIVE (« Dossier traité ») — elle n'était faite que par le menu libre, c'est-à-dire
  // par le seul chemin qui contournait les gardes de cette fin (§118.191, audit R12). Une fois, jamais
  // bloquante : la demande est terminée même si l'archive échoue.
  await archiveAdminRequestIfDone(id, user.id).catch((e) => console.error("[admin-request] archive non faite", e));
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
  return { ok: true };
}

/**
 * SOUMETTRE UNE PIÈCE JOINTE À VALIDATION — à n'importe quel moment, à une ou plusieurs personnes.
 *
 * Chaque pièce se soumet À PART (une facture peut partir en validation pendant que le devis reste
 * en discussion), au bureau de validation CENTRAL : les validateurs choisis la retrouvent dans
 * /validations et Mon travail, comme toute validation. En PARALLÈLE — tous saisis et notifiés en
 * même temps, aucun ordre imposé. Et parce qu'on ne valide pas une pièce hors de son contexte,
 * être validateur d'une pièce OUVRE L'ACCÈS à toute la demande (géré sur la page de la demande).
 */
export async function submitAttachmentValidation(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const requestId = String(formData.get("requestId") ?? "").trim();
  const documentId = String(formData.get("documentId") ?? "").trim();
  const validatorIds = formData.getAll("validatorIds").map((v) => String(v).trim()).filter(Boolean);
  const note = String(formData.get("note") ?? "").trim();
  // Montant (DZD) et catégorie de finance FACULTATIFS : s'ils sont là, l'approbation de la pièce
  // émettra automatiquement l'ordre de dépense correspondant vers les Finances.
  const amount = fdNum(formData, "amount");
  const rawCategory = String(formData.get("category") ?? "").trim();
  const category = (Object.values(FinanceCategory) as string[]).includes(rawCategory) ? rawCategory : null;
  if (!requestId || !documentId) return { ok: false, error: "Pièce ou demande manquante." };
  if (validatorIds.length === 0) return { ok: false, error: "Choisissez au moins un validateur." };
  if (amount !== null && amount < 0) return { ok: false, error: "Montant invalide." };

  const req = await prisma.administrativeRequest.findFirst({
    where: { id: requestId, deletedAt: null },
    select: { id: true, reference: true, title: true, requesterId: true, assignedToId: true },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  const isSecretary = hasRole(user, "DIRECTION_ASSISTANT");
  const allowed = hasGlobalView(user.role) || isSecretary || userCan(user, "ADMIN_REQUESTS", "UPDATE")
    || req.requesterId === user.id || req.assignedToId === user.id;
  if (!allowed) return { ok: false, error: "Non autorisé sur cette demande." };
  const autoValidation = refusValidateursPieceChiffree({
    montant: amount, validateurs: validatorIds, soumetteurId: user.id, demandeurId: req.requesterId, traitanteId: req.assignedToId,
  });
  if (autoValidation) return { ok: false, error: autoValidation };

  const doc = await prisma.document.findFirst({
    where: { id: documentId, entityType: "ADMIN_REQUEST", entityId: requestId },
    select: { id: true, name: true },
  });
  if (!doc) return { ok: false, error: "Cette pièce n'appartient pas à la demande." };

  // Pas deux validations EN COURS sur la même pièce : la seconde sèmerait la confusion sur
  // laquelle fait foi. Une pièce refusée peut en revanche être resoumise (nouvelle version).
  const pending = await prisma.validationRequest.count({
    where: { documentId: doc.id, entityType: "ADMIN_REQUEST", entityId: requestId, status: "PENDING" },
  });
  if (pending > 0) return { ok: false, error: "Cette pièce est déjà en cours de validation." };

  const res = await createDirectValidation({
    requesterId: user.id,
    title: `Pièce jointe « ${doc.name} » — ${req.reference}`,
    description: note || `Validation de la pièce « ${doc.name} » de la demande ${req.reference} — ${req.title}.`,
    link: `/demandes/${req.id}`,
    module: "Bureau du secrétariat",
    entityType: "ADMIN_REQUEST",
    entityId: req.id,
    documentId: doc.id,
    mode: "PARALLEL",
    validatorIds,
    amount,
    category,
    // Se choisir soi-même comme validateur est PERMIS ici quand la pièce n'est pas chiffrée : la validation
    // est alors un avis, pas un circuit hiérarchique — sans cela, le choix s'évaporait et l'écran réclamait
    // « au moins un validateur » alors qu'on venait d'en saisir un. Chiffrée, elle émet un paiement : la
    // règle ci-dessus (`refusValidateursPieceChiffree`) a déjà refusé tout validateur intéressé.
    allowSelf: !(amount !== null && amount > 0),
  });
  if (!res.ok) return { ok: false, error: res.error };

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: req.id,
    summary: `Pièce « ${doc.name} » soumise à validation (${validatorIds.length} validateur·s) — ${res.reference}`,
  });
  revalidatePath(`/demandes/${req.id}`);
  revalidatePath("/validations");
  revalidatePath("/mon-travail");
  return { ok: true };
}

/**
 * RETIRER UNE VALIDATION DE PIÈCE EN COURS — soumise par erreur, mauvaise pièce, mauvais
 * validateurs : tant qu'elle est EN ATTENTE, celui qui l'a soumise (ou l'assistante / un profil
 * gestionnaire) peut la retirer. Statut ANNULÉ (trace conservée, pas de suppression) ; les
 * validateurs encore saisis sont prévenus et la pièce redevient soumissible.
 */
export async function cancelAttachmentValidation(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const validationId = String(formData.get("validationId") ?? "").trim();
  if (!validationId) return { ok: false, error: "Validation manquante." };

  const val = await prisma.validationRequest.findFirst({
    where: { id: validationId, entityType: "ADMIN_REQUEST", documentId: { not: null } },
    select: {
      id: true, reference: true, title: true, status: true, requesterId: true, entityId: true,
      version: true, mode: true, currentOrder: true,
      steps: { select: { validatorId: true, status: true, order: true } },
    },
  });
  if (!val) return { ok: false, error: "Validation introuvable." };
  // LA MÊME RÈGLE QUE LA FICHE D'UNE VALIDATION (`validations/retrait.ts`, décision du 04/10) : on
  // retire tant que ce n'est pas tranché. Une validation de pièce renvoyée se corrige depuis la pièce
  // (elle n'est pas « sur place ») : elle ne se retire qu'en attente.
  const refusRetrait = refusDuRetraitValidation({ status: val.status, version: val.version, surPlace: false, steps: val.steps });
  if (refusRetrait) return { ok: false, error: val.status === "PENDING" ? refusRetrait : "Cette validation est déjà clôturée." };

  const isSecretary = hasRole(user, "DIRECTION_ASSISTANT");
  const allowed = hasGlobalView(user.role) || isSecretary || userCan(user, "ADMIN_REQUESTS", "UPDATE") || val.requesterId === user.id;
  if (!allowed) return { ok: false, error: "Non autorisé." };

  // UN GESTE À LA FOIS : la clôture exige la demande encore en attente.
  const close = await prisma.validationRequest.updateMany({ where: { id: val.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
  if (close.count === 0) return { ok: false, error: "Cette validation vient d'être tranchée ou retirée — rechargez la page." };

  // Prévenir ceux qui l'ont déjà eue entre les mains — sinon ils chercheraient une demande disparue.
  for (const v of validateursSollicites(val, user.id)) {
    await notifyUser({
      userId: v, type: "GENERIC", title: "Validation retirée",
      body: `${val.reference} — ${val.title}`, link: val.entityId ? `/demandes/${val.entityId}` : "/validations",
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Demandes administratives", entityType: "ADMIN_REQUEST", entityId: val.entityId ?? val.id,
    summary: `Validation de pièce retirée — ${val.reference}`,
  });
  if (val.entityId) revalidatePath(`/demandes/${val.entityId}`);
  revalidatePath("/validations");
  revalidatePath("/mon-travail");
  return { ok: true };
}
