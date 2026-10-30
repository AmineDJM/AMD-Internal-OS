// EN PREMIER : le contexte asynchrone de Next, réel hors de son serveur (l'action de l'écran est appelée pour de vrai).
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerHorsRequete, personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { executerCapacite, outilsCapacites, registreDesCapacites } from "./capacites";
import { accesAssistantIa } from "./role-config";
import type { PropositionCarte } from "./operations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE MONTRE LE DIFF RÉEL, ET RIEN NE S'EXÉCUTE QUI N'Y RESSEMBLE PLUS (J7, décision 0029) — sans `vi.mock`.
 *
 *   1. la capacité « modifier la tâche » prépare sa carte : la simulation (transaction annulée) dit « 1 champ modifié
 *      sur la tâche X : priorité LOW → HIGH » — et la tâche n'a pas bougé ;
 *   2. Yasmine passe la priorité à MEDIUM avant la confirmation : la simulation rejouée ne ressemble plus à la carte —
 *      RIEN ne s'exécute, la carte se remontre avec le nouveau diff ;
 *   3. confirmée de nouveau (le nouveau diff), elle s'exécute — et le geste va au JOURNAL DES EFFETS, sans écart.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__carte__${Date.now()}`;
let moi: CurrentUser;
let tache = "";

suite("la carte d'une capacité simulable (J7)", () => {
  beforeAll(async () => {
    const id = (await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    moi = (await personneDuGeste(id))!;
    tache = (await prisma.task.create({ data: { title: `${TAG} Stand du congrès`, createdById: id, priority: "LOW" } })).id;
  });
  afterAll(async () => {
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: moi.id } }).catch(() => undefined);
    await prisma.assistantActionIntent.deleteMany({ where: { userId: moi.id } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("montre le diff réel, refuse ce qui a changé depuis, puis exécute sous journal ce qui a été revu", { timeout: 60_000 }, async () => {
    const cap = registreDesCapacites().parId.get("task-actions:modifierTache")!;
    expect(cap.simulable).toBe("oui");
    const acces = await accesAssistantIa(moi);
    const propositions: PropositionCarte[] = [];
    const outil = outilsCapacites(moi, propositions, acces).find((o) => o.def.name === cap.outil)!;
    const sortie = JSON.parse(await outil.run({ id: tache, priority: "HIGH" }, moi) as string) as { statut: string; simulation?: string };
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");

    // 1. LE DIFF RÉEL sur la carte — et rien n'a bougé.
    const carte = propositions[0];
    const sim = carte.proposition.simulation!;
    expect(sim.statut).toBe("SIMULE");
    expect(sim.resume).toMatch(/1 champ modifié sur tâche « .*Stand du congrès »/);
    expect(sim.lignes[0].champs).toEqual(expect.arrayContaining([{ champ: "priority", avant: "LOW", apres: "HIGH" }]));
    expect(sortie.simulation).toBe(sim.resume);
    expect((await prisma.task.findUnique({ where: { id: tache } }))?.priority).toBe("LOW");

    // 2. LE MONDE CHANGE avant le clic : rien ne s'exécute, la carte se remontre.
    await prisma.task.update({ where: { id: tache }, data: { priority: "MEDIUM" } });
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: carte.intentId } });
    // La confirmation vit dans la REQUÊTE de la personne : le test en pose l'équivalent (sa personne, un store de Next).
    const confirmer = async (payload: unknown) => (await executerHorsRequete(moi, "test", () => executerCapacite(moi, payload, acces, carte.intentId))).resultat;
    const r1 = await confirmer(intent.payload);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Rien n'a été exécuté/);
    expect(r1.error).toMatch(/MEDIUM/);
    expect((await prisma.task.findUnique({ where: { id: tache } }))?.priority).toBe("MEDIUM");
    const remontree = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: carte.intentId } });
    expect((remontree.payload as { simulation: { empreinte: string } }).simulation.empreinte).not.toBe(sim.empreinte);

    // 3. CONFIRMÉE SUR LE NOUVEAU DIFF : exécutée, journalisée, sans écart.
    const r2 = await confirmer(remontree.payload);
    expect(r2.ok, r2.error).toBe(true);
    expect((await prisma.task.findUnique({ where: { id: tache } }))?.priority).toBe("HIGH");
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: moi.id, cleIdempotence: carte.intentId }, include: { effets: true } });
    expect(g).toMatchObject({ origine: "carte", capaciteId: "task-actions:modifierTache", resultat: "FAIT", ecart: false });
    expect(g.effets.find((e) => e.modele === "Task")).toMatchObject({ operation: "UPDATE", avant: expect.objectContaining({ priority: "MEDIUM" }), apres: expect.objectContaining({ priority: "HIGH" }) });
  });

  it("une capacité non prouvée simulable le dit sur sa carte", async () => {
    const cap = registreDesCapacites().capacites.find((c) => c.source === "action" && c.appelable && c.risque !== "R0" && c.simulable !== "oui");
    expect(cap, "il reste au moins une capacité appelable non simulable").toBeTruthy();
    expect(cap!.raisonSimulable).toBeTruthy();
  });
});
