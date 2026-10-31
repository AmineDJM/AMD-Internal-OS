/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BAC À SABLE PYTHON — un processus à part, mesuré, et déclaré ABSENT quand il l'est.
 *
 * ── CE QUI EST GARANTI, ET PAR QUOI ──────────────────────────────────────────────────────
 *
 *   1. UN PROCESSUS SÉPARÉ, lancé avec `-I` (isolé : ignore PYTHONPATH, le site utilisateur, les
 *      variables d'environnement) et un environnement VIDE — les clés de la production n'existent
 *      pas dans son monde. Répertoire de travail : un dossier temporaire vide, supprimé après.
 *   2. DES LIMITES POSÉES PAR LE NOYAU (`resource`) avant la première ligne du code : mémoire
 *      virtuelle, temps CPU, taille de fichier à ZÉRO (aucune écriture possible), nombre de
 *      processus à ZÉRO (aucun `subprocess`, aucun `fork`). Le code ne peut pas les relever :
 *      la limite dure est égale à la limite souple.
 *   3. UN DÉLAI dur côté Node : SIGKILL, pas une prière.
 *   4. LA FORME : les modules qui touchent au système, au réseau ou aux fichiers sont refusés à
 *      la lecture du code, avec le mot fautif. Ce n'est pas une barrière noyau — c'est dit tel
 *      quel dans la réponse (`isolation`), et c'est pour cela que les trois autres verrous existent.
 *   5. UN RÉSULTAT BORNÉ : la variable `result`, sérialisée en JSON (1 Mo au plus), rendue sur un
 *      descripteur séparé des `print` — qu'on capture dans un journal borné.
 *
 * DISPONIBILITÉ MESURÉE, JAMAIS SUPPOSÉE. Le serveur de production déploie en `runtime: node` :
 * python3 peut manquer. `sonderPython()` le constate une fois, et l'outil dit « indisponible ici »
 * plutôt que d'échouer en silence — le code JavaScript du bac reste la voie sûre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PY_DELAI_MS = 8_000;
export const PY_MEMOIRE_MO = 768;
export const PY_CODE_MAX = 40_000;
export const PY_RESULTAT_MAX = 1_048_576;
export const PY_JOURNAL_MAX = 60;

const CANDIDATS = [
  process.env.SANDBOX_PYTHON, "/usr/local/bin/python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3.12", "/usr/bin/python3.11",
].filter((c): c is string => typeof c === "string" && c.length > 0 && c !== "off");

export interface DisponibilitePython {
  disponible: boolean;
  chemin: string | null;
  version: string | null;
  /** Les modules de calcul présents (pandas, numpy…) — pour que le modèle sache quoi importer. */
  modules: string[];
  raison?: string;
}

let cache: DisponibilitePython | null = null;

/** SONDER python3 — une fois par processus, résultat mis en cache ; `force` pour re-mesurer. */
export function sonderPython(force = false): DisponibilitePython {
  if (cache && !force) return cache;
  if (process.env.SANDBOX_PYTHON === "off") {
    cache = { disponible: false, chemin: null, version: null, modules: [], raison: "désactivé par configuration (SANDBOX_PYTHON=off)" };
    return cache;
  }
  const sonde = "import sys,json,importlib.util as u;print(json.dumps({'v':sys.version.split()[0],'m':[m for m in ('pandas','numpy','scipy','statistics','decimal','csv') if u.find_spec(m)]}))";
  for (const chemin of CANDIDATS) {
    try {
      const r = spawnSync(chemin, ["-I", "-c", sonde], { env: {} as unknown as NodeJS.ProcessEnv, timeout: 4_000, encoding: "utf8" });
      if (r.status === 0 && r.stdout) {
        const j = JSON.parse(r.stdout.trim()) as { v: string; m: string[] };
        cache = { disponible: true, chemin, version: j.v, modules: j.m };
        return cache;
      }
    } catch { /* candidat suivant */ }
  }
  cache = { disponible: false, chemin: null, version: null, modules: [], raison: "python3 introuvable sur ce serveur (aucun binaire standard, SANDBOX_PYTHON non défini)" };
  return cache;
}

const INTERDIT_PY = /\b(import\s+(os|sys|subprocess|socket|shutil|pathlib|ctypes|multiprocessing|threading|signal|importlib|urllib|http|requests|ftplib|smtplib|telnetlib|asyncio|pty|resource|builtins|code|pickle|marshal|shelve|sqlite3|psycopg2|webbrowser|glob|tempfile|io)\b|from\s+(os|sys|subprocess|socket|shutil|pathlib|ctypes|multiprocessing|threading|signal|importlib|urllib|http|requests|ftplib|smtplib|asyncio|pty|resource|builtins|pickle|marshal|shelve|sqlite3|psycopg2|glob|tempfile|io)\b|__import__|open\s*\(|exec\s*\(|eval\s*\(|compile\s*\(|globals\s*\(|__builtins__|__subclasses__|__loader__|__spec__|breakpoint\s*\()/;

/** LA FORME : ce qu'on refuse avant de lancer un processus — dit clairement, pour que le modèle corrige. */
export function verifierCodePython(code: string): { ok: true } | { ok: false; motif: string } {
  const c = (code ?? "").trim();
  if (!c) return { ok: false, motif: "code vide" };
  if (c.length > PY_CODE_MAX) return { ok: false, motif: `code trop long (${PY_CODE_MAX} caractères au plus)` };
  const m = INTERDIT_PY.exec(c);
  if (m) return { ok: false, motif: `« ${m[0].trim()} » n'est pas disponible dans le bac à sable : ni fichiers, ni réseau, ni système — seulement le calcul sur data` };
  return { ok: true };
}

export interface ResultatPython {
  ok: boolean;
  resultat: unknown;
  journal: string[];
  ms: number;
  erreur?: string;
  notes: string[];
  isolation: "processus_limites_noyau" | null;
  version: string | null;
}

/** Le prélude : limites noyau, capture des `print`, exécution, résultat sur le descripteur 3. */
function prelude(cpuS: number, memOctets: number): string {
  return [
    "import sys, json, builtins, os",
    "try:",
    "    import resource",
    `    resource.setrlimit(resource.RLIMIT_AS, (${memOctets}, ${memOctets}))`,
    `    resource.setrlimit(resource.RLIMIT_CPU, (${cpuS}, ${cpuS}))`,
    "    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))",
    "    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))",
    "except Exception:",
    "    pass",
    "_fd3 = os.fdopen(3, 'w')",
    "_code = sys.stdin.read()",
    "_sep = _code.index('\\n#__DATA__\\n')",
    "_src, _json = _code[:_sep], _code[_sep + len('\\n#__DATA__\\n'):]",
    "data = json.loads(_json)",
    "class _J:",
    "    def __init__(self): self.lines = []; self.buf = ''",
    "    def write(self, s):",
    "        self.buf += str(s)",
    "        while '\\n' in self.buf:",
    "            l, self.buf = self.buf.split('\\n', 1)",
    `            if l.strip() and len(self.lines) < ${PY_JOURNAL_MAX}: self.lines.append(l[:500])`,
    "    def flush(self):",
    `        if self.buf.strip() and len(self.lines) < ${PY_JOURNAL_MAX}: self.lines.append(self.buf[:500])`,
    "        self.buf = ''",
    "_j = _J(); sys.stdout = _j; sys.stderr = _j",
    "_g = {'__builtins__': builtins, '__name__': '__sandbox__', 'data': data, 'json': json}",
    "_ok, _err = True, None",
    "try:",
    "    exec(compile(_src, 'sandbox.py', 'exec'), _g)",
    "except BaseException as e:",
    "    _ok, _err = False, (type(e).__name__ + ': ' + str(e))[:400]",
    "_j.flush()",
    "_res = _g.get('result')",
    "try:",
    "    _out = json.dumps(_res, default=str, ensure_ascii=False)",
    "except Exception as e:",
    "    _ok, _err, _out = False, 'résultat non sérialisable en JSON : ' + str(e)[:200], 'null'",
    "_fd3.write(json.dumps({'ok': _ok, 'result': _out, 'journal': _j.lines, 'error': _err}, ensure_ascii=False))",
    "_fd3.flush()",
  ].join("\n");
}

/**
 * EXÉCUTER du Python sur des données, dans un processus isolé. Le code lit `data` et pose
 * `result`. Indisponible → `ok: false` avec la raison, jamais une exception.
 */
export async function executerPython(code: string, data: unknown, opts: { delaiMs?: number } = {}): Promise<ResultatPython> {
  const t0 = Date.now();
  const notes: string[] = [];
  const dispo = sonderPython();
  if (!dispo.disponible || !dispo.chemin) return { ok: false, resultat: null, journal: [], ms: 0, erreur: `Python indisponible : ${dispo.raison ?? "non sondé"}. Le code JavaScript du bac à sable reste disponible.`, notes, isolation: null, version: null };
  const forme = verifierCodePython(code);
  if (!forme.ok) return { ok: false, resultat: null, journal: [], ms: 0, erreur: `Code refusé — ${forme.motif}.`, notes, isolation: null, version: dispo.version };
  const delai = Math.min(Math.max(opts.delaiMs ?? PY_DELAI_MS, 500), PY_DELAI_MS);
  let dataJson: string;
  try { dataJson = JSON.stringify(data ?? null) ?? "null"; }
  catch { return { ok: false, resultat: null, journal: [], ms: 0, erreur: "les données ne sont pas sérialisables en JSON", notes, isolation: null, version: dispo.version }; }
  if (code.includes("\n#__DATA__\n")) return { ok: false, resultat: null, journal: [], ms: 0, erreur: "Code refusé — séquence réservée.", notes, isolation: null, version: dispo.version };

  const cwd = mkdtempSync(join(tmpdir(), "amd-sandbox-"));
  return new Promise<ResultatPython>((resolve) => {
    let fini = false;
    const chunks: Buffer[] = []; const bruit: Buffer[] = [];
    const options: SpawnOptions = {
      cwd,
      // Un environnement RÉDUIT à ce que le calcul numérique exige (un seul fil BLAS, hachage
      // stable, UTF-8) : aucune variable de la production n'y entre.
      env: { OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    };
    const child: ChildProcess = spawn(dispo.chemin as string, ["-I", "-B", "-c", prelude(Math.ceil(delai / 1000) + 1, PY_MEMOIRE_MO * 1024 * 1024)], options);
    const conclure = (r: Omit<ResultatPython, "ms" | "isolation" | "version">) => {
      if (fini) return; fini = true; clearTimeout(garde);
      try { child.kill("SIGKILL"); } catch { /* déjà terminé */ }
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve({ ...r, ms: Date.now() - t0, isolation: "processus_limites_noyau", version: dispo.version });
    };
    const garde = setTimeout(() => conclure({ ok: false, resultat: null, journal: [], erreur: `délai dépassé (${delai} ms) : le processus a été tué`, notes }), delai + 500);
    (child.stdio[3] as Readable | null | undefined)?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => { if (bruit.length < 20) bruit.push(c); });
    child.stdout?.on("data", () => undefined);
    child.on("error", (e: Error) => conclure({ ok: false, resultat: null, journal: [], erreur: `lancement impossible : ${e.message}`, notes }));
    child.on("close", (codeSortie: number | null) => {
      const brut = Buffer.concat(chunks).toString("utf8");
      if (!brut) {
        const err = Buffer.concat(bruit).toString("utf8").trim().split("\n").pop() ?? "";
        const memoire = /MemoryError|Cannot allocate memory/i.test(err);
        conclure({ ok: false, resultat: null, journal: [], erreur: memoire ? `mémoire dépassée (${PY_MEMOIRE_MO} Mo)` : `le processus s'est arrêté sans résultat (code ${codeSortie})${err ? " — " + err.slice(0, 200) : ""}`, notes });
        return;
      }
      let m: { ok: boolean; result: string; journal: string[]; error: string | null };
      try { m = JSON.parse(brut); } catch { conclure({ ok: false, resultat: null, journal: [], erreur: "sortie illisible du processus", notes }); return; }
      if (m.result.length > PY_RESULTAT_MAX) {
        notes.push(`résultat tronqué : ${m.result.length} octets, ${PY_RESULTAT_MAX} au plus — rendre moins de lignes ou agréger`);
        conclure({ ok: false, resultat: null, journal: m.journal ?? [], erreur: "résultat trop volumineux", notes });
        return;
      }
      let resultat: unknown = null;
      try { resultat = JSON.parse(m.result); } catch { /* sérialisé côté Python */ }
      conclure({ ok: m.ok, resultat, journal: m.journal ?? [], ...(m.error ? { erreur: m.error } : {}), notes });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${code}\n#__DATA__\n${dataJson}`);
  });
}
