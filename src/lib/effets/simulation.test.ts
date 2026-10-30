// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerAction } from "@/lib/actions/executer";
import { personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { simulerEnDiff, simulerGeste } from "./simulation";

/**
 * LA SIMULATION, SUR LA VRAIE BASE ET LES VRAIES ACTIONS (J7, décision 0029) — aucun `vi.mock` : l'action de l'écran
 * s'exécute dans une transaction annulée, ses écritures sont capturées, rien ne reste.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sim__${Date.now()}`;
let moi: CurrentUser;
let karim = "";

suite("la simulation transactionnelle (J7)", () => {
  beforeAll(async () => {
    const id = (await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    karim = (await prisma.user.create({ data: { name: `${TAG}Karim`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } })).id;
    moi = (await personneDuGeste(id))!;
  });
  afterAll(async () => {
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("une écriture directe est capturée (avant, après, champs) puis annulée", async () => {
    const t = await prisma.task.create({ data: { title: `${TAG} base`, createdById: moi.id } });
    const issue = await simulerGeste(moi, { origine: "test" }, async () => {
      await prisma.task.update({ where: { id: t.id }, data: { title: `${TAG} renommée`, priority: "HIGH" }, select: { id: true } });
      return prisma.task.findUnique({ where: { id: t.id }, select: { title: true } });
    });
    expect(issue.ok).toBe(true);
    // DANS la simulation, l'action voit sa propre écriture…
    expect(issue.resultat?.title).toBe(`${TAG} renommée`);
    // … et après, rien n'est resté.
    expect((await prisma.task.findUnique({ where: { id: t.id } }))?.title).toBe(`${TAG} base`);
    const e = issue.capture.ecritures.find((x) => x.modele === "Task")!;
    expect(e.operation).toBe("UPDATE");
    expect(e.champs).toEqual(expect.arrayContaining(["priority", "title"]));
    expect(e.avant?.title).toBe(`${TAG} base`);
    expect(e.apres?.title).toBe(`${TAG} renommée`);
  });

  it("la vraie action de l'écran (créer une tâche pour Karim) : diff lisible, aucune ligne restée, empreinte stable", async () => {
    const appel = () => executerAction(moi, "task-actions:createTask", { title: `${TAG} Stand du congrès`, assignedToId: karim, priority: "HIGH" }, "assistant-ia");
    const a = await simulerEnDiff(moi, { origine: "carte" }, appel, (r) => (r.ok ? null : r.message));
    expect(a.diff.statut, a.diff.raison).toBe("SIMULE");
    expect(a.diff.resume).toMatch(/tâche « .*Stand du congrès » créé/);
    expect(a.diff.resume).toMatch(new RegExp(`notification à ${TAG}Karim`));
    expect(await prisma.task.count({ where: { title: { startsWith: `${TAG} Stand` } } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: karim } })).toBe(0);
    const b = await simulerEnDiff(moi, { origine: "carte" }, appel, (r) => (r.ok ? null : r.message));
    expect(b.diff.empreinte).toBe(a.diff.empreinte);
    const c = await simulerEnDiff(moi, { origine: "carte" }, () => executerAction(moi, "task-actions:createTask", { title: `${TAG} Autre`, assignedToId: karim }, "assistant-ia"), (r) => (r.ok ? null : r.message));
    expect(c.diff.empreinte).not.toBe(a.diff.empreinte);
  });

  it("une action qui refuse donne un diff en ÉCHEC, avec sa raison", async () => {
    const r = await simulerEnDiff(moi, { origine: "carte" }, () => executerAction(moi, "task-actions:startTask", { id: "inexistante" }, "assistant-ia"), (x) => (x.ok ? null : x.message));
    expect(r.diff.statut).toBe("ECHEC");
    expect(r.diff.raison).toBeTruthy();
  });
});
