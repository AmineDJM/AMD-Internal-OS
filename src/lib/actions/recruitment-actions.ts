"use server";

import { revalidatePath } from "next/cache";
import { doubleEcrireCoffre } from "@/modules/coffre/api";
import { synchroniserOffreDeLaDemande } from "@/lib/site-web/contenus";
import type { ContractType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan, rolesWithModule } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { attachFormFiles } from "@/lib/documents";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { recruitmentViewer } from "@/lib/recruitment/access";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import {
  abilities, ETAPES_RETIRABLES, applyChainDecision, canDecideStep, canSelectCandidate, needsOnboarding, summarize,
  validateDraft, CONTRACT_LABEL, marchesChangees, reouverture, cibleDeLaDecision, decisionDuSommetExigeSuivi,
  type ChainStep, type RecruitmentContract, type RecruitmentStage,
} from "@/lib/recruitment/request-flow";
import { relierCommeLaLigne } from "@/modules/referentiels/api";
import { sansBloquer } from "@/lib/journal";
import {
  AUCUN_VALIDATEUR, DEJA_CHANGE, EtatChange, MOTIF_REFUS, buildChain, etapesDeLaChaine, prevenirLeSuivi,
} from "@/lib/actions/internes/recruitment/circuit";
import {
  annoncerLaDesignation, ficheDeLaRecrue, ficheDuFuturManager, phraseDuSuivi, questionDeLaDemande, refusRenvoi,
  refusRetrait,
} from "@/lib/actions/internes/recruitment/decisions";
import {
  phraseDeLaCorrection, phraseDeLaReouverture, phraseDeLaReponse,
} from "@/lib/actions/internes/recruitment/phrases";
import {
  deposerLeCandidat, donneesDuMouvement, enregistrerLaDemande, lireLAnnulation, lireLaCloture, lireLaCorrection,
  lireLaDesignation, lireLaReouverture,
} from "@/lib/actions/internes/recruitment/saisie";
import {
  annoncerLAnnulation, annoncerLaCorrection, annoncerLaDecision, annoncerLaReouverture, annoncerLeRenvoi,
  annoncerLeRetrait,
} from "@/lib/actions/internes/recruitment/annonces";
// Découpé par responsabilité (lot V4) : aides, lectures et corps internes dans `actions/internes/recruitment/{circuit,decisions,phrases,saisie,annonces}` — les actions restent ici (leur clé de contrat, leur porte, chaque écriture d'étape).

/** Les valeurs multiples d'un champ (`followerIds`) — lu par nom littéral, comme les autres champs. */
const fdList = (formData: FormData, key: string): string[] => formData.getAll(key).map((v) => String(v)).filter(Boolean);

/**
 * LE CIRCUIT DE RECRUTEMENT — la porte de l'écran.
 *
 * Les RÈGLES vivent dans `lib/recruitment/request-flow.ts` (module pur, testé) ; ici on ne fait
 * que trois choses : lire le formulaire, résoudre qui parle, écrire. Toute décision — qui peut
 * quoi, ce qui suit quoi — est posée là-bas et RE-DEMANDÉE ici avec les mêmes arguments que
 * l'écran : un bouton visible correspond alors toujours à une action permise, et l'inverse.
 */

// ───────────────────────────── Créer la demande ─────────────────────────────

export async function createRecruitmentRequest(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "RECRUITMENT", "CREATE")) {
    return { ok: false, error: "Le module Recrutement vous est fermé (Administration › Accès) : vous ne pouvez pas demander de recrutement." };
  }

  const contractType = fdStr(formData, "contractType") ?? "";
  const draft = {
    position: fdStr(formData, "position") ?? "",
    headcount: Math.floor(fdNum(formData, "headcount") ?? 1),
    contractType,
    salaryMin: fdNum(formData, "salaryMin"),
    salaryMax: fdNum(formData, "salaryMax"),
    startDate: fdDate(formData, "startDate"),
    endDate: fdDate(formData, "endDate"),
  };
  const invalid = validateDraft(draft);
  if (invalid) return { ok: false, error: invalid };

  // LA CHAÎNE EST CALCULÉE AVANT D'ÉCRIRE. Sans elle, la demande naîtrait sans validateur : elle
  // ne serait ni refusée ni approuvée, simplement invisible de tout le monde.
  const chain = await buildChain(user.id);
  if (chain.length === 0) return { ok: false, error: AUCUN_VALIDATEUR };

  const created = await enregistrerLaDemande(formData, { user, contractType: contractType as ContractType, chain, draft });

  // La fiche de poste, s'il y en a une. Un échec de fichier ne défait PAS la demande : elle est
  // enregistrée, on dit ce qui n'a pas suivi.
  const files = await attachFormFiles(user.id, "RECRUITMENT_REQUEST", created.id, formData);

  await notifyUser({
    userId: chain[0].approverId,
    type: "GENERIC",
    title: "Demande de recrutement à valider",
    body: `${created.reference} — ${draft.position} · ${summarize({ ...draft, contractType })}`,
    link: `/recrutement/${created.id}`,
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: created.id,
    summary: `Demande ${created.reference} — ${draft.position} (${chain.length} marche(s) de validation)`,
  });

  revalidatePath("/recrutement");
  return files.failed.length
    ? { ok: true, id: created.id, message: `Demande enregistrée ; échec sur : ${files.failed.map((f) => f.name).join(", ")}.` }
    : { ok: true, id: created.id };
}

// ───────────────────────────── La chaîne hiérarchique ─────────────────────────────

export async function decideRecruitmentStep(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const brute = fdStr(formData, "decision");
  const reason = fdStr(formData, "reason");
  if (!id) return { ok: false, error: "Demande introuvable." };
  // UNE DÉCISION ILLISIBLE N'EST PAS UN ACCORD (§118.192). L'ancienne lecture — « REJECTED, sinon
  // APPROVED » — faisait de toute valeur inattendue (une faute de frappe, un champ perdu en route) une
  // validation donnée au nom du validateur.
  // Obligatoire, et dit comme tel au contrat de l'action : sans décision, il n'y a rien à écrire. Mesuré :
  // retirée seule, la ligne suivante refuse aussi une décision absente — celle-ci existe pour le CONTRAT,
  // que la dérivation lit sur une garde de négation (§118.137).
  if (!brute) return { ok: false, error: "Décision illisible (attendu : valider ou refuser)." };
  if (brute !== "APPROVED" && brute !== "REJECTED") return { ok: false, error: "Décision illisible (attendu : valider ou refuser)." };
  const decision = brute;

  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };

  const req = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
    },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };

  const steps: ChainStep[] = etapesDeLaChaine(req.approvals);
  const allowed = canDecideStep(req.stage, steps, { userId: user.id, isTop: viewer.isTop });
  if (!allowed.ok) return { ok: false, error: allowed.reason ?? "Non autorisé." };
  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18). L'écran exigeait le motif d'un refus ; le serveur, non :
  // une requête directe refusait sans un mot, et le demandeur lisait « refusée » sans savoir pourquoi.
  if (decision === "REJECTED" && reason === null) return { ok: false, error: MOTIF_REFUS };

  // Le PDG tranche depuis SA marche s'il en a une, sinon depuis la dernière : c'est ce qui
  // marque les marches d'en dessous comme non consultées plutôt qu'approuvées en son nom.
  // (Triées par rang : la base ne rend pas toujours les marches dans l'ordre.)
  const decideur = { userId: user.id, isTop: viewer.isTop };
  const target = cibleDeLaDecision(steps, decideur);
  if (!target) return { ok: false, error: "Plus aucune marche en attente." };

  // LE DG QUI CONCLUT LA CHAÎNE DÉSIGNE LE N+1 DE LA FUTURE RECRUE ET LE SUIVI (Direction, 07/10) — exigé ici,
  // pas seulement à l'écran : une validation conclusive sans eux laisserait le recrutement sans responsable.
  const designe = decision === "APPROVED" && decisionDuSommetExigeSuivi(req.stage, steps, decideur);
  const designation = await lireLaDesignation(formData, { designe });
  if (!designation.ok) return { ok: false, error: designation.error };
  const { futureManagerId, followerIds, nomsDesignes } = designation;

  const { steps: nextSteps, outcome } = applyChainDecision(steps, target.order, decision);
  // Les marches à écrire se trouvent par leur RANG (`marchesChangees`) : comparées par leur position dans
  // deux tableaux qui n'avaient pas le même ordre, la marche décidée pouvait ne pas être écrite.
  const changees = marchesChangees(steps, nextSteps);
  const maintenant = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      for (const s of changees) {
        const ecrite = await tx.recruitmentApproval.updateMany({
          where: { requestId: id, order: s.order, status: "PENDING" },
          data: { status: s.status, decidedAt: maintenant, ...(s.order === target.order ? { reason } : {}) },
        });
        if (ecrite.count === 0) throw new EtatChange();
      }
      const etape = await tx.recruitmentRequest.updateMany({
        where: { id, stage: "CHAIN" },
        data: {
          stage: outcome.stage,
          ...(outcome.stage === "REJECTED" ? { closingNote: reason, closedAt: maintenant } : {}),
          ...(designe ? { futureManagerId } : {}),
        },
      });
      if (etape.count === 0) throw new EtatChange();
      if (designe) {
        await tx.recruitmentFollower.createMany({
          data: followerIds.map((userId) => ({ requestId: id, userId, addedById: user.id })),
          skipDuplicates: true,
        });
      }
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  if (decision === "REJECTED") {
    await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Refusée à la marche ${target.order} — ${reason}` }).catch(sansBloquer("recruitment-actions.decideRecruitmentStep.ecrireAuFil"));
  }
  const phraseSuivi = designe ? phraseDuSuivi(nomsDesignes, futureManagerId, followerIds) : null;
  if (designe && futureManagerId) await annoncerLaDesignation(id, req, user, futureManagerId, followerIds, phraseSuivi);
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);

  await annoncerLaDecision(formData, { id, req, decision, complete: outcome.complete, nextSteps });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: `Validation — marche ${target.order}`,
    oldValue: "PENDING", newValue: decision,
    summary: `${req.reference} — ${decision === "APPROVED" ? "validée" : "refusée"} par ${user.name}${reason ? ` · ${reason}` : ""}${phraseSuivi ? ` · ${phraseSuivi}` : ""}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: decision === "APPROVED" ? "Validée." : "Refusée." };
}

/**
 * Retirer sa demande — tant qu'elle n'est pas EXÉCUTÉE, c'est-à-dire tant qu'aucun recrutement n'est
 * prononcé (décision de la Direction, 04/10 ; règle `ETAPES_RETIRABLES`, lue aussi par la fiche). Les
 * personnes déjà engagées dans la chaîne sont prévenues, l'offre du site repasse en brouillon.
 */
export async function cancelRecruitmentRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };

  const req = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: { reference: true, position: true, stage: true, approvals: { select: { status: true, order: true, approverId: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!abilities(req.stage, viewer).cancel) return { ok: false, error: refusRetrait(req.stage) };

  // Conditionnelle sur l'étape LUE : un passage d'étape concurrent (une marche qui avance, les RH qui
  // ouvrent le sourcing, un recrutement prononcé) fait refuser le retrait au lieu de l'écraser.
  const motif = fdStr(formData, "reason");
  const retiree = await prisma.recruitmentRequest.updateMany({
    where: { id, stage: req.stage },
    data: { stage: "CANCELLED", closedAt: new Date(), closingNote: motif },
  });
  if (retiree.count === 0) return { ok: false, error: DEJA_CHANGE };
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);

  await annoncerLeRetrait(formData, { user, id, req });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "stage", oldValue: req.stage, newValue: "CANCELLED",
    summary: `${req.reference} — demande retirée par son auteur${motif ? ` · ${motif}` : ""}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Demande retirée — les personnes qui l'avaient en main sont prévenues." };
}

// ───────────────────────────── Les RH : précisions, ouverture, refus ─────────────────────────────

export async function askRecruitmentInfo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const question = fdStr(formData, "question");
  if (!id || !question) return { ok: false, error: "Précisez ce que vous demandez." };

  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, stage: true, requesterId: true, position: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage, viewer).askInfo) return { ok: false, error: "Non autorisé à cette étape." };

  try {
    await prisma.$transaction(async (tx) => {
      // La demande RETOURNE au demandeur : tant qu'il n'a pas répondu, elle n'est plus dans la
      // file des RH — sinon ils la rouvriraient chaque jour sans que rien n'ait bougé.
      const etape = await tx.recruitmentRequest.updateMany({ where: { id, stage: "HR_REVIEW" }, data: { stage: "INFO_REQUESTED" } });
      if (etape.count === 0) throw new EtatChange();
      await tx.recruitmentInfoRequest.create({ data: { requestId: id, askedById: user.id, question } });
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: "Précisions demandées sur votre demande de recrutement",
    body: `${req.reference} — ${question}`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: "Précisions demandées au demandeur", body: `${req.reference} — ${question}` }, [user.id, req.requesterId]);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    summary: `${req.reference} — précisions demandées : « ${question} »`,
  });
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Question envoyée au demandeur." };
}

export async function answerRecruitmentInfo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const infoId = fdStr(formData, "infoId");
  const answer = fdStr(formData, "answer");
  if (!id || !infoId || !answer) return { ok: false, error: "Écrivez votre réponse." };

  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, stage: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage, viewer).answerInfo) return { ok: false, error: "Non autorisé à cette étape." };

  const info = await questionDeLaDemande(id, infoId);
  if (!info) return { ok: false, error: "Question introuvable." };

  await prisma.recruitmentInfoRequest.update({
    where: { id: infoId },
    data: { answer, answeredById: user.id, answeredAt: new Date() },
  });
  // Reste-t-il des questions sans réponse ? Tant qu'il y en a, la demande reste chez le
  // demandeur : la renvoyer aux RH à la première réponse leur ferait rouvrir un dossier
  // incomplet.
  const pending = await prisma.recruitmentInfoRequest.count({ where: { requestId: id, answeredAt: null } });
  // La demande ne retourne aux RH que si elle ATTEND ENCORE la réponse : refusée entre-temps, une
  // réponse ne doit pas la ressusciter « chez les RH ».
  const retour = pending === 0
    ? await prisma.recruitmentRequest.updateMany({ where: { id, stage: "INFO_REQUESTED" }, data: { stage: "HR_REVIEW" } })
    : { count: 0 };
  if (retour.count > 0) {
    // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
    // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
    await synchroniserOffreDeLaDemande(id, user.id);
    await notifyUser({
      userId: info.askedById, type: "GENERIC",
      title: "Réponse à vos précisions — demande de recrutement",
      body: `${req.reference} — ${answer}`,
      link: `/recrutement/${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    summary: `${req.reference} — réponse : « ${answer} »`,
  });
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: phraseDeLaReponse(retour.count, pending) };
}

/** Les RH ouvrent le poste : la recherche de candidats commence. */
export async function openRecruitmentSourcing(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, position: true, stage: true, requesterId: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage, viewer).openSourcing) return { ok: false, error: "Non autorisé à cette étape." };

  const ouverte = await prisma.recruitmentRequest.updateMany({ where: { id, stage: "HR_REVIEW" }, data: { stage: "SOURCING" } });
  if (ouverte.count === 0) return { ok: false, error: DEJA_CHANGE };
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: "Recrutement ouvert",
    body: `${req.reference} — ${req.position} : les RH ont ouvert le poste. Vous présélectionnerez les CV reçus.`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: "Recrutement ouvert", body: `${req.reference} — ${req.position} : les RH ont ouvert le poste.` }, [user.id, req.requesterId]);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    summary: `${req.reference} — poste ouvert par les RH`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Poste ouvert — les CV peuvent être déposés." };
}

/** Les RH ferment la demande — refus motivé, ou clôture après recrutement. */
export async function closeRecruitmentRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const brute = fdStr(formData, "decision");
  if (!id) return { ok: false, error: "Demande introuvable." };
  // Absente : clôturer. « REJECTED » : refuser. Toute autre valeur est illisible — et ne clôt rien.
  if (brute !== null && brute !== "REJECTED" && brute !== "CLOSE") return { ok: false, error: "Décision illisible (attendu : refuser ou clôturer)." };
  const reject = brute === "REJECTED";
  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const lu = await lireLaCloture(formData, { id, viewer, reject });
  if ("fini" in lu) return lu.fini;
  const { req, note } = lu;

  const fermee = await prisma.recruitmentRequest.updateMany({
    where: { id, stage: req.stage },
    data: { stage: reject ? "REJECTED" : "CLOSED", closingNote: note, closedAt: new Date() },
  });
  if (fermee.count === 0) return { ok: false, error: DEJA_CHANGE };
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `${reject ? "Refusée par les RH" : "Clôturée sans suite"} — ${note}` }).catch(sansBloquer("recruitment-actions.closeRecruitmentRequest.ecrireAuFil"));
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: reject ? "Demande de recrutement refusée par les RH" : "Recrutement clôturé",
    body: `${req.reference} — ${note}`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: reject ? "Demande de recrutement refusée par les RH" : "Recrutement clôturé", body: `${req.reference} — ${note}` }, [user.id, req.requesterId]);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    summary: `${req.reference} — ${reject ? "refusée par les RH" : "clôturée"} · ${note}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: reject ? "Demande refusée." : "Demande clôturée." };
}

// ───────────────────────────── Les candidats ─────────────────────────────

export async function addRecruitmentCandidate(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  const fullName = fdStr(formData, "fullName");
  if (!id || !fullName) return { ok: false, error: "Le nom du candidat est obligatoire." };

  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, stage: true, requesterId: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage, viewer).addCandidate) {
    return { ok: false, error: "Les CV se déposent une fois le poste ouvert par les RH." };
  }

  const { candidate, files } = await deposerLeCandidat(formData, { user, id, fullName });

  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: "CV reçu à présélectionner",
    body: `${req.reference} — ${fullName}`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: "CV reçu", body: `${req.reference} — ${fullName}` }, [user.id, req.requesterId]);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Recrutement",
    entityType: "RECRUITMENT_CANDIDATE", entityId: candidate.id,
    summary: `${req.reference} — CV reçu : ${fullName}`,
  });
  revalidatePath(`/recrutement/${id}`);
  return files.failed.length
    ? { ok: true, id: candidate.id, message: `Candidat ajouté ; échec sur : ${files.failed.map((f) => f.name).join(", ")}.` }
    : { ok: true, id: candidate.id };
}

/**
 * Faire avancer (ou écarter) un candidat.
 *
 * Une seule action pour tout le pipeline, parce que c'est une seule question — « où en est cette
 * personne ? » — et que chaque mouvement se gouverne par la MÊME table de droits. Quatre actions
 * séparées auraient fini par diverger sur qui a le droit de quoi.
 */
export async function moveRecruitmentCandidate(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const candidateId = fdStr(formData, "candidateId");
  const move = fdStr(formData, "move"); // SHORTLIST | UNSHORTLIST | SELECT | INTERVIEW | HIRE | DECLINE
  if (!candidateId || !move) return { ok: false, error: "Action inconnue." };

  const candidate = await prisma.recruitmentCandidate.findUnique({
    where: { id: candidateId },
    select: { id: true, requestId: true, fullName: true, status: true },
  });
  if (!candidate) return { ok: false, error: "Candidat introuvable." };

  const viewer = await recruitmentViewer(user, candidate.requestId);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id: candidate.requestId },
    select: { reference: true, stage: true, requesterId: true, contractType: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const can = abilities(req.stage, viewer);

  const enLice = canSelectCandidate(candidate.status);
  const mouvement = donneesDuMouvement(formData, { user, move, candidate, can, enLice });
  if ("error" in mouvement) return { ok: false, error: mouvement.error };
  const { data } = mouvement;

  // UN GESTE À LA FOIS : le candidat change depuis l'état LU. Deux gestes croisés — la direction qui
  // retient pendant que le demandeur écarte — ne s'écrasent plus.
  // Recruter fait aussi basculer la DEMANDE en intégration, et seulement depuis un poste OUVERT : deux
  // recrutements prononcés à la même seconde sur deux candidats laissaient deux « recrutés », et
  // l'intégration aurait créé la fiche du premier venu.
  try {
    await prisma.$transaction(async (tx) => {
      const bouge = await tx.recruitmentCandidate.updateMany({ where: { id: candidateId, status: candidate.status }, data });
      if (bouge.count === 0) throw new EtatChange();
      if (move === "HIRE") {
        const etape = await tx.recruitmentRequest.updateMany({ where: { id: candidate.requestId, stage: "SOURCING" }, data: { stage: "ONBOARDING" } });
        if (etape.count === 0) throw new EtatChange();
      }
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }

  // Recruter quelqu'un fait basculer la DEMANDE en intégration : c'est le geste qui déclenche
  // la fiche employé (ou, pour un consulting, la simple prise en compte d'un externe).
  if (move === "HIRE") {
    // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
    // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
    await synchroniserOffreDeLaDemande(candidate.requestId, user.id);
    await notifyRoles(rolesWithModule("RH", "UPDATE"), {
      type: "GENERIC",
      title: needsOnboarding(req.contractType as RecruitmentContract) ? "Intégration à préparer" : "Consultant externe retenu",
      body: `${req.reference} — ${candidate.fullName}`,
      link: `/recrutement/${candidate.requestId}`,
    });
    await prevenirLeSuivi(candidate.requestId, { title: "Candidat recruté", body: `${req.reference} — ${candidate.fullName}` }, [user.id]);
  }
  if (move === "SELECT") {
    await notifyUser({
      userId: req.requesterId, type: "GENERIC",
      title: "Candidat retenu par la direction",
      body: `${req.reference} — ${candidate.fullName}`,
      link: `/recrutement/${candidate.requestId}`,
    });
    await prevenirLeSuivi(candidate.requestId, { title: "Candidat retenu par la direction", body: `${req.reference} — ${candidate.fullName}` }, [user.id, req.requesterId]);
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_CANDIDATE", entityId: candidateId,
    field: "Statut", oldValue: candidate.status, newValue: String(data.status),
    summary: `${req.reference} — ${candidate.fullName} : ${String(data.status)}`,
  });
  revalidatePath(`/recrutement/${candidate.requestId}`);
  return { ok: true };
}

// ───────────────────────────── L'intégration ─────────────────────────────

/**
 * CRÉER LA FICHE EMPLOYÉ à partir de la candidature retenue.
 *
 * Elle est PRÉ-REMPLIE depuis la demande (département, entité, contrat, dates, rémunération) et
 * depuis le candidat (nom, courriel, téléphone) : ressaisir ce qui est déjà écrit, c'est
 * introduire des écarts entre le poste demandé et le poste créé.
 *
 * ⚠️ PAS POUR UN CONSULTING. Un consultant est un intervenant EXTERNE : lui créer une fiche
 * employé le ferait entrer dans la masse salariale, dans les congés et dans l'organigramme —
 * trois endroits où il n'a rien à faire, et trois faux chiffres. La demande se clôt alors sans
 * fiche, et c'est la bonne fin.
 */
export async function onboardRecruitment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };

  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, stage: true, position: true, contractType: true, companyId: true,
      departmentId: true, startDate: true, endDate: true, salaryMin: true, futureManagerId: true,
      department: { select: { name: true } },
      candidates: { where: { status: "HIRED" }, select: { id: true, fullName: true, email: true, phone: true, employeeId: true } },
    },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };

  const hired = req.candidates[0];
  if (!abilities(req.stage, viewer, { hasHire: Boolean(hired) }).onboard) {
    return { ok: false, error: "L'intégration se prépare une fois un candidat recruté." };
  }
  if (!hired) return { ok: false, error: "Aucun candidat recruté sur cette demande." };
  if (hired.employeeId) return { ok: false, error: "La fiche employé existe déjà." };

  const contract = req.contractType as RecruitmentContract;
  if (!needsOnboarding(contract)) {
    // Un consultant externe : on clôt, sans inventer un salarié — depuis l'intégration LUE : une
    // embauche annulée entre-temps ne se clôt pas « consultant retenu ».
    const close = await prisma.recruitmentRequest.updateMany({
      where: { id, stage: "ONBOARDING" },
      data: {
        stage: "CLOSED", closedAt: new Date(),
        closingNote: `${hired.fullName} — consultant externe (pas de fiche employé).`,
      },
    });
    if (close.count === 0) return { ok: false, error: DEJA_CHANGE };
    // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
    // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
    await synchroniserOffreDeLaDemande(id, user.id);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Recrutement",
      entityType: "RECRUITMENT_REQUEST", entityId: id,
      summary: `${req.reference} — ${hired.fullName} retenu comme consultant EXTERNE : aucune fiche employé, hors effectif et hors paie`,
    });
    revalidatePath("/recrutement");
    revalidatePath(`/recrutement/${id}`);
    return { ok: true, message: "Consultant externe enregistré — aucune fiche employé créée." };
  }

  // LE N+1 DÉSIGNÉ PAR LE DG (Direction, 07/10) devient le manager de la fiche — par SA fiche employé
  // (`Employee.managerId` relie deux fiches) ; sans fiche, le N+1 se déduira de l'organigramme, comme avant.
  const managerFiche = await ficheDuFuturManager(req.futureManagerId);

  // LA FICHE, LE LIEN ET LA CLÔTURE EN UNE TRANSACTION, depuis l'intégration LUE : une embauche annulée
  // pendant la création ne laisse pas une fiche employé pour quelqu'un qu'on ne recrute plus.
  let employee: { id: string };
  try {
    employee = await prisma.$transaction(async (tx) => {
      const cree = await tx.employee.create({ data: ficheDeLaRecrue(req, hired, managerFiche), select: { id: true } });
      // Mesuré : retirée seule, cette condition ne change aucun résultat — tout geste qui touche le recruté
      // (une intégration concurrente, une embauche annulée) déplace aussi l'étape de la demande, que la
      // condition d'après lit. Elle reste parce qu'elle dit le fait exact : CE recruté, encore sans fiche.
      const lie = await tx.recruitmentCandidate.updateMany({ where: { id: hired.id, status: "HIRED", employeeId: null }, data: { employeeId: cree.id } });
      if (lie.count === 0) throw new EtatChange();
      const close = await tx.recruitmentRequest.updateMany({
        where: { id, stage: "ONBOARDING" },
        data: { stage: "CLOSED", closedAt: new Date(), closingNote: `${hired.fullName} recruté — fiche employé créée.` },
      });
      if (close.count === 0) throw new EtatChange();
      // DOUBLE ÉCRITURE (refonte, lot V2-B) : la fiche salarié rejoint la Personne de la candidature — une seule personne.
      await relierCommeLaLigne(tx, "Employee", cree.id, { source: "RecruitmentCandidate", id: hired.id }, user.id);
      // LE COFFRE (refonte V2-E), dans la MÊME transaction : la fiche et la copie de son salaire vivent ensemble.
      await doubleEcrireCoffre("Employee", cree.id, { baseSalary: req.salaryMin ?? 0 }, user.id, tx);
      return cree;
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Recrutement",
    entityType: "EMPLOYEE", entityId: employee.id,
    summary: `${req.reference} — fiche employé créée pour ${hired.fullName} (${CONTRACT_LABEL[contract]}, ${req.position})${managerFiche ? " — N+1 désigné par la direction générale" : ""}`,
  });
  await prevenirLeSuivi(id, { title: "Recrue intégrée", body: `${req.reference} — ${hired.fullName} : fiche employé créée.` }, [user.id]);
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  revalidatePath("/rh");
  return {
    ok: true, id: employee.id,
    message: "Fiche employé créée. Complétez-la (salaire réel, état civil, compte applicatif) depuis les RH.",
  };
}

// ───────────────────────────── Renvoyer, corriger, rouvrir (audit 360°, R14 — §118.192) ─────────────────────────────

/**
 * RENVOYER POUR CORRECTION — la troisième issue, entre valider et refuser.
 *
 * Un intitulé imprécis, une fourchette mal posée : le validateur n'avait que « valider » (laisser
 * passer un besoin faux) ou « refuser » (tuer une demande juste, et faire recommencer toute la chaîne).
 * Renvoyer est un refus ADOUCI : ouvert à qui peut trancher, là où il le peut — la marche active de la
 * chaîne, ou les RH quand la demande est chez eux —, le motif exigé, et la demande garde son parcours.
 */
export async function renvoyerDemandeRecrutement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
    },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const steps: ChainStep[] = etapesDeLaChaine(req.approvals);
  const peutTrancher = canDecideStep(req.stage, steps, { userId: user.id, isTop: viewer.isTop }).ok;
  if (!abilities(req.stage, viewer, { peutTrancherLaMarche: peutTrancher }).returnForCorrection) {
    return { ok: false, error: refusRenvoi(req.stage, steps, { userId: user.id, isTop: viewer.isTop }) };
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites ce qu'il faut corriger : c'est ce que lira le demandeur." };

  const renvoyee = await prisma.recruitmentRequest.updateMany({
    where: { id, stage: req.stage },
    data: { stage: "RETURNED", returnedFrom: req.stage, returnedAt: new Date(), returnedById: user.id, returnNote: motif },
  });
  if (renvoyee.count === 0) return { ok: false, error: DEJA_CHANGE };
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await annoncerLeRenvoi(formData, { user, id, req });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "Étape", oldValue: req.stage, newValue: "RETURNED",
    summary: `${req.reference} — renvoyée pour correction par ${user.name} · ${motif}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Demande renvoyée à son demandeur, avec votre motif." };
}

/**
 * CORRIGER ET RENVOYER — le geste du demandeur quand la balle est chez lui.
 *
 * Une correction qui ne touche rien de ce que les validateurs ont PESÉ revient là d'où on l'a renvoyée :
 * la même marche, ou les RH. Une correction MATÉRIELLE — un autre poste, un autre contrat, plus de
 * postes, une rémunération relevée, un contrat plus long — fait repartir la chaîne depuis sa première
 * marche : un accord ne couvre pas plus que ce qu'il a vu (§118.187). Ce que le formulaire ne porte pas
 * ne s'écrit pas (§118.152c), et « ce qui a changé » est exigé : c'est ce que lira la personne qui attend.
 */
export async function resoumettreDemandeRecrutement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const lu = await lireLaCorrection(formData, { id, viewer });
  if ("fini" in lu) return lu.fini;
  const { req, changements, missions, skills, justification, steps, materiels, repart, vers } = lu;
  const { position, headcount, contractType, salaryMin, salaryMax, startDate, endDate } = lu.draft;

  try {
    await prisma.$transaction(async (tx) => {
      const corrigee = await tx.recruitmentRequest.updateMany({
        where: { id, stage: "RETURNED" },
        data: {
          position: position.trim(), headcount, contractType: contractType as ContractType,
          salaryMin, salaryMax, startDate, endDate, missions, skills, justification,
          stage: vers, returnedFrom: null, returnedAt: null, returnedById: null, returnNote: null,
        },
      });
      if (corrigee.count === 0) throw new EtatChange();
      if (repart) {
        await tx.recruitmentApproval.updateMany({ where: { requestId: id }, data: { status: "PENDING", decidedAt: null, reason: null } });
      }
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await annoncerLaCorrection(formData, { user, id, req, position, steps, materiels, repart, vers });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "Étape", oldValue: "RETURNED", newValue: vers,
    summary: `${req.reference} — corrigée et renvoyée · ${changements}${repart ? ` (la chaîne repart : ${materiels.join(", ")})` : ""}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: phraseDeLaCorrection(repart, materiels, vers) };
}

/**
 * ROUVRIR — une demande refusée, ou close sans recrutement, motif à l'appui.
 *
 * Un refus était terminal : une erreur reconnue par la personne même qui avait refusé faisait
 * recommencer toute la chaîne. Refusée dans la chaîne, la demande repart à la marche qui a refusé, et à
 * elle seule ; refusée par les RH, elle leur revient ; close sans recrutement, le poste se rouvre
 * (`reouverture`). Les RH ou le sommet, qui portent le circuit — jamais d'un clic sans dire pourquoi.
 */
export async function rouvrirDemandeRecrutement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const lu = await lireLaReouverture(formData, { id, viewer });
  if ("fini" in lu) return lu.fini;
  const { req, steps, ou, motif } = lu;

  try {
    await prisma.$transaction(async (tx) => {
      const rouverte = await tx.recruitmentRequest.updateMany({
        where: { id, stage: req.stage },
        data: { stage: ou.vers, closingNote: null, closedAt: null },
      });
      if (rouverte.count === 0) throw new EtatChange();
      if (ou.marche !== null) {
        // Mesuré : retirée seule, la condition sur la marche ne change aucun résultat — une réouverture
        // concurrente déplace l'étape, que la condition d'avant lit. Elle dit le fait exact : la marche qui A REFUSÉ.
        const marche = await tx.recruitmentApproval.updateMany({
          where: { requestId: id, order: ou.marche, status: "REJECTED" },
          data: { status: "PENDING", decidedAt: null, reason: null },
        });
        if (marche.count === 0) throw new EtatChange();
      }
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await annoncerLaReouverture(formData, { user, id, req, ou, steps });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "Étape", oldValue: req.stage, newValue: ou.vers,
    summary: `${req.reference} — rouverte par ${user.name} · ${motif}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: phraseDeLaReouverture(ou.vers) };
}

/**
 * ANNULER L'EMBAUCHE — avant l'intégration, motif à l'appui.
 *
 * « Recruter » était sans retour : un candidat qui se désiste entre l'accord et la fiche laissait la
 * demande en intégration pour toujours, avec un recruté qui ne viendra pas. Tant que la fiche employé
 * n'existe pas, l'embauche s'annule : le candidat redevient retenu (la direction le recrute de nouveau,
 * ou l'écarte), et le poste se rouvre. Une fiche créée ne se défait pas d'ici : c'est un départ, aux RH.
 */
export async function annulerEmbaucheRecrutement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  if (!viewer) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const lu = await lireLAnnulation(formData, { id, viewer });
  if ("fini" in lu) return lu.fini;
  const { req, recrute, motif } = lu;

  try {
    await prisma.$transaction(async (tx) => {
      const candidat = await tx.recruitmentCandidate.updateMany({
        where: { id: recrute.id, status: "HIRED", employeeId: null },
        data: { status: "SELECTED", decidedAt: null },
      });
      if (candidat.count === 0) throw new EtatChange();
      const etape = await tx.recruitmentRequest.updateMany({ where: { id, stage: "ONBOARDING" }, data: { stage: "SOURCING" } });
      if (etape.count === 0) throw new EtatChange();
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);
  await annoncerLAnnulation(formData, { user, id, req, recrute, viewer });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_CANDIDATE", entityId: recrute.id,
    field: "Statut", oldValue: "HIRED", newValue: "SELECTED",
    summary: `${req.reference} — embauche de ${recrute.fullName} annulée par ${user.name} · ${motif}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: `Embauche annulée — ${recrute.fullName} redevient retenu, et le poste est rouvert.` };
}

// ───────────────────────────── Le fil de la demande (Direction, 07/10) ─────────────────────────────

/**
 * ÉCRIRE AU FIL — qui est partie à la demande (demandeur, validateurs, RH, sommet, et le SUIVI désigné par le DG),
 * tant qu'elle vit (`abilities().comment`). Le demandeur et le suivi sont prévenus, jamais l'auteur.
 */
export async function commenterDemandeRecrutement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const texte = fdStr(formData, "texte");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({ where: { id }, select: { reference: true, stage: true, requesterId: true } });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage as RecruitmentStage, viewer).comment) return { ok: false, error: "Cette demande est close : son fil ne s'écrit plus." };
  if (!texte) return { ok: false, error: "Écrivez votre message." };
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: texte });
  const corps = `${req.reference} — ${user.name} : ${texte.length > 140 ? `${texte.slice(0, 139)}…` : texte}`;
  if (req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Nouveau message sur votre demande de recrutement", body: corps, link: `/recrutement/${id}` }).catch(sansBloquer("recruitment-actions.commenterDemandeRecrutement.notifyUser"));
  }
  await prevenirLeSuivi(id, { title: "Nouveau message sur un recrutement que vous suivez", body: corps }, [user.id, req.requesterId]);
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Message ajouté au fil." };
}
