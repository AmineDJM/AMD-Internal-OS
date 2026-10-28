import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { champsNonSaisis } from "@/lib/coffre/champs";

/**
 * GOLDEN OPS RH 2 — VAGUE 2a. Le cœur : le PATCH SEMANTICS de la fiche employé.
 * `updateEmployee` (action canonique) REMPLACE la fiche entière — l'op doit donc :
 *   1. n'appliquer QUE les champs cités et REJOUER tout le reste (salaires, drapeaux, liens) ;
 *   2. montrer le DIFF avant → après ;
 *   3. REFUSER un champ salarial (op dédiée) ;
 *   4. refuser d'exécuter si la fiche a changé entre la proposition et la confirmation
 *      (garde de fraîcheur — testée ICI en EXÉCUTION réelle : la garde refuse avant
 *      toute session, donc avant l'action canonique).
 * Plus : congés/avances, demandes RH du dossier, intérim, matrice d'accès (FUSION, SA seul).
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

const PREFIXE = "__opshr2__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let rhId = "";
let accountId = "";
let empId = "";
let emp2Id = "";
let interviewId = "";
let docId = "";

const rh = () => userWith(avecSousModulesRh(["VIEW", "CREATE", "UPDATE"]), "FINANCE_BUDGET_MANAGER", rhId, `${TAG} Lamia`);
const sa = () => userWith({}, "SUPER_ADMIN", rhId, `${TAG} Lamia`);
const outsider = () => userWith({ WORKSPACE: ["VIEW"] }, "MEDICAL_DELEGATE", accountId, `${TAG} Farid`);

suite("ops RH 2 — PATCH fiche employé, congés, dossier RH, intérim, accès (goldens)", () => {
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
    await prisma.employeeDocument.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: { employee: { fullName: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employee: { fullName: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: { employee: { fullName: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.userSession.deleteMany({ where: { user: { email: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [r, a] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Lamia`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
      prisma.user.create({ data: { name: `${TAG} Farid`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    rhId = r.id; accountId = a.id;
    // Le compte de Farid a DÉJÀ un réglage d'accès sur FINANCES : la FUSION doit le rejouer
    // quand on règle un AUTRE module.
    await prisma.userAccess.create({
      data: { userId: a.id, module: "FINANCES", canView: true, canCreate: true, canUpdate: false, canDelete: false, canValidate: false, canExport: true, canUpload: false, scope: "ALL" },
    });

    // Fiche employé COMPLÈTE — le PATCH doit tout rejouer (salaires, drapeaux, essai).
    const emp = await prisma.employee.create({
      data: {
        fullName: `${TAG} Karim Benali`, position: "Délégué médical", email: "karim@adventum.dz",
        phone: "0550 11 22 33", baseSalary: 120_000, grossSalary: 140_000, employerCost: 180_000,
        netToPay: 110_000, retSS9: 12_600, contractType: "CDI", hireDate: new Date("2024-03-01"),
        trialRenewable: true, leaveBalanceDays: 24, isActive: true,
      },
    });
    empId = emp.id;
    const emp2 = await prisma.employee.create({ data: { fullName: `${TAG} Nawel Cherif`, leaveBalanceDays: 30 } });
    emp2Id = emp2.id;

    // Dossier RH : une demande de congé annuel (décidable) + une entrevue avec date proposée.
    await prisma.hrDocumentRequest.create({
      data: { employeeId: emp.id, type: "ANNUAL_LEAVE", status: "PENDING", periodStart: new Date("2026-09-14"), periodEnd: new Date("2026-09-18") },
    });
    const interview = await prisma.hrDocumentRequest.create({
      data: { employeeId: emp2.id, type: "HR_INTERVIEW", status: "IN_PROGRESS", meetingAt: new Date("2026-09-03T09:00:00Z"), meetingProposedById: a.id },
    });
    interviewId = interview.id;

    // Congés pour l'intérim : Karim sans intérimaire (propose), Nawel avec (decide).
    await prisma.leaveRequest.create({
      data: { employeeId: emp.id, type: "ANNUAL", status: "PENDING", startDate: new Date("2026-09-14"), endDate: new Date("2026-09-18"), days: 5 },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp2.id, type: "ANNUAL", status: "APPROVED", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-09"), days: 5,
        standInId: a.id, standInStatus: "PENDING", standInModules: ["WORKSPACE"],
      },
    });

    // Un document du dossier (visibilité + suppression CRITIQUE).
    const doc = await prisma.employeeDocument.create({
      data: { employeeId: emp.id, category: "CONTRACT", name: `${TAG} Contrat CDI.pdf`, blobId: `${TAG}-blob`, mime: "application/pdf", size: 1234, visibleToEmployee: false },
    });
    docId = doc.id;
  });


  describe("PATCH SEMANTICS — fiche employé", () => {
    it("changer le POSTE seul : diff montré, TOUT le reste rejoué (salaires, contrat, drapeaux, actif)", async () => {
      const p = await buildProposal("hr_operation", { op: "update_employee", employee: `${TAG} Karim`, position: "Superviseur régional" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("1 champ");
      expect(JSON.stringify(p.fields)).toContain("Délégué médical → Superviseur régional");
      const args = domainArgs(p);
      expect(args.position).toBe("Superviseur régional");
      // Le rejeu intégral : rien n'est perdu par omission.
      expect(args.fullName).toBe(`${TAG} Karim Benali`);
      // LE COFFRE (refonte V2-E) : les salaires sont rejoués MASQUÉS — le modèle ne les lit pas, et le masque
      // garde la valeur en place à l'exécution (voir « le masque rejoué garde les salaires » ci-dessous).
      expect(args.baseSalary).toBe("•••••• DZD");
      expect(args.employerCost).toBe("•••••• DZD");
      expect(JSON.stringify(p)).not.toMatch(/120.?000|180.?000/);
      expect(args.contractType).toBe("CDI");
      expect(args.trialRenewable).toBe("1");
      expect(args.isActive).toBe("1");
      expect(args.leaveBalanceDays).toBe("24");
      expect(args.expectedUpdatedAt).toBeTruthy();
    });

    it("un champ SALARIAL dans update_employee est REFUSÉ (op dédiée) ; aucun champ = refus explicite", async () => {
      const salary = await buildProposal("hr_operation", { op: "update_employee", employee: `${TAG} Karim`, baseSalary: "150000" }, rh());
      expect("error" in salary && salary.error).toMatch(/update_employee_salary/);
      const empty = await buildProposal("hr_operation", { op: "update_employee", employee: `${TAG} Karim` }, rh());
      expect("error" in empty && empty.error).toMatch(/Aucun champ/);
    });

    it("update_employee_salary : le coût employeur seul change, les autres montants sont rejoués", async () => {
      const p = await buildProposal("hr_operation", { op: "update_employee_salary", employee: `${TAG} Karim`, employerCost: "195000" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      // L'ancien montant n'est pas montré (coffre, refonte V2-E) : seul le nouveau, dicté par la personne.
      expect(JSON.stringify(p.fields)).toMatch(/•+ DZD → 195.000.DZD/);
      expect(JSON.stringify(p)).not.toMatch(/180.?000/);
      const args = domainArgs(p);
      expect(args.employerCost).toBe("195000");
      expect(args.baseSalary).toBe("•••••• DZD");
      expect(args.netToPay).toBe("•••••• DZD");
      expect(args.position).toBe("Délégué médical");
    });

    it("le masque rejoué garde les salaires en place : `updateEmployee` les reconnaît comme non saisis", async () => {
      const p = await buildProposal("hr_operation", { op: "update_employee", employee: `${TAG} Karim`, phone: "0550 44 55 66" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const fd = new FormData();
      for (const [k, v] of Object.entries(domainArgs(p))) if (typeof v === "string") fd.set(k, v);
      // Ce que `updateEmployee` GARDE de la fiche au lieu de l'écrire (`champsNonSaisis`, hr-actions.ts).
      // IBAN et NIN de Karim sont vides : non envoyés, donc gardés vides ; ses salaires reviennent masqués, donc gardés.
      expect(champsNonSaisis("Employee", fd)).toEqual(["iban", "nationalId", "baseSalary", "grossSalary", "netToPay", "employerCost"]);
    });

    it("GARDE DE FRAÎCHEUR (exécution réelle) : la fiche a bougé entre la proposition et la confirmation → REFUS", async () => {
      const p = await buildProposal("hr_operation", { op: "update_employee", employee: `${TAG} Nawel`, position: "Assistante RH" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      // Quelqu'un d'autre modifie la fiche AVANT la confirmation.
      await prisma.employee.update({ where: { id: emp2Id }, data: { phone: "0770 99 88 77" } });
      const impl = DOMAIN_TOOLS.hr_operation.ops.update_employee.impl;
      const r = await impl.execute(domainArgs(p) as Record<string, string | null>, rh());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/modifiée entre-temps/);
    });

    it("create_employee : contrat FR normalisé, porte RH", async () => {
      const p = await buildProposal("hr_operation", { op: "create_employee", name: `${TAG} Yasmine Toumi`, position: "Chargée regulatory", contractType: "cdd", amount: "95000" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).contractType).toBe("CDD");
      const refused = await buildProposal("hr_operation", { op: "create_employee", name: "X" }, outsider());
      expect("error" in refused).toBe(true);
    });
  });

  describe("congés, avances, dossier RH, intérim", () => {
    it("request_leave : dates obligatoires ; pour un employé nommé, le circuit est annoncé", async () => {
      const noDates = await buildProposal("hr_operation", { op: "request_leave", employee: `${TAG} Karim` }, rh());
      expect("error" in noDates && noDates.error).toMatch(/dates/);
      const p = await buildProposal("hr_operation", {
        op: "request_leave", employee: `${TAG} Karim`, startDate: "2026-11-02", endDate: "2026-11-06", type: "annuel",
      }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).employeeId).toBe(empId);
      expect(domainArgs(p).type).toBe("ANNUAL");
      expect(p.warnings.join(" ")).toMatch(/N\+1/);
    });

    it("decide_hr_leave : la demande d'absence du dossier se résout par employé, la décision est tracée", async () => {
      const p = await buildProposal("hr_operation", { op: "decide_hr_leave", employee: `${TAG} Karim`, decision: "accorde" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).decision).toBe("APPROVE");
      expect(p.warnings.join(" ")).toMatch(/solde/);
    });

    it("confirm_hr_meeting : l'entrevue AVEC date proposée se confirme ; propose_ exige la date", async () => {
      const p = await buildProposal("hr_operation", { op: "confirm_hr_meeting", employee: `${TAG} Nawel` }, rh());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).id).toBe(interviewId);
      const noDate = await buildProposal("hr_operation", { op: "propose_hr_meeting", employee: `${TAG} Nawel` }, rh());
      expect("error" in noDate && noDate.error).toMatch(/date/);
    });

    it("propose_stand_in : intérimaire résolu par nom ; « aucun » = retrait ; decide refuse sans motif", async () => {
      const p = await buildProposal("hr_operation", { op: "propose_stand_in", employee: `${TAG} Karim`, standIn: `${TAG} Farid` }, rh());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).standInId).toBe(accountId);

      const remove = await buildProposal("hr_operation", { op: "propose_stand_in", employee: `${TAG} Karim`, standIn: "aucun" }, rh());
      expect("error" in remove).toBe(false);
      if (!("error" in remove)) expect(domainArgs(remove).standInId).toBeNull();

      const rejectNoNote = await buildProposal("hr_operation", { op: "decide_stand_in", employee: `${TAG} Nawel`, decision: "refuse" }, rh());
      expect("error" in rejectNoNote && rejectNoNote.error).toMatch(/motive/);
    });

    it("set_employee_document_visibility + delete (CRITIQUE, ressaisie du nom)", async () => {
      const vis = await buildProposal("hr_operation", { op: "set_employee_document_visibility", employee: `${TAG} Karim`, name: "Contrat CDI" }, rh());
      expect("error" in vis).toBe(false);
      if (!("error" in vis)) {
        expect(domainArgs(vis).id).toBe(docId);
        expect(domainArgs(vis).visible).toBe("1");
      }
      const del = await buildProposal("hr_operation", { op: "delete_employee_document", employee: `${TAG} Karim`, name: "Contrat CDI" }, rh());
      expect("error" in del).toBe(false);
      if (!("error" in del)) {
        expect(del.level).toBe("CRITICAL");
        expect(del.confirmText).toBe(`${TAG} Contrat CDI.pdf`);
      }
    });
  });

  describe("comptes & accès (Super Admin)", () => {
    it("set_module_access : SA SEUL — donner CREATE sur Drive REJOUE le réglage FINANCES existant", async () => {
      const p = await buildProposal("org_operation", {
        op: "set_module_access", person: `${TAG} Farid`, module: "Drive", give: "CREATE",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.mode_DRIVE).toBe("CUSTOM");
      expect(args.actlist_DRIVE).toContain("CREATE");
      // La FUSION : le réglage FINANCES existant (CREATE + EXPORT, portée ALL) est rejoué.
      expect(args.mode_FINANCES).toBe("CUSTOM");
      expect(args.actlist_FINANCES).toContain("CREATE");
      expect(args.actlist_FINANCES).toContain("EXPORT");
      expect(args.scope_FINANCES).toBe("ALL");

      const refused = await buildProposal("org_operation", { op: "set_module_access", person: `${TAG} Farid`, module: "Drive", give: "CREATE" }, rh());
      expect("error" in refused).toBe(true);
    });

    it("update_user_profile : e-mail = identifiant (averti) ; rien à changer = refus", async () => {
      const p = await buildProposal("org_operation", { op: "update_user_profile", person: `${TAG} Farid`, email: `${TAG}nouveau@t.dz` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/IDENTIFIANT DE CONNEXION/);
      expect(domainArgs(p).email).toBe(`${TAG}nouveau@t.dz`.toLowerCase());

      const empty = await buildProposal("org_operation", { op: "update_user_profile", person: `${TAG} Farid` }, sa());
      expect("error" in empty && empty.error).toMatch(/set_account_role/);
    });

    it("revoke_sessions + request_user_onboarding : résolus par nom, portes SA", async () => {
      const p = await buildProposal("org_operation", { op: "revoke_sessions", person: `${TAG} Farid` }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/reconnecter/);
      const o = await buildProposal("org_operation", { op: "request_user_onboarding", person: `${TAG} Farid` }, sa());
      expect("error" in o).toBe(false);
    });
  });
});
