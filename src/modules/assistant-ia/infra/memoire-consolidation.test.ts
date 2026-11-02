import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { annulerSouvenir, jetonsDeLaMemoire, listerMemoire, purgerHistoriqueMemoire } from "./memoire";
import { consoliderMemoire, oublierDerniereTacheMemoire, tacheMemoire, type Consolideur } from "./memoire-consolidation";
import { capturerApresTour } from "./memoire-capture";
import { ouvrirBudget, remplacerReglagesPourTests } from "./consommation";
import { lireConsolidation, validerGroupe, doitConsolider } from "../domaine/memoire/consolidation";

/**
 * M1, décisions de la Direction (01/11/2026) — l'historique gardé 12 mois, la santé retenue d'office, la mémoire gérée
 * en JETONS (consolidation rare, réversible) et « pas de plafond » quotidien. Sur la vraie base.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__memjet_${Date.now().toString(36)}_`;
let moi = "";
const MOIS = 30 * 24 * 3600_000;

function consolideur(groupes: unknown[]): Consolideur & { appels: string[] } {
  const appels: string[] = [];
  const f = (async (_c: string, e: string) => { appels.push(e); return { ok: true as const, texte: JSON.stringify({ groupes }) }; }) as Consolideur & { appels: string[] };
  f.appels = appels;
  return f;
}

async function faits(...contenus: [string, string][]) {
  for (const [type, content] of contenus) await prisma.assistantMemoryItem.create({ data: { userId: moi, type, content, origine: "auto" } });
}

describe("consolidation — règle pure", () => {
  it("lit les groupes, écarte les clés inconnues et les doublons de faits", () => {
    const cles = new Map([["m1", "a"], ["m2", "b"], ["m3", "c"]]);
    const g = lireConsolidation('{"groupes":[{"remplace":["m1","m2","m9"],"sorte":"FAMILLE","contenu":"Fille : Lina, 9 ans"},{"remplace":["m2"],"sorte":"FAMILLE","contenu":"x"}]}', cles);
    expect(g).toEqual([{ remplace: ["a", "b"], sorte: "FAMILLE", contenu: "Fille : Lina, 9 ans" }]);
  });

  it("un groupe doit économiser des jetons et ne rien inventer", () => {
    const r = [{ contenu: "Fille : Lina." }, { contenu: "Lina a 9 ans." }, { contenu: "Lina est à l'école Les Oliviers d'Alger." }];
    expect(validerGroupe({ contenu: "Fille : Lina, 9 ans, école Les Oliviers d'Alger" }, r).ok).toBe(true);
    expect(validerGroupe({ contenu: "Fille : Lina, 10 ans, école Les Oliviers d'Alger" }, r).ok).toBe(false);
    expect(validerGroupe({ contenu: "Fille : Lina. Elle a 9 ans et va à l'école Les Oliviers d'Alger, une très bonne école du centre." }, r.slice(0, 1)).ok).toBe(false);
    expect(doitConsolider(6_800, 8_000)).toBe(true);
    expect(doitConsolider(6_700, 8_000)).toBe(false);
  });
});

suite("mémoire — jetons, consolidation, historique 12 mois, sans plafond quotidien", () => {
  beforeAll(async () => {
    moi = (await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id;
  });
  afterEach(async () => {
    remplacerReglagesPourTests(null);
    await prisma.assistantMemoryItem.deleteMany({ where: { userId: moi } });
    await prisma.assistantIaPreference.deleteMany({ where: { userId: moi } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("l'historique est purgé après 12 mois — un fait ACTIF ne l'est jamais par l'âge", async () => {
    const maintenant = new Date();
    const vieux = await prisma.assistantMemoryItem.create({ data: { userId: moi, type: "VOYAGES", content: "Part à Oran en mars", active: false, remplaceLe: new Date(maintenant.getTime() - 13 * MOIS) } });
    const recent = await prisma.assistantMemoryItem.create({ data: { userId: moi, type: "VOYAGES", content: "Part à Oran en avril", active: false, remplaceLe: new Date(maintenant.getTime() - 11 * MOIS) } });
    const actif = await prisma.assistantMemoryItem.create({ data: { userId: moi, type: "FAMILLE", content: "Fille : Lina", createdAt: new Date(maintenant.getTime() - 36 * MOIS) } });
    await purgerHistoriqueMemoire(maintenant);
    await purgerHistoriqueMemoire(maintenant); // idempotent
    const restants = new Set((await prisma.assistantMemoryItem.findMany({ where: { userId: moi }, select: { id: true } })).map((x) => x.id));
    expect(restants.has(vieux.id)).toBe(false);
    expect(restants.has(recent.id)).toBe(true);
    expect(restants.has(actif.id)).toBe(true);
  });

  it("la santé que la personne déclare est retenue d'office", async () => {
    const b = await capturerApresTour({
      userId: moi, message: "Je suis allergique à la pénicilline.", conversation: null,
      deps: { extraire: async () => ({ ok: true, texte: '{"souvenirs":[{"sorte":"SANTE_DECLAREE","contenu":"Allergique à la pénicilline","sujet":"sante:allergie"}]}' }) },
    });
    expect(b.retenus).toMatchObject([{ sorte: "SANTE_DECLAREE", contenu: "Allergique à la pénicilline" }]);
  });

  it("au-delà de 85 % du budget en JETONS : consolidation en un lot, économie mesurée, réversible, rare", async () => {
    remplacerReglagesPourTests({ memoireJetonsBudget: 1_000 });
    await faits(["FAMILLE", "Fille : Lina."], ["FAMILLE", "Lina a 9 ans."], ["FAMILLE", "Lina est à l'école Les Oliviers d'Alger."]);
    for (let i = 0; i < 40; i++) await faits(["WORKING_STYLE", `Habitude ${i} : relit les rapports hebdomadaires du service ${i} le dimanche matin.`]);
    const avant = await jetonsDeLaMemoire(moi);
    expect(avant).toBeGreaterThanOrEqual(850);
    const c = consolideur([
      { remplace: ["m1", "m2", "m3"], sorte: "FAMILLE", contenu: "Fille : Lina, 9 ans, école Les Oliviers d'Alger" },
      { remplace: ["m4", "m5"], sorte: "WORKING_STYLE", contenu: "Relit le dimanche matin les rapports hebdomadaires des services 0 et 1" },
      { remplace: ["m6"], sorte: "WORKING_STYLE", contenu: "Invente un rendez-vous le 31 décembre à Paris" },
    ]);
    const b = await consoliderMemoire(moi, { consolider: c });
    expect(c.appels).toHaveLength(1);
    expect(b).toMatchObject({ fait: true, motif: "consolide", groupes: 2, faitsRepris: 5 });
    expect(b.refuses.length).toBe(1);
    expect(b.jetonsApres).toBeLessThan(b.jetonsAvant);
    const liste = await listerMemoire(moi);
    const fille = liste.find((e) => e.contenu.startsWith("Fille : Lina, 9 ans"))!;
    expect(fille).toMatchObject({ origine: "consolidation", versionsAnterieures: 3 });
    expect(await prisma.assistantMemoryItem.count({ where: { userId: moi, consolideDans: fille.id, active: false, remplaceLe: { not: null } } })).toBe(3);

    // Rare : une seconde fois le même jour, rien.
    expect((await consoliderMemoire(moi, { consolider: c })).motif).toBe("trop-tot");
    // Réversible : annuler le fait consolidé rend les trois faits d'avant.
    expect((await annulerSouvenir(moi, fille.id)).ok).toBe(true);
    const apres = (await listerMemoire(moi)).map((e) => e.contenu);
    expect(apres).toEqual(expect.arrayContaining(["Fille : Lina.", "Lina a 9 ans.", "Lina est à l'école Les Oliviers d'Alger."]));
  });

  it("sous le seuil, rien n'est appelé ; la tâche quotidienne purge puis consolide les candidats", async () => {
    remplacerReglagesPourTests({ memoireJetonsBudget: 8_000 });
    await faits(["FAMILLE", "Fille : Lina."]);
    const c = consolideur([]);
    expect((await consoliderMemoire(moi, { consolider: c })).motif).toBe("sous-le-seuil");
    expect(c.appels).toHaveLength(0);
    oublierDerniereTacheMemoire();
    const t = await tacheMemoire();
    expect(t).not.toBeNull();
    expect(await tacheMemoire()).toBeNull(); // une fois toutes les 6 h par processus
  });

  it("pas de plafond quotidien par défaut : une personne qui a déjà tout consommé n'est pas refusée", async () => {
    remplacerReglagesPourTests({});
    await prisma.modelCallLog.create({ data: { userId: moi, route: "conversation", role: "conversation", feature: "assistant_ia", provider: "openai", model: "test", inputTokens: 5_000_000, outputTokens: 0 } as never });
    await expect(ouvrirBudget({ userId: moi, origine: "conversation" })).resolves.toBeTruthy();
    remplacerReglagesPourTests({ plafondJetonsJour: 100_000 });
    await expect(ouvrirBudget({ userId: moi, origine: "conversation" })).rejects.toThrow(/plafond/i);
    await prisma.modelCallLog.deleteMany({ where: { userId: moi } });
  });
});
