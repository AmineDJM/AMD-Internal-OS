import { sortiesInterdites } from "@/lib/sortie/garde";
import type { AgentDeveloppeur, ConsigneDev, Resultat, SessionDev } from "@/lib/missions/chantiers/ports-moteur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT « TRAVAILLEUR » (lot O2, décision 0059 § 2) — lancer, envoyer un message à la MÊME session, lire l'état,
 * arrêter ; idempotent par clé ; coût rendu quand le fournisseur le dit.
 *
 *   • Claude Code cloud (DÉFAUT) — l'`AgentDeveloppeur` des chantiers (Routines, relais `claude --cloud`) : abonnement,
 *     un conteneur et une branche par session. Il n'a pas d'arrêt : aucune API ne tue une session cloud — c'est DIT.
 *   • Managed Agents — API Anthropic (bêta `managed-agents-2026-04-01`), facturée à l'usage, plafond dollar DUR par
 *     session (`budget.max_list_cost`, en cents). ÉCRIT, INTERRUPTEUR COUPÉ : il ne sert que si `EQUIPE_MANAGED_AGENTS=1`,
 *     une clé, un agent et un environnement sont posés — et jamais quand les sorties sont interdites (tests, bancs).
 *   • Agent SDK auto-hébergé — NON construit (décision 0059 § 2).
 *
 * Le routage se fait à la CONSIGNE : `moyenVoulu: "managed-agents"` (posé par le plan d'un programme) part chez Managed
 * Agents si l'interrupteur est ouvert, sinon il est REFUSÉ (jamais un repli silencieux vers une autre facturation).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EtatTravailleur { statut: "travaille" | "attend" | "fini" | "mort"; coutUsd: number | null }

export interface Travailleur {
  moyen: SessionDev["moyen"];
  lancer(c: ConsigneDev, cle: string): Promise<Resultat<SessionDev>>;
  envoyer(c: ConsigneDev, session: string, texte: string, cle: string): Promise<Resultat<SessionDev>>;
  etat(sessionId: string): Promise<Resultat<EtatTravailleur>>;
  arreter(sessionId: string): Promise<Resultat<{ arretee: boolean }>>;
}

const refus = (erreur: string): Resultat<never> => ({ ok: false, erreur, definitif: true });

/** L'adaptateur PAR DÉFAUT : Claude Code cloud, par l'agent des chantiers. */
export function travailleurCloud(agent: AgentDeveloppeur): Travailleur {
  return {
    moyen: "routine",
    lancer: (c, cle) => agent.lancer(c, cle),
    envoyer: (c, session, texte, cle) => agent.relancer({ ...c, probleme: texte, session, sansNouvelleSession: true }, cle),
    etat: async () => refus("Claude Code cloud : l'état d'une session ne se lit pas sur l'abonnement — GitHub fait foi (commits, checks)"),
    arreter: async () => refus("Claude Code cloud : aucune API n'arrête une session ; elle peut finir son tour, rien ne sera intégré ni déployé"),
  };
}

// ─────────────────────────────── Managed Agents (interrupteur coupé) ───────────────────────────────

const API = "https://api.anthropic.com/v1";
const BETA = "managed-agents-2026-04-01";
const VERSION = "2026-10-21";

export interface ConfigManagedAgents { cle: string; agentId: string; environnementId: string; jetonGithub: string | null; budgetUsd: number }

/** L'interrupteur : ouvert seulement par la Direction (facturation API), et jamais quand les sorties sont interdites. */
export function configManagedAgents(env: NodeJS.ProcessEnv = process.env): ConfigManagedAgents | null {
  if (env.EQUIPE_MANAGED_AGENTS !== "1" || sortiesInterdites(env)) return null;
  const cle = env.ANTHROPIC_API_KEY?.trim();
  const agentId = env.EQUIPE_MA_AGENT_ID?.trim();
  const environnementId = env.EQUIPE_MA_ENVIRONNEMENT_ID?.trim();
  if (!cle || !agentId || !environnementId) return null;
  const budget = Number(env.EQUIPE_MA_BUDGET_USD ?? "15");
  return { cle, agentId, environnementId, jetonGithub: env.EQUIPE_MA_GITHUB_TOKEN?.trim() || null, budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 100) : 15 };
}

export const managedAgentsActif = (env: NodeJS.ProcessEnv = process.env): boolean => configManagedAgents(env) !== null;

type Fetch = typeof fetch;

/** Le texte de la consigne, composé par le code (comme pour la session cloud) : objectif, périmètre, critères, commandes. */
export function texteDeConsigne(c: ConsigneDev): string {
  return [
    `Dépôt ${c.depot.proprietaire}/${c.depot.nom} — travaille sur la branche ${c.branche} (créée depuis ${c.brancheBase}), pousse-la ; n'écris jamais sur ${c.brancheBase}.`,
    `Objectif : ${c.objectif}`,
    `Périmètre (seuls fichiers autorisés) : ${c.perimetre.join(", ")}`,
    `Critères d'acceptation :\n${c.criteres.map((x) => `- ${x}`).join("\n")}`,
    `Vérifications à faire passer avant de pousser :\n${c.commandesVerif.map((x) => `- ${x}`).join("\n")}`,
    ...(c.contexte ? [c.contexte] : []),
  ].join("\n\n");
}

export function travailleurManagedAgents(cfg: ConfigManagedAgents, f: Fetch = fetch): Travailleur {
  const appel = async <T>(chemin: string, init: { method?: string; body?: unknown } = {}): Promise<Resultat<T>> => {
    try {
      const r = await f(`${API}${chemin}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", "x-api-key": cfg.cle, "anthropic-version": VERSION, "anthropic-beta": BETA },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 429 || r.status >= 500) return { ok: false, erreur: `Managed Agents : HTTP ${r.status}`, reessayerApresMs: Number(r.headers.get("retry-after") ?? 60) * 1000 };
      if (!r.ok) return { ok: false, erreur: `Managed Agents : HTTP ${r.status} ${(await r.text()).slice(0, 300)}`, definitif: true };
      return { ok: true, valeur: (r.status === 204 ? null : await r.json()) as T };
    } catch (e) {
      // Délai dépassé : la session a PU être créée — jamais relancée à l'aveugle (le reçu du chantier le garde).
      return { ok: false, erreur: `Managed Agents injoignable : ${e instanceof Error ? e.message : String(e)}`, incertain: init.method === "POST" };
    }
  };
  const message = (sessionId: string, texte: string) => appel<unknown>(`/sessions/${encodeURIComponent(sessionId)}/events`, { method: "POST", body: { events: [{ type: "user.message", content: [{ type: "text", text: texte }] }] } });
  const session = (id: string): SessionDev => ({ sessionId: id, url: `https://platform.claude.com/sessions/${id}`, lanceeLe: new Date().toISOString(), moyen: "managed-agents" });
  return {
    moyen: "managed-agents",
    lancer: async (c, cle) => {
      const cree = await appel<{ id: string }>("/sessions", {
        method: "POST",
        body: {
          agent: cfg.agentId, environment_id: cfg.environnementId, title: `Chantier ${c.chantierId} — ${c.branche}`.slice(0, 200),
          metadata: { chantier: c.chantierId, cle: cle.slice(0, 200) },
          // Le plafond DUR : en cents, chaîne entière (« 1500 » = 15,00 $), USD seul.
          budget: { type: "limit", max_list_cost: { amount: String(Math.round(cfg.budgetUsd * 100)), currency: "USD" } },
          ...(cfg.jetonGithub ? { resources: [{ type: "github_repository", url: `https://github.com/${c.depot.proprietaire}/${c.depot.nom}`, mount_path: "/workspace/repo", authorization_token: cfg.jetonGithub, checkout: { type: "branch", name: c.brancheBase } }] } : {}),
        },
      });
      if (!cree.ok) return cree;
      const m = await message(cree.valeur.id, texteDeConsigne(c));
      return m.ok ? { ok: true, valeur: session(cree.valeur.id) } : { ok: false, erreur: `session ${cree.valeur.id} créée mais consigne non remise : ${m.erreur}`, incertain: true };
    },
    envoyer: async (_c, sessionId, texte) => {
      const m = await message(sessionId, texte);
      return m.ok ? { ok: true, valeur: session(sessionId) } : m;
    },
    etat: async (sessionId) => {
      const r = await appel<{ status: string; archived_at: string | null; usage?: { list_cost?: { amount: string } } }>(`/sessions/${encodeURIComponent(sessionId)}`);
      if (!r.ok) return r;
      const statut = r.valeur.archived_at || r.valeur.status === "terminated" ? "fini" : r.valeur.status === "running" || r.valeur.status === "rescheduling" ? "travaille" : "attend";
      const cents = Number(r.valeur.usage?.list_cost?.amount ?? NaN);
      return { ok: true, valeur: { statut, coutUsd: Number.isFinite(cents) ? cents / 100 : null } };
    },
    arreter: async (sessionId) => {
      const r = await appel<unknown>(`/sessions/${encodeURIComponent(sessionId)}/events`, { method: "POST", body: { events: [{ type: "user.interrupt" }] } });
      return r.ok ? { ok: true, valeur: { arretee: true } } : r;
    },
  };
}

/**
 * L'AGENT DES CHANTIERS, ROUTÉ PAR LA CONSIGNE — ce que `portsDevBranches` rend au moteur : la consigne qui demande
 * Managed Agents y part si l'interrupteur est ouvert, sinon elle est REFUSÉE (définitif) ; toute autre reste au cloud.
 */
export function agentRoute(cloud: AgentDeveloppeur, env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): AgentDeveloppeur {
  const ma = () => { const c = configManagedAgents(env); return c ? travailleurManagedAgents(c, f) : null; };
  const coupe = "Managed Agents demandé mais l'interrupteur est coupé (EQUIPE_MANAGED_AGENTS) : décision de facturation de la Direction";
  return {
    disponible: () => cloud.disponible(),
    lancer: async (c, cle) => {
      if (c.moyenVoulu !== "managed-agents") return cloud.lancer(c, cle);
      const t = ma();
      return t ? t.lancer(c, cle) : refus(coupe);
    },
    relancer: async (c, cle) => {
      if (c.moyenVoulu !== "managed-agents") return cloud.relancer(c, cle);
      const t = ma();
      if (!t) return refus(coupe);
      return c.session ? t.envoyer(c, c.session, c.probleme, cle) : c.sansNouvelleSession ? refus("injoignable : aucune session Managed Agents connue") : t.lancer(c, cle);
    },
    ...(cloud.ordre ? { ordre: cloud.ordre.bind(cloud) } : {}),
    arreter: async (sessionId, moyen) => {
      if (moyen !== "managed-agents") return travailleurCloud(cloud).arreter(sessionId);
      const t = ma();
      return t ? t.arreter(sessionId) : refus(coupe);
    },
  };
}
