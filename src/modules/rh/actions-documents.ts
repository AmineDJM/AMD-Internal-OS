"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import type { HrRequestType, HrRequestStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { entitePermisePourFiche } from "@/lib/company";
import { userCan, hasGlobalView, rolesWithModule } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { releaseBlob } from "@/lib/drive-storage";
import { saveFile, validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createEventForUser } from "@/lib/calendar";
import { algiersInputToUtc, formatAlgiers } from "@/lib/calendar-tz";
import { formatMonth, nextMonthYm } from "@/lib/utils";
import { HR_REQUEST_TYPE, HR_REQUEST_STATUS } from "@/lib/labels";
import {
  HR_APPROVAL_TYPES, hrNature, createLeaveRequest, attachLeaveFiles, revalidateLeaveViews, hrTypeIsLeave,
  HR_TYPE_TO_LEAVE, visibilityLabel, canEditExpenseClaim, expenseAmountError, expenseEditDeadline,
  expenseEditLabel, genererEtRemettreOrdreDeMission, societeDeLOrdreDeMission, estEtatRhTraite,
  marquerDemandeRhTraitee, archiveHrRequestIfDone, genererEtRemettreAttestation, preparerAttestationTravail, type PreparationAttestation,
  type Civilite,
} from "@/modules/rh/api";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { refusAnnulationDemandeRh, STATUTS_RH_ANNULABLES } from "@/lib/annulations/regles";
import { requestDocument } from "@/lib/actions/document-request-actions";
import { etatDuRegistre } from "@/lib/references/registre-serveur";
import type { ReferenceProchaine } from "@/lib/references/registre";
import { synchroniserOrdreEmis } from "@/lib/missions-equipe/serveur";
import { refusTraitementRh } from "@/lib/missions-equipe/etat";
import { clauseSalariesVisibles } from "@/lib/queries/visibilite-listes";
import { sansBloquer } from "@/lib/journal";

const REQUEST_TYPES: HrRequestType[] = ["WORK_CERTIFICATE", "CNAS_CERTIFICATE", "SALARY_STATEMENT", "DOMICILIATION", "LEAVE_CERTIFICATE", "LEAVE_TITLE", "MISSION_ORDER", "EXPENSE_REPORT", "EXCEPTIONAL_EXIT", "SICK_LEAVE", "ANNUAL_LEAVE", "UNPAID_LEAVE", "SPECIAL_LEAVE", "MATERNITY_LEAVE", "HR_INTERVIEW", "OTHER"];
const REQUEST_STATUSES: HrRequestStatus[] = ["PENDING", "IN_PROGRESS", "READY", "DELIVERED", "REJECTED"];
const YM = /^\d{4}-\d{2}$/;
/** Types « congé » à période complète (jours entiers, début + fin obligatoires). */
const LEAVE_PERIOD_TYPES: HrRequestType[] = ["ANNUAL_LEAVE", "UNPAID_LEAVE", "SPECIAL_LEAVE", "MATERNITY_LEAVE", "SICK_LEAVE"];
/** Types nécessitant au moins une date de début (congés + absence ponctuelle). */
const PERIOD_TYPES: HrRequestType[] = [...LEAVE_PERIOD_TYPES, "EXCEPTIONAL_EXIT"];

/** Jours calendaires inclusifs entre deux dates (min 1). */
function daysInclusive(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (Number.isNaN(ms) || ms < 0) return 1;
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * Débit UNIQUE du solde de congés d'un employé lorsqu'un congé ANNUEL est accordé.
 * Verrou `balanceAppliedAt` : idempotent (jamais débité deux fois). Les congés sans
 * solde / exceptionnels / maternité / maladie ne débitent pas. Renvoie le nb de jours débités.
 */
async function applyAnnualLeaveBalance(
  req: { id: string; type: HrRequestType; employeeId: string; balanceAppliedAt: Date | null; periodDays: unknown },
  actorId: string,
  employeeName: string,
): Promise<number> {
  const pd = req.periodDays ? Number(req.periodDays) : 0;
  if (req.type !== "ANNUAL_LEAVE" || req.balanceAppliedAt || !(pd > 0)) return 0;
  // Le verrou se PREND avant de débiter, dans la même transaction : deux accords simultanés lisaient tous deux
  // `balanceAppliedAt = null` et débitaient deux fois (audit du 27/10/2026, RH-DOCUMENTS-COMMS-03).
  const debite = await prisma.$transaction(async (tx) => {
    const pris = await tx.hrDocumentRequest.updateMany({ where: { id: req.id, balanceAppliedAt: null }, data: { balanceAppliedAt: new Date() } });
    if (pris.count !== 1) return false;
    await tx.employee.update({ where: { id: req.employeeId }, data: { leaveBalanceDays: { decrement: pd } } });
    return true;
  });
  if (!debite) return 0;
  await recordAudit({ actorId, action: "UPDATE", module: "RH", summary: `Congé annuel accordé — ${employeeName} (−${pd} j de solde)` });
  return pd;
}

/**
 * Le formulaire « Nouvelle demande RH » parle en périodes (`periodStart`/`periodEnd`) ; le
 * circuit de congé parle en dates de début/fin. Cette fonction traduit, valide, crée la
 * demande unique et y verse les justificatifs.
 */
async function createLeaveFromHrForm(
  actorId: string,
  employee: { id: string; fullName: string; userId: string | null },
  type: HrRequestType,
  formData: FormData,
): Promise<ActionResult> {
  const start = fdDate(formData, "periodStart");
  if (!start) return { ok: false, error: "Indiquez la date de début du congé / de l'absence." };
  // La sortie exceptionnelle tient sur une journée : sa date de fin, c'est sa date de début.
  const end = fdDate(formData, "periodEnd") ?? (type === "EXCEPTIONAL_EXIT" ? start : null);
  if (!end) return { ok: false, error: "Indiquez la date de fin du congé." };
  if (end < start) return { ok: false, error: "La date de fin précède la date de début." };

  const created = await createLeaveRequest(actorId, employee, {
    type: HR_TYPE_TO_LEAVE[type] ?? "OTHER",
    startDate: start, endDate: end,
    reason: fdStr(formData, "details"),
  });

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) {
    const err = await attachLeaveFiles(created.id, files, actorId);
    if (err) return { ok: false, error: err };
  }
  revalidateLeaveViews(employee.id);
  return { ok: true, id: created.id };
}

/**
 * VERSER DES PIÈCES AU DOSSIER D'UNE DEMANDE RH.
 *
 * Extrait parce que la CRÉATION et la MODIFICATION en ont toutes deux besoin, et que deux
 * copies auraient fini par diverger sur ce qui compte : la validation de taille et de type, et
 * le fait qu'un échec d'écriture n'efface pas la trace de la pièce. Renvoie le message de refus,
 * ou `null` quand tout est versé.
 */
async function attachRequestFiles(requestId: string, files: File[], uploaderId: string): Promise<string | null> {
  if (files.length === 0) return null;
  const maxMb = (await getAppSettings()).maxUploadMb;
  for (const file of files) {
    const invalid = validateUpload(file.name, file.size, maxMb);
    if (invalid) return invalid;
    const key = `HR_REQUEST/${requestId}/${randomUUID()}__${file.name}`;
    try {
      await saveFile(key, Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      // ON GARDE LA LIGNE MÊME SI L'ÉCRITURE A ÉCHOUÉ : une pièce annoncée puis introuvable se
      // voit et se redemande ; une pièce silencieusement disparue laisse croire au dépôt.
      console.error("[hr-request] storage write failed, recording metadata only", err);
    }
    await prisma.document.create({
      data: {
        name: file.name, category: "OTHER", entityType: "HR_REQUEST", entityId: requestId,
        fileKey: key, mimeType: file.type || null, sizeBytes: file.size, confidentiality: "INTERNAL", uploadedById: uploaderId,
      },
    });
  }
  return null;
}

/** Demande d'attestation par l'employé (acte côté « Mon dossier RH »). */
export async function requestHrDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true, fullName: true, userId: true } });
  if (!employee) return { ok: false, error: "Aucun dossier RH n'est lié à votre compte. Contactez les RH." };

  const typeRaw = fdStr(formData, "type");
  const type = (typeRaw && REQUEST_TYPES.includes(typeRaw as HrRequestType) ? typeRaw : "WORK_CERTIFICATE") as HrRequestType;

  // UN CONGÉ N'EST PAS UN DOCUMENT À PRÉPARER : c'est une décision qui monte N+1 → RH.
  // Quelle que soit la porte d'entrée (ce formulaire, « Mon espace », ou l'assistant IA), il
  // n'existe qu'UNE demande de congé. Sans ce renvoi, un congé déposé ici échappait à la file
  // de validation, aux « Absents aujourd'hui » et au solde.
  if (hrTypeIsLeave(type)) return createLeaveFromHrForm(user.id, employee, type, formData);

  // ── NOTE DE FRAIS : UN MOIS, UN MONTANT, UNE PIÈCE ────────────────────────────────────────
  //
  // Le mois dit sur quel exercice l'imputer ; le MONTANT est ce qu'on demande, et il ne vit
  // plus dans le texte du motif — un chiffre noyé dans une phrase ne s'additionne pas et ne se
  // contrôle pas. La PIÈCE, enfin : une note de frais sans justificatif n'est pas une demande,
  // c'est une affirmation, et les RH la renverraient au premier examen.
  const expenseMonth = fdStr(formData, "expenseMonth");
  const expenseAmount = type === "EXPENSE_REPORT" ? fdNum(formData, "expenseAmount") : null;
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (type === "EXPENSE_REPORT") {
    if (!expenseMonth || !YM.test(expenseMonth)) {
      return { ok: false, error: "Indiquez le mois concerné par la note de frais." };
    }
    const mauvais = expenseAmountError(expenseAmount);
    if (mauvais) return { ok: false, error: mauvais };
    if (files.length === 0) {
      return { ok: false, error: "Joignez le justificatif : scannez-le ou choisissez-le dans vos fichiers." };
    }
  }

  // Congés / absences : période demandée. Début obligatoire ; fin obligatoire pour les congés
  // à jours entiers. Le nombre de jours est calculé si non fourni (calendaire inclusif).
  const needsPeriod = PERIOD_TYPES.includes(type);
  const periodStart = needsPeriod ? fdDate(formData, "periodStart") : null;
  const periodEnd = needsPeriod ? fdDate(formData, "periodEnd") : null;
  if (needsPeriod && !periodStart) return { ok: false, error: "Indiquez la date de début du congé / de l'absence." };
  if (LEAVE_PERIOD_TYPES.includes(type) && !periodEnd) return { ok: false, error: "Indiquez la date de fin du congé." };
  if (periodStart && periodEnd && periodEnd < periodStart) return { ok: false, error: "La date de fin précède la date de début." };
  let periodDays = needsPeriod ? fdNum(formData, "periodDays") : null;
  if (periodDays == null && periodStart && periodEnd) periodDays = daysInclusive(periodStart, periodEnd);

  const created = await prisma.hrDocumentRequest.create({
    data: {
      employeeId: employee.id, type, details: fdStr(formData, "details"),
      expenseMonth: type === "EXPENSE_REPORT" ? expenseMonth : null,
      expenseAmount: expenseAmount != null ? expenseAmount : null,
      // LA FENÊTRE EST POSÉE À L'ENVOI, pas recalculée à la lecture : elle se lit ainsi dans la
      // base, et une prolongation décidée par les RH s'écrit au même endroit au lieu de se
      // déduire d'une règle qu'il faudrait retrouver.
      editableUntil: type === "EXPENSE_REPORT" ? expenseEditDeadline(new Date()) : null,
      periodStart, periodEnd,
      periodDays: periodDays != null ? periodDays : null,
    },
  });

  // Pièces jointes (facultatives partout SAUF sur une note de frais, où le justificatif est
  // exigé plus haut), versées au dossier de la demande — visibles du demandeur et des RH.
  const refus = await attachRequestFiles(created.id, files, user.id);
  if (refus) return { ok: false, error: refus };
  await recordAudit({ actorId: user.id, action: "CREATE", module: "RH", summary: `Demande RH — ${type}` });
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "GENERIC",
    title: "Nouvelle demande RH",
    body: `${employee.fullName} a demandé un document RH.`,
    link: `/rh/demandes?demande=${created.id}`,
  });
  revalidatePath("/mon-dossier");
  revalidatePath("/rh");
  return { ok: true, id: created.id };
}

/**
 * SE CORRIGER — la note de frais, pendant quinze minutes, ou après si les RH ont rouvert.
 *
 * ── POURQUOI MODIFIER PLUTÔT QUE REFAIRE ────────────────────────────────────────────────────
 *
 * On envoie, on relit, on voit qu'on s'est trompé d'un chiffre. Sans cette porte, il faut
 * annuler et redéposer : deux demandes dans l'historique, dont une morte, et des RH qui devinent
 * laquelle fait foi. C'est la MÊME demande qui change — elle garde son identité, ses pièces, son
 * fil et sa place dans l'historique.
 *
 * ── LA GARDE VIT ICI ────────────────────────────────────────────────────────────────────────
 *
 * L'écran cache le bouton passé le délai ; cela ne prouve rien, une action serveur s'appelle
 * depuis le navigateur (§118-7). C'est CETTE ligne qui refuse — et elle refuse aussi sur une
 * note déjà tranchée, y compris rouverte : modifier après coup changerait ce sur quoi quelqu'un
 * s'est prononcé, et l'audit dirait « validée » à côté d'un montant que le validateur n'a jamais
 * vu.
 *
 * ── ET CE QUI RESTE ─────────────────────────────────────────────────────────────────────────
 *
 * L'ancien montant part à l'AUDIT (§17 : pas de second registre). Une correction d'argent qui ne
 * laisse aucune trace, c'est une note qu'on peut réécrire après lecture sans que rien ne le dise.
 */
export async function updateExpenseClaim(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };

  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    select: {
      id: true, type: true, status: true, editableUntil: true, editUnlockedAt: true,
      expenseMonth: true, expenseAmount: true, details: true, employeeId: true,
      employee: { select: { userId: true, fullName: true } },
    },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.type !== "EXPENSE_REPORT") return { ok: false, error: "Cette demande n'est pas une note de frais." };
  // SA note, et pas celle d'un autre : les RH corrigent en demandant, pas en réécrivant. Le
  // montant remboursé doit rester la parole du demandeur.
  if (req.employee.userId !== user.id) return { ok: false, error: "Seul le demandeur modifie sa note de frais." };

  const verdict = canEditExpenseClaim(req, new Date());
  if (!verdict.allowed) return { ok: false, error: expenseEditLabel(verdict) };

  const expenseMonth = fdStr(formData, "expenseMonth");
  if (!expenseMonth || !YM.test(expenseMonth)) return { ok: false, error: "Indiquez le mois concerné par la note de frais." };
  const expenseAmount = fdNum(formData, "expenseAmount");
  const mauvais = expenseAmountError(expenseAmount);
  if (mauvais) return { ok: false, error: mauvais };

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const refus = await attachRequestFiles(id, files, user.id);
  if (refus) return { ok: false, error: refus };

  const ancien = req.expenseAmount != null ? Number(req.expenseAmount) : null;
  await prisma.hrDocumentRequest.update({
    where: { id },
    data: {
      expenseMonth,
      expenseAmount,
      details: fdStr(formData, "details"),
      // LA RÉOUVERTURE SE CONSOMME. La laisser ouverte ferait d'une autorisation ponctuelle un
      // droit permanent : les RH ont dit « corrigez cette fois », pas « corrigez quand vous
      // voulez ». La fenêtre ordinaire, elle, n'est PAS reconduite — quinze minutes de plus à
      // chaque enregistrement seraient une fenêtre sans fin.
      editUnlockedAt: null,
      editUnlockedById: null,
    },
  });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH",
    entityType: "HR_REQUEST", entityId: id, field: "expenseAmount",
    oldValue: ancien != null ? String(ancien) : null,
    newValue: expenseAmount != null ? String(expenseAmount) : null,
    summary: `Note de frais corrigée par ${req.employee.fullName}${verdict.reason === "UNLOCKED" ? " (modification rouverte par les RH)" : ""}`,
  });

  // LES RH SONT PRÉVENUS quand la correction vient d'une réouverture QU'ILS ONT ACCORDÉE : sans
  // cela, ils attendent une correction déjà faite. Dans les quinze minutes ordinaires, en
  // revanche, personne n'a encore rien lu — les avertir serait du bruit.
  if (verdict.reason === "UNLOCKED") {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
      type: "GENERIC",
      title: "Note de frais corrigée",
      body: `${req.employee.fullName} a corrigé sa note de frais.`,
      link: `/rh/demandes?demande=${id}`,
    });
  }
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true, id, message: "Note de frais mise à jour." };
}

/**
 * ROUVRIR (OU REFERMER) LA MODIFICATION — une décision des RH, portée par son auteur.
 *
 * « Votre reçu est illisible, corrigez » n'a aucun sens si la personne ne peut plus rien
 * changer : elle refait une seconde note, et l'on se retrouve avec deux demandes pour une
 * dépense. On rouvre donc — mais c'est un geste HUMAIN, tracé : `editUnlockedById` dit qui.
 *
 * Refermer sert au cas symétrique : on a rouvert par erreur, ou la correction est faite et l'on
 * ne veut pas laisser la porte ouverte indéfiniment.
 */
export async function setExpenseClaimEditUnlocked(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const ouvrir = fdStr(formData, "unlock") === "1";

  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, employeeId: true, employee: { select: { userId: true, fullName: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.type !== "EXPENSE_REPORT") return { ok: false, error: "Cette demande n'est pas une note de frais." };
  // ROUVRIR UNE NOTE DÉJÀ TRANCHÉE NE SERT À RIEN et induirait en erreur : le demandeur verrait
  // « corrigez », essaierait, et se ferait refuser par la même garde un cran plus loin.
  if (ouvrir && !canEditExpenseClaim({ ...req, editableUntil: null, editUnlockedAt: new Date() }).allowed) {
    return { ok: false, error: "Cette note est déjà traitée : elle ne se modifie plus. Demandez-en une nouvelle." };
  }

  await prisma.hrDocumentRequest.update({
    where: { id },
    data: ouvrir
      ? { editUnlockedAt: new Date(), editUnlockedById: user.id }
      : { editUnlockedAt: null, editUnlockedById: null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH",
    entityType: "HR_REQUEST", entityId: id, field: "editUnlockedAt",
    summary: `${ouvrir ? "Modification rouverte" : "Modification refermée"} — note de frais de ${req.employee.fullName}`,
  });
  // Rouvrir sans le dire ne sert à rien : la personne ne retourne pas sur l'écran par hasard.
  if (ouvrir && req.employee.userId) {
    await notifyUser({
      userId: req.employee.userId, type: "GENERIC",
      title: "Vous pouvez corriger votre note de frais",
      body: "Les RH ont rouvert la modification. Corrigez-la depuis « Mon dossier RH ».",
      link: `/mon-dossier#demande-rh-${id}`,
    });
  }
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true, message: ouvrir ? "Modification rouverte — le demandeur est prévenu." : "Modification refermée." };
}

/**
 * LES RH RÉCLAMENT UN JUSTIFICATIF SUR UNE DEMANDE — au demandeur, et à personne d'autre.
 *
 * Le mécanisme existe déjà et il est générique (`DocumentRequest`, §118-5) : on ne le récrit
 * pas, on l'appelle. Ce qui change ici, c'est qu'il n'y a PAS de choix du destinataire — le
 * justificatif d'un taxi est chez celui qui l'a pris, et proposer un annuaire ferait réclamer
 * la pièce d'une personne à une autre.
 *
 * La demande apparaît alors dans « Mes pièces à fournir » du demandeur, avec sa référence, son
 * échéance et son fil — c'est-à-dire une trace de ce qu'on attend, de qui, depuis quand. C'est
 * précisément ce qu'un message perdu ne donne pas.
 *
 * Pour une EXPLICATION plutôt qu'une pièce, il n'y a rien à ajouter : le fil de la demande sert
 * déjà à cela (`addHrRequestComment`), et il prévient le demandeur.
 */
export async function askHrRequestPiece(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "requestId");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    select: { id: true, employeeId: true, employee: { select: { userId: true, fullName: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!req.employee.userId) {
    return { ok: false, error: "Cette personne n'a pas de compte : la pièce se réclame de vive voix." };
  }
  if (req.employee.userId === user.id) {
    return { ok: false, error: "C'est votre propre demande : ajoutez la pièce vous-même." };
  }

  const fd = new FormData();
  fd.set("entityType", "HR_REQUEST");
  fd.set("entityId", id);
  // Le demandeur n'a pas accès au module RH : on le ramène là où SA demande vit.
  fd.set("link", "/mon-dossier");
  fd.set("label", fdStr(formData, "label") ?? "");
  fd.set("kind", "PROOF");
  fd.set("askedToId", req.employee.userId);
  fd.set("note", fdStr(formData, "note") ?? "");
  fd.set("dueDate", fdStr(formData, "dueDate") ?? "");
  const r = await requestDocument(fd);
  if (!r.ok) return r;

  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true, id: r.id, message: `Pièce demandée à ${req.employee.fullName} — la personne est prévenue.` };
}

/** Échange dans une demande RH : le demandeur ou les RH y répondent (fil de discussion). */
export async function addHrRequestComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  const body = fdStr(formData, "body");
  if (!id || !body) return { ok: false, error: "Message vide." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  const isOwner = req.employee.userId === user.id;
  const isHr = userCan(user, "HR_REQUESTS", "UPDATE");
  if (!(isOwner || isHr)) return { ok: false, error: "Non autorisé." };

  await prisma.comment.create({ data: { entityType: "HR_REQUEST", entityId: id, body, authorId: user.id } });
  // Notifie l'autre partie.
  if (isHr && req.employee.userId) {
    await notifyUser({ userId: req.employee.userId, type: "GENERIC", title: "Réponse des RH à votre demande", body, link: `/mon-dossier#demande-rh-${id}` });
  } else if (isOwner) {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "GENERIC", title: "Message sur une demande RH", body: `${req.employee.fullName} : ${body}`, link: `/rh/demandes?demande=${id}` });
  }
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true };
}

/** Traitement d'une demande par les RH (statut + note). */
/**
 * GÉNÉRER L'ORDRE DE MISSION d'une demande (Direction, 06/10) — les RH saisissent date d'émission, référence, lieu(x),
 * dates, transport, signataire ; la plateforme remplit le document de la Direction et le remet au salarié.
 */
export async function genererOrdreDeMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande introuvable." };
  const txt = (k: string) => fdStr(formData, k) ?? "";
  const r = await genererEtRemettreOrdreDeMission(user.id, requestId, {
    dateEmission: txt("dateEmission"), reference: txt("reference"), entreprise: txt("entreprise"), adresse: txt("adresse"),
    collaborateur: txt("collaborateur"), fonction: txt("fonction"), objet: txt("objet"), destination: txt("destination"),
    datesDepart: formData.getAll("dateDepart").map(String), datesRetour: formData.getAll("dateRetour").map(String),
    transport: txt("transport"), signataire: txt("signataire"), signataireFonction: txt("signataireFonction"),
  }, { referenceSuggeree: fdStr(formData, "referenceSuggeree") });
  if (!r.ok) return r;
  await archiveHrRequestIfDone(requestId, user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${r.employeeId}`);
  revalidatePath("/rh");
  return { ok: true, id: requestId, message: r.message };
}

/**
 * LA RÉFÉRENCE QUE PORTERA L'ORDRE DE MISSION (registre commun NNN/DG/AAAA, Direction 10/2026) — ce que le champ « Référence »
 * du formulaire préremplit : la société qui émet (celle que l'ordre imprime, sinon l'employeur du salarié), si elle tient le
 * registre, et son prochain numéro — PRÉVU, rien n'est réservé. Lecture seule, pour les RH.
 */
export async function referenceOrdreDeMission(formData: FormData): Promise<ReferenceProchaine> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande introuvable." };
  return etatDuRegistre(await societeDeLOrdreDeMission(requestId, fdStr(formData, "entreprise")));
}

/**
 * L'ATTESTATION DE TRAVAIL — la demande doit être celle d'un salarié que la personne VOIT (la même clause que la file
 * « Demandes RH ») : le formulaire montre une date et un lieu de naissance, il ne s'ouvre pas sur un salarié hors périmètre.
 */
async function demandeRhVisible(userId: string, requestId: string): Promise<boolean> {
  const perimetre = await clauseSalariesVisibles(userId);
  return (await prisma.hrDocumentRequest.count({ where: { id: requestId, employee: perimetre } })) > 0;
}

/**
 * PRÉPARER L'ATTESTATION DE TRAVAIL d'une demande (Direction, 10/2026) — le formulaire des RH s'ouvre prérempli : la fiche
 * RH, puis ce que Luna (ou, IA fermée, la lecture déterministe) a lu dans le CONTRAT DE TRAVAIL du salarié, l'identité
 * légale de la société, les signataires possibles, le registre NNN/DG/AAAA. Lecture seule : rien n'est enregistré.
 */
export async function preparerAttestationDeTravail(formData: FormData): Promise<PreparationAttestation | { ok: false; error: string }> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId || !(await demandeRhVisible(user.id, requestId))) return { ok: false, error: "Demande introuvable." };
  return preparerAttestationTravail(user.id, requestId);
}

/**
 * GÉNÉRER L'ATTESTATION DE TRAVAIL (Direction, 10/2026) — « comme les ordres de mission » : les RH relisent et corrigent
 * les champs, choisissent le signataire en fin de formulaire ; la plateforme remplit le modèle de la Direction (papier à
 * en-tête), attribue la référence au registre, remet le PDF au salarié. Régénérer = une nouvelle version.
 */
export async function genererAttestationDeTravail(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId || !(await demandeRhVisible(user.id, requestId))) return { ok: false, error: "Demande introuvable." };
  const txt = (k: string) => fdStr(formData, k) ?? "";
  const civ = (v: string): Civilite | "" => (v === "Monsieur" || v === "Madame" ? v : "");
  const r = await genererEtRemettreAttestation(user.id, requestId, {
    reference: txt("reference"), civilite: civ(txt("civilite")), salarie: txt("salarie"), dateNaissance: txt("dateNaissance"),
    lieuNaissance: txt("lieuNaissance"), societe: txt("societe"), societeSignature: txt("societeSignature"), poste: txt("poste"),
    dateEmbauche: txt("dateEmbauche"), signataireCivilite: civ(txt("signataireCivilite")), signataire: txt("signataire"),
    signataireFonction: txt("signataireFonction"), lieuSignature: txt("lieuSignature"), dateSignature: txt("dateSignature"),
  }, { referenceSuggeree: fdStr(formData, "referenceSuggeree") });
  if (!r.ok) return r;
  await archiveHrRequestIfDone(requestId, user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${r.employeeId}`);
  revalidatePath("/rh/demandes");
  revalidatePath("/rh");
  return { ok: true, id: requestId, message: r.message };
}

/**
 * UNE DÉCISION RH NE SE PREND QU'UNE FOIS, ET JAMAIS SUR SA PROPRE DEMANDE (audit du 27/10/2026, RH-DOCUMENTS-COMMS-03).
 * `decideExpenseReport` / `decideHrLeave` écrivaient sans relire l'état : une note ANNULÉE par le salarié se
 * validait, un REFUS après un ACCORD laissait le solde débité, deux clics croisés s'appliquaient l'un après
 * l'autre ; un membre des RH validait sa propre note de frais ; une note de frais de mission encore chez le N+1
 * (ou refusée par lui) se tranchait aux RH. La prise est atomique (`updateMany` conditionné à l'état ouvert).
 */
const ETATS_RH_OUVERTS: HrRequestStatus[] = ["PENDING", "IN_PROGRESS"];

function refusDecisionRh(
  user: { id: string },
  req: { status: HrRequestStatus; managerGate: Parameters<typeof refusTraitementRh>[0]; employee: { userId: string | null } },
): string | null {
  if (!ETATS_RH_OUVERTS.includes(req.status)) return "Cette demande a déjà été tranchée (ou annulée).";
  if (req.employee.userId === user.id) return "On ne décide pas de sa propre demande : un autre membre des RH doit la trancher.";
  return refusTraitementRh(req.managerGate);
}

export async function processHrRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const statusRaw = fdStr(formData, "status");
  const status = (statusRaw && REQUEST_STATUSES.includes(statusRaw as HrRequestStatus) ? statusRaw : "IN_PROGRESS") as HrRequestStatus;

  // UN ORDRE DE MISSION ENCORE CHEZ LE N+1 ne se traite pas aux RH (missions Ad & Pro, 10/2026).
  const marche = await prisma.hrDocumentRequest.findUnique({ where: { id }, select: { managerGate: true } });
  const avantRh = refusTraitementRh(marche?.managerGate ?? null);
  if (avantRh) return { ok: false, error: avantRh };

  const req = await prisma.hrDocumentRequest.update({
    where: { id },
    data: { status, hrNote: fdStr(formData, "hrNote"), handledById: user.id },
    include: { employee: { select: { fullName: true, userId: true } } },
  });
  if (estEtatRhTraite(status)) await marquerDemandeRhTraitee(id); // brique KPI « demandes traitées »

  // Congé ANNUEL approuvé (READY) : débit UNIQUE du solde de congés de l'employé.
  // (Les congés/absences passent normalement par decideHrLeave ; garde de compat.)
  if (status === "READY") {
    await applyAnnualLeaveBalance(req, user.id, req.employee.fullName);
  }
  if (status === "READY" || status === "DELIVERED") await synchroniserOrdreEmis(id, user.id);

  if (req.employee.userId) {
    await notifyUser({
      userId: req.employee.userId,
      type: "GENERIC",
      title: "Votre demande RH a été mise à jour",
      body: `Statut : ${HR_REQUEST_STATUS[status]?.label ?? status}.`,
      link: `/mon-dossier#demande-rh-${id}`,
    });
  }
  await archiveHrRequestIfDone(id, user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  revalidatePath("/rh");
  return { ok: true };
}

/**
 * Décision RH sur une NOTE DE FRAIS : valider pour le mois demandé, valider pour
 * le mois suivant, ou refuser. Un commentaire libre passe par le fil d'échange.
 */
export async function decideExpenseReport(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision"); // APPROVE | APPROVE_NEXT | REJECT
  if (!id || !decision || !["APPROVE", "APPROVE_NEXT", "REJECT"].includes(decision)) return { ok: false, error: "Décision invalide." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req || req.type !== "EXPENSE_REPORT") return { ok: false, error: "Note de frais introuvable." };
  if (!req.expenseMonth || !YM.test(req.expenseMonth)) return { ok: false, error: "Cette note de frais n'a pas de mois renseigné." };
  // Verrou : pas de traitement tant que le bureau du secrétariat n'a pas accusé
  // réception des documents ORIGINAUX (l'accusé est visible dans la demande).
  if (!req.originalsAckAt) {
    return { ok: false, error: "Traitement impossible : le bureau du secrétariat n'a pas encore accusé réception des originaux." };
  }

  const refus = refusDecisionRh(user, req);
  if (refus) return { ok: false, error: refus };

  const approvedMonth = decision === "APPROVE" ? req.expenseMonth : decision === "APPROVE_NEXT" ? nextMonthYm(req.expenseMonth) : null;
  const note = fdStr(formData, "hrNote");
  const pris = await prisma.hrDocumentRequest.updateMany({
    where: { id, status: { in: ETATS_RH_OUVERTS } },
    data: {
      status: decision === "REJECT" ? "REJECTED" : "READY",
      approvedMonth,
      handledById: user.id,
      ...(note ? { hrNote: note } : {}),
    },
  });
  if (pris.count !== 1) return { ok: false, error: "Cette demande a déjà été tranchée (ou annulée)." };

  const body = decision === "REJECT"
    ? `Votre note de frais (${formatMonth(req.expenseMonth)}) a été refusée.`
    : `Votre note de frais (${formatMonth(req.expenseMonth)}) est validée pour ${formatMonth(approvedMonth)}${decision === "APPROVE_NEXT" ? " (mois suivant)" : ""}.`;
  if (req.employee.userId) {
    await notifyUser({ userId: req.employee.userId, type: "GENERIC", title: decision === "REJECT" ? "Note de frais refusée" : "Note de frais validée", body, link: `/mon-dossier#demande-rh-${id}` });
  }
  await recordAudit({
    actorId: user.id, action: decision === "REJECT" ? "REFUSE" : "VALIDATE", module: "RH",
    summary: `Note de frais ${req.employee.fullName} (${req.expenseMonth}) — ${decision === "REJECT" ? "refusée" : `validée pour ${approvedMonth}`}`,
  });
  await archiveHrRequestIfDone(id, user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  revalidatePath("/rh");
  return { ok: true };
}

/**
 * Décision RH sur une demande de NATURE APPROBATION (congé / absence / autorisation de
 * sortie) : Accorder ou Refuser — pas de document à préparer. Un congé annuel accordé
 * débite le solde de l'employé (verrou balanceAppliedAt). Une note RH facultative peut être jointe.
 */
export async function decideHrLeave(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision"); // APPROVE | REJECT
  if (!id || !decision || !["APPROVE", "REJECT"].includes(decision)) return { ok: false, error: "Décision invalide." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (hrNature(req.type) !== "APPROVAL") return { ok: false, error: "Cette demande ne relève pas d'une décision d'accord." };

  const refus = refusDecisionRh(user, req);
  if (refus) return { ok: false, error: refus };

  const approved = decision === "APPROVE";
  const note = fdStr(formData, "hrNote");
  const pris = await prisma.hrDocumentRequest.updateMany({
    where: { id, status: { in: ETATS_RH_OUVERTS } },
    data: { status: approved ? "APPROVED" : "REJECTED", handledById: user.id, ...(note ? { hrNote: note } : {}) },
  });
  if (pris.count !== 1) return { ok: false, error: "Cette demande a déjà été tranchée (ou annulée)." };
  await marquerDemandeRhTraitee(id); // brique KPI « demandes traitées »

  // Congé annuel accordé : débit du solde (idempotent). Autres congés/absences : pas de solde.
  const debited = approved ? await applyAnnualLeaveBalance(req, user.id, req.employee.fullName) : 0;

  const label = HR_REQUEST_TYPE[req.type] ?? req.type;
  const periodTxt = req.periodStart
    ? ` (du ${formatAlgiers(req.periodStart, { day: "2-digit", month: "long", year: "numeric" })}${req.periodEnd ? ` au ${formatAlgiers(req.periodEnd, { day: "2-digit", month: "long", year: "numeric" })}` : ""})`
    : "";
  if (req.employee.userId) {
    await notifyUser({
      userId: req.employee.userId, type: "GENERIC",
      title: approved ? "Demande accordée" : "Demande refusée",
      body: approved
        ? `Votre demande « ${label} »${periodTxt} a été accordée.${debited > 0 ? ` ${debited} j déduits de votre solde de congés.` : ""}`
        : `Votre demande « ${label} »${periodTxt} a été refusée.${note ? ` Motif : ${note}` : ""}`,
      link: `/mon-dossier#demande-rh-${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: approved ? "VALIDATE" : "REFUSE", module: "RH",
    summary: `${label} — ${req.employee.fullName} : ${approved ? "accordée" : "refusée"}`,
  });
  await archiveHrRequestIfDone(id, user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  revalidatePath("/rh");
  return { ok: true };
}

/**
 * Accusé de réception des ORIGINAUX d'une note de frais par le BUREAU DU
 * SECRÉTARIAT (droit « Modifier » sur le module Bureau du secrétariat, ou vue globale).
 */
export async function ackExpenseOriginals(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE"))) {
    return { ok: false, error: "Réservé au bureau du secrétariat." };
  }
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req || req.type !== "EXPENSE_REPORT") return { ok: false, error: "Note de frais introuvable." };
  if (req.originalsAckAt) return { ok: false, error: "Originaux déjà réceptionnés." };

  await prisma.hrDocumentRequest.update({ where: { id }, data: { originalsAckAt: new Date(), originalsAckById: user.id } });
  if (req.employee.userId) {
    await notifyUser({
      userId: req.employee.userId, type: "GENERIC", title: "Originaux réceptionnés",
      body: `Le bureau du secrétariat a accusé réception des originaux de votre note de frais (${formatMonth(req.expenseMonth)}).`,
      link: `/mon-dossier#demande-rh-${id}`,
    });
  }
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "GENERIC", title: "Originaux de note de frais réceptionnés",
    body: `${req.employee.fullName} — ${formatMonth(req.expenseMonth)} (accusé par ${user.name}).`,
    link: `/rh/demandes?demande=${id}`,
  });
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: "Demandes administratives", summary: `Accusé de réception originaux note de frais — ${req.employee.fullName} (${req.expenseMonth ?? "?"})` });
  revalidatePath("/demandes");
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true };
}

/**
 * ENTREVUE RH : proposer (ou contre-proposer) une date. Les RH proposent en premier,
 * l'employé peut répondre par une autre date — chaque proposition remplace la précédente.
 */
export async function proposeHrMeeting(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const when = fdStr(formData, "meetingAt"); // datetime-local, heure d'Alger
  if (!id || !when) return { ok: false, error: "Indiquez la date et l'heure proposées." };
  const at = algiersInputToUtc(when);
  if (!at) return { ok: false, error: "Date invalide." };
  if (at < new Date()) return { ok: false, error: "La date proposée est déjà passée." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req || req.type !== "HR_INTERVIEW") return { ok: false, error: "Demande d'entrevue introuvable." };
  if (req.meetingConfirmedAt) return { ok: false, error: "L'entrevue est déjà confirmée." };
  const isOwner = req.employee.userId === user.id;
  const isHr = userCan(user, "HR_REQUESTS", "UPDATE");
  if (!(isOwner || isHr)) return { ok: false, error: "Non autorisé." };

  await prisma.hrDocumentRequest.update({
    where: { id },
    data: { meetingAt: at, meetingProposedById: user.id, meetingConfirmedAt: null, status: "IN_PROGRESS", ...(isHr && !isOwner ? { handledById: user.id } : {}) },
  });
  const whenLabel = formatAlgiers(at, { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  if (isOwner) {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "GENERIC", title: "Entrevue RH — date proposée par l'employé", body: `${req.employee.fullName} propose : ${whenLabel}.`, link: `/rh/demandes?demande=${id}` });
  } else if (req.employee.userId) {
    await notifyUser({ userId: req.employee.userId, type: "GENERIC", title: "Entrevue RH — date proposée", body: `Les RH vous proposent : ${whenLabel}. Acceptez ou proposez une autre date.`, link: `/mon-dossier#demande-rh-${id}` });
  }
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  revalidatePath("/rh");
  return { ok: true };
}

/** ENTREVUE RH : accepter la date proposée par l'autre partie → rendez-vous au calendrier. */
export async function confirmHrMeeting(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.hrDocumentRequest.findUnique({ where: { id }, include: { employee: { select: { userId: true, fullName: true } } } });
  if (!req || req.type !== "HR_INTERVIEW") return { ok: false, error: "Demande d'entrevue introuvable." };
  if (!req.meetingAt || !req.meetingProposedById) return { ok: false, error: "Aucune date proposée à accepter." };
  if (req.meetingConfirmedAt) return { ok: false, error: "L'entrevue est déjà confirmée." };
  if (req.meetingProposedById === user.id) return { ok: false, error: "L'autre partie doit accepter votre proposition." };
  const isOwner = req.employee.userId === user.id;
  const isHr = userCan(user, "HR_REQUESTS", "UPDATE");
  if (!(isOwner || isHr)) return { ok: false, error: "Non autorisé." };

  await prisma.hrDocumentRequest.update({
    where: { id },
    data: { meetingConfirmedAt: new Date(), status: "READY", ...(isHr && !isOwner ? { handledById: user.id } : {}) },
  });
  if (isHr && !isOwner) await marquerDemandeRhTraitee(id); // brique KPI « demandes traitées » (confirmée par les RH)

  // Rendez-vous au calendrier des deux parties (organisateur = côté RH).
  const employeeUserId = req.employee.userId;
  const rhUserId = req.meetingProposedById === employeeUserId ? user.id : req.meetingProposedById;
  if (rhUserId) {
    try {
      await createEventForUser(rhUserId, {
        title: `Entrevue RH — ${req.employee.fullName}`,
        kind: "MEETING",
        startAt: req.meetingAt,
        inviteeIds: employeeUserId && employeeUserId !== rhUserId ? [employeeUserId] : [],
      });
    } catch (err) {
      console.error("[hr-meeting] calendar event failed", err);
    }
  }

  const whenLabel = formatAlgiers(req.meetingAt, { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  if (isOwner) {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "GENERIC", title: "Entrevue RH confirmée", body: `${req.employee.fullName} — ${whenLabel}.`, link: `/rh/demandes?demande=${id}` });
  } else if (employeeUserId) {
    await notifyUser({ userId: employeeUserId, type: "GENERIC", title: "Entrevue RH confirmée", body: `Votre entrevue est confirmée : ${whenLabel}. Elle apparaît dans votre calendrier.`, link: `/mon-dossier#demande-rh-${id}` });
  }
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: "RH", summary: `Entrevue RH confirmée — ${req.employee.fullName} (${whenLabel})` });
  // Archive dans le Drive du côté RH (même si c'est l'employé qui a accepté).
  await archiveHrRequestIfDone(id, rhUserId ?? user.id);
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  revalidatePath("/rh");
  revalidatePath("/calendar");
  return { ok: true };
}

/**
 * ANNULER SA DEMANDE RH (décision de la Direction, 04/10) — le salarié la retire tant que les RH ne
 * l'ont pas traitée (soumise ou en préparation). Elle se CLÔT (`CANCELLED`) au lieu de s'effacer, et
 * les RH sont prévenues. Écriture conditionnelle : deux clics, ou un traitement passé entre-temps,
 * ne produisent qu'un seul effet.
 */
export async function annulerDemandeRh(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const motif = fdStr(formData, "motif");
  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, employeeId: true, handledById: true, employee: { select: { userId: true, fullName: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.employee.userId !== user.id) return { ok: false, error: "Seul le salarié qui a fait la demande l'annule." };
  const refus = refusAnnulationDemandeRh(req.status);
  if (refus) return { ok: false, error: refus };

  const pris = await prisma.hrDocumentRequest.updateMany({
    where: { id, status: { in: [...STATUTS_RH_ANNULABLES] } },
    data: { status: "CANCELLED", ...(motif ? { hrNote: `Annulée par le salarié — ${motif}` } : {}) },
  });
  if (pris.count === 0) {
    const apres = await prisma.hrDocumentRequest.findUnique({ where: { id }, select: { status: true } });
    return { ok: false, error: (apres && refusAnnulationDemandeRh(apres.status)) ?? "Cette demande vient de changer — rechargez la page." };
  }
  const libelle = HR_REQUEST_TYPE[req.type] ?? req.type;
  const corps = `${req.employee.fullName} a annulé sa demande « ${libelle} »${motif ? ` — ${motif}` : ""}. Il n'y a plus rien à préparer.`;
  if (req.handledById && req.handledById !== user.id) {
    await notifyUser({ userId: req.handledById, type: "GENERIC", title: "Demande RH annulée", body: corps, link: "/rh/demandes" }).catch(sansBloquer("hr-document-actions.annulerDemandeRh.notifyUser"));
  }
  await notifyRoles(rolesWithModule("HR_REQUESTS", "UPDATE"), { type: "GENERIC", title: "Demande RH annulée", body: corps, link: "/rh/demandes" }).catch(sansBloquer("hr-document-actions.annulerDemandeRh.notifyRoles"));
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH", entityType: "HR_REQUEST", entityId: id,
    field: "status", oldValue: req.status, newValue: "CANCELLED",
    summary: `Demande RH « ${libelle} » annulée par ${req.employee.fullName}${motif ? ` — ${motif}` : ""}`,
  });
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true, id, message: "Demande annulée — les RH sont prévenues." };
}

/** Suppression d'une demande (RH seulement — le salarié, lui, l'annule). */
export async function deleteHrRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    include: { employee: { select: { userId: true, fullName: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  const isOwner = req.employee.userId === user.id;
  const isHr = userCan(user, "HR_REQUESTS", "UPDATE");
  // LE SALARIÉ ANNULE, IL N'EFFACE PAS (décision du 04/10) : sa demande se CLÔT par
  // `annulerDemandeRh`, qui prévient les RH — la supprimer ferait disparaître ce qu'elles préparent.
  if (!isHr) {
    return { ok: false, error: isOwner ? "Annulez plutôt votre demande : elle reste visible, close, et les RH en sont prévenues." : "Non autorisé." };
  }
  // Un congé annuel APPROUVÉ a débité le solde (verrou balanceAppliedAt) : le supprimer sans
  // rendre les jours amputerait le solde d'un congé qui n'existe plus.
  const joursARendre = req.balanceAppliedAt && Number(req.periodDays ?? 0) > 0 ? Number(req.periodDays) : 0;
  await prisma.$transaction(async (tx) => {
    if (joursARendre > 0) {
      await tx.employee.update({ where: { id: req.employeeId }, data: { leaveBalanceDays: { increment: joursARendre } } });
    }
    await tx.hrDocumentRequest.delete({ where: { id } });
  });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "RH", entityType: "HR_REQUEST", entityId: id,
    summary: `Demande RH ${req.type} de ${req.employee.fullName} supprimée${joursARendre > 0 ? ` — ${joursARendre} j restitués au solde` : ""}`,
  });
  revalidatePath("/mon-dossier");
  revalidatePath(`/rh/${req.employeeId}`);
  return { ok: true };
}

/** Suppression d'un document RH (RH) — libère le blob chiffré. */
export async function deleteEmployeeDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  const doc = await prisma.employeeDocument.findUnique({ where: { id }, select: { blobId: true, employeeId: true, name: true, employee: { select: { companyId: true } } } });
  // LA PORTE DE LA FICHE (`/rh/[id]`, `updateEmployee`) : la pièce d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!doc || !(await entitePermisePourFiche(user.id, doc.employee.companyId))) return { ok: false, error: "Document introuvable." };
  await prisma.employeeDocument.delete({ where: { id } });
  await releaseBlob(doc.blobId);
  await recordAudit({ actorId: user.id, action: "DELETE", module: "RH", entityType: "EMPLOYEE", entityId: doc.employeeId, summary: `Document RH « ${doc.name} » supprimé` });
  revalidatePath(`/rh/${doc.employeeId}`);
  revalidatePath("/mon-dossier");
  return { ok: true };
}

/**
 * PARTAGER (ou reprendre) UNE PIÈCE RH AVEC LE SALARIÉ.
 *
 * Le défaut suit la nature du document — un contrat reste aux RH, un bulletin va au salarié.
 * Ce geste-ci est l'exception assumée : remettre à quelqu'un son contrat signé, ou au contraire
 * retirer une pièce déposée par erreur dans son espace.
 *
 * Tracé dans les deux sens : ouvrir l'accès à une pièce du dossier d'un salarié n'est pas un
 * réglage d'affichage, et le refermer non plus.
 */
export async function setEmployeeDocumentVisibility(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  const visible = fdStr(formData, "visible") === "1";

  const doc = await prisma.employeeDocument.findUnique({
    where: { id },
    select: { employeeId: true, name: true, visibleToEmployee: true, employee: { select: { fullName: true, companyId: true } } },
  });
  // LA PORTE DE LA FICHE (`/rh/[id]`, `updateEmployee`) : la pièce d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!doc || !(await entitePermisePourFiche(user.id, doc.employee.companyId))) return { ok: false, error: "Document introuvable." };
  if (doc.visibleToEmployee === visible) return { ok: true };

  await prisma.employeeDocument.update({ where: { id }, data: { visibleToEmployee: visible } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH", entityType: "EMPLOYEE", entityId: doc.employeeId,
    field: "visibleToEmployee",
    oldValue: String(doc.visibleToEmployee), newValue: String(visible),
    summary: `Document RH « ${doc.name} » (${doc.employee.fullName}) — ${visibilityLabel(visible)}`,
  });
  revalidatePath(`/rh/${doc.employeeId}`);
  revalidatePath("/mon-dossier");
  return { ok: true };
}
