import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { balayerChantiers } from "@/lib/missions/chantiers/service";
import { REGLAGES_CHANTIERS_DEFAUT } from "@/lib/missions/chantiers/regles";
import { fauxPortsDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { OUTILS_PROGRAMME } from "@/lib/missions/equipe/outils";
import { conduireProgramme } from "@/lib/missions/equipe/conduite";
import { lireLeDossierProgramme } from "@/lib/missions/equipe/dossier";
import { annulerProgramme, lancerProgramme, ouEnEstProgramme } from "@/lib/missions/equipe/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * O2-2 (décision 0059) — LES PROGRAMMES SUR LA VRAIE BASE ET LE VRAI MOTEUR DES CHANTIERS, ports factices :
 *   • lancé par l'outil d'Adam (Super Admin seul ; un salarié est refusé ; un travailleur autre que les sessions cloud est refusé) ;
 *   • TROIS tâches indépendantes → trois chantiers enfants, trois sessions lancées EN MÊME TEMPS (mesuré) ;
 *   • chaque chantier vert passe ses réservations au programme (tenues jusqu'à l'intégration) ;
 *   • deux tâches qui se recouvrent → une seule part, l'autre attend « sérialisée après … » ;
 *   • l'annulation arrête les chantiers et libère tout.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__o2p__${Date.now()}`;
const REGLAGES = { ...REGLAGES_CHANTIERS_DEFAUT, jourLancementsMax: 100, jourDeploiementsMax: 100, jourUsdMax: 1000 };
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
const cerveau: CerveauChantier = { disponibles: () => ({ mimo: false, terra: false, sol: false }), executer: async () => ({ ok: false, erreur: "aucun modèle au banc" }) };
class Horloge implements Clock { t = Date.now(); now() { return new Date(this.t); } }

let admin = "";
let salarie = "";
const depot = { proprietaire: "aminedjm", nom: `depot-${TAG}` };
const tache = (cle: string, perimetre: string[], o: Record<string, unknown> = {}) => ({
  cle, titre: `Tâche ${cle}`, objectif: `Écrire ${cle}`, perimetre, criteres: [`npm test -- ${cle} rend 0 échec`], commandesVerif: [`npm test -- ${cle}`], ...o,
});
const planDe = (taches: unknown[], o: Record<string, unknown> = {}) => ({ titre: `${TAG} programme`, objectif: "Banc O2", depot, cible: `claude/${TAG}-cible`, taches, ...o });

/** Une session factice : pousse un fichier DANS son périmètre, checks verts ; mesure combien travaillent EN MÊME TEMPS. */
function equipeFactice() {
  let enCours = 0;
  let max = 0;
  const ports = fauxPortsDev({
    surSession: (_n, c) => ({ sha: `${c.branche.slice(-6)}`.padEnd(12, "0"), checks: "vert", fichiers: [c.perimetre[0]!.replace("**", "x.ts")] }),
  });
  const lancer = ports.agent.lancer.bind(ports.agent);
  ports.agent.lancer = async (c, cle) => {
    enCours += 1;
    max = Math.max(max, enCours);
    await new Promise((r) => setTimeout(r, 300));
    try { return await lancer(c, cle); } finally { enCours -= 1; }
  };
  return { ports, max: () => max };
}

suite("programmes — une équipe de chantiers sous un ordonnanceur déterministe (O2-2)", () => {
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

  it("PERMISSIONS : un salarié est refusé ; un travailleur autre que les sessions cloud est refusé (décision de la Direction)", async () => {
    const outil = OUTILS_PROGRAMME.find((o) => o.def.name === "lancer_un_programme")!;
    expect(JSON.parse(await outil.run({ plan: planDe([tache("a", ["src/lib/a/**"])]) }, salarie))).toMatchObject({ statut: "PLAN_REFUSE", raison: "les chantiers de développement sont réservés au Super Admin" });
    const ma = await lancerProgramme(admin, { plan: planDe([tache("a", ["src/lib/a/**"])], { travailleur: "managed-agents" }) });
    expect(ma.ok).toBe(false);
    expect(!ma.ok && ma.fautes?.join(" ")).toMatch(/sessions cloud Claude Code \(abonnement\)/);
  });

  it("TROIS travailleurs indépendants EN PARALLÈLE, lancés depuis l'outil d'Adam ; réservations passées au programme une fois verts", { timeout: 60_000 }, async () => {
    const outil = OUTILS_PROGRAMME.find((o) => o.def.name === "lancer_un_programme")!;
    const sortie = JSON.parse(await outil.run({ plan: planDe([tache("a", ["src/lib/o2a/**"]), tache("b", ["src/lib/o2b/**"]), tache("c", ["src/lib/o2c/**"])]) }, admin)) as { statut: string; programmeId: string };
    expect(sortie.statut).toBe("DEMARRE");
    const id = sortie.programmeId;
    const h = new Horloge();
    const b1 = await conduireProgramme(id, { clock: h, cerveau });
    expect(b1.lances).toEqual(["a", "b", "c"]);
    const enfants = await prisma.mission.findMany({ where: { parentMissionId: id, kind: "CHANTIER" }, select: { id: true, status: true } });
    expect(enfants).toHaveLength(3);
    // Rejouer le passage ne lance RIEN de plus (idempotent : les tâches sont LANCEE).
    expect((await conduireProgramme(id, { clock: h, cerveau })).lances).toEqual([]);
    const { ports, max } = equipeFactice();
    await balayerChantiers({ clock: h, interrupteur: PAS_SUSPENDU, seulement: enfants.map((e) => e.id), deps: { ports, cerveau, reglages: { ...REGLAGES, enParallele: 3 } } });
    expect(max()).toBe(3);
    for (let i = 0; i < 6; i++) {
      h.t += 31 * 60_000;
      await balayerChantiers({ clock: h, interrupteur: PAS_SUSPENDU, seulement: enfants.map((e) => e.id), deps: { ports, cerveau, reglages: { ...REGLAGES, enParallele: 3 } } });
    }
    const statuts = await prisma.mission.findMany({ where: { parentMissionId: id }, select: { status: true } });
    expect(statuts.map((s) => s.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(ports.journal.filter((j) => j.quoi === "lancer" || j.quoi === "relancer")).toHaveLength(3);
    // Les réservations des enfants verts sont TENUES par le programme (jusqu'à l'intégration), plus par les enfants.
    expect(await prisma.chantierReservation.count({ where: { missionId: { in: enfants.map((e) => e.id) } } })).toBe(0);
    const tenues = await prisma.chantierReservation.findMany({ where: { missionId: id }, select: { cle: true } });
    expect(tenues.map((r) => r.cle).filter((c) => c.startsWith("PERIMETRE:")).sort()).toEqual(["a", "b", "c"].map((x) => `PERIMETRE:${`${depot.proprietaire}/${depot.nom}`.toLowerCase()}:src/lib/o2${x}/**`));
    await conduireProgramme(id, { clock: h, cerveau });
    const d = await lireLeDossierProgramme(id);
    expect(Object.values(d.taches).map((t) => t.etat)).toEqual(["EN_FILE", "EN_FILE", "EN_FILE"]);
    const [vue] = await ouEnEstProgramme(admin, id);
    expect(vue!.taches.map((t) => t.travailleur.sessions)).toEqual([1, 1, 1]);
    expect(vue!.couts.infra).toMatch(/aucun déploiement/);
    expect(vue!.couts.sessions).toMatchObject({ lancees: 3, plafondHeure: 25 });
    expect(vue!.couts.modelesUsd).toEqual({ superviseur: 0, chantiers: 0 });
  });

  it("deux tâches qui SE RECOUVRENT : une seule part, l'autre attend « sérialisée » ; l'annulation libère tout", async () => {
    const r = await lancerProgramme(admin, { plan: planDe([tache("a", ["src/lib/finance/**"]), tache("b", ["src/lib/finance/tva.ts"])]) });
    if (!r.ok) throw new Error(r.erreur);
    const b = await conduireProgramme(r.programmeId, { clock: new Horloge(), cerveau });
    expect(b.lances).toEqual(["a"]);
    const d = await lireLeDossierProgramme(r.programmeId);
    expect(d.conflits).toEqual([{ a: "a", b: "b", motif: "périmètres « src/lib/finance/** » et « src/lib/finance/tva.ts »" }]);
    expect(d.taches.b!.raison).toMatch(/sérialisée après « a »/);
    const a = await annulerProgramme(r.programmeId, admin);
    expect(a.ok).toBe(true);
    expect((await prisma.mission.findUnique({ where: { id: r.programmeId }, select: { status: true } }))!.status).toBe("CANCELLED");
    expect((await prisma.mission.findMany({ where: { parentMissionId: r.programmeId }, select: { status: true } })).map((m) => m.status)).toEqual(["CANCELLED"]);
    expect(await prisma.chantierReservation.count({ where: { mission: { parentMissionId: r.programmeId } } })).toBe(0);
  });
});
