import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { getAppSettings } from "@/lib/settings";
import { auNomDe } from "../consommation";
import { SPONSORING_CREATION } from "./adpro-sponsoring";
import { PRISE_EN_CHARGE_CREATION } from "./adpro-prise-en-charge";
import { EVENEMENT_CREATION } from "./adpro-evenement";
import { MATERIEL_PROMO_CREATION } from "./adpro-materiel-promo";
import { AUTRE_CREATION, POSTE_AJOUT } from "./adpro-poste-autre";
import { BON_DE_COMMANDE } from "./bon-de-commande";
import { DEPOT_PIECE, MESSAGE_DIRECT, RELANCE, RENDEZ_VOUS, REPONSE_MESSAGE } from "./quotidien";
import { DOCUMENT_MODELE } from "./document-modele";
import { BC_DEPUIS_DEVIS } from "./bc-depuis-devis";
import { VOYAGEUR_PASSEPORT } from "./voyageur-passeport";
import { TRADUCTION } from "./traduction";
import { FORMULAIRE_PDF } from "./formulaire-pdf";
import { GERER_ROUTINE, PROGRAMMER_ROUTINE } from "./routines";
import { ENREGISTRER_ATELIER } from "./atelier-enregistrer";
import { estChargeOperationIA, type ChargeOperationIA, type OperationIA, type ResultatOperation } from "../../domaine/operations/types";
import { sansBloquer } from "@/lib/journal";


/** LE REGISTRE — chaque geste que l'Assistant IA sait préparer. */
export const OPERATIONS_IA: OperationIA[] = [
  SPONSORING_CREATION, PRISE_EN_CHARGE_CREATION, EVENEMENT_CREATION, MATERIEL_PROMO_CREATION, AUTRE_CREATION, POSTE_AJOUT,
  BON_DE_COMMANDE, BC_DEPUIS_DEVIS, VOYAGEUR_PASSEPORT,
  RELANCE, DEPOT_PIECE, RENDEZ_VOUS, REPONSE_MESSAGE, MESSAGE_DIRECT,
  DOCUMENT_MODELE, TRADUCTION, FORMULAIRE_PDF,
  PROGRAMMER_ROUTINE, GERER_ROUTINE,
  ENREGISTRER_ATELIER,
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
    libelleBouton?: string;
    payload?: unknown;
  };
}

/**
 * UNE CARTE PAR TOUR. L'écran (et le fil gardé) ne montre que LA carte du tour (`propositions[0]`) :
 * une seconde intention, préparée dans le même tour (« relance Karim et prends rendez-vous avec le
 * Dr X »), restait PROPOSÉE en base, invisible et jamais confirmable, pendant que le modèle disait
 * « deux cartes sont affichées ». Le second geste est donc refusé AVANT d'être préparé, et le dit :
 * il se préparera au tour suivant, une fois la première carte tranchée.
 */
export const REFUS_SECONDE_CARTE = JSON.stringify({
  statut: "REFUS",
  raison: "Une carte attend déjà la confirmation de l'utilisateur dans ce tour : une seule action se prépare à la fois.",
  consigne: "Ne prépare rien d'autre maintenant. Résume la carte affichée, puis dis que l'autre demande sera préparée dès que celle-ci sera confirmée ou écartée.",
});

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
      if (propositions.length > 0) return REFUS_SECONDE_CARTE;
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
export const REFUS_ARRET_URGENCE =
  "Les actions de l'assistant sont DÉSACTIVÉES (arrêt d'urgence, réglé par le Super Admin) : rien n'a été exécuté. Les lectures et analyses restent disponibles.";

export async function executerOperationIA(user: CurrentUser, charge: unknown): Promise<ResultatOperation> {
  if (!estChargeOperationIA(charge)) return { ok: false, error: "Action inconnue." };
  const o = PAR_NOM.get(charge.op);
  if (!o) return { ok: false, error: "Cette action n'existe plus." };
  // L'ARRÊT D'URGENCE (`aiExternalActionsDisabled`) vaut pour TOUTE action confirmée de l'IA, pas
  // seulement celles d'Adam (`performAction`) : chaque opération de ce registre change une donnée
  // métier ou prévient quelqu'un (demande, BC, message, rendez-vous, relance, dépôt, routine).
  // Même lecture que `performAction` — un réglage illisible ne bloque pas plus qu'il ne bloque Adam.
  const reglages = await getAppSettings().catch(sansBloquer("operations.executerOperationIA.getAppSettings", null));
  if (reglages?.aiExternalActionsDisabled) return { ok: false, error: REFUS_ARRET_URGENCE };
  if (!o.ouverte(user)) return { ok: false, error: "Vous n'avez plus le droit de faire ce geste." };
  try {
    // Une opération qui rédige (traduction, document) appelle le modèle : imputé à la personne qui confirme.
    return await auNomDe(user.id, () => o.executer(charge.args ?? {}, user));
  } catch (e) {
    console.error("[assistant-ia] exécution", charge.op, e);
    return { ok: false, error: "L'action n'a pas pu être exécutée. Réessayez dans un instant." };
  }
}
