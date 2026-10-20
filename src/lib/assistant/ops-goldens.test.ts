import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, performAction, type AssistantActionPayload } from "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { OPS_CATALOG } from "@/lib/assistant/ops/catalog";
import { actionsForUser } from "@/lib/assistant/action-registry";

/**
 * GOLDEN OPS DE DOMAINE — le mécanisme SYSTÉMIQUE qui ferme les trous de parité en série :
 *
 *   • INTÉGRITÉ : chaque op du catalogue a une implémentation (le zip échoue au chargement
 *     sinon) et une définition d'outil générée cohérente (énumération `op`).
 *   • RÉSOLUTION Drive par NOM : exact/unique proposé, ambigu LISTÉ avec l'emplacement,
 *     inaccessible refusé — l'ACL réelle (`resolveDriveAccess`) dès la proposition.
 *   • CRITIQUE : la suppression Drive définitive exige la RESSAISIE du nom.
 *   • TÂCHES côté « moi » : seules les tâches où le geste est possible se proposent
 *     (accepter = demande REQUESTED qui m'est adressée, jamais celle d'un collègue).
 *   • LOT (`bulk_action`) : UNE carte pour N cibles par RÉCURSION de buildProposal (mêmes
 *     portes, même résolution), niveau = max des items, CRITIQUE → ressaisie « LOT n »,
 *     exécution best-effort avec reçu par cible.
 */

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

// ── Intégrité catalogue ↔ implémentations ↔ défs (PUR, sans base) ──

describe("ops de domaine — intégrité du catalogue", () => {
  it("chaque op du catalogue est implémentée et énumérée dans la définition d'outil", () => {
    for (const meta of OPS_CATALOG) {
      const spec = DOMAIN_TOOLS[meta.tool];
      expect(spec, `outil ${meta.tool} absent de DOMAIN_TOOLS`).toBeDefined();
      expect(spec.ops[meta.op], `${meta.tool}/${meta.op} sans implémentation`).toBeDefined();
      const schema = spec.def.input_schema as { properties: { op: { enum: string[] } } };
      expect(schema.properties.op.enum, `${meta.tool}/${meta.op} absent de l'enum`).toContain(meta.op);
    }
  });

  it("découverte par les droits : le Drive ouvre les ops Drive, un compte sans droits ne les voit pas", () => {
    const withDrive = userWith({ DRIVE: ["VIEW", "CREATE"], WORKSPACE: ["VIEW", "UPDATE"] }, "DIRECTION", "u-d", "D");
    const ids = actionsForUser(withDrive).map((a) => a.id);
    expect(ids).toContain("OP_DRIVE_OPERATION_MOVE");
    expect(ids).toContain("OP_DRIVE_OPERATION_DELETE");
    expect(ids).toContain("OP_TASK_OPERATION_ACCEPT");
    const bare = userWith({}, "MEDICAL_DELEGATE", "u-b", "B");
    const bareIds = actionsForUser(bare).map((a) => a.id);
    expect(bareIds).not.toContain("OP_DRIVE_OPERATION_MOVE");
    expect(bareIds).not.toContain("OP_TASK_OPERATION_ACCEPT");
  });
});

// ── Goldens avec base (résolution réelle, fixtures nettoyées) ──

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops__";
const TAG = `${PREFIXE}${Date.now()}`;
let ownerId = "";
let colleagueId = "";
let outsiderId = "";
let folderId = "";
let fileId = "";
let requestedTaskId = "";
let companyId = "";
let regProductId = "";

const owner = () => userWith({ DRIVE: ["VIEW", "CREATE"], WORKSPACE: ["VIEW", "CREATE", "UPDATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
const outsider = () => userWith({ DRIVE: ["VIEW"], WORKSPACE: ["VIEW", "UPDATE"] }, "MEDICAL_DELEGATE", outsiderId, `${TAG} Walid`);

suite("ops de domaine & lots — goldens (fixtures partagées)", () => {
  /**
   * ── POURQUOI CE DÉCOR EST ÉCRIT EN VAGUES, ET NON EN SUITE ─────────────────────────────
   *
   * Mesuré : ce fichier entier tourne en 985 ms SEUL, et son décor a dépassé les 30 000 ms de
   * `hookTimeout` dans la suite complète — 717 fichiers sur QUATRE cœurs. Le décor n'était pas
   * lourd (une trentaine de lignes) : il était SÉQUENTIEL, donc son coût était trente attentes
   * l'une après l'autre, et sous contention chacune se paie plusieurs centaines de millisecondes.
   *
   * Relever le plafond aurait été la mauvaise réparation : un plafond de décor existe pour
   * attraper un décor BLOQUÉ, pas pour mesurer l'humeur de l'ordonnanceur — une assertion de
   * temps qui dépend de la charge ne mesure pas la propriété qu'elle annonce (§118.83). On
   * réduit donc le NOMBRE d'attentes : trois vagues, chacune limitée par ses seules clés
   * étrangères. Ce qui ne dépend de rien part ensemble ; ce qui dépend d'un identifiant attend
   * la vague qui le produit.
   */
  beforeAll(async () => {
    // VAGUE 1 — tout ce qui ne dépend d'aucun identifiant.
    const [o, c, x, company, dept, emp, product] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Karim`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG} Lina`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG} Walid`, email: `${TAG}x@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.company.create({ data: { name: `${TAG} Adventum Pharma` } }),
      prisma.department.create({ data: { name: `${TAG} Marketing`, code: `${TAG}-MKT` } }),
      prisma.employee.create({ data: { fullName: `${TAG} Samir Hadjout` } }),
      prisma.regulatoryProduct.create({
        data: {
          reference: `${TAG}-REG-1`, dci: `${TAG} FOSFOMYCINE`, status: "SUBMITTED",
          steps: { create: [{ type: "DOSSIER_SUBMISSION", order: 4, status: "IN_PROGRESS" }] },
        },
      }),
      prisma.mailEntry.create({
        data: { title: `${TAG} Convocation ANPP`, reference: `${TAG}-CHR-7`, direction: "INCOMING", sender: "ANPP" },
      }),
      prisma.mailEntryFolder.create({ data: { name: `${TAG} Officiel` } }),
      prisma.supplier.create({ data: { name: `${TAG} LabPartner GmbH` } }),
      prisma.businessDevelopmentOpportunity.create({ data: { name: `${TAG} Biosimilaire X`, status: "RESEARCH" } }),
      prisma.expenseOrder.createMany({
        data: [
          { reference: `${TAG}-OD-1`, label: `${TAG} Impression brochures`, amount: 250000, status: "PENDING" },
          { reference: `${TAG}-OD-2`, label: `${TAG} Impression affiches`, amount: 90000, status: "PENDING" },
        ],
      }),
      prisma.sponsoringRequest.create({
        data: {
          reference: `${TAG}-SPO-1`, institution: `${TAG} Association cardio`, type: "Table ronde",
          items: { create: { label: `${TAG} Location de salle`, status: "PENDING", amountEstimated: 180000, submittedAt: new Date(), supplier: "Hôtel El Aurassi" } },
        },
      }),
    ]);
    ownerId = o.id; colleagueId = c.id; outsiderId = x.id;
    companyId = company.id; regProductId = product.id;

    // VAGUE 2 — ce qui n'attend qu'un identifiant de la vague 1.
    const [folder, task, allot] = await Promise.all([
      prisma.driveNode.create({ data: { name: `${TAG} Campagne`, type: "FOLDER", ownerId, createdById: ownerId } }),
      prisma.task.create({
        data: {
          title: `${TAG} Préparer la synthèse`, assignedToId: ownerId, createdById: colleagueId,
          status: "REQUESTED", requestedAt: new Date(),
        },
      }),
      prisma.pettyCashAllotment.create({
        data: { departmentId: dept.id, period: "2026-08", amount: 50000, holderId: colleagueId },
      }),
      prisma.driveNode.create({ data: { name: `${TAG} Rapport ventes.xlsx`, type: "FILE", ownerId, createdById: ownerId } }),
      prisma.task.create({
        data: { title: `${TAG} Relire le contrat`, assignedToId: colleagueId, createdById: ownerId, status: "REQUESTED", requestedAt: new Date() },
      }),
      prisma.regulatoryVariation.create({
        data: { productId: product.id, toStatus: "SECONDARY_PACKAGING", status: "EN_ATTENTE" },
      }),
      prisma.departmentBudgetRequest.create({
        data: { departmentId: dept.id, year: 2026, kind: "OPERATING", amount: 300000, status: "PENDING", requestedById: colleagueId },
      }),
      prisma.leaveRequest.create({
        data: {
          employeeId: emp.id, type: "ANNUAL", status: "PENDING",
          startDate: new Date("2026-09-07"), endDate: new Date("2026-09-11"), days: 5,
        },
      }),
      prisma.salaryAdvance.create({ data: { employeeId: emp.id, amount: 80000, status: "PENDING", reason: "Rentrée scolaire" } }),
      prisma.hrDocumentRequest.create({
        data: { employeeId: emp.id, type: "EXPENSE_REPORT", status: "PENDING", expenseMonth: "2026-08" },
      }),
      prisma.meeting.create({
        data: {
          title: `${TAG} Point mensuel Regulatory`, slug: `${TAG}-meet`, publicToken: `${TAG}-tok`,
          organizerId: colleagueId, scheduledAt: new Date("2026-09-02T09:00:00Z"),
          participants: { create: { userId: ownerId } },
        },
      }),
      prisma.legalDocument.create({
        data: { title: `${TAG} Contrat de maintenance`, reference: `${TAG}-LEG-1`, kind: "CONTRACT", endDate: new Date("2026-12-31"), createdById: ownerId },
      }),
      prisma.legalDocument.create({
        data: { title: `${TAG} Facture imprimeur`, kind: "INVOICE", amount: 45000, counterparty: "Imprimerie", createdById: ownerId },
      }),
    ]);
    folderId = folder.id; requestedTaskId = task.id;

    // VAGUE 3 — ce qui attend un identifiant de la vague 2.
    const [file] = await Promise.all([
      prisma.driveNode.create({
        data: { name: `${TAG} Rapport ANPP.docx`, type: "FILE", ownerId, createdById: ownerId, parentId: folderId },
      }),
      prisma.pettyCashTopUpRequest.create({
        data: { allotmentId: allot.id, amountRequested: 20000, status: "PENDING", requestedById: colleagueId },
      }),
    ]);
    fileId = file.id;
  });

  afterAll(async () => {
    const tasks = await prisma.task.findMany({ where: { title: { startsWith: PREFIXE } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: tasks.map((t) => t.id) } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { body: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { department: { name: { startsWith: PREFIXE } } } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { department: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.departmentBudgetRequest.deleteMany({ where: { department: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.businessDevelopmentOpportunity.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  });

  describe("ops Drive — résolution par nom, ACL réelle, CRITIQUE", () => {
  it("rename : élément résolu par nom (exact), payload domain_op avec les args rejouables", async () => {
    const p = await buildProposal("drive_operation", { op: "rename", name: `${TAG} Rapport ANPP.docx`, newName: `${TAG} Rapport ANPP v2.docx` }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("domain_op");
    expect(p.module).toBe("DRIVE");
    expect(p.title).toContain("Renommer");
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
    expect(payload.tool).toBe("drive_operation");
    expect(payload.op).toBe("rename");
    expect(payload.args.id).toBe(fileId);
    expect(payload.args.newName).toBe(`${TAG} Rapport ANPP v2.docx`);
  });

  it("ambigu : « Rapport » correspond à deux fichiers → la liste est montrée, rien n'est proposé", async () => {
    const p = await buildProposal("drive_operation", { op: "trash", name: `${TAG} Rapport` }, owner());
    expect("error" in p).toBe(true);
    if (!("error" in p)) return;
    expect(p.error).toContain("Plusieurs éléments");
    expect(p.error).toContain("Rapport ANPP");
    expect(p.error).toContain("Rapport ventes");
  });

  it("ACL : un compte SANS accès au nœud ne peut pas le viser — même avec le droit module Drive", async () => {
    const p = await buildProposal("drive_operation", { op: "rename", name: `${TAG} Rapport ANPP.docx`, newName: "X" }, outsider());
    expect("error" in p).toBe(true);
    if ("error" in p) expect(p.error).toMatch(/Aucun élément|droit d'ÉDITION/);
  });

  it("delete : NIVEAU CRITIQUE — la confirmation exige de RESSAISIR le nom exact", async () => {
    const p = await buildProposal("drive_operation", { op: "delete", name: `${TAG} Rapport ventes.xlsx` }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.level).toBe("CRITICAL");
    expect(p.confirmText).toBe(`${TAG} Rapport ventes.xlsx`);
    // Plus « irréversible » (10/2026) : l'élément part dans la corbeille du Super Admin — la carte le dit.
    expect(p.warnings.join(" ")).toMatch(/seul le Super Admin pourra le restaurer/);
    expect(p.warnings.join(" ")).not.toMatch(/IRRÉVERSIBLE/);
  });

  it("create_folder : le dossier parent se résout par nom, l'emplacement est montré", async () => {
    const p = await buildProposal("drive_operation", { op: "create_folder", name: `${TAG} Sous-dossier`, folder: `${TAG} Campagne` }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(JSON.stringify(p.fields)).toContain(`${TAG} Campagne`);
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
    expect(payload.args.parentId).toBe(folderId);
  });

  it("share : personnes résolues par nom (introuvable = averti, jamais deviné), droit lecture/modification", async () => {
    const p = await buildProposal("drive_operation", {
      op: "share", name: `${TAG} Campagne`, people: `${TAG} Lina, Personne Inexistante Zz`, access: "modification",
    }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(JSON.stringify(p.fields)).toContain(`${TAG} Lina`);
    expect(JSON.stringify(p.fields)).toContain("Modification");
    expect(p.warnings.join(" ")).toContain("introuvable");
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
    expect(payload.args.userIds).toBe(colleagueId);
    expect(payload.args.access).toBe("EDIT");
  });

  it("porte du catalogue : sans le droit module Drive, l'op est refusée à la proposition", async () => {
    const noDrive = userWith({ WORKSPACE: ["VIEW"] }, "MEDICAL_DELEGATE", outsiderId, `${TAG} Walid`);
    const p = await buildProposal("drive_operation", { op: "trash", name: "x" }, noDrive);
    expect("error" in p).toBe(true);
    if ("error" in p) expect(p.error).toMatch(/pas le droit/);
  });

  it("op inconnue : refus net avec la liste des ops disponibles", async () => {
    const p = await buildProposal("drive_operation", { op: "explode", name: "x" }, owner());
    expect("error" in p).toBe(true);
    if ("error" in p) expect(p.error).toContain("create_folder");
  });
  });

  describe("ops Tâches — le côté « moi » du circuit de demande", () => {
  it("accept : seule MA demande REQUESTED se propose ; celle d'un collègue reste introuvable", async () => {
    const p = await buildProposal("task_operation", { op: "accept", title: `${TAG} Préparer la synthèse` }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.title).toContain("Accepter");
    expect(p.warnings.join(" ")).toMatch(/commencer/);
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
    expect(payload.args.id).toBe(requestedTaskId);

    // La demande adressée à Lina n'est PAS acceptable par Karim — accepter à la place de
    // quelqu'un, c'est lui attribuer un engagement qu'il n'a pas pris.
    const other = await buildProposal("task_operation", { op: "accept", title: `${TAG} Relire le contrat` }, owner());
    expect("error" in other).toBe(true);
  });

  it("refuse : le motif (facultatif) est montré et rejoué dans les args", async () => {
    const p = await buildProposal("task_operation", { op: "refuse", title: `${TAG} Préparer la synthèse`, reason: "Surchargé cette semaine" }, owner());
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(JSON.stringify(p.fields)).toContain("Surchargé cette semaine");
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
    expect(payload.args.reason).toBe("Surchargé cette semaine");
  });

  it("submit_work : une demande encore REQUESTED ne se « valide » pas (il faut l'accepter d'abord)", async () => {
    const p = await buildProposal("task_operation", { op: "submit_work", title: `${TAG} Préparer la synthèse` }, owner());
    expect("error" in p).toBe(true);
  });

  it("comment : le message est exigé, le cercle de la tâche fait foi", async () => {
    const missing = await buildProposal("task_operation", { op: "comment", title: `${TAG} Préparer la synthèse` }, owner());
    expect("error" in missing && missing.error).toMatch(/message/);
    const p = await buildProposal("task_operation", { op: "comment", title: `${TAG} Préparer la synthèse`, comment: "Vu — je regarde demain." }, owner());
    expect("error" in p).toBe(false);
  });
  });

  describe("ops Finances — écritures, règlements, décisions", () => {
    const finUser = () => userWith({ FINANCES: ["VIEW", "CREATE", "UPDATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);

    it("create_transaction : normalisation FR (sens, catégorie, statut) + avertissement trésorerie", async () => {
      const p = await buildProposal("finance_operation", {
        op: "create_transaction", label: `${TAG} Loyer siège`, amount: "1 500 000", category: "loyer", direction: "décaissement",
      }, finUser());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(JSON.stringify(p.fields)).toMatch(/1.500.000.DZD/);
      expect(p.warnings.join(" ")).toMatch(/trésorerie/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.category).toBe("LOYER");
      expect(payload.args.direction).toBe("OUT");
      expect(payload.args.status).toBe("SETTLED");
    });

    it("settle_expense_order : ambigu LISTÉ, exact proposé avec le verrou du Centre de paiement annoncé", async () => {
      const ambiguous = await buildProposal("finance_operation", { op: "settle_expense_order", label: `${TAG} Impression` }, finUser());
      expect("error" in ambiguous).toBe(true);
      if ("error" in ambiguous) {
        expect(ambiguous.error).toContain(`${TAG}-OD-1`);
        expect(ambiguous.error).toContain(`${TAG}-OD-2`);
      }
      const p = await buildProposal("finance_operation", { op: "settle_expense_order", reference: `${TAG}-OD-1` }, finUser());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(JSON.stringify(p.fields)).toMatch(/250.000.DZD/);
      expect(p.warnings.join(" ")).toMatch(/Centre de paiement/);
    });

    it("decide_petty_topup : résolution par département, montant accordé ajustable", async () => {
      const p = await buildProposal("finance_operation", {
        op: "decide_petty_topup", decision: "accorde", department: `${TAG} Marketing`, amount: "15000",
      }, finUser());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toMatch(/20.000.DZD/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.decision).toBe("APPROVED");
      expect(payload.args.amountGranted).toBe("15000");
    });

    it("decide_department_budget : la demande EN ATTENTE du département se propose avec son montant", async () => {
      const p = await buildProposal("finance_operation", {
        op: "decide_department_budget", decision: "approuve", department: `${TAG} Marketing`,
      }, finUser());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toMatch(/300.000.DZD/);
      expect(p.warnings.join(" ")).toMatch(/AJOUTE au budget/);
    });

    it("porte : sans droit Finances, l'op est refusée à la proposition", async () => {
      const noFin = userWith({ WORKSPACE: ["VIEW"] }, "MEDICAL_DELEGATE", outsiderId, `${TAG} Walid`);
      const p = await buildProposal("finance_operation", { op: "create_transaction", label: "x", amount: "10" }, noFin);
      expect("error" in p).toBe(true);
      if ("error" in p) expect(p.error).toMatch(/pas le droit/);
    });
  });

  describe("ops Regulatory — le dossier complet", () => {
    const regSA = () => userWith({ REGULATORY: ["VIEW", "CREATE", "UPDATE"] }, "SUPER_ADMIN", ownerId, `${TAG} Karim`);

    it("create_product : l'ENTITÉ est obligatoire et se résout par nom", async () => {
      const missing = await buildProposal("regulatory_operation", { op: "create_product", dci: `${TAG} AMOXICILLINE` }, regSA());
      expect("error" in missing && missing.error).toMatch(/ENTITÉ/i);
      const p = await buildProposal("regulatory_operation", {
        op: "create_product", dci: `${TAG} AMOXICILLINE`, entity: `${TAG} Adventum`,
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain(`${TAG} Adventum Pharma`);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.companyId).toBe(companyId);
    });

    it("set_participants : liste REMPLACÉE, personnes résolues par nom", async () => {
      const p = await buildProposal("regulatory_operation", {
        op: "set_participants", reference: `${TAG}-REG-1`, people: `${TAG} Lina`,
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/REMPLACÉE/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.userIds).toBe(colleagueId);
    });

    it("update_step_details : l'étape se donne par LIBELLÉ et la fusion préserve l'existant", async () => {
      const p = await buildProposal("regulatory_operation", {
        op: "update_step_details", reference: `${TAG}-REG-1`, step: "Dépôt dossier", note: "En attente de l'accusé ANPP",
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain("Dépôt dossier");
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      // La fusion rejoue le statut EXISTANT (IN_PROGRESS) : une note ne coûte jamais un statut.
      expect(payload.args.status).toBe("IN_PROGRESS");
      expect(payload.args.comment).toBe("En attente de l'accusé ANPP");
      const unknown = await buildProposal("regulatory_operation", {
        op: "update_step_details", reference: `${TAG}-REG-1`, step: "Étape imaginaire", note: "x",
      }, regSA());
      expect("error" in unknown && unknown.error).toMatch(/Valeurs possibles|introuvable/);
    });

    it("set_checklist_item : le libellé humain se résout vers la clé du référentiel", async () => {
      const p = await buildProposal("regulatory_operation", {
        op: "set_checklist_item", reference: `${TAG}-REG-1`, item: "CPP",
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.itemKey).toBe("cpp");
      expect(payload.args.checked).toBe("true");
    });

    it("request_bv : montant DZD obligatoire, l'ordre de dépense est annoncé (SENSIBLE)", async () => {
      const missing = await buildProposal("regulatory_operation", { op: "request_bv", reference: `${TAG}-REG-1` }, regSA());
      expect("error" in missing && missing.error).toMatch(/montant/i);
      const p = await buildProposal("regulatory_operation", {
        op: "request_bv", reference: `${TAG}-REG-1`, amount: "120000", bvType: "BV1",
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(p.warnings.join(" ")).toMatch(/ORDRE DE DÉPENSE/);
      expect(JSON.stringify(p.fields)).toMatch(/120.000.DZD/);
    });

    it("set_variation_status : la variation EN ATTENTE unique est choisie, « obtenue » annonce le verrou Super Admin", async () => {
      const p = await buildProposal("regulatory_operation", {
        op: "set_variation_status", reference: `${TAG}-REG-1`, status: "obtenue",
      }, regSA());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/Super Admin/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.status).toBe("OBTENUE");
    });
  });

  describe("ops RH — décisions de circuits, fiche employé", () => {
    const rh = () => userWith({ RH: ["VIEW", "CREATE", "UPDATE", "VALIDATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);

    it("decide_leave : le congé EN ATTENTE de l'employé se propose, le circuit est annoncé", async () => {
      const p = await buildProposal("hr_operation", { op: "decide_leave", decision: "approuve", employee: `${TAG} Samir` }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(JSON.stringify(p.fields)).toContain("2026-09-07");
      expect(p.warnings.join(" ")).toMatch(/CIRCUIT/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.decision).toBe("APPROVED");
    });

    it("decide_advance : montant montré en DZD, refus possible", async () => {
      const p = await buildProposal("hr_operation", { op: "decide_advance", decision: "refuse", employee: `${TAG} Samir`, note: "Budget serré" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toMatch(/80.000.DZD/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.decision).toBe("REJECTED");
      expect(payload.args.note).toBe("Budget serré");
    });

    it("decide_expense_report : « mois suivant » se comprend (APPROVE_NEXT)", async () => {
      const p = await buildProposal("hr_operation", { op: "decide_expense_report", decision: "approuve sur le mois suivant", employee: `${TAG} Samir` }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain("2026-08");
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.decision).toBe("APPROVE_NEXT");
    });

    it("set_employee_active : fiche résolue par nom, sens du geste compris", async () => {
      const p = await buildProposal("hr_operation", { op: "set_employee_active", employee: `${TAG} Samir`, status: "désactive" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("Désactiver");
      expect(p.warnings.join(" ")).toMatch(/rien n'est effacé/);
    });

    it("porte : décider une avance exige RH VALIDATE", async () => {
      const noValidate = userWith({ RH: ["VIEW"] }, "MEDICAL_DELEGATE", outsiderId, `${TAG} Walid`);
      const p = await buildProposal("hr_operation", { op: "decide_advance", decision: "accorde", employee: `${TAG} Samir` }, noValidate);
      expect("error" in p).toBe(true);
      if ("error" in p) expect(p.error).toMatch(/pas le droit/);
    });
  });

  describe("ops Réunions — planifier, répondre, gérer", () => {
    const me = () => userWith({ MESSAGING: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);

    it("create : créneau heure d'Alger + invités résolus par nom", async () => {
      const p = await buildProposal("meeting_operation", {
        op: "create", title: `${TAG} Comité budget`, date: "2026-09-10", time: "14:30", people: `${TAG} Lina`,
      }, me());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain("2026-09-10 à 14:30");
      expect(JSON.stringify(p.fields)).toContain(`${TAG} Lina`);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.userIds).toBe(colleagueId);
    });

    it("respond_invite : seule une réunion où JE suis invité se propose ; la réponse est normalisée", async () => {
      const p = await buildProposal("meeting_operation", { op: "respond_invite", title: `${TAG} Point mensuel`, response: "j'accepte" }, me());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.response).toBe("ACCEPTED");
      expect(JSON.stringify(p.fields)).toContain(`${TAG} Lina`); // l'organisatrice
    });

    it("end/delete : réservé à l'ORGANISATEUR — la réunion d'un collègue reste introuvable pour moi", async () => {
      const p = await buildProposal("meeting_operation", { op: "end", title: `${TAG} Point mensuel` }, me());
      expect("error" in p).toBe(true);
      if ("error" in p) expect(p.error).toMatch(/organisez/);
    });
  });

  describe("ops Courriers / Legal / Structurel", () => {
    const clerk = () => userWith({ MAIL_REGISTER: ["VIEW", "CREATE", "UPDATE"], LEGAL: ["VIEW", "CREATE", "UPDATE"], GENERAL_MEANS: ["VIEW", "CREATE"], RH: ["VIEW", "UPDATE"] }, "DIRECTION_ASSISTANT", ownerId, `${TAG} Karim`);

    it("mail edit_entry : FUSION — corriger l'objet ne coûte jamais l'expéditeur", async () => {
      const p = await buildProposal("mail_operation", {
        op: "edit_entry", reference: `${TAG}-CHR-7`, newLabel: `${TAG} Convocation ANPP — commission`,
      }, clerk());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.sender).toBe("ANPP"); // rejoué, pas effacé
      expect(payload.args.title).toContain("commission");
    });

    it("mail move_entries : dossier résolu par nom, plusieurs plis d'un coup", async () => {
      const p = await buildProposal("mail_operation", {
        op: "move_entries", reference: `${TAG}-CHR-7`, folder: `${TAG} Officiel`,
      }, clerk());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain(`${TAG} Officiel`);
    });

    it("mail attach_drive : le fichier Drive se résout et la non-copie est dite", async () => {
      const p = await buildProposal("mail_operation", {
        op: "attach_drive", name: `${TAG} Rapport ANPP.docx`, direction: "entrant",
      }, clerk());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/jamais copié/);
    });

    it("legal set_readers : liste REMPLACÉE annoncée, lecteurs résolus", async () => {
      const p = await buildProposal("legal_operation", {
        op: "set_readers", reference: `${TAG}-LEG-1`, people: `${TAG} Lina`,
      }, clerk());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/REMPLACÉE/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.userIds).toBe(colleagueId);
    });

    it("legal send_invoice_settlement : seule une FACTURE à montant se propose (SENSIBLE)", async () => {
      const notInvoice = await buildProposal("legal_operation", { op: "send_invoice_settlement", reference: `${TAG}-LEG-1` }, clerk());
      expect("error" in notInvoice).toBe(true);
      const p = await buildProposal("legal_operation", { op: "send_invoice_settlement", label: `${TAG} Facture imprimeur` }, clerk());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(JSON.stringify(p.fields)).toMatch(/45.000.DZD/);
      expect(p.warnings.join(" ")).toMatch(/ORDRE DE DÉPENSE/);
    });

    it("org assign_manager : employé et N+1 résolus au registre RH ; jamais son propre N+1", async () => {
      const p = await buildProposal("org_operation", { op: "assign_manager", employee: `${TAG} Samir`, manager: `${TAG} Samir` }, clerk());
      expect("error" in p && p.error).toMatch(/propre N\+1/);
    });

    it("org create_company : réservé au Super Admin (porte du catalogue)", async () => {
      const p = await buildProposal("org_operation", { op: "create_company", name: "X" }, clerk());
      expect("error" in p).toBe(true);
      const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
      const ok = await buildProposal("org_operation", { op: "create_company", name: `${TAG} Nouvelle Filiale` }, sa);
      expect("error" in ok).toBe(false);
      if (!("error" in ok)) expect(ok.warnings.join(" ")).toMatch(/CLOISONNEMENT/);
    });

    it("org toggle_supplier : fournisseur résolu par nom, sens du geste dit", async () => {
      const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
      const p = await buildProposal("org_operation", { op: "toggle_supplier", name: `${TAG} LabPartner` }, sa);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("Désactiver");
    });

    it("org create_account_invite : compte par LIEN d'invitation — JAMAIS de mot de passe en conversation", async () => {
      const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
      // Porte : réservé au Super Admin.
      const refused = await buildProposal("org_operation", { op: "create_account_invite", name: "X", email: "x@t.dz", role: "VIEWER" }, clerk());
      expect("error" in refused).toBe(true);
      // Rôle inconnu → la liste des rôles possibles est DONNÉE, rien n'est deviné.
      const badRole = await buildProposal("org_operation", { op: "create_account_invite", name: "X", email: `${TAG}new@t.dz`, role: "grand manitou" }, sa);
      expect("error" in badRole && badRole.error).toMatch(/Rôles possibles/);
      // E-mail déjà pris → refus dès la PROPOSITION (pas à l'exécution).
      const karim = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true } });
      const dup = await buildProposal("org_operation", { op: "create_account_invite", name: "X", email: karim!.email, role: "VIEWER" }, sa);
      expect("error" in dup && dup.error).toMatch(/existe déjà/);
      // Proposition valide : la carte DIT qu'aucun mot de passe ne transite, le rôle est normalisé.
      const ok = await buildProposal("org_operation", { op: "create_account_invite", name: `${TAG} Nawel`, email: `${TAG}nawel@t.dz`, role: "viewer" }, sa);
      expect("error" in ok).toBe(false);
      if ("error" in ok) return;
      expect(ok.level).toBe("SENSITIVE");
      expect(ok.warnings.join(" ")).toMatch(/AUCUN mot de passe/);
      expect(ok.payload.kind === "domain_op" && ok.payload.args.role).toBe("VIEWER");
      expect(JSON.stringify(ok.fields)).toMatch(/usage unique/);
    });
  });

  describe("ops Ad & Pro / BD / Stocks", () => {
    it("decide_item : le poste SOUMIS se résout par libellé, montant accordé ajustable (Direction)", async () => {
      const direction = userWith({}, "DIRECTION", ownerId, `${TAG} Karim`);
      const p = await buildProposal("adpro_operation", {
        op: "decide_item", decision: "accorde", label: `${TAG} Location`, amount: "150000",
      }, direction);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("SENSITIVE");
      expect(JSON.stringify(p.fields)).toContain(`${TAG}-SPO-1`);
      expect(JSON.stringify(p.fields)).toMatch(/180.000.DZD/); // estimation montrée
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.decision).toBe("APPROVED");
      expect(payload.args.amountGranted).toBe("150000");
    });

    it("transfer : source résolue (référence sponsoring), destination comprise, effets annoncés", async () => {
      const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
      const p = await buildProposal("adpro_operation", {
        op: "transfer", reference: `${TAG}-SPO-1`, to: "prise en charge nationale",
      }, sa);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/repart du DÉBUT/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.from).toBe("SPONSORING");
      expect(payload.args.to).toBe("CONGRESS_NATIONAL");
    });

    it("bd update_status : stade normalisé en FR, sans-changement refusé", async () => {
      const bd = userWith({ BUSINESS_DEVELOPMENT: ["VIEW", "CREATE", "UPDATE"] }, "BUSINESS_DEVELOPMENT_MANAGER", ownerId, `${TAG} Karim`);
      const same = await buildProposal("bd_operation", { op: "update_status", name: `${TAG} Biosimilaire X`, status: "recherche" }, bd);
      expect("error" in same && same.error).toMatch(/déjà au stade/);
      const p = await buildProposal("bd_operation", { op: "update_status", name: `${TAG} Biosimilaire X`, status: "négociation" }, bd);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.status).toBe("NEGOTIATION");
    });

    it("stock request_state : destinataire résolu, circuit demande de tâche annoncé", async () => {
      const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
      const p = await buildProposal("stock_operation", { op: "request_state", assigneeName: `${TAG} Lina` }, sa);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/DEMANDE DE TÂCHE/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>;
      expect(payload.args.assigneeId).toBe(colleagueId);
    });
  });

  describe("action_plan — chaînes d'étapes dépendantes ($prev)", () => {
    it("PROPOSITION : les étapes sans dépendance sont résolues, celles en $prev sont différées et dites", async () => {
      const me = userWith({ DRIVE: ["VIEW", "CREATE"], WORKSPACE: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
      const p = await buildProposal("action_plan", {
        summary: "Créer le dossier puis y ranger le rapport",
        steps: [
          { tool: "drive_operation", input: { op: "create_folder", name: `${TAG} Rapports 2026` } },
          { tool: "drive_operation", input: { op: "move", name: `${TAG} Rapport ANPP.docx`, folder: "$prev.name" } },
        ],
      }, me);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.kind).toBe("action_plan");
      expect(p.warnings.join(" ")).toMatch(/ARRÊTE la chaîne/);
      const payload = p.payload as Extract<AssistantActionPayload, { kind: "action_plan" }>;
      expect(payload.steps[0].kind).toBe("resolved");
      expect(payload.steps[1].kind).toBe("deferred");
      expect(JSON.stringify(p.fields)).toContain("dépend de l'étape 1");
    });

    it("$prev interdit en 1re étape ; une étape invalide refuse tout le plan avec son numéro", async () => {
      const me = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
      const bad = await buildProposal("action_plan", {
        steps: [
          { tool: "create_task", input: { title: "$prev.title" } },
          { tool: "create_task", input: { title: "x" } },
        ],
      }, me);
      expect("error" in bad && bad.error).toMatch(/1re étape/);
      const unknown = await buildProposal("action_plan", {
        steps: [
          { tool: "create_task", input: { title: "a" } },
          { tool: "outil_fantome", input: { x: "1" } },
        ],
      }, me);
      expect("error" in unknown && unknown.error).toMatch(/Étape 2/);
    });

    it("EXÉCUTION réelle : create_task puis create_task « Suite de $prev.title » — la substitution nourrit la 2e étape", async () => {
      const me = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
      const p = await buildProposal("action_plan", {
        summary: "Deux tâches chaînées",
        steps: [
          { tool: "create_task", input: { title: `${TAG} Préparer le brief` } },
          { tool: "create_task", input: { title: `Relire : $prev.title` } },
        ],
      }, me);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const r = await performAction(me, p.payload);
      expect(r.ok).toBe(true);
      expect(r.message).toContain("2/2");
      const follow = await prisma.task.findFirst({ where: { title: `Relire : ${TAG} Préparer le brief` } });
      expect(follow).not.toBeNull();
      await prisma.task.deleteMany({ where: { title: { contains: `${TAG} Préparer le brief` } } });
    });

    it("MAILLON CASSÉ : la chaîne s'arrête, le reçu dit où, rien n'est tenté après", async () => {
      const me = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
      const p = await buildProposal("action_plan", {
        summary: "Chaîne fragile",
        steps: [
          { tool: "create_task", input: { title: `${TAG} Maillon 1` } },
          { tool: "create_task", input: { title: "$prev.champInexistant" } },
          { tool: "create_task", input: { title: `${TAG} Jamais atteint`, description: "$prev.title" } },
        ],
      }, me);
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const r = await performAction(me, p.payload);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/interrompu à l'étape 2/);
      expect(r.error).toContain("non tentée");
      const never = await prisma.task.findFirst({ where: { title: `${TAG} Jamais atteint` } });
      expect(never).toBeNull();
      await prisma.task.deleteMany({ where: { title: `${TAG} Maillon 1` } });
    });
  });

  describe("bulk_action — une carte pour N cibles, reçus par cible", () => {
  it("LOT CRITIQUE : 2 suppressions définitives → UNE carte, niveau CRITICAL, ressaisie « LOT 2 », 2 items résolus", async () => {
    await prisma.regulatoryProduct.createMany({
      data: [
        { reference: `${TAG}-RB-1`, dci: `${TAG} Alpha`, status: "SUBMITTED" },
        { reference: `${TAG}-RB-2`, dci: `${TAG} Beta`, status: "SUBMITTED" },
      ],
    });
    const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
    const p = await buildProposal("bulk_action", {
      tool: "delete_record",
      targets: [`${TAG}-RB-1`, `${TAG}-RB-2`],
      params: { kind: "REGULATORY_PRODUCT" },
    }, sa);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("bulk_action");
    expect(p.level).toBe("CRITICAL");
    expect(p.confirmText).toBe("LOT 2");
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "bulk_action" }>;
    expect(payload.innerTool).toBe("delete_record");
    expect(payload.items).toHaveLength(2);
    expect(payload.items.every((i) => i.payload.kind === "delete_record")).toBe(true);
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: `${TAG}-RB` } } });
  });

  it("cible fautive : le lot se prépare SANS elle et le dit (jamais une carte muette)", async () => {
    await prisma.regulatoryProduct.create({ data: { reference: `${TAG}-RB-3`, dci: `${TAG} Gamma`, status: "SUBMITTED" } });
    const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
    const p = await buildProposal("bulk_action", {
      tool: "delete_record",
      targets: [`${TAG}-RB-3`, `${TAG}-INEXISTANT`],
      params: { kind: "REGULATORY_PRODUCT" },
    }, sa);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    const payload = p.payload as Extract<AssistantActionPayload, { kind: "bulk_action" }>;
    expect(payload.items).toHaveLength(1);
    expect(p.warnings.join(" ")).toContain("Non préparé");
    expect(p.warnings.join(" ")).toContain(`${TAG}-INEXISTANT`);
    await prisma.regulatoryProduct.deleteMany({ where: { reference: `${TAG}-RB-3` } });
  });

  it("EXÉCUTION réelle : « demande la même tâche à Lina et Walid » → 2 demandes REQUESTED par le cœur canonique, reçu par cible", async () => {
    const requester = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "DIRECTION", ownerId, `${TAG} Karim`);
    const p = await buildProposal("bulk_action", {
      tool: "create_task",
      targets: [`${TAG} Lina`, `${TAG} Walid`],
      params: { title: `${TAG} Pointer les stocks`, priority: "HIGH" },
    }, requester);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.level).toBeUndefined();

    const r = await performAction(requester, p.payload);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("2/2");
    expect(r.message).toContain("✓");
    const created = await prisma.task.findMany({ where: { title: `${TAG} Pointer les stocks` } });
    expect(created).toHaveLength(2);
    expect(created.every((t) => t.status === "REQUESTED" && t.requestedAt !== null)).toBe(true);
    expect(new Set(created.map((t) => t.assignedToId))).toEqual(new Set([colleagueId, outsiderId]));
  });

  it("garde-fous : outil non groupable refusé, cible unique renvoyée vers l'outil direct", async () => {
    const sa = userWith({}, "SUPER_ADMIN", ownerId, `${TAG} Karim`);
    const bad = await buildProposal("bulk_action", { tool: "update_salary", targets: ["a", "b"] }, sa);
    expect("error" in bad && bad.error).toContain("groupables");
    const single = await buildProposal("bulk_action", { tool: "create_task", targets: [`${TAG} Lina`] }, sa);
    expect("error" in single && single.error).toMatch(/DEUX cibles/);
  });
  });
});
