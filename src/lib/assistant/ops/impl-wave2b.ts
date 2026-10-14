import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  createRecruitmentRequest, cancelRecruitmentRequest, askRecruitmentInfo, answerRecruitmentInfo,
  openRecruitmentSourcing, closeRecruitmentRequest, addRecruitmentCandidate, moveRecruitmentCandidate,
  onboardRecruitment,
} from "@/lib/actions/recruitment-actions";
import {
  requestTraining, createHrTraining, updateTraining, inviteTrainingParticipants, respondToTrainingInvitation,
} from "@/lib/actions/training-actions";
import { assignMission, removeMission, requestMissionOrder, issueMissionOrder, addMissionComment } from "@/lib/actions/mission-actions";
import {
  requestDocument as requestEntityDocument, submitDocumentRequest, decideDocumentRequest, cancelDocumentRequest,
} from "@/lib/actions/document-request-actions";
import {
  requestDocument as requestMedicalDoc, cancelDocRequest, recordAuthorityDeclaration,
  validateDeclaration, validateDeclarationByDirection, addMedicalInfoComment,
  requestSlipsValidation, requestSlipPayment, deliverMedicalInfoSlip, skipMedicalInfoBv,
  requestDeclareDecision, addMedicalInfoSlip, removeMedicalInfoSlip, createMedicalInfoItem,
} from "@/lib/actions/medical-info-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, runFd2, dzd, fieldsOf, resolveOne, isoDate } from "./helpers";

/**
 * OPS VAGUE 2b — recrutement (circuit complet jusqu'à l'onboarding), formations (demande,
 * organisation RH, correction, invitations, réponses), missions d'événements (assignation,
 * ordres de mission), demandes de documents transverses, information médicale (déclarations
 * autorités). Toujours par les ACTIONS CANONIQUES — les chaînes de validation, périmètres
 * d'entité et verrous de stade restent les leurs.
 */

const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const resolvePerson = (raw: string) =>
  resolveOne(raw, "la personne",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

const resolveDeptLocal = (raw: string) =>
  resolveOne(raw, "le département (champ « department »)",
    (q) => prisma.department.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (d) => d.name);

// ─────────────── Recrutement ───────────────

const REC_STAGE_FR: Record<string, string> = {
  CHAIN: "Validation hiérarchique", HR_REVIEW: "Revue RH", INFO_REQUESTED: "Informations demandées", RETURNED: "À corriger",
  SOURCING: "Sourcing (candidatures)", ONBOARDING: "Intégration", CLOSED: "Clôturée", REJECTED: "Refusée", CANCELLED: "Annulée",
};

async function resolveRecruitment(raw: string, stages?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (REC-…) ou le poste de la demande de recrutement." } as const;
  const rows = await prisma.recruitmentRequest.findMany({
    where: {
      ...(stages ? { stage: { in: stages as never } } : {}),
      OR: [{ reference: { equals: q, mode: "insensitive" } }, { position: { contains: q, mode: "insensitive" } }],
    },
    select: { id: true, reference: true, position: true, stage: true, headcount: true, contractType: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune demande de recrutement « ${q} »${stages ? ` au stade ${stages.map((s) => REC_STAGE_FR[s] ?? s).join("/")}` : ""}.` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs demandes correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.position} (${REC_STAGE_FR[r.stage] ?? r.stage})`).join(" ; ")} — donner la référence exacte.` } as const;
}

const CAND_STATUS_FR: Record<string, string> = {
  RECEIVED: "Reçue", SHORTLISTED: "Présélectionné", SELECTED: "Choisi", INTERVIEWED: "Reçu en entretien", HIRED: "Recruté", DECLINED: "Écarté",
};

const CAND_MOVES: [RegExp, string, string][] = [
  [/pr[ée]s[ée]lection|shortlist/i, "SHORTLIST", "Présélectionner"],
  [/retire.*pr[ée]s[ée]lection|unshortlist/i, "UNSHORTLIST", "Retirer de la présélection"],
  [/choisi|s[ée]lectionn|retien/i, "SELECT", "Choisir (direction générale)"],
  [/entretien|interview/i, "INTERVIEW", "Noter l'entretien"],
  [/recrut|embauch|hire/i, "HIRE", "Recruter"],
  [/[ée]carte|decline|rejet/i, "DECLINE", "Écarter"],
];

// ─────────────── Formations ───────────────

async function resolveTraining(raw: string, statuses?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (FORM-…) ou le titre de la formation." } as const;
  const rows = await prisma.training.findMany({
    where: {
      ...(statuses ? { status: { in: statuses as never } } : {}),
      OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }],
    },
    select: { id: true, reference: true, title: true, status: true, amount: true, startDate: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune formation « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs formations correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.title}`).join(" ; ")} — donner la référence exacte.` } as const;
}

// ─────────────── Missions (entités porteuses) ───────────────

export interface MissionParent { entityType: string; entityId: string; label: string }

export async function resolveMissionParent(kindRaw: string, labelRaw: string): Promise<MissionParent | { error: string }> {
  const q = labelRaw.trim();
  if (!q) return { error: "Précisez l'événement / congrès / sponsoring visé (champ « target »)." };
  const k = kindRaw.toLowerCase();
  const wantEvent = /[ée]v[èeé]nement|event/.test(k);
  const wantSpo = /sponsor/.test(k);
  const wantCI = /congr.s.*inter|international/.test(k);
  const wantCN = /congr.s.*nation|national/.test(k) && !wantCI;
  const hits: MissionParent[] = [];
  if (wantEvent || !k) {
    for (const e of await prisma.event.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "EVENT", entityId: e.id, label: `${e.name} (événement)` });
    }
  }
  if (wantSpo || !k) {
    for (const s of await prisma.sponsoringRequest.findMany({ where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }] }, select: { id: true, reference: true, institution: true }, take: 4 })) {
      hits.push({ entityType: "SPONSORING", entityId: s.id, label: `${s.reference} — ${s.institution} (sponsoring)` });
    }
  }
  if (wantCI || !k) {
    for (const c of await prisma.congressInternational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "CONGRESS_INTERNATIONAL", entityId: c.id, label: `${c.name} (congrès international)` });
    }
  }
  if (wantCN || !k) {
    for (const c of await prisma.congressNational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "CONGRESS_NATIONAL", entityId: c.id, label: `${c.name} (congrès national)` });
    }
  }
  if (hits.length === 0) return { error: `Aucun événement / congrès / sponsoring « ${q} ».` };
  if (hits.length > 1) return { error: `Plusieurs cibles possibles : ${hits.slice(0, 6).map((h) => h.label).join(" ; ")} — préciser (champ « kind » : événement | sponsoring | congrès international | congrès national).` };
  return hits[0];
}

interface MissionHit { assignmentId: string; parent: MissionParent; personName: string }

async function resolveMissionAssignment(input: Record<string, unknown>): Promise<MissionHit | { error: string }> {
  const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
  if ("error" in parent) return parent;
  const person = await resolvePerson(opStr(input, "person"));
  if ("error" in person) return person;
  const a = await prisma.missionAssignment.findFirst({
    where: { entityType: parent.entityType as never, entityId: parent.entityId, userId: person.id },
    select: { id: true },
  });
  if (!a) return { error: `${person.name} n'est pas assigné·e sur ${parent.label}.` };
  return { assignmentId: a.id, parent, personName: person.name };
}

// ─────────────── Information médicale ───────────────

const MEDINFO_STATUS_FR: Record<string, string> = {
  AWAITING_REVIEW: "En attente de revue", DOCS_REQUESTED: "Pièces demandées", READY: "Prête",
  AWAITING_DIRECTION: "En attente du Directeur des Opérations", VALIDATED: "Validée",
};

async function resolveDeclaration(raw: string, statuses?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence ou le libellé de la déclaration (champ « reference »)." } as const;
  const rows = await prisma.medicalInfoDeclaration.findMany({
    where: {
      ...(statuses ? { status: { in: statuses as never } } : {}),
      OR: [{ reference: { equals: q, mode: "insensitive" } }, { label: { contains: q, mode: "insensitive" } }, { beneficiary: { contains: q, mode: "insensitive" } }],
    },
    select: { id: true, reference: true, label: true, beneficiary: true, status: true, amount: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune déclaration « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs déclarations correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.label} (${MEDINFO_STATUS_FR[r.status] ?? r.status})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/**
 * UN MATÉRIEL DANS UN DOSSIER — le bon de versement se demande MATÉRIEL PAR MATÉRIEL.
 *
 * Une cible ambiguë rend des CANDIDATS, jamais « le premier des quatre » : faire payer la
 * quittance du mauvais matériel en annonçant que c'est fait est le défaut le plus coûteux de tout
 * ce circuit.
 */
async function resolveSlip(declarationId: string, raw: string) {
  const rows = await prisma.medicalInfoSlip.findMany({
    where: { declarationId },
    select: { id: true, label: true, amount: true, requestId: true, deliveredAt: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  if (rows.length === 0) return { error: "Ce dossier n'a encore aucun matériel : séparez-le d'abord en matériels." } as const;
  const q = raw.trim().toLowerCase();
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Ce dossier porte ${rows.length} matériels : ${rows.map((r) => r.label).join(" ; ")} — préciser lequel (champ « material »).` } as const;
  }
  const hits = rows.filter((r) => r.label.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucun matériel « ${raw} » dans ce dossier : ${rows.map((r) => r.label).join(" ; ")}.` } as const;
  return { error: `Plusieurs matériels correspondent à « ${raw} » : ${hits.map((r) => r.label).join(" ; ")} — préciser.` } as const;
}

export const RECRUIT_TRAINING_OPS_IMPL: Record<string, OpImpl> = {
  // ── Recrutement ──

  create_recruitment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const position = opStr(input, "position") || opStr(input, "label");
      if (!position) return { error: "Précisez le poste à recruter (champ « position »)." };
      const contract = opStr(input, "contractType").toUpperCase();
      if (!["CDI", "CDD", "INTERIM", "STAGE", "FREELANCE", "CONSULTING"].includes(contract)) {
        return { error: "Précisez le contrat (champ « contractType ») : CDI, CDD, INTERIM, STAGE, FREELANCE ou CONSULTING." };
      }
      let departmentId: string | null = null; let deptName: string | null = null;
      if (opStr(input, "department")) {
        const dept = await resolveDeptLocal(opStr(input, "department"));
        if ("error" in dept) return dept;
        departmentId = dept.id; deptName = dept.name;
      }
      const headcount = num(input, "headcount") ?? 1;
      return {
        title: `Demande de recrutement — ${position} (${contract}${headcount > 1 ? ` × ${headcount}` : ""})`,
        fields: fieldsOf([
          ["Poste", position], ["Contrat", contract], ["Effectif", headcount > 1 ? String(headcount) : null],
          ["Département", deptName],
          ["Fourchette", num(input, "salaryMin") !== null || num(input, "salaryMax") !== null
            ? `${num(input, "salaryMin") !== null ? dzd(num(input, "salaryMin")!) : "—"} → ${num(input, "salaryMax") !== null ? dzd(num(input, "salaryMax")!) : "—"}` : null],
          ["Début souhaité", isoDate(opStr(input, "startDate"))],
          ["Justification", opStr(input, "reason") || null],
        ]),
        warnings: ["La demande entre dans la chaîne hiérarchique (N+1 → … → DG) calculée depuis l'organigramme — sans chaîne renseignée, l'action refusera en le disant."],
        args: {
          position, contractType: contract, headcount: String(Math.max(1, Math.floor(headcount))),
          salaryMin: num(input, "salaryMin") !== null ? String(num(input, "salaryMin")) : null,
          salaryMax: num(input, "salaryMax") !== null ? String(num(input, "salaryMax")) : null,
          startDate: isoDate(opStr(input, "startDate")), endDate: isoDate(opStr(input, "endDate")),
          departmentId, missions: opStr(input, "missions") || null, skills: opStr(input, "skills") || null,
          justification: opStr(input, "reason") || null,
        },
        successMessage: `Demande de recrutement « ${position} » déposée — la chaîne de validation est notifiée.`,
        link: "/recrutement", revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd2(createRecruitmentRequest, args, "La demande de recrutement a été refusée.", { link: "/recrutement", revalidate: ["/recrutement"] }),
  },

  cancel_recruitment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"));
      if ("error" in req) return req;
      return {
        title: `Annuler la demande de recrutement ${req.reference} (${req.position})`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.position} · ${REC_STAGE_FR[req.stage] ?? req.stage}` }],
        warnings: ["La demande est close sans suite ; les validateurs en cours sont prévenus."],
        args: { id: req.id },
        successMessage: `Demande ${req.reference} annulée.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(cancelRecruitmentRequest, args, "L'annulation a été refusée.", { revalidate: ["/recrutement"] }),
  },

  ask_recruitment_info: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"));
      if ("error" in req) return req;
      const question = opStr(input, "question") || opStr(input, "note");
      if (!question) return { error: "Écrivez la question (champ « question ») — le demandeur devra y répondre." };
      return {
        title: `Demander une précision — ${req.reference} (${req.position})`,
        fields: [
          { label: "Demande", value: `${req.reference} — ${req.position}` },
          { label: "Question", value: question },
        ],
        warnings: ["La demande passe « Informations demandées » : elle attend la réponse du demandeur."],
        args: { id: req.id, question },
        successMessage: `Question posée sur ${req.reference}.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(askRecruitmentInfo, args, "La question a été refusée.", { revalidate: ["/recrutement"] }),
  },

  answer_recruitment_info: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"), ["INFO_REQUESTED"]);
      if ("error" in req) return req;
      const answer = opStr(input, "answer") || opStr(input, "note");
      if (!answer) return { error: "Écrivez la réponse (champ « answer »)." };
      const open = await prisma.recruitmentInfoRequest.findFirst({
        where: { requestId: req.id, answer: null }, orderBy: { createdAt: "desc" },
        select: { id: true, question: true },
      });
      if (!open) return { error: `Aucune question ouverte sur ${req.reference}.` };
      return {
        title: `Répondre à la question — ${req.reference}`,
        fields: [
          { label: "Question", value: open.question },
          { label: "Réponse", value: answer },
        ],
        args: { id: req.id, infoId: open.id, answer },
        successMessage: `Réponse envoyée sur ${req.reference} — la validation reprend.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(answerRecruitmentInfo, args, "La réponse a été refusée.", { revalidate: ["/recrutement"] }),
  },

  open_recruitment_sourcing: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"), ["HR_REVIEW"]);
      if ("error" in req) return req;
      return {
        title: `Ouvrir le sourcing — ${req.reference} (${req.position})`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.position}` }],
        warnings: ["Geste RH : la demande validée passe en recherche de candidatures."],
        args: { id: req.id },
        successMessage: `Sourcing ouvert sur ${req.reference}.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(openRecruitmentSourcing, args, "L'ouverture du sourcing a été refusée.", { revalidate: ["/recrutement"] }),
  },

  close_recruitment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"));
      if ("error" in req) return req;
      const reject = /refus|rejet|sans suite/i.test(opStr(input, "decision"));
      // Le motif est exigé par l'action (§118.192) : la carte ne propose pas une clôture que l'exécution refuserait.
      if (!opStr(input, "note")) return { error: "Une clôture se motive : dites pourquoi la demande se clôt (c'est ce que lira le demandeur)." };
      return {
        title: `${reject ? "Clore SANS SUITE" : "Clore"} la demande ${req.reference} (${req.position})`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.position}`],
          ["Issue", reject ? "Refusée / sans suite" : "Clôturée"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: req.id, note: opStr(input, "note") || null, decision: reject ? "REJECTED" : null },
        successMessage: `Demande ${req.reference} close.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(closeRecruitmentRequest, args, "La clôture a été refusée.", { revalidate: ["/recrutement"] }),
  },

  add_recruitment_candidate: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"), ["SOURCING", "ONBOARDING"]);
      if ("error" in req) return req;
      const fullName = opStr(input, "name") || opStr(input, "candidate");
      if (!fullName) return { error: "Précisez le nom du candidat (champ « name »)." };
      return {
        title: `Ajouter la candidature de ${fullName} — ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.position}`],
          ["Candidat", fullName], ["E-mail", opStr(input, "email") || null], ["Téléphone", opStr(input, "phone") || null],
        ]),
        args: { requestId: req.id, fullName, email: opStr(input, "email") || null, phone: opStr(input, "phone") || null },
        successMessage: `Candidature de ${fullName} ajoutée sur ${req.reference}.`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd2(addRecruitmentCandidate, args, "L'ajout du candidat a été refusé.", { revalidate: ["/recrutement"] }),
  },

  move_recruitment_candidate: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"));
      if ("error" in req) return req;
      const candRaw = opStr(input, "candidate") || opStr(input, "name");
      if (!candRaw) return { error: "Précisez le candidat (champ « candidate »)." };
      const cands = await prisma.recruitmentCandidate.findMany({
        where: { requestId: req.id, fullName: { contains: candRaw, mode: "insensitive" } },
        select: { id: true, fullName: true, status: true }, take: 6,
      });
      if (cands.length === 0) return { error: `Aucun candidat « ${candRaw} » sur ${req.reference}.` };
      if (cands.length > 1) return { error: `Plusieurs candidats correspondent : ${cands.map((c) => c.fullName).join(", ")} — préciser.` };
      const mv = CAND_MOVES.find(([re, code]) => re.test(opStr(input, "decision")) || opStr(input, "decision").toUpperCase() === code);
      if (!mv) return { error: "Précisez le geste (champ « decision ») : présélectionner | retirer de la présélection | choisir | entretien | recruter | écarter." };
      const [, move, label] = mv;
      return {
        title: `${label} — ${cands[0].fullName} (${req.reference})`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.position}`],
          ["Candidat", `${cands[0].fullName} (${CAND_STATUS_FR[cands[0].status] ?? cands[0].status})`],
          ["Geste", label],
          ["Entretien le", move === "INTERVIEW" ? (isoDate(opStr(input, "date")) ?? "aujourd'hui") : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: move === "HIRE"
          ? ["RECRUTER fait basculer la demande en INTÉGRATION — les RH sont notifiées pour préparer la fiche employé."]
          : move === "SELECT" ? ["Le choix final appartient à la direction générale — l'action refusera sinon."] : [],
        args: {
          candidateId: cands[0].id, move,
          interviewAt: move === "INTERVIEW" ? isoDate(opStr(input, "date")) : null,
          interviewNote: move === "INTERVIEW" ? (opStr(input, "note") || null) : null,
        },
        successMessage: `${cands[0].fullName} : ${label.toLowerCase()} (${req.reference}).`,
        revalidate: ["/recrutement"],
      };
    },
    execute: (args) => runFd(moveRecruitmentCandidate, args, "Le geste sur le candidat a été refusé.", { revalidate: ["/recrutement"] }),
  },

  onboard_recruitment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveRecruitment(opStr(input, "reference") || opStr(input, "position"), ["ONBOARDING"]);
      if ("error" in req) return req;
      const hired = await prisma.recruitmentCandidate.findFirst({
        where: { requestId: req.id, status: "HIRED" }, select: { fullName: true, employeeId: true },
      });
      if (!hired) return { error: `Aucun candidat recruté sur ${req.reference} — recruter d'abord.` };
      if (hired.employeeId) return { error: `La fiche employé de ${hired.fullName} existe déjà.` };
      return {
        title: `Intégrer ${hired.fullName} — ${req.reference}`,
        fields: [
          { label: "Demande", value: `${req.reference} — ${req.position}` },
          { label: "Recruté·e", value: hired.fullName },
        ],
        warnings: ["La FICHE EMPLOYÉ est créée au registre RH (un consulting externe est simplement clos, hors effectif et hors paie)."],
        args: { id: req.id },
        successMessage: `${hired.fullName} intégré·e — ${req.reference}.`,
        link: "/rh", revalidate: ["/recrutement", "/rh"],
      };
    },
    execute: (args) => runFd(onboardRecruitment, args, "L'intégration a été refusée.", { revalidate: ["/recrutement", "/rh"] }),
  },

  // ── Formations ──

  request_training: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "title");
      if (!title) return { error: "Précisez l'intitulé de la formation (champ « label »)." };
      const amount = num(input, "amount");
      return {
        title: `Demande de formation — ${title}${amount !== null ? ` (${dzd(amount)})` : ""}`,
        fields: fieldsOf([
          ["Formation", title], ["Organisme", opStr(input, "provider") || null],
          ["Coût annoncé", amount !== null ? dzd(amount) : null],
          ["Du", isoDate(opStr(input, "startDate"))], ["Au", isoDate(opStr(input, "endDate"))],
          ["Lieu", opStr(input, "location") || null],
        ]),
        warnings: ["La demande suit le circuit N+1 → RH → DG ; le montant réellement accordé peut différer du demandé."],
        args: {
          title, amount: amount !== null ? String(amount) : null, provider: opStr(input, "provider") || null,
          description: opStr(input, "description") || null, startDate: isoDate(opStr(input, "startDate")),
          endDate: isoDate(opStr(input, "endDate")), location: opStr(input, "location") || null,
        },
        successMessage: `Demande de formation « ${title} » déposée.`,
        revalidate: ["/rh/formations", "/mon-espace"],
      };
    },
    execute: (args) => runFd2(requestTraining, args, "La demande de formation a été refusée.", { revalidate: ["/rh/formations", "/mon-espace"] }),
  },

  create_hr_training: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "title");
      if (!title) return { error: "Précisez l'intitulé de la formation (champ « label »)." };
      const amount = num(input, "amount");
      let departmentId: string | null = null; let deptName: string | null = null;
      if (opStr(input, "department")) {
        const dept = await resolveDeptLocal(opStr(input, "department"));
        if ("error" in dept) return dept;
        departmentId = dept.id; deptName = dept.name;
      }
      return {
        title: `Formation organisée par les RH — ${title}`,
        fields: fieldsOf([
          ["Formation", title], ["Organisme", opStr(input, "provider") || null],
          ["Département", deptName], ["Coût", amount !== null ? dzd(amount) : null],
          ["Du", isoDate(opStr(input, "startDate"))], ["Au", isoDate(opStr(input, "endDate"))],
        ]),
        warnings: ["Une formation RH n'a pas de N+1 à consulter : elle entre directement à l'étape Direction. Les invitations partent ensuite."],
        args: {
          title, amount: amount !== null ? String(amount) : null, provider: opStr(input, "provider") || null,
          description: opStr(input, "description") || null, startDate: isoDate(opStr(input, "startDate")),
          endDate: isoDate(opStr(input, "endDate")), location: opStr(input, "location") || null, departmentId,
        },
        successMessage: `Formation « ${title} » créée (organisée par les RH).`,
        revalidate: ["/rh/formations"],
      };
    },
    execute: (args) => runFd2(createHrTraining, args, "La création de la formation a été refusée.", { revalidate: ["/rh/formations"] }),
  },

  update_training: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const training = await resolveTraining(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in training) return training;
      const changes = fieldsOf([
        ["Intitulé", opStr(input, "newLabel") || null],
        ["Organisme", opStr(input, "provider") || null],
        ["Lieu", opStr(input, "location") || null],
        ["Du", isoDate(opStr(input, "startDate"))], ["Au", isoDate(opStr(input, "endDate"))],
        ["Coût", num(input, "amount") !== null ? dzd(num(input, "amount")!) : null],
      ]);
      if (changes.length === 0) return { error: "Précisez ce qui change : intitulé (« newLabel »), organisme, lieu, dates ou coût." };
      return {
        title: `Corriger la formation ${training.reference} (${changes.length} champ·s)`,
        fields: [{ label: "Formation", value: `${training.reference} — ${training.title}` }, ...changes],
        warnings: ["PATCH natif : seuls les champs cités changent — l'action ne touche pas au reste."],
        args: {
          id: training.id, title: opStr(input, "newLabel") || null, provider: opStr(input, "provider") || null,
          location: opStr(input, "location") || null, startDate: isoDate(opStr(input, "startDate")),
          endDate: isoDate(opStr(input, "endDate")), amount: num(input, "amount") !== null ? String(num(input, "amount")) : null,
        },
        successMessage: `Formation ${training.reference} corrigée.`,
        revalidate: ["/rh/formations"],
      };
    },
    execute: (args) => runFd(updateTraining, args, "La correction de la formation a été refusée.", { revalidate: ["/rh/formations"] }),
  },

  invite_training_participants: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const training = await resolveTraining(opStr(input, "reference") || opStr(input, "label"), ["PENDING", "APPROVED"]);
      if ("error" in training) return training;
      const peopleRaw = opStr(input, "people");
      if (!peopleRaw) return { error: "Précisez les personnes à convier (champ « people », noms séparés par des virgules)." };
      const names: string[] = []; const ids: string[] = [];
      for (const part of peopleRaw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const person = await resolvePerson(part);
        if ("error" in person) return person;
        ids.push(person.id); names.push(person.name);
      }
      const mandatory = /convoqu|obligatoire|mandatory/i.test(opStr(input, "mode"));
      return {
        title: `${mandatory ? "Convoquer" : "Inviter"} ${names.length} personne·s — ${training.title}`,
        fields: [
          { label: "Formation", value: `${training.reference} — ${training.title}` },
          { label: mandatory ? "Convoqués (présence requise)" : "Invités (ils répondent)", value: names.join(", ") },
        ],
        args: { trainingId: training.id, attendance: mandatory ? "MANDATORY" : "VOLUNTARY", userIds: ids.join(",") },
        successMessage: `${names.length} personne·s ${mandatory ? "convoquée·s" : "invitée·s"} à « ${training.title} ».`,
        revalidate: ["/rh/formations"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("trainingId", args.trainingId ?? "");
      if (args.attendance) fd.set("attendance", args.attendance);
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("userIds", id);
      const r = await inviteTrainingParticipants(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Les invitations ont été refusées." };
      return { ok: true, revalidate: ["/rh/formations"] };
    },
  },

  respond_training_invitation: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const training = await resolveTraining(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in training) return training;
      const invitation = await prisma.trainingParticipant.findFirst({
        where: { trainingId: training.id, userId: user.id },
        select: { id: true, state: true, attendance: true },
      });
      if (!invitation) return { error: `Vous n'êtes pas invité·e à « ${training.title} ».` };
      if (invitation.attendance === "MANDATORY") return { error: "Vous êtes CONVOQUÉ·E à cette formation — la présence n'est pas une option, il n'y a rien à répondre." };
      const decline = /d[ée]clin|refus|non|absent/i.test(opStr(input, "decision"));
      return {
        title: `${decline ? "Décliner" : "Accepter"} l'invitation — ${training.title}`,
        fields: fieldsOf([
          ["Formation", `${training.reference} — ${training.title}`],
          ["Réponse", decline ? "Décliner" : "Accepter"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: invitation.id, answer: decline ? "DECLINED" : "ACCEPTED", note: opStr(input, "note") || null },
        successMessage: `Invitation à « ${training.title} » ${decline ? "déclinée" : "acceptée"}.`,
        revalidate: ["/rh/formations", "/mon-espace"],
      };
    },
    execute: (args) => runFd(respondToTrainingInvitation, args, "La réponse a été refusée.", { revalidate: ["/rh/formations", "/mon-espace"] }),
  },
};

export const MISSION_OPS_IMPL: Record<string, OpImpl> = {
  assign_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in parent) return parent;
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      const reference = /r[ée]f[ée]rence|d[ée]l[ée]gu[ée]/i.test(opStr(input, "role"));
      return {
        title: `Assigner ${person.name} ${reference ? "comme délégué de référence" : "comme accompagnant"} — ${parent.label}`,
        fields: fieldsOf([
          ["Sur", parent.label], ["Personne", person.name],
          ["Rôle", reference ? "Délégué de référence" : "Accompagnant"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { entityType: parent.entityType, entityId: parent.entityId, userId: person.id, role: reference ? "DELEGATE_REFERENCE" : "ACCOMPAGNANT", note: opStr(input, "note") || null },
        successMessage: `${person.name} assigné·e sur ${parent.label}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(assignMission, args, "L'assignation a été refusée.", { revalidate: ["/missions"] }),
  },

  remove_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Retirer ${hit.personName} — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        args: { id: hit.assignmentId },
        successMessage: `${hit.personName} retiré·e de ${hit.parent.label}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(removeMission, args, "Le retrait a été refusé.", { revalidate: ["/missions"] }),
  },

  request_mission_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Demander l'ordre de mission — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        warnings: ["Seule la personne assignée demande SON ordre de mission — l'action refusera sinon."],
        args: { id: hit.assignmentId },
        successMessage: `Ordre de mission demandé (${hit.parent.label}).`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(requestMissionOrder, args, "La demande d'ordre de mission a été refusée.", { revalidate: ["/missions"] }),
  },

  issue_mission_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Émettre l'ordre de mission de ${hit.personName} — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        warnings: ["Réservé aux responsables de l'entité (événement / congrès / sponsoring) — la personne assignée est notifiée."],
        args: { id: hit.assignmentId },
        successMessage: `Ordre de mission émis pour ${hit.personName}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(issueMissionOrder, args, "L'émission de l'ordre a été refusée.", { revalidate: ["/missions"] }),
  },

  comment_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la mission de ${hit.personName} — ${hit.parent.label}`,
        fields: [
          { label: "Mission", value: `${hit.personName} sur ${hit.parent.label}` },
          { label: "Message", value: body },
        ],
        args: { assignmentId: hit.assignmentId, body },
        successMessage: `Message posté sur la mission de ${hit.personName}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(addMissionComment, args, "Le message a été refusé.", { revalidate: ["/missions"] }),
  },
};

export const DOCREQ_OPS_IMPL: Record<string, OpImpl> = {
  request_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      const label = opStr(input, "label");
      if (!label) return { error: "Précisez la pièce demandée (champ « label » — ex. « Devis signé », « Facture originale »)." };
      // L'action canonique EXIGE l'entité de rattachement : une pièce se demande toujours
      // SUR quelque chose (événement, congrès, sponsoring) — jamais dans le vide.
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in parent) return parent;
      const entityType = parent.entityType; const entityId = parent.entityId; const parentLabel = parent.label;
      return {
        title: `Demander « ${label} » à ${person.name}`,
        fields: fieldsOf([
          ["Pièce", label], ["À", person.name], ["Rattachée à", parentLabel],
          ["Échéance", isoDate(opStr(input, "dueDate"))], ["Note", opStr(input, "note") || null],
        ]),
        args: {
          askedToId: person.id, label, entityType, entityId,
          dueDate: isoDate(opStr(input, "dueDate")), note: opStr(input, "note") || null,
        },
        successMessage: `Pièce « ${label} » demandée à ${person.name}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(requestEntityDocument, args, "La demande de pièce a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  submit_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedToId: user.id, status: "PENDING", ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, reference: true, label: true, askedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de pièce EN ATTENTE qui vous est adressée${opStr(input, "label") ? ` (« ${opStr(input, "label")} »)` : ""}.` };
      if (rows.length > 1) return { error: `Plusieurs demandes en attente : ${rows.map((r) => `${r.label} (par ${r.askedBy?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      return {
        title: `Marquer « ${rows[0].label} » comme transmise`,
        fields: fieldsOf([
          ["Pièce", rows[0].label], ["Demandée par", rows[0].askedBy?.name ?? null],
          ["Note de réponse", opStr(input, "note") || null],
        ]),
        warnings: ["Le demandeur tranchera : pièce acceptée ou refusée."],
        args: { id: rows[0].id, note: opStr(input, "note") || null },
        successMessage: `Pièce « ${rows[0].label} » marquée transmise.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(submitDocumentRequest, args, "La transmission a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  decide_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedById: user.id, status: "SUBMITTED", ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true, askedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: "Aucune pièce TRANSMISE en attente de votre décision." };
      if (rows.length > 1) return { error: `Plusieurs pièces transmises : ${rows.map((r) => `${r.label} (par ${r.askedTo?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      const reject = /refus|rejet|non/i.test(opStr(input, "decision"));
      return {
        title: `${reject ? "Refuser" : "Accepter"} la pièce « ${rows[0].label} »`,
        fields: fieldsOf([
          ["Pièce", rows[0].label], ["Transmise par", rows[0].askedTo?.name ?? null],
          ["Décision", reject ? "Refusée (à reprendre)" : "Acceptée"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: rows[0].id, accept: reject ? "0" : "1", note: opStr(input, "note") || null },
        successMessage: `Pièce « ${rows[0].label} » ${reject ? "refusée" : "acceptée"}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(decideDocumentRequest, args, "La décision a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  cancel_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedById: user.id, status: { in: ["PENDING", "SUBMITTED"] }, ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true, askedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: "Aucune demande de pièce en cours de votre part." };
      if (rows.length > 1) return { error: `Plusieurs demandes en cours : ${rows.map((r) => `${r.label} (à ${r.askedTo?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      return {
        title: `Annuler la demande « ${rows[0].label} »`,
        fields: [{ label: "Pièce", value: `${rows[0].label} — demandée à ${rows[0].askedTo?.name ?? "—"}` }],
        args: { id: rows[0].id },
        successMessage: `Demande « ${rows[0].label} » annulée.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(cancelDocumentRequest, args, "L'annulation a été refusée.", { revalidate: ["/mon-espace"] }),
  },
};

export const MEDINFO_OPS_IMPL: Record<string, OpImpl> = {
  request_declaration_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const label = opStr(input, "piece") || opStr(input, "label");
      if (!label) return { error: "Précisez la pièce demandée (champ « piece »)." };
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      return {
        title: `Demander « ${label} » sur la déclaration ${decl.reference}`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          { label: "Pièce", value: label },
          { label: "À", value: person.name },
        ],
        warnings: ["La déclaration passe « Pièces demandées » jusqu'à réception."],
        args: { declarationId: decl.id, label, targetUserId: person.id },
        successMessage: `Pièce « ${label} » demandée à ${person.name} (${decl.reference}).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(requestMedicalDoc, args, "La demande de pièce a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  cancel_declaration_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const open = await prisma.medicalInfoDocRequest.findMany({
        where: { declarationId: decl.id, status: "PENDING", ...(opStr(input, "piece") ? { label: { contains: opStr(input, "piece"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true }, take: 6,
      });
      if (open.length === 0) return { error: `Aucune demande de pièce EN ATTENTE sur ${decl.reference}.` };
      if (open.length > 1) return { error: `Plusieurs pièces en attente : ${open.map((o) => o.label).join(", ")} — préciser (champ « piece »).` };
      return {
        title: `Annuler la demande de pièce « ${open[0].label} » (${decl.reference})`,
        fields: [{ label: "Pièce", value: `${open[0].label} — ${decl.reference}` }],
        args: { id: open[0].id },
        successMessage: `Demande de pièce « ${open[0].label} » annulée.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(cancelDocRequest, args, "L'annulation a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  // ─────── CIRCUIT ÉVÉNEMENT — « faut-il déclarer ? », sans aucun versement ───────

  declare_decision: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const brut = (opStr(input, "intent") || "").toLowerCase();
      const intent = /^(skip|non|sans|pas)/.test(brut) ? "SKIP" : /^(declare|déclare|oui)/.test(brut) ? "DECLARE" : null;
      if (!intent) return { error: "Dites ce qui est soumis : « declare » (à déclarer au ministère) ou « skip » (sans déclaration) — champ « intent »." };
      const note = opStr(input, "note");
      if (intent === "SKIP" && !note) {
        return { error: "Une lecture « sans déclaration » exige un motif (champ « note ») : c'est ce que lira le validateur, puis l'audit." };
      }
      return {
        title: `${intent === "DECLARE" ? "À déclarer au ministère" : "Sans déclaration"} — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Lecture soumise", intent === "DECLARE" ? "À déclarer au ministère" : "Sans déclaration"],
          ["Motif / note", note || null],
        ]),
        warnings: [
          "Ce dossier n'appelle AUCUN bon de versement : c'est le circuit des événements et prises en charge.",
          "Ce qu'on fait valider est la LECTURE du pharmacien, pas la question — le responsable, la Direction Marketing, puis le centre de validations.",
        ],
        args: { id: decl.id, intent, note: note || null },
        successMessage: `Lecture soumise à validation pour ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
      };
    },
    execute: (args) => runFd2(requestDeclareDecision, args, "La demande de décision a été refusée.", {
      revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
    }),
  },

  // ─────── CIRCUIT MATÉRIEL — un bon de versement par matériel ───────

  add_slip: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const label = opStr(input, "material") || opStr(input, "title");
      if (!label) return { error: "Nommez le matériel concerné par ce bon (champ « material »)." };
      const raw = opStr(input, "amount");
      const montant = raw ? Number(raw.replace(",", ".").replace(/\s/g, "")) : null;
      if (raw && (!Number.isFinite(montant) || (montant ?? 0) < 0)) return { error: "Montant du bon invalide." };
      return {
        title: `Ajouter un matériel — ${label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", label],
          ["Montant annoncé", montant ? dzd(montant) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["Un bon de versement PAR MATÉRIEL : la liste se fige dès que son dépôt part en validation."],
        args: { declarationId: decl.id, label, amount: montant ? String(montant) : null, note: opStr(input, "note") || null },
        successMessage: `Matériel « ${label} » ajouté à ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd2(addMedicalInfoSlip, args, "L'ajout du matériel a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  remove_slip: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      return {
        title: `Retirer le matériel « ${slip.label} » — ${decl.reference}`,
        fields: fieldsOf([["Déclaration", `${decl.reference} — ${decl.label}`], ["Matériel", slip.label]]),
        warnings: ["Impossible une fois le dépôt soumis à validation : la signature porterait sur autre chose que ce qui existe."],
        args: { slipId: slip.id },
        successMessage: `Matériel « ${slip.label} » retiré de ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(removeMedicalInfoSlip, args, "Le retrait du matériel a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  request_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slips = await prisma.medicalInfoSlip.findMany({
        where: { declarationId: decl.id }, select: { label: true, amount: true },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      if (slips.length === 0) {
        return { error: "Ce dossier n'a encore aucun matériel : séparez-le d'abord (op « add_slip »). Faire signer une liste vide, c'est faire signer une intention." };
      }
      const total = slips.reduce((a, sl) => a + (sl.amount ? Number(sl.amount) : 0), 0);
      return {
        title: `Faire valider le dépôt de ${slips.length} bon(s) — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériels", slips.map((sl) => sl.label).join(" · ")],
          ["Total annoncé", total > 0 ? dzd(total) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: [
          "AUCUN ARGENT N'EST ENGAGÉ ICI : le dépôt part en VALIDATION — le responsable du pharmacien, le référent Direction Marketing du dossier, puis le centre de validations.",
          "Une seule validation pour le LOT ; le paiement de chaque quittance se demande ensuite SÉPARÉMENT.",
          "La liste des matériels est FIGÉE à partir de cet envoi.",
        ],
        args: { id: decl.id, note: opStr(input, "note") || null },
        successMessage: `Dépôt de ${slips.length} bon(s) soumis à validation pour ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
      };
    },
    execute: (args) => runFd2(requestSlipsValidation, args, "La demande de validation a été refusée.", {
      revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
    }),
  },

  /**
   * LE SECOND TEMPS — la quittance, BON PAR BON. Elle ne peut être demandée qu'une fois le dépôt
   * accordé, et l'action le REVÉRIFIE : ce n'est pas à l'aperçu de garder cette garde.
   */
  request_quittance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      const montant = Number(opStr(input, "amount") ?? "");
      if (!Number.isFinite(montant) || montant <= 0) return { error: "Indiquez le montant de la quittance (champ « amount »)." };
      return {
        title: `Demander le paiement de la quittance — ${slip.label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", slip.label],
          ["Montant de la quittance", dzd(montant)],
          ["Bon annoncé", slip.amount ? dzd(Number(slip.amount)) : null],
          ["Bénéficiaire", opStr(input, "person") || "Autorités sanitaires"],
          ["Échéance demandée", isoDate(opStr(input, "date")) || null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: [
          "Le dépôt des bons doit être ACCORDÉ : sans cela, l'action refuse.",
          "La demande part au CENTRE DE PAIEMENT ; les Finances ne la voient qu'une fois autorisée.",
          "Les pièces se joignent à l'écran : une demande de paiement se justifie par un document, pas par une phrase.",
        ],
        args: {
          slipId: slip.id, amount: String(montant),
          payee: opStr(input, "person") || "Autorités sanitaires",
          dueDate: isoDate(opStr(input, "date")) || null,
          note: opStr(input, "note") || null,
        },
        successMessage: `Quittance de ${dzd(montant)} demandée au paiement pour « ${slip.label} » — au centre de paiement.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations/paiements"],
      };
    },
    execute: (args) => runFd2(requestSlipPayment, args, "La demande de paiement a été refusée.", {
      revalidate: ["/information-medicale", "/validations/paiements"],
    }),
  },

  deliver_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      return {
        title: `Quittance remise au bureau du PRIM — ${slip.label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", slip.label],
          ["Note de remise", opStr(input, "note") || null],
        ]),
        warnings: ["C'est cette remise — et non le règlement — qui fait avancer le dossier ; la déclaration s'ouvre quand TOUTES les quittances sont remises."],
        args: { slipId: slip.id, note: opStr(input, "note") || null },
        successMessage: `Quittance de « ${slip.label} » remise au bureau du PRIM.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(deliverMedicalInfoSlip, args, "La remise de la quittance a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  skip_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const motif = opStr(input, "note");
      if (!motif) return { error: "Dites POURQUOI ce dossier n'appelle aucun versement (champ « note ») : c'est ce que lira l'audit." };
      return {
        title: `Déclarer ${decl.reference} sans bon de versement`,
        fields: fieldsOf([["Déclaration", `${decl.reference} — ${decl.label}`], ["Motif", motif]]),
        warnings: [
          "Réservé au MATÉRIEL PROMOTIONNEL : les événements et prises en charge n'appellent aucun versement, et n'ont donc rien à contourner.",
          "Ouvre la déclaration aux autorités sans versement — le motif est versé au journal.",
        ],
        args: { id: decl.id, reason: motif },
        successMessage: `${decl.reference} déclarée sans versement — la déclaration aux autorités est ouverte.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(skipMedicalInfoBv, args, "La déclaration « sans versement » a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  // ─────── CE QUE LE PRIM OUVRE LUI-MÊME ───────

  create_medical_info_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label") || opStr(input, "title");
      if (!label) return { error: "Nommez ce qui est ouvert (champ « label »)." };
      const brut = (opStr(input, "kind") || "").toLowerCase();
      const kind = /visa/.test(brut) ? "AD_VISA"
        : /(bon|versement|bv|slip)/.test(brut) ? "PAYMENT_SLIP"
        : /(mip|minist|décl|decl)/.test(brut) ? "MIP"
        : null;
      if (!kind) return { error: "Choisissez la nature (champ « kind ») : « mip » (déclaration au ministère), « visa » (visa publicitaire) ou « bon de versement »." };
      const raw = opStr(input, "amount");
      const montant = raw ? Number(raw.replace(",", ".").replace(/\s/g, "")) : null;
      if (raw && (!Number.isFinite(montant) || (montant ?? 0) < 0)) return { error: "Montant invalide." };
      const NATURE: Record<string, string> = {
        MIP: "Déclaration au ministère (MIP)", AD_VISA: "Demande de visa publicitaire", PAYMENT_SLIP: "Bon de versement",
      };
      return {
        title: `Ouvrir — ${NATURE[kind]} : ${label}`,
        fields: fieldsOf([
          ["Objet", label], ["Nature", NATURE[kind]],
          ["Bénéficiaire", opStr(input, "person") || null],
          ["Montant", montant ? dzd(montant) : null],
        ]),
        warnings: [
          kind === "MIP"
            ? "Circuit ÉVÉNEMENT : la décision de déclarer se fait valider, puis le dépôt au ministère."
            : "Circuit MATÉRIEL : le dossier se sépare en matériels, un bon de versement par matériel.",
        ],
        args: { label, kind, beneficiary: opStr(input, "person") || null, amount: montant ? String(montant) : null },
        successMessage: `${NATURE[kind]} ouverte — ${label}.`,
        link: "/information-medicale",
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd2(createMedicalInfoItem, args, "L'ouverture du dossier a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  record_authority_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const authorityRef = opStr(input, "authorityRef") || opStr(input, "note");
      if (!authorityRef) return { error: "Précisez la référence donnée par l'autorité (champ « authorityRef »)." };
      return {
        title: `Consigner la déclaration à l'autorité — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Référence autorité", authorityRef],
          ["Notes", opStr(input, "notes") || null],
        ]),
        args: { id: decl.id, authorityRef, authorityNotes: opStr(input, "notes") || null },
        successMessage: `Référence autorité consignée sur ${decl.reference}.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(recordAuthorityDeclaration, args, "L'enregistrement a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  validate_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"), ["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"]);
      if ("error" in decl) return decl;
      return {
        title: `Valider la déclaration ${decl.reference} (pharmacien)`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          ...(decl.amount !== null ? [{ label: "Montant", value: dzd(toNumber(decl.amount)) }] : []),
        ],
        warnings: ["Validation PHARMACIEN : la déclaration monte ensuite au Directeur des Opérations."],
        args: { id: decl.id },
        successMessage: `Déclaration ${decl.reference} validée (pharmacien).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(validateDeclaration, args, "La validation a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  validate_declaration_direction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"), ["AWAITING_DIRECTION"]);
      if ("error" in decl) return decl;
      return {
        title: `Validation finale (Directeur des Opérations) — déclaration ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Montant", decl.amount !== null ? dzd(toNumber(decl.amount)) : null],
          ["Commentaire", opStr(input, "note") || null],
        ]),
        warnings: ["Dernière marche : la déclaration passe VALIDÉE."],
        args: { id: decl.id, comment: opStr(input, "note") || null },
        successMessage: `Déclaration ${decl.reference} validée (validation finale).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(validateDeclarationByDirection, args, "La validation finale a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  comment_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la déclaration ${decl.reference}`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          { label: "Message", value: body },
        ],
        args: { declarationId: decl.id, body },
        successMessage: `Message posté sur ${decl.reference}.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(addMedicalInfoComment, args, "Le message a été refusé.", { revalidate: ["/information-medicale"] }),
  },
};
