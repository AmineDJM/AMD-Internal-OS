import { createHmac, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/chantiers/webhooks/[fournisseur]/route";
import { construireConsigne } from "./consigne";
import type { ForgeGit, Hebergeur, Resultat } from "./ports";
import { inscrireFaits, recevoirWebhook, type Inscrire } from "./reception";
import { delaiSondage, sonderBranche, sonderChecks, sonderDeploiement, sonderEtInscrire } from "./sondage";
import { faitsGithub, signerStandard, verifierSignatureGithub, verifierSignatureRender } from "./webhooks";

/**
 * LES WEBHOOKS DES CHANTIERS (lot C2) : signatures GitHub et Render (Standard Webhooks), réception exactement-une-fois
 * (relivraison, réessai, et même fait vu par le sondage), la route publique, le pas du sondage, la consigne bornée.
 */

const SECRET_GH = "secret-github-de-test";
const SECRET_RENDER = `whsec_${randomBytes(24).toString("base64")}`;
const env = { GITHUB_WEBHOOK_SECRET: SECRET_GH, RENDER_WEBHOOK_SECRET: SECRET_RENDER };
const signerGh = (corps: string, secret = SECRET_GH) => `sha256=${createHmac("sha256", secret).update(corps).digest("hex")}`;
const sha = () => randomBytes(20).toString("hex");
const inscrits: { type: string; relatedRefs: string[] }[] = [];
const inscrire: Inscrire = async (e) => { inscrits.push({ type: e.type, relatedRefs: e.relatedRefs }); return `evt-${inscrits.length}`; };
const cles: string[] = [];

afterAll(async () => {
  await prisma.ingestedEvent.deleteMany({ where: { source: { in: ["dev-github", "dev-render"] }, externalId: { in: cles } } });
  await prisma.businessEvent.deleteMany({ where: { sourceDomain: "DEV", relatedRefs: { has: "DEPOT:adventum/banc-webhook-test" } } });
});

const corpsPush = (s: string) => JSON.stringify({ ref: "refs/heads/claude/c2", after: s, deleted: false, compare: "https://github.com/x", repository: { full_name: "adventum/banc-webhook-test" }, sender: { login: "claude" }, head_commit: { timestamp: "2026-11-01T10:00:00Z" } });
const entetesGh = (evenement: string, corps: string, livraison = crypto.randomUUID()) => new Headers({ "x-github-event": evenement, "x-github-delivery": livraison, "x-hub-signature-256": signerGh(corps) });

describe("signatures", () => {
  it("GitHub : X-Hub-Signature-256 du corps BRUT, en temps constant", () => {
    const corps = '{"a":1}';
    expect(verifierSignatureGithub(corps, signerGh(corps), SECRET_GH)).toBe(true);
    expect(verifierSignatureGithub(corps, signerGh(corps, "autre"), SECRET_GH)).toBe(false);
    expect(verifierSignatureGithub(`${corps} `, signerGh(corps), SECRET_GH)).toBe(false);
    expect(verifierSignatureGithub(corps, null, SECRET_GH)).toBe(false);
    expect(verifierSignatureGithub(corps, signerGh(corps), null)).toBe(false);
  });

  it("Render : Standard Webhooks (whsec_ base64 ou secret brut), plusieurs signatures, horodatage à ± 5 min", () => {
    const corps = '{"type":"deploy_ended"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signerStandard(corps, "evt-1", ts, SECRET_RENDER);
    expect(verifierSignatureRender(corps, { id: "evt-1", horodatage: ts, signature: `v1,AAAA ${sig}` }, SECRET_RENDER)).toBe(true);
    expect(verifierSignatureRender(corps, { id: "evt-2", horodatage: ts, signature: sig }, SECRET_RENDER)).toBe(false);
    const vieux = String(Number(ts) - 600);
    expect(verifierSignatureRender(corps, { id: "evt-1", horodatage: vieux, signature: signerStandard(corps, "evt-1", vieux, SECRET_RENDER) }, SECRET_RENDER)).toBe(false);
    const brut = "secret-brut-sans-prefixe";
    expect(verifierSignatureRender(corps, { id: "evt-1", horodatage: ts, signature: signerStandard(corps, "evt-1", ts, brut) }, brut)).toBe(true);
  });
});

describe("normalisation GitHub", () => {
  it("push, PR fusionnée, check_suite terminé, commentaire de PR ; ping et branche supprimée ignorés", () => {
    const repo = { full_name: "a/b" };
    expect(faitsGithub("push", JSON.parse(corpsPush("s1")))[0]).toMatchObject({ type: "DEV_PUSH", branche: "claude/c2", sha: "s1", cle: "push:adventum/banc-webhook-test:claude/c2:s1" });
    expect(faitsGithub("push", { ref: "refs/heads/x", after: "0", deleted: true, repository: repo })).toEqual([]);
    expect(faitsGithub("pull_request", { action: "closed", pull_request: { number: 3, merged: true, head: { ref: "claude/x", sha: "s2" } }, repository: repo })[0]).toMatchObject({ type: "DEV_PR", statut: "merged", numeroPr: 3 });
    expect(faitsGithub("check_suite", { action: "completed", check_suite: { id: 5, head_sha: "s3", head_branch: "claude/x", conclusion: "failure", pull_requests: [{ number: 3 }] }, repository: repo })[0]).toMatchObject({ type: "DEV_CHECKS", statut: "failure", sha: "s3", numeroPr: 3 });
    expect(faitsGithub("check_run", { action: "created", check_run: { id: 6, head_sha: "s3" }, repository: repo })).toEqual([]);
    expect(faitsGithub("issue_comment", { action: "created", issue: { number: 3, pull_request: {} }, comment: { id: 77, user: { login: "claude[bot]", type: "Bot" } }, repository: repo })[0]).toMatchObject({ type: "DEV_COMMENTAIRE", statut: "bot", numeroPr: 3 });
    expect(faitsGithub("issue_comment", { action: "created", issue: { number: 4 }, comment: { id: 78 }, repository: repo })).toEqual([]);
    expect(faitsGithub("ping", { zen: "x", repository: repo })).toEqual([]);
  });
});

describe("réception exactement une fois", () => {
  it("GitHub : une relivraison et le sondage du même commit n'inscrivent qu'un BusinessEvent", async () => {
    inscrits.length = 0;
    const s = sha();
    cles.push(`push:adventum/banc-webhook-test:claude/c2:${s}`);
    const corps = corpsPush(s);
    const livraison = crypto.randomUUID();
    const a = await recevoirWebhook("github", corps, entetesGh("push", corps, livraison), { inscrire, env });
    const b = await recevoirWebhook("github", corps, entetesGh("push", corps, livraison), { inscrire, env });
    expect(a).toMatchObject({ statut: 200, bilan: { nouveaux: 1, doublons: 0 } });
    expect(b).toMatchObject({ statut: 200, bilan: { nouveaux: 0, doublons: 1 } });
    const forge = { teteDeBranche: async () => ({ ok: true, valeur: s }) } as unknown as ForgeGit;
    const sonde = await sonderEtInscrire(sonderBranche(forge, "adventum/banc-webhook-test", "claude/c2", null), inscrire);
    expect(sonde).toMatchObject({ ok: true, valeur: { nouveaux: 0, doublons: 1 } });
    expect(inscrits).toHaveLength(1);
    expect(inscrits[0]!.relatedRefs).toEqual(["DEPOT:adventum/banc-webhook-test", "BRANCHE:adventum/banc-webhook-test:claude/c2", `SHA:${s}`]);
  });

  it("refus : sans secret 503, signature fausse 401, corps illisible 400, fournisseur inconnu 404 — rien d'inscrit", async () => {
    inscrits.length = 0;
    const corps = corpsPush(sha());
    expect((await recevoirWebhook("github", corps, entetesGh("push", corps), { inscrire, env: {} })).statut).toBe(503);
    const faux = new Headers({ "x-github-event": "push", "x-hub-signature-256": signerGh(corps, "mauvais") });
    expect((await recevoirWebhook("github", corps, faux, { inscrire, env })).statut).toBe(401);
    expect((await recevoirWebhook("github", "pas du json", entetesGh("push", "pas du json"), { inscrire, env })).statut).toBe(400);
    expect((await recevoirWebhook("gitlab", corps, entetesGh("push", corps), { inscrire, env })).statut).toBe(404);
    expect(inscrits).toHaveLength(0);
  });

  it("Render : deploy_ended enrichi par GET /events/{id} → même clé que le sondage du déploiement", async () => {
    inscrits.length = 0;
    const evt = `evt-${sha().slice(0, 12)}`;
    const dep = `dep-${sha().slice(0, 12)}`;
    cles.push(`render:deploy:${dep}:succeeded`);
    const corps = JSON.stringify({ type: "deploy_ended", timestamp: "2026-11-01T10:05:00Z", data: { id: evt, serviceId: "srv-a", serviceName: "erp", status: "succeeded" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const h = new Headers({ "webhook-id": evt, "webhook-timestamp": ts, "webhook-signature": signerStandard(corps, evt, ts, SECRET_RENDER) });
    const hebergeur = {
      evenement: async () => ({ ok: true, valeur: { type: "deploy_ended", serviceId: "srv-a", deployId: dep } }),
      deploiement: async () => ({ ok: true, valeur: { id: dep, statut: "live", sha: "abc", messageCommit: null, declencheur: "api", creeLe: null, termineLe: "2026-11-01T10:05:00Z" } }),
    } as unknown as Hebergeur;
    expect(await recevoirWebhook("render", corps, h, { inscrire, env, hebergeur })).toMatchObject({ statut: 200, bilan: { nouveaux: 1 } });
    expect(await sonderEtInscrire(sonderDeploiement(hebergeur, "srv-a", dep), inscrire)).toMatchObject({ ok: true, valeur: { doublons: 1 } });
    expect(inscrits).toEqual([{ type: "RENDER_DEPLOIEMENT", relatedRefs: ["SERVICE:srv-a", `DEPLOIEMENT:${dep}`] }]);
  });

  it("la route publique : signature vérifiée, BusinessEvent DEV_PUSH inscrit au registre", async () => {
    const s = sha();
    cles.push(`push:adventum/banc-webhook-test:claude/c2:${s}`);
    const corps = corpsPush(s);
    const avant = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = SECRET_GH;
    try {
      const rep = await POST(new Request("http://local/api/chantiers/webhooks/github", { method: "POST", body: corps, headers: entetesGh("push", corps) }), { params: Promise.resolve({ fournisseur: "github" }) });
      expect(rep.status).toBe(200);
      expect(await rep.json()).toMatchObject({ ok: true, nouveaux: 1 });
      const faux = await POST(new Request("http://local/api/chantiers/webhooks/github", { method: "POST", body: corps, headers: { "x-hub-signature-256": "sha256=00" } }), { params: Promise.resolve({ fournisseur: "github" }) });
      expect(faux.status).toBe(401);
    } finally {
      if (avant === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = avant;
    }
    const evt = await prisma.businessEvent.findFirst({ where: { type: "DEV_PUSH", relatedRefs: { has: `SHA:${s}` } } });
    expect(evt).toMatchObject({ sourceDomain: "DEV" });
  });

  it("un fait déjà réclamé dont l'inscription a échoué n'est pas réinscrit (pas de double réveil)", async () => {
    const s = sha();
    const f = faitsGithub("push", JSON.parse(corpsPush(s)));
    cles.push(f[0]!.cle);
    expect(await inscrireFaits(f, async () => null, "webhook")).toMatchObject({ nouveaux: 1, evenements: [] });
    expect(await inscrireFaits(f, inscrire, "sondage")).toMatchObject({ doublons: 1 });
  });
});

describe("sondage de secours", () => {
  it("pas croissant 30 s → 15 min, jamais sous le délai de quota", () => {
    expect([0, 1, 2, 3, 10].map((t) => delaiSondage(t))).toEqual([30_000, 60_000, 120_000, 240_000, 900_000]);
    expect(delaiSondage(0, undefined, 300_000)).toBe(300_000);
  });

  it("checks : rien tant qu'ils tournent, un fait au verdict ; une erreur de quota remonte telle quelle", async () => {
    let global = "EN_COURS";
    const forge = { checks: async () => ({ ok: true, valeur: { sha: "s", global, runs: [], echecs: [] } }) } as unknown as ForgeGit;
    expect(await sonderChecks(forge, "a/b", "s")).toEqual({ ok: true, valeur: [] });
    global = "ROUGE";
    expect(await sonderChecks(forge, "a/b", "s")).toMatchObject({ ok: true, valeur: [{ type: "DEV_CHECKS", statut: "failure", cle: "checks:a/b:s:failure" }] });
    const quota: Resultat<never> = { ok: false, erreur: { code: "QUOTA", message: "q", reessayable: true, reessayerApresMs: 1000 } };
    const bloque = { teteDeBranche: async () => quota } as unknown as ForgeGit;
    expect(await sonderBranche(bloque, "a/b", "x", null)).toEqual(quota);
    expect(await sonderBranche({ teteDeBranche: async () => ({ ok: true, valeur: "s0" }) } as unknown as ForgeGit, "a/b", "x", "s0")).toEqual({ ok: true, valeur: [] });
  });
});

describe("consigne envoyée à Claude Code", () => {
  it("nomme branche, périmètre, critères, commandes ; bornée à 65 536 caractères en rognant le contexte", () => {
    const c = { depot: "adventum/banc" as const, branche: "claude/c2-x", objectif: "Ajouter X", perimetre: ["src/x/**"], criteres: ["X marche"], commandes: ["npm test"], contexte: "y".repeat(100_000) };
    const t = construireConsigne(c);
    expect(t.length).toBeLessThanOrEqual(65_536);
    for (const morceau of ["`claude/c2-x`", "- src/x/**", "- X marche", "- npm test", "## Contexte"]) expect(t).toContain(morceau);
    expect(construireConsigne({ ...c, contexte: null, numeroPr: 7 })).toContain("#7");
  });
});
