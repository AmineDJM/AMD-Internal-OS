import { DOMAINE_DE, LIBELLE_NATURE, NATURES_ORGANISATION, type NatureCoffre } from "./natures";

/**
 * QUI LIT LE COFFRE — règle PURE (aucune lecture de base), décisions de la Direction :
 *
 *  - un modèle d'IA (assistant, agent, enrichissement automatique) : JAMAIS, quelle que soit la nature ;
 *  - le Super Admin : tout (et chaque lecture est journalisée, comme les autres) ;
 *  - la personne elle-même : les siennes ;
 *  - les RH : salaires, NIN, numéros et expiration des pièces d'identité ;
 *  - les Finances : RIB et IBAN ;
 *  - une PIÈCE OFFICIELLE (devis, facture, bon de commande, ordre de virement) imprime les coordonnées
 *    bancaires d'une ORGANISATION — celles qu'elle donne pour être payée ou qu'on publie pour l'être —,
 *    au nom de qui la génère, journalisé ; jamais une donnée d'une personne (V2-E).
 *
 * Les capacités « tient les RH / les Finances » sont calculées en amont (`lecteur.ts`, qui lit le
 * RBAC) et PORTÉES ici : la règle se teste sans base, et ne recopie pas le RBAC.
 */

export type LecteurCoffre =
  | { genre: "IA"; nom: string }
  | {
      genre: "UTILISATEUR";
      userId: string;
      superAdmin: boolean;
      /** Tient le module RH (droit de modification) — pas une simple lecture d'organigramme. */
      tientRH: boolean;
      /** Tient le module Finances (droit de modification). */
      tientFinances: boolean;
    };

export type TitulaireCoffre =
  | { genre: "PERSONNE"; personneId: string; /** Compte de la personne, quand elle en a un. */ userId?: string | null }
  | { genre: "ORGANISATION"; organisationId: string };

/**
 * Ce que la politique a besoin de savoir du titulaire : son genre, et pour une personne son compte.
 * `TitulaireCoffre` s'y range ; la double lecture d'une colonne dont la fiche du référentiel n'existe
 * pas encore (un salarié sans `Personne`) n'a besoin que de ça.
 */
export type TitulaireLu =
  | { genre: "PERSONNE"; userId?: string | null }
  | { genre: "ORGANISATION" };

/** CONSULTATION : un écran, un formulaire, un export. PIECE_OFFICIELLE : une pièce générée qui imprime la valeur. */
export type UsageLecture = "CONSULTATION" | "PIECE_OFFICIELLE";

export type MotifAccord = "SUPER_ADMIN" | "TITULAIRE" | "RH" | "FINANCES" | "PIECE_OFFICIELLE";
export type MotifRefus = "MODELE_IA" | "NATURE_INCOMPATIBLE" | "HORS_PERIMETRE";

export type DecisionLecture =
  | { autorise: true; motif: MotifAccord }
  | { autorise: false; motif: MotifRefus; raison: string };

export function peutLire(
  lecteur: LecteurCoffre,
  nature: NatureCoffre,
  titulaire: TitulaireLu,
  usage: UsageLecture = "CONSULTATION",
): DecisionLecture {
  if (lecteur.genre === "IA") {
    return { autorise: false, motif: "MODELE_IA", raison: "Le coffre n'est jamais lu par un modèle d'IA." };
  }
  if (titulaire.genre === "ORGANISATION" && !NATURES_ORGANISATION.has(nature)) {
    return { autorise: false, motif: "NATURE_INCOMPATIBLE", raison: `Une organisation n'a pas de « ${LIBELLE_NATURE[nature]} ».` };
  }
  if (lecteur.superAdmin) return { autorise: true, motif: "SUPER_ADMIN" };
  if (titulaire.genre === "PERSONNE" && titulaire.userId && titulaire.userId === lecteur.userId) {
    return { autorise: true, motif: "TITULAIRE" };
  }
  const domaine = DOMAINE_DE[nature];
  if (domaine === "RH" && lecteur.tientRH) return { autorise: true, motif: "RH" };
  if (domaine === "FINANCES" && lecteur.tientFinances) return { autorise: true, motif: "FINANCES" };
  // Une organisation n'a au coffre que RIB / IBAN (vérifié plus haut) : la pièce les imprime.
  if (usage === "PIECE_OFFICIELLE" && titulaire.genre === "ORGANISATION") return { autorise: true, motif: "PIECE_OFFICIELLE" };
  return {
    autorise: false,
    motif: "HORS_PERIMETRE",
    raison: domaine === "RH"
      ? `« ${LIBELLE_NATURE[nature]} » est lu par les RH et par la personne elle-même.`
      : `« ${LIBELLE_NATURE[nature]} » est lu par les Finances${titulaire.genre === "PERSONNE" ? " et par la personne elle-même" : ""}.`,
  };
}
