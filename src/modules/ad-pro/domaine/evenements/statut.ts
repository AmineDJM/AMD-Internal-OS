/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉTAT D'UN ÉVÉNEMENT — module PUR (zéro import), parce que TROIS couches le lisent.
 *
 * ── LE DÉFAUT QU'IL FERME (demande de la Direction, 09/2026) ────────────────────────────
 *
 * « Des fois un événement n'est pas encore validé et pourtant son état est validé, répare ça ! »
 *
 * Mesuré : un événement portait DEUX vérités sur la même question. `Event.status` se saisissait
 * À LA MAIN dans le formulaire « Modifier » (`inEnum(EventStatus, fdStr(formData, "status"))`,
 * `createEvent` et `updateEvent`), et `Event.requestStatus` portait la décision du CIRCUIT de
 * prise en charge. N'importe qui avec le droit EVENTS:UPDATE pouvait donc écrire « Validé »
 * pendant que le circuit n'avait rien tranché — et c'est la première qui s'affichait, en gros,
 * sur la fiche. Le faux succès parfait : aucune erreur, aucune étape en échec, un badge vert.
 *
 * C'est §118.5 dans sa forme la plus coûteuse : deux mécanismes du même dépôt qui divergent sur
 * l'IDENTITÉ d'un fait, et c'est la vérité la plus FLATTEUSE qui gagne.
 *
 * ── LA RÈGLE, EN DEUX MOITIÉS, ET IL FAUT LES DEUX ──────────────────────────────────────
 *
 *   1. LE FORMULAIRE NE PEUT PLUS L'ÉCRIRE. `STATUTS_MANUELS` est une liste FERMÉE : ce sont
 *      les états de VIE de l'événement (brouillon, préparation, inscriptions, complet, terminé,
 *      annulé). `AWAITING_VALIDATION` et `VALIDATED` n'y sont pas — ce sont des VERDICTS, et un
 *      verdict ne se tape pas.
 *   2. LE CIRCUIT L'ÉCRIT. `statutDepuisCircuit` traduit la décision du circuit en état, et le
 *      moteur l'applique en même temps qu'il projette `requestStatus`. Sans cette moitié, la
 *      première aurait seulement rendu l'état IMPOSSIBLE à mettre à jour : un événement validé
 *      serait resté « Brouillon » pour toujours — un refus à tort, plus coûteux que le défaut
 *      qu'on corrige (§118.27).
 *
 * ── CE QU'ON NE FAIT PAS ────────────────────────────────────────────────────────────────
 *
 * On ne supprime AUCUNE valeur de l'énumération : les événements déjà en base portent
 * `VALIDATED`, et retirer la valeur rendrait leur historique illisible. On ne RÉÉCRIT pas non
 * plus l'existant : un événement validé à la main hier reste validé — c'est peut-être vrai, et
 * une correction de masse déciderait à la place d'un humain (§118.15).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Les états de VIE d'un événement — ceux que le formulaire « Modifier » peut écrire. « En préparation »,
 * « Inscriptions ouvertes » et « Complet » n'y sont plus (Direction, 27/10) : les événements Ad & Pro sont
 * EXTERNES, nous ne les organisons pas (`events/externe.ts`). Les valeurs restent dans l'énumération.
 */
export const STATUTS_MANUELS = [
  "DRAFT",
  "COMPLETED",
  "CANCELLED",
] as const;
export type StatutManuel = (typeof STATUTS_MANUELS)[number];

/** Les états qui sont un VERDICT du circuit de prise en charge — jamais saisis à la main. */
export const STATUTS_DU_CIRCUIT = ["AWAITING_VALIDATION", "VALIDATED"] as const;

export function estStatutManuel(v: string): v is StatutManuel {
  return (STATUTS_MANUELS as readonly string[]).includes(v);
}

export function estStatutDuCircuit(v: string): boolean {
  return (STATUTS_DU_CIRCUIT as readonly string[]).includes(v);
}

/**
 * LE STATUT QUE LE FORMULAIRE A LE DROIT D'ÉCRIRE, ou `null` quand il n'en propose aucun.
 *
 * `null` vaut « ne touche pas au champ » et non « remets-le à DRAFT » : un formulaire qui ne
 * porte pas le champ (création rapide, import) ne doit pas remettre un événement en brouillon.
 * Une valeur de CIRCUIT rend `null` elle aussi — c'est le refus, et il est SILENCIEUX pour une
 * raison nommable : cette fonction sert aussi à l'écriture d'Adam et d'imports, où le mot
 * « validé » peut arriver de bonne foi ; c'est l'ACTION qui dit pourquoi, avec le geste à faire
 * (§118.30). Ici, on ne fait que refuser d'écrire.
 */
export function statutManuelOuRien(saisi: string | null | undefined): StatutManuel | null {
  if (!saisi) return null;
  return estStatutManuel(saisi) ? saisi : null;
}

/**
 * L'ÉTAT QUE LE CIRCUIT IMPOSE, d'après le statut de la demande de prise en charge.
 *
 * Trois réponses, et la troisième est celle qui demande le plus de retenue :
 *   • le circuit A TRANCHÉ POUR → `VALIDATED` ;
 *   • le circuit COURT → `AWAITING_VALIDATION` ;
 *   • le circuit a REFUSÉ ou la demande est ANNULÉE → `DRAFT`. Ni « Annulé » ni
 *     « En attente » : on a refusé la PRISE EN CHARGE, pas l'événement, qui peut très bien se
 *     tenir autrement (autre budget, format réduit) — écrire « Annulé » déciderait de sa tenue à
 *     la place d'un humain (§118.15). Mais le laisser « En attente de validation » serait un
 *     état FAUX : plus rien n'est attendu. `DRAFT` est le seul état neutre — rien d'engagé, rien
 *     de promis — et l'organisateur reprend la main de là ;
 *   • `null` = le circuit ne dit rien : pas de demande du tout (l'événement est piloté
 *     directement), ou demande TERMINÉE — c'est alors le DOSSIER qui est clos, pas l'événement.
 */
export function statutDepuisCircuit(
  requestStatus: string | null | undefined,
): "AWAITING_VALIDATION" | "VALIDATED" | "DRAFT" | null {
  if (!requestStatus) return null;
  if (requestStatus === "APPROVED") return "VALIDATED";
  if (["AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED", "AWAITING_FINAL"].includes(requestStatus)) {
    return "AWAITING_VALIDATION";
  }
  // RENVOYÉE POUR CORRECTION (§118.186) : plus rien n'est attendu d'un validateur, l'organisateur la
  // reprend — un brouillon le temps de la correction, comme après un refus, sans en être un.
  if (["REJECTED", "CANCELLED", "RETURNED"].includes(requestStatus)) return "DRAFT";
  return null;
}
