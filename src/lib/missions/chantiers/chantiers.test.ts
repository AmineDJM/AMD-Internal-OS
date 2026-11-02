import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { conduireChantier, type DepsChantier } from "@/lib/missions/chantiers/conduite";
import { annulerChantier, approuverChantier, demanderRevertFusion, ouEnEstChantier, proposerChantier, validerGesteChantier } from "@/lib/missions/chantiers/service";
import { reveillerChantiersSurFait } from "@/lib/missions/chantiers/reveil";
import { lireCarnet } from "@/lib/missions/travaux/carnet";
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
 *   • fusion : carte « Fusionner la PR #n » (orale), fusion AU SHA vérifié, CI de la base, puis la production a SA carte ;
 *     préproduction autonome après fusion ; protection de branche → refus dit ; base rouge → PR de revert (compensation) ;
 *   • réveil par un fait DEV_* (webhook) ; rapport final au Drive, aux livrables, conversation prévenue ;
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
/** Les plafonds du JOUR sont communs à toute la suite (et aux autres bancs) : relevés ici ; ceux du chantier restent par défaut. */
const REGLAGES_BANC: ReglagesChantiers = { ...REGLAGES_CHANTIERS_DEFAUT, jourLancementsMax: 100, jourDeploiementsMax: 100, jourUsdMax: 1000 };
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
  // La fusion (DEV_FUSIONNER) est au plan type ; les bancs d'avant la fusion la retirent, ceux de la fusion la remettent.
  fusion: false,
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
async function jusquAuBout(id: string, ports: FauxPorts, o: { cerveau?: CerveauChantier; reglages?: ReglagesChantiers; max?: number; horloge?: Horloge; deps?: Partial<DepsChantier> } = {}) {
  const h = o.horloge ?? new Horloge();
  for (let i = 0; i < (o.max ?? 30); i++) {
    await conduireChantier(id, { ...(o.deps ?? {}), ports, cerveau: o.cerveau ?? cerveauFactice().c, clock: h, reglages: o.reglages ?? REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
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
    // Le tableau « Missions » dit le tour de correction.
    expect((await tableauDesTravaux(admin)).find((x) => x.id === id)!.etapes.find((e) => e.cle === "corriger")?.essais).toBe(1);
  });

  it("l'Auto-fix d'abord : un rouge laisse à la session le temps de corriger SA PR — corrigé sans aucune relance payée", async () => {
    const ports = fauxPortsDev({ surSession: () => ({ sha: "acac000000000001", checks: "rouge", extrait: "FAIL lint" }) });
    const id = await lancer(plan());
    const h = new Horloge();
    for (let i = 0; i < 4; i++) {
      await conduireChantier(id, { ports, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
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

  it("production : carte « Fusionner la PR #1 » (orale), fusion au SHA vérifié, CI de main, PUIS sa propre carte de production", async () => {
    const ports = fauxPortsDev({ surSession: vert("eeee000000000001") });
    const p = plan({ fusion: true, services: [{ id: `srv-${TAG}-prod`, nom: "App", role: "app", production: true, branche: "main", url: "https://app.test", healthCheckPath: "/" }] });
    const id = await lancer(p);
    const h = new Horloge();
    expect(await jusquAuBout(id, ports, { max: 4, horloge: h })).not.toBe("COMPLETED");
    const vue = (await ouEnEstChantier(admin, id))[0]!;
    expect(vue.validationsAttendues[0]).toMatch(/Fusionner la PR #1 \(« .+ »\) dans main — SHA vérifié eeee000/);
    expect(ports.journal.some((j) => j.quoi === "fusionner" || j.quoi === "deployer")).toBe(false);
    // « vas-y » à la voix : la validation ORALE suffit.
    expect((await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "oral" })).ok).toBe(true);
    expect(await jusquAuBout(id, ports, { max: 4, horloge: h })).not.toBe("COMPLETED");
    expect(ports.journal.find((j) => j.quoi === "fusionner")!.detail).toMatchObject({ numero: 1, shaAttendu: "eeee000000000001" });
    expect(ports.journal.some((j) => j.quoi === "deployer")).toBe(false);
    // La PRODUCTION a sa propre carte, sur le commit de fusion vérifié par la CI de main.
    const vue2 = (await ouEnEstChantier(admin, id))[0]!;
    expect(vue2.validationsAttendues[0]).toMatch(/déployer App en PRODUCTION \(SHA vérifié fusion1\)/);
    expect((await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "ecrit" })).ok).toBe(true);
    expect(await jusquAuBout(id, ports, { horloge: h })).toBe("COMPLETED");
    const d = await dossier(id);
    expect(d.fusion).toMatchObject({ sha: "fusion1".padEnd(12, "0"), pr: 1, base: "main" });
    expect(Object.values(d.validations).map((v) => v.canal)).toEqual(["oral", "ecrit"]);
    expect(d.vert?.sha).toBe("fusion1".padEnd(12, "0"));
    expect(d.deploiements[0]).toMatchObject({ commit: "fusion1".padEnd(12, "0"), sain: true });
    expect(ports.journal.map((j) => j.quoi)).toEqual(["lancer", "ouvrirPr", "fusionner", "deployer"]);
    expect(d.rapport?.texte).toMatch(/fusion/i);
  });

  it("fusion validée, puis préproduction AUTONOME : une seule carte, déploiement du commit de fusion sans autre geste", async () => {
    const ports = fauxPortsDev({ surSession: vert("e1e1000000000001") });
    const id = await lancer(plan({ fusion: true }));
    const h = new Horloge();
    await jusquAuBout(id, ports, { max: 4, horloge: h });
    expect((await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "oral" })).ok).toBe(true);
    expect(await jusquAuBout(id, ports, { horloge: h })).toBe("COMPLETED");
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "CHANTIER_VALIDATION_DEMANDEE" } })).toBe(1);
    expect((await dossier(id)).deploiements[0]).toMatchObject({ commit: "fusion1".padEnd(12, "0"), statut: "live" });
  });

  it("fusion REFUSÉE par la protection de branche : dit clairement, rien n'est déployé", async () => {
    const ports = fauxPortsDev({ surSession: vert("e2e2000000000001"), fusionRefusee: true });
    const id = await lancer(plan({ fusion: true }));
    const h = new Horloge();
    await jusquAuBout(id, ports, { max: 4, horloge: h });
    await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "ecrit" });
    expect(["BLOCKED", "PARTIAL", "FAILED"]).toContain(await jusquAuBout(id, ports, { horloge: h }));
    const d = await dossier(id);
    expect(d.blocage).toMatch(/fusion refusée : .*protection de branche/);
    expect(d.fusion).toBeNull();
    expect(ports.journal.some((j) => j.quoi === "deployer")).toBe(false);
  });

  it("CI de main ROUGE après la fusion : rien n'est déployé ; la compensation ouvre une PR de REVERT (jamais un force-push)", async () => {
    const ports = fauxPortsDev({ surSession: vert("e3e3000000000001"), ciBase: "rouge" });
    const id = await lancer(plan({ fusion: true }));
    const h = new Horloge();
    await jusquAuBout(id, ports, { max: 4, horloge: h });
    await validerGesteChantier(id, admin, { decision: "ACCORDEE", canal: "ecrit" });
    expect(["BLOCKED", "PARTIAL", "FAILED"]).toContain(await jusquAuBout(id, ports, { horloge: h }));
    const d = await dossier(id);
    expect(d.blocage).toMatch(/main est ROUGE sur le commit de fusion/);
    expect(d.fusion?.pr).toBe(1);
    expect(ports.journal.some((j) => j.quoi === "deployer")).toBe(false);
    // Un salarié ne compense rien ; la Direction, si.
    expect((await demanderRevertFusion(id, salarie)).ok).toBe(false);
    expect((await demanderRevertFusion(id, admin)).ok).toBe(true);
    await conduireChantier(id, { ports, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
    expect((await dossier(id)).revert).toMatchObject({ numero: 101 });
    expect(ports.journal.filter((j) => j.quoi === "revert")).toHaveLength(1);
    // Idempotent : redemander ne rouvre pas une seconde PR.
    await demanderRevertFusion(id, admin);
    await conduireChantier(id, { ports, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
    expect(ports.journal.filter((j) => j.quoi === "revert")).toHaveLength(1);
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "CHANTIER_REVERT" } })).toBe(1);
  });

  it("le réveil par un fait (webhook DEV_*) : l'étape qui attendait repart tout de suite ; un fait étranger ne réveille rien", async () => {
    const ports = fauxPortsDev({ surSession: () => null });
    const p = plan();
    const id = await lancer(p);
    await jusquAuBout(id, ports, { max: 2 });
    expect((await etapes(id)).attendre!.status).toBe("WAITING");
    expect(await reveillerChantiersSurFait({ type: "DEV_PUSH", relatedRefs: [`BRANCHE:aminedjm/autre-${TAG}:x`] })).not.toContain(id);
    expect(await reveillerChantiersSurFait({ type: "FACTURE_PAYEE", relatedRefs: [`BRANCHE:aminedjm/depot-${TAG}:${p.branche}`] })).toEqual([]);
    expect(await reveillerChantiersSurFait({ type: "DEV_PUSH", relatedRefs: [`BRANCHE:aminedjm/depot-${TAG}:${p.branche}`] })).toContain(id);
    expect((await etapes(id)).attendre!.status).toBe("READY");
    expect((await prisma.mission.findUnique({ where: { id }, select: { reveilDemandeLe: true } }))?.reveilDemandeLe).not.toBeNull();
    await annulerChantier(id, admin);
  });

  it("le rapport final part au Drive (dossier « Travaux ») et rejoint les livrables ; la conversation est prévenue (K3)", async () => {
    const ports = fauxPortsDev({ surSession: vert("e4e4000000000001") });
    const id = await lancer(plan());
    const depots: { cle: string; titre: string; reprise: boolean }[] = [];
    const fins: string[] = [];
    const deps: Partial<DepsChantier> = {
      deposerRapport: async (_p, d) => { depots.push({ cle: d.cle, titre: d.titre, reprise: d.reprise }); return { ok: true, document: { nodeId: `node-${TAG}`, nom: "Rapport.docx", lien: `/drive/node-${TAG}` } }; },
      surFin: async (x) => { fins.push(x); },
    };
    expect(await jusquAuBout(id, ports, { deps })).toBe("COMPLETED");
    // Une seule fois, même si la conduite repasse.
    await conduireChantier(id, { ...deps, ports, cerveau: cerveauFactice().c, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
    expect(depots).toHaveLength(1);
    expect(depots[0]!.titre).toMatch(/Rapport/);
    const d = await dossier(id);
    expect(d.rapport?.document).toMatchObject({ lien: `/drive/node-${TAG}` });
    const carnet = (await prisma.mission.findUnique({ where: { id }, select: { carnet: true } }))!.carnet;
    expect(lireCarnet(carnet).livrables.at(-1)?.document?.lien).toBe(`/drive/node-${TAG}`);
    expect(lireDossier(carnet)?.plan.titre).toBe(d.plan.titre);
    expect(fins).toContain(id);
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
    const serre = { ...REGLAGES_BANC, lancementsMax: 1 };
    expect(await jusquAuBout(id, ports, { reglages: serre })).toBe("PAUSED");
    const m = await prisma.mission.findUnique({ where: { id }, select: { pausedReason: true } });
    expect(m?.pausedReason).toMatch(/^BUDGET_HOLD — 1 lancements de Claude Code sur 1/);
    // Un plafond de CHANTIER se lève seul quand la console le relève : la conduite suivante reprend sans clic.
    expect(await jusquAuBout(id, ports, { reglages: { ...REGLAGES_BANC, lancementsMax: 3 } })).toBe("COMPLETED");
  });

  it("deux chantiers au périmètre recouvrant : le second attend en file, puis part quand le premier libère", async () => {
    const pA = fauxPortsDev({ surSession: vert("1a1a000000000001") });
    const pB = fauxPortsDev({ surSession: vert("2b2b000000000001") });
    const a = await lancer(plan({ perimetre: ["src/lib/missions/**"] }));
    const b = await lancer(plan({ perimetre: ["src/lib/missions/chantiers/**"] }));
    const h = new Horloge();
    await conduireChantier(a, { ports: pA, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU, vagues: 1 });
    await conduireChantier(b, { ports: pB, cerveau: cerveauFactice().c, clock: h, reglages: REGLAGES_BANC, interrupteur: PAS_SUSPENDU });
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
