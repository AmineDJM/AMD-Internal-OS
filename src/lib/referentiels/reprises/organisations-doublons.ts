import { apercuDesDoublons, enregistrerDoublons } from "@/lib/referentiels/organisations/doublons-service";
import type { Reprise } from "./types";

/**
 * REPRISE R2 — LES DOUBLONS PROPOSÉS : toutes les organisations vivantes comparées par blocs (identifiants, nom,
 * wilaya, e-mails, téléphones). Chaque paire est enregistrée pour être tranchée par une personne
 * (Administration › Refonte des données › Doublons d'organisations). Rien n'est fusionné.
 */
export const organisationsDoublons: Reprise = {
  cle: "organisations-doublons",
  titre: "Organisations — doublons à trancher",
  description:
    "Compare les organisations entre elles (même NIF, RC ou NIS ; même raison sociale ; nom contenu dans l'autre, même "
    + "wilaya, même e-mail ou téléphone) et enregistre chaque paire, avec ses raisons, pour une décision humaine. "
    + "Une paire déjà écartée ou fusionnée n'est jamais reproposée.",
  apercu: apercuDesDoublons,
  executer: enregistrerDoublons,
};
