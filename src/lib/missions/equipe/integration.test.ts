import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { Clock } from "@/lib/missions/ports";
import { contrat, depotDeBanc, type ForgeGitLocale } from "@/lib/missions/chantiers/integration-test-outils";
import { avancerFile, deposerEnFile, forgeGardee, gardeEcritureRef, prendreLaTete, validerIntegration } from "@/lib/missions/equipe/integration";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * O2-3 (décision 0059 § 6) — LA FILE D'INTÉGRATION SUR UN VRAI DÉPÔT GIT ET LA VRAIE BASE :
 *   • INCOMPATIBILITÉ QUE GIT NE SIGNALE PAS : A renomme `f` en `g`, B appelle `f` — chacun VERT seul, aucune collision
 *     de fichiers (merge-tree sans conflit) ; A intégré, B fusionné avec la NOUVELLE tête → CI rouge → RENVOYÉE, la
 *     cible ne reçoit jamais B ;
 *   • conflit limité au fichier GÉNÉRÉ (contrat) → renvoyé AVEC la recette de régénération ;
 *   • la cible bouge pendant l'intégration → on recommence sur la nouvelle tête ; jamais d'avance non fast-forward ;
 *   • `main` protégée → carte de validation ; accordée → avance ; jamais sans elle ;
 *   • deux prises simultanées → une seule entrée active (index unique partiel) ;
 *   • la garde refuse toute écriture hors des branches d'intégration et de la cible.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__o2i__${Date.now()}`;
const horloge: Clock = { now: () => new Date() };
let admin = "";
let programmeId = "";
let n = 0;

const depot = () => ({ proprietaire: "banc", nom: `${TAG}-${++n}` });
const deposer = async (d: { proprietaire: string; nom: string }, cible: string, branche: string, sha: string, cle: string) => {
  const chantierId = `${TAG}-ch-${cle}-${n}`;
  await deposerEnFile({ programmeId, chantierId, tacheCle: cle, depot: d, cible, branche, shaTache: sha });
  return prisma.integrationFile.findUniqueOrThrow({ where: { chantierId_shaTache: { chantierId, shaTache: sha } } });
};
const jusquAuRepos = async (depotNom: string, cible: string, forge: ForgeGitLocale, deps: Partial<Parameters<typeof avancerFile>[2]> = {}) => {
  for (let i = 0; i < 12; i++) if (!(await avancerFile(depotNom, cible, { forge, clock: horloge, ...deps }))) return;
};
const statut = async (id: string) => (await prisma.integrationFile.findUniqueOrThrow({ where: { id } })).statut;

suite("file d'intégration — vrai git, vraie base (O2-3)", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    programmeId = (await prisma.mission.create({ data: { kind: "PROGRAMME", ownerId: admin, principalId: admin, title: `${TAG} programme`, objective: "banc", status: "RUNNING" }, select: { id: true } })).id;
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("A renomme `f`, B appelle `f` : chacun vert, Git ne voit RIEN ; la CI du résultat intégré bloque B", { timeout: 60_000 }, async () => {
    const { forge } = depotDeBanc();
    const cible = "claude/cible";
    forge.git("update-ref", `refs/heads/${cible}`, forge.git("rev-parse", "main"));
    const a = forge.commit("claude/a", { "src/m/lib.mjs": "export function g() { return 1; }\n" }, "A : f devient g", cible);
    const b = forge.commit("claude/b", { "src/m/use.mjs": "import { f } from \"./lib.mjs\";\nexport const usage = f();\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "use.mjs"]) }, "B : appelle f", cible);
    // Chacune est VERTE seule.
    expect(await forge.checks({ proprietaire: "", nom: "" }, a)).toMatchObject({ ok: true, valeur: { statut: "vert" } });
    expect(await forge.checks({ proprietaire: "", nom: "" }, b)).toMatchObject({ ok: true, valeur: { statut: "vert" } });
    const d = depot();
    const ea = await deposer(d, cible, "claude/a", a, "a");
    await jusquAuRepos(ea.depot, cible, forge);
    expect(await statut(ea.id)).toBe("FUSIONNEE");
    expect(forge.git("rev-parse", cible)).toBe(a); // fast-forward : la cible est EXACTEMENT le SHA vérifié
    // Git ne voit RIEN : B (use.mjs, contrat) et A (lib.mjs) ne touchent pas les mêmes fichiers.
    expect(forge.git("merge-tree", "--write-tree", a, b)).not.toMatch(/CONFLICT/);
    const eb = await deposer(d, cible, "claude/b", b, "b");
    await jusquAuRepos(eb.depot, cible, forge);
    const rouge = await prisma.integrationFile.findUniqueOrThrow({ where: { id: eb.id } });
    expect(rouge.statut).toBe("RENVOYEE");
    expect(String((rouge.detail as { raison: string }).raison)).toMatch(/CI rouge sur le résultat intégré/);
    expect(String((rouge.detail as { extrait: string }).extrait)).toMatch(/does not provide an export named 'f'/);
    expect(forge.git("rev-parse", cible)).toBe(a); // la cible n'a JAMAIS reçu B
    // Et la branche d'intégration, qui n'a servi qu'à la CI, est retirée.
    expect(forge.git("for-each-ref", "--format=%(refname)", "refs/heads/claude/integration/")).toBe("");
    expect(forge.journal().filter((j) => j.geste === "avancer")).toHaveLength(1);
  });

  it("deux tâches qui ne se gênent qu'au fichier GÉNÉRÉ : conflit renvoyé AVEC la recette de régénération", { timeout: 60_000 }, async () => {
    const { forge } = depotDeBanc();
    const cible = "claude/generee";
    forge.git("update-ref", `refs/heads/${cible}`, forge.git("rev-parse", "main"));
    const x = forge.commit("claude/gx", { "src/m/x.mjs": "export const x = 1;\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "x.mjs"]) }, "X", cible);
    const z = forge.commit("claude/gz", { "src/m/z.mjs": "export const z = 1;\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "z.mjs"]) }, "Z", cible);
    const d = depot();
    const ex = await deposer(d, cible, "claude/gx", x, "gx");
    const ez = await deposer(d, cible, "claude/gz", z, "gz");
    await jusquAuRepos(ex.depot, cible, forge);
    expect(await statut(ex.id)).toBe("FUSIONNEE");
    const fin = await prisma.integrationFile.findUniqueOrThrow({ where: { id: ez.id } });
    expect(fin.statut).toBe("RENVOYEE");
    expect(fin.detail).toMatchObject({ fichiers: ["src/lib/actions/contrat.genere.json"], recette: ["npm run actions:contrat"], raison: "conflit limité aux fichiers générés : régénération" });
    expect(forge.git("rev-parse", cible)).toBe(x);
  });

  it("la cible BOUGE pendant l'intégration : on recommence sur la nouvelle tête, jamais d'avance non fast-forward", { timeout: 60_000 }, async () => {
    const { forge } = depotDeBanc();
    const cible = "claude/mouvante";
    forge.git("update-ref", `refs/heads/${cible}`, forge.git("rev-parse", "main"));
    const x = forge.commit("claude/x", { "src/m/x.mjs": "export const x = 1;\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "x.mjs"]) }, "X", cible);
    const d = depot();
    const e = await deposer(d, cible, "claude/x", x, "x");
    let bouge = false;
    await avancerFile(e.depot, cible, {
      forge, clock: horloge,
      sonde: async (m) => {
        if (m !== "avant-avance" || bouge) return;
        bouge = true;
        // Quelqu'un pousse sur la cible entre la CI et l'avance (un autre outil, un humain).
        forge.commit(cible, { "LISEZMOI.md": "ajout\n" }, "pendant ce temps");
      },
    });
    expect(await statut(e.id)).toBe("EN_FILE");
    await jusquAuRepos(e.depot, cible, forge);
    const fin = await prisma.integrationFile.findUniqueOrThrow({ where: { id: e.id } });
    expect(fin.statut).toBe("FUSIONNEE");
    expect(fin.tour).toBe(2);
    const t = forge.git("rev-parse", cible);
    expect(forge.git("show", `${t}:LISEZMOI.md`)).toBe("ajout");
    expect(forge.git("show", `${t}:src/m/x.mjs`)).toBe("export const x = 1;");
    expect(await forge.checks({ proprietaire: "", nom: "" }, t)).toMatchObject({ ok: true, valeur: { statut: "vert" } });
  });

  it("main PROTÉGÉE : CI verte → carte de validation ; rien n'avance sans elle ; accordée → avance", { timeout: 60_000 }, async () => {
    const { forge, cible } = depotDeBanc();
    const avant = forge.git("rev-parse", "main");
    const y = forge.commit("claude/y", { "src/m/y.mjs": "export const y = 2;\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "y.mjs"]) }, "Y", "main");
    const e = await deposer(depot(), cible, "claude/y", y, "y");
    await jusquAuRepos(e.depot, cible, forge);
    expect(await statut(e.id)).toBe("A_VALIDER");
    expect(forge.git("rev-parse", "main")).toBe(avant);
    expect((await validerIntegration(programmeId, "ACCORDEE", admin, horloge)).ok).toBe(true);
    await jusquAuRepos(e.depot, cible, forge);
    expect(await statut(e.id)).toBe("FUSIONNEE");
    expect(forge.git("rev-parse", "main")).toBe(y);
  });

  it("deux prises SIMULTANÉES sur une cible : une seule entrée active (la base tranche)", async () => {
    const d = depot();
    const e1 = await deposer(d, "claude/c", "claude/p1", "a1".padEnd(40, "0"), "p1");
    const e2 = await deposer(d, "claude/c", "claude/p2", "a2".padEnd(40, "0"), "p2");
    const prises = await Promise.all([prendreLaTete(e1.depot, "claude/c", horloge), prendreLaTete(e1.depot, "claude/c", horloge), prendreLaTete(e1.depot, "claude/c", horloge)]);
    expect(prises.filter(Boolean).map((p) => p!.id).every((id) => id === e1.id)).toBe(true);
    expect(await prisma.integrationFile.count({ where: { depot: e1.depot, cible: "claude/c", statut: { in: ["EN_COURS", "CI", "A_VALIDER"] } } })).toBe(1);
    expect(await statut(e2.id)).toBe("EN_FILE");
    // Même hors du code : la base refuse une seconde entrée active pour la même cible.
    await expect(prisma.integrationFile.update({ where: { id: e2.id }, data: { statut: "CI" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("la GARDE : jamais d'écriture hors des branches d'intégration ; jamais d'avance d'une autre branche que la cible", async () => {
    expect(gardeEcritureRef("main", "creer")).toMatch(/refus/);
    expect(gardeEcritureRef("claude/integration/main/x-1", "creer")).toBeNull();
    expect(gardeEcritureRef("main", "avancer", "claude/cible")).toMatch(/refus/);
    const { forge } = depotDeBanc();
    const g = forgeGardee(forge, "claude/cible");
    const sha = forge.git("rev-parse", "main");
    expect(await g.creerBranche({ proprietaire: "", nom: "" }, "main-bis", sha)).toMatchObject({ ok: false, definitif: true });
    expect(await g.avancer({ proprietaire: "", nom: "" }, "main", sha)).toMatchObject({ ok: false });
    expect(await g.fusionnerDans({ proprietaire: "", nom: "" }, "main", "claude/x", "m")).toMatchObject({ ok: false });
    expect(forge.journal()).toEqual([]);
    fs.rmSync(forge.racine, { recursive: true, force: true });
  });
});
