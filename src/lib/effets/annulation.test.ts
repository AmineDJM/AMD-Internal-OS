// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerAction } from "@/lib/actions/executer";
import { personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { sendSmartEmail } from "@/lib/mail-smart";
import { journaliserGeste } from "./journal";
import { annulerGeste, gestesDeLAssistant, planDAnnulation, type CompteRenduAnnulation, type IssueEffet } from "./annulation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNULATION, JUSTE, SUR 50 CAS RÉELS DE L'ERP (J7, décision 0029) — aucun `vi.mock`.
 *
 * Chaque cas : un VRAI geste de l'assistant (l'action de l'écran, sous le journal des effets), parfois le geste d'un
 * AUTRE ensuite (Karim lit la notification, Yasmine change la priorité, quelqu'un commente), puis « Annuler ». On
 * vérifie l'issue de chaque effet (annulé / compensé / impossible / sans objet) ET l'état réel de la base — en
 * particulier qu'AUCUNE annulation n'écrase une valeur changée depuis par quelqu'un d'autre (compté à part).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ann__${Date.now()}`;
let moi: CurrentUser;
let karim = "";
let yasmine = "";
let cas = 0;
let preservations = 0;

const act = async (id: string, entree: Record<string, unknown>) => {
  const r = await executerAction(moi, id, entree, "assistant-ia");
  if (!r.ok) throw new Error(`${id} : ${r.message}`);
  return r.retour;
};
/** Un geste de l'assistant, sous le journal (hors requête : la personne est rendue à `requireUser`). */
const geste = async (fn: () => Promise<unknown>, libelle = "cas") => {
  const r = await journaliserGeste(moi, { origine: "carte", libelle }, fn, { horsRequete: true });
  expect(r.gesteId).toBeTruthy();
  return r.gesteId!;
};
const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  cas += 1;
  const r = await annulerGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
/** Les issues par modèle — `{ Task: ["ANNULE"], Notification: ["IMPOSSIBLE"] }`. */
const parModele = async (gesteId: string, r: CompteRenduAnnulation): Promise<Record<string, IssueEffet[]>> => {
  const effets = await prisma.assistantEffet.findMany({ where: { gesteId }, select: { id: true, modele: true, acte: true } });
  const m = new Map(effets.map((e) => [e.id, e.modele ?? e.acte ?? "?"]));
  const out: Record<string, IssueEffet[]> = {};
  for (const d of r.details) (out[m.get(d.effetId)!] ??= []).push(d.issue);
  return out;
};
const tacheDe = (g: string) => prisma.assistantEffet.findFirst({ where: { gesteId: g, modele: "Task", operation: "CREATE" } }).then((e) => e!.enregistrementId!);
const nouvelleTache = async (data: Record<string, unknown> = {}) =>
  (await prisma.task.create({ data: { title: `${TAG} existante`, createdById: moi.id, ...data } })).id;
/** Une valeur changée par un AUTRE et laissée intacte par l'annulation : la propriété que J7 doit tenir. */
const preserve = (attendu: unknown, obtenu: unknown) => { expect(obtenu).toEqual(attendu); preservations += 1; };

suite("l'annulation honnête, sur 50 cas réels (J7)", () => {
  beforeAll(async () => {
    const id = (await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    karim = (await prisma.user.create({ data: { name: `${TAG}Karim`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } })).id;
    yasmine = (await prisma.user.create({ data: { name: `${TAG}Yasmine`, email: `${TAG}y@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } })).id;
    moi = (await personneDuGeste(id))!;
  });
  afterAll(async () => {
    const ids = [moi?.id, karim, yasmine].filter(Boolean);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.taskComment.deleteMany({ where: { task: { title: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.calendarEvent.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.meeting.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
    // LE COMPTE, ASSERTÉ : le banc doit couvrir 50 cas, et la propriété « rien d'écrasé » doit avoir été éprouvée.
    expect(cas).toBeGreaterThanOrEqual(50);
    expect(preservations).toBeGreaterThanOrEqual(10);
  });

  // ── CRÉATIONS ────────────────────────────────────────────────────────────────────────────
  describe("création", () => {
    it.each(["LOW", "MEDIUM", "HIGH", "CRITICAL"])("1–4. une tâche créée pour Karim (priorité %s), intacte : tâche et notification retirées", async (priority) => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} création ${priority}`, assignedToId: karim, priority }));
      const t = await tacheDe(g);
      const r = await annuler(g);
      expect(await parModele(g, r)).toMatchObject({ Task: ["ANNULE"], Notification: ["ANNULE"] });
      expect(await prisma.task.findUnique({ where: { id: t } })).toBeNull();
      expect(await prisma.notification.count({ where: { userId: karim, title: { contains: `${TAG} création ${priority}` } } })).toBe(0);
      expect(r.complet).toBe(true);
    });

    it("5. une tâche sans destinataire : seule la tâche, retirée", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} seule` }));
      const t = await tacheDe(g);
      const r = await annuler(g);
      expect(await parModele(g, r)).toEqual({ Task: ["ANNULE"] });
      expect(await prisma.task.findUnique({ where: { id: t } })).toBeNull();
    });

    it("6. Karim a LU la notification : elle est dite impossible à reprendre, la tâche est retirée", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} lue`, assignedToId: karim }));
      const notifs = (await prisma.assistantEffet.findMany({ where: { gesteId: g, modele: "Notification" } })).map((e) => e.enregistrementId!);
      await prisma.notification.updateMany({ where: { id: { in: notifs } }, data: { isRead: true } });
      const r = await annuler(g);
      const i = await parModele(g, r);
      expect(i.Notification).toEqual(["IMPOSSIBLE"]);
      expect(r.details.find((d) => d.issue === "IMPOSSIBLE")!.pourquoi).toMatch(/Karim l'a déjà lue/);
      expect(i.Task).toEqual(["ANNULE"]);
      preserve(notifs.length, await prisma.notification.count({ where: { id: { in: notifs } } }));
      expect(r.complet).toBe(false);
    });

    it("7. quelqu'un a COMMENTÉ la tâche depuis : compensée (CANCELLED), le commentaire reste", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} commentée` }));
      const t = await tacheDe(g);
      await prisma.taskComment.create({ data: { taskId: t, authorId: yasmine, body: "J'ai commencé" } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["COMPENSE"]);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.status).toBe("CANCELLED");
      preserve(1, await prisma.taskComment.count({ where: { taskId: t } }));
    });

    it("8. quelqu'un a RENOMMÉ la tâche depuis : compensée, son titre gardé", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} à renommer` }));
      const t = await tacheDe(g);
      await prisma.task.update({ where: { id: t }, data: { title: `${TAG} renommée par Yasmine` } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["COMPENSE"]);
      const apres = await prisma.task.findUnique({ where: { id: t } });
      preserve(`${TAG} renommée par Yasmine`, apres?.title);
      expect(apres?.status).toBe("CANCELLED");
    });

    it("9. quelqu'un a DÉMARRÉ la tâche depuis : impossible, son statut gardé", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} démarrée` }));
      const t = await tacheDe(g);
      await prisma.task.update({ where: { id: t }, data: { status: "IN_PROGRESS" } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["IMPOSSIBLE"]);
      preserve("IN_PROGRESS", (await prisma.task.findUnique({ where: { id: t } }))?.status);
    });

    it("10. la tâche a déjà été supprimée par ailleurs : sans objet", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} déjà partie` }));
      await prisma.task.delete({ where: { id: await tacheDe(g) } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["SANS_OBJET"]);
    });

    it("11. un rendez-vous créé : retiré", async () => {
      const g = await geste(() => act("calendar-actions:createCalendarEvent", { title: `${TAG} rdv`, start: "2026-12-01T10:00" }));
      const r = await annuler(g);
      expect((await parModele(g, r)).CalendarEvent).toEqual(["ANNULE"]);
      expect(await prisma.calendarEvent.count({ where: { title: `${TAG} rdv` } })).toBe(0);
    });

    it("12. un rendez-vous créé puis déplacé par quelqu'un : impossible (pas de statut d'annulation), l'heure gardée", async () => {
      const g = await geste(() => act("calendar-actions:createCalendarEvent", { title: `${TAG} rdv déplacé`, start: "2026-12-01T10:00" }));
      const e = await prisma.calendarEvent.findFirstOrThrow({ where: { title: `${TAG} rdv déplacé` } });
      const nouveau = new Date("2026-12-02T09:00:00Z");
      await prisma.calendarEvent.update({ where: { id: e.id }, data: { startAt: nouveau } });
      const r = await annuler(g);
      expect((await parModele(g, r)).CalendarEvent).toEqual(["IMPOSSIBLE"]);
      preserve(nouveau.toISOString(), (await prisma.calendarEvent.findUnique({ where: { id: e.id } }))?.startAt.toISOString());
    });

    it("13. une réunion avec Karim : réunion et invitation retirées", async () => {
      const g = await geste(() => act("meeting-actions:createMeeting", { title: `${TAG} réunion`, participantIds: [karim], scheduledAt: "2026-12-03T14:00" }));
      const r = await annuler(g);
      const i = await parModele(g, r);
      expect(i.Meeting).toEqual(["ANNULE"]);
      expect(i.MeetingParticipant?.every((x) => x === "ANNULE")).toBe(true);
      // La poussée d'invitation, elle, est partie (ou l'aurait été) : dite impossible, jamais « annulée ».
      expect(i.NOTIFICATION_PUSH ?? []).not.toContain("ANNULE");
      expect(await prisma.meeting.count({ where: { title: `${TAG} réunion` } })).toBe(0);
    });

    it("14. un dossier du Drive créé : retiré", async () => {
      const g = await geste(() => act("drive-actions:createFolder", { name: `${TAG} dossier` }));
      const r = await annuler(g);
      expect((await parModele(g, r)).DriveNode).toEqual(["ANNULE"]);
      expect(await prisma.driveNode.count({ where: { name: `${TAG} dossier` } })).toBe(0);
    });

    it("15. un dossier du Drive où quelqu'un a rangé un fichier depuis : impossible (un élément s'y rattache), rien d'effacé", async () => {
      const g = await geste(() => act("drive-actions:createFolder", { name: `${TAG} dossier rempli` }));
      const d = await prisma.driveNode.findFirstOrThrow({ where: { name: `${TAG} dossier rempli` } });
      await prisma.driveNode.create({ data: { name: `${TAG} fichier de Yasmine`, type: "FOLDER", parentId: d.id, ownerId: yasmine } });
      const r = await annuler(g);
      expect((await parModele(g, r)).DriveNode).toEqual(["IMPOSSIBLE"]);
      expect(r.details[0].pourquoi).toMatch(/rattach/);
      preserve(1, await prisma.driveNode.count({ where: { parentId: d.id } }));
    });
  });

  // ── MODIFICATIONS ────────────────────────────────────────────────────────────────────────
  describe("modification", () => {
    it.each([["LOW", "HIGH"], ["MEDIUM", "CRITICAL"], ["HIGH", "LOW"], ["CRITICAL", "MEDIUM"]] as const)("16–19. priorité %s → %s par l'assistant : remise", async (de, vers) => {
      const t = await nouvelleTache({ priority: de });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, priority: vers }));
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["ANNULE"]);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.priority).toBe(de);
    });

    it.each([["LOW", "HIGH", "CRITICAL"], ["MEDIUM", "LOW", "HIGH"]] as const)("20–21. priorité %s → %s, puis Yasmine la met à %s : impossible, la sienne gardée", async (de, vers, yas) => {
      const t = await nouvelleTache({ priority: de });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, priority: vers }));
      await prisma.task.update({ where: { id: t }, data: { priority: yas } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["IMPOSSIBLE"]);
      preserve(yas, (await prisma.task.findUnique({ where: { id: t } }))?.priority);
    });

    it("22. échéance posée par l'assistant : retirée (remise à vide)", async () => {
      const t = await nouvelleTache();
      const g = await geste(() => act("task-actions:modifierTache", { id: t, dueDate: "2026-12-15" }));
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["ANNULE"]);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.dueDate).toBeNull();
    });

    it("23. échéance déplacée par l'assistant : l'ancienne date revient", async () => {
      const avant = new Date("2026-11-20T00:00:00Z");
      const t = await nouvelleTache({ dueDate: avant });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, dueDate: "2026-12-15" }));
      await annuler(g);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.dueDate?.toISOString()).toBe(avant.toISOString());
    });

    it("24. échéance ET priorité changées, Yasmine retouche la priorité : l'échéance revient, sa priorité reste", async () => {
      const t = await nouvelleTache({ priority: "LOW" });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, priority: "HIGH", dueDate: "2026-12-15" }));
      await prisma.task.update({ where: { id: t }, data: { priority: "CRITICAL" } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["ANNULE"]);
      expect(r.details[0].pourquoi).toMatch(/laissé/);
      const apres = await prisma.task.findUnique({ where: { id: t } });
      expect(apres?.dueDate).toBeNull();
      preserve("CRITICAL", apres?.priority);
    });

    it("25. tâche réattribuée à Karim : rendue à son ancien titulaire, la notification de Karim retirée", async () => {
      const t = await nouvelleTache({ assignedToId: yasmine });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, assignedToId: karim }));
      const r = await annuler(g);
      expect(r.compte.IMPOSSIBLE, JSON.stringify(r.details.filter((d) => d.issue === "IMPOSSIBLE"))).toBe(0);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.assignedToId).toBe(yasmine);
    });

    it("26. réattribuée, puis Karim l'a lue et la tâche est réattribuée à Yasmine par quelqu'un : rien n'est écrasé", async () => {
      const t = await nouvelleTache({ assignedToId: moi.id });
      const g = await geste(() => act("task-actions:modifierTache", { id: t, assignedToId: karim }));
      await prisma.notification.updateMany({ where: { userId: karim }, data: { isRead: true } });
      await prisma.task.update({ where: { id: t }, data: { assignedToId: yasmine } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["IMPOSSIBLE"]);
      preserve(yasmine, (await prisma.task.findUnique({ where: { id: t } }))?.assignedToId);
    });

    it.each(["IN_PROGRESS", "DONE"])("27–28. statut mis à %s par l'assistant : remis à TODO", async (statut) => {
      const t = await nouvelleTache({ status: "TODO" });
      const g = await geste(() => act("task-actions:updateTaskStatus", { id: t, status: statut }));
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["ANNULE"]);
      const apres = await prisma.task.findUnique({ where: { id: t } });
      expect(apres?.status).toBe("TODO");
      expect(apres?.completedAt).toBeNull();
    });

    it("29. statut mis à DONE, puis rouvert par quelqu'un : impossible, sa réouverture gardée", async () => {
      const t = await nouvelleTache({ status: "TODO" });
      const g = await geste(() => act("task-actions:updateTaskStatus", { id: t, status: "DONE" }));
      await prisma.task.update({ where: { id: t }, data: { status: "IN_PROGRESS", completedAt: null } });
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["IMPOSSIBLE"]);
      preserve("IN_PROGRESS", (await prisma.task.findUnique({ where: { id: t } }))?.status);
    });

    it("30. tâche démarrée par l'assistant : revenue à faire", async () => {
      const t = await nouvelleTache({ status: "TODO", assignedToId: moi.id });
      const g = await geste(() => act("task-actions:startTask", { id: t }));
      await annuler(g);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.status).toBe("TODO");
    });

    it("31. rendez-vous renommé par l'assistant : l'ancien titre revient", async () => {
      const e = await prisma.calendarEvent.create({ data: { title: `${TAG} rdv initial`, startAt: new Date("2026-12-05T10:00:00Z"), organizerId: moi.id } });
      const g = await geste(() => act("calendar-actions:updateCalendarEvent", { id: e.id, title: `${TAG} rdv renommé`, start: "2026-12-05T10:00" }));
      await annuler(g);
      expect((await prisma.calendarEvent.findUnique({ where: { id: e.id } }))?.title).toBe(`${TAG} rdv initial`);
    });

    it("32. rendez-vous renommé, puis renommé encore par quelqu'un : son titre gardé", async () => {
      const e = await prisma.calendarEvent.create({ data: { title: `${TAG} rdv A`, startAt: new Date("2026-12-05T10:00:00Z"), organizerId: moi.id } });
      const g = await geste(() => act("calendar-actions:updateCalendarEvent", { id: e.id, title: `${TAG} rdv B`, start: "2026-12-05T10:00" }));
      await prisma.calendarEvent.update({ where: { id: e.id }, data: { title: `${TAG} rdv C (Yasmine)` } });
      const r = await annuler(g);
      expect(r.compte.ANNULE + r.compte.IMPOSSIBLE).toBeGreaterThan(0);
      preserve(`${TAG} rdv C (Yasmine)`, (await prisma.calendarEvent.findUnique({ where: { id: e.id } }))?.title);
    });

    it("33. dossier renommé par l'assistant : l'ancien nom revient", async () => {
      const d = await prisma.driveNode.create({ data: { name: `${TAG} nom d'origine`, type: "FOLDER", ownerId: moi.id } });
      const g = await geste(() => act("drive-actions:renameNode", { id: d.id, name: `${TAG} nom de l'assistant` }));
      await annuler(g);
      expect((await prisma.driveNode.findUnique({ where: { id: d.id } }))?.name).toBe(`${TAG} nom d'origine`);
    });

    it("34. dossier renommé, puis renommé par Yasmine : impossible, son nom gardé", async () => {
      const d = await prisma.driveNode.create({ data: { name: `${TAG} n1`, type: "FOLDER", ownerId: moi.id } });
      const g = await geste(() => act("drive-actions:renameNode", { id: d.id, name: `${TAG} n2` }));
      await prisma.driveNode.update({ where: { id: d.id }, data: { name: `${TAG} n3 (Yasmine)` } });
      const r = await annuler(g);
      expect((await parModele(g, r)).DriveNode).toEqual(["IMPOSSIBLE"]);
      preserve(`${TAG} n3 (Yasmine)`, (await prisma.driveNode.findUnique({ where: { id: d.id } }))?.name);
    });

    it("35. dossier déplacé par l'assistant : il revient à sa place", async () => {
      const a = await prisma.driveNode.create({ data: { name: `${TAG} parent A`, type: "FOLDER", ownerId: moi.id } });
      const b = await prisma.driveNode.create({ data: { name: `${TAG} parent B`, type: "FOLDER", ownerId: moi.id } });
      const d = await prisma.driveNode.create({ data: { name: `${TAG} à déplacer`, type: "FOLDER", ownerId: moi.id, parentId: a.id } });
      const g = await geste(() => act("drive-actions:moveNode", { id: d.id, targetId: b.id }));
      await annuler(g);
      expect((await prisma.driveNode.findUnique({ where: { id: d.id } }))?.parentId).toBe(a.id);
    });

    it("36. réunion renommée par l'assistant : l'ancien titre revient", async () => {
      const m = await prisma.meeting.create({ data: { title: `${TAG} réunion 1`, organizerId: moi.id, slug: `${TAG}-r1`, publicToken: `${TAG}-t1` } });
      const g = await geste(() => act("meeting-actions:updateMeeting", { id: m.id, title: `${TAG} réunion 2` }));
      await annuler(g);
      expect((await prisma.meeting.findUnique({ where: { id: m.id } }))?.title).toBe(`${TAG} réunion 1`);
    });

    it("37. deux gestes successifs de l'assistant sur le même champ : défaire le PREMIER seul est refusé (le second l'a changé)", async () => {
      const t = await nouvelleTache({ priority: "LOW" });
      const g1 = await geste(() => act("task-actions:modifierTache", { id: t, priority: "MEDIUM" }));
      await geste(() => act("task-actions:modifierTache", { id: t, priority: "HIGH" }));
      const r = await annuler(g1);
      expect((await parModele(g1, r)).Task).toEqual(["IMPOSSIBLE"]);
      preserve("HIGH", (await prisma.task.findUnique({ where: { id: t } }))?.priority);
    });

    it("38. … et défaire le SECOND puis le PREMIER (l'ordre inverse) rend l'état d'origine", async () => {
      const t = await nouvelleTache({ priority: "LOW" });
      const g1 = await geste(() => act("task-actions:modifierTache", { id: t, priority: "MEDIUM" }));
      const g2 = await geste(() => act("task-actions:modifierTache", { id: t, priority: "HIGH" }));
      await annuler(g2);
      await annuler(g1);
      expect((await prisma.task.findUnique({ where: { id: t } }))?.priority).toBe("LOW");
    });
  });

  // ── SUPPRESSIONS ─────────────────────────────────────────────────────────────────────────
  describe("suppression", () => {
    it.each([1, 2, 3])("39–41. tâche supprimée sans rien d'attaché (%i) : recréée à l'identique, même identifiant", async (n) => {
      const t = await nouvelleTache({ title: `${TAG} à supprimer ${n}`, priority: "HIGH" });
      const g = await geste(() => act("task-actions:deleteTask", { id: t }));
      expect(await prisma.task.findUnique({ where: { id: t } })).toBeNull();
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["ANNULE"]);
      const revenue = await prisma.task.findUnique({ where: { id: t } });
      expect(revenue?.title).toBe(`${TAG} à supprimer ${n}`);
      expect(revenue?.priority).toBe("HIGH");
    });

    it("42. tâche supprimée AVEC ses commentaires (cascade) : impossible, et dit pourquoi", async () => {
      const t = await nouvelleTache({ title: `${TAG} avec commentaires` });
      await prisma.taskComment.create({ data: { taskId: t, authorId: yasmine, body: "note" } });
      const g = await geste(() => act("task-actions:deleteTask", { id: t }));
      const r = await annuler(g);
      expect((await parModele(g, r)).Task).toEqual(["IMPOSSIBLE"]);
      expect(r.details.find((d) => d.issue === "IMPOSSIBLE")!.pourquoi).toMatch(/cascade/);
      expect(await prisma.task.findUnique({ where: { id: t } })).toBeNull();
    });

    it("43. rendez-vous supprimé : recréé à l'identique", async () => {
      const e = await prisma.calendarEvent.create({ data: { title: `${TAG} rdv à supprimer`, startAt: new Date("2026-12-09T08:00:00Z"), organizerId: moi.id } });
      const g = await geste(() => act("calendar-actions:deleteCalendarEvent", { id: e.id }));
      await annuler(g);
      expect((await prisma.calendarEvent.findUnique({ where: { id: e.id } }))?.title).toBe(`${TAG} rdv à supprimer`);
    });

    it("44. réunion supprimée : recréée à l'identique", async () => {
      const m = await prisma.meeting.create({ data: { title: `${TAG} réunion à supprimer`, organizerId: moi.id, slug: `${TAG}-r2`, publicToken: `${TAG}-t2` } });
      const g = await geste(() => act("meeting-actions:deleteMeeting", { id: m.id }));
      const r = await annuler(g);
      expect(r.compte.IMPOSSIBLE, JSON.stringify(r.details.filter((d) => d.issue === "IMPOSSIBLE"))).toBe(0);
      expect((await prisma.meeting.findUnique({ where: { id: m.id } }))?.title).toBe(`${TAG} réunion à supprimer`);
    });
  });

  // ── NOTIFICATIONS ET MESSAGES ────────────────────────────────────────────────────────────
  describe("notification", () => {
    it("45. un commentaire qui prévient Karim : commentaire et notification retirés", async () => {
      const t = await nouvelleTache({ assignedToId: karim });
      const g = await geste(() => act("task-actions:addTaskComment", { id: t, body: `${TAG} commentaire` }));
      const r = await annuler(g);
      expect(r.compte.IMPOSSIBLE, JSON.stringify(r.details.filter((d) => d.issue === "IMPOSSIBLE"))).toBe(0);
      expect(await prisma.taskComment.count({ where: { taskId: t } })).toBe(0);
    });

    it("46. … Karim l'a lue : la notification est dite impossible, le commentaire est retiré", async () => {
      const t = await nouvelleTache({ assignedToId: karim, title: `${TAG} commentaire lu` });
      const g = await geste(() => act("task-actions:addTaskComment", { id: t, body: `${TAG} commentaire lu` }));
      const avant = await prisma.notification.count({ where: { userId: karim, isRead: false } });
      await prisma.notification.updateMany({ where: { userId: karim }, data: { isRead: true } });
      const r = await annuler(g);
      const i = await parModele(g, r);
      if (avant > 0) expect(i.Notification).toEqual(["IMPOSSIBLE"]);
      expect(i.TaskComment).toEqual(["ANNULE"]);
    });

    it("47. un courriel parti : impossible, avec le rectificatif à la place — jamais « annulé »", async () => {
      const g = await geste(async () => {
        await sendSmartEmail({ to: ["partenaire@exemple.dz"], subject: "Devis", text: "x" });
        return { ok: true };
      });
      const r = await annuler(g);
      expect(r.details).toEqual([expect.objectContaining({ issue: "IMPOSSIBLE", aLaPlace: expect.stringMatching(/rectificatif/) })]);
      expect(r.complet).toBe(false);
      expect(r.resume).toMatch(/PAS une annulation complète/);
    });
  });

  // ── PIÈCES ───────────────────────────────────────────────────────────────────────────────
  describe("pièce", () => {
    it("48. une tâche créée avec sa pièce jointe : la pièce et la tâche retirées", async () => {
      const fichier = new File([`contenu ${TAG}`], "devis.pdf", { type: "application/pdf" });
      const g = await geste(async () => {
        const { createTask } = await import("@/lib/actions/task-actions");
        const fd = new FormData();
        fd.set("title", `${TAG} avec pièce`);
        fd.append("files", fichier);
        return createTask(undefined, fd);
      });
      const r = await annuler(g);
      expect(r.compte.IMPOSSIBLE, JSON.stringify(r.details.filter((d) => d.issue === "IMPOSSIBLE"))).toBe(0);
      expect(await prisma.task.count({ where: { title: `${TAG} avec pièce` } })).toBe(0);
      expect(await prisma.document.count({ where: { name: "devis.pdf", uploadedById: moi.id } })).toBe(0);
    });
  });

  // ── L'ÉCRAN ET LES GARDES ────────────────────────────────────────────────────────────────
  describe("l'écran et ses gardes", () => {
    it("49. l'aperçu ne change RIEN ; un geste ne s'annule qu'une fois ; la liste le dit annulé", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} aperçu` }));
      const plan = await planDAnnulation(g, moi);
      expect("refus" in plan).toBe(false);
      expect(await prisma.task.count({ where: { title: `${TAG} aperçu` } })).toBe(1);
      await annuler(g);
      expect(await annulerGeste(g, moi)).toEqual({ refus: expect.stringMatching(/déjà été annulé/) });
      const liste = await gestesDeLAssistant(moi);
      expect(liste.find((x) => x.id === g)?.annuleLe).toBeTruthy();
    });

    it("50. un autre que la personne (non Super Admin) ne peut pas annuler son geste", async () => {
      const g = await geste(() => act("task-actions:createTask", { title: `${TAG} pas à Karim` }));
      const k = (await personneDuGeste(karim))!;
      expect(await annulerGeste(g, k)).toEqual({ refus: expect.stringMatching(/Seule la personne/) });
      expect(await prisma.task.count({ where: { title: `${TAG} pas à Karim` } })).toBe(1);
      await annuler(g);
    });
  });
});
