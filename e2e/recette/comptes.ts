/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES COMPTES DE LA RECETTE — une personne par métier, tous préfixés `__recette__`.
 *
 * La recette utilisateur se joue « dans la peau » de chaque métier de l'entreprise (consigne du
 * Super Admin, 24/11/2026 : « le contrôle final, c'est aussi des tests user »). Un métier n'est pas
 * toujours un rôle : la RH, la comptabilité et le caissier sont des comptes ordinaires à qui l'on
 * ouvre UN module par la grille des accès (`UserAccess`), exactement comme en production ; le KAM est
 * un délégué médical rattaché à une BU (`SalesRepProfile`) ; le superviseur est le Manager Promotion
 * Médicale désigné superviseur de cette BU. Décrire le métier ici, une fois, évite que chaque parcours
 * le recompose à sa façon.
 *
 * DONNÉES DE TEST, JAMAIS DE PRODUCTION : la graine refuse une base qui n'est pas locale
 * (`seed.ts`), et tout ce qu'elle pose porte le préfixe — le nettoyage le retrouve sans ambiguïté.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe de TOUT ce que la recette pose en base (comptes, société, ordres, dossiers…). */
export const P = "__recette__";

/** Le mot de passe commun des comptes de recette — local, jamais communiqué hors du banc. */
export const MOT_DE_PASSE = process.env.RECETTE_MOT_DE_PASSE ?? "Recette!MotDePasse#2026";

/** La société de test : tous les comptes y ont accès (le cloisonnement se teste avec la seconde). */
export const SOCIETE = { nom: `${P} Adventum Pharma TEST`, court: "RECETTE-ADV" } as const;
/** Une seconde société, que seuls le Super Admin et le DG voient — pour les contrôles de cloisonnement. */
export const SOCIETE_FERMEE = { nom: `${P} Pharmagène TEST`, court: "RECETTE-PHG" } as const;

export type CleDepartement =
  | "DG" | "OPERATIONS" | "MARKETING" | "FINANCES" | "MOYENS_GENERAUX" | "RH" | "REGULATORY" | "INFO_MED" | "INFORMATIQUE";

export const DEPARTEMENTS: Record<CleDepartement, { nom: string; code: string }> = {
  DG: { nom: `${P} Direction générale`, code: "RCT-DG" },
  OPERATIONS: { nom: `${P} Opérations`, code: "RCT-OPS" },
  MARKETING: { nom: `${P} Marketing`, code: "RCT-MKT" },
  FINANCES: { nom: `${P} Finances`, code: "RCT-FIN" },
  MOYENS_GENERAUX: { nom: `${P} Administration — moyens généraux`, code: "RCT-ADM" },
  RH: { nom: `${P} Ressources humaines`, code: "RCT-RH" },
  REGULATORY: { nom: `${P} Regulatory`, code: "RCT-REG" },
  INFO_MED: { nom: `${P} Information médicale`, code: "RCT-IM" },
  INFORMATIQUE: { nom: `${P} Informatique`, code: "RCT-IT" },
};

/** Un module ouvert à la personne par la grille des accès (en plus de ce que son rôle donne). */
export interface AccesModule {
  module: string;
  creer?: boolean;
  modifier?: boolean;
  valider?: boolean;
  deposer?: boolean;
}

export interface Persona {
  /** Le métier, tel que le cahier de recette le nomme. */
  metier: string;
  role: string;
  /** Département de rattachement (fiche salarié + compte). */
  departement: CleDepartement;
  /** Responsable de son département dans l'organigramme (« Directeur » au sens du Super Admin, 24/11). */
  responsable?: boolean;
  /** Clé de la persona qui est son supérieur hiérarchique (N+1). */
  superieur?: CleCompte;
  acces?: AccesModule[];
}

export type CleCompte =
  | "superAdmin" | "dg" | "dirOps" | "dirMarketing" | "finances" | "comptable" | "assistante" | "rh"
  | "regulatory" | "pharmacienIM" | "delegue" | "kam" | "superviseur" | "caissier";

export const COMPTES: Record<CleCompte, Persona> = {
  superAdmin: { metier: "Super Admin", role: "SUPER_ADMIN", departement: "DG" },
  dg: { metier: "Directeur général", role: "GENERAL_MANAGER", departement: "DG", responsable: true },
  dirOps: { metier: "Directeur des opérations", role: "OPERATIONS_DIRECTOR", departement: "OPERATIONS", responsable: true, superieur: "dg" },
  dirMarketing: { metier: "Direction Marketing", role: "PRODUCT_MANAGER", departement: "MARKETING", responsable: true, superieur: "dg" },
  finances: { metier: "Finances / Banque", role: "FINANCE_BUDGET_MANAGER", departement: "FINANCES", responsable: true, superieur: "dg" },
  // La comptabilité : un compte ordinaire à qui l'on ouvre le seul module « Comptabilité » — il ne paie pas.
  comptable: {
    metier: "Comptabilité", role: "VIEWER", departement: "FINANCES", superieur: "finances",
    acces: [{ module: "FINANCES_COMPTABILITE", creer: true, modifier: true, deposer: true }],
  },
  assistante: { metier: "Assistante de direction / secrétariat", role: "DIRECTION_ASSISTANT", departement: "DG", superieur: "dg" },
  // La RH : assistante de rôle, module RH ouvert par la grille (c'est ainsi qu'elle existe en production).
  rh: {
    metier: "RH", role: "DIRECTION_ASSISTANT", departement: "RH", responsable: true, superieur: "dg",
    acces: [{ module: "RH", creer: true, modifier: true, valider: true, deposer: true }, { module: "TRAINING", creer: true, modifier: true }],
  },
  regulatory: { metier: "Responsable réglementaire", role: "HEAD_OF_REGULATORY", departement: "REGULATORY", responsable: true, superieur: "dirOps" },
  pharmacienIM: { metier: "Pharmacien information médicale", role: "MEDICAL_INFO_PHARMACIST", departement: "INFO_MED", responsable: true, superieur: "dirOps" },
  superviseur: { metier: "Superviseur (force de vente)", role: "MEDICAL_PROMOTION_MANAGER", departement: "OPERATIONS", superieur: "dirOps" },
  delegue: { metier: "Délégué médical", role: "MEDICAL_DELEGATE", departement: "OPERATIONS", superieur: "superviseur" },
  kam: { metier: "KAM", role: "MEDICAL_DELEGATE", departement: "OPERATIONS", superieur: "superviseur" },
  // Le caissier des moyens généraux : la personne qui tient la caisse d'avance et confirme la réception des remises.
  caissier: {
    metier: "Caissier / moyens généraux", role: "DIRECTION_ASSISTANT", departement: "MOYENS_GENERAUX", superieur: "assistante",
    acces: [{ module: "GENERAL_MEANS", creer: true, modifier: true, deposer: true }],
  },
};

export const emailDe = (cle: CleCompte): string => `${P}${cle.toLowerCase()}@recette.test`;
export const nomDe = (cle: CleCompte): string => `${P} ${COMPTES[cle].metier}`;

/** La BU de test, supervisée par le superviseur, où le délégué et le KAM sont rattachés. */
export const BU = { nom: `${P} BU Cardio-Diabète`, code: "RCT-BU" } as const;
