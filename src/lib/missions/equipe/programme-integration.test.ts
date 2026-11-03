import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { balayerChantiers } from "@/lib/missions/chantiers/service";
import { REGLAGES_CHANTIERS_DEFAUT } from "@/lib/missions/chantiers/regles";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { compter } from "@/lib/missions/runtime/store";
import { contrat, depotDeBanc, portsSurGit } from "@/lib/missions/chantiers/integration-test-outils";
import { OUTILS_PROGRAMME } from "@/lib/missions/equipe/outils";
import { conduireProgramme } from "@/lib/missions/equipe/conduite";
import { integrateur } from "@/lib/missions/equipe/integrateur";
import { lireLeDossierProgramme } from "@/lib/missions/equipe/dossier";
import { lancerProgramme } from "@/lib/missions/equipe/service";
import { tableauDesTravaux } from "@/lib/missions/travaux/tableau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * O2-5 (décision 0059) — DE BOUT EN BOUT, sur la vraie base, le vrai moteur des chantiers et un VRAI dépôt git :
 *   1. lancé par l'OUTIL D'ADAM (« lancer_un_programme »), visible au tableau « Missions d'Adam » ;
 *   2. x (renomme `f` en `g`) et y (appelle `f`) partent EN PARALLÈLE — indépendants, chacun VERT seul ;
 *   3. x s'intègre ; y, fusionné avec la NOUVELLE tête, casse la CI → RENVOYÉ à la MÊME session (travail préservé) ;
 *   4. la session de y fusionne la cible et corrige → nouveau commit vert → de nouveau en file → intégré ;
 *   5. z (dépend de x) ne part qu'APRÈS l'intégration de x, sur la cible qui la contient ;
 *   6. programme TERMINÉ, réservations rendues, cible verte contenant les trois ;
 *   7. budget : un programme au plafond ne lance PERSONNE (BUDGET_HOLD) ; la validation par un salarié est refusée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__o2e__${Date.now()}`;
const REGLAGES = { ...REGLAGES_CHANTIERS_DEFAUT, jourLancementsMax: 100, jourDeploiementsMax: 100, jourUsdMax: 1000, enParallele: 3 };
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
const cerveau: CerveauChantier = { disponibles: () => ({ mimo: false, terra: false, sol: false }), executer: async () => ({ ok: false, erreur: "aucun modèle au banc" }) };
class Horloge implements Clock { t = Date.now(); now() { return new Date(this.t); } }

let admin = "";
let salarie = "";
const tache = (cle: string, perimetre: string[], o: Record<string, unknown> = {}) => ({
  cle, titre: `Tâche ${cle}`, objectif: `Écrire ${cle}`, perimetre, criteres: [`node verif.mjs rend 0 sur ${cle}`], commandesVerif: ["node verif.mjs"], ...o,
});

suite("programme de bout en bout — équipe, file d'intégration, vrai git (O2-5)", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    salarie = (await prisma.user.create({ data: { name: `${TAG}Sami`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SALES_USER" } })).id;
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.memoireTechnique.deleteMany({ where: { cle: { contains: TAG.toLowerCase() } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("parallèle, incompatibilité attrapée, renvoi à la même session, dépendance après intégration, terminé", { timeout: 180_000 }, async () => {
    const { forge } = depotDeBanc();
    const cible = `claude/${TAG}-cible`;
    forge.git("update-ref", `refs/heads/${cible}`, forge.git("rev-parse", "main"));
    // CE QUE FONT LES TRAVAILLEURS (des sessions factices qui commitent pour de vrai).
    const ports = portsSurGit(forge, (c, n) => {
      if (c.branche.endsWith("-x")) forge.commit(c.branche, { "src/m/lib.mjs": "export function g() { return 1; }\n" }, "x : f devient g", c.brancheBase);
      if (c.branche.endsWith("-y") && n === 1) forge.commit(c.branche, { "src/m/use.mjs": "import { f } from \"./lib.mjs\";\nexport const usage = f();\n", "src/lib/actions/contrat.genere.json": contrat(["lib.mjs", "use.mjs"]) }, "y : appelle f", c.brancheBase);
      // Renvoyée : la MÊME session fusionne la cible (son travail gardé) et suit le renommage.
      if (c.branche.endsWith("-y") && n === 2) forge.commit(c.branche, { "src/m/use.mjs": "import { g } from \"./lib.mjs\";\nexport const usage = g();\n" }, "y : fusion de la cible, g", undefined, c.brancheBase);
      if (c.branche.endsWith("-z")) forge.commit(c.branche, { "src/m/lib.mjs": "export function g() { return 1; }\nexport const h = 2;\n" }, "z : ajoute h", c.brancheBase);
    });
    const outil = OUTILS_PROGRAMME.find((o) => o.def.name === "lancer_un_programme")!;
    const s = JSON.parse(await outil.run({ plan: {
      titre: `${TAG} équipe`, objectif: "Renommer f, l'utiliser, l'étendre", depot: { proprietaire: "banc", nom: `${TAG}-depot` }, cible,
      taches: [tache("x", ["src/m/lib.mjs"]), tache("y", ["src/m/use.mjs"], { ressources: ["CONTRAT"] }), tache("z", ["src/m/lib.mjs"], { dependances: ["x"] })],
    } }, admin)) as { statut: string; programmeId: string };
    expect(s.statut).toBe("DEMARRE");
    const id = s.programmeId;
    const h = new Horloge();
    const integrer = integrateur(forge, ports.agent);
    const lancesParPassage: string[][] = [];
    for (let i = 0; i < 30; i++) {
      const b = await conduireProgramme(id, { clock: h, cerveau, integrer });
      if (b.lances.length) lancesParPassage.push(b.lances);
      if (b.statut === "COMPLETED") break;
      const enfants = (await prisma.mission.findMany({ where: { parentMissionId: id }, select: { id: true } })).map((e) => e.id);
      await balayerChantiers({ clock: h, interrupteur: PAS_SUSPENDU, seulement: enfants, deps: { ports, cerveau, reglages: REGLAGES } });
      h.t += 31 * 60_000;
    }
    // 2. x et y partis ENSEMBLE ; z seul, plus tard (après l'intégration de x).
    expect(lancesParPassage[0]).toEqual(["x", "y"]);
    expect(lancesParPassage[1]).toEqual(["z"]);
    const d = await lireLeDossierProgramme(id);
    expect(Object.fromEntries(Object.entries(d.taches).map(([k, t]) => [k, t.etat]))).toEqual({ x: "INTEGREE", y: "INTEGREE", z: "INTEGREE" });
    expect((await prisma.mission.findUnique({ where: { id }, select: { status: true } }))!.status).toBe("COMPLETED");
    // 3-4. y renvoyé UNE fois, à la MÊME session, avec l'extrait de la CI qui dit l'incompatibilité.
    expect(d.taches.y!.renvois).toBe(1);
    expect(ports.messages).toHaveLength(1);
    expect(ports.messages[0]!.session).toBe(`session-${d.taches.y!.branche}`);
    expect(ports.messages[0]!.texte).toMatch(/fait ÉCHOUER la CI[\s\S]*does not provide an export named 'f'/);
    const entrees = await prisma.integrationFile.findMany({ where: { programmeId: id }, orderBy: { createdAt: "asc" }, select: { tacheCle: true, statut: true } });
    expect(entrees.map((e) => `${e.tacheCle}:${e.statut}`)).toEqual(["x:FUSIONNEE", "y:RENVOYEE", "y:FUSIONNEE", "z:FUSIONNEE"]);
    // 6. La cible contient les trois, sa CI est verte, aucune avance n'a été faite deux fois.
    const tete = forge.git("rev-parse", cible);
    expect(forge.git("show", `${tete}:src/m/lib.mjs`)).toBe("export function g() { return 1; }\nexport const h = 2;");
    expect(forge.git("show", `${tete}:src/m/use.mjs`)).toMatch(/import \{ g \}/);
    expect(await forge.checks({ proprietaire: "", nom: "" }, tete)).toMatchObject({ ok: true, valeur: { statut: "vert" } });
    expect(forge.journal().filter((j) => j.geste === "avancer")).toHaveLength(3);
    expect(await prisma.chantierReservation.count({ where: { OR: [{ missionId: id }, { mission: { parentMissionId: id } }] } })).toBe(0);
    // 1. Visible au tableau « Missions d'Adam » : tâches, file, coûts par rôle.
    const vue = (await tableauDesTravaux(admin)).find((m) => m.id === id);
    expect(vue?.programme?.taches.map((t) => t.etat)).toEqual(["INTEGREE", "INTEGREE", "INTEGREE"]);
    expect(vue?.programme?.file.map((f) => f.statut)).toEqual(["FUSIONNEE", "RENVOYEE", "FUSIONNEE", "FUSIONNEE"]);
    expect(vue?.avancement).toMatchObject({ faites: 3, total: 3 });
    expect((await tableauDesTravaux(admin)).filter((m) => m.parentId === id)).toHaveLength(3);
    fs.rmSync(forge.racine, { recursive: true, force: true });
  });

  it("BUDGET : un programme à son plafond ne lance aucun travailleur ; un salarié ne valide rien", async () => {
    const r = await lancerProgramme(admin, { plan: { titre: `${TAG} budget`, objectif: "plafond", depot: { proprietaire: "banc", nom: `${TAG}-b` }, cible: "claude/b", budget: { usd: 1 }, taches: [tache("a", ["src/a/**"])] } });
    if (!r.ok) throw new Error(r.erreur);
    await compter(r.programmeId, { costUsd: 1.5 });
    const b = await conduireProgramme(r.programmeId, { clock: new Horloge(), cerveau });
    expect(b).toMatchObject({ arret: "BUDGET", lances: [] });
    const m = await prisma.mission.findUnique({ where: { id: r.programmeId }, select: { status: true, pausedReason: true } });
    expect(m?.status).toBe("PAUSED");
    expect(m?.pausedReason).toMatch(/^BUDGET_HOLD/);
    expect(await prisma.mission.count({ where: { parentMissionId: r.programmeId } })).toBe(0);
    const valider = OUTILS_PROGRAMME.find((o) => o.def.name === "valider_programme")!;
    expect(JSON.parse(await valider.run({ programmeId: r.programmeId, decision: "valide" }, salarie))).toMatchObject({ statut: "REFUS" });
  });
});
