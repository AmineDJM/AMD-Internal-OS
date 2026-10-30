/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE ASSISTANT IA — LA PORTE PURE (« Adventum Brain », ouvert à chacun selon ses droits).
 *
 * Importable PARTOUT, navigateur compris : elle ne réexporte que `domaine/` — les familles d'accès
 * réglées dans la console, les plafonds de consommation, le filtre de confidentialité, les règles de
 * lecture d'une pièce, la lecture d'une bande MRZ. Aucune base, aucun Node, aucun modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Accès : les familles que la Direction ouvre ou ferme (décision 0012, console `/admin/ai/acces`)
export {
  AIDE_FAMILLE, FAMILLES_IA, FAMILLES_SENSIBLES, familleExplicite, LIBELLE_FAMILLE, normaliserReglageFamilles,
  resoudreAccesIa, type FamilleIa, type ReglageFamilles,
} from "./domaine/acces-regles";

// ── Consommation : les plafonds par tour, par personne, par jour (console `/admin/ai/consommation`)
export { BORNES, normaliserReglages, REGLAGES_PAR_DEFAUT, type ReglagesAssistantIa } from "./domaine/consommation-regles";

// ── Confidentialité : ce qui ne part jamais au modèle (rémunération, banque, pièce d'identité)
export { censurerObjet, censurerTexte } from "./domaine/filtre-confidentialite";

// ── Pièces jointes et vocaux : règles de lecture, de dépôt, bornes
export { idsDriveCites } from "./domaine/lecture/depot";
export { DUREE_VOCAL_MAX_S, nomAnnonceLeCoffre } from "./domaine/lecture/regles";

// ── Mémoire personnelle (ce qu'une carte « Retenir » propose)
export type { MemoireProposee } from "./domaine/memoire-ui";

// ── Opérations : la charge d'une carte de l'Assistant IA ; la bande MRZ (lue aussi par l'enrichissement)
export { estChargeOperationIA } from "./domaine/operations/types";
export { casse, chiffreDeControle, lireMrz } from "./domaine/operations/mrz";

// ── Conversations et dossiers (décision 0027, Adventum IA) : groupes par date, titre, privée verrouillée
export {
  CONSIGNE_TITRE, expireLe, extraitAutour, grouperConversations, groupeDe, nettoyerTitre, ORDRE_GROUPES, PRIVEE_JOURS,
  refusChangerPrive, termeDeRecherche, TITRE_DEFAUT, titreProvisoire, type ConversationResumee, type GroupeConversation,
} from "./domaine/conversations";
export {
  CONSIGNES_DOSSIER_MAX, DOCUMENTS_DOSSIER_MAX, NOM_DOSSIER_MAX, type DocumentDuDossier, type DossierVue,
} from "./domaine/dossiers";
