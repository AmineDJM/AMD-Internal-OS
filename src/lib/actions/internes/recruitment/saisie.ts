/**
 * RECRUTEMENT — les CORPS de saisie des actions : la demande créée, un CV déposé, le mouvement d'un candidat,
 * la désignation du DG qui conclut la chaîne, et la LECTURE (demande chargée, droits de l'étape, champs) d'une
 * clôture, d'une correction, d'une réouverture, d'une embauche annulée.
 *
 * Sortis de `actions/recruitment-actions.ts` (lot V4). Ce que ces corps n'écrivent JAMAIS : l'étape de la
 * demande. Chaque écriture d'étape reste dans son action, conditionnelle sur l'étape lue et suivie de la
 * resynchronisation de l'offre (les cliquets `etape-conditionnelle` et `site-web/recrutement` la lisent là).
 * L'action passe le FORMULAIRE à son corps : pour le contrat des actions, ce corps est celui du fichier
 * d'actions (`contrat/internes.ts`) — ses champs, ses écritures et ses écrivains importés comptent pour elle.
 */
import type { ContractType } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildRef, createWithRetry } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { attachFormFiles } from "@/lib/documents";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import type { recruitmentViewer } from "@/lib/recruitment/access";
import {
  abilities, nettoyerIds, reouverture, validateDraft, type canSelectCandidate, type ChainStep, type RecruitmentStage,
} from "@/lib/recruitment/request-flow";
import { relierALaPersonne } from "@/modules/referentiels/api";
import { MOTIF_REFUS, etapesDeLaChaine, type buildChain } from "@/lib/actions/internes/recruitment/circuit";
import { designesDuSommet, refusAnnulationEmbauche } from "@/lib/actions/internes/recruitment/decisions";
import { issueDeLaCorrection } from "@/lib/actions/internes/recruitment/phrases";

/** L'arrêt de l'action, avec ce qu'elle rend — un type nommé, pour que `"fini" in …` le distingue de la suite. */
const arret = (r: ActionResult): { fini: ActionResult } => ({ fini: r });

/** Les valeurs multiples d'un champ (`followerIds`) — lu par nom littéral, comme les autres champs. */
const fdList = (formData: FormData, key: string): string[] => formData.getAll(key).map((v) => String(v)).filter(Boolean);

type Lecteur = NonNullable<Awaited<ReturnType<typeof recruitmentViewer>>>;
const HORS_PERIMETRE: ActionResult = { ok: false, error: "Cette demande n'est pas dans votre périmètre." };

/** `createRecruitmentRequest`, une fois le brouillon validé et la chaîne calculée : la demande et ses marches. */
export async function enregistrerLaDemande(
  formData: FormData,
  ctx: {
    user: SessionUser; contractType: ContractType; chain: Awaited<ReturnType<typeof buildChain>>;
    draft: {
      position: string; headcount: number; salaryMin: number | null; salaryMax: number | null;
      startDate: Date | null; endDate: Date | null;
    };
  },
): Promise<{ id: string; reference: string }> {
  const { user, contractType, chain, draft } = ctx;
  const departmentId = fdStr(formData, "departmentId");
  const year = new Date().getFullYear();
  return createWithRetry(async () => {
    const refs = await prisma.recruitmentRequest.findMany({
      where: { reference: { startsWith: `REC-${year}-` } }, select: { reference: true },
    });
    return prisma.recruitmentRequest.create({
      data: {
        reference: buildRef("REC", year, refs.map((r) => r.reference)),
        companyId: await companyIdForNew(user.id),
        departmentId,
        requesterId: user.id,
        position: draft.position.trim(),
        headcount: draft.headcount,
        contractType,
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
}

/**
 * `decideRecruitmentStep` — LE DG QUI CONCLUT LA CHAÎNE DÉSIGNE LE N+1 DE LA FUTURE RECRUE ET LE SUIVI
 * (Direction, 07/10) : lus et vérifiés ici quand la décision l'exige (`designe`).
 */
export async function lireLaDesignation(formData: FormData, ctx: { designe: boolean }) {
  const futureManagerId = fdStr(formData, "futureManagerId");
  const followerIds = nettoyerIds(fdList(formData, "followerIds"));
  let nomsDesignes = new Map<string, string>();
  if (ctx.designe) {
    const lus = await designesDuSommet(futureManagerId, followerIds);
    if (!lus.ok) return { ok: false as const, error: lus.error };
    nomsDesignes = lus.noms;
  }
  return { ok: true as const, futureManagerId, followerIds, nomsDesignes };
}

/** `addRecruitmentCandidate`, après la porte : le candidat (et sa Personne), puis ses pièces. */
export async function deposerLeCandidat(formData: FormData, ctx: { user: SessionUser; id: string; fullName: string }) {
  const { user, id, fullName } = ctx;
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
  return { candidate, files };
}

/**
 * `moveRecruitmentCandidate` — ce que le mouvement demandé écrit sur le candidat, selon la MÊME table de droits
 * que l'écran (`can`). `enLice` : le candidat peut encore être retenu (`canSelectCandidate`, lu par l'action).
 */
export function donneesDuMouvement(
  formData: FormData,
  ctx: { user: SessionUser; move: string; candidate: { status: Parameters<typeof canSelectCandidate>[0] }; can: ReturnType<typeof abilities>; enLice: boolean },
): { data: Record<string, unknown> } | { error: string } {
  const { user, move, candidate, can, enLice } = ctx;
  const now = new Date();
  switch (move) {
    case "SHORTLIST":
      if (!can.shortlist) return { error: "La présélection appartient au demandeur." };
      return { data: { status: "SHORTLISTED", shortlistedById: user.id, shortlistedAt: now } };
    case "UNSHORTLIST":
      if (!can.shortlist) return { error: "La présélection appartient au demandeur." };
      if (candidate.status !== "SHORTLISTED") return { error: "Ce candidat n'est pas présélectionné." };
      return { data: { status: "RECEIVED", shortlistedById: null, shortlistedAt: null } };
    case "SELECT":
      if (!can.select) return { error: "Le choix final appartient à la direction générale." };
      // Présélectionné ou non : la présélection est un avis, pas un tri éliminatoire.
      if (!enLice) return { error: "Ce candidat n'est plus en lice." };
      return { data: { status: "SELECTED", selectedById: user.id, selectedAt: now } };
    case "INTERVIEW": {
      if (!can.interview) return { error: "Non autorisé à cette étape." };
      const at = fdDate(formData, "interviewAt");
      return { data: { status: "INTERVIEWED", interviewAt: at ?? now, interviewNote: fdStr(formData, "interviewNote") } };
    }
    case "HIRE":
      if (!can.hire) return { error: "Le recrutement se prononce par la direction générale." };
      return { data: { status: "HIRED", decidedAt: now } };
    case "DECLINE":
      if (!can.shortlist && !can.select && !can.interview) return { error: "Non autorisé." };
      return { data: { status: "DECLINED", decidedAt: now } };
    default:
      return { error: "Action inconnue." };
  }
}

/**
 * `resoumettreDemandeRecrutement` — la demande renvoyée, le droit de la corriger, ce qui a changé, et la
 * correction lue : ce que le formulaire ne porte pas garde sa valeur (§118.152c). `fini` : l'action s'arrête là.
 */
export async function lireLaCorrection(formData: FormData, ctx: { id: string; viewer: Lecteur }) {
  const { id, viewer } = ctx;
  const req = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, stage: true, requesterId: true, position: true, headcount: true, contractType: true,
      salaryMin: true, salaryMax: true, startDate: true, endDate: true, missions: true, skills: true, justification: true,
      returnedFrom: true, returnedById: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
    },
  });
  if (!req) return arret(HORS_PERIMETRE);
  if (!abilities(req.stage, viewer).correct) {
    return arret({ ok: false, error: req.stage === "RETURNED" ? "Seul son demandeur corrige une demande renvoyée." : "Cette demande n'est pas à corriger : elle n'a pas été renvoyée." });
  }
  const changements = fdStr(formData, "changements");
  if (!changements) return arret({ ok: false, error: "Dites ce qui a changé : c'est ce que lira la personne qui vous l'a renvoyée." });

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
  if (invalide) return arret({ ok: false, error: invalide });

  const steps: ChainStep[] = etapesDeLaChaine(req.approvals);
  const { materiels, repart, vers } = issueDeLaCorrection(req, draft, steps);
  return { req, changements, draft, missions, skills, justification, steps, materiels, repart, vers };
}

/**
 * `rouvrirDemandeRecrutement` — la demande refusée ou close, où elle repart (`reouverture`), le droit de la
 * rouvrir, et le motif exigé. `fini` : l'action s'arrête là.
 */
export async function lireLaReouverture(formData: FormData, ctx: { id: string; viewer: Lecteur }) {
  const { id, viewer } = ctx;
  const req = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true, closingNote: true,
      approvals: { select: { order: true, approverId: true, status: true, approver: { select: { name: true } } } },
      _count: { select: { candidates: { where: { status: "HIRED" } } } },
    },
  });
  if (!req) return arret(HORS_PERIMETRE);
  const aRecrute = req._count.candidates > 0;
  const steps: ChainStep[] = etapesDeLaChaine(req.approvals);
  const ou = reouverture(req.stage as RecruitmentStage, steps, aRecrute);
  if ("refus" in ou) return arret({ ok: false, error: ou.refus });
  if (!abilities(req.stage as RecruitmentStage, viewer, { aRecrute }).reopen) {
    return arret({ ok: false, error: "Seuls les RH ou la direction rouvrent une demande." });
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return arret({ ok: false, error: "Dites pourquoi vous la rouvrez : c'est ce que liront le demandeur et la personne qui la reprend." });
  return { req, steps, ou, motif };
}

/**
 * `annulerEmbaucheRecrutement` — le recruté encore SANS fiche, le droit d'annuler, et le motif exigé. `fini` :
 * l'action s'arrête là.
 */
export async function lireLAnnulation(formData: FormData, ctx: { id: string; viewer: Lecteur }) {
  const { id, viewer } = ctx;
  const req = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      reference: true, position: true, stage: true, requesterId: true,
      candidates: { where: { status: "HIRED" }, select: { id: true, fullName: true, employeeId: true } },
    },
  });
  if (!req) return arret(HORS_PERIMETRE);
  const recrute = req.candidates[0];
  const sansFiche = Boolean(recrute) && recrute.employeeId === null;
  if (!abilities(req.stage as RecruitmentStage, viewer, { embaucheSansFiche: sansFiche }).cancelHire) {
    return arret({ ok: false, error: refusAnnulationEmbauche(recrute, req.stage) });
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return arret({ ok: false, error: "Dites pourquoi l'embauche s'annule : c'est ce que liront le demandeur et la direction." });
  return { req, recrute, motif };
}

/**
 * `closeRecruitmentRequest` — le droit de refuser ou de clore à cette étape, et la phrase exigée (c'est ce que lira
 * le demandeur). `fini` : l'action s'arrête là.
 */
export async function lireLaCloture(formData: FormData, ctx: { id: string; viewer: Lecteur; reject: boolean }) {
  const { id, viewer, reject } = ctx;
  const req = await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { reference: true, stage: true, requesterId: true },
  });
  if (!req) return arret(HORS_PERIMETRE);

  const can = abilities(req.stage, viewer);
  const autorise = reject ? can.hrReject : viewer.isHr || viewer.isTop;
  if (autorise === false) return arret({ ok: false, error: "Non autorisé à cette étape." });
  if (reject === false && req.stage !== "SOURCING" && req.stage !== "ONBOARDING") {
    return arret({ ok: false, error: "Une demande ne se clôt qu'une fois le poste ouvert." });
  }
  const note = fdStr(formData, "note");
  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18). Refuser ou clôturer sans suite, c'est fermer le besoin de
  // quelqu'un : l'écran exigeait la phrase, le serveur ne la demandait pas.
  if (!note) return arret({ ok: false, error: reject ? MOTIF_REFUS : "Dites pourquoi le poste se clôt sans suite : c'est ce que lira le demandeur." });
  return { req, note };
}
