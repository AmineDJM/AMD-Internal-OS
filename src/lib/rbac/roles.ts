/**
 * RBAC — les PRÉDICATS DE RÔLE, sans accès résolu : vue globale, sommet, missions et visibilité
 * d'Adam, rôle principal ou secondaire, défauts de matrice (`can`), recrutement, portée par défaut.
 * Réexporté par la porte `lib/rbac`.
 */

import type { AccessScope, Prisma, UserRole } from "@prisma/client";
import type { Action, Module } from "./modules";
import { MANAGE } from "./gestes";
import { PERMISSIONS } from "./permissions";

const GLOBAL_VIEW_ROLES: UserRole[] = ["SUPER_ADMIN", "DIRECTION"];

/** Type minimal « porteur de rôles » : rôle principal + éventuel rôle secondaire. */
type RoleBearer = { role: UserRole; secondaryRole?: UserRole | null };

/**
 * Vue globale (voit tout / valide comme la Direction). Accepte un **rôle brut**
 * (rétrocompatible) OU un **utilisateur** — auquel cas le **rôle secondaire** est
 * aussi pris en compte (ex. un compte dont l'« autre rôle » est Direction).
 */
export function hasGlobalView(u: UserRole | RoleBearer): boolean {
  if (typeof u === "string") return GLOBAL_VIEW_ROLES.includes(u);
  return GLOBAL_VIEW_ROLES.includes(u.role) || (u.secondaryRole != null && GLOBAL_VIEW_ROLES.includes(u.secondaryRole));
}

/**
 * LE SOMMET DE LA MAISON — celui qui tranche en dernier ressort.
 *
 * Plus large que `hasGlobalView` d'un cran : le Directeur Général en fait partie. Il est
 * délibérément hors de la vue globale (il ne supervise pas les validations de tout le monde, il
 * ne lit pas les Drive privés), mais sur les décisions d'ENTREPRISE — arbitrer un recrutement,
 * choisir entre deux candidats — il est précisément la personne qu'on appelle « le PDG ».
 *
 * Sert d'OUTREPASSE, jamais de raccourci : la chaîne de validation d'un recrutement est
 * calculée sur l'organigramme réel, et son dernier échelon est le vrai sommet, quel que soit son
 * rôle applicatif. Ce prédicat ne fait que permettre de trancher quand un maillon est absent —
 * exactement la période où les demandes s'accumulent.
 */
export function isTopManagement(u: UserRole | RoleBearer): boolean {
  const tops: UserRole[] = ["SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER"];
  if (typeof u === "string") return tops.includes(u);
  return tops.includes(u.role) || (u.secondaryRole != null && tops.includes(u.secondaryRole));
}

/**
 * ═══════════════════════════════════════════════════════════
 * LES MISSIONS D'ADAM SONT RÉSERVÉES AU SUPER ADMIN — décision de la Direction (09/2026).
 *
 * Une mission est un moteur durable : elle planifie, exécute, attend, relance, écrit et notifie
 * SANS session, au nom de son propriétaire, pendant des jours. Une surveillance (`watch_entity`)
 * est le même moteur avec une seule règle. La Direction a tranché : ce pouvoir-là n'appartient
 * qu'au compte souverain. Tout le reste d'Adam — lire, agir sur confirmation, rappels datés,
 * tâches, engagements — reste ouvert selon les droits ordinaires.
 *
 * ── UN PRÉDICAT, ET UN SEUL ─────────────────────────────────────────────────────────
 *
 * Écrans (`/centre-de-missions`, `/missions/<id>`), actions serveur, outils de conversation,
 * entrée de menu, moteur (`lancerMission`, `creerSurveillance`), interrupteur et battement le
 * lisent tous ICI. Deux copies de « qui peut » finiraient par diverger, et le symptôme serait un
 * écran qui montre une mission qu'une action refuse — ou l'inverse (§118.5, §118.71).
 *
 * ── POURQUOI LE RÔLE PRINCIPAL, ET LUI SEUL ─────────────────────────────────────────
 *
 * `hasGlobalView` accepte un rôle secondaire : voir tout est une casquette qu'on prête. Piloter
 * un moteur autonome au nom d'un compte n'en est pas une : le Super Admin est un COMPTE, pas une
 * fonction déléguée, et une casquette secondaire ne l'ouvre pas.
 *
 * ── CE QUE LA RÈGLE FAIT DES MISSIONS DÉJÀ LANCÉES PAR D'AUTRES ────────────────────────
 *
 * Le battement relit le propriétaire à chaque passage (§118.119b) : une mission dont le
 * propriétaire n'est pas Super Admin passe en PAUSE — jamais supprimée, avec son motif au
 * journal — parce qu'une planification ne doit pas être une permission qui survit à la règle.
 * ═══════════════════════════════════════════════════════════
 */
export function peutPiloterMissionsAdam(u: UserRole | RoleBearer): boolean {
  return (typeof u === "string" ? u : u.role) === "SUPER_ADMIN";
}

/** Le refus, écrit UNE fois — écran, action, outil et moteur disent la même phrase. */
export const REFUS_MISSIONS_ADAM = "Les missions et surveillances d'Adam sont réservées au Super Admin.";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM N'EST VISIBLE QUE DU SUPER ADMIN — décision de la Direction (09/2026, §118.153).
 *
 * « Adam ne doit être visible par personne sauf le super admin ; Adam en tant que chief of staff
 * est en pause de développement. » L'assistant de conversation, le bureau du chief of staff, la
 * voix, le brief du matin et la question posée depuis la palette sont UN seul produit : le
 * masquer d'un côté et le laisser de l'autre ferait une porte fermée à côté d'une porte ouverte
 * (§118.71). Menu, pages, points d'entrée d'API, voix et brief lisent CE prédicat.
 *
 * La règle est celle des missions (le rôle PRINCIPAL, jamais une casquette secondaire), et elle
 * l'ÉLARGIT : les missions sont une partie d'Adam. Ce qui reste ouvert à tous est ce qui n'est PAS
 * Adam — les écrans de l'ERP, et les fonctions d'IA qu'un écran appelle pour son propre compte
 * (OCR, transcription d'un rapport terrain, fabrique de documents depuis un bouton).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function peutVoirAdam(u: UserRole | RoleBearer): boolean {
  return peutPiloterMissionsAdam(u);
}

/** Le refus, écrit UNE fois — une action serveur d'Adam appelée hors de son écran dit cette phrase. */
export const REFUS_ADAM = "Adam est réservé au Super Admin.";

/** L'utilisateur porte-t-il ce rôle, en **principal OU en secondaire** ? */
export function hasRole(u: RoleBearer, role: UserRole): boolean {
  return u.role === role || u.secondaryRole === role;
}

/**
 * Superviseur Regulatory : le **Super Admin** (toujours) OU un rôle **configuré en
 * Administration** (`AppSetting.regulatorySupervisorRoles`), porté en principal OU
 * secondaire. Il fixe la **priorité** et les **dates cibles** des dossiers, reçoit les
 * notifications (nouveau dossier à prioriser / dossier déposé) et peut **demander des
 * mises à jour de statut**. Les rôles sont passés depuis les réglages (pas en dur).
 */
export function isRegulatorySupervisor(u: RoleBearer, supervisorRoles: string[]): boolean {
  if (u.role === "SUPER_ADMIN") return true;
  return supervisorRoles.includes(u.role) || (u.secondaryRole != null && supervisorRoles.includes(u.secondaryRole));
}

/** Filtre Prisma « porte l'un de ces rôles » — principal **OU secondaire**. À utiliser
 *  pour TOUTE sélection d'utilisateurs par rôle (notifications, candidats désignables,
 *  pharmacien PRIM, annuaires…), sinon un rôle attribué en secondaire est ignoré. */
/**
 * Les rôles dont la matrice donne au moins la VUE sur un module.
 *
 * Sert à dresser « les personnes concernées par X » sans deviner : c'est la même matrice qui
 * gouverne l'accès à l'écran, on ne réinvente pas une liste en parallèle qui divergerait au
 * premier réglage.
 */
export function rolesWithModule(module: Module, action: Action = "VIEW"): UserRole[] {
  return (Object.keys(PERMISSIONS) as UserRole[]).filter((r) => (PERMISSIONS[r][module] ?? []).includes(action));
}

export function anyRoleFilter(roles: UserRole[]): Prisma.UserWhereInput {
  return { OR: [{ role: { in: roles } }, { secondaryRole: { in: roles } }] };
}

// ─────────── Demandes à Regulatory (émission → prise en charge) ───────────
/** Role-default check (baseline, ignores per-user overrides). */
export function can(role: UserRole, module: Module, action: Action): boolean {
  return PERMISSIONS[role]?.[module]?.includes(action) ?? false;
}

/**
 * QUI VOIT TOUT LE BUREAU DU SECRÉTARIAT, au-delà de ses propres demandes.
 *
 * Ceux qui PAIENT et ceux qui CONTRÔLENT : une mission chauffeur, un achat de fournitures, une
 * prestation, un visa d'invité finissent tous en décaissement ou au dossier du personnel. Ne
 * montrer au DRH et aux Finances que « leurs » demandes revenait à leur faire valider des
 * dépenses dont ils ne voyaient ni l'origine, ni les pièces, ni le circuit.
 *
 * Il faut TENIR le module, pas seulement le lire : une lecture des RH accordée à quelqu'un pour
 * consulter un organigramme n'ouvre pas le courrier de toute l'entreprise.
 *
 * Portée de LECTURE uniquement — le bureau reste tenu par l'assistante de direction. Voir n'est
 * pas instruire.
 */
/**
 * L'ACCÈS AU MODULE RECRUTEMENT — dicté par l'ORGANIGRAMME, pas par une liste de rôles.
 *
 * « Chaque directeur de département a le droit de demander un recrutement » : la condition est
 * FACTUELLE (diriger un département), pas nominale. Un « Responsable Logistique » qui ne dirige
 * rien n'a pas à demander de poste ; quelqu'un dont le rôle ne dit rien de particulier mais qui
 * tient un service en a besoin. Écrire une liste de rôles serait donc faux dans les deux sens, et
 * fausse dès la première réorganisation.
 *
 * L'ADJOINT compte comme le responsable : c'est lui qui tient le service quand l'autre est
 * absent, et un recrutement ne s'arrête pas pendant les congés du directeur.
 *
 * Les RH obtiennent le module ENTIER : ce sont eux qui instruisent, publient et intègrent.
 *
 * Et TOUT LE MONDE peut demander (Direction, 07/10 — « n'importe qui peut demander un nouveau
 * recrutement ») : VIEW + CREATE + UPLOAD, portée ASSIGNED — on voit ce dont on est partie, rien
 * d'autre. Le chef de département garde son jeu plus large, les RH le module entier.
 *
 * Fonction PURE — les faits (dirige-t-il un département ? tient-il les RH ?) sont établis par
 * l'appelant ; la règle, elle, est ici et se teste.
 */
export function recruitmentAccessFor(caps: {
  headsDepartment: boolean;
  rhCanUpdate: boolean;
}): { actions: Action[]; scope: AccessScope } {
  if (caps.rhCanUpdate) return { actions: [...MANAGE], scope: "ALL" };
  // Le demandeur voit SES demandes — pas celles des autres départements. Ce qu'un directeur
  // recrute ailleurs ne le regarde pas, et une fourchette de rémunération est une information
  // sensible qui n'a aucune raison de circuler entre pairs.
  if (caps.headsDepartment) return { actions: ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"], scope: "ASSIGNED" };
  // N'IMPORTE QUI PEUT DEMANDER UN RECRUTEMENT (Direction, 07/10) — la demande part à son N+1 et remonte
  // jusqu'au DG. Demander, joindre sa fiche de poste, et voir CE dont on est partie (`recruitmentScope` :
  // ses demandes, celles qu'on valide ou qu'on suit) : rien de plus. Un blocage dans la console prime.
  return { actions: ["VIEW", "CREATE", "UPLOAD"], scope: "ASSIGNED" };
}

export function seesWholeSecretariat(caps: { rhCanUpdate: boolean; financeCanUpdate: boolean }): boolean {
  return caps.rhCanUpdate || caps.financeCanUpdate;
}

/** Default row scope for a role on a module (ALL vs only assigned rows). */
export function defaultScope(role: UserRole, module: Module): AccessScope {
  if (hasGlobalView(role)) return "ALL";
  // Drive defaults to per-user scope: one only sees one's own and shared files.
  if (module === "DRIVE") return "ASSIGNED";
  // Admin requests : ceux qui PILOTENT le secrétariat les voient toutes (ALL) — l'Assistante
  // de Direction, et les deux directions qui gèrent le module. Les autres ne voient que les
  // leurs (l'admin peut élargir via un override).
  if (module === "ADMIN_REQUESTS") {
    return (["DIRECTION_ASSISTANT", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR"] as UserRole[]).includes(role) ? "ALL" : "ASSIGNED";
  }
  // Information médicale : le pharmacien responsable voit tout ; les autres (Direction
  // exceptée via hasGlobalView) ne voient que les déclarations où une pièce leur est demandée.
  // Le Directeur des Opérations, qui tranche tout ce que le pharmacien fait valider, voit tout aussi.
  if (module === "MEDICAL_INFO") return role === "MEDICAL_INFO_PHARMACIST" || role === "OPERATIONS_DIRECTOR" ? "ALL" : "ASSIGNED";
  // Directives : chacun ne voit que celles qui le concernent (la Direction voit tout via ALL).
  if (module === "DIRECTIVES") return "ASSIGNED";
  // Demandes de support : chacun ne voit que ce qu'il a émis / reçu (rôle visé) / pris en charge.
  if (module === "SUPPORT") return "ASSIGNED";
  // Dossiers de suivi : chacun ne voit que les dossiers créés / dont il est responsable / où il participe.
  if (module === "DOSSIERS") return "ASSIGNED";
  // Pharmacovigilance (Direction, 06/10) : la boîte entière à qui tient Regulatory ; les autres (le KAM qui signale)
  // ne lisent que leurs signalements et les cas où on les a ajoutés.
  if (module === "PHARMACOVIGILANCE") return PERMISSIONS[role]?.REGULATORY?.includes("VIEW") ? "ALL" : "ASSIGNED";
  const assigned: Partial<Record<Module, UserRole[]>> = {
    REGULATORY: ["REGULATORY_ASSISTANT"],
    // Le pipeline suit la portée de Regulatory (Direction, 08/10) : l'assistante n'y voit que les dossiers où elle est nommée.
    REGULATORY_PIPELINE: ["REGULATORY_ASSISTANT"],
    SALES: ["SALES_USER"],
    MEDICAL: ["MEDICAL_DELEGATE"],
    // Rapports terrain : le délégué ne voit QUE les siens ; le National Sales (superviseur
    // national) est volontairement absent → portée ALL, il voit tous les rapports des délégués.
    FIELD_REPORTS: ["MEDICAL_DELEGATE"],
    CONGRESS_INTERNATIONAL: ["MEDICAL_DELEGATE"],
    CONGRESS_NATIONAL: ["MEDICAL_DELEGATE"],
    // Matériel promotionnel (§118.153) : le délégué et le superviseur national DEMANDENT — ils
    // voient leurs dossiers, et ceux où le circuit les attend s'ouvrent par la règle du dossier.
    PROMO_MATERIAL: ["MEDICAL_DELEGATE", "NATIONAL_SALES"],
    // Stock promotionnel (§118.164) : la force de vente voit SON stock et celui de son équipe ;
    // les autres porteurs du module (Direction, Direction Marketing, directeur des opérations,
    // Finances) ont la vue globale. La console élargit ou resserre personne par personne.
    PROMO_STOCK: ["MEDICAL_DELEGATE", "NATIONAL_SALES", "MEDICAL_PROMOTION_MANAGER"],
    // Sponsoring (audit 360°, I4) : le délégué DEMANDE et ne voit que ses demandes ; le National
    // Sales, absent, les voit toutes — c'est lui qui en instruit l'étape préliminaire.
    SPONSORING: ["MEDICAL_DELEGATE"],
    // « Autre » (27/10/2026) : même règle que le sponsoring — le délégué ne voit que ses demandes.
    AD_PRO_OTHER: ["MEDICAL_DELEGATE"],
    // Segmentation Studio : le KAM ne voit et ne renseigne que SON panel (secteur ∪ rattachement).
    SEGMENTATION: ["MEDICAL_DELEGATE"],
  };
  return assigned[module]?.includes(role) ? "ASSIGNED" : "ALL";
}
