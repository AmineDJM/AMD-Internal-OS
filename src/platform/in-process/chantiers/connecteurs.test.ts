import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { creerAgentDeveloppeur } from "./agent-routines";
import { creerForgeGithub } from "./forge-github";
import { creerHebergeurRender } from "./hebergeur-render";
import { masquer } from "@/platform/dev/http";
import { sonderGithub, sonderMimo, sonderRender, sonderRoutines } from "./sondes";

/**
 * LES ADAPTATEURS CONTRE UN FAUX SERVEUR HTTP LOCAL (lot C2). Les réponses reprennent les exemples des documentations
 * officielles (Routines API, GitHub REST, Render API) ; le serveur note chaque requête pour vérifier chemins, en-têtes
 * et corps exacts. Aucun appel ne sort de la machine.
 */

interface Requete { methode: string; chemin: string; requete: URLSearchParams; entetes: IncomingHttpHeaders; corps: string }
interface Reponse { statut?: number; entetes?: Record<string, string>; corps?: unknown; texte?: string; jamais?: boolean }
type Gerer = (r: Requete) => Reponse;

let serveur: Server;
let base = "";
let gerer: Gerer = () => ({ statut: 404 });
const appels: Requete[] = [];

beforeAll(async () => {
  serveur = createServer((req, res) => {
    let corps = "";
    req.on("data", (c) => { corps += c; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://local");
      const r: Requete = { methode: req.method ?? "GET", chemin: url.pathname, requete: url.searchParams, entetes: req.headers, corps };
      appels.push(r);
      const rep = gerer(r);
      if (rep.jamais) return; // ne répond pas : le client doit dépasser son délai
      const texte = rep.texte ?? (rep.corps !== undefined ? JSON.stringify(rep.corps) : "");
      res.writeHead(rep.statut ?? 200, { "content-type": "application/json", ...rep.entetes });
      res.end(texte);
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});
afterAll(async () => {
  serveur.closeAllConnections();
  await new Promise<void>((ok) => serveur.close(() => ok()));
  await prisma.devLancement.deleteMany({ where: { cleIdempotence: { startsWith: "test-c2-" } } });
});
afterEach(() => { appels.length = 0; gerer = () => ({ statut: 404 }); });

const JETON_ROUTINE = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789";
const JETON_GITHUB = "github_pat_11AAAAAAA0123456789abcdefghijklmnop";
const JETON_RENDER = "rnd_abcdefghijklmnopqrstuvwxyz012345";
const uniq = () => `test-c2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const envRoutine = (alias = "TEST", extra: Record<string, string> = {}) => ({ ANTHROPIC_ROUTINES_URL: base, [`CLAUDE_ROUTINE_${alias}_ID`]: "trig_01ABCDEFGHJKLMNOPQRSTUVW", [`CLAUDE_ROUTINE_${alias}_TOKEN`]: JETON_ROUTINE, [`CLAUDE_ROUTINE_${alias}_DEPOT`]: "adventum/banc", ...extra });
const FIRE_OK = { type: "routine_fire", claude_code_session_id: "session_01HJKLMNOPQRSTUVWXYZ", claude_code_session_url: "https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ" };

describe("Routines API — lancer une session Claude Code", () => {
  it("POST /v1/claude_code/routines/{trig}/fire avec les en-têtes de la doc, puis la même clé ne relance pas", async () => {
    gerer = () => ({ corps: FIRE_OK });
    const alias = `T${Date.now() % 100000}`;
    const agent = creerAgentDeveloppeur({ env: envRoutine(alias) });
    const cle = uniq();
    const r = await agent.lancer({ alias, texte: "Corrige le test X", cleIdempotence: cle });
    expect(r).toMatchObject({ ok: true, valeur: { moyen: "ROUTINE", sessionId: "session_01HJKLMNOPQRSTUVWXYZ", deja: false } });
    expect(appels).toHaveLength(1);
    const a = appels[0]!;
    expect(a.methode).toBe("POST");
    expect(a.chemin).toBe("/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire");
    expect(a.entetes.authorization).toBe(`Bearer ${JETON_ROUTINE}`);
    expect(a.entetes["anthropic-version"]).toBe("2023-06-01");
    expect(a.entetes["content-type"]).toBe("application/json");
    expect(JSON.parse(a.corps)).toEqual({ text: "Corrige le test X" });

    const encore = await agent.lancer({ alias, texte: "Corrige le test X", cleIdempotence: cle });
    expect(encore).toMatchObject({ ok: true, valeur: { deja: true, sessionId: "session_01HJKLMNOPQRSTUVWXYZ" } });
    expect(appels).toHaveLength(1);
    expect((await prisma.devLancement.findUnique({ where: { cleIdempotence: cle } }))?.statut).toBe("LANCE");
  });

  it("deux lancements CONCURRENTS de la même clé : une seule session", async () => {
    gerer = () => ({ corps: FIRE_OK });
    const agent = creerAgentDeveloppeur({ env: envRoutine() });
    const cle = uniq();
    const [a, b] = await Promise.all([agent.lancer({ alias: "test", texte: "x", cleIdempotence: cle }), agent.lancer({ alias: "test", texte: "x", cleIdempotence: cle })]);
    expect(appels).toHaveLength(1);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const perdant = a.ok && !a.valeur.deja ? b : a;
    expect(perdant.ok ? perdant.valeur.deja : perdant.erreur.code).toSatisfy((v: unknown) => v === true || v === "INCERTAIN");
  });

  it("429 + Retry-After : QUOTA daté, la clé reste re-lançable (rien n'a été créé)", async () => {
    gerer = () => ({ statut: 429, entetes: { "retry-after": "120" }, corps: { type: "error", error: { type: "rate_limit_error", message: "Hourly fire limit reached" } } });
    const agent = creerAgentDeveloppeur({ env: envRoutine() });
    const cle = uniq();
    const r = await agent.lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(r).toMatchObject({ ok: false, erreur: { code: "QUOTA", statut: 429, reessayable: true, reessayerApresMs: 120_000 } });
    expect((await prisma.devLancement.findUnique({ where: { cleIdempotence: cle } }))?.statut).toBe("ECHEC");
    gerer = () => ({ corps: FIRE_OK });
    const ensuite = await agent.lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(ensuite).toMatchObject({ ok: true, valeur: { deja: false } });
    expect(appels).toHaveLength(2);
  });

  it("délai dépassé : INCERTAIN, JAMAIS de réessai, et la clé reste bloquée", async () => {
    gerer = () => ({ jamais: true });
    const agent = creerAgentDeveloppeur({ env: envRoutine(), delaiMs: 300 });
    const cle = uniq();
    const r = await agent.lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(r).toMatchObject({ ok: false, erreur: { code: "INCERTAIN", reessayable: false } });
    expect(appels).toHaveLength(1);
    const encore = await agent.lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(encore).toMatchObject({ ok: false, erreur: { code: "INCERTAIN" } });
    expect(appels).toHaveLength(1);
    serveur.closeAllConnections();
  });

  it("connexion refusée (requête NON partie) : RESEAU réessayable, clé re-lançable (rien de créé)", async () => {
    const libre = createServer();
    await new Promise<void>((ok) => libre.listen(0, "127.0.0.1", ok));
    const port = (libre.address() as AddressInfo).port;
    await new Promise<void>((ok) => libre.close(() => ok()));
    const agent = creerAgentDeveloppeur({ env: envRoutine("TEST", { ANTHROPIC_ROUTINES_URL: `http://127.0.0.1:${port}` }), pausesMs: [0, 0] });
    const cle = uniq();
    const r = await agent.lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(r).toMatchObject({ ok: false, erreur: { code: "RESEAU", reessayable: true } });
    expect((await prisma.devLancement.findUnique({ where: { cleIdempotence: cle } }))?.statut).toBe("ECHEC");
  });

  it("refuse sans appel : routine non configurée, consigne trop longue, quota local atteint", async () => {
    const agent = creerAgentDeveloppeur({ env: envRoutine() });
    expect(await agent.lancer({ alias: "AUTRE", texte: "x", cleIdempotence: uniq() })).toMatchObject({ ok: false, erreur: { code: "NON_CONFIGURE" } });
    expect(await agent.lancer({ alias: "TEST", texte: "x".repeat(65_537), cleIdempotence: uniq() })).toMatchObject({ ok: false, erreur: { code: "INVALIDE" } });
    const alias = `Q${Date.now() % 100000}`;
    await prisma.devLancement.createMany({ data: Array.from({ length: 30 }, () => ({ cleIdempotence: uniq(), moyen: "ROUTINE", cible: alias, statut: "LANCE", empreinte: "x" })) });
    const plein = await creerAgentDeveloppeur({ env: envRoutine(alias) }).lancer({ alias, texte: "x", cleIdempotence: uniq() });
    expect(plein).toMatchObject({ ok: false, erreur: { code: "QUOTA", reessayable: true } });
    expect(appels).toHaveLength(0);
  });

  it("aucun secret dans les messages ni les journaux, même quand le fournisseur le renvoie", async () => {
    const espion = vi.spyOn(console, "error").mockImplementation(() => {});
    const espionW = vi.spyOn(console, "warn").mockImplementation(() => {});
    gerer = () => ({ statut: 401, corps: { type: "error", error: { type: "authentication_error", message: `bad token ${JETON_ROUTINE}` } } });
    const cle = uniq();
    const r = await creerAgentDeveloppeur({ env: envRoutine() }).lancer({ alias: "TEST", texte: "x", cleIdempotence: cle });
    expect(r).toMatchObject({ ok: false, erreur: { code: "AUTH" } });
    const tout = JSON.stringify([r, espion.mock.calls, espionW.mock.calls, await prisma.devLancement.findUnique({ where: { cleIdempotence: cle } })]);
    expect(tout).not.toContain(JETON_ROUTINE);
    expect(tout).not.toContain("abcdefghijklmnop");
    espion.mockRestore();
    espionW.mockRestore();
    expect(masquer(`Authorization: Bearer ${JETON_GITHUB} et ${JETON_RENDER}`)).not.toMatch(/github_pat_|rnd_[a-z]/);
  });
});

describe("GitHub REST v3", () => {
  const forge = () => creerForgeGithub({ jeton: JETON_GITHUB, base });

  it("en-têtes de la doc, ETag : la seconde lecture envoie If-None-Match et un 304 rend la réponse gardée", async () => {
    gerer = (r) => (r.entetes["if-none-match"] === '"e1"' ? { statut: 304, entetes: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" } } : { entetes: { etag: '"e1"', "x-ratelimit-remaining": "4998", "x-ratelimit-limit": "5000" }, corps: { login: "direction", type: "User", name: "La Direction" } });
    const f = forge();
    expect(await f.moi()).toEqual({ ok: true, valeur: { login: "direction", type: "User", nom: "La Direction" } });
    expect(await f.moi()).toEqual({ ok: true, valeur: { login: "direction", type: "User", nom: "La Direction" } });
    expect(appels[0]!.entetes).toMatchObject({ authorization: `Bearer ${JETON_GITHUB}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
    expect(appels[0]!.entetes["user-agent"]).toBeTruthy();
    expect(appels[1]!.entetes["if-none-match"]).toBe('"e1"');
    expect(f.quota()).toMatchObject({ restant: 4999, limite: 5000 });
  });

  it("checks paginés par Link + statuts : un échec rend ROUGE, le check relancé compte seul", async () => {
    gerer = (r) => {
      if (r.chemin.endsWith("/status")) return { corps: { state: "success", statuses: [{ context: "render", state: "success", target_url: "https://dashboard.render.com" }] } };
      if (r.requete.get("page") === "2") return { corps: { total_count: 3, check_runs: [{ id: 30, name: "build", status: "completed", conclusion: "failure", html_url: "https://github.com/x", app: { slug: "github-actions" } }] } };
      return { entetes: { link: `<${base}${r.chemin}?per_page=100&page=2>; rel="next", <${base}${r.chemin}?page=2>; rel="last"` }, corps: { total_count: 3, check_runs: [{ id: 10, name: "test", status: "completed", conclusion: "failure", app: { slug: "github-actions" } }, { id: 11, name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] } };
    };
    const r = await forge().checks("adventum/banc", "abc123");
    expect(r.ok && r.valeur.global).toBe("ROUGE");
    expect(r.ok && r.valeur.echecs.map((e) => [e.nom, e.jobId])).toEqual([["build", 30]]);
    expect(appels.map((a) => a.chemin)).toContain("/repos/adventum/banc/commits/abc123/check-runs");
  });

  it("quotas : 403 primaire (x-ratelimit-remaining 0) et 403 secondaire (retry-after) deviennent QUOTA daté", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    gerer = () => ({ statut: 403, entetes: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, corps: { message: "API rate limit exceeded" } });
    const p = await forge().pr("adventum/banc", 1);
    expect(p).toMatchObject({ ok: false, erreur: { code: "QUOTA", reessayable: true } });
    expect(!p.ok && p.erreur.reessayerApresMs).toBeGreaterThan(500_000);
    gerer = () => ({ statut: 403, entetes: { "retry-after": "60" }, corps: { message: "You have exceeded a secondary rate limit." } });
    expect(await forge().pr("adventum/banc", 1)).toMatchObject({ ok: false, erreur: { code: "QUOTA", reessayerApresMs: 60_000 } });
    gerer = () => ({ statut: 403, corps: { message: "Resource not accessible by personal access token" } });
    expect(await forge().pr("adventum/banc", 1)).toMatchObject({ ok: false, erreur: { code: "INTERDIT", reessayable: false } });
  });

  it("tête de branche (barres obliques), branche absente = null, PR de la branche, commentaire @claude idempotent", async () => {
    gerer = (r) => {
      if (r.chemin === "/repos/adventum/banc/git/ref/heads/claude/c2-test") return { corps: { ref: "refs/heads/claude/c2-test", object: { sha: "deadbeef", type: "commit" } } };
      if (r.chemin.startsWith("/repos/adventum/banc/git/ref/heads/")) return { statut: 404, corps: { message: "Not Found" } };
      if (r.chemin === "/repos/adventum/banc/pulls") return { corps: [{ number: 7, title: "C2", state: "open", draft: false, mergeable: null, head: { ref: "claude/c2-test", sha: "deadbeef" }, base: { ref: "main" }, html_url: "https://github.com/adventum/banc/pull/7", user: { login: "direction" } }] };
      if (r.chemin === "/repos/adventum/banc/issues/7/comments" && r.methode === "POST") return { statut: 201, corps: { id: 991, html_url: "https://github.com/adventum/banc/pull/7#issuecomment-991" } };
      return { statut: 404 };
    };
    const f = forge();
    expect(await f.teteDeBranche("adventum/banc", "claude/c2-test")).toEqual({ ok: true, valeur: "deadbeef" });
    expect(await f.teteDeBranche("adventum/banc", "absente")).toEqual({ ok: true, valeur: null });
    const pr = await f.prDeBranche("adventum/banc", "claude/c2-test");
    expect(pr).toMatchObject({ ok: true, valeur: { numero: 7, fusionnable: null, shaTete: "deadbeef" } });
    expect(appels.find((a) => a.chemin.endsWith("/pulls"))!.requete.get("head")).toBe("adventum:claude/c2-test");

    const agent = creerAgentDeveloppeur({ env: {}, forge: f });
    const cle = uniq();
    const c = await agent.relancerDansPr({ depot: "adventum/banc", numeroPr: 7, texte: "le test X échoue : corrige-le", cleIdempotence: cle });
    expect(c).toMatchObject({ ok: true, valeur: { moyen: "COMMENTAIRE_PR", commentaireId: 991, deja: false } });
    expect(JSON.parse(appels.find((a) => a.methode === "POST")!.corps)).toEqual({ body: "@claude le test X échoue : corrige-le" });
    expect(await agent.relancerDansPr({ depot: "adventum/banc", numeroPr: 7, texte: "le test X échoue : corrige-le", cleIdempotence: cle })).toMatchObject({ ok: true, valeur: { deja: true, commentaireId: 991 } });
    expect(appels.filter((a) => a.methode === "POST")).toHaveLength(1);
  });
});

describe("Render API v1", () => {
  const render = () => creerHebergeurRender({ jeton: JETON_RENDER, base });
  const DEPLOY = { id: "dep-d0123", commit: { id: "abc1234def", message: "feat: x\n\ncorps", createdAt: "2026-11-01T10:00:00Z" }, status: "live", trigger: "api", createdAt: "2026-11-01T10:00:00Z", finishedAt: "2026-11-01T10:05:00Z" };

  it("services paginés par cursor ; NOMS des variables seulement — la valeur ne sort jamais", async () => {
    gerer = (r) => {
      if (r.chemin === "/services") {
        const page2 = r.requete.get("cursor") === "c2";
        return { corps: page2 ? [] : [{ cursor: "c1", service: { id: "srv-a", name: "erp", type: "web_service", repo: "https://github.com/adventum/banc", branch: "main", autoDeployTrigger: "commit", suspended: "not_suspended", ownerId: "tea-1", serviceDetails: { url: "https://erp.onrender.com", healthCheckPath: "/api/health" } } }] };
      }
      if (r.chemin === "/services/srv-a/env-vars") return { corps: [{ envVar: { key: "DATABASE_URL", value: "postgres://secret-valeur" }, cursor: "e1" }, { envVar: { key: "mimo", value: "cle-tres-secrete" }, cursor: "e2" }] };
      return { statut: 404 };
    };
    const h = render();
    const s = await h.services();
    expect(s).toMatchObject({ ok: true, valeur: [{ id: "srv-a", autoDeploy: "commit", cheminSante: "/api/health", proprietaireId: "tea-1", suspendu: false }] });
    expect(appels[0]!.entetes.authorization).toBe(`Bearer ${JETON_RENDER}`);
    expect(appels[0]!.requete.get("limit")).toBe("100");
    const v = await h.nomsDesVariables("srv-a");
    expect(v).toEqual({ ok: true, valeur: ["DATABASE_URL", "mimo"] });
    expect(JSON.stringify(v)).not.toMatch(/secret/);
  });

  it("déployer (201 et 202), annuler, rollback {deployId}, auto-déploiement coupé, journaux", async () => {
    gerer = (r) => {
      if (r.chemin === "/services/srv-a/deploys" && r.methode === "POST") return JSON.parse(r.corps).commitId ? { statut: 201, corps: { ...DEPLOY, status: "created" } } : { statut: 202, texte: "" };
      if (r.chemin === "/services/srv-a/deploys/dep-d0123/cancel") return { corps: { ...DEPLOY, status: "canceled" } };
      if (r.chemin === "/services/srv-a/rollback") return { statut: 201, corps: { ...DEPLOY, id: "dep-rb", trigger: "rollback", status: "created" } };
      if (r.chemin === "/services/srv-a" && r.methode === "PATCH") return { corps: { id: "srv-a", name: "erp", type: "web_service", autoDeployTrigger: JSON.parse(r.corps).autoDeployTrigger } };
      if (r.chemin === "/logs") return { corps: { hasMore: true, nextStartTime: "2026-11-01T09:00:00Z", nextEndTime: "2026-11-01T09:30:00Z", logs: [{ id: "l1", message: "Error: boom", timestamp: "2026-11-01T09:31:00Z", labels: [{ name: "level", value: "error" }, { name: "type", value: "app" }] }] } };
      return { statut: 404 };
    };
    const h = render();
    expect(await h.deployer("srv-a", { commitId: "abc1234def" })).toMatchObject({ ok: true, valeur: { id: "dep-d0123", statut: "created", sha: "abc1234def", messageCommit: "feat: x" } });
    expect(JSON.parse(appels[0]!.corps)).toEqual({ commitId: "abc1234def" });
    expect(await h.deployer("srv-a")).toEqual({ ok: true, valeur: null });
    expect(await h.annuler("srv-a", "dep-d0123")).toMatchObject({ ok: true, valeur: { statut: "canceled" } });
    expect(await h.rollback("srv-a", "dep-d0123")).toMatchObject({ ok: true, valeur: { id: "dep-rb", declencheur: "rollback" } });
    expect(JSON.parse(appels.find((a) => a.chemin.endsWith("/rollback"))!.corps)).toEqual({ deployId: "dep-d0123" });
    expect(await h.reglerAutoDeploy("srv-a", "off")).toMatchObject({ ok: true, valeur: { autoDeploy: "off" } });
    const j = await h.journaux({ proprietaireId: "tea-1", serviceId: "srv-a", niveaux: ["error"], limite: 50 });
    expect(j).toMatchObject({ ok: true, valeur: { encore: true, lignes: [{ message: "Error: boom", niveau: "error", type: "app" }] } });
    const q = appels.find((a) => a.chemin === "/logs")!.requete;
    expect([q.get("ownerId"), q.getAll("resource"), q.getAll("level"), q.get("limit")]).toEqual(["tea-1", ["srv-a"], ["error"], "50"]);
  });

  it("429 + Retry-After, 409 (déploiement en cours), jeton absent", async () => {
    gerer = () => ({ statut: 429, entetes: { "retry-after": "30", "ratelimit-remaining": "0" }, corps: { id: "rate", message: "rate limit exceeded" } });
    expect(await render().deploiements("srv-a")).toMatchObject({ ok: false, erreur: { code: "QUOTA", reessayerApresMs: 30_000 } });
    gerer = () => ({ statut: 409, corps: { message: "deploy already in progress" } });
    expect(await render().deployer("srv-a")).toMatchObject({ ok: false, erreur: { code: "CONFLIT", reessayable: false } });
    expect(await creerHebergeurRender({ jeton: null, base }).services()).toMatchObject({ ok: false, erreur: { code: "NON_CONFIGURE" } });
  });
});

describe("Sondes de l'écran Administration › Développement (lecture seule)", () => {
  it("GitHub, Render, MiMo sondés en GET ; routines : configurées sans appel", async () => {
    gerer = (r) => {
      if (r.chemin === "/user") return { entetes: { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000" }, corps: { login: "direction", type: "User" } };
      if (r.chemin === "/repos/adventum/banc") return { corps: { full_name: "adventum/banc", default_branch: "main", private: true, permissions: { push: true } } };
      if (r.chemin === "/services") return { corps: [] };
      if (r.chemin === "/v1/models") return { corps: { object: "list", data: [{ id: "mimo-v2.6-pro", object: "model" }] } };
      return { statut: 404 };
    };
    const env = { GITHUB_TOKEN: JETON_GITHUB, GITHUB_API_URL: base, CHANTIERS_DEPOTS: "adventum/banc", RENDER_API_KEY: JETON_RENDER, RENDER_API_URL: base, mimo: "cle-mimo-0123456789", MIMO_BASE_URL: `${base}/v1`, ...envRoutine() };
    const [g, rd, m, ro] = await Promise.all([sonderGithub({ env }), sonderRender({ env }), sonderMimo({ env }), sonderRoutines({ env })]);
    expect(g).toMatchObject({ configure: true, joignable: true });
    expect(g.details.join(" ")).toContain("adventum/banc : accès en écriture");
    expect(g.quotas[0]).toMatchObject({ restant: 4990, limite: 5000 });
    expect(rd).toMatchObject({ configure: true, joignable: true });
    expect(m.details.join(" ")).toContain("mimo-v2.6-pro");
    expect(ro).toMatchObject({ configure: true, joignable: null });
    expect(appels.every((a) => a.methode === "GET")).toBe(true);
    expect(appels.some((a) => a.chemin.includes("/fire"))).toBe(false);
    expect(JSON.stringify([g, rd, m, ro])).not.toMatch(/github_pat_|rnd_|sk-ant-|cle-mimo/);
  });
});
