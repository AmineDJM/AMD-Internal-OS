import type { CurrentUser } from "@/lib/session";
import { peutAnnuaire } from "@/lib/rbac";

/**
 * QUI TIENT L'ANNUAIRE — et pourquoi ce n'est pas tout le monde.
 *
 * L'annuaire est une donnée d'IDENTITÉ à l'échelle de l'entreprise : c'est lui qui décide à
 * quelle adresse part un message signé du PDG. Laisser n'importe quel compte y écrire, ce serait
 * offrir un moyen simple de détourner du courrier — il suffirait de changer une adresse.
 *
 * Le geste attendu est celui de l'ASSISTANTE DE DIRECTION : elle enrichit, corrige, marque une
 * adresse comme vérifiée. Elle a le module Moyens généraux, comme pour l'annuaire des
 * prestataires. La Direction et le Super Admin l'ont aussi ; les RH également, parce que ce sont
 * eux qui savent quand une adresse professionnelle change.
 *
 * Prédicats PURS, dans leur propre fichier : un module « use server » n'exporte que des fonctions
 * asynchrones, et ces règles doivent rester testables sans base ni session.
 */

/** Lire l'annuaire : tout compte actif de l'entreprise. Un annuaire secret ne sert personne. */
export function canReadDirectory(user: CurrentUser): boolean {
  return Boolean(user.id);
}

/**
 * Écrire dans l'annuaire — ajouter, corriger, désactiver une coordonnée.
 *
 * La règle vit dans `annuaires/acces.ts` (§118.147), à l'identique de ce qu'elle était ici : le
 * Super Admin et la Direction par leur rôle, l'assistante de direction et les RH par leur MODULE
 * (Moyens généraux, RH) — plus, désormais, quiconque s'est vu ouvrir l'annuaire des PERSONNES en
 * modification depuis la console. La recopier ici en ferait deux vérités, et c'est celle de
 * l'écran qu'on ne relit pas qui prendrait du retard (§118.5).
 */
export function canEditDirectory(user: CurrentUser): boolean {
  return peutAnnuaire(user, "PERSONNES", "UPDATE");
}
