import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { arreterMissionsDeDiagnostic } from "@/platform/in-process/missions/provider-smoke";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INSTRUMENT S'ARRÊTE AVEC LA MESURE (§118.132).
 *
 * Le smoke fournisseur tourne dans le Shell Render — en PRODUCTION — et laissait ses missions de
 * diagnostic vivantes : BLOCKED, elles étaient reprises par le battement, replanifiées jusqu'au
 * plafond et NOTIFIAIENT le dirigeant à chaque version de plan. Ce banc tient les deux moitiés :
 * la fonction arrête ce qui vit et respecte ce qui est fini ; et elle est APPELÉE là où il faut
 * (§118.49 — un corps testé sans son point d'appel ne prouve rien).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__smokearret${Date.now()}`;
let owner = "";

suite("les missions de diagnostic ne survivent pas au diagnostic", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "DIRECTION" }, select: { id: true },
    });
    owner = u.id;
  }, 60_000);
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: owner } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("arrête ce qui vit encore (BLOCKED, RUNNING), respecte ce qui est fini (COMPLETED), ignore les absents", async () => {
    const creer = async (status: string) => (await prisma.mission.create({
      data: { ownerId: owner, title: `${TAG} ${status}`, objective: "diagnostic", kind: "RUNTIME", status: status as never },
      select: { id: true },
    })).id;
    const bloquee = await creer("BLOCKED");
    const enCours = await creer("RUNNING");
    const finie = await creer("COMPLETED");

    const n = await arreterMissionsDeDiagnostic(owner, [bloquee, null, enCours, finie]);
    expect(n, "deux missions ont changé d'état ; la terminée ne compte pas").toBe(2);
    const statuts = await prisma.mission.findMany({ where: { id: { in: [bloquee, enCours, finie] } }, select: { id: true, status: true } });
    const par = Object.fromEntries(statuts.map((s) => [s.id, s.status]));
    expect(par[bloquee]).toBe("CANCELLED");
    expect(par[enCours]).toBe("CANCELLED");
    expect(par[finie], "un diagnostic réussi reste COMPLETED — on n'efface pas une preuve").toBe("COMPLETED");
    // Rejouer ne compte plus rien : l'arrêt est idempotent.
    expect(await arreterMissionsDeDiagnostic(owner, [bloquee, enCours, finie])).toBe(0);
    // Le journal porte la raison — c'est `annuler`, la porte canonique, qui a écrit.
    const ferme = await prisma.missionEvent.findFirst({ where: { missionId: bloquee, kind: "CLOSED" }, select: { summary: true } });
    expect(ferme?.summary ?? "").toMatch(/diagnostic terminé/);
  }, 60_000);

  it("POINT D'APPEL : le smoke fournisseur arrête ses missions APRÈS la mesure, et le deep smoke arrête celles qu'il garde", () => {
    const smoke = readFileSync(join(process.cwd(), "src/platform/in-process/missions/provider-smoke.ts"), "utf8");
    const appel = smoke.indexOf("out.missionsArretees = await arreterMissionsDeDiagnostic(user.id");
    expect(appel).toBeGreaterThan(0);
    // Après la boucle des scénarios (la mesure), jamais avant : on n'arrête pas ce qu'on mesure.
    expect(appel).toBeGreaterThan(smoke.indexOf("for (const sc of liste) {"));
    // Et avant la conclusion du rapport, pour que la ligne « missions de banc arrêtées » soit vraie.
    expect(appel).toBeLessThan(smoke.indexOf("const r = finir();"));

    const deep = readFileSync(join(process.cwd(), "src/platform/in-process/missions/deep-smoke.ts"), "utf8");
    const garde = deep.indexOf("out.nettoyage.arretees = await arreterMissionsDeDiagnostic(user.id, ids)");
    expect(garde, "les missions GARDÉES pour inspection sont arrêtées, pas laissées au battement").toBeGreaterThan(0);
  });
});
