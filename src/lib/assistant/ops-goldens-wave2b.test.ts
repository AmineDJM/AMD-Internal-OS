import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 2b — recrutement (candidats par nom, gestes bornés), formations
 * (invitations résolues par nom, convocation vs invitation, réponse à la sienne), missions
 * (résolution multi-entités : événement / congrès / sponsoring, ambiguïté inter-types LISTÉE),
 * demandes de pièces (côté demandeur ET côté receveur — cloisonnées par personne), information
 * médicale (statuts bornés par étape de validation).
 */

/**
 * « RH » EN SOUS-MODULES (7dece361, Direction 06/10) : Employés, Demandes RH et Formations sont des modules à part, et chaque
 * rôle qui tenait « RH » y a reçu EXACTEMENT ses gestes de « RH » (défauts de `rbac.ts`, accès personnalisés recopiés par la
 * migration `20270114180000_sous_modules_rh`). Une fixture qui écrit ses droits à la main reçoit la même recopie.
 */
function avecSousModulesRh(actions: Action[]): Partial<Record<Module, Action[]>> {
  return { RH: actions, EMPLOYEES: actions, HR_REQUESTS: actions, TRAINING: actions };
}

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops2b__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let rhUserId = "";
let otherId = "";
let recruitmentId = "";
let candidateId = "";
let trainingId = "";
let invitationId = "";
let eventId = "";
let assignmentId = "";
let docReqId = "";
let declarationId = "";

const rh = () => userWith({ ...avecSousModulesRh(["VIEW", "CREATE", "UPDATE", "VALIDATE"]), WORKSPACE: ["VIEW", "CREATE", "UPDATE"] }, "FINANCE_BUDGET_MANAGER", rhUserId, `${TAG} Meriem`);
const sa = () => userWith({}, "SUPER_ADMIN", rhUserId, `${TAG} Meriem`);
const other = () => userWith({ WORKSPACE: ["VIEW", "CREATE", "UPDATE"] }, "MEDICAL_DELEGATE", otherId, `${TAG} Sofiane`);

suite("ops vague 2b — recrutement, formations, missions, pièces, information médicale", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.recruitmentCandidate.deleteMany({ where: { fullName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.recruitmentInfoRequest.deleteMany({ where: { request: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.recruitmentRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.trainingParticipant.deleteMany({ where: { training: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.training.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.missionAssignment.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalInfoDocRequest.deleteMany({ where: { declaration: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [r, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Meriem`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
      prisma.user.create({ data: { name: `${TAG} Sofiane`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    rhUserId = r.id; otherId = o.id;

    const rec = await prisma.recruitmentRequest.create({
      data: {
        reference: `${TAG}-REC-1`, position: `${TAG} Délégué médical Oran`, headcount: 1,
        contractType: "CDI", stage: "SOURCING", requesterId: r.id,
      },
    });
    recruitmentId = rec.id;
    const cand = await prisma.recruitmentCandidate.create({
      data: { requestId: rec.id, fullName: `${TAG} Imane Bousbia`, status: "RECEIVED" },
    });
    candidateId = cand.id;

    const training = await prisma.training.create({
      data: { reference: `${TAG}-FORM-1`, title: `${TAG} Pharmacovigilance niveau 2`, status: "APPROVED", amount: 90_000 },
    });
    trainingId = training.id;
    const inv = await prisma.trainingParticipant.create({
      data: { trainingId: training.id, userId: r.id, attendance: "VOLUNTARY", state: "INVITED" },
    });
    invitationId = inv.id;

    const event = await prisma.event.create({ data: { name: `${TAG} Symposium cardio Alger` } });
    eventId = event.id;
    const assignment = await prisma.missionAssignment.create({
      data: { entityType: "EVENT", entityId: event.id, userId: o.id, role: "ACCOMPAGNANT", createdById: r.id },
    });
    assignmentId = assignment.id;
    // Une 2e entité au nom voisin pour l'ambiguïté INTER-TYPES.
    await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}-SPO-9`, institution: `${TAG} Symposium cardio — sponsoring`, type: "Table ronde" },
    });

    const docReq = await prisma.documentRequest.create({
      data: { reference: `${TAG}-DOC-1`, label: `${TAG} Devis signé imprimeur`, entityType: "EVENT", entityId: event.id, askedById: r.id, askedToId: o.id, status: "PENDING" },
    });
    docReqId = docReq.id;

    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${TAG}-MI-1`, label: `${TAG} Prise en charge Dr Hamidi`, beneficiary: "Dr Hamidi", status: "AWAITING_DIRECTION", requesterId: r.id, amount: 60_000, sourceType: "SPONSORING", sourceId: "src-x" },
    });
    declarationId = decl.id;
  });


  describe("recrutement — candidats par nom, gestes bornés", () => {
    it("create_recruitment : contrat obligatoire ; la chaîne hiérarchique est annoncée", async () => {
      const noContract = await buildProposal("hr_operation", { op: "create_recruitment", position: "Chef de zone" }, rh());
      expect("error" in noContract && noContract.error).toMatch(/contrat/i);
      const p = await buildProposal("hr_operation", { op: "create_recruitment", position: "Chef de zone", contractType: "CDI", salaryMin: "180000" }, rh());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/chaîne hiérarchique/i);
    });

    it("move_recruitment_candidate : geste FR normalisé, candidat résolu par nom, RECRUTER averti", async () => {
      const p = await buildProposal("hr_operation", {
        op: "move_recruitment_candidate", reference: `${TAG}-REC-1`, candidate: "Imane", decision: "présélectionne",
      }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).candidateId).toBe(candidateId);
      expect(domainArgs(p).move).toBe("SHORTLIST");

      const hire = await buildProposal("hr_operation", {
        op: "move_recruitment_candidate", reference: `${TAG}-REC-1`, candidate: "Imane", decision: "recrute",
      }, rh());
      expect("error" in hire).toBe(false);
      if (!("error" in hire)) expect(hire.warnings.join(" ")).toMatch(/INTÉGRATION/);
    });

    it("onboard_recruitment : sans candidat RECRUTÉ, refus net (jamais de fiche fantôme)", async () => {
      const p = await buildProposal("hr_operation", { op: "onboard_recruitment", reference: `${TAG}-REC-1` }, rh());
      expect("error" in p).toBe(true);
      if ("error" in p) expect(p.error).toMatch(/stade Intégration|Aucun candidat/i);
    });
  });

  describe("formations — invitations et réponses", () => {
    it("invite_training_participants : personnes par nom, « convoquer » = présence requise", async () => {
      const p = await buildProposal("hr_operation", {
        op: "invite_training_participants", reference: `${TAG}-FORM-1`, people: `${TAG} Sofiane`, mode: "convoquer",
      }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).attendance).toBe("MANDATORY");
      expect(domainArgs(p).userIds).toBe(otherId);
    });

    it("respond_training_invitation : on répond à LA SIENNE (invitation résolue par formation + user)", async () => {
      const p = await buildProposal("hr_operation", { op: "respond_training_invitation", reference: `${TAG}-FORM-1`, decision: "décline", note: "En mission" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(invitationId);
      expect(domainArgs(p).answer).toBe("DECLINED");

      const notInvited = await buildProposal("hr_operation", { op: "respond_training_invitation", reference: `${TAG}-FORM-1` }, other());
      expect("error" in notInvited && notInvited.error).toMatch(/pas invité/);
    });

    it("update_training : PATCH natif — rien à changer = refus explicite", async () => {
      const empty = await buildProposal("hr_operation", { op: "update_training", reference: `${TAG}-FORM-1` }, rh());
      expect("error" in empty && empty.error).toMatch(/quoi|change/i);
      const p = await buildProposal("hr_operation", { op: "update_training", reference: `${TAG}-FORM-1`, amount: "95000" }, rh());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).amount).toBe("95000");
    });
  });

  describe("missions — résolution multi-entités", () => {
    it("« Symposium cardio » matche l'ÉVÉNEMENT et le SPONSORING → ambiguïté inter-types LISTÉE ; « kind » tranche", async () => {
      const ambiguous = await buildProposal("adpro_operation", {
        op: "assign_mission", target: `${TAG} Symposium cardio`, person: `${TAG} Sofiane`,
      }, sa());
      expect("error" in ambiguous).toBe(true);
      if ("error" in ambiguous) {
        expect(ambiguous.error).toContain("événement");
        expect(ambiguous.error).toContain("sponsoring");
      }
      const p = await buildProposal("adpro_operation", {
        op: "assign_mission", target: `${TAG} Symposium cardio`, kind: "événement", person: `${TAG} Sofiane`, role: "délégué de référence",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).entityType).toBe("EVENT");
      expect(domainArgs(p).role).toBe("DELEGATE_REFERENCE");
    });

    it("issue_mission_order : l'assignation (entité + personne) se résout, l'ordre s'émet", async () => {
      const p = await buildProposal("adpro_operation", {
        op: "issue_mission_order", target: `${TAG} Symposium cardio`, kind: "événement", person: `${TAG} Sofiane`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).id).toBe(assignmentId);
    });
  });

  describe("demandes de pièces — cloisonnées par personne", () => {
    it("submit : seule la personne À QUI on a demandé voit sa demande ; le demandeur, lui, n'a rien à transmettre", async () => {
      const p = await buildProposal("task_operation", { op: "submit_document_request", label: "Devis" }, other());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).id).toBe(docReqId);

      const wrongSide = await buildProposal("task_operation", { op: "submit_document_request", label: "Devis" }, rh());
      expect("error" in wrongSide && wrongSide.error).toMatch(/Aucune demande/);
    });

    it("decide : rien tant que la pièce n'est pas TRANSMISE ; request_document exige la pièce nommée", async () => {
      const tooEarly = await buildProposal("task_operation", { op: "decide_document_request", label: "Devis" }, rh());
      expect("error" in tooEarly && tooEarly.error).toMatch(/Aucune pièce TRANSMISE/);

      const noLabel = await buildProposal("task_operation", { op: "request_document", person: `${TAG} Sofiane`, target: `${TAG} Symposium cardio`, kind: "événement" }, rh());
      expect("error" in noLabel && noLabel.error).toMatch(/pièce/);
      const noTarget = await buildProposal("task_operation", { op: "request_document", person: `${TAG} Sofiane`, label: "Devis" }, rh());
      expect("error" in noTarget && noTarget.error).toMatch(/événement|congrès|sponsoring/);
    });
  });

  describe("information médicale — statuts bornés", () => {
    it("validate_declaration_direction : la déclaration EN ATTENTE DIRECTION se résout ; la validation pharmacien, elle, n'a plus sa place", async () => {
      const p = await buildProposal("medical_info_operation", { op: "validate_declaration_direction", reference: `${TAG}-MI-1` }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(declarationId);
        expect(p.warnings.join(" ")).toMatch(/Dernière marche/);
      }
      const wrongStage = await buildProposal("medical_info_operation", { op: "validate_declaration", reference: `${TAG}-MI-1` }, sa());
      expect("error" in wrongStage).toBe(true);
    });

    it("request_declaration_document : pièce + personne obligatoires, statut annoncé", async () => {
      const p = await buildProposal("medical_info_operation", {
        op: "request_declaration_document", reference: `${TAG}-MI-1`, piece: "Ordonnance originale", person: `${TAG} Sofiane`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/Pièces demandées/);
    });
  });
});
