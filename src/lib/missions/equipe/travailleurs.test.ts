import { describe, expect, it } from "vitest";
import { agentRoute, configManagedAgents, texteDeConsigne, travailleurCloud, travailleurManagedAgents } from "@/lib/missions/equipe/travailleurs";
import { fauxPortsDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { ConsigneDev } from "@/lib/missions/chantiers/ports-moteur";
import { planDeChantier } from "@/lib/missions/equipe/conduite";
import { lirePlanProgramme } from "@/lib/missions/equipe/programme";
import { lirePlanChantier } from "@/lib/missions/chantiers/plan";

/**
 * O2 (décision 0059 § 2) — LE PORT TRAVAILLEUR : Claude Code cloud par défaut ; Managed Agents ÉCRIT mais derrière un
 * interrupteur COUPÉ (jamais ouvert quand les sorties sont interdites, jamais un repli silencieux vers la facturation
 * API) ; ses appels HTTP vérifiés contre un faux `fetch` (aucun appel réel) : en-têtes bêta, budget en cents, interruption.
 */

const consigne: ConsigneDev = {
  depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, branche: "claude/prog-x-a", brancheBase: "main", objectif: "Faire a",
  perimetre: ["src/lib/a/**"], criteres: ["npm test -- a passe"], commandesVerif: ["npm test -- a"], chantierId: "ch1", moyenVoulu: "managed-agents",
};
const ENV_OUVERT = { EQUIPE_MANAGED_AGENTS: "1", ANTHROPIC_API_KEY: "sk-test", EQUIPE_MA_AGENT_ID: "agent_1", EQUIPE_MA_ENVIRONNEMENT_ID: "env_1", EQUIPE_MA_BUDGET_USD: "12.5", ADAM_SORTIE_AUTORISEE: "1" } as unknown as NodeJS.ProcessEnv;

function fauxFetch() {
  const appels: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    appels.push({ url, init });
    if (url.endsWith("/sessions") && init.method === "POST") return new Response(JSON.stringify({ id: "sesn_1" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/events")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ status: "running", archived_at: null, usage: { list_cost: { amount: "734", currency: "USD" } } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, appels };
}

describe("travailleurs — Claude Code cloud par défaut, Managed Agents derrière l'interrupteur", () => {
  it("l'interrupteur est COUPÉ par défaut, et reste coupé quand les sorties sont interdites (tests, bancs)", () => {
    expect(configManagedAgents({} as NodeJS.ProcessEnv)).toBeNull();
    expect(configManagedAgents({ ...ENV_OUVERT, ADAM_SORTIE_AUTORISEE: "", ADAM_SORTIE_INTERDITE: "1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(configManagedAgents({ ...ENV_OUVERT, EQUIPE_MA_AGENT_ID: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(configManagedAgents(ENV_OUVERT)).toMatchObject({ agentId: "agent_1", budgetUsd: 12.5 });
  });

  it("une consigne qui veut Managed Agents, interrupteur coupé : REFUSÉE (jamais un repli silencieux) ; les autres restent au cloud", async () => {
    const cloud = fauxPortsDev().agent;
    const { f, appels } = fauxFetch();
    const a = agentRoute(cloud, {} as NodeJS.ProcessEnv, f);
    expect(await a.lancer(consigne, "k")).toMatchObject({ ok: false, definitif: true, erreur: expect.stringMatching(/interrupteur est coupé/) });
    expect(await a.lancer({ ...consigne, moyenVoulu: undefined }, "k")).toMatchObject({ ok: true, valeur: { moyen: "routine" } });
    expect(appels).toEqual([]);
    // Sur l'abonnement, rien n'arrête une session : c'est DIT.
    expect(await travailleurCloud(cloud).arreter("s")).toMatchObject({ ok: false, erreur: expect.stringMatching(/aucune API n'arrête une session/) });
  });

  it("interrupteur ouvert : création de session (bêta, budget en cents), consigne remise, coût lu, interruption", async () => {
    const { f, appels } = fauxFetch();
    const t = travailleurManagedAgents(configManagedAgents(ENV_OUVERT)!, f);
    const l = await t.lancer(consigne, "cle-1");
    expect(l).toMatchObject({ ok: true, valeur: { sessionId: "sesn_1", moyen: "managed-agents" } });
    const [creation, message] = appels;
    expect(creation!.url).toBe("https://api.anthropic.com/v1/sessions");
    expect((creation!.init.headers as Record<string, string>)["anthropic-beta"]).toBe("managed-agents-2026-04-01");
    expect(JSON.parse(String(creation!.init.body))).toMatchObject({ agent: "agent_1", environment_id: "env_1", budget: { type: "limit", max_list_cost: { amount: "1250", currency: "USD" } } });
    expect(JSON.parse(String(message!.init.body)).events[0]).toMatchObject({ type: "user.message" });
    expect(JSON.parse(String(message!.init.body)).events[0].content[0].text).toBe(texteDeConsigne(consigne));
    expect(await t.etat("sesn_1")).toEqual({ ok: true, valeur: { statut: "travaille", coutUsd: 7.34 } });
    expect(await t.arreter("sesn_1")).toEqual({ ok: true, valeur: { arretee: true } });
    expect(JSON.parse(String(appels.at(-1)!.init.body))).toEqual({ events: [{ type: "user.interrupt" }] });
  });
});

describe("un programme ne DÉPLOIE jamais et ne FUSIONNE jamais seul", () => {
  it("le chantier d'une tâche n'a ni service, ni étape de fusion, ni déploiement ; ses ressources sont réservées", () => {
    const p = lirePlanProgramme({ titre: "P", objectif: "o", depot: { proprietaire: "a", nom: "b" }, taches: [{ cle: "a", objectif: "x", perimetre: ["prisma/**"], ressources: ["SCHEMA"], criteres: ["npm test passe sans échec"], commandesVerif: ["npm test"] }] });
    if (!p.ok) throw new Error(p.fautes.join(" "));
    const brut = planDeChantier(p.plan, p.plan.taches[0]!, "claude/prog-x-a", "prog1");
    const c = lirePlanChantier(brut);
    if (!c.ok) throw new Error(c.fautes.join(" "));
    expect(c.plan.services).toEqual([]);
    expect(c.plan.etapes.map((e) => e.type)).toEqual(["DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "RAPPORT"]);
    expect(c.plan.brancheBase).toBe("main");
    expect(c.plan.ressources).toEqual(["SCHEMA"]);
    expect(c.plan.perimetre).toEqual(expect.arrayContaining(["prisma/**", "prisma/schema.prisma", "prisma/migrations/**"]));
  });
});
