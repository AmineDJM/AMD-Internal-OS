import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LE SCRIPT DU RELAIS (`scripts/relais-claude.ts`, service Render `claude-relais`) contre un FAUX ERP local, un FAUX
 * `claude` (il note ses arguments, son entrée et son environnement) et un VRAI `git` sur un dépôt nu local. Rien ne sort
 * de la machine. Plus la forme du service dans `render.yaml` et de son image (`Dockerfile.relais`).
 */

const JETON = "relais-script-test-0123456789abcdefghij";
let dossier = "";
let erp: Server;
let base = "";
const ordres: unknown[] = [];
const rendus: Record<string, unknown>[] = [];
const tirages: URLSearchParams[] = [];
let relais: ChildProcess | null = null;

const FAUX_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const noter = (o) => fs.appendFileSync(process.env.FAUX_JOURNAL, JSON.stringify(o) + "\\n");
if (a[0] === "-v") { console.log("2.1.316 (Claude Code)"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
let entree = ""; process.stdin.on("data", (d) => { entree += d; });
process.stdin.on("end", () => {
  noter({ args: a, entree, cwd: process.cwd(), jetonRelais: process.env.CLAUDE_RELAIS_TOKEN ?? null, jetonGithub: process.env.GITHUB_TOKEN ?? null, config: process.env.CLAUDE_CONFIG_DIR ?? null });
  if (a[0] === "-p") { console.log(JSON.stringify({ ok: true, session_id: a[2], url: "https://claude.ai/code/" + a[2] })); return; }
  console.log("Sent to cloud session.\\nSession ID: session_01FAKECREATE000\\nView: https://claude.ai/code/session_01FAKECREATE000?from=cli");
});
`;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "relais-"));
  writeFileSync(join(dossier, "claude"), FAUX_CLAUDE);
  chmodSync(join(dossier, "claude"), 0o755);
  // Un dépôt nu « adventum/banc » avec une branche par défaut `main` et un commit.
  const nu = join(dossier, "hote", "adventum", "banc.git");
  const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git(["init", "--bare", "-b", "main", nu]);
  const travail = join(dossier, "graine");
  git(["clone", nu, travail]);
  writeFileSync(join(travail, "README.md"), "banc\n");
  git(["add", "."], travail);
  git(["commit", "-m", "graine"], travail);
  git(["push", "origin", "main"], travail);

  erp = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${JETON}`) { res.writeHead(401).end(); return; }
    if (req.method === "GET") {
      tirages.push(new URL(req.url ?? "/", "http://x").searchParams);
      const ordre = ordres.shift() ?? null;
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ordre })), ordre ? 0 : 200);
      return;
    }
    let corps = "";
    req.on("data", (d) => { corps += d; });
    req.on("end", () => { rendus.push(JSON.parse(corps)); res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); });
  });
  await new Promise<void>((ok) => erp.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(erp.address() as AddressInfo).port}`;
});

afterAll(async () => {
  relais?.kill("SIGTERM");
  erp.closeAllConnections();
  await new Promise<void>((ok) => erp.close(() => ok()));
  rmSync(dossier, { recursive: true, force: true });
});

const attendre = async (cond: () => boolean, ms = 20_000) => {
  const fin = Date.now() + ms;
  while (!cond()) { if (Date.now() > fin) throw new Error("délai dépassé"); await new Promise((r) => setTimeout(r, 100)); }
};

describe("le script du relais", () => {
  it("MESSAGE puis CREER : bonnes commandes, texte sur stdin, branche poussée, aucun jeton transmis à claude", async () => {
    ordres.push(
      { id: "o-msg", type: "MESSAGE", depot: null, branche: null, sessionId: "session_01EXISTANTE00", texte: "corrige le test X" },
      { id: "o-creer", type: "CREER", depot: "adventum/banc", branche: "claude/banc-relais", sessionId: null, texte: "ajoute banc.md" },
    );
    relais = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/relais-claude.ts"], {
      env: {
        PATH: process.env.PATH, HOME: dossier, ERP_URL: base, CLAUDE_RELAIS_TOKEN: JETON, GITHUB_TOKEN: "ghp_faux0123456789abcdef",
        RELAIS_CLAUDE: join(dossier, "claude"), RELAIS_DOSSIER: join(dossier, "depots"), RELAIS_GIT_BASE: `file://${join(dossier, "hote")}`,
        CLAUDE_CONFIG_DIR: join(dossier, "config-claude"), FAUX_JOURNAL: join(dossier, "journal.jsonl"),
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "pipe",
    });
    let sortie = "";
    relais.stdout?.on("data", (d) => { sortie += d; });
    relais.stderr?.on("data", (d) => { sortie += d; });
    await attendre(() => rendus.length >= 2);

    expect(rendus[0]).toMatchObject({ id: "o-msg", code: 0, delaiDepasse: false });
    expect(String(rendus[0]!.stdout)).toContain('"session_id":"session_01EXISTANTE00"');
    expect(rendus[1]).toMatchObject({ id: "o-creer", code: 0 });
    expect(String(rendus[1]!.stdout)).toContain("session_01FAKECREATE000");

    const appels = readFileSync(join(dossier, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; entree: string; cwd: string; jetonRelais: string | null; jetonGithub: string | null; config: string | null });
    expect(appels[0]!.args).toEqual(["-p", "--cloud", "session_01EXISTANTE00", "--output-format", "json"]);
    expect(appels[0]!.entree).toBe("corrige le test X");
    expect(appels[1]!.args).toEqual(["--cloud", "ajoute banc.md"]);
    expect(appels[1]!.cwd).toBe(join(dossier, "depots", "adventum__banc"));
    for (const a of appels) expect([a.jetonRelais, a.jetonGithub, a.config]).toEqual([null, null, join(dossier, "config-claude")]);
    // La branche réservée a été créée depuis `main` et POUSSÉE avant `claude --cloud`.
    expect(execFileSync("git", ["branch", "--list", "claude/banc-relais"], { cwd: join(dossier, "hote", "adventum", "banc.git") }).toString()).toContain("claude/banc-relais");
    // Le battement porte la version et l'état de connexion ; aucun jeton dans les journaux du relais.
    expect(tirages[0]!.get("version")).toBe("2.1.316 (Claude Code)");
    expect(tirages[0]!.get("authCode")).toBe("0");
    expect(sortie).not.toMatch(/ghp_faux|relais-script-test/);
  }, 30_000);
});

describe("le service Render et son image", () => {
  it("worker Docker à part, disque /var/data, aucun accès à la base, secrets en sync: false", () => {
    const yaml = readFileSync("render.yaml", "utf8");
    const bloc = yaml.slice(yaml.indexOf("name: claude-relais"));
    expect(yaml).toMatch(/- type: worker\s+name: claude-relais\s+runtime: docker\s+plan: starter/);
    expect(bloc).toMatch(/dockerfilePath: \.\/Dockerfile\.relais/);
    expect(bloc).toMatch(/disk:\s+name: claude-relais-data\s+mountPath: \/var\/data/);
    expect(bloc).toMatch(/key: CLAUDE_RELAIS_TOKEN\s+sync: false/);
    expect(bloc).toMatch(/key: GITHUB_TOKEN\s+sync: false/);
    expect(bloc).toMatch(/key: CLAUDE_CONFIG_DIR\s+value: \/var\/data\/claude/);
    expect(bloc).not.toMatch(/DATABASE_URL|fromDatabase/);
    const image = readFileSync("Dockerfile.relais", "utf8");
    expect(image).toMatch(/^FROM node:22/m);
    expect(image).toMatch(/@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
    expect(image).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(image).toMatch(/^CMD \["node", "--experimental-strip-types", "--no-warnings", "\/app\/relais-claude\.ts"\]$/m);
    expect(readFileSync("Dockerfile.relais.dockerignore", "utf8")).toMatch(/^\*\n!scripts\/relais-claude\.ts$/m);
  });
});
