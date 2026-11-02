/**
 * OPS VAGUE 2b — RECRUTEMENT (circuit complet jusqu'à l'onboarding) et FORMATIONS (demande,
 * organisation RH, correction, invitations, réponses), par les actions canoniques.
 */
import { prisma } from "./erp";
import { createRecruitmentRequest, cancelRecruitmentRequest, askRecruitmentInfo, answerRecruitmentInfo, openRecruitmentSourcing, closeRecruitmentRequest, addRecruitmentCandidate, moveRecruitmentCandidate, onboardRecruitment } from "@/lib/actions/recruitment-actions";
import { requestTraining, createHrTraining, updateTraining, inviteTrainingParticipants, respondToTrainingInvitation } from "@/lib/actions/training-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, dzd, fieldsOf, resolveOne, isoDate } from "../../helpers";
import { resolvePerson } from "./commun";

const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

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
