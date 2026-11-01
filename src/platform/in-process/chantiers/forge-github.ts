import { noterEffetExterne } from "@/lib/effets/magasin";
import { configGithub, type Env } from "@/platform/dev/config";
import { appeler, echec, pageSuivante, type ConfigHttp, type OptionsAppel, type ReponseHttp, type ValeurRequete } from "@/platform/dev/http";
import type { CheckRun, Commit, CompteForge, Comparaison, ConclusionCheck, EtatChecks, ForgeGit, InfoDepot, NomDepot, PullRequest, Resultat } from "@/platform/dev/ports";

/**
 * LA FORGE — GitHub REST v3 en `fetch` nu (lot C2).
 *
 * En-têtes de la doc GitHub : `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
 * `Authorization: Bearer <GITHUB_TOKEN>` (fine-grained de la Direction), `User-Agent` (exigé).
 *   • PAGINATION par l'en-tête `Link: …; rel="next"` (bornée : 10 pages).
 *   • ETag : une lecture répétée envoie `If-None-Match` ; un 304 ne coûte rien au quota (« conditional requests ») et
 *     rend la réponse gardée — le sondage de secours en vit.
 *   • QUOTAS : 403/429 avec `x-ratelimit-remaining: 0` (primaire, `x-ratelimit-reset`) ou « secondary rate limit »
 *     (`retry-after`) → `QUOTA` daté ; le dernier `x-ratelimit-remaining` lu est gardé pour l'écran.
 *   • ÉCRITURES (commentaire, relance de jobs) : notées au journal des effets J7, neutralisées en simulation.
 */

const VERSION_API = "2022-11-28";
const PAGES_MAX = 10;
const CACHE_MAX = 300;

interface Brut { [k: string]: unknown }
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (typeof v === "number" ? v : 0);
const o = (v: unknown): Brut => (v && typeof v === "object" ? (v as Brut) : {});

export interface QuotaGithub { restant: number | null; limite: number | null; reinitialiseA: string | null }

export interface OptionsForge { env?: Env; fetch?: typeof fetch; jeton?: string | null; base?: string }

const chemin = (depot: NomDepot, suite: string) => `/repos/${depot.split("/").map(encodeURIComponent).join("/")}${suite}`;
const segments = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

function commitDe(c: Brut): Commit {
  const commit = o(c.commit);
  return {
    sha: s(c.sha) ?? "",
    message: (s(commit.message) ?? "").split("\n")[0]!.slice(0, 300),
    auteur: s(o(c.author).login) ?? s(o(commit.author).name),
    date: s(o(commit.author).date) ?? s(o(commit.committer).date),
    url: s(c.html_url),
  };
}

export function prDe(p: Brut): PullRequest {
  return {
    numero: n(p.number),
    titre: s(p.title) ?? "",
    etat: p.state === "closed" ? "closed" : "open",
    fusionnee: Boolean(p.merged_at) || p.merged === true,
    brouillon: p.draft === true,
    fusionnable: typeof p.mergeable === "boolean" ? p.mergeable : null,
    etatFusion: s(p.mergeable_state),
    branche: s(o(p.head).ref) ?? "",
    base: s(o(p.base).ref) ?? "",
    shaTete: s(o(p.head).sha) ?? "",
    url: s(p.html_url) ?? "",
    auteur: s(o(p.user).login),
  };
}

const ECHECS: ReadonlySet<string> = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const VERTS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** Le verdict DÉTERMINISTE sur un SHA : un échec suffit à le rendre rouge ; vert exige tout terminé et vert. */
export function verdictChecks(sha: string, runs: CheckRun[]): EtatChecks {
  // Un check relancé apparaît deux fois : seul le plus récent (id le plus grand) compte.
  const parNom = new Map<string, CheckRun>();
  for (const r of runs) { const d = parNom.get(r.nom); if (!d || r.id > d.id) parNom.set(r.nom, r); }
  const retenus = [...parNom.values()];
  const echecs = retenus.filter((r) => r.statut === "completed" && r.conclusion !== null && ECHECS.has(r.conclusion));
  let global: EtatChecks["global"];
  if (!retenus.length) global = "AUCUN";
  else if (echecs.length) global = "ROUGE";
  else if (retenus.some((r) => r.statut !== "completed")) global = "EN_COURS";
  else global = retenus.every((r) => r.conclusion !== null && VERTS.has(r.conclusion)) ? "VERT" : "ROUGE";
  return { sha, global, runs: retenus, echecs };
}

export function creerForgeGithub(opts: OptionsForge = {}): ForgeGit & { quota(): QuotaGithub } {
  const conf = configGithub(opts.env ?? process.env);
  const jeton = opts.jeton !== undefined ? opts.jeton : conf.jeton;
  const cfg: ConfigHttp = {
    fournisseur: "GitHub",
    base: opts.base ?? conf.base,
    autorisation: jeton ? `Bearer ${jeton}` : null,
    entetes: { accept: "application/vnd.github+json", "x-github-api-version": VERSION_API, "user-agent": "Adventum-Chantiers" },
    fetch: opts.fetch,
  };
  const cache = new Map<string, { etag: string; rep: ReponseHttp<unknown> }>();
  const quota: QuotaGithub = { restant: null, limite: null, reinitialiseA: null };

  function noterQuota(h: Headers) {
    const r = h.get("x-ratelimit-remaining");
    const l = h.get("x-ratelimit-limit");
    const z = h.get("x-ratelimit-reset");
    if (r !== null) quota.restant = Number(r);
    if (l !== null) quota.limite = Number(l);
    if (z !== null && /^\d+$/.test(z)) quota.reinitialiseA = new Date(Number(z) * 1000).toISOString();
  }

  async function lire<T>(route: string, requete?: Record<string, ValeurRequete>, extra: OptionsAppel = {}): Promise<Resultat<ReponseHttp<T>>> {
    const cle = `${route}?${JSON.stringify(requete ?? {})}`;
    const garde = cache.get(cle);
    const r = await appeler<T>(cfg, "GET", route, { ...extra, requete, accepter: [304, ...(extra.accepter ?? [])], entetes: garde ? { "if-none-match": garde.etag } : undefined });
    if (!r.ok) return r;
    noterQuota(r.valeur.entetes);
    if (r.valeur.statut === 304 && garde) return { ok: true, valeur: garde.rep as ReponseHttp<T> };
    const etag = r.valeur.entetes.get("etag");
    if (etag && r.valeur.statut === 200) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(cle, { etag, rep: r.valeur });
    }
    return r;
  }

  async function tout<T>(route: string, requete: Record<string, ValeurRequete>, extraire: (corps: unknown) => T[]): Promise<Resultat<T[]>> {
    const acc: T[] = [];
    let suivante: string | null = route;
    let req: Record<string, ValeurRequete> | undefined = requete;
    for (let p = 0; suivante && p < PAGES_MAX; p += 1) {
      const r: Resultat<ReponseHttp<unknown>> = await lire<unknown>(suivante, req);
      if (!r.ok) return r;
      acc.push(...extraire(r.valeur.corps));
      suivante = pageSuivante(r.valeur.entetes.get("link"));
      req = undefined; // l'URL suivante porte déjà sa requête
    }
    return { ok: true, valeur: acc };
  }

  async function ecrire<T>(methode: "POST", route: string, corps: unknown, libelle: string): Promise<Resultat<ReponseHttp<T>>> {
    if (noterEffetExterne({ acte: "ECRITURE_EXTERNE", cible: `GitHub : ${libelle}`.slice(0, 200), origine: "chantiers" })) {
      return echec("SIMULE", `simulation : ${libelle} — rien n'a été envoyé à GitHub`);
    }
    const r = await appeler<T>(cfg, methode, route, { corps });
    if (r.ok) noterQuota(r.valeur.entetes);
    return r;
  }

  return {
    quota: () => ({ ...quota }),

    async moi(): Promise<Resultat<CompteForge>> {
      const r = await lire<Brut>("/user");
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      return { ok: true, valeur: { login: s(c.login) ?? "", type: s(c.type) ?? "User", nom: s(c.name) } };
    },

    async depot(depot): Promise<Resultat<InfoDepot>> {
      const r = await lire<Brut>(chemin(depot, ""));
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      const perm = o(c.permissions);
      return { ok: true, valeur: { nom: (s(c.full_name) ?? depot) as NomDepot, brancheParDefaut: s(c.default_branch) ?? "main", prive: c.private === true, peutPousser: typeof perm.push === "boolean" ? perm.push : null, archive: c.archived === true } };
    },

    async teteDeBranche(depot, branche): Promise<Resultat<string | null>> {
      const r = await lire<Brut>(chemin(depot, `/git/ref/heads/${segments(branche)}`), undefined, { accepter: [404] });
      if (!r.ok) return r;
      if (r.valeur.statut === 404) return { ok: true, valeur: null };
      return { ok: true, valeur: s(o(o(r.valeur.corps).object).sha) };
    },

    async commits(depot, { branche, depuis, limite }): Promise<Resultat<Commit[]>> {
      const r = await lire<Brut[]>(chemin(depot, "/commits"), { sha: branche, since: depuis ?? undefined, per_page: Math.min(Math.max(limite ?? 30, 1), 100) });
      if (!r.ok) return r;
      return { ok: true, valeur: (Array.isArray(r.valeur.corps) ? r.valeur.corps : []).map((c) => commitDe(o(c))) };
    },

    async comparer(depot, base, tete): Promise<Resultat<Comparaison>> {
      const r = await lire<Brut>(chemin(depot, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(tete)}`));
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      const fichiers = (Array.isArray(c.files) ? c.files : []).map((f) => { const x = o(f); return { chemin: s(x.filename) ?? "", statut: s(x.status) ?? "", ajouts: n(x.additions), suppressions: n(x.deletions) }; });
      return { ok: true, valeur: { statut: s(c.status) ?? "", enAvance: n(c.ahead_by), enRetard: n(c.behind_by), commits: (Array.isArray(c.commits) ? c.commits : []).map((x) => commitDe(o(x))), fichiers } };
    },

    async prDeBranche(depot, branche): Promise<Resultat<PullRequest | null>> {
      const proprietaire = depot.split("/")[0]!;
      const r = await lire<Brut[]>(chemin(depot, "/pulls"), { head: `${proprietaire}:${branche}`, state: "all", sort: "updated", direction: "desc", per_page: 10 });
      if (!r.ok) return r;
      const prs = (Array.isArray(r.valeur.corps) ? r.valeur.corps : []).map((p) => prDe(o(p)));
      return { ok: true, valeur: prs.find((p) => p.etat === "open") ?? prs[0] ?? null };
    },

    async pr(depot, numero): Promise<Resultat<PullRequest>> {
      const r = await lire<Brut>(chemin(depot, `/pulls/${numero}`));
      if (!r.ok) return r;
      return { ok: true, valeur: prDe(o(r.valeur.corps)) };
    },

    async checks(depot, sha): Promise<Resultat<EtatChecks>> {
      const runs = await tout<CheckRun>(chemin(depot, `/commits/${encodeURIComponent(sha)}/check-runs`), { per_page: 100 }, (corps) =>
        (Array.isArray(o(corps).check_runs) ? (o(corps).check_runs as unknown[]) : []).map((x) => {
          const c = o(x);
          const actions = s(o(c.app).slug) === "github-actions";
          return { id: n(c.id), nom: s(c.name) ?? "?", statut: s(c.status) ?? "queued", conclusion: (s(c.conclusion) as ConclusionCheck) ?? null, url: s(c.html_url) ?? s(c.details_url), jobId: actions ? n(c.id) : null };
        }));
      if (!runs.ok) return runs;
      // Les « commit statuses » (anciens intégrateurs, dont certains hébergeurs) comptent aussi.
      const st = await lire<Brut>(chemin(depot, `/commits/${encodeURIComponent(sha)}/status`));
      if (!st.ok) return st;
      const statuts = (Array.isArray(o(st.valeur.corps).statuses) ? (o(st.valeur.corps).statuses as unknown[]) : []).map((x, i): CheckRun => {
        const c = o(x);
        const etat = s(c.state) ?? "pending";
        return { id: -1 - i, nom: `statut:${s(c.context) ?? "?"}`, statut: etat === "pending" ? "pending" : "completed", conclusion: etat === "success" ? "success" : etat === "pending" ? null : "failure", url: s(c.target_url), jobId: null };
      });
      return { ok: true, valeur: verdictChecks(sha, [...runs.valeur, ...statuts]) };
    },

    async journalDeJob(depot, jobId, maxOctets = 60_000): Promise<Resultat<string>> {
      const r = await appeler<string>(cfg, "GET", chemin(depot, `/actions/jobs/${jobId}/logs`), { maxOctets, entetes: { accept: "application/vnd.github+json" } });
      if (!r.ok) return r;
      noterQuota(r.valeur.entetes);
      return { ok: true, valeur: r.valeur.texte };
    },

    async commenterPr(depot, numero, texte): Promise<Resultat<{ id: number; url: string }>> {
      const r = await ecrire<Brut>("POST", chemin(depot, `/issues/${numero}/comments`), { body: texte }, `commentaire sur ${depot}#${numero}`);
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      return { ok: true, valeur: { id: n(c.id), url: s(c.html_url) ?? "" } };
    },

    async relancerEchecs(depot, runId): Promise<Resultat<true>> {
      const r = await ecrire<Brut>("POST", chemin(depot, `/actions/runs/${runId}/rerun-failed-jobs`), {}, `relance des jobs en échec du run ${runId} (${depot})`);
      return r.ok ? { ok: true, valeur: true } : r;
    },
  };
}
