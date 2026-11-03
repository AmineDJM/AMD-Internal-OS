import type { AccesIa } from "./acces-regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PROFIL D'ACCÈS — UN SEUL MOTEUR, DES ACCÈS (lot I2, décision 0064 ; audit AU3 du 03/11/2026, étape 1).
 *
 * La Direction (03/11) : « Je veux vraiment que ce soit la même architecture, le même truc. C'est juste les accès qui
 * changent : le super admin a accès à WhatsApp, à Gmail et à d'autres choses, les autres moins. »
 *
 * CETTE TABLE EST LA SEULE RÈGLE « QUI A QUOI » DU MODULE. Elle remplace les trois prédicats qui disaient chacun à leur
 * façon « c'est le Super Admin » (`adamOuvert`, `canalAdamOuvert`, `role === "SUPER_ADMIN"` en ligne — 21 fichiers
 * mesurés par AU3) : ils LISENT désormais ce profil. Un test (`profil-acces.test.ts`) interdit toute comparaison du rôle
 * au Super Admin ailleurs dans `src/modules/assistant-ia`.
 *
 *   • FAMILLES (S1, décision 0012/0048) et BASES (D2–D5, décision 0057) : `AccesIa`, déjà résolu par la console
 *     (`accesAssistantIa`) — le profil le porte, il ne le recalcule pas. Attention : une base fermée rend
 *     `familles.superAdmin` faux pour un Super Admin (souveraineté perdue sur ces familles) ; le profil, lui, garde
 *     `superAdmin` = le RÔLE — les deux ne se confondent pas.
 *   • CANAUX d'envoi : l'envoi de l'ERP, la boîte Microsoft et la boîte SMTP de la personne (leur ÉTAT — reliée ou non —
 *     se lit ailleurs, ce n'est pas un accès), le Gmail d'Adam et WhatsApp (Super Admin seul). La RÉCEPTION de pièces par
 *     WhatsApp ou mail (`attendre_pieces`, décision 0036) n'est pas un canal d'envoi : elle ne figure pas ici.
 *   • CATALOGUES : les fonctions de l'ancien Adam (par la porte, décision 0055) et les chantiers / programmes (O2).
 *   • VUE EXACTE (S1, décision 0048) : tout est fermé — l'assistant ne joue pas sous une identité vue.
 *   • ARRÊT D'URGENCE (réglé par le Super Admin) : aucune action confirmée de l'IA ne s'exécute ; les lectures restent.
 *
 * PUR et ÉCHEC FERMÉ : aucune entrée illisible n'ouvre rien ; seul le rôle PRINCIPAL compte (un rôle secondaire de
 * Super Admin n'ouvre rien). Un outil fermé par ce profil n'est PAS OFFERT — et n'est jamais décrit en prose au modèle.
 * La porte d'Adam (`platform/in-process/porte-assistant-ia.ts`) garde sa propre relecture : défense en profondeur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le rôle qui ouvre tout — écrit UNE fois dans le module. */
const ROLE_SUPER_ADMIN = "SUPER_ADMIN";

export const CANAUX_ENVOI = ["erp", "microsoft", "smtp", "gmailAdam", "whatsapp"] as const;
export type CanalEnvoi = (typeof CANAUX_ENVOI)[number];

/** Ce que le profil lit du compte — un sous-ensemble de la session (aucune base, aucun réseau). */
export interface CompteProfil {
  role?: unknown;
  impersonatedBy?: unknown;
  visualise?: unknown;
}

export interface ProfilDAcces {
  /** Le Super Admin EN PERSONNE : rôle principal, hors Vue exacte. */
  superAdmin: boolean;
  /** Une identité vue (impersonation) ou un Super Admin qui en visualise une autre : l'assistant ne joue pas. */
  vueExacte: boolean;
  /** L'arrêt d'urgence : aucune action confirmée de l'IA ne s'exécute (les lectures et analyses restent). */
  arretUrgence: boolean;
  /** Les actions confirmées peuvent-elles s'exécuter ? (ni Vue exacte, ni arrêt d'urgence) */
  gestesExecutables: boolean;
  /** Familles S1 + bases D2–D5 du tour (`accesAssistantIa`) ; `null` hors d'un tour (le compte seul). */
  familles: AccesIa | null;
  canaux: Readonly<Record<CanalEnvoi, boolean>>;
  catalogues: Readonly<{ adam: boolean; chantiers: boolean }>;
}

/** Ce que le tour ajoute au compte : les familles relues dans la console, l'arrêt d'urgence lu dans les réglages. */
export interface EntreesProfil {
  familles?: AccesIa | null;
  arretUrgence?: boolean | null;
}

/**
 * LE RÔLE PRINCIPAL EST-IL SUPER ADMIN ? — la seule comparaison du rôle au Super Admin dans le module. Le rôle seul,
 * sans la clause de Vue exacte : c'est la règle des consoles d'administration et des portes d'écran, qui jugent elles-mêmes
 * l'impersonation (où le rôle est déjà celui du compte vu). Pour le moteur, lire `profilDAcces(...).superAdmin`.
 */
export const roleSuperAdmin = (c: CompteProfil | null | undefined): boolean => !!c && typeof c === "object" && c.role === ROLE_SUPER_ADMIN;

/** Une identité vue ou visualisée — le même juge que `enVueExacteIa` (S1). */
const enVueExacte = (c: CompteProfil): boolean => Boolean(c.impersonatedBy || c.visualise);

/** Le profil fermé : ce que reçoit une entrée illisible, et la Vue exacte. */
const FERME: ProfilDAcces = Object.freeze({
  superAdmin: false, vueExacte: false, arretUrgence: false, gestesExecutables: false, familles: null,
  canaux: Object.freeze({ erp: false, microsoft: false, smtp: false, gmailAdam: false, whatsapp: false }),
  catalogues: Object.freeze({ adam: false, chantiers: false }),
});

/** LE PROFIL D'ACCÈS — calculé une fois par tour (`fil/tour.ts`), ou pour un compte seul (les prédicats ci-dessous). */
export function profilDAcces(c: CompteProfil | null | undefined, e: EntreesProfil = {}): ProfilDAcces {
  if (!c || typeof c !== "object") return FERME;
  const vueExacte = enVueExacte(c);
  if (vueExacte) return { ...FERME, vueExacte: true };
  const superAdmin = roleSuperAdmin(c);
  const arretUrgence = e.arretUrgence === true;
  return {
    superAdmin,
    vueExacte: false,
    arretUrgence,
    gestesExecutables: !arretUrgence,
    familles: e.familles ?? null,
    canaux: { erp: true, microsoft: true, smtp: true, gmailAdam: superAdmin, whatsapp: superAdmin },
    catalogues: { adam: superAdmin, chantiers: superAdmin },
  };
}

/**
 * LE CACHE DU COMPTE — le profil d'un même objet de session se calcule une fois (les prédicats sont appelés dans chaque
 * `allowed` des outils). Une session est un objet neuf à chaque requête : aucun profil ne survit à un changement de rôle.
 */
const PARCOMPTE = new WeakMap<object, ProfilDAcces>();
export function profilDuCompte(c: CompteProfil | null | undefined): ProfilDAcces {
  if (!c || typeof c !== "object") return FERME;
  let p = PARCOMPTE.get(c);
  if (!p) { p = profilDAcces(c); PARCOMPTE.set(c, p); }
  return p;
}

/** Le catalogue de l'ancien Adam (porte, décision 0055) est-il ouvert à ce compte ? */
export const catalogueAdamOuvert = (c: CompteProfil | null | undefined): boolean => profilDuCompte(c).catalogues.adam;
/** Un canal d'envoi est-il ouvert à ce compte ? */
export const canalOuvert = (c: CompteProfil | null | undefined, canal: CanalEnvoi): boolean => profilDuCompte(c).canaux[canal];
/** Les chantiers et programmes (O2) sont-ils ouverts à ce compte ? */
export const chantiersOuverts = (c: CompteProfil | null | undefined): boolean => profilDuCompte(c).catalogues.chantiers;

/**
 * LES GESTES RÉSERVÉS PAR LE PROFIL — un geste qui n'existe que pour un canal ou un catalogue fermé à la personne. Il n'est
 * pas « fermé » pour elle : il N'EXISTE PAS. Le refus nommé (`trouver_outil`) ne le cite donc jamais (décision 0055 : « un
 * employé n'entend jamais parler d'une fonction réservée »).
 */
export const GESTES_RESERVES: Readonly<Record<string, (p: ProfilDAcces) => boolean>> = {
  envoyer_gmail: (p) => p.canaux.gmailAdam,
};
export const gesteReserveFerme = (nom: string, p: ProfilDAcces): boolean => {
  const ouvre = GESTES_RESERVES[nom];
  return ouvre !== undefined && !ouvre(p);
};

