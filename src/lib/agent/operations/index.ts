import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { persistActionIntents } from "@/lib/assistant/action-intents";
import { SPONSORING_CREATION } from "./adpro-sponsoring";
import { PRISE_EN_CHARGE_CREATION } from "./adpro-prise-en-charge";
import { EVENEMENT_CREATION } from "./adpro-evenement";
import { MATERIEL_PROMO_CREATION } from "./adpro-materiel-promo";
import { AUTRE_CREATION, POSTE_AJOUT } from "./adpro-poste-autre";
import { estChargeOperationIA, type ChargeOperationIA, type OperationIA, type ResultatOperation } from "./types";

export type { ChargeOperationIA } from "./types";

/** LE REGISTRE — chaque geste que l'Assistant IA sait préparer. */
export const OPERATIONS_IA: OperationIA[] = [
  SPONSORING_CREATION, PRISE_EN_CHARGE_CREATION, EVENEMENT_CREATION, MATERIEL_PROMO_CREATION, AUTRE_CREATION, POSTE_AJOUT,
];

const PAR_NOM = new Map(OPERATIONS_IA.map((o) => [o.nom, o]));

/** Ce que l'agent remet à l'écran : la carte, liée à son intention persistée. */
export interface PropositionCarte {
  intentId: string;
  proposition: {
    kind: string;
    title: string;
    fields: { label: string; value: string }[];
    warnings?: string[];
    level?: "SENSITIVE" | "CRITICAL";
    confirmText?: string;
    payload?: unknown;
  };
}

/**
 * Les opérations offertes à CETTE personne, en outils. Une opération que son rôle ne permet pas
 * n'est pas même offerte ; celle qui l'est revérifie tout à l'exécution (action métier).
 */
export function outilsOperations(user: CurrentUser, propositions: PropositionCarte[]): PowerTool[] {
  return OPERATIONS_IA.filter((o) => o.ouverte(user)).map((o) => ({
    def: { name: o.nom, description: o.description, input_schema: o.schema } as PowerTool["def"],
    allowed: (u: CurrentUser) => u.id === user.id && o.ouverte(u),
    label: o.libelle,
    run: async (entree: Record<string, unknown>, u: CurrentUser) => {
      const p = await o.proposer(entree ?? {}, u);
      if ("manque" in p) {
        return JSON.stringify({
          statut: "INCOMPLET",
          manque: p.manque,
          ...(p.precision ? { precision: p.precision } : {}),
          consigne: "Pose UNE seule question à l'utilisateur : la première de `manque`. Ne propose pas de valeur que tu n'as pas lue.",
        });
      }
      if ("erreur" in p) return JSON.stringify({ statut: "REFUS", raison: p.erreur });
      const charge: ChargeOperationIA = { kind: "assistant_ia_op", op: o.nom, args: p.args };
      const [intentId] = await persistActionIntents(u.id, [{
        kind: "assistant_ia_op", module: o.module, title: p.carte.title, fields: p.carte.fields,
        ...(p.carte.level ? { level: p.carte.level } : {}), ...(p.carte.confirmText ? { confirmText: p.carte.confirmText } : {}),
        payload: charge,
      }], "text");
      if (!intentId) return JSON.stringify({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
      propositions.push({ intentId, proposition: { kind: "assistant_ia_op", ...p.carte, payload: charge } });
      return JSON.stringify({
        statut: "EN_ATTENTE_DE_CONFIRMATION",
        titre: p.carte.title,
        avertissements: p.carte.warnings,
        consigne: "Rien n'est créé : une carte récapitulative est affichée. Résume en une phrase et cite les avertissements ; ne dis jamais que c'est fait.",
      });
    },
  }));
}

/**
 * EXÉCUTER une intention de l'Assistant IA confirmée — appelé SEULEMENT par la confirmation de
 * l'Assistant IA (`confirmerIntentionAssistantIA`), sous la réclamation atomique de l'intention.
 */
export async function executerOperationIA(user: CurrentUser, charge: unknown): Promise<ResultatOperation> {
  if (!estChargeOperationIA(charge)) return { ok: false, error: "Action inconnue." };
  const o = PAR_NOM.get(charge.op);
  if (!o) return { ok: false, error: "Cette action n'existe plus." };
  if (!o.ouverte(user)) return { ok: false, error: "Vous n'avez plus le droit de faire ce geste." };
  try {
    return await o.executer(charge.args ?? {}, user);
  } catch (e) {
    console.error("[assistant-ia] exécution", charge.op, e);
    return { ok: false, error: "L'action n'a pas pu être exécutée. Réessayez dans un instant." };
  }
}
