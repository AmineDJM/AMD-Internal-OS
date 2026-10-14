import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { lunaConfigured } from "@/lib/openai-luna";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { contentHash } from "./text";
import { ingestFast } from "./ingest";
import { stageEntities } from "./stages";
import { traiterJob, knowledgeHealth } from "./worker";
import { relancerTravauxMorts, reparerEtapesEnEchec, rattraperVecteurs, rattraperVisions, chargerBoiteMorte } from "./rattrapage";
import { cleDeGroupe } from "./boite-morte";
import { MAX_ATTEMPTS } from "./contract";
import { relancerBoiteMorte } from "@/lib/actions/knowledge-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE DE CONNAISSANCE, PAR SES VRAIS POINTS D'ENTRÉE — ce que l'écran de production a montré.
 *
 *   • « Boîte morte 441 » : une panne du FOURNISSEUR (clé, interrupteur, réseau) envoyait les
 *     travaux en boîte morte et passait les documents « en échec ». Ici : elle ATTEND, sans
 *     consommer d'essai, et l'étape du document ne bouge pas.
 *   • La boîte morte est RELANÇABLE par cause, proprement (essais remis à zéro), une seule fois
 *     (idempotent), bornée, et par le seul Super Admin.
 *   • Les éléments « en échec » laissés par l'ancienne règle retrouvent l'étape que leurs faits
 *     disent ; un fichier sans texte finit « sans texte lisible ».
 *   • Les vecteurs et lectures visuelles jamais faits sont rattrapés — jamais sans modèle.
 *
 * Tout ce qui est créé porte `__krel__` et est retiré à la fin, dans une base partagée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__krel__";
/** Un mot que rien d'autre n'écrit : les groupes de ce banc ne se mêlent pas à ceux des voisins. */
const MOT = "zqkrelzq";

async function nettoyer() {
  const items = await prisma.knowledgeItem.findMany({ where: { sourceId: { startsWith: TAG } }, select: { id: true } });
  const ids = items.map((i) => i.id);
  await prisma.knowledgeJob.deleteMany({ where: { OR: [{ itemId: { in: ids } }, { dedupeKey: { startsWith: TAG } }, { lastError: { contains: MOT } }] } });
  if (ids.length) {
    await prisma.knowledgeChunk.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.knowledgeItem.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
  if (users.length) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users.map((u) => u.id) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => undefined);
  }
}

async function element(nom: string, opts: { text?: string | null; stage?: string; extractedBy?: string; chunks?: number } = {}) {
  const text = opts.text === undefined ? `Texte de ${nom} suffisant pour être retrouvé.` : opts.text;
  const it = await prisma.knowledgeItem.create({
    data: {
      sourceType: "drive_file", sourceId: `${TAG}${nom}`, contentHash: contentHash(nom), title: `${nom}.pdf`,
      text, textFold: text ? text.toLowerCase() : null, stage: opts.stage ?? "READY", extractedBy: opts.extractedBy ?? "native",
    },
    select: { id: true },
  });
  for (let i = 0; i < (opts.chunks ?? 0); i += 1) {
    await prisma.knowledgeChunk.create({ data: { itemId: it.id, kind: "section", ord: i, text: `morceau ${i}`, textFold: `morceau ${i}` } });
  }
  return it.id;
}

async function travail(kind: string, itemId: string | null, data: { status: string; attempts?: number; lastError?: string | null }) {
  return prisma.knowledgeJob.create({
    data: { kind, itemId, status: data.status, attempts: data.attempts ?? 0, maxAttempts: MAX_ATTEMPTS, lastError: data.lastError ?? null, dedupeKey: `${TAG}${Math.random().toString(36).slice(2)}` },
    select: { id: true },
  });
}

async function acteur(nom: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { email: `${TAG}${nom}@t.dz`, name: `${TAG}${nom}`, role, passwordHash: "x" }, select: { id: true, name: true, email: true } });
  return { id: u.id, name: u.name, email: u.email, role, access: await getAccess(u.id, role), mustChangePassword: false };
}

suite("Couche de connaissance — pannes, boîte morte, rattrapages", () => {
  beforeAll(nettoyer);
  afterAll(nettoyer);
  afterEach(() => remplacerLecteurInterrupteurIaPourTests(null));

  it("PRÉMISSE : ce banc tourne sans clé du fournisseur — c'est la vraie situation qu'il éprouve", () => {
    expect(lunaConfigured()).toBe(false);
  });

  it("SANS CLÉ, une vectorisation ATTEND : aucun essai consommé, jamais la boîte morte, l'étape intacte", async () => {
    const itemId = await element("sans-cle", { chunks: 2 });
    // Le travail est au DERNIER essai : l'ancienne règle l'envoyait en boîte morte et passait le
    // document « en échec ».
    const j = await travail("embed", itemId, { status: "RUNNING", attempts: MAX_ATTEMPTS });
    const issue = await traiterJob({ id: j.id, kind: "embed", itemId, payload: null, attempts: MAX_ATTEMPTS });
    expect(issue).toBe("reporte");
    const job = await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(job.status).toBe("QUEUED");
    expect(job.attempts).toBe(MAX_ATTEMPTS - 1); // l'essai de la réclamation est rendu
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(job.lastError).toMatch(/En attente — panne temporaire/);
    expect((job.payload as { _reports?: number })._reports).toBe(1);
    const item = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.stage).toBe("READY");
  });

  it("SOUS L'INTERRUPTEUR COUPÉ, même chose — la clé présente ne change rien, rien ne part", async () => {
    const avant = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => true);
    const fetchEspion = vi.spyOn(globalThis, "fetch");
    try {
      const itemId = await element("interrupteur", { chunks: 1 });
      const j = await travail("embed", itemId, { status: "RUNNING", attempts: 1 });
      expect(await traiterJob({ id: j.id, kind: "embed", itemId, payload: null, attempts: 1 })).toBe("reporte");
      expect(fetchEspion).not.toHaveBeenCalled();
      const job = await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } });
      expect(job.status).toBe("QUEUED");
    } finally {
      fetchEspion.mockRestore();
      if (avant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = avant;
    }
  });

  it("une panne qui PERSISTE au-delà des reports finit en boîte morte — avec un motif qui le dit", async () => {
    const itemId = await element("persistante", { chunks: 1 });
    const j = await prisma.knowledgeJob.create({
      data: { kind: "embed", itemId, status: "RUNNING", attempts: 1, payload: { _reports: 20 }, dedupeKey: `${TAG}persist` },
    });
    expect(await traiterJob({ id: j.id, kind: "embed", itemId, payload: { _reports: 20 }, attempts: 1 })).toBe("mort");
    const job = await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(job.status).toBe("DEAD");
    expect(job.lastError).toMatch(/Panne persistante après 20 reports/);
  });

  it("un défaut du DOCUMENT au dernier essai : boîte morte, motif noté sur l'élément — son étape ne recule pas", async () => {
    const itemId = await element("defaut");
    const j = await travail("entities", itemId, { status: "RUNNING", attempts: MAX_ATTEMPTS });
    const issue = await traiterJob(
      { id: j.id, kind: "entities", itemId, payload: null, attempts: MAX_ATTEMPTS },
      { executer: async () => { throw new Error(`Format ${MOT} refusé`); } },
    );
    expect(issue).toBe("mort");
    expect((await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe("DEAD");
    const item = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.stage).toBe("READY"); // l'ancienne règle : FAILED, et le document sortait des retrouvables
    expect(item.error).toMatch(/Étape « entities » abandonnée/);
  });

  it("RELANCER une cause : propre (essais à zéro), seulement ce groupe, une seule fois, et les étapes réparées", async () => {
    const a = await element("rel-a", { stage: "FAILED" });
    const b = await element("rel-b", { stage: "FAILED", text: null });
    const autre = await element("rel-autre", { stage: "FAILED" });
    const motif = `Erreur ${MOT} du parseur`;
    const ja = await travail("classify", a, { status: "DEAD", attempts: 4, lastError: motif });
    const jb = await travail("classify", b, { status: "DEAD", attempts: 4, lastError: motif });
    const jAutre = await travail("classify", autre, { status: "DEAD", attempts: 4, lastError: `Autre ${MOT} chose` });
    await travail("entities", a, { status: "DONE" }); // a a été relié

    const cle = cleDeGroupe({ kind: "classify", lastError: motif, nom: "x.pdf" });
    const boite = await chargerBoiteMorte();
    expect(boite.groupes.find((g) => g.cle === cle)?.count).toBe(2);

    // DEUX clics en même temps : chaque travail n'est relancé qu'une fois. L'entrelacement est
    // FORCÉ : le banc verrouille les deux lignes, laisse les deux relances LIRE la boîte (les
    // lectures ne sont pas bloquées) et attend qu'elles soient toutes deux arrêtées sur leur
    // écriture, puis relâche. Sans cette barrière, les deux gestes se succèdent parfois, et le
    // cas passerait aussi sans la condition `status = 'DEAD'` qu'il existe pour garder.
    let barriere = false;
    const [r1, r2] = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "KnowledgeJob" WHERE id = ANY(${[ja.id, jb.id]}::text[]) FOR UPDATE`;
      const gestes = Promise.all([relancerTravauxMorts({ cle }), relancerTravauxMorts({ cle })]);
      for (let i = 0; i < 300 && !barriere; i += 1) {
        const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE "KnowledgeJob"%depuis la boîte morte%'`;
        if (Number(n) >= 2) barriere = true;
        else await new Promise((r) => setTimeout(r, 50));
      }
      return { gestes };
    }, { timeout: 30_000 }).then(({ gestes }) => gestes);
    expect(barriere, "les deux relances doivent avoir été arrêtées ENSEMBLE sur leur écriture").toBe(true);
    expect(r1.relances + r2.relances).toBe(2);

    for (const id of [ja.id, jb.id]) {
      const job = await prisma.knowledgeJob.findUniqueOrThrow({ where: { id } });
      expect(job.status).toBe("QUEUED");
      expect(job.attempts).toBe(0);
      expect(job.lastError).toContain(motif); // l'histoire du motif est gardée
      expect(job.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect((await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: jAutre.id } })).status).toBe("DEAD");

    // Les étapes : a avait un texte et une relation faite → relié ; b n'avait aucun texte → sans texte.
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: a } })).stage).toBe("READY");
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: b } })).stage).toBe("EMPTY");
    // L'élément de l'AUTRE cause n'a pas été touché par cette relance.
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: autre } })).stage).toBe("FAILED");

    // Rejouer le clic : rien.
    expect((await relancerTravauxMorts({ cle })).relances).toBe(0);
  });

  it("la relance est BORNÉE par clic, et le dit", async () => {
    const motif = `Borne ${MOT} atteinte`;
    for (let i = 0; i < 3; i += 1) await travail("classify", null, { status: "DEAD", attempts: 4, lastError: motif });
    const cle = cleDeGroupe({ kind: "classify", lastError: motif, nom: null });
    const r = await relancerTravauxMorts({ cle, limite: 2 });
    expect(r.relances).toBe(2);
    expect(r.borne).toBe(true);
    const r2 = await relancerTravauxMorts({ cle, limite: 2 });
    expect(r2.relances).toBe(1);
    expect(r2.borne).toBe(false);
  });

  it("l'ACTION est au Super Admin : un administrateur délégué sans vue globale est refusé, et rien ne bouge", async () => {
    const motif = `Action ${MOT} gardée`;
    const j = await travail("classify", null, { status: "DEAD", attempts: 4, lastError: motif });
    const fd = new FormData();
    fd.set("cle", cleDeGroupe({ kind: "classify", lastError: motif, nom: null }));

    ACTOR = await acteur("finances", "FINANCE_BUDGET_MANAGER");
    expect(hasGlobalView(ACTOR.role)).toBe(false); // PRÉMISSE : le refus ne peut venir que de la règle
    const refus = await relancerBoiteMorte(fd);
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Super Admin/);
    expect((await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe("DEAD");

    ACTOR = await acteur("sa", "SUPER_ADMIN");
    const ok = await relancerBoiteMorte(fd);
    expect(ok.ok).toBe(true);
    expect(ok.relances).toBe(1);
    expect((await prisma.knowledgeJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe("QUEUED");
    const encore = await relancerBoiteMorte(fd);
    expect(encore.ok).toBe(false); // idempotent : le second clic ne trouve plus rien, et le DIT
    ACTOR = null;
  });

  it("les éléments « en échec » de l'ancienne règle retrouvent l'étape de leurs faits — idempotent", async () => {
    const lu = await element("rep-lu", { stage: "FAILED" });
    const muet = await element("rep-muet", { stage: "FAILED", text: null });
    const scan = await element("rep-scan", { stage: "FAILED", text: null, extractedBy: "luna" });
    const n = await reparerEtapesEnEchec(50, [lu, muet, scan]);
    expect(n).toBe(3);
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: lu } })).stage).toBe("INDEXED");
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: muet } })).stage).toBe("EMPTY");
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: scan } })).stage).toBe("RECEIVED");
    expect(await reparerEtapesEnEchec(50, [lu, muet, scan])).toBe(0);
  });

  it("un fichier lu SANS texte finit « sans texte lisible » ; un scan qui attend sa vision reste « reçu »", async () => {
    const vide = await ingestFast({
      sourceType: "drive_file", sourceId: `${TAG}ing-vide`, contentHash: contentHash(`${TAG}v`),
      extractedBy: "native", deepJobs: ["classify", "entities"],
    });
    expect(vide?.stage).toBe("EMPTY");
    const scan = await ingestFast({
      sourceType: "drive_file", sourceId: `${TAG}ing-scan`, contentHash: contentHash(`${TAG}s`),
      extractedBy: "luna", deepJobs: ["classify", "entities", "vision"],
    });
    expect(scan?.stage).toBe("RECEIVED");
    // La mise en relation ne déclare plus « recherchable et relié » un fichier sans texte.
    await stageEntities(scan!.itemId);
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: scan!.itemId } })).stage).toBe("RECEIVED");
    await stageEntities(vide!.itemId);
    expect((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: vide!.itemId } })).stage).toBe("EMPTY");
  });

  it("RATTRAPAGE DES VECTEURS : ce qui était voulu et jamais fait repart — pas sans modèle, pas un travail mort", async () => {
    const voulu = await element("vec-voulu", { chunks: 3 });
    await travail("embed", voulu, { status: "DONE" }); // terminé « sans rien faire » (sans clé)
    const jamaisVoulu = await element("vec-jamais", { chunks: 2 }); // §18 : personne n'a demandé de vecteur
    const mort = await element("vec-mort", { chunks: 2 });
    await travail("embed", mort, { status: "DEAD", lastError: `Vecteur ${MOT}` }); // se relance d'un clic
    const ids = [voulu, jamaisVoulu, mort];

    expect(await rattraperVecteurs(10, { itemIds: ids })).toBe(0); // vraie disponibilité : pas de clé
    const dispo = async () => ({ ok: true, raison: null });
    expect(await rattraperVecteurs(10, { itemIds: ids, modele: dispo })).toBe(1);
    const enFile = await prisma.knowledgeJob.findMany({ where: { itemId: { in: ids }, kind: "embed", status: "QUEUED" } });
    expect(enFile.map((j) => j.itemId)).toEqual([voulu]);
    // Rejouer ne double rien : un travail est déjà en file.
    expect(await rattraperVecteurs(10, { itemIds: ids, modele: dispo })).toBe(0);
  });

  it("RATTRAPAGE DES LECTURES VISUELLES : une seule reprise par scan jamais lu", async () => {
    const scan = await element("vis-scan", { text: null, stage: "RECEIVED", extractedBy: "luna_vision" });
    await travail("vision", scan, { status: "DONE" });
    const lu = await element("vis-lu", { extractedBy: "luna" }); // déjà lu : rien à faire
    await travail("vision", lu, { status: "DONE" });
    const dispo = async () => ({ ok: true, raison: null });
    expect(await rattraperVisions(5, { itemIds: [scan, lu], modele: dispo })).toBe(1);
    await prisma.knowledgeJob.updateMany({ where: { itemId: scan, kind: "vision", status: "QUEUED" }, data: { status: "DONE" } });
    expect(await rattraperVisions(5, { itemIds: [scan, lu], modele: dispo })).toBe(0); // une seule reprise
  });

  it("L'ÉCRAN : une ligne par moyen (plus de « luna_vision » ni d'« hybride » bruts), pgvector constaté", async () => {
    await element("ecran-lv", { extractedBy: "luna_vision" });
    await element("ecran-hy", { extractedBy: "hybride" });
    const h = await knowledgeHealth();
    expect(h.byExtraction).not.toHaveProperty("luna_vision");
    expect(h.byExtraction).not.toHaveProperty("hybride");
    expect(h.byExtraction.hybrid ?? 0).toBeGreaterThanOrEqual(1);
    expect(["absente", "disponible", "installee", "inconnu"]).toContain(h.pgvector);
    const constat = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_available_extensions WHERE name = 'vector'`;
    expect(h.pgvector === "absente").toBe(Number(constat[0].n) === 0);
    expect(h.modele.ok).toBe(false);
    expect(h.modele.raison).toMatch(/clé/);
  });
});
