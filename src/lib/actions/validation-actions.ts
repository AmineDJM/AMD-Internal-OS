"use server";

import { revalidatePath } from "next/cache";
import { OBJET_BC, MODULE_BC, CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { LIBELLE_CENTRE_BC, reserveDeLAiguillage } from "@/lib/bons-de-commande/regle";
import { signalerSiASigner } from "@/lib/bons-de-commande/etat";
import { LIBELLE_SOURCE_BC, OBJET_PREVALIDATION_BC, lireSourceBC, refusSoumissionBC, refusValidationFinale, validateursDuFormulaire } from "@/lib/bons-de-commande/prevalidation";
import { bcASoumettre, libererPrevalidation, peutCreerUnBC, retenirPourPrevalidation } from "@/lib/bons-de-commande/retenue-bc";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import type { Priority, UserRole, ValidationMode, ValidationStatus, ValidationStepState } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { createValidationFromRules, createDirectValidation, notifyValidator, joindrePiecesValidation, reprendreEtapesRenvoyees, verifierPiecesValidation } from "@/lib/validation";
import { issueDeLaDecision, motifExige, MOTIF_EXIGE, repriseApresCorrection, resoumissionSurPlace, cheminsDeLObjetLie, type DecisionEtape } from "@/lib/validations/decision";
import { lireCircuit } from "@/lib/validations/lecture-circuit";
import { refusDuRetraitValidation, retraitEfface, validateursSollicites } from "@/lib/validations/retrait";
import { createExpenseOrder } from "@/lib/expense-orders";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { toNumber } from "@/lib/utils";
import { fdStr, fdNum, fdDate, fdBool, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity, lecteurDeLaDemandeDeValidation } from "@/lib/entity-access";
import { lienEtapeAValider } from "@/lib/chemins/validations";

const ROLES: UserRole[] = [
  "SUPER_ADMIN", "DIRECTION", "HEAD_OF_REGULATORY", "REGULATORY_ASSISTANT", "HEAD_OF_SALES",
  "SALES_USER", "LOGISTICS_MANAGER", "MEDICAL_PROMOTION_MANAGER", "MEDICAL_DELEGATE", "NATIONAL_SALES",
  "PRODUCT_MANAGER", "BUSINESS_DEVELOPMENT_MANAGER", "FINANCE_BUDGET_MANAGER", "VIEWER",
];
const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const roleOrNull = (s: string | null): UserRole | null => (s && ROLES.includes(s as UserRole) ? (s as UserRole) : null);
const priorityOrNull = (s: string | null): Priority | null => (s && PRIORITIES.includes(s as Priority) ? (s as Priority) : null);
const SUPER_ONLY: ActionResult = { ok: false, error: "Réservé au Super Admin." };

// ───────────────────────────── Règles (Super Admin) ─────────────────────────────

function readRuleData(formData: FormData) {
  return {
    module: fdStr(formData, "module"),
    objectType: fdStr(formData, "objectType"),
    description: fdStr(formData, "description"),
    minAmount: fdNum(formData, "minAmount"),
    maxAmount: fdNum(formData, "maxAmount"),
    department: fdStr(formData, "department"),
    requesterRole: roleOrNull(fdStr(formData, "requesterRole")),
    priority: priorityOrNull(fdStr(formData, "priority")),
    category: fdStr(formData, "category"),
    validator1Id: fdStr(formData, "validator1Id"),
    validator2Id: fdStr(formData, "validator2Id"),
    mode: (fdStr(formData, "mode") === "PARALLEL" ? "PARALLEL" : "SEQUENTIAL") as ValidationMode,
  };
}

export async function createValidationRule(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de la règle est obligatoire." };
  const data = readRuleData(formData);
  if (!data.validator1Id) return { ok: false, error: "Au moins un validateur est requis." };

  const created = await prisma.validationRule.create({
    data: { name, ...data, active: true, createdById: user.id },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: created.id, summary: `Règle « ${name} »` });
  revalidatePath("/admin/validations");
  return { ok: true, id: created.id };
}

export async function updateValidationRule(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Nom requis." };
  const data = readRuleData(formData);
  if (!data.validator1Id) return { ok: false, error: "Au moins un validateur est requis." };

  await prisma.validationRule.update({ where: { id }, data: { name, ...data, active: fdBool(formData, "active") } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id, summary: `Règle « ${name} » modifiée` });
  revalidatePath("/admin/validations");
  return { ok: true, id };
}

export async function toggleValidationRule(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const rule = await prisma.validationRule.findUnique({ where: { id }, select: { active: true } });
  if (!rule) return { ok: false, error: "Règle introuvable." };
  await prisma.validationRule.update({ where: { id }, data: { active: !rule.active } });
  revalidatePath("/admin/validations");
  return { ok: true };
}

export async function deleteValidationRule(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  await prisma.validationRule.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id, summary: "Règle de validation supprimée" });
  revalidatePath("/admin/validations");
  return { ok: true };
}

// ───────────────────────────── Demandes de validation ─────────────────────────────

export async function createValidationRequest(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "VALIDATIONS", "CREATE")) return { ok: false, error: "Non autorisé." };
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Indiquez l'objet à valider." };
  // LES PIÈCES SE VÉRIFIENT AVANT LA DEMANDE : vérifiées après, un fichier trop lourd laissait une
  // demande créée sans ses pièces, sous un message d'erreur qui faisait croire qu'elle n'existait pas.
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) {
    const invalid = verifierPiecesValidation(files, (await getAppSettings()).maxUploadMb);
    if (invalid) return { ok: false, error: invalid };
  }

  // LES VALIDATEURS, choisis par le demandeur : le PRINCIPAL, puis ceux qu'il ajoute par « + » (Direction, 10/2026),
  // dans l'ordre où il les a posés — c'est l'ordre du circuit. Les anciens champs (`validator1Id`, `validator2Id`)
  // restent lus : l'assistant et les écrans d'avant les envoient encore.
  const directValidators = validateursDuFormulaire([
    ...formData.getAll("validatorId"), formData.get("validator1Id"), formData.get("validator2Id"),
  ]);

  // ── L'OBJET EST UN BON DE COMMANDE : la PRÉ-VALIDATION (`bons-de-commande/prevalidation.ts`) ──
  if (fdStr(formData, "objectKind") === "BON_DE_COMMANDE") {
    return creerPrevalidationBC(user, formData, title, directValidators, files);
  }

  let res;
  if (directValidators.length > 0) {
    res = await createDirectValidation({
      requesterId: user.id,
      title,
      description: fdStr(formData, "description"),
      link: fdStr(formData, "link"),
      module: fdStr(formData, "module"),
      priority: priorityOrNull(fdStr(formData, "priority")) ?? "MEDIUM",
      deadline: fdDate(formData, "deadline"),
      validatorIds: directValidators,
    });
  } else {
    // LE ROUTAGE PAR RÈGLES n'est plus proposé par l'écran (« Module concerné » retiré, Direction 10/2026) : on y
    // choisit un validateur principal. Il reste ouvert aux appelants qui nomment le module (assistant, autres circuits).
    const module = fdStr(formData, "module");
    if (!module) return { ok: false, error: "Choisissez le validateur principal." };
    res = await createValidationFromRules({
      module,
      objectType: fdStr(formData, "objectType"),
      title,
      description: fdStr(formData, "description"),
      amount: fdNum(formData, "amount"),
      department: fdStr(formData, "department"),
      priority: priorityOrNull(fdStr(formData, "priority")) ?? "MEDIUM",
      category: fdStr(formData, "category"),
      link: fdStr(formData, "link"),
      deadline: fdDate(formData, "deadline"),
      requesterId: user.id,
      requesterRole: user.role,
    });
  }
  if (!res.ok) return { ok: false, error: res.error };

  // Pièces jointes facultatives (vérifiées plus haut) : versées à la demande de validation, visibles
  // du demandeur et des validateurs. Un seul écrivain avec la resoumission (`joindrePiecesValidation`).
  if (files.length) await joindrePiecesValidation(res.requestId!, files, user.id);

  await recordAudit({ actorId: user.id, action: "CREATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: res.requestId!, summary: `${res.reference} — ${title}` });
  revalidatePath("/validations");
  revalidatePath("/mon-travail");
  return { ok: true, id: res.requestId };
}

/**
 * LA PRÉ-VALIDATION D'UN BC — le bon de commande vient de Legal, de l'ordinateur, ou du compositeur ; les validateurs
 * choisis donnent leur avis ; le BC est RETENU (aucun centre ne le voit) jusqu'à la validation finale.
 *
 * Déposé depuis l'ordinateur, il passe par l'écrivain du registre (`createLegalDocument`) : mêmes droits, même partie
 * de l'annuaire, même pièce jointe qu'un BC enregistré dans Legal — et il y naît déjà retenu.
 */
async function creerPrevalidationBC(
  user: Awaited<ReturnType<typeof requireUser>>, formData: FormData, title: string, validateurs: string[], files: File[],
): Promise<ActionResult> {
  if (validateurs.filter((v) => v !== user.id).length === 0) return { ok: false, error: "Choisissez le validateur principal." };
  const source = lireSourceBC(fdStr(formData, "bcSource"));
  if (!source) return { ok: false, error: "Choisissez d'où vient le bon de commande : Legal, votre ordinateur, ou composez-le ici." };

  let docId: string | null;
  if (source === "ORDINATEUR") {
    if (!peutCreerUnBC(user)) return { ok: false, error: "Déposer un bon de commande demande le droit d'écrire au registre Legal (ou aux Finances)." };
    const fichier = formData.get("bcFile");
    if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, error: "Joignez le fichier du bon de commande." };
    const fd = new FormData();
    fd.set("kind", "PURCHASE_ORDER");
    fd.set("title", fdStr(formData, "bcTitle") ?? title);
    const montant = fdStr(formData, "bcAmount");
    if (montant) fd.set("amount", montant);
    const reference = fdStr(formData, "bcReference");
    if (reference) fd.set("reference", reference);
    // Le fournisseur vient de l'ANNUAIRE, comme pour tout BC enregistré dans Legal (le sélecteur de l'écran, ou un nom
    // que l'écrivain du registre résout contre l'annuaire).
    for (const partie of formData.getAll("bcCounterpartyIds").map(String).filter(Boolean)) fd.append("counterpartyIds", partie);
    const fournisseur = fdStr(formData, "bcFournisseur");
    if (fournisseur) fd.set("counterpartyName", fournisseur);
    fd.append("attachment", fichier);
    fd.set("prevalidation", "1");
    const cree = await createLegalDocument(undefined, fd);
    if (!cree.ok || !cree.id) return { ok: false, error: cree.ok ? "Le bon de commande n'a pas pu être enregistré." : cree.error };
    docId = cree.id;
  } else {
    docId = fdStr(formData, "legalDocumentId");
    if (!docId) {
      return { ok: false, error: source === "COMPOSER" ? "Composez puis émettez le bon de commande avant d'envoyer la demande." : "Choisissez le bon de commande à importer." };
    }
    if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", docId, "VIEW"))) return { ok: false, error: "Ce bon de commande ne vous est pas ouvert." };
  }

  const bc = await bcASoumettre(docId);
  if (!bc) return { ok: false, error: "Bon de commande introuvable." };
  const refus = refusSoumissionBC(bc);
  if (refus) return { ok: false, error: refus };

  const res = await createDirectValidation({
    requesterId: user.id,
    title,
    description: fdStr(formData, "description"),
    link: `/legal/${docId}`,
    module: MODULE_BC,
    objectType: OBJET_PREVALIDATION_BC,
    entityType: "LEGAL_DOCUMENT",
    entityId: docId,
    amount: bc.amount,
    priority: priorityOrNull(fdStr(formData, "priority")) ?? "MEDIUM",
    deadline: fdDate(formData, "deadline"),
    validatorIds: validateurs,
  });
  if (!res.ok || !res.requestId) return { ok: false, error: res.error ?? "La demande n'a pas pu être créée." };

  const retenu = await retenirPourPrevalidation(docId, res.requestId, user.id);
  if (!retenu.ok) {
    // Une demande qui ne retient pas son BC le laisserait partir au centre pendant qu'on recueille des avis : on la
    // ferme aussitôt, en disant pourquoi.
    await prisma.validationRequest.update({ where: { id: res.requestId }, data: { status: "CANCELLED", decidedAt: new Date() } }).catch(() => undefined);
    return { ok: false, error: retenu.error };
  }
  if (files.length) await joindrePiecesValidation(res.requestId, files, user.id);

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: res.requestId,
    summary: `${res.reference} — pré-validation du bon de commande ${bc.reference ?? bc.title} (${LIBELLE_SOURCE_BC[source].toLowerCase()})`,
  });
  revalidatePath("/validations");
  revalidatePath("/mon-travail");
  revalidatePath(`/legal/${docId}`);
  return {
    ok: true, id: res.requestId,
    message: "Pré-validation envoyée. Quand tous les validateurs auront accepté, demandez la validation finale : le bon de commande partira alors au centre de validation.",
  };
}

/**
 * DEMANDER LA VALIDATION FINALE D'UN BC PRÉ-VALIDÉ — le CTA du demandeur.
 *
 * La retenue tombe et l'aiguillage ordinaire prend la main : le centre de validation des bons de commande (Ad & Pro si
 * le BC en vient, le centre de validations sinon), puis, validé, la signature dans le module Bons de commande. Rien de
 * plus n'est inventé ici : c'est le circuit de tout BC (§118.148, §118.149).
 */
export async function demanderValidationFinaleBC(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.validationRequest.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, status: true, requesterId: true, objectType: true, entityType: true, entityId: true },
  });
  if (!req || req.objectType !== OBJET_PREVALIDATION_BC || req.entityType !== "LEGAL_DOCUMENT" || !req.entityId) {
    return { ok: false, error: "Cette demande ne porte pas sur un bon de commande." };
  }
  const doc = await prisma.legalDocument.findUnique({ where: { id: req.entityId }, select: { bcPrevalidationRequestId: true } });
  const refus = refusValidationFinale({ statut: req.status, demandeurId: req.requesterId, retenu: doc?.bcPrevalidationRequestId === req.id }, user);
  if (refus) return { ok: false, error: refus };

  const { libere, aiguillage } = await libererPrevalidation(req.entityId, req.id, user.id, `validation finale demandée après la pré-validation ${req.reference}.`);
  if (!libere) return { ok: false, error: "La validation finale a déjà été demandée." };

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: req.id,
    summary: `${req.reference} — validation finale du bon de commande demandée`,
  });
  revalidatePath("/validations");
  revalidatePath(`/validations/${req.id}`);
  revalidatePath(`/legal/${req.entityId}`);
  revalidatePath("/centre-de-validations");
  revalidatePath("/centre-ad-pro");
  revalidatePath(CHEMIN_BC_A_SIGNER);
  const phrase = aiguillage ? reserveDeLAiguillage(aiguillage) : null;
  const tete = aiguillage?.porte
    ? `Validation finale demandée : le bon de commande est adressé au ${LIBELLE_CENTRE_BC[aiguillage.porte.centre]}. Validé, il passera à la signature (module Bons de commande).`
    : "Validation finale demandée.";
  return { ok: true, message: [tete, aiguillage?.porte ? null : phrase].filter(Boolean).join(" ") };
}

/**
 * QUI PEUT TRANCHER CETTE ÉTAPE — son validateur, le Super Admin, ou l'INTÉRIMAIRE de l'absent
 * (§118.185 — audit 360°, I18). Les trois gestes d'une étape (décider, juger une pièce, retirer
 * ce jugement) lisent cette fonction : l'intérimaire voyait l'étape, pouvait la décider, et se
 * voyait refuser le jugement de ses pièces — un bouton offert puis retiré (§118.83).
 *
 * L'intérim ne fait JAMAIS trancher sa propre demande : remplacer son N+1 ne donne pas le droit
 * de s'approuver soi-même. La règle « on ne décide pas pour soi » vaut ici comme partout.
 */
async function droitSurLEtape(
  user: { id: string; role: string },
  validatorId: string,
  requesterId: string | null,
): Promise<"VALIDATEUR" | "SUPER_ADMIN" | "INTERIM" | null> {
  if (validatorId === user.id) return "VALIDATEUR";
  if (user.role === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (requesterId !== user.id && (await actsForUser(user.id, validatorId))) return "INTERIM";
  return null;
}

export async function decideValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const stepId = fdStr(formData, "stepId");
  const decision = fdStr(formData, "decision") as ValidationStepState | null;
  const reason = fdStr(formData, "reason");
  if (!stepId || !decision || !["APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(decision)) {
    return { ok: false, error: "Décision invalide." };
  }

  // REFUSER OU RENVOYER SANS DIRE POURQUOI (audit 360°, R08 et R17) laisse le demandeur deviner ce
  // qu'il doit corriger, et l'historique muet sur ce qui a arrêté la demande. L'accord reste sans motif.
  // `=== null` et non `!reason` : la dérivation des contrats lit un `!v` comme « champ obligatoire »,
  // et le motif ne l'est QUE pour renvoyer ou refuser — valider sans commentaire reste possible (§118.138).
  if (motifExige(decision as DecisionEtape) && reason === null) return { ok: false, error: MOTIF_EXIGE };

  const step = await prisma.validationStep.findUnique({
    where: { id: stepId },
    include: { request: { include: { steps: true } } },
  });
  if (!step) return { ok: false, error: "Étape introuvable." };
  // L'INTÉRIMAIRE D'UN CONGÉ décide à la place de l'absent. C'est tout l'objet de l'intérim :
  // sans cela, les validations s'empilent trois semaines et l'on découvre au retour qu'une
  // demande attendait depuis quinze jours. La délégation est validée par les RH et s'éteint
  // seule à la fin du congé — voir `lib/hr/stand-in.ts`. Jamais sur sa propre demande (I18).
  const droit = await droitSurLEtape(user, step.validatorId, step.request.requesterId);
  if (!droit) {
    return { ok: false, error: "Vous n'êtes pas le validateur de cette étape." };
  }
  const asStandIn = droit === "INTERIM";
  if (step.status !== "PENDING") return { ok: false, error: "Étape déjà traitée." };

  const req = step.request;
  if (req.status === "CHANGES_REQUESTED") {
    return { ok: false, error: "Cette demande a été renvoyée pour correction : elle reviendra vers vous quand son demandeur l'aura resoumise." };
  }
  if (req.status !== "PENDING") return { ok: false, error: "Demande déjà clôturée." };
  if (req.mode === "SEQUENTIAL" && step.order !== req.currentOrder) return { ok: false, error: "Ce n'est pas encore votre tour." };

  // UN GESTE À LA FOIS (audit 360°, lot C3). La décision se prend SOUS LE VERROU de la demande, sur
  // ses étapes RELUES : deux validateurs d'un circuit parallèle qui approuvaient à la même seconde
  // voyaient chacun l'autre « en attente », aucun ne finalisait, et la demande restait en attente
  // pour toujours sans que plus personne puisse la trancher ; un double clic sur la dernière étape
  // émettait DEUX ordres de dépense. L'écriture de l'étape est conditionnelle (encore en attente),
  // et seule la décision qui FINALISE ici déclenche ce qui suit.
  const issue = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ValidationRequest" WHERE id = ${req.id} FOR UPDATE`;
    const frais = await tx.validationRequest.findUnique({
      where: { id: req.id },
      select: { status: true, mode: true, currentOrder: true, steps: { select: { id: true, order: true, status: true, validatorId: true } } },
    });
    if (!frais || frais.status !== "PENDING") {
      return { ok: false as const, error: "Cette demande vient d'être tranchée par un autre validateur : rouvrez-la pour voir où elle en est." };
    }
    if (frais.mode === "SEQUENTIAL" && step.order !== frais.currentOrder) return { ok: false as const, error: "Ce n'est pas encore votre tour." };
    const ecrite = await tx.validationStep.updateMany({
      where: { id: stepId, status: "PENDING" },
      data: { status: decision, reason, decidedAt: new Date() },
    });
    if (ecrite.count === 0) return { ok: false as const, error: "Étape déjà traitée." };
    const etapes = frais.steps.map((e) => (e.id === stepId ? { ...e, status: decision } : e));
    const r = issueDeLaDecision({ mode: frais.mode, currentOrder: frais.currentOrder, steps: etapes }, stepId, decision as DecisionEtape);
    const finalisee = r.status !== "PENDING";
    await tx.validationRequest.update({
      where: { id: req.id },
      data: { status: r.status, currentOrder: r.currentOrder, decidedAt: finalisee ? new Date() : null },
    });
    const suivante = r.suivanteId ? etapes.find((e) => e.id === r.suivanteId) ?? null : null;
    return { ok: true as const, status: r.status, finalisee, currentOrder: r.currentOrder, suivanteValidatorId: suivante?.validatorId ?? null, suivanteStepId: suivante?.id ?? null };
  });
  if (!issue.ok) return { ok: false, error: issue.error };
  const newStatus: ValidationStatus = issue.status;
  const finalized = issue.finalisee;
  if (issue.suivanteValidatorId) await notifyValidator(issue.suivanteValidatorId, req, issue.suivanteStepId);

  if (finalized && req.requesterId !== user.id) {
    // UNE DÉCISION SUR UNE PIÈCE N'EST PAS UNE DÉCISION SUR LA DEMANDE. « Validation acceptée »
    // sur la facture d'une demande qui en compte quatre laissait croire que tout était tranché.
    // On nomme donc l'objet de la décision, et on dit ce qu'il reste à attendre.
    const onPiece = Boolean(req.documentId);
    const pieceName = onPiece
      ? (await prisma.document.findUnique({ where: { id: req.documentId! }, select: { name: true } }))?.name ?? "Pièce jointe"
      : null;
    const stillPending = onPiece && req.entityType && req.entityId
      ? await prisma.validationRequest.count({
          where: { entityType: req.entityType, entityId: req.entityId, status: "PENDING", id: { not: req.id } },
        })
      : 0;
    const label = newStatus === "APPROVED" ? "acceptée" : newStatus === "REJECTED" ? "refusée" : "à corriger";
    // LE MOTIF VOYAGE AVEC LA DÉCISION, et le lien mène à LA demande (audit 360°, R08) : « à corriger »
    // sans dire quoi, vers la liste de toutes les validations, faisait chercher deux fois.
    const motif = reason ? ` Motif : « ${reason} ».` : "";
    const suite = newStatus === "CHANGES_REQUESTED"
      ? (resoumissionSurPlace(req)
        ? " Corrigez-la puis « Resoumettre » sur la demande : elle reviendra à la même étape."
        : " Corrigez depuis l'objet d'origine, puis renvoyez-la depuis lui.")
      // LA PRÉ-VALIDATION D'UN BC ACQUISE : le geste suivant est au demandeur, et la notification le nomme.
      : newStatus === "APPROVED" && req.objectType === OBJET_PREVALIDATION_BC
        ? " Tous les validateurs ont donné leur accord : demandez maintenant la validation finale du bon de commande."
        : "";
    await notifyUser({
      userId: req.requesterId,
      type: "GENERIC",
      title: onPiece ? `Pièce ${label} — ${pieceName}` : `Validation ${label}`,
      body: onPiece
        ? `${req.reference} · cette décision porte sur cette pièce seule.${stillPending > 0 ? ` ${stillPending} autre${stillPending > 1 ? "s" : ""} pièce${stillPending > 1 ? "s" : ""} de la même demande attend${stillPending > 1 ? "ent" : ""} encore.` : " Toutes les pièces de la demande sont désormais tranchées."}${motif}${suite}`
        : `${req.reference} — ${req.title}.${motif}${suite}`,
      link: `/validations/${req.id}`,
    });
  } else if (!finalized && req.requesterId !== user.id) {
    // UN ACCORD QUI NE CLÔT PAS LE CIRCUIT SE DIT AUSSI (Direction, 06/10). Le premier de deux validateurs
    // validait, la demande passait au second — et le demandeur n'en savait rien : sur son écran, « En
    // attente » sous un « Je valide… » sans auteur. On lui dit qui a validé, ce qu'il a écrit, et qui reste.
    const etapes = await prisma.validationStep.findMany({
      where: { requestId: req.id },
      select: { order: true, status: true, reason: true, decidedAt: true, validator: { select: { name: true } } },
    });
    const { resume } = lireCircuit({
      status: newStatus, mode: req.mode, currentOrder: issue.currentOrder,
      steps: etapes.map((e) => ({ order: e.order, status: e.status, validateur: e.validator?.name ?? "—", motif: e.reason, decideeLe: e.decidedAt })),
    });
    await notifyUser({
      userId: req.requesterId,
      type: "GENERIC",
      title: `Validation partielle — ${req.reference}`,
      body: `${req.title}. ${resume}${reason ? ` Note de ${user.name} : « ${reason} ».` : ""}`,
      link: req.link || `/validations/${req.id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: decision === "REJECTED" ? "REFUSE" : "VALIDATE", module: "Validations",
    entityType: "VALIDATION_REQUEST", entityId: req.id, field: "decision", newValue: decision,
    // Le journal DIT que la décision a été prise au titre d'un intérim. Sans cette mention, on
    // relirait « Untel a validé » sans comprendre pourquoi ce n'est pas le validateur désigné.
    summary: `${req.reference} → ${decision}${asStandIn ? " (par l'intérimaire du validateur, congé en cours)" : ""}${reason ? ` — ${reason}` : ""}`,
  });

  // PIÈCE JOINTE APPROUVÉE + MONTANT SAISI À LA SOUMISSION → la suite est FINANCIÈRE : un ordre
  // de dépense part automatiquement aux Finances (notifiées), catégorisé (catégorie choisie à la
  // soumission, sinon « Autre ») et rattaché à la demande d'origine — au règlement, la dépense
  // rejoint le budget par le circuit habituel des ordres. Sans montant, rien n'est payable :
  // l'approbation reste un simple avis sur la pièce.
  //
  // UNE DEMANDE ANNULÉE NE REÇOIT PAS DE PAIEMENT (vague « restes 2 ») — la règle de `decideApproval`
  // (§118.197d), que cette émission n'appliquait pas. La décision ci-dessus juge la PIÈCE, sous le verrou
  // de la validation ; elle ne relisait pas la DEMANDE au secrétariat. L'annulation de la demande
  // (`annulerDemandeSecretariat`) relit ses ordres APRÈS sa propre écriture : elle rattrape un ordre né
  // AVANT elle, jamais un ordre né après. Joué : la décision écrit APPROVED, l'annulation passe et ne
  // trouve aucun ordre, puis l'ordre naît — payable au centre pour une demande annulée, sans un mot.
  // Deux lectures, donc : AVANT d'émettre (une demande déjà annulée ou supprimée n'en reçoit aucun, et le
  // centre n'est pas sollicité pour rien) ; APRÈS l'émission (une annulation passée entre les deux voit
  // l'ordre qu'elle ne pouvait pas voir annulé par la porte unique, conditionnelle — un ordre réglé n'est
  // jamais défait). L'une ou l'autre voit l'annulation : chacun écrit avant de relire l'autre. L'accord sur
  // la pièce, lui, reste enregistré — et la phrase le DIT.
  let paiementRetire: string | null = null;
  if (newStatus === "APPROVED" && req.documentId && req.entityType === "ADMIN_REQUEST" && req.entityId) {
    const amt = req.amount === null ? 0 : toNumber(req.amount);
    if (amt > 0) {
      const demandeId = req.entityId;
      const avant = await prisma.administrativeRequest.findUnique({ where: { id: demandeId }, select: { reference: true, status: true, deletedAt: true } });
      if (demandeSansPaiement(avant)) {
        paiementRetire = `La demande ${avant?.reference ?? "au secrétariat"} a été annulée ou supprimée : votre accord sur la pièce est enregistré, mais aucun paiement n'a été émis — rechargez la page.`;
      } else {
        let ordre: { id: string; reference: string } | null = null;
        try {
          ordre = await createExpenseOrder({
            label: req.title,
            amount: amt,
            category: (req.category as Parameters<typeof createExpenseOrder>[0]["category"]) ?? "AUTRE",
            sourceType: "ADMIN_REQUEST",
            sourceId: demandeId,
            requestedById: req.requesterId,
            notes: `Pièce validée (${req.reference})${req.description ? ` — ${req.description}` : ""}`,
          });
          revalidatePath("/finances/paiements-a-faire");
        } catch (err) {
          // L'ordre raté ne doit pas annuler la décision déjà enregistrée — on trace et on continue.
          console.error("[validations] ordre de dépense post-approbation échoué :", err);
        }
        if (ordre) {
          const apres = await prisma.administrativeRequest.findUnique({ where: { id: demandeId }, select: { reference: true, status: true, deletedAt: true } });
          if (demandeSansPaiement(apres)) {
            const ref = apres?.reference ?? avant?.reference ?? "au secrétariat";
            const retrait = await annulerOrdreNonRegle(ordre.id, { acteurId: user.id, motif: `demande ${ref} annulée pendant la décision sur la pièce ${req.reference}` });
            paiementRetire = retrait.ok
              ? `La demande ${ref} vient d'être annulée pendant votre décision : votre accord sur la pièce est enregistré, mais le paiement ${ordre.reference} qu'il émettait a été annulé — rechargez la page.`
              : `La demande ${ref} vient d'être annulée pendant votre décision, et le paiement ${ordre.reference} qu'il émettait n'a pas pu être annulé : ${retrait.error}`;
          }
        }
      }
    }
  }

  // Reflet sur la demande administrative liée : une fois la validation finalisée,
  // la demande repasse « en cours » pour que l'assistante poursuive (ou retravaille
  // en cas de refus / modification demandée — le va-et-vient du flux achat).
  // Une validation de PIÈCE JOINTE (documentId) est un avis sur cette pièce : elle ne fait pas
  // repartir le flux de la demande — sinon valider une facture ressusciterait une demande close.
  if (finalized && req.entityType === "ADMIN_REQUEST" && req.entityId && !req.documentId) {
    // Jamais une demande TERMINÉE ou ANNULÉE (§118.187) : depuis qu'un demandeur annule au-delà de
    // trente minutes, la demande reste visible au lieu d'être effacée — une validation tranchée après
    // coup ne doit pas la ressusciter « en cours ».
    await prisma.administrativeRequest.updateMany({ where: { id: req.entityId, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } }, data: { status: "IN_PROGRESS" } });
    revalidatePath("/demandes");
    revalidatePath("/demandes/assistant");
  }
  // CHAQUE DÉCISION, pas seulement la dernière (Direction, 06/10) : la fiche d'origine montre ce que
  // chaque validateur a dit — le premier accord d'un circuit à deux doit s'y lire aussi.
  for (const chemin of cheminsDeLObjetLie(req)) revalidatePath(chemin);

  // UN BON DE COMMANDE VALIDÉ PASSE À LA SIGNATURE DES FINANCES (§118.149) — elles en sont
  // prévenues, sans quoi la file « à signer » se remplirait en silence. Relu, jamais supposé :
  // un BC annulé ou déjà signé entre-temps ne prévient personne.
  if (newStatus === "APPROVED" && req.entityType === "LEGAL_DOCUMENT" && req.objectType === OBJET_BC && req.entityId) {
    await signalerSiASigner(req.entityId).catch(() => undefined);
    revalidatePath(CHEMIN_BC_A_SIGNER);
    revalidatePath(`/legal/${req.entityId}`);
  }

  revalidatePath("/validations");
  revalidatePath("/admin/validations");
  revalidatePath("/mon-travail");
  // L'accord est enregistré, le paiement n'est pas parti (ou a été retiré) : on le DIT, comme
  // `decideApproval` — une décision « réussie » sur un paiement annulé serait une phrase fausse.
  if (paiementRetire) return { ok: false, error: paiementRetire };
  return { ok: true };
}

/**
 * Une demande au secrétariat qui n'est plus là pour recevoir un paiement : effacée, supprimée ou
 * annulée — la condition même de `decideApproval`. Une demande TERMINÉE, elle, garde son paiement :
 * le montant a bien été autorisé (§118.187).
 */
function demandeSansPaiement(d: { status: string; deletedAt: Date | null } | null): boolean {
  return !d || d.deletedAt !== null || d.status === "CANCELLED";
}

const ITEM_DECISIONS: ValidationStepState[] = ["APPROVED", "REJECTED", "CHANGES_REQUESTED"];

/**
 * Décision GRANULAIRE d'un validateur sur UN élément de la demande : le « message »
 * (itemKey = "MESSAGE") ou une pièce jointe précise (itemKey = id du Document).
 * Approuver / Refuser / Demander une révision, avec commentaire OPTIONNEL. Vient EN
 * PLUS de la décision globale (qui fait avancer le circuit) : c'est un retour détaillé,
 * pièce par pièce, pour le demandeur. Idempotent — réenregistrer met à jour le verdict.
 */
export async function reviewValidationItem(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const stepId = fdStr(formData, "stepId");
  const itemKey = fdStr(formData, "itemKey");
  const decision = fdStr(formData, "decision") as ValidationStepState | null;
  const comment = fdStr(formData, "comment");
  if (!stepId || !itemKey || !decision || !ITEM_DECISIONS.includes(decision)) {
    return { ok: false, error: "Décision invalide." };
  }
  const step = await prisma.validationStep.findUnique({
    where: { id: stepId },
    include: { request: { select: { status: true, mode: true, currentOrder: true, requesterId: true } } },
  });
  if (!step) return { ok: false, error: "Étape introuvable." };
  const isSuper = user.role === "SUPER_ADMIN";
  if (!(await droitSurLEtape(user, step.validatorId, step.request.requesterId))) {
    return { ok: false, error: "Vous n'êtes pas le validateur de cette étape." };
  }
  if (step.status !== "PENDING") return { ok: false, error: "Étape déjà traitée." };
  if (step.request.status !== "PENDING") return { ok: false, error: "Demande déjà clôturée." };
  if (step.request.mode === "SEQUENTIAL" && step.order !== step.request.currentOrder && !isSuper) {
    return { ok: false, error: "Ce n'est pas encore votre tour." };
  }
  // L'itemKey doit désigner soit le message, soit une pièce RÉELLEMENT jointe à la demande.
  if (itemKey !== "MESSAGE") {
    const doc = await prisma.document.findFirst({
      where: { id: itemKey, entityType: "VALIDATION_REQUEST", entityId: step.requestId },
      select: { id: true },
    });
    if (!doc) return { ok: false, error: "Pièce introuvable." };
  }
  await prisma.validationItemDecision.upsert({
    where: { stepId_itemKey: { stepId, itemKey } },
    create: { stepId, itemKey, decision, comment: comment || null },
    update: { decision, comment: comment || null },
  });
  revalidatePath("/validations");
  return { ok: true };
}

/** Retire le verdict d'un élément (le validateur revient à « non évalué »). */
export async function clearValidationItem(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const stepId = fdStr(formData, "stepId");
  const itemKey = fdStr(formData, "itemKey");
  if (!stepId || !itemKey) return { ok: false, error: "Paramètres manquants." };
  const step = await prisma.validationStep.findUnique({
    where: { id: stepId }, select: { validatorId: true, status: true, request: { select: { requesterId: true } } },
  });
  if (!step) return { ok: false, error: "Étape introuvable." };
  if (!(await droitSurLEtape(user, step.validatorId, step.request.requesterId))) return { ok: false, error: "Non autorisé." };
  if (step.status !== "PENDING") return { ok: false, error: "Étape déjà traitée." };
  await prisma.validationItemDecision.deleteMany({ where: { stepId, itemKey } });
  revalidatePath("/validations");
  return { ok: true };
}

/**
 * RELANCER LE VALIDATEUR QUI BLOQUE — l'action qui manquait à la supervision.
 *
 * La Direction voyait la liste des demandes en attente sans rien pouvoir en faire : constater
 * qu'une validation dort depuis trois semaines et devoir sortir de l'outil pour envoyer un
 * message, c'est une supervision qui ne supervise rien. Le rappel part à la personne dont on
 * attend la décision, et il est TRACÉ (audit) : une relance qu'on ne peut pas prouver se
 * répète indéfiniment.
 *
 * Réservé à la vue globale : c'est une pression hiérarchique, pas un bouton de confort.
 */
/**
 * RETIRER SA PROPRE DEMANDE DE VALIDATION.
 *
 * Une demande partie par erreur — mauvais validateur, mauvaise pièce, objet abandonné — occupait
 * jusqu'ici la file de quelqu'un d'autre pour toujours : seul le Super Admin pouvait l'effacer,
 * et on ne le dérange pas pour ça. Le demandeur reprend donc la sienne.
 *
 * DEUX BORNES, et elles ne se négocient pas :
 *   • seul LE DEMANDEUR (ou le Super Admin) retire — un validateur qui supprimerait ce qu'on lui
 *     soumet ferait disparaître la demande au lieu de la refuser, sans motif et sans trace ;
 *   • une demande DÉJÀ TRANCHÉE ne se retire pas. L'accord ou le refus d'un tiers est un fait :
 *     l'effacer réécrirait ce que quelqu'un a signé. On ne retire que ce qui attend encore.
 *
 * UNE DEMANDE QUI A UN HISTORIQUE S'ABANDONNE, ELLE NE S'EFFACE PAS (audit 360°, R08). Renvoyée pour
 * correction, elle restait « à corriger » pour toujours si son demandeur renonçait ; resoumise, elle
 * porte dans son fil ce qu'un validateur a demandé. L'abandon la CLÔT (annulée, visible, son fil
 * intact) au lieu de la supprimer — seule une demande vierge, à sa première version, s'efface encore.
 */
/**
 * UNE PRÉ-VALIDATION RETIRÉE REND SON BC AU CIRCUIT ORDINAIRE. Le laisser retenu sans demande pour le lever serait un
 * BC bloqué pour toujours ; le laisser hors circuit, une pièce qui n'a l'air ni validée ni à valider. Le sens sûr :
 * l'aiguillage le rend à son centre, comme tout BC — le demandeur peut l'y annuler s'il n'en veut plus.
 */
async function rendreLeBCAuCircuit(req: { id: string; reference: string; objectType: string | null; entityId: string | null }, acteurId: string): Promise<void> {
  if (req.objectType !== OBJET_PREVALIDATION_BC || !req.entityId) return;
  await libererPrevalidation(req.entityId, req.id, acteurId, `pré-validation ${req.reference} retirée — le bon de commande retourne au circuit ordinaire.`).catch(() => undefined);
}

export async function deleteMyValidationRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.validationRequest.findUnique({
    where: { id },
    select: {
      id: true, reference: true, title: true, requesterId: true, status: true, version: true, entityType: true, documentId: true,
      objectType: true, entityId: true,
      mode: true, currentOrder: true, steps: { select: { status: true, validatorId: true, order: true } },
    },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.requesterId !== user.id && user.role !== "SUPER_ADMIN") {
    return { ok: false, error: "Seul le demandeur retire sa demande. Un validateur refuse — avec un motif, qui reste." };
  }
  // UNE RÈGLE, DEUX APPELANTS (`validations/retrait.ts`, décision du 04/10) : la demande se retire
  // tant qu'elle n'est pas TRANCHÉE — même si une étape a déjà dit oui. Une demande née d'un autre
  // circuit et renvoyée se corrige là-bas (audit 360°, I9).
  const vue = { status: req.status, version: req.version, surPlace: resoumissionSurPlace(req), steps: req.steps };
  const refus = refusDuRetraitValidation(vue);
  if (refus) return { ok: false, error: refus };

  if (!retraitEfface(vue)) {
    // UN GESTE À LA FOIS : la clôture exige l'état et la version lus — une décision passée entre la
    // lecture et le clic ne se fait pas effacer, et deux clics ne closent qu'une fois.
    const close = await prisma.validationRequest.updateMany({
      where: { id, status: req.status, version: req.version },
      data: { status: "CANCELLED", decidedAt: new Date() },
    });
    if (close.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };
    await rendreLeBCAuCircuit(req, user.id);
    if (req.status === "PENDING") {
      for (const v of validateursSollicites(req, user.id)) {
        await notifyUser({ userId: v, type: "GENERIC", title: "Validation retirée", body: `${req.reference} — ${req.title} : retirée par son demandeur, il n'y a plus rien à trancher.`, link: `/validations/${id}` }).catch(() => undefined);
      }
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id,
      field: "status", oldValue: req.status, newValue: "CANCELLED",
      summary: `Demande de validation retirée par son demandeur — ${req.reference} : ${req.title} (son historique reste)`,
    });
    revalidatePath("/validations");
    revalidatePath(`/validations/${id}`);
    return { ok: true, message: "Demande retirée : elle reste visible, close, avec son historique — les validateurs sollicités sont prévenus." };
  }

  // VIERGE : personne ne s'est prononcé, elle s'efface. La suppression exige qu'elle le soit
  // ENCORE (une étape tranchée entre-temps l'interdit) : écriture conditionnelle.
  const efface = await prisma.validationRequest.deleteMany({
    where: { id, status: "PENDING", version: req.version, steps: { every: { status: "PENDING" } } },
  });
  if (efface.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };
  await rendreLeBCAuCircuit(req, user.id);
  for (const v of validateursSollicites(req, user.id)) {
    await notifyUser({ userId: v, type: "GENERIC", title: "Validation retirée", body: `${req.reference} — ${req.title} : retirée par son demandeur.`, link: "/validations" }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Validations",
    entityType: "VALIDATION_REQUEST", entityId: id,
    summary: `Demande de validation retirée par son demandeur — ${req.reference} : ${req.title}`,
  });
  revalidatePath("/validations");
  revalidatePath("/mon-espace");
  return { ok: true };
}

/**
 * RESOUMETTRE UNE DEMANDE RENVOYÉE POUR CORRECTION — sur ELLE-MÊME (audit 360°, R08).
 *
 * « Modification demandée » clôturait la demande : on en écrivait une autre, sans lien avec la
 * première ni avec le motif. La demande corrigée reprend maintenant À L'ÉTAPE QUI L'A RENVOYÉE
 * (`repriseApresCorrection`), sa version monte, et le fil garde qui a renvoyé, pourquoi et ce qui a
 * été corrigé (`reprendreEtapesRenvoyees`). Ce que le formulaire ne porte pas ne s'écrit pas : un
 * texte ou un montant absent de l'envoi reste ce qu'il était (§118.152c).
 *
 * Seul le DEMANDEUR resoumet, et seulement une demande qui se corrige sur elle-même : une demande
 * née d'un autre circuit (un BC, une pièce du secrétariat, une déclaration) se corrige et repart de
 * LÀ-BAS — la resoumettre ici contournerait la correction que ce circuit exige.
 */
export async function resoumettreValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const note = fdStr(formData, "note");
  if (!note) return { ok: false, error: "Dites ce que vous avez corrigé : c'est la première chose que le validateur lira." };

  const req = await prisma.validationRequest.findUnique({
    where: { id },
    select: {
      id: true, reference: true, title: true, requesterId: true, status: true, mode: true, currentOrder: true,
      version: true, amount: true, entityType: true, documentId: true, link: true, objectType: true,
      steps: { select: { id: true, order: true, status: true, reason: true, validatorId: true, validator: { select: { name: true } } } },
    },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.requesterId !== user.id) return { ok: false, error: "Seul le demandeur resoumet sa demande : c'est lui qui la corrige." };
  if (!resoumissionSurPlace(req)) {
    return { ok: false, error: `Cette demande se corrige depuis son objet d'origine${req.link ? ` (${req.link})` : ""} : c'est de là qu'elle repart.` };
  }
  if (req.status !== "CHANGES_REQUESTED") {
    return { ok: false, error: req.status === "PENDING" ? "Cette demande est déjà en cours de validation." : "Cette demande a été tranchée : elle ne se resoumet plus." };
  }

  const description = formData.has("description") ? fdStr(formData, "description") : undefined;
  const montantSaisi = formData.has("amount") ? fdNum(formData, "amount") : undefined;
  if (montantSaisi != null && montantSaisi < 0) return { ok: false, error: "Le montant ne peut pas être négatif." };
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) {
    const invalid = verifierPiecesValidation(files, (await getAppSettings()).maxUploadMb);
    if (invalid) return { ok: false, error: invalid };
  }

  const avant = req.amount === null ? null : toNumber(req.amount);
  const apres = montantSaisi === undefined ? avant : montantSaisi;
  const reprise = repriseApresCorrection({ mode: req.mode, currentOrder: req.currentOrder, steps: req.steps }, avant, apres);
  const renvois = req.steps.filter((e) => e.status === "CHANGES_REQUESTED");
  const version = req.version + 1;
  const histoire = [
    `Resoumise après correction — version ${version}.`,
    ...renvois.map((e) => `Renvoyée par ${e.validator?.name ?? "le validateur"} : « ${e.reason ?? "sans motif"} ».`),
    `Ce qui a été corrigé : « ${note} ».`,
    avant !== apres
      ? `Montant : ${avant == null ? "non renseigné" : `${avant.toLocaleString("fr-FR")} DZD`} → ${apres == null ? "non renseigné" : `${apres.toLocaleString("fr-FR")} DZD`}${reprise.montantReleve ? " — relevé : les accords déjà donnés repartent avec la nouvelle version." : "."}`
      : null,
  ].filter(Boolean).join("\n");

  // UN GESTE À LA FOIS : la resoumission prend le même verrou que la décision. Deux resoumissions
  // simultanées ne montent pas deux versions ; la seconde trouve la demande déjà repartie.
  const repartie = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ValidationRequest" WHERE id = ${id} FOR UPDATE`;
    const ecrite = await tx.validationRequest.updateMany({
      where: { id, status: "CHANGES_REQUESTED", version: req.version },
      data: {
        status: "PENDING", version, currentOrder: reprise.currentOrder, decidedAt: null,
        ...(description !== undefined ? { description } : {}),
        ...(montantSaisi !== undefined ? { amount: montantSaisi } : {}),
      },
    });
    if (ecrite.count === 0) return false;
    await reprendreEtapesRenvoyees(tx, { requestId: id, etapes: reprise.aRouvrir, auteurId: user.id, histoire });
    return true;
  });
  if (!repartie) return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };
  if (files.length) await joindrePiecesValidation(id, files, user.id);

  // QUI EST PRÉVENU : ceux dont c'est de nouveau le tour — en séquentiel, l'étape où le circuit
  // reprend ; en parallèle, chaque étape rouverte. Les autres n'ont rien de neuf à faire.
  const aPrevenir = req.steps.filter((e) => reprise.aRouvrir.includes(e.id) && (req.mode !== "SEQUENTIAL" || e.order === reprise.currentOrder));
  for (const e of aPrevenir) {
    await notifyUser({
      userId: e.validatorId, type: "VALIDATION_REQUIRED",
      title: "Demande resoumise après correction",
      body: `${req.reference} — ${req.title} (version ${version}). Ce qui a été corrigé : « ${note} ».`,
      link: lienEtapeAValider(e.id),
    }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id,
    field: "version", newValue: String(version),
    summary: `${req.reference} resoumise après correction (version ${version}) — ${note}`,
  });
  revalidatePath("/validations");
  revalidatePath(`/validations/${id}`);
  revalidatePath("/mon-travail");
  return { ok: true, id, message: `Demande resoumise (version ${version}) : elle reprend à l'étape qui l'avait renvoyée.` };
}

export async function remindValidator(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!hasGlobalView(user)) return { ok: false, error: "Réservé à la Direction." };
  const stepId = fdStr(formData, "stepId");
  if (!stepId) return { ok: false, error: "Étape non précisée." };

  const step = await prisma.validationStep.findUnique({
    where: { id: stepId },
    include: { request: { select: { id: true, reference: true, title: true, link: true } } },
  });
  if (!step) return { ok: false, error: "Étape introuvable." };
  if (step.status !== "PENDING") return { ok: false, error: "Cette étape est déjà tranchée." };
  if (!step.validatorId) return { ok: false, error: "Aucun validateur n'est assigné à cette étape." };

  const note = fdStr(formData, "note");
  await notifyUser({
    userId: step.validatorId,
    type: "VALIDATION_REQUIRED",
    title: "Relance — validation en attente",
    body: `${step.request.reference} — ${step.request.title}${note ? ` · ${note}` : ""}`,
    link: lienEtapeAValider(stepId),
    push: { tag: `validation-${step.request.id}`, requireInteraction: true },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Validations",
    entityType: "VALIDATION_REQUEST", entityId: step.request.id,
    summary: `Relance du validateur — ${step.request.reference}`,
  });
  revalidatePath("/validations");
  return { ok: true };
}

// ─────────────────────────── La discussion et les participants (Direction, 06/10) ───────────────────────────

/** La demande, avec ce qui dit qui la lit (demandeur, validateurs, participants). */
async function demandeLisible(id: string) {
  return prisma.validationRequest.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, requesterId: true, steps: { select: { validatorId: true } }, participants: { select: { userId: true, addedById: true } } },
  });
}

/** Tous ceux qui suivent la demande — prévenus d'un nouveau message. */
const suiveursDe = (d: NonNullable<Awaited<ReturnType<typeof demandeLisible>>>): string[] =>
  [...new Set([d.requesterId, ...d.steps.map((s) => s.validatorId), ...d.participants.map((p) => p.userId)])];

/**
 * ÉCRIRE DANS LA DISCUSSION D'UNE DEMANDE DE VALIDATION — le demandeur, les validateurs et les participants y échangent ;
 * chacun des autres est prévenu.
 */
export async function commenterValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  const body = fdStr(formData, "body");
  if (!id || !body?.trim()) return { ok: false, error: "Message vide." };
  const d = await demandeLisible(id);
  if (!d || !(await lecteurDeLaDemandeDeValidation(user, d))) return { ok: false, error: "Demande introuvable." };
  await prisma.comment.create({ data: { entityType: "VALIDATION_REQUEST", entityId: id, body: body.trim(), authorId: user.id } });
  for (const uid of suiveursDe(d)) {
    if (uid !== user.id) {
      await notifyUser({ userId: uid, type: "GENERIC", title: `Nouveau message — ${d.reference}`, body: body.trim().slice(0, 120), link: `/validations/${id}` }).catch(() => undefined);
    }
  }
  revalidatePath(`/validations/${id}`);
  return { ok: true };
}

/** Qui ajoute des participants : le demandeur, un validateur de la demande, le Super Admin. */
async function peutGererParticipants(user: { id: string; role: string }, d: NonNullable<Awaited<ReturnType<typeof demandeLisible>>>): Promise<boolean> {
  if (user.role === "SUPER_ADMIN" || d.requesterId === user.id) return true;
  for (const s of d.steps) if (s.validatorId === user.id || (await actsForUser(user.id, s.validatorId))) return true;
  return false;
}

/** AJOUTER DES PARTICIPANTS à une demande de validation : ils la lisent et prennent part à sa discussion. */
export async function ajouterParticipantsValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  const ids = [...new Set(formData.getAll("userId").map(String).filter(Boolean))];
  if (!id) return { ok: false, error: "Demande introuvable." };
  if (ids.length === 0) return { ok: false, error: "Choisissez au moins un collègue." };
  const d = await demandeLisible(id);
  if (!d || !(await lecteurDeLaDemandeDeValidation(user, d))) return { ok: false, error: "Demande introuvable." };
  if (!(await peutGererParticipants(user, d))) return { ok: false, error: "Seuls le demandeur et les validateurs ajoutent des participants." };
  const deja = new Set(suiveursDe(d));
  const actifs = await prisma.user.findMany({ where: { id: { in: ids.filter((x) => !deja.has(x)) }, isActive: true }, select: { id: true, name: true } });
  if (actifs.length === 0) return { ok: false, error: "Ces collègues suivent déjà la demande." };
  await prisma.validationParticipant.createMany({ data: actifs.map((u) => ({ requestId: id, userId: u.id, addedById: user.id })), skipDuplicates: true });
  const noms = actifs.map((u) => u.name).join(", ");
  // LA TRACE dans le fil : qui a été ajouté, par qui.
  await prisma.comment.create({ data: { entityType: "VALIDATION_REQUEST", entityId: id, body: `A ajouté à la discussion : ${noms}.`, authorId: user.id } });
  for (const u of actifs) {
    await notifyUser({ userId: u.id, type: "GENERIC", title: `Ajouté à une demande de validation`, body: `${d.reference} — ${d.title}`, link: `/validations/${id}` }).catch(() => undefined);
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id, summary: `Participants ajoutés à ${d.reference} : ${noms}` });
  revalidatePath(`/validations/${id}`);
  return { ok: true, message: `${noms} ${actifs.length > 1 ? "participent" : "participe"} désormais à la demande.` };
}

/** RETIRER UN PARTICIPANT — par qui gère les participants, ou par lui-même (se retirer). */
export async function retirerParticipantValidation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  const userId = fdStr(formData, "userId");
  if (!id || !userId) return { ok: false, error: "Participant introuvable." };
  const d = await demandeLisible(id);
  if (!d || !(await lecteurDeLaDemandeDeValidation(user, d))) return { ok: false, error: "Demande introuvable." };
  if (userId !== user.id && !(await peutGererParticipants(user, d))) return { ok: false, error: "Non autorisé." };
  const r = await prisma.validationParticipant.deleteMany({ where: { requestId: id, userId } });
  if (r.count === 0) return { ok: false, error: "Ce collègue ne participe pas à la demande." };
  const nom = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "—";
  await prisma.comment.create({ data: { entityType: "VALIDATION_REQUEST", entityId: id, body: userId === user.id ? "S'est retiré de la discussion." : `A retiré de la discussion : ${nom}.`, authorId: user.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Validations", entityType: "VALIDATION_REQUEST", entityId: id, summary: `Participant retiré de ${d.reference} : ${nom}` });
  revalidatePath(`/validations/${id}`);
  return { ok: true };
}
