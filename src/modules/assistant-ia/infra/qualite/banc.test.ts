import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { demanderPassage, enregistrerReglageBanc, remplacerLanceurBancPourTests, tacheBancProgramme, type DemandeLancement } from "./banc";
import { changerModeleRole, modelesEnService, revenirModeleEnvironnement } from "./modeles";
import type { ResultatBanc, ScenarioBanc } from "../../domaine/qualite/resultat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC PROGRAMMÉ ET LE PROTOCOLE A/B (J5 + J14, décision 0022) — sans aucun processus ni appel de modèle : le
 * lanceur est remplacé par un faux qui rend un résultat écrit d'avance (comme le ferait `scripts/bench/banc-programme.ts`).
 * Prouvé : le banc ne tourne que sur le worker ; il REFUSE sans base d'essai et quand la production porte le marqueur ;
 * il historise, compare, prévient le Super Admin d'une régression ; le calendrier le lance une fois par créneau ; un
 * modèle ne change qu'avec un banc A/B vert.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__banc_prog_${Date.now().toString(36)}_`;
const ENV = { NODE_ENV: "test", DATABASE_URL: "postgresql://amd:amd@localhost:5432/amd_internal_os", BENCH_DATABASE_URL: "postgresql://amd:amd@localhost:5432/amd_bench" } as NodeJS.ProcessEnv;
let admin = "";
const lances: DemandeLancement[] = [];

const sc = (scenario: string, verdict: ScenarioBanc["verdict"], o: Partial<ScenarioBanc> = {}): ScenarioBanc => ({ scenario, famille: "jarvis", verdict, motifs: [], ms: 4000, premierMotMs: 3000, appels: 2, entree: 6000, cache: 3000, sortie: 100, coutUsd: 0.02, ...o });
let prochain: ResultatBanc = { scenarios: [], depenseUsd: 0, budgetAtteint: false };

async function passer(o: { executeur?: string; maintenant?: Date; env?: NodeJS.ProcessEnv } = {}) {
  const r = await tacheBancProgramme({ executeur: o.executeur ?? "worker", maintenant: o.maintenant, env: o.env ?? ENV });
  await r.fin;
  return r;
}

suite("Le banc programmé et le protocole A/B", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Super`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    remplacerLanceurBancPourTests(async (d) => { lances.push(d); return prochain; });
  });
  beforeEach(async () => {
    await prisma.assistantIaBancPassage.deleteMany({});
    await prisma.assistantIaModeleRole.deleteMany({});
    await prisma.bancBaseEssai.deleteMany({});
    await enregistrerReglageBanc({ actif: true, frequence: "HEBDOMADAIRE", jour: 5, heure: 3, plafondUsd: 1 }, admin);
    lances.length = 0;
  });
  afterAll(async () => {
    remplacerLanceurBancPourTests(null);
    await prisma.assistantIaBancPassage.deleteMany({});
    await prisma.assistantIaModeleRole.deleteMany({});
    await prisma.assistantIaBancReglage.deleteMany({});
    await prisma.notification.deleteMany({ where: { userId: admin } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("ne tourne que sur le worker", async () => {
    expect((await passer({ executeur: "web" })).issue).toBe("rien");
    expect(await prisma.assistantIaBancPassage.count()).toBe(0);
  });

  it("en production sans base d'essai : REFUSÉ, raison dite, rien lancé", async () => {
    const r = await passer({ env: { ...ENV, NODE_ENV: "production", BENCH_DATABASE_URL: "" } });
    expect(r.issue).toBe("refuse");
    const p = await prisma.assistantIaBancPassage.findFirstOrThrow();
    expect(p).toMatchObject({ statut: "REFUSE", declencheur: "PROGRAMME" });
    expect(p.raison).toMatch(/Aucune base d'essai/);
    expect(lances).toHaveLength(0);
  });

  it("la production porte le marqueur d'une base d'essai : REFUSÉ", async () => {
    await prisma.bancBaseEssai.create({ data: { nom: "piège" } });
    const r = await passer();
    expect(r).toMatchObject({ issue: "refuse", raison: expect.stringMatching(/marqueur/) });
    expect(lances).toHaveLength(0);
  });

  it("historise, compare, et prévient le Super Admin d'une régression ; le calendrier ne relance pas le même créneau", async () => {
    const maintenant = new Date("2026-10-30T15:00:00Z");
    prochain = { depenseUsd: 0.5, budgetAtteint: false, scenarios: [sc("00-bonjour", "OK"), sc("01-assia", "OK"), sc("02-service", "ÉCHEC")] };
    const r1 = await passer({ maintenant });
    expect(r1.issue).toBe("lance");
    expect(lances[0]).toMatchObject({ baseEssai: ENV.BENCH_DATABASE_URL, plafondUsd: 1 });
    expect(lances[0]!.envModeles.ASSISTANT_IA_MODEL).toBeTruthy();
    const p1 = await prisma.assistantIaBancPassage.findUniqueOrThrow({ where: { id: r1.passageId! }, include: { scenarios: true } });
    expect(p1).toMatchObject({ statut: "TERMINE", reussis: 2, total: 3, vert: true, premierMotP50Ms: 3000 });
    expect(p1.scenarios).toHaveLength(3);
    expect(p1.modeles).toBeTruthy();

    // Même créneau : rien.
    expect((await passer({ maintenant: new Date("2026-10-31T10:00:00Z") })).issue).toBe("rien");

    // La semaine suivante : « 01-assia » ne passe plus, et le premier mot prend +60 % → régression, avis.
    prochain = { depenseUsd: 0.5, budgetAtteint: false, scenarios: [sc("00-bonjour", "OK", { premierMotMs: 4800 }), sc("01-assia", "ÉCHEC", { premierMotMs: 4800 }), sc("02-service", "ÉCHEC", { premierMotMs: 4800 })] };
    const r2 = await passer({ maintenant: new Date("2026-11-06T09:00:00Z") });
    const p2 = await prisma.assistantIaBancPassage.findUniqueOrThrow({ where: { id: r2.passageId! } });
    expect(p2).toMatchObject({ vert: false, referenceId: p1.id });
    expect((p2.regressions as { mesure: string }[]).map((x) => x.mesure)).toEqual(["réussite", "latence P50", "latence P95"]);
    expect(p2.notifieLe).not.toBeNull();
    const avis = await prisma.notification.findFirst({ where: { userId: admin, title: { startsWith: "Banc Assistant IA : régression" } } });
    expect(avis?.body).toMatch(/n'est plus OK : 01-assia/);
  });

  it("un passage resté « en cours » après un redémarrage est clos, dit", async () => {
    await prisma.assistantIaBancPassage.create({ data: { declencheur: "MANUEL", statut: "EN_COURS", debutLe: new Date() } });
    await enregistrerReglageBanc({ actif: false }, admin);
    await passer();
    const p = await prisma.assistantIaBancPassage.findFirstOrThrow();
    expect(p).toMatchObject({ statut: "ECHEC", raison: expect.stringMatching(/interrompu/) });
  });

  it("A/B : le modèle ne change qu'avec un banc vert pour ce candidat ; le retour à l'environnement est permis", async () => {
    const candidat = { role: "standard" as const, modelId: "gpt-6.2-terra", effort: "low" };
    expect(await changerModeleRole(candidat, admin)).toMatchObject({ ok: false, raison: expect.stringMatching(/Aucun banc A\/B/) });

    // Référence, puis A/B vert.
    prochain = { depenseUsd: 0.4, budgetAtteint: false, scenarios: [sc("00-bonjour", "OK"), sc("01-assia", "OK")] };
    await passer({ maintenant: new Date("2026-10-30T15:00:00Z") });
    await enregistrerReglageBanc({ actif: false }, admin);
    const d = await demanderPassage({ declencheur: "AB", parId: admin, candidat });
    expect(d.ok).toBe(true);
    expect(await demanderPassage({ declencheur: "MANUEL", parId: admin })).toMatchObject({ ok: false });
    await passer();
    expect(lances.at(-1)!.envModeles.ASSISTANT_IA_MODEL).toBe("gpt-6.2-terra");
    const ab = await prisma.assistantIaBancPassage.findFirstOrThrow({ where: { declencheur: "AB" } });
    expect(ab.vert).toBe(true);
    expect(await notificationsDe("Banc A/B Assistant IA : vert")).toBe(1);

    expect(await changerModeleRole(candidat, admin)).toEqual({ ok: true });
    expect((await modelesEnService(ENV)).standard).toMatchObject({ modelId: "gpt-6.2-terra", source: "écran" });
    // Un autre effort n'a pas été éprouvé.
    expect((await changerModeleRole({ ...candidat, effort: "high" }, admin)).ok).toBe(false);

    // Un A/B rouge : refusé.
    prochain = { depenseUsd: 0.4, budgetAtteint: false, scenarios: [sc("00-bonjour", "OK"), sc("01-assia", "ÉCHEC")] };
    const rouge = { role: "rapide" as const, modelId: "gpt-6-nova", effort: "low" };
    await demanderPassage({ declencheur: "AB", parId: admin, candidat: rouge });
    await passer();
    expect(await changerModeleRole(rouge, admin)).toMatchObject({ ok: false, raison: expect.stringMatching(/pas vert/) });

    await revenirModeleEnvironnement("standard", admin);
    expect((await modelesEnService(ENV)).standard.source).toBe("environnement");
  });
});

async function notificationsDe(debut: string) {
  return prisma.notification.count({ where: { userId: admin, title: { startsWith: debut } } });
}
