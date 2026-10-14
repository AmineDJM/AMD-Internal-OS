import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, isTopManagement, userCan, type SessionUser } from "@/lib/rbac";
import {
  abandonnerCleSite, enregistrerArticle, genererCleSite, leverBlocageSite, rapprocherSiteMaintenant, relancerEnvoiSite, supprimerArticle,
  verifierConnexionSite,
} from "@/lib/actions/site-web-actions";
import { peutEcrireArticles, peutGererLaLiaison } from "./acces";
import { ECRAN_LIAISON, REFUS_LIAISON } from "./ecran";
import { enregistrerOffre, supprimerOffre } from "@/lib/actions/offres-emploi-actions";
import { closeRecruitmentRequest, openRecruitmentSourcing } from "@/lib/actions/recruitment-actions";
import { leverBlocage, lireBlocage, VERROU_PERIME_MS, viderFile } from "./file";
import { rapprocherSite, rapprocherSiteSiDu, verifierSante } from "./reconciliation";
import { synchroniserArticle } from "./contenus";
import { empreinteCle, lireConfiguration } from "./config";
import { DELAIS_REESSAI_MS, ESSAIS_MAX, slugSuggere } from "./contrat";
import { etatAffiche, etatIntegration, etatLiaison, publicationsDe } from "./etat";
import { envoyerAuSite, signer, type ReponseSite, type RequeteSite, type TransportSite } from "./transport";
import {
  blocEnvironnement, cleActive, cleEnAttente, clesIllisibles, configurationEnVigueur, genererCle, origineDeLERP,
  presenterCleEnAttente, prochainePresentation, promouvoir,
} from "./cles";
import { authentifierLeSite, signatureAttendue, SIGNATURE_REFUSEE } from "./entrant";
import { derniereSante, entretenirLiaison } from "./liaison";
import { GET as contenusDuSite } from "@/app/api/site-web/v1/contenus/route";
import { POST as candidatureDuSite } from "@/app/api/site-web/v1/candidatures/route";
import { deleteFileByKey } from "@/lib/storage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PUBLICATION VERS LE SITE, DE BOUT EN BOUT (§118.158) — par les VRAIES actions, la VRAIE
 * file et la VRAIE réconciliation, contre un FAUX SITE en mémoire qui tient le contrat
 * (`docs/openapi.yaml` du dépôt du site) : PUT idempotent sur l'`externalId`, 201 à la création,
 * 200 ensuite, 404 sur un DELETE déjà fait, `GET /jobs` et `GET /posts` qui rendent ce qu'il détient.
 *
 * UN SEUL FICHIER, et c'est voulu : le disjoncteur vit dans une ligne GLOBALE (`AppSetting`), et
 * deux fichiers qui le poseraient et le lèveraient en parallèle se contrediraient. Ici tout est
 * séquentiel, et chaque cas repart d'une file vide de ses propres lignes.
 *
 * AUCUNE REQUÊTE NE SORT : le transport est injecté partout, et le seul cas qui passe par le
 * transport de production prouve justement que la garde le bloque AVANT le réseau. La liaison
 * (§118.159) passe, elle, par le VRAI transport vers une adresse de la MACHINE (`127.0.0.1`), que
 * `fetch` bouché fait répondre comme le site : rien ne quitte le processus.
 *
 * LES CLÉS DE LIAISON SONT GLOBALES comme le disjoncteur (une seule active, une seule en attente) :
 * elles vivent ici, dans le même fichier séquentiel, et chaque cas repart d'une table vide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__siteweb__";
const CLE = "cle-banc-siteweb-9f8e7d6c5b4a";
const ENV_AVANT = {
  base: process.env.ADVENTUM_BASE_URL, cle: process.env.ADVENTUM_API_KEY, secret: process.env.ADVENTUM_WEBHOOK_SECRET,
  reco: process.env.SITE_WEB_RECONCILIATION,
};

function poserEnv() {
  process.env.ADVENTUM_BASE_URL = "https://site.banc.test";
  process.env.ADVENTUM_API_KEY = CLE;
  delete process.env.ADVENTUM_WEBHOOK_SECRET;
  delete process.env.SITE_WEB_RECONCILIATION;
}

const plus = (ms: number) => new Date(Date.now() + ms);
const VRAI_FETCH = global.fetch;

/**
 * CE QU'UN RUN INTERROMPU LAISSE NE DOIT PAS FAUSSER LE SUIVANT (§118.91, §118.136).
 *
 * Mesuré en jouant la série de sabotages : un cas qui tombe avant sa dernière ligne ne supprimait
 * pas ses rapprochements, et le run d'après lisait leurs orphelins comme « déjà signalés » — ou,
 * datés du surlendemain par le cas du battement, les prenait pour le passage précédent. Deux
 * remèdes, parce qu'ils ne protègent pas de la même chose : chaque rapprochement joué est NOTÉ et
 * retiré en `afterEach`, échec compris ; et l'orphelin du banc porte un identifiant PROPRE AU RUN,
 * qu'aucune ligne laissée par un autre run ne peut contenir.
 */
const RUN = Date.now().toString(36);
const ORPHELIN = `orphelin-banc-${RUN}`;
const RAPPROCHEMENTS: string[] = [];
function noter<T extends { id: string | null } | null>(b: T): T {
  if (b?.id) RAPPROCHEMENTS.push(b.id);
  return b;
}

function rep(statut: number | null, corps?: unknown, extra: Partial<ReponseSite> = {}): ReponseSite {
  return {
    statut,
    texte: corps === undefined || corps === null ? null : typeof corps === "string" ? corps : JSON.stringify(corps),
    erreur: statut === null ? "site injoignable : ECONNRESET" : null,
    ms: 4,
    retryAfterS: null,
    location: null,
    ...extra,
  };
}

/** Un transport scripté qui garde la trace de chaque requête. */
function script(reponse: (r: RequeteSite) => ReponseSite | Promise<ReponseSite>): { fn: TransportSite; appels: RequeteSite[] } {
  const appels: RequeteSite[] = [];
  return { appels, fn: async (r) => { appels.push(r); return reponse(r); } };
}

/**
 * LE FAUX SITE — assez fidèle pour que la réconciliation se juge sur ce qu'il DÉTIENT : il écrit
 * ce qu'on lui pousse, dérive un slug du titre quand on n'en donne pas, rend 404 sur un DELETE
 * de ce qu'il n'a pas, et liste ses contenus (plus ceux saisis dans son admin, sans externalId,
 * et les articles de son dépôt).
 */
function fauxSite() {
  const posts = new Map<string, Record<string, unknown>>();
  const jobs = new Map<string, Record<string, unknown>>();
  const manuels: Record<string, unknown>[] = [];
  const depot: { slug: string; title: string; url: string }[] = [];
  // LE DÉPÔT DU SITE (§118.160) — ses articles en Markdown BRUT, ses offres d'exemple, les offres
  // saisies dans son administration, et les fichiers qu'il CACHE : ceux qu'un article de l'ERP
  // remplace (`replacesFile`) et ceux dont l'ERP a supprimé la reprise (pierres tombales). Il tient
  // ce que `lib/blog.ts`, `lib/jobs.ts` et `lib/replaced-files.ts` du site tiennent, relus pour
  // l'écrire. `sansDepot` joue un site d'AVANT la reprise : `/repository` y répond 404.
  const depotComplet: Record<string, unknown>[] = [];
  const exemples: Record<string, unknown>[] = [];
  const offresSaisies: Record<string, unknown>[] = [];
  const tombes = new Set<string>();
  const etat = { sansDepot: false, rechargements: 0 };
  const caches = () => {
    const c = new Set(tombes);
    for (const p of posts.values()) if (typeof p.replacesFile === "string") c.add(p.replacesFile);
    return c;
  };
  const retirerSaisie = (id: unknown) => {
    const i = offresSaisies.findIndex((o) => o.id === id);
    if (i >= 0) offresSaisies.splice(i, 1);
    return i >= 0;
  };
  const s = script((r) => {
    if (r.methode === "GET" && r.chemin === "/posts") {
      const c = caches();
      const visibles = depotComplet.filter((a) => !c.has(String(a.slug))).map((a) => ({ slug: a.slug, title: a.title, url: `/blog/${a.slug}` }));
      return rep(200, {
        count: posts.size + manuels.length, posts: [...posts.values(), ...manuels],
        readOnlyFileArticles: [...depot, ...visibles], replacedFiles: [...c].sort(),
      });
    }
    if (r.methode === "GET" && r.chemin === "/jobs") {
      return rep(200, { count: jobs.size + offresSaisies.length, jobs: [...jobs.values(), ...offresSaisies.map((o) => ({ ...o, externalId: null }))] });
    }
    if (r.methode === "GET" && r.chemin === "/repository") {
      if (etat.sansDepot) return rep(404, { error: "not_found" });
      const c = caches();
      return rep(200, { articles: depotComplet.map((a) => ({ ...a, replaced: c.has(String(a.slug)) })), sampleJobs: exemples });
    }
    if (r.methode === "POST" && r.chemin === "/resync") {
      if (etat.sansDepot) return rep(404, { error: "not_found" });
      etat.rechargements += 1;
      return rep(200, { reloaded: true });
    }
    const m = /^\/(posts|jobs)\/(.+)$/.exec(r.chemin);
    if (!m) return rep(404, { error: "not_found" });
    const store = m[1] === "posts" ? posts : jobs;
    const ext = decodeURIComponent(m[2]!);
    const b = r.corps ? (JSON.parse(r.corps) as Record<string, unknown>) : {};
    if (r.methode === "DELETE") {
      // Un DELETE de contenu REPRIS dit ce qu'il remplaçait : le site le cache (ou retire sa copie)
      // même s'il n'a jamais reçu notre version.
      const existant = store.get(ext);
      const fichier = typeof existant?.replacesFile === "string" ? existant.replacesFile : typeof b.replacesFile === "string" ? b.replacesFile : null;
      if (m[1] === "posts" && fichier) tombes.add(fichier);
      const saisie = m[1] === "jobs" && typeof b.replacesJob === "string" ? retirerSaisie(b.replacesJob) : false;
      if (!store.has(ext) && !fichier && !saisie) return rep(404, { error: "not_found" });
      store.delete(ext);
      return rep(200, { ok: true, deleted: true });
    }
    if (m[1] === "jobs" && typeof b.replacesJob === "string") retirerSaisie(b.replacesJob);
    const slug = typeof b.slug === "string" ? b.slug : slugSuggere(String(b.title ?? ""));
    const url = m[1] === "posts" ? `/blog/${slug}` : `/carrieres/${slug}`;
    const cree = !store.has(ext);
    // Comme le site : le marqueur d'une offre reprise n'est pas conservé, celui d'un article oui.
    const { replacesJob: _sansMarqueur, ...garde } = b;
    void _sansMarqueur;
    store.set(ext, { ...(m[1] === "jobs" ? garde : b), externalId: ext, slug, url });
    return rep(cree ? 201 : 200, { ok: true, created: cree, [m[1] === "posts" ? "post" : "job"]: store.get(ext) });
  });
  return { ...s, posts, jobs, manuels, depot, depotComplet, exemples, offresSaisies, tombes, etat };
}

/**
 * LE SITE, AU NIVEAU DU RÉSEAU (§118.159) — pour les cas où ce qui compte est l'EN-TÊTE : quelle clé
 * l'ERP présente, et avec quel secret il signe. Il tient ce que `lib/api-auth.ts` du site tient,
 * relu pour l'écrire : 503 tant qu'il n'a aucune clé, 401 sur une autre clé, et dès qu'il a un
 * secret, 401 « Invalid body signature » sur TOUTE requête mal signée — corps vide compris. Il
 * répond à une adresse de la MACHINE : le vrai transport y va sans que rien sorte du processus.
 */
const SITE_LOCAL = "http://127.0.0.1:39123";
function siteReseau(etat: { cle: string | null; secret: string | null }) {
  const posts = new Map<string, Record<string, unknown>>();
  const vus: { methode: string; chemin: string; cle: string; signe: boolean }[] = [];
  const json = (statut: number, corps: unknown) =>
    new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json" } });
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== SITE_LOCAL) return VRAI_FETCH(url as never, init);
    const h = new Headers(init?.headers);
    const methode = init?.method ?? "GET";
    const chemin = u.pathname.replace(/^\/api\/v1/, "");
    const presentee = /^Bearer (.+)$/.exec(h.get("authorization") ?? "")?.[1] ?? "";
    const corps = typeof init?.body === "string" ? init.body : "";
    vus.push({ methode, chemin, cle: presentee, signe: h.has("x-adventum-signature") });
    if (chemin === "/health" && !presentee) return json(200, { status: "ok", configured: Boolean(etat.cle), authenticated: false });
    if (!etat.cle) return json(503, { status: "error", error: "Content API disabled: ERP_API_KEY is not set on the website environment." });
    if (presentee !== etat.cle) return json(401, { status: "error", error: "Invalid or missing bearer token." });
    if (etat.secret && (h.get("x-adventum-signature") ?? "") !== signer(corps, etat.secret)) {
      return json(401, { status: "error", error: "Invalid body signature." });
    }
    if (chemin === "/health") return json(200, { status: "ok", configured: true, authenticated: true, capabilities: ["jobs", "posts"] });
    if (methode === "GET" && chemin === "/posts") return json(200, { count: posts.size, posts: [...posts.values()], readOnlyFileArticles: [] });
    if (methode === "GET" && chemin === "/jobs") return json(200, { count: 0, jobs: [] });
    const m = /^\/posts\/(.+)$/.exec(chemin);
    if (m && methode === "PUT") {
      const b = JSON.parse(corps) as Record<string, unknown>;
      const ext = decodeURIComponent(m[1]!);
      const cree = !posts.has(ext);
      const slug = slugSuggere(String(b.title ?? ""));
      posts.set(ext, { ...b, externalId: ext, slug, url: `/blog/${slug}` });
      return json(cree ? 201 : 200, { ok: true, created: cree, post: posts.get(ext) });
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch;
  return { fn, vus, posts, etat };
}

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const pub = (nature: "JOB" | "POST", externalId: string) =>
  prisma.sitePublication.findUniqueOrThrow({ where: { kind_externalId: { kind: nature, externalId } } });

const notifs = (userId: string, title: string) => prisma.notification.count({ where: { userId, title } });

suite("Site Adventum — file, disjoncteur, recrutement, réconciliation", () => {
  const ids: Record<string, string> = {};

  async function viderLesContenus() {
    await prisma.sitePublication.deleteMany({ where: { label: { startsWith: TAG } } });
    await prisma.siteReprise.deleteMany({ where: { titre: { startsWith: TAG } } });
    await prisma.blogArticle.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.jobPosting.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.recruitmentRequest.deleteMany({ where: { position: { startsWith: TAG } } });
  }

  async function viderLaLiaison() {
    await prisma.siteWebCle.deleteMany({});
    await prisma.appSetting.updateMany({ where: { id: "global" }, data: { siteSante: Prisma.DbNull, siteSanteAt: null, siteBootId: null } });
    const candidatures = await prisma.siteCandidature.findMany({ where: { siteId: { startsWith: `banc${RUN}` } }, select: { id: true, cvCle: true } });
    for (const c of candidatures) if (c.cvCle) await deleteFileByKey(c.cvCle).catch(() => undefined);
    await prisma.siteCandidature.deleteMany({ where: { siteId: { startsWith: `banc${RUN}` } } });
  }

  async function nettoyer() {
    await viderLesContenus();
    await viderLaLiaison();
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    poserEnv();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [dir, sa, fin, pm] = await Promise.all([
      faire("dir", "DIRECTION"), faire("sa", "SUPER_ADMIN"), faire("fin", "FINANCE_BUDGET_MANAGER"), faire("pm", "PRODUCT_MANAGER"),
    ]);
    Object.assign(ids, { dir: dir.id, sa: sa.id, fin: fin.id, pm: pm.id });
  });

  // Les rapprochements que le code lance DE LUI-MÊME (après une liaison, après un redémarrage du
  // site) n'ont pas d'identifiant à noter : on retire aussi tout ce qui a commencé pendant le cas.
  // Seul ce fichier rapproche, et il est séquentiel : rien d'autre ne peut tomber dans la fenêtre.
  let debutDuCas = new Date();
  beforeEach(() => { debutDuCas = new Date(); });

  afterEach(async () => {
    global.fetch = VRAI_FETCH;
    await prisma.siteReconciliation.deleteMany({ where: { OR: [{ id: { in: RAPPROCHEMENTS.splice(0) } }, { startedAt: { gte: debutDuCas } }] } });
    await viderLesContenus();
    await viderLaLiaison();
    await leverBlocage();
    poserEnv();
    ACTOR = null;
  });

  afterAll(async () => {
    await nettoyer();
    await leverBlocage();
    for (const [k, v] of [
      ["ADVENTUM_BASE_URL", ENV_AVANT.base], ["ADVENTUM_API_KEY", ENV_AVANT.cle],
      ["ADVENTUM_WEBHOOK_SECRET", ENV_AVANT.secret], ["SITE_WEB_RECONCILIATION", ENV_AVANT.reco],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const publier = async (titre: string, champs: Record<string, string> = {}) => {
    ACTOR = await actorFor(ids.dir!);
    const r = await enregistrerArticle(form({ intention: "publier", title: `${TAG}${titre}`, body: "Introduction.\n\n## Contexte\n\nTexte.", ...champs }));
    expect(r.ok, r.error).toBe(true);
    return r.id!;
  };

  // ───────────────────────────── Prémisses ─────────────────────────────

  it("PRÉMISSES : la Direction écrit les articles et publie les offres ; la Direction Marketing n'a pas les RH ; les Finances n'ont pas le site", async () => {
    const [dir, pm, fin] = await Promise.all([actorFor(ids.dir!), actorFor(ids.pm!), actorFor(ids.fin!)]);
    expect(userCan(dir, "SITE_WEB", "CREATE")).toBe(true);
    expect(userCan(dir, "RH", "UPDATE") || isTopManagement(dir)).toBe(true);
    expect(userCan(pm, "SITE_WEB", "CREATE")).toBe(true);
    expect(userCan(pm, "RH", "UPDATE"), "sans quoi le refus des offres ne prouverait rien").toBe(false);
    expect(isTopManagement(pm)).toBe(false);
    expect(userCan(fin, "SITE_WEB", "VIEW")).toBe(false);
  });

  // ───────────────────────────── La file ─────────────────────────────

  it("un brouillon jamais publié ne part pas : le site n'a pas à le connaître", async () => {
    ACTOR = await actorFor(ids.dir!);
    const r = await enregistrerArticle(form({ intention: "brouillon", title: `${TAG}brouillon`, body: "## A\n\nB" }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Brouillon/);
    expect(await prisma.sitePublication.count({ where: { kind: "POST", externalId: r.id! } })).toBe(0);
  });

  it("publier : un PUT sur l'externalId, puis « En ligne » avec l'adresse que le SITE a rendue ; rejouer ne crée rien", async () => {
    const id = await publier("Tracabilite", { description: "Une description.", tags: "qualité, Qualité, lots", category: "Qualité" });
    const avant = await pub("POST", id);
    expect(avant).toMatchObject({ state: "PENDING", operation: "PUT", version: 1, attempts: 0 });
    const corps = JSON.parse(avant.body!) as Record<string, unknown>;
    expect(Object.keys(corps)).toEqual(["title", "body", "description", "category", "tags", "author", "date", "featured", "published"]);
    expect(corps).toMatchObject({ published: true, category: "Qualité", author: "Adventum Pharma", tags: ["qualité", "lots"] });

    const site = fauxSite();
    const b = await viderFile({ transport: site.fn, seulement: [avant.id], maintenant: plus(1_000) });
    expect(b).toMatchObject({ envoyes: 1, reussis: 1 });
    expect(site.appels).toEqual([{ methode: "PUT", chemin: `/posts/${id}`, corps: avant.body }]);
    const apres = await pub("POST", id);
    expect(apres).toMatchObject({ state: "DONE", attempts: 1, lastStatus: 201, confirmedHash: avant.bodyHash, confirmedPublished: true });
    expect(apres.siteUrl).toBe(`/blog/${slugSuggere(`${TAG}Tracabilite`)}`);
    const journal = await prisma.sitePushAttempt.findMany({ where: { publicationId: avant.id } });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ status: 201, outcome: "SUCCES", version: 1, method: "PUT" });

    // Rejouer le même contenu : rien ne repart, la version ne bouge pas.
    const s2 = await synchroniserArticle(id, ids.dir!);
    expect(s2).toMatchObject({ etat: "INCHANGE", message: "Le site détient déjà cette version." });
    expect((await pub("POST", id)).version).toBe(1);
    expect((await viderFile({ transport: site.fn, seulement: [avant.id], maintenant: plus(5_000) })).envoyes).toBe(0);
  });

  it(`503 : réessais à ${DELAIS_REESSAI_MS.map((d) => d / 1000).join(", ")} s, puis ÉCHEC dit une seule fois, au demandeur ; « Relancer » le remet en file`, async () => {
    const id = await publier("Reessais");
    const ligne = await pub("POST", id);
    const t = script(() => rep(503, { error: "storage not writable" }));
    let m = plus(1_000);
    for (let i = 0; i < ESSAIS_MAX; i += 1) {
      const b = await viderFile({ transport: t.fn, seulement: [ligne.id], maintenant: m });
      expect(b.envoyes, `essai ${i + 1}`).toBe(1);
      const l = await pub("POST", id);
      if (i < ESSAIS_MAX - 1) {
        expect(l).toMatchObject({ state: "PENDING", attempts: i + 1, lastStatus: 503, lastError: "storage not writable" });
        expect(l.nextAttemptAt.getTime() - m.getTime()).toBe(DELAIS_REESSAI_MS[i]);
        if (i === 0) {
          // AVANT l'échéance, rien ne part : l'attente est tenue par la base, pas par la chance.
          expect((await viderFile({ transport: t.fn, seulement: [ligne.id], maintenant: m })).envoyes).toBe(0);
        }
        m = l.nextAttemptAt;
      } else {
        expect(l).toMatchObject({ state: "FAILED", attempts: ESSAIS_MAX });
        expect(l.alertedAt).not.toBeNull();
      }
    }
    expect(t.appels).toHaveLength(ESSAIS_MAX);
    expect((await viderFile({ transport: t.fn, seulement: [ligne.id], maintenant: plus(3_600_000) })).envoyes).toBe(0);
    expect(await notifs(ids.dir!, "Site web : envoi impossible")).toBe(1);

    ACTOR = await actorFor(ids.dir!);
    const r = await relancerEnvoiSite(form({ publicationId: ligne.id }));
    expect(r.ok, r.error).toBe(true);
    expect(await pub("POST", id)).toMatchObject({ state: "PENDING", attempts: 0, alertedAt: null });
  });

  it("réseau : une panne (aucune réponse) ou une exception du transport se réessaient, la cause est gardée", async () => {
    const id = await publier("Reseau");
    const ligne = await pub("POST", id);
    await viderFile({ transport: script(() => rep(null)).fn, seulement: [ligne.id], maintenant: plus(1_000) });
    expect(await pub("POST", id)).toMatchObject({ state: "PENDING", attempts: 1, lastStatus: null, lastError: "site injoignable : ECONNRESET" });
    const l1 = await pub("POST", id);
    await viderFile({ transport: async () => { throw new Error("socket hang up"); }, seulement: [ligne.id], maintenant: l1.nextAttemptAt });
    expect(await pub("POST", id)).toMatchObject({ state: "PENDING", attempts: 2, lastError: "socket hang up" });
  });

  it("429 : Retry-After est honoré — et plafonné à une heure", async () => {
    const id = await publier("Quota");
    const ligne = await pub("POST", id);
    const m = plus(1_000);
    await viderFile({ transport: script(() => rep(429, { error: "rate_limited" }, { retryAfterS: 120 })).fn, seulement: [ligne.id], maintenant: m });
    const l = await pub("POST", id);
    expect(l.nextAttemptAt.getTime() - m.getTime()).toBe(120_000);
    await viderFile({ transport: script(() => rep(429, null, { retryAfterS: 999_999 })).fn, seulement: [ligne.id], maintenant: l.nextAttemptAt });
    const l2 = await pub("POST", id);
    expect(l2.nextAttemptAt.getTime() - l.nextAttemptAt.getTime()).toBe(3_600_000);
  });

  it("4xx : refusé à la PREMIÈRE réponse, jamais réessayé, jamais renvoyé tel quel ; corrigé, il repart", async () => {
    const id = await publier("Refuse");
    const ligne = await pub("POST", id);
    const t = script(() => rep(422, { error: "title: too long" }));
    const b = await viderFile({ transport: t.fn, seulement: [ligne.id], maintenant: plus(1_000) });
    expect(b.refuses).toBe(1);
    expect(await pub("POST", id)).toMatchObject({ state: "FAILED", attempts: 1, lastStatus: 422, lastError: "title: too long" });
    expect(await notifs(ids.dir!, "Site web : contenu refusé")).toBe(1);
    expect((await viderFile({ transport: t.fn, seulement: [ligne.id], maintenant: plus(3_600_000) })).envoyes).toBe(0);

    const s = await synchroniserArticle(id, ids.dir!);
    expect(s.etat).toBe("INCHANGE");
    expect(s.message).toMatch(/refusé ce contenu tel quel/);

    ACTOR = await actorFor(ids.dir!);
    const r = await enregistrerArticle(form({ id, intention: "enregistrer", title: `${TAG}Refuse corrigé`, body: "Introduction.\n\n## Contexte\n\nTexte." }));
    expect(r.ok, r.error).toBe(true);
    expect(await pub("POST", id)).toMatchObject({ state: "PENDING", version: 2, attempts: 0, alertedAt: null });
  });

  it("401 : le DISJONCTEUR — un seul appel, aucune tentative consommée, une alerte aux Super Admins ; une clé changée le lève", async () => {
    const [a, b] = [await publier("Cle un"), await publier("Cle deux")];
    const [la, lb] = [await pub("POST", a), await pub("POST", b)];
    const t = script(() => rep(401, { error: "unauthorized" }));
    const avantAlertes = await notifs(ids.sa!, "Site web : publication suspendue");

    const b1 = await viderFile({ transport: t.fn, seulement: [la.id, lb.id], maintenant: plus(1_000) });
    expect(b1.bloque).toBe(true);
    expect(t.appels).toHaveLength(1);
    const touchee = t.appels[0]!.chemin.endsWith(a) ? a : b;
    expect(await pub("POST", touchee)).toMatchObject({ state: "PENDING", attempts: 0, lastStatus: 401 });
    const blocage = await lireBlocage();
    const conf = lireConfiguration();
    expect(conf.ok).toBe(true);
    expect(blocage?.empreinte).toBe(conf.ok ? conf.config.empreinte : "");
    expect(blocage?.motif).toMatch(/Générez une nouvelle clé/);
    expect(await notifs(ids.sa!, "Site web : publication suspendue")).toBe(avantAlertes + 1);

    // Bloqué : plus AUCUN appel, et pas une seconde alerte pour le même incident.
    const b2 = await viderFile({ transport: t.fn, seulement: [la.id, lb.id], maintenant: plus(120_000) });
    expect(b2.bloque).toBe(true);
    expect(t.appels).toHaveLength(1);
    expect(await notifs(ids.sa!, "Site web : publication suspendue")).toBe(avantAlertes + 1);

    // L'écran dit « Suspendu », jamais « Nouvel essai prévu ».
    const vue = (await publicationsDe("POST", [a])).get(a)!;
    expect(etatAffiche(vue, true, "BLOQUE").libelle).toBe("Suspendu");
    const integ = await etatIntegration();
    expect(integ.suspendu).toBe("BLOQUE");

    // LA CLÉ N'EST ÉCRITE NULLE PART — ni au journal, ni dans le motif, ni dans ce que l'écran lit.
    expect(JSON.stringify(integ)).not.toContain(CLE);
    expect(blocage?.motif).not.toContain(CLE);
    expect(await prisma.sitePushAttempt.count({ where: { OR: [{ responseBody: { contains: CLE } }, { error: { contains: CLE } }] } })).toBe(0);
    expect(await prisma.sitePublication.count({ where: { OR: [{ body: { contains: CLE } }, { lastError: { contains: CLE } }] } })).toBe(0);

    // La réparation : une nouvelle clé change l'empreinte, et le blocage tombe de lui-même.
    process.env.ADVENTUM_API_KEY = `${CLE}-nouvelle`;
    const site = fauxSite();
    const b3 = await viderFile({ transport: site.fn, seulement: [la.id, lb.id], maintenant: plus(240_000) });
    expect(b3).toMatchObject({ bloque: false, reussis: 2 });
    expect(await lireBlocage()).toBeNull();
  });

  it("une redirection est une ADRESSE fausse : elle bloque aussi, nomme sa cible ; seul le Super Admin lève à la main", async () => {
    const id = await publier("Redirection");
    const t = script(() => rep(301, null, { location: "https://www.adventumdz.com/api/v1/posts/x" }));
    const b = await viderFile({ transport: t.fn, seulement: [(await pub("POST", id)).id], maintenant: plus(1_000) });
    expect(b.bloque).toBe(true);
    const bl = await lireBlocage();
    expect(bl?.motif).toMatch(/ADVENTUM_BASE_URL/);
    expect(bl?.motif).toContain("https://www.adventumdz.com/api/v1/posts/x");

    ACTOR = await actorFor(ids.dir!);
    expect((await leverBlocageSite()).ok).toBe(false);
    expect(await lireBlocage()).not.toBeNull();
    ACTOR = await actorFor(ids.sa!);
    expect((await leverBlocageSite()).ok).toBe(true);
    expect(await lireBlocage()).toBeNull();
  });

  it("LA LIAISON EST AU SUPER ADMIN SEUL (§118.160) : la Direction, qui PUBLIE, se voit refuser les cinq gestes — et le refus nomme l'écran où ils vivent", async () => {
    const dir = await actorFor(ids.dir!);
    // PRÉMISSE : la Direction tient le module et publie — le refus ne peut venir que de la règle de la liaison.
    expect(peutEcrireArticles(dir)).toBe(true);
    expect(peutGererLaLiaison(dir)).toBe(false);
    expect(peutGererLaLiaison(await actorFor(ids.sa!))).toBe(true);
    ACTOR = dir;
    const gestes = { verifierConnexionSite, rapprocherSiteMaintenant, leverBlocageSite, genererCleSite, abandonnerCleSite };
    for (const [nom, geste] of Object.entries(gestes)) {
      const r = await geste();
      expect(r.ok, `${nom} accepté pour la Direction`).toBe(false);
      expect(r.error, nom).toBe(REFUS_LIAISON);
      expect(r.error).toContain(ECRAN_LIAISON.nom);
    }
    // Rien n'a bougé : aucune clé générée, aucun rapprochement lancé.
    expect(await prisma.siteWebCle.count()).toBe(0);
    expect(await prisma.siteReconciliation.count({ where: { startedAt: { gte: debutDuCas } } })).toBe(0);
  });

  it("course : un envoi réussi ne confirme QUE la version qu'il portait — la correction faite pendant le vol repart", async () => {
    const id = await publier("Course");
    const v1 = await pub("POST", id);
    let corrige = false;
    const t = script(async () => {
      if (!corrige) {
        corrige = true;
        // Pendant le vol, l'auteur corrige et enregistre : une version 2 entre en file.
        await prisma.blogArticle.update({ where: { id }, data: { title: `${TAG}Course corrigée` } });
        await synchroniserArticle(id, ids.dir!);
      }
      return rep(200, { ok: true, post: { url: "/blog/course" } });
    });
    // UN envoi, pour observer l'entre-deux : sans borne, la même boucle reprend aussitôt la version 2
    // (elle est due) — c'est la bonne conduite, mais elle masquerait ce qu'on veut voir.
    await viderFile({ transport: t.fn, seulement: [v1.id], maintenant: plus(1_000), limite: 1 });
    expect(t.appels).toHaveLength(1);
    const apres = await pub("POST", id);
    expect(apres.version).toBe(2);
    expect(apres.state, "la version 2 n'a jamais été envoyée : elle ne peut pas être « en ligne »").toBe("PENDING");
    expect(apres.confirmedHash).toBe(v1.bodyHash);
    expect(apres.claimedAt).toBeNull();
    await viderFile({ transport: t.fn, seulement: [v1.id], maintenant: plus(2_000) });
    const fin = await pub("POST", id);
    expect(fin).toMatchObject({ state: "DONE", version: 2, confirmedHash: fin.bodyHash });
    expect(JSON.parse(t.appels[1]!.corps!).title).toBe(`${TAG}Course corrigée`);
  });

  // ───────────────────────────── Concurrence : une seule alerte ─────────────────────────────

  /**
   * UN SITE QUI RETIENT SA PREMIÈRE RÉPONSE. Le premier appel attend qu'on ouvre le portillon ; les
   * suivants — il n'y en a que si une garde est tombée — répondent tout de suite. Retenir TOUS les
   * appels bloquerait le banc précisément dans le cas qu'il existe pour attraper.
   */
  function siteRetenu(reponse: () => ReponseSite) {
    const appels: RequeteSite[] = [];
    let ouvrir!: () => void;
    const ouvert = new Promise<void>((r) => { ouvrir = r; });
    let signaler!: () => void;
    const premierAppel = new Promise<void>((r) => { signaler = r; });
    const fn: TransportSite = async (r) => {
      appels.push(r);
      if (appels.length === 1) { signaler(); await ouvert; }
      return reponse();
    };
    return { fn, appels, ouvrir, premierAppel };
  }

  it("CONCURRENCE — huit passages lancés ENSEMBLE sur un envoi refusé : la PRISE n'en laisse partir qu'un, et l'échec ne se dit qu'une fois", async () => {
    const id = await publier("Concurrence prise");
    const ligne = await pub("POST", id);
    const titre = "Site web : contenu refusé";
    const avant = await notifs(ids.dir!, titre);
    const site = siteRetenu(() => rep(422, { error: "title: too long" }));
    const m = plus(1_000);
    let rendus = 0;
    const passages = Array.from({ length: 8 }, () =>
      viderFile({ transport: site.fn, seulement: [ligne.id], maintenant: m }).then((b) => { rendus += 1; return b; }));
    await site.premierAppel;
    // Les sept autres tentent leur prise PENDANT que la ligne est tenue ; c'est seulement quand ils
    // ont TOUS rendu la main que le site répond au premier. Sans cette attente, le banc pourrait
    // passer parce que les passages se seraient simplement succédé.
    await vi.waitFor(() => expect(rendus).toBe(7), { timeout: 15_000, interval: 20 });
    site.ouvrir();
    const bilans = await Promise.all(passages);
    expect(site.appels, "une version, un envoi").toHaveLength(1);
    expect(bilans.filter((b) => b.envoyes === 1)).toHaveLength(1);
    expect(bilans.filter((b) => b.envoyes === 0)).toHaveLength(7);
    expect(await notifs(ids.dir!, titre)).toBe(avant + 1);
    expect(await pub("POST", id)).toMatchObject({ state: "FAILED", attempts: 1, lastStatus: 422, claimedAt: null });
    expect(await prisma.sitePushAttempt.count({ where: { publicationId: ligne.id } })).toBe(1);
  });

  it("CONCURRENCE — un passage bloqué au-delà du verrou : la ligne est REPRISE, l'échec est dit une fois, et le retardataire se tait", async () => {
    // Le cas que la prise ne couvre pas : pour le second passage, un verrou de plus de
    // VERROU_PERIME_MS est celui d'un processus mort. S'il ne l'est pas, les deux finissent par
    // échouer sur la MÊME version — et c'est la précondition `alertedAt: null` d'`echouer`, seule,
    // qui empêche deux alertes pour un seul incident.
    const id = await publier("Concurrence verrou perime");
    const ligne = await pub("POST", id);
    const titre = "Site web : contenu refusé";
    const avant = await notifs(ids.dir!, titre);
    const lent = siteRetenu(() => rep(422, { error: "title: too long" }));
    const m0 = plus(1_000);
    const passageA = viderFile({ transport: lent.fn, seulement: [ligne.id], maintenant: m0 });
    await lent.premierAppel;
    expect((await pub("POST", id)).claimedAt?.getTime(), "A tient la ligne").toBe(m0.getTime());

    const vif = script(() => rep(422, { error: "title: too long" }));
    const bB = await viderFile({ transport: vif.fn, seulement: [ligne.id], maintenant: new Date(m0.getTime() + VERROU_PERIME_MS + 1_000) });
    expect(bB, "B reprend une ligne dont le verrou est périmé").toMatchObject({ envoyes: 1, refuses: 1 });
    expect(await notifs(ids.dir!, titre)).toBe(avant + 1);

    lent.ouvrir();
    const bA = await passageA;
    expect(bA).toMatchObject({ envoyes: 1, refuses: 1 });
    expect(lent.appels).toHaveLength(1);
    expect(vif.appels).toHaveLength(1);
    expect(await notifs(ids.dir!, titre), "le retardataire ne redit pas un échec déjà dit").toBe(avant + 1);
    const fin = await pub("POST", id);
    expect(fin).toMatchObject({ state: "FAILED", claimedAt: null, lastStatus: 422 });
    expect(fin.alertedAt).not.toBeNull();
  });

  it("SORTIE INTERDITE : le transport de production est bloqué AVANT le réseau — rien n'est parti, aucune tentative consommée", async () => {
    const id = await publier("Sortie");
    const ligne = await pub("POST", id);
    const espion = vi.spyOn(global, "fetch");
    const m = plus(1_000);
    const b = await viderFile({ seulement: [ligne.id], maintenant: m });
    expect(b.sortieInterdite).toBe(true);
    expect(b.envoyes).toBe(0);
    expect(espion).not.toHaveBeenCalled();
    espion.mockRestore();
    const l = await pub("POST", id);
    expect(l).toMatchObject({ state: "PENDING", attempts: 0 });
    expect(l.nextAttemptAt.getTime() - m.getTime()).toBe(10 * 60_000);
    expect(l.lastError).toMatch(/Sortie interdite/);
    const j = await prisma.sitePushAttempt.findFirst({ where: { publicationId: ligne.id }, orderBy: { createdAt: "desc" } });
    expect(j?.outcome).toBe("LOCAL");

    // L'action « Vérifier la connexion » passe par le même transport : elle le DIT. (Jouée par le
    // Super Admin : c'est son geste depuis §118.160 — la Direction serait refusée AVANT le transport,
    // et le cas ne mesurerait plus la garde de sortie.)
    ACTOR = await actorFor(ids.sa!);
    const v = await verifierConnexionSite();
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Sortie interdite/);
  });

  it("non configurée : rien ne part, et la file le dit au lieu de réessayer", async () => {
    const id = await publier("Sans configuration");
    delete process.env.ADVENTUM_API_KEY;
    const t = script(() => rep(200, {}));
    const b = await viderFile({ transport: t.fn, seulement: [(await pub("POST", id)).id], maintenant: plus(1_000) });
    expect(b.nonConfigure).toBe(true);
    expect(t.appels).toHaveLength(0);
    expect(await pub("POST", id)).toMatchObject({ state: "PENDING", attempts: 0 });
  });

  it("supprimer : le DELETE est mis en file avant la ligne, et un 404 vaut « déjà absent » ; jamais envoyé, rien à supprimer", async () => {
    const site = fauxSite();
    const id = await publier("A supprimer");
    await viderFile({ transport: site.fn, seulement: [(await pub("POST", id)).id], maintenant: plus(1_000) });
    expect(site.posts.has(id)).toBe(true);
    site.posts.delete(id); // le site l'a déjà perdu : le DELETE rendra 404

    ACTOR = await actorFor(ids.dir!);
    const r = await supprimerArticle(form({ id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/retirée du site/);
    expect(await prisma.blogArticle.count({ where: { id } })).toBe(0);
    const del = await pub("POST", id);
    expect(del).toMatchObject({ operation: "DELETE", state: "PENDING", version: 2 });
    await viderFile({ transport: site.fn, seulement: [del.id], maintenant: plus(2_000) });
    expect(await pub("POST", id)).toMatchObject({ operation: "DELETE", state: "DONE", lastStatus: 404 });

    const r2 = await enregistrerArticle(form({ intention: "brouillon", title: `${TAG}jamais parti`, body: "## A\n\nB" }));
    const r3 = await supprimerArticle(form({ id: r2.id! }));
    expect(r3.message).toMatch(/n'était pas sur le site/);
    expect(await prisma.sitePublication.count({ where: { kind: "POST", externalId: r2.id! } })).toBe(0);
  });

  // ───────────────────────────── Les droits et les refus ─────────────────────────────

  it("les refus : un titre `#` est refusé AVANT écriture, en nommant la ligne ; les Finances n'écrivent pas d'article ; la Direction Marketing ne publie pas d'offre", async () => {
    ACTOR = await actorFor(ids.dir!);
    const h1 = await enregistrerArticle(form({ intention: "publier", title: `${TAG}H1`, body: "Introduction\n# Grand titre\n\nTexte" }));
    expect(h1.ok).toBe(false);
    expect(h1.error).toMatch(/ligne 2/);
    expect(await prisma.blogArticle.count({ where: { title: `${TAG}H1` } })).toBe(0);

    ACTOR = await actorFor(ids.fin!);
    const a = await enregistrerArticle(form({ intention: "brouillon", title: `${TAG}Finances`, body: "## A" }));
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/Site web/);

    ACTOR = await actorFor(ids.pm!);
    const o = await enregistrerOffre(form({ intention: "brouillon", title: `${TAG}Offre PM` }));
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/RH/);
    expect(await prisma.jobPosting.count({ where: { title: `${TAG}Offre PM` } })).toBe(0);
  });

  // ───────────────────────────── Les offres suivent le recrutement ─────────────────────────────

  it("offre : ni salaire ni justification ; un poste fermé part INVISIBLE ; ouvrir puis clore le poste la fait suivre, par les vraies actions", async () => {
    const req = await prisma.recruitmentRequest.create({
      data: {
        reference: `${TAG}REC-1`, requesterId: ids.dir!, position: `${TAG}Délégué médical Oncologie`, contractType: "CDI",
        salaryMin: 123_456, salaryMax: 234_567, justification: `${TAG}justification confidentielle`,
        missions: "- Animer le réseau de prescripteurs\n- Préparer les congrès", skills: "Formation en pharmacie", stage: "HR_REVIEW",
      },
    });
    ACTOR = await actorFor(ids.dir!);
    const r = await enregistrerOffre(form({
      intention: "publier", recruitmentRequestId: req.id, title: req.position, department: "Promotion médicale", location: "Alger",
      contractLabel: "CDI", mission: "Animer le réseau de prescripteurs\nPréparer les congrès", profile: "Formation en pharmacie",
    }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/n'est pas ouvert/);
    const v1 = await pub("JOB", r.id!);
    const corps = JSON.parse(v1.body!) as Record<string, unknown>;
    expect(Object.keys(corps)).toEqual(["title", "department", "location", "type", "experience", "summary", "mission", "profile", "offer", "published"]);
    expect(corps.published, "coché publié, mais le poste n'est pas ouvert").toBe(false);
    expect(v1.body).not.toMatch(/123456|123 456|234567|confidentielle/);

    // Une demande porte UNE offre.
    const double = await enregistrerOffre(form({ intention: "brouillon", recruitmentRequestId: req.id, title: `${TAG}doublon` }));
    expect(double.ok).toBe(false);
    expect(double.error).toMatch(/déjà son offre/);

    expect((await openRecruitmentSourcing(form({ id: req.id }))).ok).toBe(true);
    const v2 = await pub("JOB", r.id!);
    expect(v2.version).toBe(2);
    expect(JSON.parse(v2.body!).published).toBe(true);

    expect((await closeRecruitmentRequest(form({ id: req.id, note: "Poste pourvu" }))).ok).toBe(true);
    const v3 = await pub("JOB", r.id!);
    expect(v3.version).toBe(3);
    expect(JSON.parse(v3.body!).published, "pourvu : l'offre repasse en brouillon côté site, tout de suite").toBe(false);
  });

  // ───────────────────────────── La réconciliation ─────────────────────────────

  it("rapprocher : repousse ce que le site a perdu ou altéré, rejoue une suppression, confirme le conforme — et NOMME sans supprimer ce qu'il ne connaît pas", async () => {
    const site = fauxSite();
    const envoyer = async (id: string) => viderFile({ transport: site.fn, seulement: [(await pub("POST", id)).id], maintenant: plus(1_000) });

    const conforme = await publier("Conforme"); await envoyer(conforme);
    const perdu = await publier("Perdu"); await envoyer(perdu);
    const altere = await publier("Altere"); await envoyer(altere);
    const supprime = await publier("Supprime"); await envoyer(supprime);
    const masque = await publier("Masque", { slug: "slug-du-depot" }); await envoyer(masque);
    const refuse = await publier("Refuse"); // jamais accepté par le site
    await viderFile({ transport: script(() => rep(422, { error: "body: invalid" })).fn, seulement: [(await pub("POST", refuse)).id], maintenant: plus(1_000) });
    // Délai dépassé alors que le site AVAIT écrit : la file le croit perdu, le site le détient.
    const fantome = await publier("Fantome");
    const lf = await pub("POST", fantome);
    await prisma.sitePublication.update({ where: { id: lf.id }, data: { attempts: 2, lastError: "délai dépassé (10000 ms)", nextAttemptAt: plus(3_600_000) } });
    site.posts.set(fantome, { ...JSON.parse(lf.body!), externalId: fantome, slug: "fantome", url: "/blog/fantome" });
    // Un contenu CONNU mais que le contrat refuse aujourd'hui (écrit hors des actions) : ni repoussé, ni orphelin.
    const hors = await prisma.blogArticle.create({ data: { title: `${TAG}Hors contrat`, body: "# Titre interdit\n\nTexte", published: true } });
    await prisma.sitePublication.create({ data: { kind: "POST", externalId: hors.id, label: `${TAG}Hors contrat`, operation: "PUT", state: "DONE" } });
    site.posts.set(hors.id, { externalId: hors.id, title: `${TAG}Hors contrat`, url: "/blog/hors" });

    // Ce que le site a fait de son côté.
    site.posts.delete(perdu);                                                   // redéployé sans disque
    site.posts.set(altere, { ...site.posts.get(altere)!, title: "Titre modifié dans l'admin" });
    ACTOR = await actorFor(ids.dir!);
    expect((await supprimerArticle(form({ id: supprime }))).ok).toBe(true);    // le DELETE n'est pas encore parti
    site.posts.set(ORPHELIN, { externalId: ORPHELIN, title: "Test de mise en service", url: "/blog/test" });
    site.manuels.push({ title: "Saisi dans l'admin du site", url: "/blog/admin" });
    site.depot.push({ slug: "slug-du-depot", title: "Article du dépôt", url: "/blog/slug-du-depot" });

    const alertes0 = await notifs(ids.sa!, "Site web : rapprochement à regarder");
    site.appels.length = 0;
    const bilan = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.dir!, maintenant: plus(10_000), transport: site.fn }));
    expect(bilan.ok, bilan.message).toBe(true);

    // Repoussés, et REPARTIS par la file : le site les détient de nouveau, à l'identique.
    expect(site.posts.has(perdu)).toBe(true);
    expect(site.posts.get(altere)!.title).toBe(`${TAG}Altere`);
    // La suppression rejouée.
    expect(site.posts.has(supprime)).toBe(false);
    // L'orphelin N'EST PAS supprimé — et aucune requête ne l'a visé.
    expect(site.posts.has(ORPHELIN)).toBe(true);
    expect(site.appels.some((a) => a.chemin.includes(ORPHELIN))).toBe(false);
    // Le refusé tel quel n'est pas repoussé.
    expect(site.appels.some((a) => a.chemin === `/posts/${refuse}`)).toBe(false);
    expect(await pub("POST", refuse)).toMatchObject({ state: "FAILED", version: 1 });
    // Le fantôme est CONFIRMÉ, sans renvoi.
    expect(await pub("POST", fantome)).toMatchObject({ state: "DONE", lastError: null });
    expect(site.appels.some((a) => a.chemin === `/posts/${fantome}`)).toBe(false);

    const ligne = await prisma.siteReconciliation.findUniqueOrThrow({ where: { id: bilan.id! } });
    expect(ligne.ok).toBe(true);
    const orphelins = ligne.orphelins as { externalId: string }[];
    // Le faux site ne détient que les contenus de ce banc : l'orphelin est le SEUL inconnu.
    expect(orphelins.map((o) => o.externalId)).toEqual([ORPHELIN]);
    expect(orphelins.some((o) => o.externalId === hors.id), "un contenu CONNU n'est jamais « inconnu de l'ERP »").toBe(false);
    const collisions = ligne.collisions as { externalId: string; slug: string }[];
    expect(collisions).toContainEqual(expect.objectContaining({ externalId: masque, slug: "slug-du-depot" }));
    const ecarts = ligne.ecarts as { externalId: string; raison: string }[];
    expect(ecarts.find((e) => e.externalId === perdu)?.raison).toBe("absent du site");
    expect(ecarts.find((e) => e.externalId === altere)?.raison).toBe("écart sur title");
    expect(ecarts.find((e) => e.externalId === refuse)?.raison).toMatch(/refusé ce contenu tel quel/);
    expect(ecarts.find((e) => e.externalId === hors.id)?.raison).toMatch(/non envoyé/);
    expect(ligne.repousses).toBeGreaterThanOrEqual(2);
    expect(ligne.suppressions).toBeGreaterThanOrEqual(1);
    expect(ligne.rejetes).toBeGreaterThanOrEqual(2);
    expect((ligne.manuels as { posts: number }).posts).toBeGreaterThanOrEqual(1);
    expect(ligne.depotSlugs).toContain("slug-du-depot");
    expect(await notifs(ids.sa!, "Site web : rapprochement à regarder")).toBe(alertes0 + 1);

    // Un second passage : tout est conforme, rien ne repart, et PAS de seconde alerte pour les mêmes.
    site.appels.length = 0;
    const second = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.dir!, maintenant: plus(20_000), transport: site.fn }));
    expect(second.ok).toBe(true);
    expect(site.appels.filter((a) => a.methode !== "GET")).toEqual([]);
    expect(await notifs(ids.sa!, "Site web : rapprochement à regarder")).toBe(alertes0 + 1);

  });

  it("rapprocher : « déjà signalé » veut dire signalé AVANT — un passage daté plus tard n'est pas le précédent", async () => {
    // LE CAS QUI FAIT TOMBER LA BORNE `startedAt < début` : un passage réussi daté du surlendemain
    // (une instance dont l'horloge avance, un banc qui joue le lendemain) et SANS orphelin. Pris
    // pour « le précédent », il ferait de l'orphelin du jour une nouveauté à CHAQUE passage — la
    // même alerte chaque nuit, le bruit que la déduplication existe pour éviter (§118.32).
    const site = fauxSite();
    const orphelin = `${ORPHELIN}-tard`;
    site.posts.set(orphelin, { externalId: orphelin, title: "Resté sur le site", url: "/blog/reste" });
    const tard = await prisma.siteReconciliation.create({ data: { trigger: "AUTO", startedAt: plus(2 * 86_400_000), ok: true, orphelins: [] } });
    RAPPROCHEMENTS.push(tard.id);
    const titre = "Site web : rapprochement à regarder";
    const a0 = await notifs(ids.sa!, titre);
    expect(noter(await rapprocherSite({ declencheur: "MANUEL", maintenant: plus(1_000), transport: site.fn })).ok).toBe(true);
    expect(await notifs(ids.sa!, titre), "le premier passage signale l'orphelin").toBe(a0 + 1);
    expect(noter(await rapprocherSite({ declencheur: "MANUEL", maintenant: plus(2_000), transport: site.fn })).ok).toBe(true);
    expect(await notifs(ids.sa!, titre), "le second passage l'a déjà vu signalé par le PREMIER").toBe(a0 + 1);
  });

  it("rapprocher : une réponse illisible ou sans liste est un ÉCHEC — jamais « le site n'a rien »", async () => {
    const id = await publier("Illisible");
    const avant = await prisma.sitePublication.findMany({ where: { label: { startsWith: TAG } }, select: { id: true, version: true } });
    const html = noter(await rapprocherSite({ declencheur: "MANUEL", transport: script(() => rep(200, "<html>maintenance</html>")).fn, maintenant: plus(1_000) }));
    expect(html.ok).toBe(false);
    expect(html.message).toMatch(/illisible/);
    const sansListe = noter(await rapprocherSite({ declencheur: "MANUEL", transport: script((r) => rep(200, r.chemin === "/jobs" ? { count: 0 } : { count: 0, posts: [] })).fn, maintenant: plus(2_000) }));
    expect(sansListe.ok).toBe(false);
    expect(sansListe.message).toMatch(/sans la liste attendue/);
    const apres = await prisma.sitePublication.findMany({ where: { label: { startsWith: TAG } }, select: { id: true, version: true } });
    expect(apres).toEqual(avant);
    expect(id).toBeTruthy();
  });

  it("le pas du battement : un rapprochement par jour, un nouvel essai une heure après un échec, débrayable", async () => {
    const dernier = await prisma.siteReconciliation.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    const base = new Date(Math.max(Date.now(), dernier?.startedAt.getTime() ?? 0) + 2 * 86_400_000);
    const heure = 3_600_000;
    const site = fauxSite();
    const panne = script(() => rep(503, { error: "down" }));

    expect(noter(await rapprocherSiteSiDu(base, site.fn))?.ok).toBe(true);
    expect(await rapprocherSiteSiDu(new Date(base.getTime() + heure), site.fn), "moins de 24 h après un rapprochement réussi").toBeNull();
    const t1 = new Date(base.getTime() + 25 * heure);
    expect(noter(await rapprocherSiteSiDu(t1, panne.fn))?.ok).toBe(false);
    expect(await rapprocherSiteSiDu(new Date(t1.getTime() + 30 * 60_000), site.fn), "moins d'une heure après un échec").toBeNull();
    expect(noter(await rapprocherSiteSiDu(new Date(t1.getTime() + 61 * 60_000), site.fn))?.ok).toBe(true);
    process.env.SITE_WEB_RECONCILIATION = "off";
    expect(await rapprocherSiteSiDu(new Date(base.getTime() + 5 * 86_400_000), site.fn)).toBeNull();
  });

  // ───────────────────────────── Vérifier la connexion ─────────────────────────────

  // ───────────────────────────── La liaison : l'ERP fabrique la clé (§118.159) ─────────────────────────────

  it("GÉNÉRER : une clé EN ATTENTE, scellée — ni la clé ni son secret en clair en base, ni dans la réponse ; une seconde génération retire la première ; le Super Admin seul", async () => {
    ACTOR = await actorFor(ids.dir!);
    expect((await genererCleSite()).ok, "la Direction ne génère pas l'identifiant qui publie sur le site public").toBe(false);
    expect(await prisma.siteWebCle.count()).toBe(0);

    ACTOR = await actorFor(ids.sa!);
    const r1 = await genererCleSite();
    expect(r1.ok, r1.error).toBe(true);
    const a1 = (await cleEnAttente())!;
    expect(a1.cle).toMatch(/^[0-9a-f]{64}$/);
    expect(a1.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a1.secret).not.toBe(a1.cle);
    expect(a1.empreinte).toBe(empreinteCle(a1.cle));
    expect(r1.message).toContain(a1.empreinte);
    expect(r1.message, "la réponse de l'action ne transporte jamais la clé").not.toContain(a1.cle);
    const brute = await prisma.siteWebCle.findUniqueOrThrow({ where: { id: a1.id } });
    expect(brute.etat).toBe("ATTENTE");
    expect(brute.cle).not.toContain(a1.cle);
    expect(brute.secret).not.toContain(a1.secret);
    expect(await prisma.auditLog.count({ where: { summary: { contains: a1.cle } } })).toBe(0);

    // Une clé EN ATTENTE ne publie rien : la configuration en vigueur est toujours l'environnement.
    const enVigueur = await configurationEnVigueur();
    expect(enVigueur.ok && enVigueur.config.source).toBe("ENVIRONNEMENT");
    expect(enVigueur.ok && enVigueur.config.cle).toBe(CLE);

    expect((await genererCleSite()).ok).toBe(true);
    const a2 = (await cleEnAttente())!;
    expect(a2.id).not.toBe(a1.id);
    expect((await prisma.siteWebCle.findUniqueOrThrow({ where: { id: a1.id } })).etat, "un seul bloc à coller").toBe("RETIREE");
    expect(await prisma.siteWebCle.count({ where: { etat: "ATTENTE" } })).toBe(1);

    // L'INVARIANT EST DANS LA BASE, pas dans la discipline du code : une seconde ligne en attente
    // est refusée par l'index partiel, quel que soit le chemin qui l'écrirait.
    await expect(prisma.siteWebCle.create({ data: { etat: "ATTENTE", cle: "x", secret: "y", empreinte: "z" } }))
      .rejects.toMatchObject({ code: "P2002" });

    ACTOR = await actorFor(ids.dir!);
    expect((await abandonnerCleSite()).ok).toBe(false);
    ACTOR = await actorFor(ids.sa!);
    expect((await abandonnerCleSite()).ok).toBe(true);
    expect(await cleEnAttente()).toBeNull();
    expect((await abandonnerCleSite()).ok, "rien à abandonner : le dire").toBe(false);
  });

  it("le rythme de présentation est DÉGRESSIF : chaque minute la première demi-heure, dix minutes ensuite, une heure après un jour", () => {
    const c = new Date("2026-09-30T10:00:00Z");
    const pas = (minutes: number) => {
      const m = new Date(c.getTime() + minutes * 60_000);
      return prochainePresentation(c, m).getTime() - m.getTime();
    };
    expect(pas(1)).toBe(60_000);
    expect(pas(29)).toBe(60_000);
    expect(pas(31)).toBe(600_000);
    expect(pas(24 * 60 - 1)).toBe(600_000);
    expect(pas(24 * 60 + 1)).toBe(3_600_000);
  });

  it("PRÉSENTER la clé au site : chaque réponse NOMME le geste ; rien avant l'échéance ; reconnue → PROMUE, l'ancienne retirée, une notification", async () => {
    // Une clé active ANTÉRIEURE, pour voir qu'elle est retirée au moment exact de la promotion.
    const ancienne = await genererCle(ids.sa!);
    expect(await promouvoir(ancienne.id, "banc")).toBe(true);
    const nouvelle = await genererCle(ids.sa!);
    const m0 = plus(1_000);

    const pasDeCle = script(() => rep(503, { status: "error", error: "Content API disabled: ERP_API_KEY is not set on the website environment." }));
    const p1 = await presenterCleEnAttente(pasDeCle.fn, { maintenant: m0 });
    expect(p1).toMatchObject({ issue: "PAS_ENCORE" });
    expect(p1.message).toMatch(/collez le bloc/);
    expect(pasDeCle.appels).toEqual([{ methode: "GET", chemin: "/health", identifiants: { cle: nouvelle.cle, secret: nouvelle.secret } }]);
    const l1 = await prisma.siteWebCle.findUniqueOrThrow({ where: { id: nouvelle.id } });
    expect(l1.prochaineVerification.getTime() - m0.getTime()).toBe(60_000);
    expect(l1.dernierConstat).toBe(p1.message);

    // Avant l'échéance, rien ne part : chaque présentation réveille un site endormi (plan gratuit).
    expect((await presenterCleEnAttente(pasDeCle.fn, { maintenant: new Date(m0.getTime() + 30_000) })).issue).toBe("PAS_DUE");
    expect(pasDeCle.appels).toHaveLength(1);

    const autreCle = script(() => rep(401, { status: "error", error: "Invalid or missing bearer token." }));
    expect((await presenterCleEnAttente(autreCle.fn, { maintenant: new Date(m0.getTime() + 61_000) })).message).toMatch(/pas celle-ci/);
    const autreSecret = script(() => rep(401, { status: "error", error: "Invalid body signature." }));
    const p3 = await presenterCleEnAttente(autreSecret.fn, { force: true, maintenant: new Date(m0.getTime() + 62_000) });
    expect(p3.issue, "bonne clé, mauvais secret : publier échouerait — pas de promotion").toBe("PAS_ENCORE");
    expect(p3.message).toMatch(/bloc ENTIER/);
    expect((await cleActive())!.id).toBe(ancienne.id);

    const avant = await notifs(ids.sa!, "Site web relié");
    const reconnue = script(() => rep(200, { status: "ok", configured: true, authenticated: true, capabilities: ["jobs", "posts"] }));
    const p4 = await presenterCleEnAttente(reconnue.fn, { force: true, maintenant: new Date(m0.getTime() + 63_000) });
    expect(p4.issue).toBe("PROMUE");
    expect((await cleActive())!.id).toBe(nouvelle.id);
    expect(await cleEnAttente()).toBeNull();
    expect((await prisma.siteWebCle.findUniqueOrThrow({ where: { id: ancienne.id } })).etat).toBe("RETIREE");
    const conf = await configurationEnVigueur();
    expect(conf.ok && conf.config).toMatchObject({ source: "ERP", cle: nouvelle.cle, secret: nouvelle.secret, cleId: nouvelle.id });
    expect(await notifs(ids.sa!, "Site web relié")).toBe(avant + 1);
    expect((await presenterCleEnAttente(reconnue.fn, { force: true })).issue).toBe("AUCUNE");
  });

  it("DEUX PROMOTIONS SIMULTANÉES (la présentation et un appel du site avec la nouvelle clé) : une seule l'emporte, une seule notification", async () => {
    const k = await genererCle(ids.sa!);
    const avant = await notifs(ids.sa!, "Site web relié");
    const issues = await Promise.all([promouvoir(k.id, "a"), promouvoir(k.id, "b"), promouvoir(k.id, "c"), promouvoir(k.id, "d")]);
    expect(issues.filter(Boolean)).toHaveLength(1);
    expect(await prisma.siteWebCle.count({ where: { etat: "ACTIVE" } })).toBe(1);
    expect(await notifs(ids.sa!, "Site web relié")).toBe(avant + 1);
  });

  it("ROTATION SANS COUPURE, par le VRAI transport : la clé en attente ne publie rien ; le site change de clé → le 401 fait présenter la nouvelle, qui repart, sans blocage ni alerte ni essai consommé", async () => {
    process.env.ADVENTUM_BASE_URL = SITE_LOCAL;
    delete process.env.ADVENTUM_API_KEY;
    const site = siteReseau({ cle: null, secret: null });
    global.fetch = site.fn;

    // 1. PREMIÈRE LIAISON : le Super Admin génère, colle le bloc (le site redémarre avec), vérifie.
    ACTOR = await actorFor(ids.sa!);
    expect((await genererCleSite()).ok).toBe(true);
    const k1 = (await cleEnAttente())!;
    Object.assign(site.etat, { cle: k1.cle, secret: k1.secret });
    const v = await verifierConnexionSite();
    expect(v.ok, v.error).toBe(true);
    expect(v.message).toMatch(/Relié/);
    expect((await cleActive())!.id).toBe(k1.id);
    // La présentation a signé avec le secret de la clé présentée — sinon le site l'aurait refusée.
    expect(site.vus.find((x) => x.chemin === "/health")).toMatchObject({ cle: k1.cle, signe: true });

    // 2. On publie : la clé ACTIVE part, signée.
    const a = await publier("Rotation un");
    const la = await pub("POST", a);
    expect(await viderFile({ transport: envoyerAuSite, seulement: [la.id], maintenant: plus(1_000) })).toMatchObject({ reussis: 1 });
    expect(site.vus.at(-1)).toMatchObject({ methode: "PUT", cle: k1.cle, signe: true });

    // 3. Une nouvelle clé EN ATTENTE ne publie rien tant que le site ne l'a pas.
    ACTOR = await actorFor(ids.sa!);
    expect((await genererCleSite()).ok).toBe(true);
    const k2 = (await cleEnAttente())!;
    const b = await publier("Rotation deux");
    const lb = await pub("POST", b);
    expect(await viderFile({ transport: envoyerAuSite, seulement: [lb.id], maintenant: plus(2_000) })).toMatchObject({ reussis: 1 });
    expect(site.vus.at(-1)).toMatchObject({ methode: "PUT", cle: k1.cle });

    // 4. La personne colle le nouveau bloc : le site ne connaît plus que k2.
    Object.assign(site.etat, { cle: k2.cle, secret: k2.secret });
    const c = await publier("Rotation trois");
    const lc = await pub("POST", c);
    const alertes = await notifs(ids.sa!, "Site web : publication suspendue");
    const b1 = await viderFile({ transport: envoyerAuSite, seulement: [lc.id], maintenant: plus(3_000) });
    expect(b1, "le 401 de l'ancienne clé fait présenter la nouvelle : reconnue, elle devient active").toMatchObject({ reconfigure: true, bloque: false });
    expect((await cleActive())!.id).toBe(k2.id);
    expect(await pub("POST", c)).toMatchObject({ state: "PENDING", attempts: 0, lastStatus: 401, lastError: null });
    expect(await lireBlocage()).toBeNull();
    expect(await notifs(ids.sa!, "Site web : publication suspendue")).toBe(alertes);

    const b2 = await viderFile({ transport: envoyerAuSite, seulement: [lc.id], maintenant: plus(4_000) });
    expect(b2).toMatchObject({ reussis: 1, bloque: false });
    expect(site.vus.at(-1)).toMatchObject({ methode: "PUT", cle: k2.cle, signe: true });
    expect(await pub("POST", c)).toMatchObject({ state: "DONE", attempts: 1 });
    expect(site.posts.has(c)).toBe(true);
  });

  it("le site a la clé mais un AUTRE secret (bloc collé en partie) : pas de promotion, le blocage le dit avec le geste qui répare", async () => {
    process.env.ADVENTUM_BASE_URL = SITE_LOCAL;
    const site = siteReseau({ cle: CLE, secret: null });
    global.fetch = site.fn;
    const k = await genererCle(ids.sa!);
    Object.assign(site.etat, { cle: k.cle, secret: "un-autre-secret" });
    const id = await publier("Secret partiel");
    const b = await viderFile({ transport: envoyerAuSite, seulement: [(await pub("POST", id)).id], maintenant: plus(1_000) });
    expect(b.bloque).toBe(true);
    expect(await cleEnAttente(), "la clé en attente n'est pas promue sur une signature refusée").not.toBeNull();
    const bl = await lireBlocage();
    expect(bl?.motif).toMatch(/Clé en attente : .*bloc ENTIER/);
  });

  it("ILLISIBLE : une clé dont le sceau ne s'ouvre plus n'est pas « jamais relié » — l'écran le dit, la configuration retombe sur l'environnement", async () => {
    await prisma.siteWebCle.create({ data: { etat: "ACTIVE", cle: "pas-un-sceau", secret: "pas-un-sceau", empreinte: "illisible0000" } });
    expect(await clesIllisibles()).toEqual(["ACTIVE"]);
    const l = await etatLiaison();
    expect(l.illisibles).toEqual(["ACTIVE"]);
    expect(l.active).toBeNull();
    const conf = await configurationEnVigueur();
    expect(conf.ok && conf.config.source).toBe("ENVIRONNEMENT");
  });

  it("LE BLOC À COLLER : la clé, son secret, et l'adresse de l'ERP — jamais une adresse inventée, jamais en clair hors de la machine", () => {
    expect(blocEnvironnement({ cle: "k", secret: "s", erp: "https://erp.test" })).toBe("ERP_API_KEY=k\nERP_WEBHOOK_SECRET=s\nERP_BASE_URL=https://erp.test");
    expect(blocEnvironnement({ cle: "k", secret: "s", erp: null })).toBe("ERP_API_KEY=k\nERP_WEBHOOK_SECRET=s");
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    expect(origineDeLERP(env({ APP_URL: "https://erp.adventum.dz/tableau" }), { hote: "autre.test", proto: "https" })).toBe("https://erp.adventum.dz");
    expect(origineDeLERP(env({}), { hote: "erp.onrender.com", proto: "https" })).toBe("https://erp.onrender.com");
    expect(origineDeLERP(env({}), { hote: "erp.onrender.com", proto: "http" }), "http:// hors de la machine emporterait la clé en clair").toBeNull();
    expect(origineDeLERP(env({}), { hote: "localhost:3000", proto: "http" })).toBe("http://localhost:3000");
    expect(origineDeLERP(env({ RENDER_EXTERNAL_URL: "https://amd.onrender.com" }), { hote: null, proto: null })).toBe("https://amd.onrender.com");
    expect(origineDeLERP(env({}), { hote: null, proto: null })).toBeNull();
  });

  it("L'ENTRETIEN (battement) : la santé du site lue UNE FOIS L'HEURE — un site endormi ne se réveille pas chaque minute ; un redémarrage (bootId) fait rapprocher aussitôt", async () => {
    let boot = `boot-${RUN}-1`;
    const site = fauxSite();
    const t = script((r) => (r.chemin === "/health"
      ? rep(200, {
        status: "ok", configured: true, authenticated: true, capabilities: ["jobs", "posts"], bootId: boot,
        startedAt: "2026-09-30T08:00:00.000Z", erp: { linked: true, signing: false, lastError: null },
        applications: { pending: 2, oldestAt: "2026-09-30T07:00:00.000Z" }, storage: { fallback: true },
      })
      : site.fn(r)));
    const m0 = plus(1_000);
    const minute = 60_000;

    const b1 = await entretenirLiaison({ transport: t.fn, maintenant: m0 });
    expect(b1.redemarrage).toBe(false);
    expect((await derniereSante()).sante).toMatchObject({
      authentifie: true, bootId: boot, erpRelie: true, signe: false, candidaturesEnAttente: 2, stockageDeSecours: true,
    });
    expect(t.appels.map((a) => a.chemin)).toEqual(["/health"]);

    await entretenirLiaison({ transport: t.fn, maintenant: new Date(m0.getTime() + 30 * minute) });
    expect(t.appels, "moins d'une heure après : le site n'est pas réveillé").toHaveLength(1);

    await entretenirLiaison({ transport: t.fn, maintenant: new Date(m0.getTime() + 61 * minute) });
    expect(t.appels.map((a) => a.chemin), "même démarrage : une lecture, pas de rapprochement").toEqual(["/health", "/health"]);

    boot = `boot-${RUN}-2`;
    const b3 = await entretenirLiaison({ transport: t.fn, maintenant: new Date(m0.getTime() + 122 * minute) });
    expect(b3).toMatchObject({ redemarrage: true, rapproche: true });
    expect(t.appels.map((a) => a.chemin)).toEqual(["/health", "/health", "/health", "/jobs", "/posts", "/repository"]);

    await entretenirLiaison({ transport: t.fn, maintenant: new Date(m0.getTime() + 123 * minute), force: true });
    expect(t.appels.filter((a) => a.chemin === "/health"), "« Vérifier maintenant » ignore l'heure").toHaveLength(4);
  });

  // ───────────────────────────── Le site appelle l'ERP (§118.159) ─────────────────────────────

  it("LE SITE APPELLE L'ERP : sans clé 503 ; clé absente, fausse ou signature fausse 401 ; la clé en attente est PROMUE sur-le-champ ; celle de l'environnement ne vaut que tant qu'aucune clé n'est active", async () => {
    const h = (cle?: string, sig?: string) =>
      new Headers({ ...(cle ? { authorization: `Bearer ${cle}` } : {}), ...(sig ? { "x-adventum-signature": sig } : {}) });
    delete process.env.ADVENTUM_API_KEY;
    expect(await authentifierLeSite(h("x"), null)).toMatchObject({ ok: false, statut: 503 });

    process.env.ADVENTUM_API_KEY = CLE;
    expect(await authentifierLeSite(h(CLE), null)).toEqual({ ok: true, source: "ENVIRONNEMENT" });
    expect(await authentifierLeSite(h(), null)).toMatchObject({ ok: false, statut: 401 });
    expect(await authentifierLeSite(h(`${CLE}x`), null)).toMatchObject({ ok: false, statut: 401 });

    const k = await genererCle(ids.sa!);
    const corps = JSON.stringify({ id: "x" });
    expect(await authentifierLeSite(h(k.cle), corps), "un corps non signé, avec une clé qui a un secret").toMatchObject({ ok: false, statut: 401, erreur: SIGNATURE_REFUSEE });
    expect(await authentifierLeSite(h(k.cle, "sha256=00"), corps)).toMatchObject({ ok: false, statut: 401 });
    expect(await cleEnAttente(), "un refus ne promeut rien").not.toBeNull();

    const avant = await notifs(ids.sa!, "Site web relié");
    expect(await authentifierLeSite(h(k.cle, `sha256=${signatureAttendue(corps, k.secret)}`), corps)).toEqual({ ok: true, source: "ATTENTE_PROMUE" });
    expect((await cleActive())!.id).toBe(k.id);
    expect(await notifs(ids.sa!, "Site web relié")).toBe(avant + 1);

    expect(await authentifierLeSite(h(CLE), null), "une clé active existe : l'ancienne de l'environnement ne sert plus").toMatchObject({ ok: false, statut: 401 });
    expect(await authentifierLeSite(h(k.cle, `sha256=${signatureAttendue("", k.secret)}`), null)).toEqual({ ok: true, source: "ACTIVE" });
    expect(await authentifierLeSite(h(k.cle, signatureAttendue(corps, k.secret).toUpperCase()), corps)).toEqual({ ok: true, source: "ACTIVE" });
  });

  it("UN GET SE SIGNE AUSSI : sans signature, ou signé sur autre chose que la chaîne vide, la clé seule ne relit rien — la règle que le site applique à l'ERP", async () => {
    const h = (cle: string, sig?: string) =>
      new Headers({ authorization: `Bearer ${cle}`, ...(sig ? { "x-adventum-signature": sig } : {}) });
    const k = await genererCle(ids.sa!);
    expect(await promouvoir(k.id, "banc")).toBe(true);
    // La clé SEULE — celle qu'un journal de mandataire aurait gardée sans son secret.
    expect(await authentifierLeSite(h(k.cle), null)).toMatchObject({ ok: false, statut: 401, erreur: SIGNATURE_REFUSEE });
    expect(await authentifierLeSite(h(k.cle, `sha256=${signatureAttendue("{}", k.secret)}`), null), "signé, mais pas sur la chaîne vide").toMatchObject({ ok: false, statut: 401 });
    expect(await authentifierLeSite(h(k.cle, `sha256=${signatureAttendue("", "un-autre-secret")}`), null), "la bonne clé, un autre secret").toMatchObject({ ok: false, statut: 401 });
    expect(await authentifierLeSite(h(k.cle, `sha256=${signatureAttendue("", k.secret)}`), null)).toEqual({ ok: true, source: "ACTIVE" });

    const url = "http://erp.banc.test/api/site-web/v1/contenus";
    expect((await contenusDuSite(new Request(url, { headers: { authorization: `Bearer ${k.cle}` } }))).status, "la route elle-même : non signé → 401").toBe(401);
    const signe = await contenusDuSite(new Request(url, {
      headers: { authorization: `Bearer ${k.cle}`, "x-adventum-signature": `sha256=${signatureAttendue("", k.secret)}` },
    }));
    expect(signe.status).toBe(200);
  });

  it("GET /api/site-web/v1/contenus : EXACTEMENT les corps que la file enverrait — jamais un brouillon — et rien sans la clé", async () => {
    const id = await publier("Restauration");
    ACTOR = await actorFor(ids.dir!);
    const brouillon = await enregistrerArticle(form({ intention: "brouillon", title: `${TAG}Restauration brouillon`, body: "## A\n\nB" }));
    expect(brouillon.ok).toBe(true);

    const url = "http://erp.banc.test/api/site-web/v1/contenus";
    expect((await contenusDuSite(new Request(url))).status).toBe(401);
    const res = await contenusDuSite(new Request(url, { headers: { authorization: `Bearer ${CLE}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as { posts: Record<string, unknown>[]; jobs: unknown[]; count: number };
    const ligne = await pub("POST", id);
    expect(j.posts.find((p) => p.externalId === id)).toEqual({ externalId: id, ...JSON.parse(ligne.body!) });
    expect(j.posts.some((p) => p.externalId === brouillon.id), "un brouillon jamais publié n'a rien à faire sur le site").toBe(false);
    expect(j.count).toBe(j.posts.length + j.jobs.length);
  });

  // ───────────────────────────── La reprise des contenus du site (§118.160) ─────────────────────────────

  /** Un article du DÉPÔT du site, tel que `GET /repository` le rend — le Markdown brut. */
  const articleDuDepot = (nom: string, extra: Record<string, unknown> = {}) => ({
    slug: `siteweb-${RUN}-${nom}`,
    title: `${TAG}Article du dépôt ${nom}`,
    description: "Une description d'article du dépôt, pour que la reprise ait quelque chose à garder.",
    body: "Une introduction.\n\n## Première partie\n\nDu texte **en gras**.\n\n## Seconde partie\n\n- un point\n- un autre",
    category: "Réglementaire", tags: ["enregistrement", "Algérie"], author: "Adventum Pharma",
    date: "2026-03-18T00:00:00.000Z", updated: "2026-09-15T00:00:00.000Z", featured: true,
    ...extra,
  });
  const lirePosts = async (site: ReturnType<typeof fauxSite>) =>
    JSON.parse((await site.fn({ methode: "GET", chemin: "/posts" })).texte!) as { readOnlyFileArticles: { slug: string }[]; replacedFiles: string[] };
  const visiblesDuRun = async (site: ReturnType<typeof fauxSite>) =>
    (await lirePosts(site)).readOnlyFileArticles.map((d) => d.slug).filter((x) => x.includes(RUN));

  it("REPRENDRE : les articles du dépôt deviennent des articles de l'ERP poussés avec ce qu'ils remplacent ; l'exemple en brouillon, jamais envoyé ; l'offre saisie sur le site reprise avec son état — une alerte, et la seconde fois rien ne se passe", async () => {
    const site = fauxSite();
    site.depotComplet.push(articleDuDepot("alpha"), articleDuDepot("beta", { featured: false, date: null, updated: null }));
    site.exemples.push({
      slug: `exemple-${RUN}`, title: `${TAG}Chargé(e) exemple`, department: "Réglementaire", location: "Alger", type: "CDI",
      experience: "3 ans", summary: "Un exemple.", mission: ["m1", "m2"], profile: ["p1"], offer: ["o1"],
    });
    site.offresSaisies.push({
      id: `saisie-${RUN}`, slug: "poste-saisi", title: `${TAG}Poste saisi sur le site`, department: "Qualité", location: "Alger", type: "CDD",
      experience: "", summary: "Saisi à la main.", mission: ["a"], profile: [], offer: [], published: true,
    });
    const alerte = "Site web : contenus repris du site";
    const a0 = await notifs(ids.sa!, alerte);

    const b1 = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    expect(b1.ok, b1.message).toBe(true);
    expect(b1.reprise?.repris.map((r) => r.origine).sort()).toEqual(["ARTICLE_DEPOT", "ARTICLE_DEPOT", "OFFRE_ADMIN", "OFFRE_EXEMPLE"]);
    expect(b1.message).toMatch(/4 contenu\(s\) repris du site/);
    expect(b1.repousses, "une reprise n'est pas un écart rattrapé").toBe(0);

    // LES ARTICLES : même adresse, même texte, mêmes dates — et publiés, comme sur le site.
    const alpha = await prisma.blogArticle.findUniqueOrThrow({ where: { slug: `siteweb-${RUN}-alpha` }, include: { reprise: true } });
    expect(alpha).toMatchObject({ published: true, featured: true, category: "Réglementaire", tags: ["enregistrement", "Algérie"], createdById: ids.sa });
    expect(alpha.body).toBe(articleDuDepot("alpha").body);
    expect(alpha.publishedOn?.toISOString()).toBe("2026-03-18T00:00:00.000Z");
    expect(alpha.firstPublishedAt?.toISOString(), "sa première mise en ligne est celle du SITE, pas celle de la reprise").toBe("2026-03-18T00:00:00.000Z");
    expect(alpha.revisedAt?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(alpha.reprise).toMatchObject({ origine: "ARTICLE_DEPOT", cleSite: `siteweb-${RUN}-alpha` });

    // POUSSÉS AVEC CE QU'ILS REMPLACENT : le site cache ses fichiers et montre la version de l'ERP.
    expect(site.posts.get(alpha.id)).toMatchObject({ replacesFile: `siteweb-${RUN}-alpha`, body: alpha.body, published: true });
    expect(await visiblesDuRun(site), "plus aucun fichier du dépôt visible").toEqual([]);

    // L'EXEMPLE : repris en BROUILLON, et jamais envoyé — publier un poste est une décision.
    const exemple = await prisma.jobPosting.findFirstOrThrow({ where: { title: `${TAG}Chargé(e) exemple` } });
    expect(exemple).toMatchObject({ published: false, contractLabel: "CDI", mission: ["m1", "m2"] });
    expect(site.jobs.has(exemple.id)).toBe(false);
    expect(await prisma.sitePublication.count({ where: { kind: "JOB", externalId: exemple.id } })).toBe(0);

    // L'OFFRE SAISIE : son état est gardé, et la version de l'ERP REMPLACE la copie du site.
    const saisie = await prisma.jobPosting.findFirstOrThrow({ where: { title: `${TAG}Poste saisi sur le site` } });
    expect(saisie.published).toBe(true);
    expect(site.jobs.get(saisie.id)).toMatchObject({ title: `${TAG}Poste saisi sur le site`, published: true });
    expect(site.offresSaisies, "jamais deux fois le même poste sur la page Carrières").toEqual([]);

    expect(await notifs(ids.sa!, alerte), "une alerte pour tout le lot").toBe(a0 + 1);

    // IDEMPOTENT : la seconde fois, rien n'est repris, rien n'est écrit, personne n'est dérangé.
    site.appels.length = 0;
    const b2 = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(2_000), transport: site.fn }));
    expect(b2.reprise?.repris).toEqual([]);
    expect(site.appels.filter((a) => a.methode !== "GET")).toEqual([]);
    expect(await prisma.siteReprise.count({ where: { titre: { startsWith: TAG } } })).toBe(4);
    expect(await notifs(ids.sa!, alerte)).toBe(a0 + 1);
  });

  it("MODIFIER puis SUPPRIMER un article repris : il garde son adresse et remplace la version du site ; supprimé, il reste caché — la reprise survit, et la liste que le site recharge le dit", async () => {
    const site = fauxSite();
    site.depotComplet.push(articleDuDepot("gamma"));
    noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    const a = await prisma.blogArticle.findUniqueOrThrow({ where: { slug: `siteweb-${RUN}-gamma` } });

    // Sa propre adresse n'est pas « une adresse du dépôt » : sans quoi on ne pourrait pas corriger
    // l'article même qu'on vient de reprendre pour le corriger.
    ACTOR = await actorFor(ids.dir!);
    const r = await enregistrerArticle(form({
      id: a.id, intention: "enregistrer", title: `${TAG}Article du dépôt gamma (corrigé)`, slug: a.slug!, body: `${a.body}\n\nUne phrase ajoutée.`,
      description: a.description ?? "", category: a.category ?? "", tags: a.tags.join(", "), author: a.author ?? "",
    }));
    expect(r.ok, r.error).toBe(true);
    await viderFile({ transport: site.fn, maintenant: plus(2_000) });
    expect(site.posts.get(a.id)).toMatchObject({ title: `${TAG}Article du dépôt gamma (corrigé)`, replacesFile: `siteweb-${RUN}-gamma` });

    const d = await supprimerArticle(form({ id: a.id }));
    expect(d.ok, d.error).toBe(true);
    await viderFile({ transport: site.fn, maintenant: plus(3_000) });
    expect(site.posts.has(a.id)).toBe(false);
    expect(await visiblesDuRun(site), "l'ancien fichier ne revient pas").toEqual([]);

    const b = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(4_000), transport: site.fn }));
    expect(b.reprise?.repris, "supprimer, c'est décider : il n'est pas repris une seconde fois").toEqual([]);
    expect(await prisma.siteReprise.findFirst({ where: { cleSite: `siteweb-${RUN}-gamma` }, select: { articleId: true } })).toEqual({ articleId: null });

    const res = await contenusDuSite(new Request("http://erp.banc.test/api/site-web/v1/contenus", { headers: { authorization: `Bearer ${CLE}` } }));
    expect(((await res.json()) as { replacedFiles: string[] }).replacedFiles).toContain(`siteweb-${RUN}-gamma`);
  });

  it("un article repris que le site REFUSERAIT (titre de niveau 1) : repris quand même, dit « à corriger », rien ne part et le site garde le sien ; le SUPPRIMER le cache quand même", async () => {
    const site = fauxSite();
    site.depotComplet.push(articleDuDepot("delta", { body: "# Un titre de niveau 1\n\nDu texte." }));
    const b = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    expect(b.reprise?.aCorriger).toHaveLength(1);
    expect(b.reprise?.aCorriger[0]!.raison).toMatch(/niveau 1/);
    const a = await prisma.blogArticle.findUniqueOrThrow({ where: { slug: `siteweb-${RUN}-delta` } });
    expect(site.posts.has(a.id), "rien ne part tant qu'une personne n'a pas corrigé").toBe(false);
    expect(await visiblesDuRun(site), "le site garde sa version en attendant").toEqual([`siteweb-${RUN}-delta`]);

    ACTOR = await actorFor(ids.dir!);
    expect((await supprimerArticle(form({ id: a.id }))).ok).toBe(true);
    const ligne = await pub("POST", a.id);
    expect(ligne.operation).toBe("DELETE");
    expect(JSON.parse(ligne.body!), "la suppression dit ce qu'elle remplaçait").toEqual({ replacesFile: `siteweb-${RUN}-delta` });
    await viderFile({ transport: site.fn, maintenant: plus(2_000) });
    expect(await visiblesDuRun(site)).toEqual([]);
    expect((await pub("POST", a.id)).state).toBe("DONE");
  });

  it("une offre saisie sur le site, reprise mais refusée par le contrat, puis SUPPRIMÉE : la suppression part quand même et retire la copie du site", async () => {
    const site = fauxSite();
    const trop = Array.from({ length: 31 }, (_, i) => `mission ${i + 1}`);
    site.offresSaisies.push({ id: `saisie2-${RUN}`, title: `${TAG}Poste trop long`, department: "", location: "", type: "CDI", experience: "", summary: "", mission: trop, profile: [], offer: [], published: true });
    const b = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    expect(b.reprise?.aCorriger.map((c) => c.origine)).toEqual(["OFFRE_ADMIN"]);
    const o = await prisma.jobPosting.findFirstOrThrow({ where: { title: `${TAG}Poste trop long` } });
    expect(site.offresSaisies).toHaveLength(1);

    ACTOR = await actorFor(ids.dir!);
    expect((await supprimerOffre(form({ id: o.id }))).ok).toBe(true);
    expect(JSON.parse((await pub("JOB", o.id)).body!)).toEqual({ replacesJob: `saisie2-${RUN}` });
    await viderFile({ transport: site.fn, maintenant: plus(2_000) });
    expect(site.offresSaisies, "la copie du site est partie avec la nôtre").toEqual([]);
  });

  it("une adresse DÉJÀ PRISE dans l'ERP : l'article du dépôt n'est pas repris, et le conflit est nommé avec le geste qui le lève — jamais deux articles fusionnés d'office", async () => {
    ACTOR = await actorFor(ids.dir!);
    const brouillon = await enregistrerArticle(form({ intention: "brouillon", title: `${TAG}Déjà là`, slug: `siteweb-${RUN}-epsilon`, body: "## A\n\nB" }));
    expect(brouillon.ok, brouillon.error).toBe(true);
    const site = fauxSite();
    site.depotComplet.push(articleDuDepot("epsilon"));
    const b = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    expect(b.reprise?.repris).toEqual([]);
    expect(b.reprise?.conflits[0]!.raison).toMatch(new RegExp(`porte déjà l'adresse /blog/siteweb-${RUN}-epsilon.*autre adresse`));
    expect(await prisma.siteReprise.count({ where: { cleSite: `siteweb-${RUN}-epsilon` } })).toBe(0);
    expect(await prisma.blogArticle.count({ where: { slug: `siteweb-${RUN}-epsilon` } })).toBe(1);
    expect(await visiblesDuRun(site), "rien ne change pour le public").toEqual([`siteweb-${RUN}-epsilon`]);
  });

  it("un site d'AVANT la reprise (pas de /repository) : la reprise est DITE impossible, le rapprochement réussit quand même, et le battement repasse toutes les heures jusqu'à ce qu'elle ait lieu — puis une fois par jour", async () => {
    // « Le dépôt a-t-il déjà été lu ? » est une question GLOBALE, et seul ce fichier rapproche dans la
    // base de test : on part d'une base où il ne l'a jamais été, sans quoi le cas ne mesure rien.
    await prisma.siteReconciliation.deleteMany({ where: { repriseLue: true } });
    const dernier = await prisma.siteReconciliation.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    const base = new Date(Math.max(Date.now(), dernier?.startedAt.getTime() ?? 0) + 2 * 86_400_000);
    const site = fauxSite();
    site.etat.sansDepot = true;
    const b1 = noter(await rapprocherSiteSiDu(base, site.fn));
    expect(b1?.ok, b1?.message).toBe(true);
    expect(b1?.reprise?.impossible).toMatch(/pas encore à jour.*Deploy latest commit/);
    expect(await prisma.siteReconciliation.findUniqueOrThrow({ where: { id: b1!.id! }, select: { repriseLue: true } })).toEqual({ repriseLue: false });
    expect(await rapprocherSiteSiDu(new Date(base.getTime() + 30 * 60_000), site.fn), "pas avant une heure").toBeNull();
    site.etat.sansDepot = false;
    const b2 = noter(await rapprocherSiteSiDu(new Date(base.getTime() + 61 * 60_000), site.fn));
    expect(b2?.ok, "une heure après, il repasse : la reprise ne doit pas attendre le lendemain").toBe(true);
    expect(b2?.reprise).toMatchObject({ lue: true, impossible: null });
    expect(await rapprocherSiteSiDu(new Date(base.getTime() + 3 * 3_600_000), site.fn), "lu une fois : de nouveau une fois par jour").toBeNull();
  });

  it("un article repris puis supprimé que le site MONTRE ENCORE (il a perdu sa pierre tombale) : on lui demande de recharger ses contenus — et seulement dans ce cas", async () => {
    const site = fauxSite();
    site.depotComplet.push(articleDuDepot("zeta"));
    noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(1_000), transport: site.fn }));
    const a = await prisma.blogArticle.findUniqueOrThrow({ where: { slug: `siteweb-${RUN}-zeta` } });
    ACTOR = await actorFor(ids.dir!);
    expect((await supprimerArticle(form({ id: a.id }))).ok).toBe(true);
    await viderFile({ transport: site.fn, maintenant: plus(2_000) });
    expect(site.etat.rechargements).toBe(0);

    site.tombes.clear(); // redémarré sans disque, pendant que l'ERP était injoignable
    expect(await visiblesDuRun(site)).toEqual([`siteweb-${RUN}-zeta`]);
    const b = noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(3_000), transport: site.fn }));
    expect(site.etat.rechargements).toBe(1);
    const trace = await prisma.siteReconciliation.findUniqueOrThrow({ where: { id: b.id! }, select: { reprise: true } });
    expect(trace.reprise).toMatchObject({ rechargement: { fichiers: [`siteweb-${RUN}-zeta`], statut: 200 } });

    site.tombes.add(`siteweb-${RUN}-zeta`);
    noter(await rapprocherSite({ declencheur: "MANUEL", parId: ids.sa!, maintenant: plus(4_000), transport: site.fn }));
    expect(site.etat.rechargements, "tout est en ordre : rien n'est demandé").toBe(1);
  });

  it("POST /api/site-web/v1/candidatures : signée → 201 ; renvoyée → 200 sans doublon ; non signée → 401 ; trop lourde → 413 ; illisible → 400 ; incomplète → 422 avec sa raison", async () => {
    const k = await genererCle(ids.sa!);
    expect(await promouvoir(k.id, "banc")).toBe(true);
    const url = "http://erp.banc.test/api/site-web/v1/candidatures";
    const envoyer = (corps: string, signe = true, entetes: Record<string, string> = {}) =>
      candidatureDuSite(new Request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${k.cle}`, "content-type": "application/json",
          ...(signe ? { "x-adventum-signature": `sha256=${signatureAttendue(corps, k.secret)}` } : {}), ...entetes,
        },
        body: corps,
      }));
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF")]);
    const candidature = {
      id: `banc${RUN}-route-0001`, submittedAt: new Date().toISOString(), fullName: `${TAG}Candidate Route`, email: "candidate.route@example.test",
      phone: "+213 555 00 00 00", message: "Bonjour.", consent: true, language: "fr",
      cv: { fileName: "cv.pdf", contentType: "application/pdf", base64: pdf.toString("base64") },
    };
    const corps = JSON.stringify(candidature);

    expect((await envoyer(corps, false)).status).toBe(401);
    expect(await prisma.siteCandidature.count({ where: { siteId: candidature.id } })).toBe(0);

    const r1 = await envoyer(corps);
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { received: boolean; id: string; duplicate: boolean; state: string };
    expect(j1).toMatchObject({ received: true, duplicate: false, state: "NOUVELLE" });

    const r2 = await envoyer(corps);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ id: j1.id, duplicate: true });
    expect(await prisma.siteCandidature.count({ where: { siteId: candidature.id } })).toBe(1);

    expect((await envoyer(corps, true, { "content-length": String(64 * 1024 * 1024) })).status).toBe(413);
    expect((await envoyer("{pas du json")).status).toBe(400);
    const sansConsentement = JSON.stringify({ ...candidature, id: `banc${RUN}-route-0002`, consent: false });
    const r422 = await envoyer(sansConsentement);
    expect(r422.status).toBe(422);
    expect(((await r422.json()) as { error: string }).error).toMatch(/consent/);
  });

  it("vérifier la connexion : le site dit s'il a une clé et s'il reconnaît la nôtre — chaque cas nommé", async () => {
    const sante = (corps: unknown, statut = 200) => verifierSante(script(() => rep(statut, corps)).fn);
    expect(await sante({ status: "ok", configured: true, authenticated: true, capabilities: ["jobs", "posts"] })).toMatchObject({ ok: true, authentifie: true });
    expect((await sante({ configured: false, authenticated: false })).message).toMatch(/collez le bloc/);
    expect((await sante({ status: "error", error: "Invalid body signature." }, 401)).message, "bonne clé, autre secret : un autre geste").toMatch(/signature/);
    expect((await sante({ configured: true, authenticated: false })).message).toMatch(/ne reconnaît pas/);
    expect((await sante({ error: "unauthorized" }, 401)).authentifie).toBe(false);
    expect((await sante({ configured: true, authenticated: true, capabilities: ["jobs"] })).message).toMatch(/n'annonce pas : posts/);
  });
});
