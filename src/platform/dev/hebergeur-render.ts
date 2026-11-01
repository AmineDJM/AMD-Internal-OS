import { noterEffetExterne } from "@/lib/effets/magasin";
import { configRender, type Env } from "./config";
import { appeler, echec, type ConfigHttp, type ReponseHttp, type ValeurRequete } from "./http";
import type { DeclencheurAutoDeploy, Deploiement, Hebergeur, LigneJournal, PageJournal, Resultat, ServiceHeberge } from "./ports";

/**
 * L'HÉBERGEUR — Render API v1 en `fetch` nu (lot C2). Base `https://api.render.com/v1`, `Authorization: Bearer
 * <RENDER_API_KEY>`. Chemins vérifiés le 01/11/2026 sur api-docs.render.com (spécification OpenAPI de chaque page) :
 *
 *   GET    /services                                 liste (pagination `cursor`, `limit` ≤ 100)
 *   GET    /services/{serviceId}                     un service (`autoDeployTrigger`, `serviceDetails.url/healthCheckPath`)
 *   PATCH  /services/{serviceId}                     `{ autoDeployTrigger: "commit" | "checksPass" | "off" }`
 *   GET    /services/{serviceId}/deploys             liste (`limit` ≤ 100)
 *   POST   /services/{serviceId}/deploys             `{ commitId?, clearCache? }` → 201 deploy, ou 202 « en file »
 *   GET    /services/{serviceId}/deploys/{deployId}
 *   POST   /services/{serviceId}/deploys/{deployId}/cancel
 *   POST   /services/{serviceId}/rollback            `{ deployId }` → 201 deploy. NE COUPE PAS l'auto-déploiement.
 *   GET    /logs                                     `ownerId` exigé, `resource`, `startTime`, `endTime`, `level`, `text`…
 *   GET    /services/{serviceId}/env-vars            `[{ envVar: { key, value }, cursor }]` — on ne garde que `key`.
 *   GET    /events/{eventId}                         le détail d'un fait de webhook (`details.deployId`).
 *
 * La synchro d'un Blueprint ne se DÉCLENCHE pas par l'API (seulement lister, valider, mettre à jour, déconnecter) :
 * elle suit le push (synchro automatique) ou le bouton du tableau de bord.
 */

interface Brut { [k: string]: unknown }
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const o = (v: unknown): Brut => (v && typeof v === "object" ? (v as Brut) : {});
const PAGES_MAX = 10;

export interface QuotaRender { restant: number | null; limite: number | null }
export interface OptionsHebergeur { env?: Env; fetch?: typeof fetch; jeton?: string | null; base?: string }

const DECLENCHEURS: readonly DeclencheurAutoDeploy[] = ["commit", "checksPass", "off"];

export function serviceDe(x: Brut): ServiceHeberge {
  const d = o(x.serviceDetails);
  const trig = s(x.autoDeployTrigger);
  const auto: DeclencheurAutoDeploy | null = trig && (DECLENCHEURS as readonly string[]).includes(trig) ? (trig as DeclencheurAutoDeploy) : x.autoDeploy === "yes" ? "commit" : x.autoDeploy === "no" ? "off" : null;
  return {
    id: s(x.id) ?? "",
    nom: s(x.name) ?? "",
    type: s(x.type) ?? "",
    depot: s(x.repo),
    branche: s(x.branch),
    autoDeploy: auto,
    suspendu: x.suspended === "suspended",
    url: s(d.url),
    tableauDeBord: s(x.dashboardUrl),
    proprietaireId: s(x.ownerId),
    cheminSante: s(d.healthCheckPath),
  };
}

export function deploiementDe(x: Brut): Deploiement {
  const c = o(x.commit);
  return {
    id: s(x.id) ?? "",
    statut: s(x.status) ?? "",
    sha: s(c.id),
    messageCommit: (s(c.message) ?? "").split("\n")[0]!.slice(0, 300) || null,
    declencheur: s(x.trigger),
    creeLe: s(x.createdAt),
    termineLe: s(x.finishedAt),
  };
}

function ligneDe(x: Brut): LigneJournal {
  const labels = Array.isArray(x.labels) ? x.labels.map(o) : [];
  const label = (nom: string) => s(labels.find((l) => l.name === nom)?.value);
  return { id: s(x.id) ?? "", date: s(x.timestamp) ?? "", message: s(x.message) ?? "", niveau: label("level"), type: label("type") };
}

export function creerHebergeurRender(opts: OptionsHebergeur = {}): Hebergeur & { quota(): QuotaRender } {
  const conf = configRender(opts.env ?? process.env);
  const jeton = opts.jeton !== undefined ? opts.jeton : conf.jeton;
  const cfg: ConfigHttp = { fournisseur: "Render", base: opts.base ?? conf.base, autorisation: jeton ? `Bearer ${jeton}` : null, fetch: opts.fetch };
  const quota: QuotaRender = { restant: null, limite: null };

  const noter = <T>(r: Resultat<ReponseHttp<T>>): Resultat<ReponseHttp<T>> => {
    if (r.ok) {
      const rest = r.valeur.entetes.get("ratelimit-remaining");
      const lim = r.valeur.entetes.get("ratelimit-limit");
      if (rest !== null) quota.restant = Number(rest);
      if (lim !== null) quota.limite = Number(lim);
    }
    return r;
  };
  const lire = async <T>(route: string, requete?: Record<string, ValeurRequete>) => noter(await appeler<T>(cfg, "GET", route, { requete }));

  /** Les écritures sont notées au journal des effets (J7) et neutralisées en simulation. */
  async function ecrire<T>(methode: "POST" | "PATCH", route: string, corps: unknown, libelle: string, accepter?: number[]): Promise<Resultat<ReponseHttp<T>>> {
    if (noterEffetExterne({ acte: "ECRITURE_EXTERNE", cible: `Render : ${libelle}`.slice(0, 200), origine: "chantiers" })) {
      return echec("SIMULE", `simulation : ${libelle} — rien n'a été envoyé à Render`);
    }
    return noter(await appeler<T>(cfg, methode, route, { corps, accepter }));
  }

  /** Pagination Render : `cursor` du dernier élément, jusqu'à une page incomplète. */
  async function tout<T>(route: string, extraire: (x: Brut) => T, limite = 100): Promise<Resultat<T[]>> {
    const acc: T[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < PAGES_MAX; p += 1) {
      const r = await lire<unknown[]>(route, { limit: limite, cursor });
      if (!r.ok) return r;
      const items = Array.isArray(r.valeur.corps) ? r.valeur.corps.map(o) : [];
      acc.push(...items.map(extraire));
      cursor = s(items[items.length - 1]?.cursor) ?? undefined;
      if (items.length < limite || !cursor) break;
    }
    return { ok: true, valeur: acc };
  }

  const id = encodeURIComponent;

  return {
    quota: () => ({ ...quota }),

    services: () => tout("/services", (x) => serviceDe(o(x.service))),

    async service(serviceId) {
      const r = await lire<Brut>(`/services/${id(serviceId)}`);
      return r.ok ? { ok: true, valeur: serviceDe(o(r.valeur.corps)) } : r;
    },

    async deploiements(serviceId, opts2 = {}) {
      const r = await lire<unknown[]>(`/services/${id(serviceId)}/deploys`, { limit: Math.min(Math.max(opts2.limite ?? 20, 1), 100) });
      if (!r.ok) return r;
      return { ok: true, valeur: (Array.isArray(r.valeur.corps) ? r.valeur.corps : []).map((x) => deploiementDe(o(o(x).deploy))) };
    },

    async deploiement(serviceId, deployId) {
      const r = await lire<Brut>(`/services/${id(serviceId)}/deploys/${id(deployId)}`);
      return r.ok ? { ok: true, valeur: deploiementDe(o(r.valeur.corps)) } : r;
    },

    async deployer(serviceId, opts2 = {}) {
      const corps: Brut = {};
      if (opts2.commitId) corps.commitId = opts2.commitId;
      if (opts2.viderCache) corps.clearCache = "clear";
      const r = await ecrire<Brut>("POST", `/services/${id(serviceId)}/deploys`, corps, `déploiement de ${serviceId}${opts2.commitId ? ` (${opts2.commitId.slice(0, 7)})` : ""}`);
      if (!r.ok) return r;
      return { ok: true, valeur: r.valeur.statut === 202 || !r.valeur.corps ? null : deploiementDe(o(r.valeur.corps)) };
    },

    async annuler(serviceId, deployId) {
      const r = await ecrire<Brut>("POST", `/services/${id(serviceId)}/deploys/${id(deployId)}/cancel`, undefined, `annulation du déploiement ${deployId}`);
      return r.ok ? { ok: true, valeur: deploiementDe(o(r.valeur.corps)) } : r;
    },

    async rollback(serviceId, deployId) {
      const r = await ecrire<Brut>("POST", `/services/${id(serviceId)}/rollback`, { deployId }, `rollback de ${serviceId} vers ${deployId}`);
      return r.ok ? { ok: true, valeur: deploiementDe(o(r.valeur.corps)) } : r;
    },

    async journaux(q): Promise<Resultat<PageJournal>> {
      const r = await lire<Brut>("/logs", {
        ownerId: q.proprietaireId, resource: [q.serviceId], startTime: q.debut ?? undefined, endTime: q.fin ?? undefined,
        level: q.niveaux, text: q.texte, direction: "backward", limit: Math.min(Math.max(q.limite ?? 100, 1), 100),
      });
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      return { ok: true, valeur: { lignes: (Array.isArray(c.logs) ? c.logs : []).map((x) => ligneDe(o(x))), encore: c.hasMore === true, suivantDebut: s(c.nextStartTime), suivantFin: s(c.nextEndTime) } };
    },

    async nomsDesVariables(serviceId) {
      // La VALEUR arrive avec la clé (l'API n'a pas de liste « noms seuls ») : elle est jetée ici, jamais rendue.
      return tout(`/services/${id(serviceId)}/env-vars`, (x) => s(o(x.envVar).key) ?? "");
    },

    async reglerAutoDeploy(serviceId, declencheur) {
      const r = await ecrire<Brut>("PATCH", `/services/${id(serviceId)}`, { autoDeployTrigger: declencheur }, `auto-déploiement de ${serviceId} → ${declencheur}`);
      return r.ok ? { ok: true, valeur: serviceDe(o(r.valeur.corps)) } : r;
    },

    async evenement(eventId) {
      const r = await lire<Brut>(`/events/${id(eventId)}`);
      if (!r.ok) return r;
      const c = o(r.valeur.corps);
      return { ok: true, valeur: { type: s(c.type) ?? "", serviceId: s(c.serviceId), deployId: s(o(c.details).deployId) } };
    },
  };
}
