import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { conduireChantier } from "@/lib/missions/chantiers/conduite";
import { annulerChantier, approuverChantier, ouEnEstChantier, proposerChantier, validerGesteChantier } from "@/lib/missions/chantiers/service";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { REGLAGES_CHANTIERS_DEFAUT, type ReglagesChantiers } from "@/lib/missions/chantiers/regles";
import { fauxPortsDev, type FauxPorts, type ScenarioDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { extraitMemoire } from "@/lib/missions/chantiers/memoire";
import { tableauDesTravaux } from "@/lib/missions/travaux/tableau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHANTIERS (lot C1, décision 0042) — sur la vraie base et le vrai moteur, avec des PORTS FACTICES (forge,
 * hébergeur, Claude Code en mémoire) et un cerveau factice qui compte ses appels :
 *
 *   • succès de bout en bout (lancer → commit → vert → déployer → sain → rapport → TERMINÉ) ;
 *   • CI rouge corrigée au 2ᵉ tour (commentaire @claude sur la PR) ;
 *   • même échec 3× → Sol consulté UNE fois au 2ᵉ, blocage RÉEL au 3ᵉ, rapport quand même ;
 *   • santé malsaine → rollback, autoDeploy coupé, conclusion refusée ;
 *   • production : carte de validation, fusion, REVÉRIFICATION de l'intégration, puis déploiement ;
 *   • conclusion REFUSÉE sans preuve de santé ;
 *   • budget : lancements épuisés → BUDGET_HOLD, réglage relevé → reprise seule ;
 *   • deux chantiers au périmètre recouvrant → le second attend la libération du premier ;
 *   • annulation : réservations libérées, rapport « annulé » ; le tableau « Missions » montre le chantier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ch__${Date.now()}`;
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);

class Horloge implements Clock {
  t = Date.now();
  now() { return new Date(this.t); }
}

function cerveauFactice() {
  const appels: string[] = [];
  const c: CerveauChantier = {
    disponibles: () => ({ mimo: true, terra: true, sol: true }),
    executer: async (niveau, d) => { appels.push(niveau); return { ok: true, texte: `${niveau} : corrige ${d.texte.slice(0, 40)}`, coutUsd: 0.001, modele: niveau }; },
  };
  return { c, appels };
}

let admin = "";
let salarie = "";
let n = 0;

const plan = (o: Record<string, unknown> = {}) => ({
  titre: `${TAG} chantier ${++n}`, objectif: "Ajouter une route de santé.",
  depot: { proprietaire: "aminedjm", nom: `depot-${TAG}` }, branche: `claude/${TAG}-${n}`,
  perimetre: [`src/lib/missions/chantiers/**`], criteres: ["la route rend 200"], commandesVerif: ["npm test"],
  services: [{ id: `srv-${TAG}-${n}`, nom: "ERP", role: "erp", production: false, url: "https://erp.test", healthCheckPath: "/api/health" }],
  ...o,
});

async function lancer(p: Record<string, unknown>): Promise<string> {
  const r = await proposerChantier(admin, p);
  if (!r.ok) throw new Error(r.fautes.join(" "));
  const a = await approuverChantier(r.chantierId, admin);
  if (!a.ok) throw new Error(a.erreur);
  return r.chantierId;
}

/** Conduit jusqu'à la fin (ou `max` passages), l'horloge avancée de 31 min entre deux : les attentes datées échoient. */
async function jusquAuBout(id: string, ports: FauxPorts, o: { cerveau?: CerveauChantier; reglages?: ReglagesChantiers; max?: number; horloge?: Horloge } = {}) {
  const h = o.horloge ?? new Horloge();
  for (let i = 0; i < (o.max ?? 30); i++) {
    await conduireChantier(id, { ports, cerveau: o.cerveau ?? cerveauFactice().c, clock: h, reglages: o.reglages ?? REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU });
    const s = (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))!.status;
    if (["COMPLETED", "CANCELLED", "FAILED", "BLOCKED", "PARTIAL", "PAUSED"].includes(s)) return s;
    h.t += 31 * 60_000;
  }
  return (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))!.status;
}

const dossier = async (id: string) => lireDossier((await prisma.mission.findUnique({ where: { id }, select: { carnet: true } }))!.carnet)!;
const etapes = async (id: string) => Object.fromEntries((await prisma.missionStep.findMany({ where: { missionId: id }, select: { key: true, status: true, result: true } })).map((s) => [s.key, s]));
const reservations = (id: string) => prisma.chantierReservation.count({ where: { missionId: id } });
const vert = (sha: string): ScenarioDev["surSession"] => () => ({ sha, checks: "vert" });

suite("chantiers — le moteur des travaux conduit Claude Code, GitHub et Render (C1)", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    salarie = (await prisma.user.create({ data: { name: `${TAG}Sami`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SALES_USER" } })).id;
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.memoireTechnique.deleteMany({ where: { cle: { contains: TAG } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("réservé au Super Admin", async () => {
    const r = await proposerChantier(salarie, plan());
    expect(r).toEqual({ ok: false, fautes: ["les chantiers de développement sont réservés au Super Admin"] });
  });

  it("succès de bout en bout : TERMINÉ seulement avec SHA vert, déploiement live, santé 200 et coût", async () => {
    const ports = fauxPortsDev({ surSession: vert("aaaa111122223333") });
    const id = await lancer(plan());
    expect(await jusquAuBout(id, ports)).toBe("COMPLETED");
    const d = await dossier(id);
    expect(d.vert?.sha).toBe("aaaa111122223333");
    expect(d.deploiements).toMatchObject([{ statut: "live", commit: "aaaa111122223333", sain: true, sante: { statut: 200 } }]);
    expect(d.rapport?.issue).toBe("LIVRE");
    expect(d.rapport?.texte).toMatch(/Checks verts sur aaaa111122223333/);
    expect(d.compteurs).toMatchObject({ lancements: 1, deploiements: 1 });
    const e = await etapes(id);
    expect(e.corriger!.status).toBe("SKIPPED");
    expect(e["rollback-" + `srv-${TAG}-${n}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)]!.status).toBe("SKIPPED");
    expect(await reservations(id)).toBe(0);
    expect(ports.journal.map((j) => j.quoi)).toEqual(["lancer", "ouvrirPr", "deployer"]);
    // LA MÉMOIRE TECHNIQUE a appris le dépôt et le service : le prochain chantier ne les réanalyse pas.
    const m = await extraitMemoire({ cles: [{ type: "depot", cle: `aminedjm/depot-${TAG}`.toLowerCase() }] });
    expect(m).toMatch(/Commandes de vérification : npm test/);
    const fin = await prisma.mission.findUnique({ where: { id }, select: { goalSatisfied: true, goalVerdict: true } });
    expect(fin).toMatchObject({ goalSatisfied: true });
    expect(fin?.goalVerdict).toMatch(/Preuves réunies/);
  });

  it("CI rouge corrigée au 2ᵉ tour : le problème part en commentaire @claude sur la PR, puis vert", async () => {
    const ports = fauxPortsDev({
      surSession: (k) => (k === 1 ? { sha: "bbbb000000000001", checks: "rouge", extrait: "FAIL src/x.test.ts > attendu 200, reçu 500" } : { sha: "bbbb000000000002", checks: "vert" }),
    });
    const cerveau = cerveauFactice();
    const id = await lancer(plan());
    expect(await jusquAuBout(id, ports, { cerveau: cerveau.c })).toBe("COMPLETED");
    const e = await etapes(id);
    expect(e.verifier!.result).toMatchObject({ vert: false });
    expect(e.corriger!.status).toBe("DONE");
    expect(e.corriger!.result).toMatchObject({ vert: true, sha: "bbbb000000000002", tours: 1 });
    const commentaire = ports.journal.find((j) => j.quoi === "commenter")!.detail as { texte: string };
    expect(commentaire.texte).toMatch(/^@claude /);
    expect(commentaire.texte).toMatch(/attendu 200, reçu 500/);
    // Extrait court : transmis tel quel — AUCUN modèle payé pour le relire.
    expect(cerveau.appels).toEqual([]);
    expect((await dossier(id)).compteurs.lancements).toBe(2);
  });

  it("l'Auto-fix d'abord : un rouge laisse à la session le temps de corriger SA PR — corrigé sans aucune relance payée", async () => {
    const ports = fauxPortsDev({ surSession: () => ({ sha: "acac000000000001", checks: "rouge", extrait: "FAIL lint" }) });
    const id = await lancer(plan());
    const h = new Horloge();
    for (let i = 0; i < 4; i++) {
      await conduireChantier(id, { ports, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU });
      h.t += 31 * 60_000;
      if ((await etapes(id)).corriger?.status === "WAITING") break;
    }
    expect(((await etapes(id)).corriger!.result as { attente: string }).attente).toMatch(/Auto-fix/);
    // La session corrige elle-même (Auto-fix de la PR) : un commit vert arrive sans qu'Adam ait rien relancé.
    ports.pousser((await dossier(id)).plan.branche, "acac000000000002", "vert");
    h.t -= 31 * 60_000;
    h.t += 4 * 60_000;
    expect(await jusquAuBout(id, ports, { horloge: h })).toBe("COMPLETED");
    expect((await dossier(id)).compteurs.lancements).toBe(1);
    expect(ports.journal.filter((j) => j.quoi === "commenter" || j.quoi === "relancer")).toEqual([]);
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "CHANTIER_AUTOFIX" } })).toBe(1);
  });

  it("même échec 3× : Sol consulté une seule fois (2ᵉ), blocage réel au 3ᵉ, rien déployé, rapport quand même", async () => {
    const ports = fauxPortsDev({ surSession: (k) => ({ sha: `cccc00000000000${k}`, checks: "rouge", extrait: `FAIL src/y.test.ts:${10 + k} attendu ${k} reçu ${k + 1}` }) });
    const cerveau = cerveauFactice();
    const id = await lancer(plan());
    const s = await jusquAuBout(id, ports, { cerveau: cerveau.c });
    expect(["PARTIAL", "BLOCKED"]).toContain(s);
    expect(cerveau.appels).toEqual(["SOL"]);
    const d = await dossier(id);
    expect(d.blocage).toMatch(/le même échec s'est produit 3 fois/);
    expect(d.solPour).toHaveLength(1);
    expect(d.deploiements).toEqual([]);
    expect(ports.journal.filter((j) => j.quoi === "deployer")).toEqual([]);
    expect(d.rapport?.issue).not.toBe("LIVRE");
    expect(d.rapport?.texte).toMatch(/Blocage : le même échec/);
    expect(await reservations(id)).toBe(0);
    const e = await etapes(id);
    expect(e.corriger!.status).toBe("FAILED");
    // L'incident entre en mémoire : la prochaine consigne sur ce dépôt le citera.
    expect(await prisma.memoireTechnique.count({ where: { type: "incident", cle: { startsWith: `aminedjm/depot-${TAG}`.toLowerCase() } } })).toBeGreaterThan(0);
  });

  it("santé malsaine : rollback vers le dernier déploiement sain, autoDeploy coupé, conclusion refusée", async () => {
    const ports = fauxPortsDev({ surSession: vert("dddd000000000001"), sante: () => 503 });
    const id = await lancer(plan());
    expect(await jusquAuBout(id, ports)).toBe("BLOCKED");
    const d = await dossier(id);
    expect(d.deploiements[0]).toMatchObject({ sain: false, rollback: { statut: "live" } });
    expect(ports.journal.map((j) => j.quoi)).toEqual(expect.arrayContaining(["rollback", "autoDeploy"]));
    expect(ports.journal.find((j) => j.quoi === "autoDeploy")!.detail).toMatchObject({ actif: false });
    const fin = await prisma.mission.findUnique({ where: { id }, select: { goalVerdict: true } });
    expect(fin?.goalVerdict).toMatch(/Conclusion refusée faute de preuves/);
  });

  it("production : carte de validation, fusion sur main, revérification du SHA d'intégration, puis déploiement", async () => {
    const ports = fauxPortsDev({ surSession: vert("eeee000000000001") });
    const p = plan({ services: [{ id: `srv-${TAG}-prod`, nom: "App", role: "app", production: true, branche: "main", url: "https://app.test", healthCheckPath: "/" }] });
    const id = await lancer(p);
    const h = new Horloge();
    expect(await jusquAuBout(id, ports, { max: 4, horloge: h })).not.toBe("COMPLETED");
    const vue = (await ouEnEstChantier(admin, id))[0]!;
    expect(vue.validationsAttendues[0]).toMatch(/fusionner la PR #1 sur main puis déployer App en PRODUCTION/);
    expect(ports.journal.some((j) => j.quoi === "fusionner" || j.quoi === "deployer")).toBe(false);
    expect((await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "oral" })).ok).toBe(true);
    expect(await jusquAuBout(id, ports, { horloge: h })).toBe("COMPLETED");
    const d = await dossier(id);
    expect(d.validations).toMatchObject({ [Object.keys(d.validations)[0]!]: { decision: "ACCORDEE", canal: "oral" } });
    expect(d.vert?.sha).toBe("fusion1".padEnd(12, "0"));
    expect(d.deploiements[0]).toMatchObject({ commit: "fusion1".padEnd(12, "0"), sain: true });
    expect(ports.journal.map((j) => j.quoi)).toEqual(["lancer", "ouvrirPr", "fusionner", "deployer"]);
  });

  it("conclusion REFUSÉE sans preuve : un plan qui ne vérifie pas la santé ne finit pas « terminé »", async () => {
    const ports = fauxPortsDev({ surSession: vert("ffff000000000001") });
    const p = plan();
    const srv = (p.services as { id: string }[])[0]!.id;
    const id = await lancer({
      ...p,
      etapes: [
        { cle: "lancer", type: "DEV_LANCER" }, { cle: "attendre", type: "DEV_ATTENDRE", apres: ["lancer"] },
        { cle: "verifier", type: "DEV_VERIFIER", apres: ["attendre"] }, { cle: "deployer", type: "RENDER_DEPLOYER", service: srv, apres: ["verifier"] },
        { cle: "rapport", type: "RAPPORT", apres: ["deployer"] },
      ],
    });
    expect(await jusquAuBout(id, ports)).toBe("BLOCKED");
    const fin = await prisma.mission.findUnique({ where: { id }, select: { goalSatisfied: true, goalVerdict: true } });
    expect(fin?.goalSatisfied).toBe(false);
    expect(fin?.goalVerdict).toMatch(/santé non démontrée/);
  });

  it("budget : lancements épuisés → BUDGET_HOLD ; le plafond relevé, le chantier reprend seul et finit", async () => {
    const ports = fauxPortsDev({ surSession: (k) => (k === 1 ? { sha: "abab000000000001", checks: "rouge", extrait: "Type error" } : { sha: "abab000000000002", checks: "vert" }) });
    const id = await lancer(plan());
    const serre = { ...REGLAGES_CHANTIERS_DEFAUT, lancementsMax: 1 };
    expect(await jusquAuBout(id, ports, { reglages: serre })).toBe("PAUSED");
    const m = await prisma.mission.findUnique({ where: { id }, select: { pausedReason: true } });
    expect(m?.pausedReason).toMatch(/^BUDGET_HOLD — 1 lancements de Claude Code sur 1/);
    // Un plafond de CHANTIER se lève seul quand la console le relève : la conduite suivante reprend sans clic.
    expect(await jusquAuBout(id, ports, { reglages: { ...REGLAGES_CHANTIERS_DEFAUT, lancementsMax: 3 } })).toBe("COMPLETED");
  });

  it("deux chantiers au périmètre recouvrant : le second attend en file, puis part quand le premier libère", async () => {
    const pA = fauxPortsDev({ surSession: vert("1a1a000000000001") });
    const pB = fauxPortsDev({ surSession: vert("2b2b000000000001") });
    const a = await lancer(plan({ perimetre: ["src/lib/missions/**"] }));
    const b = await lancer(plan({ perimetre: ["src/lib/missions/chantiers/**"] }));
    const h = new Horloge();
    await conduireChantier(a, { ports: pA, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU, vagues: 1 });
    await conduireChantier(b, { ports: pB, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU });
    const eb = await etapes(b);
    expect(eb.lancer!.status).toBe("WAITING");
    expect((eb.lancer!.result as { attente: string }).attente).toMatch(/en file : le périmètre « src\/lib\/missions\/chantiers\/\*\* » recouvre « src\/lib\/missions\/\*\* »/);
    expect(pB.journal).toEqual([]);
    expect(await jusquAuBout(a, pA, { horloge: h })).toBe("COMPLETED");
    expect(await jusquAuBout(b, pB, { horloge: h })).toBe("COMPLETED");
    expect(pB.journal[0]?.quoi).toBe("lancer");
  });

  it("annuler : réservations libérées, rapport « annulé » ; le tableau « Missions » montre le chantier, ses réservations et ses liens", async () => {
    const ports = fauxPortsDev({ surSession: () => null });
    const id = await lancer(plan());
    await jusquAuBout(id, ports, { max: 2 });
    const tableau = (await tableauDesTravaux(admin)).find((x) => x.id === id)!;
    expect(tableau.chantier).toMatchObject({ depot: `aminedjm/depot-${TAG}`, sessions: [{ url: "https://claude.ai/code/session-1" }] });
    expect(tableau.chantier!.reservations.some((r) => r.startsWith("BRANCHE:"))).toBe(true);
    expect(tableau.etapes.find((e) => e.cle === "attendre")?.etat).toBe("ATTENTE");
    expect((await annulerChantier(id, admin)).ok).toBe(true);
    expect(await reservations(id)).toBe(0);
    expect((await dossier(id)).rapport?.issue).toBe("ANNULE");
  });
});
