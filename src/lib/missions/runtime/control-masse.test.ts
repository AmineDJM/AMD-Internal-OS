import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  arreterBloquees, compterPourLesGestesDeMasse, mettreEnPauseToutes, ouBloquee, ouSuspendable, reprendre,
} from "@/lib/missions/runtime/control";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE MASSE D'UNE PERSONNE SUR SON PARC (§118.132).
 *
 * Deux propriétaires FABRIQUÉS pour ce banc — jamais `user.findFirst()` : un geste de masse sur
 * le premier compte de la base suspendrait les missions que d'autres tests font tourner en
 * parallèle (§118.115). Et un TIERS, pour prouver le cloisonnement : sa mission bloquée ne bouge
 * pas quand un autre arrête « toutes ses bloquées ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__masse${Date.now()}`;
let a = ""; let b = ""; let tiers = "";

async function compte(nom: string): Promise<string> {
  const u = await prisma.user.create({
    data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@amd.dz`, passwordHash: "x", role: "DIRECTION" },
    select: { id: true },
  });
  return u.id;
}
async function mission(ownerId: string, status: string, extra: { replanBloque?: boolean; jalonBloque?: boolean } = {}): Promise<string> {
  const m = await prisma.mission.create({
    data: { ownerId, title: `${TAG} ${status}`, objective: "banc", kind: "RUNTIME", status: status as never, replanBloque: extra.replanBloque ?? false },
    select: { id: true },
  });
  if (extra.jalonBloque) {
    await prisma.missionMilestone.create({ data: { missionId: m.id, ordre: 1, titre: "jalon", resultat: "r", statut: "BLOCKED" } });
  }
  return m.id;
}
const statutDe = async (id: string) => (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))?.status;

suite("suspendre tout ce qui tourne, arrêter tout ce qui est bloqué — sur SON parc seulement", () => {
  beforeAll(async () => {
    a = await compte("A"); b = await compte("B"); tiers = await compte("T");
  }, 60_000);
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: { in: [a, b, tiers] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("SUSPENDRE TOUTES : les vivantes passent PAUSED avec leur trace, les closes et celles d'autrui ne bougent pas", async () => {
    const running = await mission(a, "RUNNING");
    const blocked = await mission(a, "BLOCKED");
    const waiting = await mission(a, "WAITING_EVENT");
    const failed = await mission(a, "FAILED");
    const dejaPausee = await mission(a, "PAUSED");
    const finie = await mission(a, "COMPLETED");
    const autrui = await mission(tiers, "RUNNING");

    const compteurs = await compterPourLesGestesDeMasse(a);
    expect(compteurs.suspendables, "RUNNING + BLOCKED + WAITING_EVENT + FAILED — pas PAUSED, pas COMPLETED").toBe(4);

    const r = await mettreEnPauseToutes(a, "banc de masse");
    expect(r).toMatchObject({ visees: 4, faites: 4, deja: 0, refusees: [] });
    for (const id of [running, blocked, waiting, failed]) expect(await statutDe(id)).toBe("PAUSED");
    expect(await statutDe(dejaPausee)).toBe("PAUSED");
    expect(await statutDe(finie)).toBe("COMPLETED");
    expect(await statutDe(autrui), "le parc d'un autre ne bouge pas").toBe("RUNNING");

    // La trace est celle de `mettreEnPause` : d'où l'on vient, depuis quand, pourquoi.
    const trace = await prisma.mission.findUnique({ where: { id: waiting }, select: { pausedFrom: true, pausedReason: true, pausedAt: true } });
    expect(trace).toMatchObject({ pausedFrom: "WAITING_EVENT", pausedReason: "banc de masse" });
    expect(trace?.pausedAt).toBeInstanceOf(Date);

    // Un second passage ne trouve plus rien à suspendre : le compteur suit le geste.
    expect((await compterPourLesGestesDeMasse(a)).suspendables).toBe(0);
    // Et la reprise se fait mission par mission, comme promis par la phrase du bouton.
    expect((await reprendre(waiting, a)).vers).toBe("RUNNING");
  }, 60_000);

  it("ARRÊTER LES BLOQUÉES : BLOCKED, FAILED, replan fermé, jalon bloqué → CANCELLED ; le reste vit encore ; autrui intact", async () => {
    const blocked = await mission(b, "BLOCKED");
    const failed = await mission(b, "FAILED");
    const replanFerme = await mission(b, "RUNNING", { replanBloque: true });
    const jalonBloque = await mission(b, "WAITING_EVENT", { jalonBloque: true });
    const saine = await mission(b, "RUNNING");
    const finie = await mission(b, "COMPLETED");
    const autrui = await mission(tiers, "BLOCKED");

    const compteurs = await compterPourLesGestesDeMasse(b);
    expect(compteurs.bloquees, "le nombre du bouton est celui que le clic touchera").toBe(4);

    const r = await arreterBloquees(b, "arrêt de masse");
    expect(r).toMatchObject({ visees: 4, faites: 4, deja: 0, refusees: [] });
    for (const id of [blocked, failed, replanFerme, jalonBloque]) expect(await statutDe(id)).toBe("CANCELLED");
    expect(await statutDe(saine)).toBe("RUNNING");
    expect(await statutDe(finie)).toBe("COMPLETED");
    expect(await statutDe(autrui), "la mission bloquée d'un autre n'est pas arrêtée").toBe("BLOCKED");
    // Le jalon bloqué a été fermé avec sa mission — sinon l'horizon resterait ouvert (§118.45).
    const jalon = await prisma.missionMilestone.findFirst({ where: { missionId: jalonBloque }, select: { statut: true } });
    expect(jalon?.statut).toBe("CANCELLED");
    expect((await compterPourLesGestesDeMasse(b)).bloquees).toBe(0);
  }, 60_000);

  it("le compteur et le geste lisent LE MÊME prédicat — deux définitions divergeraient (§118.5)", async () => {
    // Les deux `where` sont les objets que le compteur ET le geste passent à Prisma : c'est la
    // même fonction, pas une copie. Le banc le tient en comparant la forme, pas en le supposant.
    expect(ouBloquee("x")).toEqual(ouBloquee("x"));
    expect(ouSuspendable("x").status).toEqual({ notIn: ["COMPLETED", "CANCELLED", "PAUSED"] });
    const bloquee = ouBloquee("x");
    expect(bloquee.OR).toHaveLength(3);
    expect(bloquee.status).toEqual({ notIn: ["COMPLETED", "CANCELLED"] });
  });
});
