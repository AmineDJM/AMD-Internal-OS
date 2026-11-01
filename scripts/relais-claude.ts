/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RELAIS CLAUDE CODE (lot C2, décision 0043 § 3 bis) — un SERVICE RENDER à part (`claude-relais`, background worker,
 * `Dockerfile.relais`, disque persistant `/var/data`), décision de la Direction du 01/11 : « le relais : dans le cloud ».
 *
 * Il TIRE les ordres de l'ERP (HTTPS, son propre jeton), exécute la CLI `claude` NON MODIFIÉE à laquelle la Direction
 * s'est connectée ELLE-MÊME (Render › claude-relais › Shell › `claude auth login` : flux d'Anthropic, URL à ouvrir et
 * code à coller), et rend la sortie BRUTE. L'identifiant claude.ai reste dans `CLAUDE_CONFIG_DIR/.credentials.json` sur
 * le disque de CE service ; l'ERP ne le voit jamais, et le relais n'a aucun accès à la base de l'ERP.
 *
 *   node --experimental-strip-types scripts/relais-claude.ts      (Node ≥ 22.6, aucune dépendance — c'est le CMD de l'image)
 *
 * Variables : ERP_URL (ou RELAIS_ERP_URL), CLAUDE_RELAIS_TOKEN (ou RELAIS_JETON) — le même que celui de l'ERP —,
 * GITHUB_TOKEN (cloner et POUSSER la branche réservée : passé à git par variables d'environnement, jamais en argument),
 * RELAIS_DOSSIER (copies de travail ; `/var/data/depots` sur Render), CLAUDE_CONFIG_DIR (`/var/data/claude` : la
 * connexion survit aux déploiements), RELAIS_CLAUDE (défaut « claude »), RELAIS_GIT (défaut « git »).
 *
 *   CREER    copie du dépôt (clone au premier ordre, puis `git fetch`), branche réservée créée depuis la branche par défaut
 *            si elle n'existe pas sur GitHub et POUSSÉE (le VM clone la branche du dépôt GitHub, pas la copie locale),
 *            puis `claude --cloud "<consigne>"`.
 *   MESSAGE  `claude -p --cloud <session-id> --output-format json`, consigne sur l'entrée standard.
 *
 * Jamais de shell : `spawn` avec des arguments. Un ordre à la fois. Rien n'est journalisé du texte des consignes ni d'un jeton.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ERP = (process.env.ERP_URL ?? process.env.RELAIS_ERP_URL ?? "").replace(/\/+$/, "");
const JETON = process.env.CLAUDE_RELAIS_TOKEN ?? process.env.RELAIS_JETON ?? "";
const JETON_GITHUB = process.env.GITHUB_TOKEN ?? "";
const DOSSIER = process.env.RELAIS_DOSSIER ?? join(homedir(), ".adventum-relais");
const CLAUDE = process.env.RELAIS_CLAUDE ?? "claude";
const GIT = process.env.RELAIS_GIT ?? "git";
/** L'hôte des dépôts (les bancs passent un dépôt nu local `file://…`). */
const BASE_GIT = (process.env.RELAIS_GIT_BASE ?? "https://github.com").replace(/\/+$/, "");
const DELAI_CLAUDE_MS = 10 * 60_000;
const DELAI_GIT_MS = 5 * 60_000;
const MAX_SORTIE = 8_000;

interface Ordre { id: string; type: "CREER" | "MESSAGE"; depot: string | null; branche: string | null; sessionId: string | null; texte: string }
interface Issue { code: number | null; stdout: string; stderr: string; delaiDepasse: boolean }

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Une commande SANS shell, avec délai ; l'entrée standard optionnelle porte le texte. */
/** L'environnement d'un enfant : JAMAIS le jeton du relais ; le jeton GitHub seulement pour git, en en-tête HTTP. */
function environnement(pourGit: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env.CLAUDE_RELAIS_TOKEN;
  delete env.RELAIS_JETON;
  delete env.GITHUB_TOKEN;
  if (pourGit && JETON_GITHUB) {
    // `GIT_CONFIG_*` (git ≥ 2.31) : l'en-tête n'apparaît ni dans les arguments (visibles par `ps`) ni dans `.git/config`.
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${JETON_GITHUB}`).toString("base64")}`;
  }
  return env;
}

function executer(cmd: string, args: string[], opts: { cwd?: string; entree?: string; delaiMs: number }): Promise<Issue> {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, env: environnement(cmd === GIT) });
    let stdout = "";
    let stderr = "";
    let delaiDepasse = false;
    const minuteur = setTimeout(() => { delaiDepasse = true; p.kill("SIGTERM"); }, opts.delaiMs);
    p.stdout.on("data", (d) => { stdout = (stdout + d).slice(-MAX_SORTIE); });
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-MAX_SORTIE); });
    p.on("error", (e) => { clearTimeout(minuteur); ok({ code: 127, stdout, stderr: `${stderr}\n${e.message}`, delaiDepasse }); });
    p.on("close", (code) => { clearTimeout(minuteur); ok({ code: delaiDepasse ? null : code, stdout, stderr, delaiDepasse }); });
    p.stdin.end(opts.entree ?? "");
  });
}

async function git(args: string[], cwd?: string): Promise<string> {
  const r = await executer(GIT, args, { cwd, delaiMs: DELAI_GIT_MS });
  if (r.code !== 0) throw new Error(`git ${args[0]} : ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
  return r.stdout.trim();
}

const DEPOT_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCHE_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** La copie de travail du dépôt, sur la branche réservée, poussée sur GitHub. */
async function preparer(depot: string, branche: string): Promise<string> {
  if (!DEPOT_RE.test(depot) || !BRANCHE_RE.test(branche) || branche.startsWith("-") || branche.includes("..")) throw new Error("dépôt ou branche invalide");
  const copie = join(DOSSIER, depot.replace("/", "__"));
  if (!existsSync(copie)) { mkdirSync(DOSSIER, { recursive: true }); await git(["clone", `${BASE_GIT}/${depot}.git`, copie]); }
  await git(["fetch", "--prune", "origin"], copie);
  const distantes = await git(["branch", "-r", "--list", `origin/${branche}`], copie);
  if (distantes) {
    await git(["checkout", "-B", branche, `origin/${branche}`], copie);
  } else {
    const parDefaut = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], copie)).replace(/^origin\//, "");
    await git(["checkout", "-B", branche, `origin/${parDefaut}`], copie);
    await git(["push", "-u", "origin", branche], copie);
  }
  return copie;
}

async function traiter(o: Ordre): Promise<Record<string, unknown>> {
  if (o.type === "MESSAGE") {
    if (!o.sessionId || !/^(session|cse)_[A-Za-z0-9]+$/.test(o.sessionId)) return { id: o.id, code: 2, stdout: "", stderr: "identifiant de session invalide", delaiDepasse: false };
    const r = await executer(CLAUDE, ["-p", "--cloud", o.sessionId, "--output-format", "json"], { entree: o.texte, delaiMs: DELAI_CLAUDE_MS });
    return { id: o.id, ...r };
  }
  let copie: string;
  try {
    copie = await preparer(o.depot ?? "", o.branche ?? "");
  } catch (e) {
    return { id: o.id, code: 1, stdout: "", stderr: "", delaiDepasse: false, avantClaude: e instanceof Error ? e.message : String(e) };
  }
  const r = await executer(CLAUDE, ["--cloud", o.texte], { cwd: copie, delaiMs: DELAI_CLAUDE_MS });
  return { id: o.id, ...r };
}

async function appelErp(methode: "GET" | "POST", chemin: string, corps?: unknown): Promise<Response> {
  return fetch(`${ERP}${chemin}`, {
    method: methode,
    headers: { authorization: `Bearer ${JETON}`, "content-type": "application/json" },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(40_000),
  });
}

async function main() {
  if (!/^https?:\/\//.test(ERP) || JETON.length < 24) { console.error("ERP_URL et CLAUDE_RELAIS_TOKEN (≥ 24 caractères) sont requis"); process.exit(2); }
  mkdirSync(DOSSIER, { recursive: true });
  if (process.env.CLAUDE_CONFIG_DIR) mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  let etat = { version: null as string | null, authStatus: null as string | null, authCode: null as number | null };
  let etatLu = 0;
  log(`relais démarré → ${ERP}`);
  for (let pause = 1_000; ; ) {
    try {
      // L'état de connexion se relit toutes les 10 min — toutes les minutes tant que `claude auth status` dit « non ».
      if (Date.now() - etatLu > (etat.authCode === 0 ? 10 * 60_000 : 60_000)) {
        const v = await executer(CLAUDE, ["-v"], { delaiMs: 30_000 });
        const a = await executer(CLAUDE, ["auth", "status"], { delaiMs: 30_000 });
        const avant = etatLu === 0 ? undefined : etat.authCode;
        etat = { version: v.stdout.trim().slice(0, 80) || null, authStatus: a.stdout.trim().slice(0, 2_000) || null, authCode: a.code };
        if (a.code !== avant) log(`claude ${etat.version ?? "?"} — connexion claude.ai : ${a.code === 0 ? "oui" : "NON : Render › claude-relais › Shell › claude auth login"}`);
        etatLu = Date.now();
      }
      const q = new URLSearchParams({ version: etat.version ?? "", authCode: etat.authCode === null ? "" : String(etat.authCode), authStatus: etat.authStatus ?? "" });
      const rep = await appelErp("GET", `/api/dev/relais/ordres?${q}`);
      if (!rep.ok) throw new Error(`ERP : HTTP ${rep.status}`);
      const { ordre } = (await rep.json()) as { ordre: Ordre | null };
      pause = 1_000;
      if (!ordre) continue; // l'ERP a déjà attendu (long-polling) : on retire aussitôt
      log(`ordre ${ordre.id} (${ordre.type})`);
      const resultat = await traiter(ordre);
      for (let essai = 0; essai < 5; essai += 1) {
        const r = await appelErp("POST", "/api/dev/relais/ordres", resultat).catch(() => null);
        if (r?.ok) break;
        await dormir(2_000 * 2 ** essai);
      }
      log(`ordre ${ordre.id} rendu (code ${String(resultat.code)})`);
    } catch (e) {
      log(`attente : ${e instanceof Error ? e.message : String(e)}`);
      await dormir(pause);
      pause = Math.min(pause * 2, 60_000);
    }
  }
}

void main();
