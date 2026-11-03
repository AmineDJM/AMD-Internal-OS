import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { aCompacter, appliquerFidelite, assemblerContexte, enregistrerEpisode } from "./store";
import type { Episode } from "./compact";
import { aRelancer, noterRelance } from "@/lib/missions/commitments/satisfy";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE EN BASE — et l'assemblage réel du contexte.
 *
 * Ce fichier existe parce que la partie pure était testée et la partie base ne l'était pas.
 * Du code plausible qui n'a jamais tourné contre Postgres n'est pas du code vérifié : c'est du
 * code qui compile.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mem__${Date.now()}`;
let userId = "";

const ep = (extra: Partial<Episode> = {}): Episode => ({
  summary: "Le marché PCH-2026-014 vaut 4 200 000 DZD.",
  entities: ["MARCHE:PCH-2026-014"],
  decisions: ["soumettre avant le 15/03"],
  commitments: [],
  openQuestions: [],
  corrections: [],
  ...extra,
});

const jours = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

suite("mémoire — la couche base", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.assistantEpisode.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { ownerId: userId } }).catch(() => {});
    await prisma.assistantMemoryItem.deleteMany({ where: { userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("UNE TRANCHE N'EST COMPACTÉE QU'UNE FOIS — sinon le contexte la compte deux fois", async () => {
    const span = {
      fromMessageId: "m1", toMessageId: "m9", turns: 8,
      startedAt: jours(3), endedAt: jours(3), tokensBefore: 900,
    };
    const a = await enregistrerEpisode(userId, ep(), span);
    const b = await enregistrerEpisode(userId, ep({ summary: "autre" }), span);
    expect(b).toBe(a);
    expect(await prisma.assistantEpisode.count({ where: { userId } })).toBe(1);

    const ligne = await prisma.assistantEpisode.findUnique({ where: { id: a } });
    // Le second enregistrement n'écrase PAS : la première version fait foi.
    expect(ligne!.summary).toMatch(/PCH-2026-014/);
    expect(ligne!.tokensAfter).toBeGreaterThan(0);
    expect(ligne!.tokensBefore).toBe(900);
  }, 30_000);

  it("une tranche SANS bornes de message est enregistrée à chaque fois — et c'est assumé", async () => {
    const span = { turns: 3, startedAt: jours(1), endedAt: jours(1), tokensBefore: 100 };
    const a = await enregistrerEpisode(userId, ep({ summary: "sans bornes A" }), span);
    const b = await enregistrerEpisode(userId, ep({ summary: "sans bornes B" }), span);
    // Sans identité de tranche, la base n'a rien pour dédupliquer. L'appelant DOIT fournir les
    // bornes s'il veut la garantie — c'est pour cela qu'elles existent.
    expect(b).not.toBe(a);
    await prisma.assistantEpisode.deleteMany({ where: { id: { in: [a, b] } } });
  }, 30_000);

  it("LA FILE DU COMPACTEUR ne contient que les épisodes en retard sur leur âge", async () => {
    await prisma.assistantEpisode.deleteMany({ where: { userId } });
    const recent = await enregistrerEpisode(userId, ep({ summary: "récent" }),
      { fromMessageId: "r1", toMessageId: "r2", turns: 2, startedAt: jours(1), endedAt: jours(1), tokensBefore: 100 });
    const vieux = await enregistrerEpisode(userId, ep({ summary: "vieux" }),
      { fromMessageId: "v1", toMessageId: "v2", turns: 2, startedAt: jours(40), endedAt: jours(40), tokensBefore: 100 });
    const antique = await enregistrerEpisode(userId, ep({ summary: "antique" }),
      { fromMessageId: "a1", toMessageId: "a2", turns: 2, startedAt: jours(200), endedAt: jours(200), tokensBefore: 100 });

    const file = await aCompacter(userId);
    const par = new Map(file.map((f) => [f.id, f]));
    expect(par.has(recent)).toBe(false);
    expect(par.get(vieux)!.visee).toBe("STRUCTURED");
    expect(par.get(antique)!.visee).toBe("FACTS");
    // La file porte l'épisode COMPLET : le compacteur sait ce qu'il doit préserver.
    expect(par.get(antique)!.episode.entities).toEqual(["MARCHE:PCH-2026-014"]);
  }, 30_000);

  it("une fidélité appliquée sort l'épisode de la file, et ne remonte jamais", async () => {
    const file = await aCompacter(userId);
    const cible = file.find((f) => f.visee === "FACTS")!;
    await appliquerFidelite(cible.id, { ...cible.episode, summary: "PCH-2026-014 : 4 200 000 DZD." }, "FACTS");

    const apres = await aCompacter(userId);
    expect(apres.map((f) => f.id)).not.toContain(cible.id);

    const ligne = await prisma.assistantEpisode.findUnique({ where: { id: cible.id } });
    expect(ligne!.fidelity).toBe("FACTS");
    expect(ligne!.tokensAfter).toBeLessThan(ligne!.tokensBefore + 1000);
    expect(ligne!.compactedAt).not.toBeNull();
  }, 30_000);

  it("L'ASSEMBLAGE lit les quatre sources et respecte la priorité", async () => {
    await prisma.assistantMemoryItem.create({
      data: { userId, type: "TERMINOLOGY", content: "Pembro = Pembrolizumab", active: true },
    });
    await prisma.executiveCommitment.create({
      data: { ownerId: userId, who: "Redouane", what: "envoyer son contrat", status: "OPEN", dueAt: jours(-2) },
    });

    const a = await assemblerContexte(userId, {
      identiteActive: "le marché PCH-2026-014",
      contrainteCourante: "pas avant vendredi",
      toursRecents: "— Où en est le marché ?",
    });

    const couches = a.morceaux.map((m) => m.couche);
    expect(couches[0]).toBe("IDENTITE_ACTIVE");
    expect(couches).toContain("CONTRAINTE_COURANTE");
    expect(couches).toContain("TOURS_RECENTS");
    expect(couches).toContain("ENGAGEMENTS");
    expect(couches).toContain("PREFERENCES");
    expect(couches).toContain("EPISODES");

    expect(a.texte).toMatch(/Redouane doit : envoyer son contrat/);
    expect(a.texte).toMatch(/Pembro = Pembrolizumab/);
    expect(a.metriques.contextTokens).toBeGreaterThan(0);
    expect(a.metriques.episodeCount).toBeGreaterThan(0);
    expect(a.metriques.contextBuildMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("À BUDGET SERRÉ, l'identité et la contrainte passent, les épisodes tombent", async () => {
    const a = await assemblerContexte(userId, {
      identiteActive: "le marché PCH-2026-014",
      contrainteCourante: "pas avant vendredi",
      budget: 5,
    });
    expect(a.morceaux.map((m) => m.couche)).toEqual(["IDENTITE_ACTIVE", "CONTRAINTE_COURANTE"]);
    expect(a.metriques.budgetDepasse).toBe(true);
  }, 30_000);

  it("le contexte d'une personne SANS rien ne plante pas et ne coûte rien", async () => {
    const vide = await prisma.user.create({
      data: { name: `${TAG}v`, email: `${TAG}v@t.dz`, passwordHash: "x", role: "VIEWER" },
    });
    const a = await assemblerContexte(vide.id);
    expect(a.morceaux).toEqual([]);
    expect(a.metriques.contextTokens).toBe(0);
    await prisma.user.delete({ where: { id: vide.id } });
  }, 30_000);

  it("la file de relance ne contient que ce qu'il est LÉGITIME de relancer", async () => {
    await prisma.executiveCommitment.deleteMany({ where: { ownerId: userId } });
    const enRetard = await prisma.executiveCommitment.create({
      data: { ownerId: userId, who: "Redouane", what: "le contrat", status: "OPEN", dueAt: jours(5) },
    });
    await prisma.executiveCommitment.create({
      data: { ownerId: userId, who: "Alla", what: "la note", status: "OPEN", dueAt: jours(-5) },
    });
    await prisma.executiveCommitment.create({
      data: { ownerId: userId, who: "Khaled", what: "fait", status: "DONE", dueAt: jours(9) },
    });

    const file = await aRelancer(userId);
    expect(file.map((f) => f.engagement.id)).toEqual([enRetard.id]);

    // Une fois la relance notée, elle ne repart pas le lendemain.
    await noterRelance(enRetard.id);
    expect((await aRelancer(userId)).map((f) => f.engagement.id)).toEqual([]);
  }, 30_000);
});
