/**
 * LE CENTRE DE VALIDATIONS — le pendant du centre de paiement, côté décisions.
 *
 * ── POURQUOI UN MODULE À PART ───────────────────────────────────────────────────────────────
 *
 * Le Directeur Général et le Super Admin reçoivent des demandes de validation de tous les
 * modules : un contrat ici, une dépense là, une pièce ailleurs. Elles se noyaient dans l'écran
 * commun des validations, entre leurs propres demandes et les blocs de suivi — au point qu'on
 * découvrait une signature attendue depuis six jours en cherchant autre chose.
 *
 * Le centre de paiement a réglé le même problème pour l'argent : un écran qui ne contient QUE ce
 * qu'on attend de vous, et rien de ce que vous attendez des autres. Celui-ci fait la même chose
 * pour les décisions.
 *
 * ── QUI Y SIÈGE ─────────────────────────────────────────────────────────────────────────────
 *
 * Par DÉFAUT, le **Directeur Général** et le **Super Admin**. Pas le PDG : le centre de PAIEMENT est
 * le sien, et donner les deux à la même personne referait l'écran fourre-tout qu'on vient de découper.
 * C'est une décision d'organisation ; depuis le 24/11/2026, la console la règle personne par personne
 * (`ouvreLeCentreDeValidations`).
 *
 * Module PUR — testé, sans base ni session : cette règle décide de qui voit passer les décisions
 * de toute l'entreprise, elle doit pouvoir se lire sans rien exécuter.
 */

import { accesOuvertParLaConsole, type AccesStructurel } from "@/lib/rbac/acces-structurel";

/**
 * QUI OUVRE LE CENTRE DE VALIDATIONS — la clé `VALIDATION_CENTRE` en « Voir », telle que la console la règle, et elle seule
 * (Super Admin, 24/11/2026). C'est LA définition de « avoir accès au Centre de validations » : l'écran, le réglage du seuil
 * des bons de commande et le visa d'un document Legal la lisent, et toute règle qui dira demain « les personnes qui ont accès
 * au Centre de validations » (la décision des BV Regulatory) doit la lire aussi — jamais une liste de rôles recopiée.
 *
 * Hier, la règle était DOUBLE : le module (`requireModule`) ET le rôle principal (Directeur Général ou Super Admin). Accorder
 * le module à quelqu'un dans Administration › Accès lui donnait une entrée de menu menant à une page introuvable ; c'était la
 * console qui mentait. Le DÉFAUT reproduit exactement hier — `VALIDATION_CENTRE` est au Directeur Général et au Super Admin
 * (`PERMISSIONS`) ; la migration `modules_configurables` bloque le module à qui le tenait sans y entrer (un « autre rôle » de
 * DG, un accès coché qui n'ouvrait rien). Ensuite : accorder ouvre, bloquer ferme — un DG bloqué ne l'ouvre plus.
 *
 * Le geste est « Voir » : le centre ne montre que ce qui est ADRESSÉ à la personne, et chaque décision reste celle du
 * validateur nommé de l'étape — ouvrir le centre ne donne aucun droit de trancher pour autrui. Un geste PRÊTÉ par un intérim
 * ne compte pas (le centre n'est jamais délégué, `hr/stand-in.ts`).
 *
 * Sans accès résolu (règle appelée avec un simple `{ role }`), on lit le défaut : le Directeur Général et le Super Admin.
 */
export function ouvreLeCentreDeValidations(user: { role: string; access?: AccesStructurel }): boolean {
  const parLaConsole = accesOuvertParLaConsole(user.access, "VALIDATION_CENTRE", "VIEW");
  if (parLaConsole !== null) return parLaConsole;
  return user.role === "SUPER_ADMIN" || user.role === "GENERAL_MANAGER";
}

/**
 * À QUI ADRESSER UNE VALIDATION QU'ON ENVOIE « AU CENTRE ».
 *
 * ── POURQUOI UNE SEULE PERSONNE, ET NON LES DEUX ────────────────────────────────────────────
 *
 * Le centre est l'écran du Directeur Général ET du Super Admin. La tentation est d'adresser la
 * demande aux deux : elle apparaîtrait chez chacun. Mais une demande à deux validateurs exige
 * DEUX signatures (`mode: PARALLEL` n'approuve que lorsque toutes les étapes sont approuvées) —
 * autrement dit, deux personnes qui regardent le même écran signeraient deux fois la même
 * décision, et le dossier s'arrêterait dès que l'une est absente.
 *
 * On adresse donc au **Directeur Général**, à qui la décision revient ; à défaut de DG actif, au
 * **Super Admin**. Rien n'est perdu pour ce dernier : `decideValidation` l'autorise déjà à
 * trancher n'importe quelle étape — c'est un pouvoir qu'il détient de toute façon, et le lui
 * faire exercer explicitement vaut mieux que de le déguiser en co-signature.
 *
 * Fonction PURE : cette règle décide où part une décision d'entreprise, elle doit se lire sans
 * rien exécuter.
 */
export function centreValidatorFrom(
  candidates: readonly { id: string; role: string; isActive?: boolean }[],
): string | null {
  const actifs = candidates.filter((c) => c.isActive !== false);
  return actifs.find((c) => c.role === "GENERAL_MANAGER")?.id
    ?? actifs.find((c) => c.role === "SUPER_ADMIN")?.id
    ?? null;
}

export interface CentreValidationLike {
  actionable: boolean;
  deadline: string | null;
  createdAt: string;
}

export interface CentreCounters {
  /** Décidables MAINTENANT — c'est ce qui bloque quelqu'un. */
  aDecider: number;
  /** Assignées, mais en attente du validateur précédent. */
  aVenir: number;
  /** Échéance dépassée parmi les décidables : le chiffre qu'on regarde en premier. */
  enRetard: number;
  /** Décidables depuis plus de `dormantDays` jours, échéance ou non. */
  dormantes: number;
}

const DORMANT_DAYS = 7;

const jours = (depuis: string, maintenant: Date): number =>
  Math.floor((maintenant.getTime() - new Date(depuis).getTime()) / 86_400_000);

/**
 * CE QUE LE CENTRE AFFICHE EN TÊTE.
 *
 * « En retard » ne compte QUE les décidables : une demande qui attend le validateur précédent
 * n'est pas en retard de MON fait, et la compter ferait porter le chapeau à celui qui n'a pas
 * encore la main. « Dormantes » attrape l'autre moitié du problème — celles qui n'ont pas
 * d'échéance et que rien ne signale donc jamais.
 */
export function centreCounters(rows: readonly CentreValidationLike[], now: Date): CentreCounters {
  const decidables = rows.filter((r) => r.actionable);
  return {
    aDecider: decidables.length,
    aVenir: rows.length - decidables.length,
    enRetard: decidables.filter((r) => r.deadline !== null && new Date(r.deadline) < now).length,
    dormantes: decidables.filter((r) => jours(r.createdAt, now) >= DORMANT_DAYS).length,
  };
}

/**
 * L'ORDRE D'AFFICHAGE : ce qui bloque en premier, ce qui attend quelqu'un d'autre en dernier.
 *
 * Entre deux décidables, l'échéance tranche — et une demande SANS échéance ne passe pas devant
 * une demande datée : ne pas avoir donné de date n'est pas une urgence. À échéance égale, la
 * plus ancienne d'abord : c'est celle qui attend depuis le plus longtemps.
 */
export function sortForCentre<T extends CentreValidationLike>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    const da = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
    const db = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}
