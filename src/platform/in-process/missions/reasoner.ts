import { callModel } from "@/lib/models/gateway";
import "@/platform/ia/telemetry/usage-sink";
import { textOf, type ModelRole } from "@/lib/models/contract";
import type { Reasoner, ReasonRequest, ReasonResult } from "@/lib/missions/ports";
import { MISSION_MODEL_ROLES, type MissionModelRole } from "@/lib/missions/model/roles";
import { resumerEcarts, verifierSchema } from "@/lib/missions/planner/validate";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAISONNEUR RÉEL — l'implémentation du port, du bon côté de la frontière.
 *
 * ── OÙ CE FICHIER VIT, ET POURQUOI ICI ──────────────────────────────────────────────────
 *
 * `src/lib/models/` est le CERVEAU d'Adam (voir `boundary-scan.ts` : « le jour où Adam part, il
 * part avec »). Le Mission Runtime, lui, est une façade de l'ERP. Si le runtime importait la
 * passerelle, l'ERP dépendrait d'Adam — le couplage inverse, celui qu'aucun cliquet ne compte
 * et qui rendrait Adam indéracinable.
 *
 * Le runtime déclare donc un PORT (`Reasoner`) et cette classe l'implémente, ici, côté Adam.
 * Ce n'est pas un port fantôme : c'est la seule implémentation, elle appelle la vraie
 * passerelle, et c'est elle que le composeur branche en production.
 *
 * ── LA TRADUCTION DES RÔLES (§4) ────────────────────────────────────────────────────────
 *
 * Le runtime parle en rôles MÉTIER (`CHEAP_WORKER`, `EXCEPTIONAL_PLANNER`). La passerelle parle
 * en rôles TECHNIQUES (`bulk`, `worker`, `orchestrator`). La table ci-dessous est le seul
 * endroit qui connaît les deux — et elle est surchargeable par variable d'environnement, pour
 * qu'un modèle se remplace en exploitation et non en revue de code.
 *
 * Aucun nom de modèle n'apparaît ici non plus : la passerelle seule les connaît.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA CORRESPONDANCE PAR DÉFAUT.
 *
 * `PRIMARY_REASONER` et au-dessus vont sur l'orchestrateur, qui RAISONNE. Les deux niveaux de
 * planification y vont aussi aujourd'hui : distinguer `COMPLEX_PLANNER` d'`EXCEPTIONAL_PLANNER`
 * ne change encore rien en pratique, et c'est dit — mais la distinction EXISTE dans le runtime,
 * elle est MESURÉE, et le jour où un modèle plus capable arrive, il se branche ici en une ligne
 * sans qu'aucune règle métier ne bouge.
 */
const DEFAUT: Record<MissionModelRole, ModelRole> = {
  CHEAP_WORKER: "bulk",
  STANDARD_WORKER: "worker",
  PRIMARY_REASONER: "orchestrator",
  COMPLEX_PLANNER: "orchestrator",
  EXCEPTIONAL_PLANNER: "orchestrator",
};

/** L'effort de réflexion par rôle métier — la seconde moitié de la politique. */
const EFFORT: Record<MissionModelRole, "none" | "low" | "medium" | "high"> = {
  CHEAP_WORKER: "none",
  STANDARD_WORKER: "none",
  PRIMARY_REASONER: "medium",
  COMPLEX_PLANNER: "medium",
  EXCEPTIONAL_PLANNER: "high",
};

const TECHNIQUES: readonly ModelRole[] = ["realtime", "orchestrator", "worker", "bulk"];

/** `ADAM_MISSION_ROLE_<RÔLE>=worker` rebranche un rôle métier sans redéploiement. */
export function rolePasserelle(role: string): ModelRole {
  const metier = (MISSION_MODEL_ROLES as readonly string[]).includes(role)
    ? (role as MissionModelRole)
    : "STANDARD_WORKER";
  const surcharge = (process.env[`ADAM_MISSION_ROLE_${metier}`] ?? "").trim().toLowerCase();
  if ((TECHNIQUES as readonly string[]).includes(surcharge)) return surcharge as ModelRole;
  return DEFAUT[metier];
}

export function effortPour(role: string): "none" | "low" | "medium" | "high" {
  const metier = (MISSION_MODEL_ROLES as readonly string[]).includes(role)
    ? (role as MissionModelRole)
    : "STANDARD_WORKER";
  return EFFORT[metier];
}

/** Vrai quand une clé de fournisseur est présente. Se DIT, ne se contourne pas (§51). */
export function fournisseurConfigure(): boolean {
  return Boolean(
    (process.env.OPENAI_API_KEY ?? "").trim()
    || (process.env.ANTHROPIC_API_KEY ?? "").trim(),
  );
}

export class RaisonneurReel implements Reasoner {
  configured(): boolean {
    return fournisseurConfigure();
  }

  async reason<T>(req: ReasonRequest): Promise<ReasonResult<T>> {
    const t0 = Date.now();
    if (!this.configured()) {
      return {
        ok: false,
        data: null,
        error: "aucun fournisseur de modèle n'est configuré",
        usage: null,
        latencyMs: Date.now() - t0,
      };
    }

    const reply = await callModel(
      rolePasserelle(req.role),
      [{ role: "user" as const, content: req.prompt }],
      {
        system: req.system,
        // LE SCHÉMA EST IMPOSÉ AU FOURNISSEUR (`strict: true` côté adaptateur) : la conformité
        // est garantie par l'API, pas par la bonne volonté du modèle.
        jsonSchema: { name: nomSchema(req.schemaName), schema: req.schema },
        reasoning: effortPour(req.role),
        maxOutputTokens: req.maxOutputTokens,
        // La CLÉ DE CACHE regroupe les appels de même nature : trente-trois workers d'un même
        // éventail partagent leur consigne et leur contexte partagé, donc leur préfixe.
        promptCacheKey: `mission:${req.purpose}`,
      },
    );

    const latencyMs = Date.now() - t0;
    const usage = reply.usage
      ? {
          inputTokens: reply.usage.inputTokens,
          outputTokens: reply.usage.outputTokens,
          model: reply.usage.model,
          // La passerelle les distingue déjà ; le port les jetait. Un plan à 6 563 jetons de
          // sortie restait alors inexplicable — schéma trop lourd, ou réflexion trop longue ?
          reasoningTokens: reply.usage.reasoningTokens,
          cachedInputTokens: reply.usage.cachedInputTokens,
          costUsd: reply.usage.costUsd,
        }
      : null;

    if (!reply.ok) {
      return { ok: false, data: null, error: reply.error ?? "appel de modèle en échec", usage, latencyMs };
    }

    const brut = textOf(reply.blocks);
    if (!brut) {
      return { ok: false, data: null, error: "le modèle n'a rien rendu", usage, latencyMs };
    }

    try {
      const objet = JSON.parse(brut) as T;
      // LA CONFORMITÉ EST VÉRIFIÉE, PAS SUPPOSÉE. Le mode strict la garantit — tant qu'il est
      // réellement actif. Ce dépôt a déjà découvert deux fois un paramètre parti sans effet
      // par une erreur en production ; le contrôle est ici pour que la troisième fois se voie
      // ici plutôt que trois étapes plus loin, sur un champ manquant devenu `undefined`.
      const ecarts = verifierSchema(objet, req.schema);
      if (ecarts.length > 0) {
        return {
          ok: false,
          data: null,
          error: `réponse non conforme au schéma « ${req.schemaName} » — ${resumerEcarts(ecarts)}`,
          usage,
          latencyMs,
        };
      }
      return { ok: true, data: objet, usage, latencyMs };
    } catch {
      // ON NE RÉPARE PAS. Le schéma étant imposé, une réponse non analysable signale un vrai
      // problème (troncature, modèle mal configuré) ; la rafistoler masquerait la panne et
      // produirait un objet à moitié valide dont la suite du runtime ne se méfierait pas.
      return {
        ok: false,
        data: null,
        error: `réponse non conforme au schéma « ${req.schemaName} » (${brut.length} caractères reçus)`,
        usage,
        latencyMs,
      };
    }
  }
}

/** Le fournisseur n'accepte qu'un nom court en [a-zA-Z0-9_-]. */
function nomSchema(nom: string): string {
  return (nom.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "schema");
}

/** L'instance partagée — une seule, sans état, sûre à réutiliser partout. */
export const raisonneur = new RaisonneurReel();
