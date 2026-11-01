/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RELAIS CLAUDE CODE — à faire tourner sur UNE MACHINE DE LA DIRECTION (lot C2, décision 0041 § 3 bis).
 *
 * Il TIRE les ordres de l'ERP (HTTPS, son propre jeton), exécute la CLI `claude` connectée au compte claude.ai de la
 * Direction (`claude auth login`, fait par elle, sur cette machine), et rend la sortie BRUTE. Les identifiants claude.ai
 * ne quittent jamais cette machine ; l'ERP ne les voit pas.
 *
 *   node --experimental-strip-types scripts/relais-claude.ts      (Node ≥ 22.6, aucune dépendance)
 *   npx tsx scripts/relais-claude.ts                              (équivalent, depuis une copie du dépôt de l'ERP)
 *
 * Variables : RELAIS_ERP_URL (ex. https://amd-internal-os-k3uc.onrender.com), RELAIS_JETON (= CLAUDE_RELAIS_TOKEN de
 * l'ERP), RELAIS_DOSSIER (où garder une copie de travail par dépôt ; défaut ~/.adventum-relais), RELAIS_CLAUDE (chemin
 * de `claude` ; défaut « claude »), RELAIS_GIT (défaut « git »).
 *
 *   CREER    copie du dépôt (clone au premier ordre, puis `git fetch`), branche réservée créée depuis la branche par défaut
 *            si elle n'existe pas sur GitHub et POUSSÉE (le VM clone la branche du dépôt GitHub, pas la copie locale),
 *            puis `claude --cloud "<consigne>"`.
 *   MESSAGE  `claude -p --cloud <session-id> --output-format json`, consigne sur l'entrée standard.
 *
 * Jamais de shell : `spawn` avec des arguments. Un ordre à la fois. Rien n'est journalisé du texte des consignes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ERP = (process.env.RELAIS_ERP_URL ?? "").replace(/\/+$/, "");
const JETON = process.env.RELAIS_JETON ?? "";
const DOSSIER = process.env.RELAIS_DOSSIER ?? join(homedir(), ".adventum-relais");
const CLAUDE = process.env.RELAIS_CLAUDE ?? "claude";
const GIT = process.env.RELAIS_GIT ?? "git";
const DELAI_CLAUDE_MS = 10 * 60_000;
const DELAI_GIT_MS = 5 * 60_000;
const MAX_SORTIE = 8_000;

interface Ordre { id: string; type: "CREER" | "MESSAGE"; depot: string | null; branche: string | null; sessionId: string | null; texte: string }
interface Issue { code: number | null; stdout: string; stderr: string; delaiDepasse: boolean }

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Une commande SANS shell, avec délai ; l'entrée standard optionnelle porte le texte. */
function executer(cmd: string, args: string[], opts: { cwd?: string; entree?: string; delaiMs: number }): Promise<Issue> {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, env: process.env });
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
  if (!existsSync(copie)) { mkdirSync(DOSSIER, { recursive: true }); await git(["clone", `https://github.com/${depot}.git`, copie]); }
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
  if (!/^https?:\/\//.test(ERP) || JETON.length < 24) { console.error("RELAIS_ERP_URL et RELAIS_JETON (≥ 24 caractères) sont requis"); process.exit(2); }
  let etat = { version: null as string | null, authStatus: null as string | null, authCode: null as number | null };
  let etatLu = 0;
  log(`relais démarré → ${ERP}`);
  for (let pause = 1_000; ; ) {
    try {
      if (Date.now() - etatLu > 10 * 60_000) {
        const v = await executer(CLAUDE, ["-v"], { delaiMs: 30_000 });
        const a = await executer(CLAUDE, ["auth", "status"], { delaiMs: 30_000 });
        etat = { version: v.stdout.trim().slice(0, 80) || null, authStatus: a.stdout.trim().slice(0, 2_000) || null, authCode: a.code };
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
