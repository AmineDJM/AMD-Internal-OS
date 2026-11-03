import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, performAction } from "@/lib/assistant";
import { getAppSettings } from "@/lib/settings";

/**
 * GOLDEN RÉGRESSION — « le Chief fait tout ce que l'écran autorise, par les mêmes circuits » :
 *
 *   • DEMANDE DE TÂCHE : assigner à un collègue via l'assistant passe par le CŒUR canonique
 *     (`lib/tasks/create-core.ts`) — statut REQUESTED, `requestedAt`, notification POP-UP,
 *     acceptation/refus — plus jamais une tâche déposée en douce dans la liste de quelqu'un.
 *   • RELANCE Regulatory (`request_regulatory_status_update`) : porte supervision, destinataires
 *     montrés AVANT la confirmation, refus net quand personne n'est à relancer.
 *   • CORBEILLE : restaurer (`restore_record`) et détruire réellement (`purge_record`, CRITIQUE
 *     avec ressaisie) — résolution par le nom affiché, jamais un choix silencieux.
 *   • COMPTES : activer/désactiver (`set_account_active`, jamais soi-même) et rôles
 *     (`set_account_role`, secondaire jamais Super Admin) — mêmes règles que l'écran.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name = "PDG"): CurrentUser {
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

const TAG = `__saw__${Date.now()}`;
let adminId = "";
let yasmineId = ""; // collègue actif (destinataire de la demande de tâche + responsable du dossier)
let dormantId = ""; // compte INACTIF (cible de la réactivation)

suite("le Chief fait tout — demandes de tâches, relance, corbeille, comptes", () => {
  beforeAll(async () => {
    const [admin, yasmine, dormant] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Yasmine`, email: `${TAG}y@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG} Dormant`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE", isActive: false } }),
    ]);
    adminId = admin.id;
    yasmineId = yasmine.id;
    dormantId = dormant.id;
    await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-9`, dci: `${TAG} Rifampicine`, status: "SUBMITTED", responsibleId: yasmineId },
    });
    await prisma.deletedRecord.createMany({
      data: [
        { kind: "REGULATORY_PRODUCT", label: "dossier réglementaire", name: `${TAG}-DEL-1 — Amoxicilline`, sourceId: "src-1", payload: {} },
        { kind: "EVENT", label: "événement", name: `${TAG} Symposium détruit`, sourceId: "src-2", payload: {}, restoredAt: new Date() },
      ],
    });
  });

  afterAll(async () => {
    const tasks = await prisma.task.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: tasks.map((t) => t.id) } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { body: { startsWith: TAG } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("DEMANDE DE TÂCHE : la carte dit le circuit (accepter/refuser) et l'exécution passe par le cœur canonique", async () => {
    const admin = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("create_task", {
      title: `${TAG} Préparer le dossier ANPP`, assigneeName: `${TAG} Yasmine`, dueDate: "2026-09-15", priority: "HIGH",
    }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.title).toContain("Demander une tâche");
    expect(p.warnings.join(" ")).toMatch(/ACCEPTER ou.*REFUSER/i);
    expect(JSON.stringify(p.fields)).toContain("2026-09-15");

    const r = await performAction(admin, p.payload);
    expect(r.ok).toBe(true);
    const task = await prisma.task.findFirstOrThrow({ where: { title: `${TAG} Préparer le dossier ANPP` } });
    // LE CIRCUIT DE L'ÉCRAN : née d'une DEMANDE — pas une ligne déposée en douce.
    expect(task.status).toBe("REQUESTED");
    expect(task.requestedAt).not.toBeNull();
    expect(task.dueDate?.toISOString().slice(0, 10)).toBe("2026-09-15");
    const popup = await prisma.notification.findFirst({ where: { userId: yasmineId, body: task.title } });
    expect(popup?.popup).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "TASK", entityId: task.id, module: "Assistant IA" } });
    expect(audit?.summary).toMatch(/Demande de tâche/);
  });

  it("DEMANDE DE TÂCHE : pour soi-même, une simple to-do (personne n'accepte ce qu'il s'impose)", async () => {
    const admin = userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "SUPER_ADMIN", adminId);
    const r = await performAction(admin, { kind: "create_task", title: `${TAG} Ma propre to-do` });
    expect(r.ok).toBe(true);
    const task = await prisma.task.findFirstOrThrow({ where: { title: `${TAG} Ma propre to-do` } });
    expect(task.status).toBe("TODO");
    expect(task.requestedAt).toBeNull();
  });

  it("RELANCE Regulatory : destinataires montrés AVANT la confirmation ; sans personne à relancer, refus net", async () => {
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("request_regulatory_status_update", { reference: `${TAG}-REG-9`, note: "Point hebdo" }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("request_regulatory_status_update");
    expect(JSON.stringify(p.fields)).toContain(`${TAG} Yasmine`);
    expect(JSON.stringify(p.fields)).toContain("Point hebdo");
    expect(p.warnings.join(" ")).toMatch(/PAS modifié/);

    await prisma.regulatoryProduct.create({ data: { reference: `${TAG}-REG-10`, dci: `${TAG} Orphelin`, status: "SUBMITTED" } });
    const empty = await buildProposal("request_regulatory_status_update", { reference: `${TAG}-REG-10` }, admin);
    expect("error" in empty && empty.error).toMatch(/ni responsable/);
  });

  it("RELANCE Regulatory : hors supervision (rôle non configuré), la porte de l'écran refuse", async () => {
    const settings = await getAppSettings();
    if (settings.regulatorySupervisorRoles.includes("MEDICAL_DELEGATE")) return; // configuration locale inhabituelle : la porte serait ouverte, le refus ne se teste pas
    const delegate = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "MEDICAL_DELEGATE", yasmineId, `${TAG} Yasmine`);
    const p = await buildProposal("request_regulatory_status_update", { reference: `${TAG}-REG-9` }, delegate);
    expect("error" in p && p.error).toMatch(/supervision/);
  });

  it("CORBEILLE — restaurer : résolution par le nom affiché, entrée déjà restaurée écartée", async () => {
    const admin = userWith({}, "SUPER_ADMIN", adminId);
    const p = await buildProposal("restore_record", { name: `${TAG}-DEL-1` }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("restore_record");
    expect(p.title).toContain("Amoxicilline");
    expect(JSON.stringify(p.fields)).toContain("pièces jointes");
    // L'événement déjà RESTAURÉ n'est pas proposable à la restauration.
    const gone = await buildProposal("restore_record", { name: `${TAG} Symposium détruit` }, admin);
    expect("error" in gone && gone.error).toMatch(/Aucune entrée/);
  });

  it("CORBEILLE — détruire : proposition CRITIQUE avec ressaisie ; l'entrée restaurée reste purgeable avec avertissement", async () => {
    const admin = userWith({}, "SUPER_ADMIN", adminId);
    const p = await buildProposal("purge_record", { name: `${TAG}-DEL-1` }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.level).toBe("CRITICAL");
    expect(p.confirmText).toBe(`${TAG}-DEL-1`);
    expect(JSON.stringify(p.fields)).toMatch(/EFFACÉS/);

    const restored = await buildProposal("purge_record", { name: `${TAG} Symposium détruit` }, admin);
    expect("error" in restored).toBe(false);
    if (!("error" in restored)) expect(restored.warnings.join(" ")).toMatch(/déjà été RESTAURÉE/);
  });

  it("CORBEILLE : réservée au Super Admin — la même porte que l'écran Administration", async () => {
    const direction = userWith({ REGULATORY: ["VIEW"] }, "DIRECTION", yasmineId);
    const p = await buildProposal("restore_record", { name: `${TAG}-DEL-1` }, direction);
    expect("error" in p && p.error).toMatch(/Super Admin/);
    const p2 = await buildProposal("purge_record", { name: `${TAG}-DEL-1` }, direction);
    expect("error" in p2 && p2.error).toMatch(/Super Admin/);
  });

  it("COMPTES — réactiver un compte inactif : avant → après affiché ; jamais sur son propre compte", async () => {
    const admin = userWith({}, "SUPER_ADMIN", adminId, `${TAG} Admin`);
    const p = await buildProposal("set_account_active", { personName: `${TAG} Dormant`, active: true }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.level).toBe("SENSITIVE");
    expect(JSON.stringify(p.fields)).toContain("inactif → actif");
    const payload = p.payload as { userId: string; active: boolean };
    expect(payload.userId).toBe(dormantId);
    expect(payload.active).toBe(true);

    const self = await buildProposal("set_account_active", { personName: `${TAG} Admin`, active: false }, admin);
    expect("error" in self && self.error).toMatch(/propre compte/);
    const noop = await buildProposal("set_account_active", { personName: `${TAG} Dormant`, active: false }, admin);
    expect("error" in noop && noop.error).toMatch(/déjà inactif/);
  });

  it("COMPTES — rôles : avant → après affiché ; secondaire jamais Super Admin ; rôle inconnu refusé", async () => {
    const admin = userWith({}, "SUPER_ADMIN", adminId, `${TAG} Admin`);
    const p = await buildProposal("set_account_role", { personName: `${TAG} Yasmine`, role: "HEAD_OF_REGULATORY" }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.level).toBe("SENSITIVE");
    const payload = p.payload as { role: string | null; roleBefore: string; secondaryRole: string | null };
    expect(payload.role).toBe("HEAD_OF_REGULATORY");
    expect(payload.roleBefore).toBe("REGULATORY_ASSISTANT");
    expect(payload.secondaryRole).toBeNull();

    const escalade = await buildProposal("set_account_role", { personName: `${TAG} Yasmine`, secondaryRole: "SUPER_ADMIN" }, admin);
    expect("error" in escalade && escalade.error).toMatch(/anti-escalade/);
    const inconnu = await buildProposal("set_account_role", { personName: `${TAG} Yasmine`, role: "GRAND_MANITOU" }, admin);
    expect("error" in inconnu && inconnu.error).toMatch(/inconnu/);
  });

  it("ACTION NATIVE FINANCES (échec réel corrigé) : « Demander l'actualisation des soldes » se propose telle quelle", async () => {
    const admin = userWith({}, "SUPER_ADMIN", adminId, `${TAG} Admin`);
    const p = await buildProposal("request_treasury_update", { note: "Avant le conseil de lundi" }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("request_treasury_update");
    expect(p.title).toBe("Demander l'actualisation des soldes");
    expect(JSON.stringify(p.fields)).toContain("Responsables Finances");
    expect(JSON.stringify(p.fields)).toContain("Avant le conseil de lundi");
    expect(p.warnings.join(" ")).toMatch(/PAS modifiés/);

    // LA MÊME PORTE QUE LE BOUTON « Banque & paiements », et elle s'est RESSERRÉE (2026-09) :
    // le geste sonne chez tous les responsables Finances, si bien qu'ouvert à toute la direction
    // il devenait une sonnerie que plus personne n'écoutait. Le Super Admin, et lui seul.
    const delegate = userWith({}, "MEDICAL_DELEGATE", yasmineId, `${TAG} Yasmine`);
    expect("error" in (await buildProposal("request_treasury_update", {}, delegate))).toBe(true);

    // Le cas qui compte pour la NOUVELLE règle : une vision globale ne suffit plus.
    const dg = userWith({ FINANCES: ["VIEW", "UPDATE"] }, "GENERAL_MANAGER", yasmineId, `${TAG} DG`);
    const refuseDg = await buildProposal("request_treasury_update", {}, dg);
    expect("error" in refuseDg && refuseDg.error).toMatch(/Super Admin/);
  });

  it("COMPTES : réservés au Super Admin — un directeur n'y touche pas", async () => {
    const direction = userWith({ RH: ["VIEW", "UPDATE"] }, "DIRECTION", yasmineId);
    const p = await buildProposal("set_account_active", { personName: `${TAG} Dormant`, active: true }, direction);
    expect("error" in p && p.error).toMatch(/Super Admin/);
    const p2 = await buildProposal("set_account_role", { personName: `${TAG} Yasmine`, role: "DIRECTION" }, direction);
    expect("error" in p2 && p2.error).toMatch(/Super Admin/);
  });
});
