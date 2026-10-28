"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import type { EntityType, MedicalInfoStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder, annulerOrdreNonRegle } from "@/modules/finances/api";
import { saveFile, validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { getDeclaration, canViewDeclaration, dernieresRelancesPieces, RELANCE_PIECE_CHAMP, REFUS_FINAL_CHAMP } from "@/lib/queries/medical-info";
import { peutRelancerPiece, visaExige } from "@/lib/medical-info/parcours";
import { archiveProcessedRequest } from "@/lib/archive";
import { formatAlgiers } from "@/lib/calendar-tz";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { refusAnnulationPieceInfoMed } from "@/lib/annulations/regles";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { circuitOfDeclaration, isOpenableDeclarationKind, DECLARATION_KIND_LABEL, ordreGlobalALaValidation } from "@/lib/medical-info/circuits";
import {
  canRequestDecision, canValidateEvent, declareStage, declareStageLabel, isDeclareIntent,
  DECLARE_INTENT_LABEL,
} from "@/lib/medical-info/declare-decision";
import {
  canDeliverSlip, canEditSlips, canRequestSlipPayment, canRequestSlipsValidation,
  slipStage, slipSansPaiementVivant, PRISE_DU_BON, SLIPS_LOT_LABEL, SLIP_STAGE_LABEL,
} from "@/lib/medical-info/slips";
import { cloreLeDossierPromoSiSolde, dossierPromoDeLaFacture } from "@/lib/promo-cloture";
import { circuitStateOf, authoritiesOpen } from "@/lib/medical-info/circuit-state";
import { nextDeclarationRef, decideursInfoMedActifs, pharmacienAssigne } from "@/lib/medical-info";
import {
  estDecideurInfoMed, noteDecideurs, confirmationDemande, AUCUN_DECIDEUR, OBJET_DECISION_INFO_MED, DECIDEUR_INFO_MED_LABEL,
  ROLE_DECIDEUR_INFO_MED, type DecideursInfoMed,
} from "@/lib/medical-info/decideur";

import { createDirectValidation, retirerValidationSansObjet } from "@/lib/validation";
import { toNumber } from "@/lib/utils";
import { postesPortantLaDepense } from "@/lib/workflow/engine";
import { sansBloquer } from "@/lib/journal";

const PATH = "/information-medicale";

/**
 * QUI PORTE LA DÉPENSE D'UN ÉVÉNEMENT DÉCLARÉ ? — l'ordre GLOBAL, ou ses POSTES (§118.151).
 *
 * La Direction émettait ici un ordre de dépense du montant de la déclaration, sans regarder les
 * postes. Or un poste émet sa PROPRE pièce (BC, puis facture, puis ordre) : une opération ventilée
 * payait donc deux fois la même dépense — une fois par l'ordre global, une fois par ses postes.
 * Le moteur de circuit s'en gardait déjà dans son autre branche (pas de pharmacien, `emitFinancials`) ;
 * celle-ci ne s'en gardait pas, et depuis que chaque sponsoring naît avec son poste, le défaut
 * serait devenu SYSTÉMATIQUE.
 *
 * Deux faits font dire « les postes » :
 *   · des postes non refusés existent — la lecture est celle du moteur (`postesPortantLaDepense`),
 *     pas un second comptage qui divergerait ;
 *   · le sponsoring suit la règle de la TENUE : pré-validé ou clôturé par sa validation finale. Là,
 *     le montant déclaré n'est qu'une ESTIMATION — l'argent se décide poste par poste —, et un ordre
 *     bâti dessus serait un ordre sur un montant que personne n'a accordé. Même si tous ses postes
 *     ont été refusés : c'est alors qu'il n'y a RIEN à payer, pas qu'il faut payer l'estimation.
 *
 * Aucune erreur n'est rattrapée : une lecture qui échoue fait échouer la validation, qui se refait
 * d'un clic. Se tromper dans l'autre sens émettrait un ordre de trop — de l'argent qui sort.
 */
async function laDepenseEstPorteeParLesPostes(sourceType: EntityType, sourceId: string): Promise<boolean> {
  if (sourceType === "SPONSORING") {
    const s = await prisma.sponsoringRequest.findUnique({ where: { id: sourceId }, select: { status: true, closedAt: true } });
    if (s && (s.status === "PRE_VALIDATED" || s.closedAt != null)) return true;
  }
  return (await postesPortantLaDepense(sourceType, sourceId)).nombre > 0;
}

/** Le pharmacien responsable (ou la Direction / un admin) pilote la déclaration. */
function canManage(user: SessionUser): boolean {
  return hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");
}

function revalidate(id: string) {
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
}

/** Recalcule le statut READY / DOCS_REQUESTED / AWAITING_REVIEW selon l'état des pièces. */
async function refreshStatus(declarationId: string) {
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id: declarationId }, include: { requests: true } });
  // NI VALIDÉ, NI CHEZ LE DÉCIDEUR : une pièce déposée (ou une demande annulée) pendant que le dossier
  // attend la validation finale le faisait repasser « prêt à valider » — il sortait de la file du
  // Directeur des Opérations sans que personne l'ait tranché.
  if (!decl || decl.status === "VALIDATED" || decl.status === "AWAITING_DIRECTION") return;
  const reqs = decl.requests;
  const next: MedicalInfoStatus =
    reqs.length > 0 && reqs.every((r) => r.status === "FULFILLED") ? "READY"
    : reqs.length > 0 ? "DOCS_REQUESTED"
    : "AWAITING_REVIEW";
  if (next !== decl.status) await prisma.medicalInfoDeclaration.update({ where: { id: declarationId }, data: { status: next } });
}

// ───────────── Demande de pièce (pharmacien → Direction / comptable / délégué…) ─────────────

export async function requestDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const declarationId = fdStr(formData, "declarationId");
  const label = fdStr(formData, "label");
  const targetUserId = fdStr(formData, "targetUserId");
  if (!declarationId || !label) return { ok: false, error: "Précisez la pièce demandée." };
  if (!targetUserId) return { ok: false, error: "Sélectionnez la personne à qui demander la pièce." };

  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id: declarationId } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (decl.status === "VALIDATED") return { ok: false, error: "Déclaration déjà validée." };

  await prisma.medicalInfoDocRequest.create({ data: { declarationId, label, targetUserId, requestedById: user.id } });
  if (decl.status === "AWAITING_REVIEW") {
    await prisma.medicalInfoDeclaration.update({ where: { id: declarationId }, data: { status: "DOCS_REQUESTED" } });
  }
  await notifyUser({ userId: targetUserId, type: "ASSIGNMENT", title: "Information médicale — pièce demandée", body: `${decl.reference} — ${label}`, link: `${PATH}/${declarationId}` });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: declarationId, summary: `Pièce demandée — ${label}` });
  revalidate(declarationId);
  return { ok: true };
}

export async function cancelDocRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const r = await prisma.medicalInfoDocRequest.findUnique({ where: { id }, include: { declaration: { select: { reference: true } } } });
  if (!r) return { ok: false, error: "Demande introuvable." };
  // LE DEMANDEUR ANNULE SA DEMANDE TANT QU'ELLE N'EST PAS EXÉCUTÉE (décision du 04/10) — la pièce n'est
  // pas encore déposée. Pas seulement un gestionnaire du module : celui qui l'a demandée aussi.
  const refus = refusAnnulationPieceInfoMed(r, { userId: user.id, gestionnaire: canManage(user) });
  if (refus) return { ok: false, error: refus };
  // UN GESTE À LA FOIS : un dépôt passé entre la lecture et le clic l'emporte.
  const pris = await prisma.medicalInfoDocRequest.deleteMany({ where: { id, status: "PENDING" } });
  if (pris.count === 0) return { ok: false, error: "La pièce vient d'être déposée — rechargez la page." };
  await refreshStatus(r.declarationId);
  // La personne sollicitée est prévenue : sans un mot, elle chercherait encore une pièce que plus personne n'attend.
  if (r.targetUserId && r.targetUserId !== user.id) {
    await notifyUser({ userId: r.targetUserId, type: "GENERIC", title: "Information médicale — pièce plus demandée", body: `${r.declaration.reference} — ${r.label} : la demande est annulée.`, link: `${PATH}/${r.declarationId}` }).catch(sansBloquer("medical-info-actions.cancelDocRequest.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: r.declarationId,
    summary: `Demande de pièce annulée — ${r.declaration.reference} : ${r.label}`,
  });
  revalidate(r.declarationId);
  return { ok: true };
}

/**
 * RELANCER UNE PIÈCE ATTENDUE — une notification à la personne sollicitée, tracée au journal.
 *
 * La règle des tâches (quatre heures depuis la demande ou la dernière relance) : sans délai, trois
 * clics font trois notifications identiques, et la quatrième — celle qui comptait — ne se lit plus.
 */
export async function relancerPieceInfoMed(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const r = await prisma.medicalInfoDocRequest.findUnique({
    where: { id },
    include: { declaration: { select: { id: true, reference: true, status: true } } },
  });
  if (!r) return { ok: false, error: "Demande introuvable." };
  if (r.declaration.status === "VALIDATED") return { ok: false, error: "Déclaration déjà validée." };
  const derniere = (await dernieresRelancesPieces(r.declarationId)).get(r.id) ?? null;
  const verdict = peutRelancerPiece(r, { userId: user.id, gestionnaire: canManage(user), derniereRelance: derniere });
  if (!verdict.ok) return { ok: false, error: verdict.raison };

  await notifyUser({
    userId: r.targetUserId!,
    type: "ASSIGNMENT",
    title: "Relance : une pièce vous est demandée",
    body: `${r.declaration.reference} — ${r.label}`,
    link: `${PATH}/${r.declarationId}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: r.declarationId,
    field: RELANCE_PIECE_CHAMP, newValue: r.id,
    summary: `Pièce relancée — ${r.declaration.reference} : ${r.label}`,
  });
  revalidate(r.declarationId);
  return { ok: true };
}

// ───────────── Dépôt de la pièce (par la personne sollicitée) ─────────────

export async function fulfillDocRequest(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande manquante." };
  const r = await prisma.medicalInfoDocRequest.findUnique({ where: { id: requestId }, include: { declaration: true } });
  if (!r) return { ok: false, error: "Demande introuvable." };
  // Seule la personne sollicitée (ou un gestionnaire) peut déposer la pièce.
  if (r.targetUserId !== user.id && !canManage(user)) return { ok: false, error: "Cette pièce ne vous a pas été demandée." };
  if (r.status === "FULFILLED") return { ok: false, error: "Pièce déjà déposée." };

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return { ok: false, error: "Aucun fichier sélectionné." };
  const validationError = validateUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (validationError) return { ok: false, error: validationError };

  const key = `MEDICAL_INFO_DECLARATION/${r.declarationId}/${randomUUID()}__${file.name}`;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await saveFile(key, buffer);
  } catch (err) {
    console.error("[medical-info] storage write failed, recording metadata only", err);
  }
  const doc = await prisma.document.create({
    data: {
      name: file.name, category: "OTHER", entityType: "MEDICAL_INFO_DECLARATION", entityId: r.declarationId,
      fileKey: key, mimeType: file.type || null, sizeBytes: file.size, confidentiality: "INTERNAL", uploadedById: user.id,
    },
  });
  await prisma.medicalInfoDocRequest.update({
    where: { id: requestId },
    data: { status: "FULFILLED", documentId: doc.id, note: fdStr(formData, "note"), fulfilledAt: new Date() },
  });
  await refreshStatus(r.declarationId);
  if (r.declaration.pharmacistId) {
    await notifyUser({ userId: r.declaration.pharmacistId, type: "DOCUMENT_UPLOADED", title: "Information médicale — pièce reçue", body: `${r.declaration.reference} — ${r.label}`, link: `${PATH}/${r.declarationId}` });
  } else {
    await notifyRoles(["MEDICAL_INFO_PHARMACIST", "SUPER_ADMIN"], { type: "DOCUMENT_UPLOADED", title: "Information médicale — pièce reçue", body: `${r.declaration.reference} — ${r.label}`, link: `${PATH}/${r.declarationId}` });
  }
  await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: r.declarationId, summary: `Pièce déposée — ${r.label} (« ${file.name} »)` });
  revalidate(r.declarationId);
  return { ok: true };
}

// ───────────── Enregistrement de la déclaration aux autorités ─────────────

export async function recordAuthorityDeclaration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };

  // LA PORTE DU BON DE VERSEMENT TIENT ICI, pas seulement à l'écran. Masquer une carte est du
  // confort ; un formulaire posté à la main, ou un écran ouvert avant la remise puis soumis
  // après coup, doit rencontrer la même règle. Le refus DIT l'étape qui manque.
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  const etat = await circuitStateOf(decl);
  if (!authoritiesOpen(etat)) {
    return {
      ok: false,
      error: etat.circuit === "EVENT"
        ? `La décision de déclarer n'est pas encore accordée : ${declareStageLabel(declareStage(etat.declare)).toLowerCase()}.`
        : `Les quittances ne sont pas toutes entre vos mains : ${etat.summary.delivered}/${etat.summary.count} remise(s).`,
    };
  }

  await prisma.medicalInfoDeclaration.update({
    where: { id },
    data: { authorityRef: fdStr(formData, "authorityRef"), authorityNotes: fdStr(formData, "authorityNotes") },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: id, summary: "Déclaration aux autorités enregistrée" });
  revalidate(id);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CIRCUIT ÉVÉNEMENT — « faut-il déclarer ? », et rien d'autre
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * CLORE LA DEMANDE « À REVOIR » QU'UNE RESOUMISSION REMPLACE (audit 360°, I9).
 *
 * L'écriture est CONDITIONNELLE : seule une demande encore à revoir se clôt. Deux resoumissions
 * simultanées lisent toutes deux « à revoir » ; la première clôt et poursuit, la seconde trouve la
 * demande déjà close et s'arrête — sans quoi deux demandes vivraient pour une seule question, ce
 * que la règle d'avant existait pour empêcher. Non exportée : une fonction qui reçoit un acteur
 * en argument n'a pas sa place parmi les points d'entrée d'un fichier « use server » (§118.153).
 */
async function clorePrecedente(validationId: string | null, acteurId: string, reference: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!validationId) return { ok: true };
  const r = await prisma.validationRequest.updateMany({
    where: { id: validationId, status: "CHANGES_REQUESTED" },
    data: { status: "CANCELLED" },
  });
  if (r.count !== 1) {
    return { ok: false, error: "Une nouvelle demande vient déjà d'être soumise pour ce dossier — rechargez la page." };
  }
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Validations",
    entityType: "VALIDATION_REQUEST", entityId: validationId,
    field: "status", newValue: "CANCELLED",
    summary: `Demande à revoir close par sa resoumission (${reference})`,
  });
  return { ok: true };
}

/**
 * LE PHARMACIEN SOUMET SA LECTURE : ce dossier se déclare au ministère, ou il ne se déclare pas.
 *
 * Une prise en charge, un sponsoring, un événement n'appellent AUCUN versement — c'était le
 * défaut : chacun sortait par la porte « ce dossier n'appelle aucun versement », motif à l'appui.
 * Ce qu'ils appellent, c'est un jugement, et ce jugement engage la société : il ne reste pas celui
 * du pharmacien seul.
 *
 * Ce qu'on fait valider, c'est sa LECTURE — pas la question. Une demande de validation répond oui
 * ou non : poser « faut-il déclarer ? » aurait fait dire « refusé » pour signifier « non, ne
 * déclarez pas », et un dossier parfaitement conforme serait marqué comme rejeté.
 */
export async function requestDeclareDecision(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Déclaration introuvable." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (circuitOfDeclaration(decl) !== "EVENT") {
    return { ok: false, error: "Ce dossier relève du matériel promotionnel : il passe par les bons de versement, pas par cette décision." };
  }

  const etat = await circuitStateOf(decl);
  if (!canRequestDecision(etat.declare)) {
    return { ok: false, error: `Une décision est déjà engagée pour ce dossier (${declareStageLabel(declareStage(etat.declare)).toLowerCase()}).` };
  }

  const intent = fdStr(formData, "intent");
  if (!isDeclareIntent(intent)) {
    return { ok: false, error: "Dites ce que vous comptez faire : déclarer ce dossier au ministère, ou non." };
  }
  const note = fdStr(formData, "note");
  // LA LECTURE « SANS DÉCLARATION » EXIGE UN MOTIF. C'est celle qui fait ne rien faire : sans
  // raison écrite, le validateur signe une absence, et l'audit ne lira rien.
  if (intent === "SKIP" && !note) {
    return { ok: false, error: "Dites pourquoi ce dossier ne se déclare pas : c'est ce que lira le validateur, puis l'audit." };
  }

  // LE DIRECTEUR DES OPÉRATIONS TRANCHE (Direction, 10/2026) — à défaut le Super Admin, et on le dit.
  const decideurs = await decideursInfoMedActifs(user.id);
  if (decideurs.validatorIds.length === 0) return { ok: false, error: AUCUN_DECIDEUR };
  // UNE DEMANDE À REVOIR SE RESOUMET ICI, ET LA PRÉCÉDENTE SE CLÔT (audit 360°, I9).
  if (declareStage(etat.declare) === "A_REVOIR") {
    const close = await clorePrecedente(decl.declareValidationId, user.id, decl.reference);
    if (!close.ok) return close;
  }

  const res = await demanderAuDecideur(decideurs, {
    requesterId: user.id,
    title: `Information médicale — ${DECLARE_INTENT_LABEL[intent]} : ${decl.label}`,
    description: [
      note,
      `Déclaration ${decl.reference}${decl.beneficiary ? ` — ${decl.beneficiary}` : ""}.`,
    ],
    declarationId: id,
  });
  if (!res.ok) return { ok: false, error: res.error ?? "La demande de décision n'a pas pu être créée." };

  // UN DOUBLE CLIC NE FAIT PAS DEUX DEMANDES VIVANTES : le rattachement est CONDITIONNEL à la demande
  // lue ; le second trouve la place prise, et la demande qu'il vient de créer est retirée.
  const rattachee = await prisma.medicalInfoDeclaration.updateMany({
    where: { id, declareValidationId: decl.declareValidationId },
    data: {
      declareValidationId: res.requestId ?? null,
      declareIntent: intent,
      declareNote: note,
      declareRequestedAt: new Date(),
      declareRequestedById: user.id,
    },
  });
  if (rattachee.count === 0) {
    if (res.requestId) await retirerValidationSansObjet(res.requestId);
    return { ok: false, error: "Une demande vient déjà d'être soumise pour ce dossier — rechargez la page." };
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    field: "Décision de déclarer", newValue: intent,
    summary: `${DECLARE_INTENT_LABEL[intent]} — soumis à validation du ${decideurs.repli ? "Super Admin (aucun Directeur des Opérations actif)" : DECIDEUR_INFO_MED_LABEL} (${decl.reference})`,
  });
  revalidate(id);
  return { ok: true, id: res.requestId, message: confirmationDemande(decideurs, "Votre lecture est envoyée") };
}

/**
 * LA DEMANDE DE VALIDATION D'UN GESTE DU PRIM — adressée au(x) Directeur(s) des Opérations.
 *
 * Tous les comptes saisis EN MÊME TEMPS (`PARALLEL`), et l'accord du premier qui tranche vaut pour
 * tous (`OBJET_DECISION_INFO_MED`, lu par le moteur commun) : une fonction tenue par deux personnes
 * ne devient pas une double signature.
 *
 * L'EXISTANT N'EST PAS RE-ROUTÉ : une demande déjà en cours sous l'ancienne chaîne (N+1, référent
 * Direction Marketing, centre — en série) finit son circuit tel qu'il a été annoncé à ses signataires ;
 * seules les demandes soumises (ou resoumises) à partir d'ici vont au Directeur des Opérations. Une
 * demande à revoir qui se resoumet passe donc, elle, chez lui (`clorePrecedente` clôt l'ancienne).
 *
 * Non exportée : une fonction qui reçoit un demandeur en
 * argument n'a pas sa place parmi les points d'entrée d'un fichier « use server » (§118.153).
 */
async function demanderAuDecideur(
  decideurs: DecideursInfoMed,
  d: { requesterId: string; title: string; description: (string | null)[]; declarationId: string; amount?: number },
) {
  return createDirectValidation({
    requesterId: d.requesterId,
    title: d.title,
    description: [...d.description, noteDecideurs(decideurs)].filter(Boolean).join("\n\n") || null,
    link: `${PATH}/${d.declarationId}`,
    module: "Information médicale",
    priority: "HIGH",
    validatorIds: decideurs.validatorIds,
    mode: "PARALLEL",
    objectType: OBJET_DECISION_INFO_MED,
    entityType: "MEDICAL_INFO_DECLARATION",
    entityId: d.declarationId,
    amount: d.amount,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CIRCUIT MATÉRIEL PROMOTIONNEL — un bon de versement par matériel
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * SÉPARER LE DOSSIER EN MATÉRIELS — un bon de versement par matériel.
 *
 * Il n'y avait qu'un bon par dossier. Un dossier en porte plusieurs : un présentoir, des affiches,
 * une vidéo — chacun sa taxe, chacun sa quittance. On additionnait donc les montants pour n'en
 * demander qu'un, et ce qui n'entrait pas dans la case se réglait hors ERP.
 */
export async function addMedicalInfoSlip(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const id = fdStr(formData, "declarationId");
  const label = fdStr(formData, "label");
  if (!id) return { ok: false, error: "Déclaration introuvable." };
  if (!label) return { ok: false, error: "Nommez le matériel concerné par ce bon de versement." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (circuitOfDeclaration(decl) !== "PROMO") {
    return { ok: false, error: "Ce dossier ne relève pas du matériel promotionnel : il n'appelle aucun bon de versement." };
  }

  const etat = await circuitStateOf(decl);
  // LA LISTE EST FIGÉE UNE FOIS SIGNÉE. Y ajouter un bon après coup ferait payer un versement que
  // personne n'a vu passer.
  if (!canEditSlips(etat.lot)) {
    return { ok: false, error: `La liste des matériels est figée : ${SLIPS_LOT_LABEL[etat.lot].toLowerCase()}.` };
  }

  const raw = fdStr(formData, "amount");
  const amount = raw ? Number(raw.replace(",", ".")) : null;
  if (raw && (!Number.isFinite(amount) || (amount ?? 0) < 0)) return { ok: false, error: "Montant du bon invalide." };

  await prisma.medicalInfoSlip.create({
    data: {
      declarationId: id, label, amount, note: fdStr(formData, "note"),
      position: etat.slips.length,
    },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    summary: `Matériel ajouté au dossier — ${label}${amount ? ` (${amount.toLocaleString("fr-FR")} DZD)` : ""}`,
  });
  revalidate(id);
  return { ok: true };
}

/** Retirer un matériel — tant que le dépôt des bons n'est pas parti en validation. */
export async function removeMedicalInfoSlip(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const slipId = fdStr(formData, "slipId");
  if (!slipId) return { ok: false, error: "Matériel introuvable." };
  const slip = await prisma.medicalInfoSlip.findUnique({ where: { id: slipId }, include: { declaration: true } });
  if (!slip) return { ok: false, error: "Matériel introuvable." };

  const etat = await circuitStateOf(slip.declaration);
  const courant = etat.slips.find((sl) => sl.id === slipId);
  // APRÈS LA VALIDATION DU LOT, UN BON SANS PAIEMENT VIVANT SE RETIRE ENCORE (audit 10/2026) : jamais
  // demandé, ou demandé puis refusé / annulé au centre. Il restait bloqué à vie ; le retirer ne paie
  // rien de plus que ce qui a été signé — c'est un versement de MOINS, tracé.
  const morteApresValidation = etat.lot === "QUITTANCE_A_DEMANDER" && !!courant && slipSansPaiementVivant(courant);
  if (!canEditSlips(etat.lot) && !morteApresValidation) {
    return { ok: false, error: "Le dépôt des bons est déjà soumis à validation : retirer un matériel laisserait une signature portant sur autre chose." };
  }
  if (slip.requestId && !morteApresValidation) return { ok: false, error: "Une quittance est déjà demandée sur ce matériel." };

  // Conditionnel : un paiement demandé entre la lecture et le clic garde son bon.
  const retire = await prisma.medicalInfoSlip.deleteMany({ where: { id: slipId, requestId: slip.requestId, deliveredAt: null } });
  if (retire.count === 0) return { ok: false, error: "Ce bon vient de changer — rechargez la page." };
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: slip.declarationId,
    summary: `Matériel retiré du dossier — ${slip.label}${morteApresValidation && slip.requestId ? " (paiement refusé ou annulé)" : ""}`,
  });
  revalidate(slip.declarationId);
  return { ok: true };
}

/**
 * FAIRE VALIDER LE DÉPÔT DES BONS — une fois pour le lot entier.
 *
 * Une décision, celle du Directeur des Opérations (Direction, 10/2026 — `medical-info/decideur.ts`).
 * Faire signer cinq fois la même décision, une par matériel, n'ajoute aucune
 * sécurité : cela ajoute quatre relances. Ce qui se demande matériel par matériel, c'est le
 * PAIEMENT, et il vient après.
 */
export async function requestSlipsValidation(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Déclaration introuvable." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (circuitOfDeclaration(decl) !== "PROMO") {
    return { ok: false, error: "Ce dossier ne relève pas du matériel promotionnel : il n'appelle aucun bon de versement." };
  }
  if (decl.bvSkippedAt) return { ok: false, error: "Ce dossier a été déclaré sans versement." };

  const etat = await circuitStateOf(decl);
  const possible = canRequestSlipsValidation(etat.lot, etat.slips);
  if (!possible.ok) return { ok: false, error: possible.reason ?? "Le dépôt ne peut pas être soumis maintenant." };

  const total = etat.summary.announced;
  const note = fdStr(formData, "note");
  // LE DIRECTEUR DES OPÉRATIONS TRANCHE (Direction, 10/2026) — à défaut le Super Admin, et on le dit.
  const decideurs = await decideursInfoMedActifs(user.id);
  if (decideurs.validatorIds.length === 0) return { ok: false, error: AUCUN_DECIDEUR };
  // Le dépôt À REVOIR se resoumet ici, et la demande précédente se clôt (audit 360°, I9).
  if (etat.lot === "VALIDATION_A_REVOIR") {
    const close = await clorePrecedente(decl.bvValidationId, user.id, decl.reference);
    if (!close.ok) return close;
  }

  const res = await demanderAuDecideur(decideurs, {
    requesterId: user.id,
    title: `Bons de versement — ${decl.label} · ${etat.slips.length} matériel(s) · ${total.toLocaleString("fr-FR")} DZD`,
    description: [
      note,
      etat.slips.map((sl) => `• ${sl.label}${sl.amount ? ` — ${sl.amount.toLocaleString("fr-FR")} DZD` : ""}`).join("\n"),
      `Déclaration ${decl.reference}${decl.beneficiary ? ` — ${decl.beneficiary}` : ""}.`,
    ],
    declarationId: id,
    amount: total > 0 ? total : undefined,
  });
  if (!res.ok) return { ok: false, error: res.error ?? "La demande de validation n'a pas pu être créée." };

  // Un double clic ne fait pas deux demandes vivantes (même règle que la décision de déclarer).
  const rattachee = await prisma.medicalInfoDeclaration.updateMany({
    where: { id, bvValidationId: decl.bvValidationId },
    data: {
      bvValidationId: res.requestId ?? null,
      bvAmount: total > 0 ? total : null,
      bvNote: note,
      bvRequestedAt: new Date(),
      bvRequestedById: user.id,
    },
  });
  if (rattachee.count === 0) {
    if (res.requestId) await retirerValidationSansObjet(res.requestId);
    return { ok: false, error: "Une demande vient déjà d'être soumise pour ce dossier — rechargez la page." };
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    summary: `Dépôt de ${etat.slips.length} bon(s) de versement soumis à validation du ${decideurs.repli ? "Super Admin (aucun Directeur des Opérations actif)" : DECIDEUR_INFO_MED_LABEL} — ${total.toLocaleString("fr-FR")} DZD (${decl.reference})`,
  });
  revalidate(id);
  return { ok: true, id: res.requestId, message: confirmationDemande(decideurs, "Le dépôt des bons est envoyé") };
}

/**
 * LE PAIEMENT D'UNE QUITTANCE — bon par bon, et c'est tout le sujet.
 *
 * Le dépôt validé, chaque quittance se demande SÉPARÉMENT : son montant réel (qui n'est pas
 * toujours celui annoncé), sa pièce, son passage au centre de paiement, son règlement, sa remise.
 * Les grouper obligerait à attendre le dernier matériel pour déposer le premier.
 *
 * À partir d'ici, plus rien de spécifique : c'est une `PaymentRequest` ORDINAIRE, qui emprunte le
 * chemin commun. Ce qui la distingue est son rattachement, qui la ramène à cette déclaration.
 */
export async function requestSlipPayment(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const slipId = fdStr(formData, "slipId");
  if (!slipId) return { ok: false, error: "Matériel introuvable." };
  const slip = await prisma.medicalInfoSlip.findUnique({ where: { id: slipId }, include: { declaration: true } });
  if (!slip) return { ok: false, error: "Matériel introuvable." };
  const decl = slip.declaration;
  if (decl.bvSkippedAt) return { ok: false, error: "Ce dossier a été déclaré sans versement." };

  const etat = await circuitStateOf(decl);
  if (etat.lot !== "QUITTANCE_A_DEMANDER") {
    return { ok: false, error: `Le dépôt des bons n'est pas encore validé : ${SLIPS_LOT_LABEL[etat.lot].toLowerCase()}.` };
  }
  const courant = etat.slips.find((sl) => sl.id === slipId);
  if (!courant || !canRequestSlipPayment(courant)) {
    return { ok: false, error: `Le paiement de ce bon ne peut pas être demandé maintenant : ${SLIP_STAGE_LABEL[slipStage(courant ?? { requestId: null, centralStatus: null, orderStatus: null, deliveredAt: null })].toLowerCase()}.` };
  }

  const raw = fdStr(formData, "amount");
  const amount = raw ? Number(raw.replace(",", ".")) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Indiquez le montant de la quittance." };

  // On rejoue le formulaire de la demande de paiement : c'est la MÊME action canonique que depuis
  // les Demandes de validations, donc les mêmes contrôles et le même circuit.
  const fd = new FormData();
  fd.set("title", `Quittance de versement — ${slip.label} (${decl.label})`);
  fd.set("payee", fdStr(formData, "payee") || "Autorités sanitaires");
  fd.set("amount", String(amount));
  fd.set("description", [
    fdStr(formData, "note"),
    slip.amount ? `Bon annoncé pour ${toNumber(slip.amount).toLocaleString("fr-FR")} DZD.` : null,
  ].filter(Boolean).join("\n\n"));
  if (decl.companyId) fd.set("companyId", decl.companyId);
  const echeance = fdStr(formData, "dueDate");
  if (echeance) fd.set("dueDate", echeance);
  // LE RATTACHEMENT EST POSÉ DÈS LA CRÉATION, et non par une mise à jour qui suivrait. C'est lui
  // qui identifie un BON DE VERSEMENT, et donc ce qui l'exempte de l'obligation de joindre un bon
  // de commande ou une facture (`finance/payment-dossier.ts`) : un BV n'en a ni n'en peut avoir,
  // et sa quittance n'existe qu'APRÈS le versement.
  fd.set("entityType", "MEDICAL_INFO_DECLARATION");
  fd.set("entityId", decl.id);
  fd.set("link", `${PATH}/${decl.id}`);
  for (const f of formData.getAll("files")) if (f instanceof File && f.size > 0) fd.append("files", f);

  // UN SEUL ORDRE VIVANT PAR BON (audit 10/2026). Deux soumissions simultanées lisaient toutes deux
  // « quittance à demander » et créaient chacune leur demande — donc deux ordres au centre de paiement
  // pour une seule taxe. Le bon est d'abord PRIS, par une écriture conditionnelle à ce qu'on a lu ; le
  // second trouve la place prise et s'arrête avant d'avoir rien créé. Le jeton de prise voyage avec la
  // demande : c'est lui qui prouve, à la création, qu'elle vient bien d'un bon de CE dossier — la seule
  // porte de l'exemption de facture (`bonDeVersementRattache`).
  const jeton = `${PRISE_DU_BON}${randomUUID()}`;
  const pris = await prisma.medicalInfoSlip.updateMany({
    where: { id: slipId, requestId: courant.requestId, deliveredAt: null },
    data: { requestId: jeton },
  });
  if (pris.count === 0) return { ok: false, error: "Le paiement de ce bon vient d'être demandé — rechargez la page." };
  fd.set("medicalInfoSlipClaim", jeton);

  let created: ActionResult;
  try {
    created = await createPaymentRequest(undefined, fd);
  } catch (err) {
    console.error("[medical-info] demande de paiement du bon non créée", err);
    created = { ok: false, error: "La demande de paiement n'a pas pu être créée." };
  }
  if (!created.ok || !created.id) {
    // Rien n'est parti : le bon retrouve son état d'avant la prise.
    await prisma.medicalInfoSlip.updateMany({ where: { id: slipId, requestId: jeton }, data: { requestId: courant.requestId } });
    return { ok: false, error: created.error ?? "La demande de paiement a été refusée." };
  }

  const rattache = await prisma.medicalInfoSlip.updateMany({ where: { id: slipId, requestId: jeton }, data: { requestId: created.id } });
  if (rattache.count === 0) {
    // Le bon a changé pendant la création (retiré, remis) : la demande née n'a plus d'objet — elle et son
    // ordre sont annulés tant que rien n'est réglé, plutôt que de laisser un paiement orphelin au centre.
    const orpheline = await prisma.paymentRequest.findUnique({ where: { id: created.id }, select: { expenseOrderId: true } });
    await prisma.paymentRequest.updateMany({ where: { id: created.id, status: { notIn: ["APPROVED", "CANCELLED"] } }, data: { status: "CANCELLED" } });
    await annulerOrdreNonRegle(orpheline?.expenseOrderId, { acteurId: user.id, motif: `bon de versement « ${slip.label} » modifié pendant la demande (${decl.reference})` });
    return { ok: false, error: "Ce bon vient de changer pendant la demande : elle a été annulée — rechargez la page." };
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id,
    summary: `Quittance demandée au paiement — ${slip.label} · ${amount.toLocaleString("fr-FR")} DZD (${decl.reference})`,
  });
  revalidate(decl.id);
  return { ok: true, id: created.id };
}

/**
 * LES FINANCES REMETTENT UNE QUITTANCE AU BUREAU DU PRIM.
 *
 * C'est CE geste — et non le règlement — qui fait avancer le dossier. « Payé » ne veut pas dire
 * « le pharmacien a le papier en main », et c'est le papier qu'on dépose au guichet. Chaque bon
 * se remet séparément : attendre le dernier pour tous les remettre bloquerait les premiers dépôts.
 */
export async function deliverMedicalInfoSlip(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // Ceux qui règlent remettent : les Finances, et la Direction / le Super Admin qui les couvrent.
  if (!(userCan(user, "FINANCES", "UPDATE") || hasGlobalView(user.role))) {
    return { ok: false, error: "La remise du bon revient aux Finances." };
  }
  const slipId = fdStr(formData, "slipId");
  if (!slipId) return { ok: false, error: "Matériel introuvable." };
  const slip = await prisma.medicalInfoSlip.findUnique({ where: { id: slipId }, include: { declaration: true } });
  if (!slip) return { ok: false, error: "Matériel introuvable." };
  const decl = slip.declaration;

  const etat = await circuitStateOf(decl);
  const courant = etat.slips.find((sl) => sl.id === slipId);
  if (!courant || !canDeliverSlip(courant)) {
    return { ok: false, error: "Ce bon ne peut pas encore être remis : la quittance doit d'abord être réglée." };
  }

  await prisma.medicalInfoSlip.update({
    where: { id: slipId },
    data: { deliveredAt: new Date(), deliveredById: user.id, deliveryNote: fdStr(formData, "note") },
  });
  // On relit APRÈS la remise : c'est la dernière qui ouvre le dépôt aux autorités, et c'est cette
  // phrase-là que le pharmacien attend.
  const apres = await circuitStateOf(decl);
  if (decl.pharmacistId) {
    await notifyUser({
      userId: decl.pharmacistId, type: "GENERIC",
      title: apres.summary.allDelivered
        ? "Toutes les quittances remises — vous pouvez déclarer aux autorités"
        : `Quittance remise — ${slip.label}`,
      body: `${decl.reference} — ${decl.label} (${apres.summary.delivered}/${apres.summary.count})`,
      link: `${PATH}/${decl.id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id,
    summary: `Quittance remise au bureau du PRIM — ${slip.label} (${decl.reference})`,
  });
  revalidate(decl.id);
  return { ok: true };
}

/**
 * CE DOSSIER N'APPELLE AUCUN VERSEMENT — la porte de sortie, tracée et motivée.
 *
 * Elle ne concerne plus QUE le matériel promotionnel : les dossiers d'événement ne passent plus
 * par les bons du tout, ils passent par la décision de déclarer. C'était le défaut — chacun d'eux
 * sortait par ici, et un contournement obligatoire n'est plus une porte de sortie, c'est le
 * chemin normal mal nommé. Le motif reste EXIGÉ : sans lui, elle redeviendrait ordinaire.
 */
export async function skipMedicalInfoBv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const id = fdStr(formData, "id");
  const reason = fdStr(formData, "reason");
  if (!id) return { ok: false, error: "Déclaration introuvable." };
  if (!reason) return { ok: false, error: "Dites pourquoi ce dossier n'appelle aucun versement : c'est ce que lira l'audit." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (circuitOfDeclaration(decl) !== "PROMO") {
    return { ok: false, error: "Ce dossier ne relève pas du matériel promotionnel : il n'appelle aucun bon de versement, et n'a donc rien à contourner." };
  }
  if (decl.bvSkippedAt) return { ok: false, error: "Ce dossier est déjà déclaré sans versement." };

  const etat = await circuitStateOf(decl);
  // Un bon dont le paiement a été refusé ou annulé n'engage plus rien (audit 10/2026) : il ne doit
  // plus empêcher de dire que le dossier n'appelle aucun versement — il le bloquait à vie.
  if (etat.slips.some((sl) => !slipSansPaiementVivant(sl))) {
    return { ok: false, error: "Une quittance est engagée : elle doit être menée à son terme ou refusée." };
  }
  if (etat.lot !== "A_DEMANDER" && etat.lot !== "VALIDATION_REFUSEE" && etat.lot !== "QUITTANCE_A_DEMANDER") {
    return { ok: false, error: "Le dépôt des bons est engagé en validation : il doit être mené à son terme ou refusé." };
  }

  await prisma.medicalInfoDeclaration.update({
    where: { id },
    data: { bvSkippedAt: new Date(), bvSkippedById: user.id, bvSkipReason: reason },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    field: "Bon de versement", newValue: "sans versement",
    summary: `Déclaré sans bon de versement — ${decl.reference} : ${reason}`,
  });
  revalidate(id);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CE QUE LE PRIM OUVRE LUI-MÊME
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * LE PHARMACIEN N'ATTEND PAS TOUJOURS QU'UN DOSSIER LUI ARRIVE.
 *
 * Une obligation réglementaire se découvre aussi de son côté : un support à faire viser, une
 * déclaration au ministère qu'aucun événement n'a déclenchée, un versement à faire. Il n'avait
 * pour cela aucun geste — le module ne se remplissait que par la validation d'un autre — et ce
 * qui n'entre pas dans l'ERP se traite dans un carnet.
 *
 * LA NATURE CHOISIE DÉCIDE DU CIRCUIT, et il n'y a pas de seconde case : une déclaration au
 * ministère suit le circuit de la décision, une demande de visa celui du matériel.
 *
 * DEUX NATURES, ET C'EST LE SERVEUR QUI LE TIENT. « Bon de versement » a été retiré du choix :
 * ce n'est pas ce qu'on ouvre, c'est une ÉTAPE du circuit du matériel. Le refus vit ici, pas
 * seulement dans la liste déroulante — une liste se réécrit dans le navigateur.
 */
export async function createMedicalInfoItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };

  const label = fdStr(formData, "label");
  const kind = fdStr(formData, "kind");
  if (!label) return { ok: false, error: "Nommez ce que vous ouvrez : c'est ce qui figurera dans la liste." };
  if (!isOpenableDeclarationKind(kind)) {
    return {
      ok: false,
      error: "Choisissez la nature : déclaration au ministère (MIP), ou demande de visa publicitaire. Le bon de versement n'est pas un dossier : c'est une étape du circuit du matériel, à l'intérieur du dossier.",
    };
  }
  const raw = fdStr(formData, "amount");
  const amount = raw ? Number(raw.replace(",", ".")) : null;
  if (raw && (!Number.isFinite(amount) || (amount ?? 0) < 0)) return { ok: false, error: "Montant invalide." };

  // LA SOURCE EST LE DOSSIER LUI-MÊME. Il n'y a pas d'événement derrière : lui en inventer un
  // ferait apparaître un lien « voir l'événement source » qui ne mène nulle part. La clé unique
  // (sourceType, sourceId) tient avec un identifiant propre à ce dossier.
  const sourceId = `prim_${randomUUID()}`;
  // Le pharmacien désigné — le plus ancien actif, déterministe (`pharmacienAssigne`).
  const pharmacist = await pharmacienAssigne();

  const decl = await prisma.medicalInfoDeclaration.create({
    data: {
      reference: await nextDeclarationRef(),
      sourceType: "MEDICAL_INFO_DECLARATION",
      sourceId,
      label,
      declarationKind: kind,
      beneficiary: fdStr(formData, "beneficiary"),
      amount,
      requesterId: user.id,
      createdById: user.id,
      // Celui qui ouvre le dossier le tient, sauf s'il n'est pas pharmacien (Direction, admin) :
      // le laisser sans pharmacien le ferait disparaître de la file de celui qui doit l'instruire.
      pharmacistId: userCan(user, "MEDICAL_INFO", "VALIDATE") ? user.id : pharmacist,
    },
  });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale",
    entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id,
    summary: `${DECLARATION_KIND_LABEL[kind]} ouverte — ${decl.reference} : ${label}`,
  });
  revalidatePath(PATH);
  return { ok: true, id: decl.id };
}

// ───────────── Validation pharmacien (PRIM) → transmission au Directeur des Opérations ─────────────

/**
 * Le pharmacien responsable valide son instruction : la déclaration ne part PAS directement au
 * comptable mais au DIRECTEUR DES OPÉRATIONS (Direction, 10/2026 — `medical-info/decideur.ts`), qui
 * la valide ou la refuse. L'ordre de dépense n'est émis qu'à cette validation finale.
 *
 * Plusieurs directeurs actifs : tous sont notifiés, le premier qui tranche décide. Aucun : la
 * demande va au Super Admin, et la confirmation du pharmacien le DIT.
 */
export async function validateDeclaration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Validation réservée au pharmacien responsable." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (decl.status === "VALIDATED") return { ok: false, error: "Déclaration déjà validée." };
  if (decl.status === "AWAITING_DIRECTION") return { ok: false, error: `Déjà transmise au ${DECIDEUR_INFO_MED_LABEL} pour validation finale.` };

  // LE CIRCUIT TIENT ICI, pas seulement à l'écran. Masquer un bouton est du confort ; un
  // formulaire posté à la main doit rencontrer la même règle, et le refus DIT ce qui manque.
  const etat = await circuitStateOf(decl);
  if (etat.circuit === "EVENT") {
    if (!canValidateEvent(etat.declare, { authorityRef: decl.authorityRef })) {
      return {
        ok: false,
        error: declareStage(etat.declare) !== "ACCORDEE"
          ? `La décision de déclarer doit d'abord être accordée : ${declareStageLabel(declareStage(etat.declare)).toLowerCase()}.`
          : "Enregistrez d'abord la référence du dépôt auprès du ministère de l'Industrie pharmaceutique.",
      };
    }
  } else if (!authoritiesOpen(etat)) {
    return {
      ok: false,
      error: `Les quittances ne sont pas toutes remises : ${etat.summary.delivered}/${etat.summary.count}. Dites, à défaut, que ce dossier n'appelle aucun versement.`,
    };
  } else if (visaExige(decl) && !(decl.authorityRef && decl.authorityRef.trim())) {
    // La même règle que l'écran (`pharmacienPeutValider`) : un visa publicitaire se valide avec son numéro.
    return { ok: false, error: "Enregistrez d'abord le numéro du visa publicitaire obtenu (référence de dépôt)." };
  }

  // QUI TRANCHERA — lu AVANT d'écrire : une demande que personne ne peut recevoir ne part pas.
  const decideurs = await decideursInfoMedActifs(user.id);
  if (decideurs.validatorIds.length === 0) return { ok: false, error: AUCUN_DECIDEUR };

  // UN GESTE À LA FOIS : deux validations simultanées lisent toutes deux « à instruire » ; la
  // première transmet, la seconde trouve le dossier déjà parti et s'arrête — sans doubler les
  // notifications ni l'archive.
  const pris = await prisma.medicalInfoDeclaration.updateMany({
    where: { id, status: { notIn: ["VALIDATED", "AWAITING_DIRECTION"] } },
    data: { status: "AWAITING_DIRECTION", pharmacistValidatedAt: new Date(), pharmacistValidatedById: user.id },
  });
  if (pris.count === 0) return { ok: false, error: "Ce dossier vient d'être transmis — rechargez la page." };
  for (const decideurId of decideurs.validatorIds) {
    await notifyUser({
      userId: decideurId,
      type: "VALIDATION_REQUIRED",
      title: `Information médicale — validation finale requise (${decideurs.repli ? "Super Admin, aucun Directeur des Opérations actif" : DECIDEUR_INFO_MED_LABEL})`,
      body: `${decl.reference} — ${decl.label}`,
      link: `${PATH}/${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    summary: `Validation pharmacien — transmise ${decideurs.repli ? "au Super Admin (aucun Directeur des Opérations actif)" : `au ${DECIDEUR_INFO_MED_LABEL}`} (${decl.reference})`,
  });

  // Instruction du PRIM terminée → archive dans SON Drive (« Dossier traité / Information médicale »).
  if (!decl.archivedNodeId) {
    const docs = await prisma.document.findMany({
      where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: id },
      select: { name: true, fileKey: true, mimeType: true },
    });
    const lines = [
      `Déclaration d'information médicale — ${decl.reference}`,
      `Libellé : ${decl.label}`,
      decl.beneficiary ? `Bénéficiaire : ${decl.beneficiary}` : null,
      decl.authorityRef ? `Référence autorités : ${decl.authorityRef}` : null,
      decl.authorityNotes ? `Notes de déclaration : ${decl.authorityNotes}` : null,
      `Créée le : ${formatAlgiers(decl.createdAt, { day: "2-digit", month: "long", year: "numeric" })}`,
      `Validée par le pharmacien le : ${formatAlgiers(new Date(), { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      `Transmise ${decideurs.repli ? "au Super Admin" : `au ${DECIDEUR_INFO_MED_LABEL}`} pour validation finale.`,
    ].filter(Boolean).join("\n");
    const day = new Date().toISOString().slice(0, 10);
    const nodeId = await archiveProcessedRequest({
      bureau: "Information médicale",
      folderName: `${day} — ${decl.reference} — ${decl.label}`,
      summary: lines,
      attachments: docs.map((d) => ({ name: d.name, fileKey: d.fileKey, mimeType: d.mimeType })),
      ownerId: user.id,
    });
    if (nodeId) {
      await prisma.medicalInfoDeclaration.update({ where: { id }, data: { archivedNodeId: nodeId } });
      revalidatePath("/drive");
    }
  }
  revalidate(id);
  revalidatePath("/mon-travail");
  return { ok: true, message: confirmationDemande(decideurs, "Le dossier est transmis pour validation finale") };
}

// ───────────── Validation finale (Directeur des Opérations) → ordre de dépense au comptable ─────────────

/** Ce que l'écran et le journal disent de celui qui tranche. */
function qualiteDuDecideur(user: SessionUser): string {
  return hasRole(user, ROLE_DECIDEUR_INFO_MED) ? DECIDEUR_INFO_MED_LABEL : "Super Admin";
}

/**
 * La porte commune aux deux décisions finales : le décideur, et jamais le pharmacien qui a validé
 * lui-même le dossier (un PRIM qui porterait aussi le rôle de directeur ne se valide pas).
 */
function refusDecideur(user: SessionUser, decl: { pharmacistValidatedById: string | null }): string | null {
  if (!estDecideurInfoMed(user)) return `Validation finale réservée au ${DECIDEUR_INFO_MED_LABEL} (à défaut, au Super Admin).`;
  if (user.role !== "SUPER_ADMIN" && decl.pharmacistValidatedById === user.id) {
    return "Vous avez validé ce dossier comme pharmacien : la validation finale revient à un autre décideur.";
  }
  return null;
}

const DEJA_TRANCHE = "Ce dossier vient d'être tranché par un autre décideur — rechargez la page.";

/**
 * Le Directeur des Opérations donne la validation finale « pour le comptable », avec un commentaire
 * facultatif (versé dans l'espace de discussion). C'est ICI qu'est émis l'ordre de dépense, qui part
 * alors au comptable.
 *
 * UN SEUL ORDRE, MÊME À DEUX CLICS. Deux validations simultanées lisaient toutes deux « en attente »
 * et émettaient chacune un ordre : la même dépense payée deux fois. Le passage à « validée » est
 * désormais une écriture CONDITIONNELLE au statut lu ; seul celui qui l'emporte émet l'ordre.
 */
export async function validateDeclarationByDirection(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!estDecideurInfoMed(user)) return { ok: false, error: `Validation finale réservée au ${DECIDEUR_INFO_MED_LABEL} (à défaut, au Super Admin).` };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (decl.status === "VALIDATED") return { ok: false, error: "Déclaration déjà validée." };
  if (decl.status !== "AWAITING_DIRECTION") return { ok: false, error: "La déclaration doit d'abord être validée par le pharmacien responsable." };
  const refus = refusDecideur(user, decl);
  if (refus) return { ok: false, error: refus };

  // Émission de l'ordre de dépense (si un budget a été accordé) → part au comptable — SAUF quand
  // ce sont les postes qui portent la dépense : ils émettent chacun leur pièce (§118.151).
  // L'ordre GLOBAL ne naît que là où rien d'autre ne porte la dépense (`ordreGlobalALaValidation`) :
  // pas sur la saisie libre d'un dossier ouvert par le PRIM, ni sur un MIP ou un visa, ni deux fois.
  const amount = ordreGlobalALaValidation(decl) ? Number(decl.amount ?? 0) : 0;
  const parLesPostes = amount > 0 && (await laDepenseEstPorteeParLesPostes(decl.sourceType, decl.sourceId));

  // LE GAGNANT SEUL : l'écriture ne passe que sur un dossier encore en attente de validation finale.
  const pris = await prisma.medicalInfoDeclaration.updateMany({
    where: { id, status: "AWAITING_DIRECTION" },
    data: { status: "VALIDATED", validatedAt: new Date(), validatedById: user.id },
  });
  if (pris.count === 0) return { ok: false, error: DEJA_TRANCHE };

  let order: Awaited<ReturnType<typeof createExpenseOrder>> | null;
  try {
    order = amount > 0 && !parLesPostes
      ? await createExpenseOrder({
          label: decl.label,
          amount,
          category: "EVENEMENT",
          beneficiary: decl.beneficiary,
          sourceType: decl.sourceType,
          sourceId: decl.sourceId,
          requestedById: decl.requesterId,
          budgetCategoryId: decl.budgetCategoryId,
        })
      : null;
  } catch (err) {
    // L'ORDRE N'EST PAS NÉ : la validation n'a pas eu lieu. Le dossier revient en attente (seulement
    // s'il porte encore CETTE validation, sans ordre) — sinon il resterait « validé » sans paiement.
    await prisma.medicalInfoDeclaration.updateMany({
      where: { id, status: "VALIDATED", validatedById: user.id, expenseOrderId: null },
      data: { status: "AWAITING_DIRECTION", validatedAt: null, validatedById: null },
    });
    console.error("[medical-info] ordre de dépense non émis à la validation finale :", err);
    return { ok: false, error: "L'ordre de dépense n'a pas pu être émis : le dossier reste en attente de votre validation." };
  }
  if (order) await prisma.medicalInfoDeclaration.update({ where: { id }, data: { expenseOrderId: order.id } });

  // Commentaire de validation (facultatif) → espace de discussion.
  const comment = fdStr(formData, "comment");
  if (comment) {
    await prisma.comment.create({ data: { entityType: "MEDICAL_INFO_DECLARATION", entityId: id, body: comment, authorId: user.id } });
  }
  // Reporte l'ordre de dépense sur l'événement source (tout reste interconnecté).
  if (order) {
    if (decl.sourceType === "SPONSORING") await prisma.sponsoringRequest.update({ where: { id: decl.sourceId }, data: { expenseOrderId: order.id } });
    else if (decl.sourceType === "CONGRESS_INTERNATIONAL") await prisma.congressInternational.update({ where: { id: decl.sourceId }, data: { expenseOrderId: order.id } });
    else if (decl.sourceType === "CONGRESS_NATIONAL") await prisma.congressNational.update({ where: { id: decl.sourceId }, data: { expenseOrderId: order.id } });
  }
  const qualite = qualiteDuDecideur(user);
  if (decl.requesterId) await notifyUser({ userId: decl.requesterId, type: "GENERIC", title: `Information médicale — événement validé (${qualite})`, body: `${decl.reference} — ${decl.label}`, link: `${PATH}/${id}` });
  if (decl.pharmacistId && decl.pharmacistId !== user.id) await notifyUser({ userId: decl.pharmacistId, type: "GENERIC", title: `Information médicale — validé par le ${qualite}`, body: `${decl.reference} — ${decl.label}`, link: `${PATH}/${id}` });
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: id, summary: `Validation finale (${qualite}) — ${decl.reference}${order ? ` (ordre ${order.reference})` : parLesPostes ? " (dépense portée par les postes — aucun ordre global)" : ""}` });
  // LE VISA D'UN PAIEMENT DE MATÉRIEL EST OBTENU : c'est peut-être la dernière pièce de son dossier,
  // qui ne se clôt « payé et visé » qu'à la déclaration VALIDÉE (`promo-cloture.ts`). Best-effort.
  if (decl.sourceType === "LEGAL_DOCUMENT") {
    const promoId = await dossierPromoDeLaFacture(decl.sourceId).catch(sansBloquer("medical-info-actions.validateDeclarationByDirection.dossierPromoDeLaFacture", null));
    if (promoId && (await cloreLeDossierPromoSiSolde(promoId, user.id))) revalidatePath(`/promo-material/${promoId}`);
  }
  revalidate(id);
  revalidatePath("/mon-travail");
  revalidatePath("/finances/paiements-a-faire");
  revalidatePath("/comptabilite");
  return { ok: true };
}

/**
 * LE DIRECTEUR DES OPÉRATIONS REFUSE — motif EXIGÉ, et le dossier revient au pharmacien.
 *
 * Il n'avait que « valider » : un dossier qu'il n'acceptait pas restait en attente sans fin, et le
 * pharmacien n'apprenait jamais pourquoi. Le refus rend la main au PRIM (le statut d'instruction
 * se recalcule sur ses pièces), le motif lui est notifié, versé dans la discussion et tracé au
 * journal (`REFUS_FINAL_CHAMP`, que la fiche relit). Écriture conditionnelle : un refus et une
 * validation simultanés ne s'appliquent pas tous les deux.
 */
export async function refuseDeclarationByDirection(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!estDecideurInfoMed(user)) return { ok: false, error: `Le refus revient au ${DECIDEUR_INFO_MED_LABEL} (à défaut, au Super Admin).` };
  const id = fdStr(formData, "id");
  const reason = fdStr(formData, "reason");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  if (reason === null) return { ok: false, error: "Indiquez le motif du refus : c'est ce que lira le pharmacien pour reprendre le dossier." };
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  if (decl.status === "VALIDATED") return { ok: false, error: "Déclaration déjà validée." };
  if (decl.status !== "AWAITING_DIRECTION") return { ok: false, error: "Ce dossier n'attend pas de validation finale." };
  const refus = refusDecideur(user, decl);
  if (refus) return { ok: false, error: refus };

  const pris = await prisma.medicalInfoDeclaration.updateMany({
    where: { id, status: "AWAITING_DIRECTION" },
    data: { status: "AWAITING_REVIEW", pharmacistValidatedAt: null, pharmacistValidatedById: null },
  });
  if (pris.count === 0) return { ok: false, error: DEJA_TRANCHE };
  // Le statut d'instruction se relit sur les pièces (à instruire / pièces demandées / prêt).
  await refreshStatus(id);

  const qualite = qualiteDuDecideur(user);
  await prisma.comment.create({
    data: { entityType: "MEDICAL_INFO_DECLARATION", entityId: id, body: `Validation finale refusée (${qualite}) — ${reason}`, authorId: user.id },
  });
  const destinataires = new Set([decl.pharmacistValidatedById, decl.pharmacistId].filter((x): x is string => Boolean(x) && x !== user.id));
  for (const userId of destinataires) {
    await notifyUser({
      userId, type: "GENERIC",
      title: `Information médicale — validation finale refusée (${qualite})`,
      body: `${decl.reference} — ${decl.label}. Motif : « ${reason} ». Reprenez le dossier, puis validez-le de nouveau.`,
      link: `${PATH}/${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "REFUSE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    field: REFUS_FINAL_CHAMP, newValue: reason,
    summary: `Validation finale refusée (${qualite}) — ${decl.reference} : ${reason}`,
  });
  revalidate(id);
  revalidatePath("/mon-travail");
  return { ok: true };
}

// ───────────── Le produit de la déclaration ─────────────

/**
 * CORRIGER LE PRODUIT D'UNE DÉCLARATION (Direction, 10/2026) — repris de la source à la création, il se corrige ici parmi nos
 * produits ; vide = « non précisé ». C'est lui que lit Produits 360 › Réglementaire & qualité. Réservé à qui instruit le
 * dossier (pharmacien responsable, vue globale) : le produit d'une déclaration aux autorités ne se change pas à la légère.
 */
export async function changerProduitDeclaration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const productId = fdStr(formData, "productId");
  const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { id }, select: { id: true, reference: true, productId: true } });
  if (!decl) return { ok: false, error: "Déclaration introuvable." };
  let nom: string | null = null;
  if (productId) {
    const p = await prisma.product.findFirst({ where: { id: productId, isActive: true }, select: { canonicalName: true } });
    if (!p) return { ok: false, error: "Produit introuvable parmi nos produits actifs : rechargez la page." };
    nom = p.canonicalName;
  }
  if ((decl.productId ?? null) === (productId ?? null)) return { ok: true };
  await prisma.medicalInfoDeclaration.update({ where: { id }, data: { productId: productId ?? null } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: id,
    field: "Produit", newValue: nom ?? "non précisé", summary: `Produit de la déclaration ${decl.reference} : ${nom ?? "non précisé"}`,
  });
  revalidate(id);
  if (productId) revalidatePath(`/produits/${productId}`);
  if (decl.productId) revalidatePath(`/produits/${decl.productId}`);
  return { ok: true };
}

// ───────────── Espace de discussion (parties prenantes) ─────────────

/** Ajoute un commentaire à la déclaration (toute personne pouvant la consulter). */
export async function addMedicalInfoComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const declarationId = fdStr(formData, "declarationId");
  const body = fdStr(formData, "body");
  if (!declarationId || !body) return { ok: false, error: "Commentaire vide." };
  const decl = await getDeclaration(declarationId);
  if (!decl || !canViewDeclaration(user, decl)) return { ok: false, error: "Action non autorisée." };
  await prisma.comment.create({ data: { entityType: "MEDICAL_INFO_DECLARATION", entityId: declarationId, body, authorId: user.id } });
  revalidate(declarationId);
  return { ok: true };
}
