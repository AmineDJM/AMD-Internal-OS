"use server";

import { revalidatePath } from "next/cache";
import { doubleEcrireCoffre } from "@/lib/coffre/ecriture";
import { synchroniserOffreDeLaDemande } from "@/lib/site-web/contenus";
import type { ContractType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan, rolesWithModule, isTopManagement } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { getManagementChain } from "@/lib/departments";
import { attachFormFiles } from "@/lib/documents";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { recruitmentViewer } from "@/lib/recruitment/access";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import {
  abilities, ETAPES_RETIRABLES, prevenusAuRetrait, applyChainDecision, canDecideStep, canSelectCandidate, currentStep,
  needsOnboarding, summarize, validateDraft, CONTRACT_LABEL,
  marchesChangees, changementsMateriels, reouverture, STAGE_LABEL,
  completerJusquAuSommet, ORDRE_DU_SOMMET, cibleDeLaDecision, decisionDuSommetExigeSuivi,
  nettoyerIds, refusDesignationDuSommet, suiveursAPrevenir,
  type ChainStep, type RecruitmentContract, type RecruitmentStage,
} from "@/lib/recruitment/request-flow";
import { relierALaPersonne, relierCommeLaLigne } from "@/lib/referentiels/personnes/double-ecriture";

/** Les valeurs multiples d'un champ (`followerIds`) — lu par nom littéral, comme les autres champs. */
const fdList = (formData: FormData, key: string): string[] => formData.getAll(key).map((v) => String(v)).filter(Boolean);

/**
 * PRÉVENIR LE SUIVI — le futur N+1 et les personnes en charge du suivi (désignés par le DG, Direction 07/10)
 * reçoivent les notifications d'étape là où le demandeur les reçoit. Jamais l'auteur du geste ni ceux de `sauf`
 * (le demandeur, déjà prévenu). Un échec de notification ne défait pas le geste.
 */
async function prevenirLeSuivi(
  id: string,
  n: { title: string; body: string },
  sauf: (string | null | undefined)[],
): Promise<void> {
  const r = await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { futureManagerId: true, followers: { select: { userId: true } } },
  });
  if (!r) return;
  for (const userId of suiveursAPrevenir(r.futureManagerId, r.followers.map((f) => f.userId), sauf)) {
    await notifyUser({ userId, type: "GENERIC", title: n.title, body: n.body, link: `/recrutement/${id}` }).catch(() => undefined);
  }
}

/**
 * LE CIRCUIT DE RECRUTEMENT — la porte de l'écran.
 *
 * Les RÈGLES vivent dans `lib/recruitment/request-flow.ts` (module pur, testé) ; ici on ne fait
 * que trois choses : lire le formulaire, résoudre qui parle, écrire. Toute décision — qui peut
 * quoi, ce qui suit quoi — est posée là-bas et RE-DEMANDÉE ici avec les mêmes arguments que
 * l'écran : un bouton visible correspond alors toujours à une action permise, et l'inverse.
 */

/**
 * UN GESTE À LA FOIS (audit 360°, R14 — §118.192). Chaque écriture d'étape est conditionnelle sur l'étape
 * LUE : deux gestes croisés sur la même demande — le N+1 et la direction sur la même marche, un retrait
 * pendant une validation, deux RH qui tranchent ensemble — ne s'écrasent plus l'un l'autre. Le perdant
 * le dit et n'écrit rien ; dans une transaction, il défait ce qu'il avait commencé.
 */
class EtatChange extends Error {}
const DEJA_CHANGE = "Cette demande vient de changer — un autre geste est passé avant le vôtre : rouvrez-la pour voir où elle en est.";
const MOTIF_REFUS = "Un refus se motive — c'est ce que le demandeur lira.";

// ───────────────────────────── Créer la demande ─────────────────────────────

/**
 * Construit la chaîne de validation : le N+1, puis les N+1 successifs jusqu'au sommet.
 *
 * Elle est FIGÉE ici, à la soumission. Une réorganisation en cours de route changerait sinon les
 * validateurs d'une demande déjà partie, et l'on ne saurait plus qui devait trancher quand elle a
 * été déposée.
 *
 * Le demandeur est écarté de sa propre chaîne : un directeur qui est aussi son propre N+1 dans
 * l'organigramme ne se valide pas lui-même.
 *
 * ELLE MONTE JUSQU'AU DG (Direction, 07/10) : si l'organigramme s'arrête avant le sommet (`isTopManagement`), le
 * premier sommet actif — DG, puis Direction, puis Super Admin — est ajouté en dernière marche
 * (`completerJusquAuSommet`). Un demandeur sans fiche employé part donc directement au sommet.
 */
async function buildChain(requesterUserId: string): Promise<{ approverId: string; name: string }[]> {
  const emp = await prisma.employee.findUnique({ where: { userId: requesterUserId }, select: { id: true } });
  const chain = emp ? await getManagementChain(emp.id) : [];
  const ids: string[] = [];
  const noms = new Map<string, string>();
  const seen = new Set<string>([requesterUserId]);
  for (const m of chain) {
    if (!m.userId || seen.has(m.userId)) continue;
    seen.add(m.userId);
    ids.push(m.userId);
    noms.set(m.userId, m.fullName);
  }
  const [comptes, sommets] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, secondaryRole: true } }),
    prisma.user.findMany({
      where: { isActive: true, OR: [{ role: { in: [...ORDRE_DU_SOMMET] } }, { secondaryRole: { in: [...ORDRE_DU_SOMMET] } }] },
      select: { id: true, name: true, role: true, secondaryRole: true },
    }),
  ]);
  const top = new Map(comptes.map((c) => [c.id, isTopManagement(c)]));
  const rang = (u: { role: string; secondaryRole: string | null }) => Math.min(
    ...[u.role, u.secondaryRole].map((r) => { const i = (ORDRE_DU_SOMMET as readonly string[]).indexOf(r ?? ""); return i < 0 ? 99 : i; }),
  );
  const sommetsTries = [...sommets].sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name));
  return completerJusquAuSommet(
    ids.map((id) => ({ approverId: id, name: noms.get(id) ?? "", isTop: top.get(id) ?? false })),
    sommetsTries.map((s) => ({ id: s.id, name: s.name })),
    requesterUserId,
  );
}

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
  if (chain.length === 0) {
    return {
      ok: false,
      error: "Aucun validateur n'a pu être trouvé — ni responsable hiérarchique au-dessus de vous, ni direction "
        + "générale active : la demande ne pourrait être validée par personne. Faites compléter l'organigramme par les RH.",
    };
  }

  const departmentId = fdStr(formData, "departmentId");
  const year = new Date().getFullYear();
  const created = await createWithRetry(async () => {
    const reference = await referenceDeSerie({
      modele: "RecruitmentRequest", prefixe: "REC", annee: year,
      existantes: async () => (await prisma.recruitmentRequest.findMany({ where: { reference: { startsWith: `REC-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
    });
    return prisma.recruitmentRequest.create({
      data: {
        reference,
        companyId: await companyIdForNew(user.id),
        departmentId,
        requesterId: user.id,
        position: draft.position.trim(),
        headcount: draft.headcount,
        contractType: contractType as ContractType,
        salaryMin: draft.salaryMin, salaryMax: draft.salaryMax,
        startDate: draft.startDate, endDate: draft.endDate,
        missions: fdStr(formData, "missions"),
        skills: fdStr(formData, "skills"),
        justification: fdStr(formData, "justification"),
        approvals: { create: chain.map((c, i) => ({ order: i + 1, approverId: c.approverId })) },
      },
      select: { id: true, reference: true },
    });
  });

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

  const steps: ChainStep[] = req.approvals.map((a) => ({
    order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "", status: a.status,
  }));
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
  const futureManagerId = fdStr(formData, "futureManagerId");
  const followerIds = nettoyerIds(fdList(formData, "followerIds"));
  let nomsDesignes = new Map<string, string>();
  if (designe) {
    const actifs = await prisma.user.findMany({
      where: { id: { in: nettoyerIds([futureManagerId, ...followerIds]) }, isActive: true },
      select: { id: true, name: true },
    });
    const refus = refusDesignationDuSommet({ futureManagerId, followerIds }, new Set(actifs.map((a) => a.id)));
    if (refus) return { ok: false, error: refus };
    nomsDesignes = new Map(actifs.map((a) => [a.id, a.name]));
  }

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
    await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Refusée à la marche ${target.order} — ${reason}` }).catch(() => undefined);
  }
  const phraseSuivi = designe
    ? `N+1 de la future recrue : ${nomsDesignes.get(futureManagerId ?? "") ?? "—"} · Suivi : ${followerIds.map((f) => nomsDesignes.get(f) ?? "—").join(", ")}`
    : null;
  if (designe && futureManagerId) {
    await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Validée par ${user.name} — ${phraseSuivi}` }).catch(() => undefined);
    if (futureManagerId !== user.id) {
      await notifyUser({
        userId: futureManagerId, type: "GENERIC",
        title: "Vous serez le N+1 d'une future recrue",
        body: `${req.reference} — ${req.position} : la direction générale vous a désigné N+1 du poste.`,
        link: `/recrutement/${id}`,
      }).catch(() => undefined);
    }
    for (const f of followerIds) {
      if (f === user.id || f === futureManagerId) continue;
      await notifyUser({
        userId: f, type: "GENERIC",
        title: "Recrutement à suivre",
        body: `${req.reference} — ${req.position} : la direction générale vous a confié le suivi de ce recrutement.`,
        link: `/recrutement/${id}`,
      }).catch(() => undefined);
    }
  }
  // L'offre publiée sur le site suit l'étape du poste (§118.158) : ouverte, elle est en ligne ;
  // pourvue, close, refusée ou annulée, elle repasse en brouillon — tout de suite.
  await synchroniserOffreDeLaDemande(id, user.id);

  // On prévient CELUI QUI ATTEND : la marche suivante, ou les RH quand la chaîne est franchie,
  // ou le demandeur quand c'est un refus. Une notification à tout le monde n'aiderait personne.
  if (decision === "REJECTED") {
    await notifyUser({
      userId: req.requesterId, type: "GENERIC",
      title: "Demande de recrutement refusée",
      body: `${req.reference} — ${req.position} · ${reason ?? ""}`,
      link: `/recrutement/${id}`,
    });
  } else if (outcome.complete) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), {
      type: "GENERIC",
      title: "Nouvelle demande de recrutement à instruire",
      body: `${req.reference} — ${req.position}`,
      link: `/recrutement/${id}`,
    });
  } else {
    const next = currentStep(nextSteps);
    if (next) {
      await notifyUser({
        userId: next.approverId, type: "GENERIC",
        title: "Demande de recrutement à valider",
        body: `${req.reference} — ${req.position}`,
        link: `/recrutement/${id}`,
      });
    }
  }

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
  if (!abilities(req.stage, viewer).cancel) {
    return {
      ok: false,
      error: ETAPES_RETIRABLES.has(req.stage)
        ? "Seul le demandeur (ou la direction) retire cette demande."
        : "Cette demande n'est plus en cours : un recrutement a été prononcé, ou elle est déjà close — elle ne se retire plus.",
    };
  }

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

  const prevenus = prevenusAuRetrait(req.stage, req.approvals, user.id);
  const corps = `${req.reference} — ${req.position} : retirée par son demandeur${motif ? ` (${motif})` : ""}. Il n'y a plus rien à traiter.`;
  for (const approverId of prevenus.approbateurs) {
    await notifyUser({ userId: approverId, type: "GENERIC", title: "Demande de recrutement retirée", body: corps, link: `/recrutement/${id}` }).catch(() => undefined);
  }
  if (prevenus.rh) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Demande de recrutement retirée", body: corps, link: `/recrutement/${id}` }).catch(() => undefined);
  }
  await prevenirLeSuivi(id, { title: "Demande de recrutement retirée", body: corps }, [user.id, ...prevenus.approbateurs]);
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

  const info = await prisma.recruitmentInfoRequest.findFirst({
    where: { id: infoId, requestId: id }, select: { id: true, askedById: true, question: true, answeredAt: true },
  });
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
  return {
    ok: true,
    message: retour.count > 0 ? "Réponse transmise aux RH."
      : pending === 0 ? "Réponse enregistrée — la demande a changé entre-temps : rouvrez-la pour voir où elle en est."
        : "Réponse enregistrée.",
  };
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
  const note = fdStr(formData, "note");
  const brute = fdStr(formData, "decision");
  if (!id) return { ok: false, error: "Demande introuvable." };
  // Absente : clôturer. « REJECTED » : refuser. Toute autre valeur est illisible — et ne clôt rien.
  if (brute !== null && brute !== "REJECTED" && brute !== "CLOSE") return { ok: false, error: "Décision illisible (attendu : refuser ou clôturer)." };
  const reject = brute === "REJECTED";
  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, stage: true, requesterId: true },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };

  const can = abilities(req.stage, viewer);
  const autorise = reject ? can.hrReject : viewer.isHr || viewer.isTop;
  if (autorise === false) return { ok: false, error: "Non autorisé à cette étape." };
  if (reject === false && req.stage !== "SOURCING" && req.stage !== "ONBOARDING") {
    return { ok: false, error: "Une demande ne se clôt qu'une fois le poste ouvert." };
  }
  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18). Refuser ou clôturer sans suite, c'est fermer le besoin de
  // quelqu'un : l'écran exigeait la phrase, le serveur ne la demandait pas.
  if (!note) return { ok: false, error: reject ? MOTIF_REFUS : "Dites pourquoi le poste se clôt sans suite : c'est ce que lira le demandeur." };

  const fermee = await prisma.recruitmentRequest.updateMany({
    where: { id, stage: req.stage },
    data: { stage: reject ? "REJECTED" : "CLOSED", closingNote: note, closedAt: new Date() },
  });
  if (fermee.count === 0) return { ok: false, error: DEJA_CHANGE };
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `${reject ? "Refusée par les RH" : "Clôturée sans suite"} — ${note}` }).catch(() => undefined);
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

  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const candidate = await prisma.$transaction(async (tx) => {
    const ligne = await tx.recruitmentCandidate.create({
      data: {
        requestId: id, fullName,
        email: fdStr(formData, "email"), phone: fdStr(formData, "phone"),
        source: fdStr(formData, "source"), notes: fdStr(formData, "notes"),
        addedById: user.id,
      },
      select: { id: true },
    });
    await relierALaPersonne(tx, "RecruitmentCandidate", ligne.id, user.id);
    return ligne;
  });
  const files = await attachFormFiles(user.id, "RECRUITMENT_CANDIDATE", candidate.id, formData);

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

  const now = new Date();
  let data: Record<string, unknown>;
  switch (move) {
    case "SHORTLIST":
      if (!can.shortlist) return { ok: false, error: "La présélection appartient au demandeur." };
      data = { status: "SHORTLISTED", shortlistedById: user.id, shortlistedAt: now };
      break;
    case "UNSHORTLIST":
      if (!can.shortlist) return { ok: false, error: "La présélection appartient au demandeur." };
      if (candidate.status !== "SHORTLISTED") return { ok: false, error: "Ce candidat n'est pas présélectionné." };
      data = { status: "RECEIVED", shortlistedById: null, shortlistedAt: null };
      break;
    case "SELECT":
      if (!can.select) return { ok: false, error: "Le choix final appartient à la direction générale." };
      // Présélectionné ou non : la présélection est un avis, pas un tri éliminatoire.
      if (!canSelectCandidate(candidate.status)) return { ok: false, error: "Ce candidat n'est plus en lice." };
      data = { status: "SELECTED", selectedById: user.id, selectedAt: now };
      break;
    case "INTERVIEW": {
      if (!can.interview) return { ok: false, error: "Non autorisé à cette étape." };
      const at = fdDate(formData, "interviewAt");
      data = { status: "INTERVIEWED", interviewAt: at ?? now, interviewNote: fdStr(formData, "interviewNote") };
      break;
    }
    case "HIRE":
      if (!can.hire) return { ok: false, error: "Le recrutement se prononce par la direction générale." };
      data = { status: "HIRED", decidedAt: now };
      break;
    case "DECLINE":
      if (!can.shortlist && !can.select && !can.interview) return { ok: false, error: "Non autorisé." };
      data = { status: "DECLINED", decidedAt: now };
      break;
    default:
      return { ok: false, error: "Action inconnue." };
  }

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
  const managerFiche = req.futureManagerId
    ? await prisma.employee.findUnique({ where: { userId: req.futureManagerId }, select: { id: true } })
    : null;

  // LA FICHE, LE LIEN ET LA CLÔTURE EN UNE TRANSACTION, depuis l'intégration LUE : une embauche annulée
  // pendant la création ne laisse pas une fiche employé pour quelqu'un qu'on ne recrute plus.
  let employee: { id: string };
  try {
    employee = await prisma.$transaction(async (tx) => {
      const cree = await tx.employee.create({
    data: {
      fullName: hired.fullName,
      position: req.position,
      companyId: req.companyId,
      departmentId: req.departmentId,
      department: req.department?.name ?? null,
      email: hired.email, phone: hired.phone,
      contractType: req.contractType,
      contractStart: req.startDate, contractEnd: req.endDate,
      hireDate: req.startDate,
      // La borne BASSE de la fourchette, pas la haute : c'est l'hypothèse prudente, et le
      // salaire réel se fixe au contrat — que les RH saisiront sur la fiche.
      baseSalary: req.salaryMin ?? 0,
      managerId: managerFiche?.id ?? null,
      isActive: true,
      notes: `Recruté via la demande ${req.reference}.`,
    },
    select: { id: true },
      });
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
  const steps: ChainStep[] = req.approvals.map((a) => ({ order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "", status: a.status }));
  const peutTrancher = canDecideStep(req.stage, steps, { userId: user.id, isTop: viewer.isTop }).ok;
  if (!abilities(req.stage, viewer, { peutTrancherLaMarche: peutTrancher }).returnForCorrection) {
    return {
      ok: false,
      error: req.stage === "CHAIN" ? canDecideStep(req.stage, steps, { userId: user.id, isTop: viewer.isTop }).reason ?? "Ce n'est pas à vous de trancher cette marche."
        : req.stage === "HR_REVIEW" ? "Seuls les RH renvoient une demande qu'ils instruisent."
          : "Une demande ne se renvoie que pendant sa validation : dans la chaîne, ou chez les RH.",
    };
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
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Renvoyée pour correction (${STAGE_LABEL[req.stage as RecruitmentStage]}) — ${motif}` }).catch(() => undefined);
  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: "Demande de recrutement à corriger",
    body: `${req.reference} — ${req.position} · ${motif}`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: "Demande de recrutement renvoyée pour correction", body: `${req.reference} — ${req.position} · ${motif}` }, [user.id, req.requesterId]);
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
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, stage: true, requesterId: true, position: true, headcount: true, contractType: true,
      salaryMin: true, salaryMax: true, startDate: true, endDate: true, missions: true, skills: true, justification: true,
      returnedFrom: true, returnedById: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
    },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!abilities(req.stage, viewer).correct) {
    return { ok: false, error: req.stage === "RETURNED" ? "Seul son demandeur corrige une demande renvoyée." : "Cette demande n'est pas à corriger : elle n'a pas été renvoyée." };
  }
  const changements = fdStr(formData, "changements");
  if (!changements) return { ok: false, error: "Dites ce qui a changé : c'est ce que lira la personne qui vous l'a renvoyée." };

  const nombre = (v: unknown) => (v == null ? null : Number(v));
  const position = formData.has("position") ? fdStr(formData, "position") ?? "" : req.position;
  const headcount = formData.has("headcount") ? Math.floor(fdNum(formData, "headcount") ?? Number.NaN) : req.headcount;
  const contractType = formData.has("contractType") ? fdStr(formData, "contractType") ?? "" : req.contractType;
  const salaryMin = formData.has("salaryMin") ? fdNum(formData, "salaryMin") : nombre(req.salaryMin);
  const salaryMax = formData.has("salaryMax") ? fdNum(formData, "salaryMax") : nombre(req.salaryMax);
  const startDate = formData.has("startDate") ? fdDate(formData, "startDate") : req.startDate;
  const endDate = formData.has("endDate") ? fdDate(formData, "endDate") : req.endDate;
  const missions = formData.has("missions") ? fdStr(formData, "missions") : req.missions;
  const skills = formData.has("skills") ? fdStr(formData, "skills") : req.skills;
  const justification = formData.has("justification") ? fdStr(formData, "justification") : req.justification;

  const draft = { position, headcount, contractType, salaryMin, salaryMax, startDate, endDate };
  const invalide = validateDraft(draft);
  if (invalide) return { ok: false, error: invalide };

  const steps: ChainStep[] = req.approvals.map((a) => ({ order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "", status: a.status }));
  const materiels = changementsMateriels(
    { position: req.position, headcount: req.headcount, contractType: req.contractType, salaryMin: nombre(req.salaryMin), salaryMax: nombre(req.salaryMax), endDate: req.endDate },
    draft,
  );
  // La chaîne ne REPART que si quelqu'un y avait déjà dit oui : renvoyée de la première marche, une
  // correction matérielle y revient de toute façon.
  const repart = materiels.length > 0 && steps.some((s) => s.status !== "PENDING");
  const vers: RecruitmentStage = repart ? "CHAIN" : (req.returnedFrom as RecruitmentStage | null) ?? "CHAIN";

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
  await ecrireAuFil({
    entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id,
    body: `Corrigée et renvoyée — ${changements}${repart ? ` · la chaîne repart de sa première marche : ${materiels.join(", ")}` : ""}`,
  }).catch(() => undefined);

  // On prévient CELUI QUI ATTEND, et seulement lui.
  const titre = repart ? "Demande de recrutement à valider de nouveau" : "Demande de recrutement corrigée";
  const corps = `${req.reference} — ${position.trim()} · ${changements}${repart ? ` · le besoin a changé : ${materiels.join(", ")}` : ""}`;
  const lien = `/recrutement/${id}`;
  if (vers === "CHAIN") {
    const marche = repart ? [...steps].sort((a, b) => a.order - b.order)[0] : currentStep(steps);
    if (marche) await notifyUser({ userId: marche.approverId, type: "GENERIC", title: titre, body: corps, link: lien });
    if (req.returnedById && req.returnedById !== marche?.approverId) {
      await notifyUser({ userId: req.returnedById, type: "GENERIC", title: "La demande que vous avez renvoyée est corrigée", body: corps, link: lien });
    }
  } else if (req.returnedById) {
    await notifyUser({ userId: req.returnedById, type: "GENERIC", title: titre, body: corps, link: lien });
  } else {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: titre, body: corps, link: lien });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "Étape", oldValue: "RETURNED", newValue: vers,
    summary: `${req.reference} — corrigée et renvoyée · ${changements}${repart ? ` (la chaîne repart : ${materiels.join(", ")})` : ""}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return {
    ok: true,
    message: repart
      ? `Demande corrigée — le besoin a changé (${materiels.join(", ")}) : la chaîne repart de sa première marche.`
      : vers === "CHAIN" ? "Demande corrigée — elle revient à la marche qui vous l'avait renvoyée." : "Demande corrigée — elle revient aux RH.",
  };
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
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true, closingNote: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
      _count: { select: { candidates: { where: { status: "HIRED" } } } },
    },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const aRecrute = req._count.candidates > 0;
  const steps: ChainStep[] = req.approvals.map((a) => ({ order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "", status: a.status }));
  const ou = reouverture(req.stage as RecruitmentStage, steps, aRecrute);
  if ("refus" in ou) return { ok: false, error: ou.refus };
  if (!abilities(req.stage as RecruitmentStage, viewer, { aRecrute }).reopen) {
    return { ok: false, error: "Seuls les RH ou la direction rouvrent une demande." };
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi vous la rouvrez : c'est ce que liront le demandeur et la personne qui la reprend." };

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
  // La décision qu'on rouvre reste lisible : la fiche la retire de son bloc « Décision », le fil la garde.
  await ecrireAuFil({
    entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id,
    body: `Rouverte — ${motif}${req.closingNote ? ` · la décision précédente : « ${req.closingNote} »` : ""}`,
  }).catch(() => undefined);
  const corps = `${req.reference} — ${req.position} · ${motif}`;
  const lien = `/recrutement/${id}`;
  if (ou.vers === "CHAIN" && ou.marche !== null) {
    const marche = steps.find((s) => s.order === ou.marche);
    if (marche) await notifyUser({ userId: marche.approverId, type: "GENERIC", title: "Demande de recrutement rouverte — à trancher de nouveau", body: corps, link: lien });
  } else if (ou.vers === "HR_REVIEW") {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Demande de recrutement rouverte — à instruire", body: corps, link: lien });
  }
  if (req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Votre demande de recrutement est rouverte", body: corps, link: lien });
  }
  await prevenirLeSuivi(id, { title: "Demande de recrutement rouverte", body: corps }, [user.id, req.requesterId]);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Recrutement",
    entityType: "RECRUITMENT_REQUEST", entityId: id,
    field: "Étape", oldValue: req.stage, newValue: ou.vers,
    summary: `${req.reference} — rouverte par ${user.name} · ${motif}`,
  });
  revalidatePath("/recrutement");
  revalidatePath(`/recrutement/${id}`);
  return {
    ok: true,
    message: ou.vers === "CHAIN" ? "Demande rouverte — elle repart à la marche qui l'avait refusée."
      : ou.vers === "HR_REVIEW" ? "Demande rouverte — elle revient aux RH." : "Demande rouverte — le poste est de nouveau ouvert.",
  };
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
  const req = viewer && await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true,
      candidates: { where: { status: "HIRED" }, select: { id: true, fullName: true, employeeId: true } },
    },
  });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  const recrute = req.candidates[0];
  const sansFiche = Boolean(recrute) && recrute.employeeId === null;
  if (!abilities(req.stage as RecruitmentStage, viewer, { embaucheSansFiche: sansFiche }).cancelHire) {
    return {
      ok: false,
      error: recrute && recrute.employeeId !== null
        ? "La fiche employé existe déjà : l'embauche ne s'annule plus d'ici — c'est un départ, à traiter aux RH."
        : req.stage !== "ONBOARDING" ? "Aucune embauche en attente d'intégration sur cette demande."
          : "Seuls les RH ou la direction annulent une embauche.",
    };
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi l'embauche s'annule : c'est ce que liront le demandeur et la direction." };

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
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Embauche de ${recrute.fullName} annulée — ${motif}` }).catch(() => undefined);
  const corps = `${req.reference} — ${recrute.fullName} · ${motif}`;
  const lien = `/recrutement/${id}`;
  if (req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Embauche annulée — le poste est rouvert", body: corps, link: lien });
  }
  await prevenirLeSuivi(id, { title: "Embauche annulée — le poste est rouvert", body: corps }, [user.id, req.requesterId]);
  if (!viewer.isHr) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Embauche annulée — plus d'intégration à préparer", body: corps, link: lien });
  }
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
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Nouveau message sur votre demande de recrutement", body: corps, link: `/recrutement/${id}` }).catch(() => undefined);
  }
  await prevenirLeSuivi(id, { title: "Nouveau message sur un recrutement que vous suivez", body: corps }, [user.id, req.requesterId]);
  revalidatePath(`/recrutement/${id}`);
  return { ok: true, message: "Message ajouté au fil." };
}
