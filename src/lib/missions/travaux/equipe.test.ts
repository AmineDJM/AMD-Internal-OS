import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { lireTravailEquipe, listerTravauxEquipe } from "@/lib/missions/travaux/equipe";

/**
 * LES TRAVAUX DE MON ÉQUIPE (J8, décision 0023) — fermé par défaut ; ouvert par la console, un N+1 voit le résumé et les
 * étapes des travaux de SON équipe (ligne hiérarchique de l'organigramme), jamais le carnet ; chaque consultation à l'audit.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eqp__${Date.now()}`;
let chef = "";
let membre = "";
let autre = "";
let travail = "";
let avant: boolean | null = null;

const audits = (actorId: string) => prisma.auditLog.count({ where: { actorId, module: "Assistant IA — travaux" } });

suite("travaux — la vue d'un responsable sur son équipe (J8)", () => {
  beforeAll(async () => {
    const creer = (n: string) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n.toLowerCase()}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    [chef, membre, autre] = (await Promise.all([creer("Chef"), creer("Membre"), creer("Autre")])).map((u) => u.id);
    const eChef = await prisma.employee.create({ data: { fullName: `${TAG}Chef`, userId: chef } });
    await prisma.employee.create({ data: { fullName: `${TAG}Membre`, userId: membre, managerId: eChef.id } });
    await prisma.employee.create({ data: { fullName: `${TAG}Autre`, userId: autre } });
    travail = (await prisma.mission.create({
      data: {
        kind: "TRAVAIL", ownerId: membre, principalId: membre, persona: "ASSISTANT_IA", title: `${TAG} Analyse`, objective: "x", status: "WAITING_EVENT",
        planApprouveLe: new Date(), carnet: { objectif: "x", plan: null, notes: [{ etape: "a", texte: "SECRET du carnet", at: "" }], trouvailles: [], livrables: [] },
      },
      select: { id: true },
    })).id;
    avant = (await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { managerVoitEquipe: true } }))?.managerVoitEquipe ?? null;
  });
  afterAll(async () => {
    await prisma.assistantIaReglage.updateMany({ where: { id: "global" }, data: { managerVoitEquipe: avant ?? false } }).catch(() => undefined);
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [chef, autre] } } }).catch(() => undefined);
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("fermé par défaut : rien n'est lu, rien n'est audité", async () => {
    await prisma.assistantIaReglage.upsert({ where: { id: "global" }, update: { managerVoitEquipe: false }, create: { id: "global", managerVoitEquipe: false } });
    expect((await listerTravauxEquipe(chef)).ok).toBe(false);
    expect((await lireTravailEquipe(chef, travail)).ok).toBe(false);
    expect(await audits(chef)).toBe(0);
  });

  it("ouvert : le N+1 voit le résumé et les étapes, jamais le carnet ; un autre ne voit rien ; chaque consultation à l'audit", async () => {
    await prisma.assistantIaReglage.update({ where: { id: "global" }, data: { managerVoitEquipe: true } });
    const l = await listerTravauxEquipe(chef);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.valeur.find((t) => t.id === travail)).toMatchObject({ titre: `${TAG} Analyse`, personne: `${TAG}Membre`, etat: "EN_ATTENTE" });
    const d = await lireTravailEquipe(chef, travail);
    expect(d.ok).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/SECRET du carnet/);
    expect(d.ok && "carnet" in d.valeur).toBe(false);
    expect(await audits(chef)).toBe(2);
    // Hors de la ligne hiérarchique : rien.
    const a = await listerTravauxEquipe(autre);
    expect(a.ok && a.valeur.some((t) => t.id === travail)).toBe(false);
    expect((await lireTravailEquipe(autre, travail)).ok).toBe(false);
    // Le membre ne passe pas par la vue d'équipe pour son propre travail.
    expect((await lireTravailEquipe(membre, travail)).ok).toBe(false);
  });
});
