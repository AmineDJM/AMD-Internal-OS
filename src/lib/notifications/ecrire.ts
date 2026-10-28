import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * REJOUER LIGNE À LIGNE UN LOT DE NOTIFICATIONS REFUSÉ — pour ne pas perdre les 199 autres
 * destinataires à cause d'un compte qui a disparu.
 *
 * LE DÉFAUT. Les destinataires d'une diffusion sont LUS avant d'être écrits, et un compte peut
 * s'effacer entre les deux — suppression depuis l'Administration, fusion de doublons, salarié
 * parti. `Notification.userId` est une clé étrangère, et c'est le SEUL lien que porte la table :
 * Postgres refuse alors la requête ENTIÈRE (`P2003`), l'erreur part dans un `catch`, et PERSONNE
 * n'est prévenu — pas même les destinataires qui existent toujours. Aucune étape en échec, aucun
 * signal : l'envoi a l'air parti.
 *
 * MESURÉ (suite complète, 09/2026) : `notifyRoles` a perdu la demande d'accès d'une assistante
 * Regulatory — `Foreign key constraint violated: Notification_userId_fkey` — parce qu'un compte
 * s'était effacé entre la lecture et l'écriture. La supervision n'a rien reçu, et la seule trace
 * était une ligne de console.
 *
 * LE REMÈDE EXISTAIT, POUR UNE PORTE SUR SIX. `directives/recipients.ts` rejouait déjà ses lots
 * ligne à ligne, avec la bonne raison en commentaire ; les cinq autres écrivains du dépôt ne
 * l'avaient jamais reçu. Quand un défaut se répète, on cherche l'endroit où TOUTES les instances
 * passent (§118.58) et l'on ne laisse pas une porte gardée à côté de cinq portes ouvertes
 * (§118.71).
 *
 * ── POURQUOI C'EST LE REJEU QUI EST PARTAGÉ, ET NON L'ÉCRITURE ───────────────────────────
 *
 * La première version de ce module portait l'écriture ELLE-MÊME (`ecrireNotifications(lignes)`),
 * et les six appelants la lui déléguaient. C'était plus propre à lire et **mesuré comme une
 * régression** : `actions/contrat.ts` DÉRIVE ce qu'une action écrit en lisant le corps de ses
 * délégués, sur UN SEUL niveau (le prix de deux niveaux est écrit là-bas : lire le module entier
 * avait fait déclarer à 593 actions qu'elles touchaient aux sessions). L'écriture passant au
 * niveau deux, **24 actions ont perdu `notification`** de ce qu'elles déclarent écrire, une est
 * sortie `ecrit: false` en notifiant des gens, et deux ont vu leur identifiant désigner la
 * mauvaise table. La carte qu'une personne valide cesse alors de dire qu'un collègue va être
 * dérangé (§118.120), et le chemin générique annonce « aucune écriture en base détectée »
 * (§118.135).
 *
 * Le `createMany` reste donc DANS le corps de chaque écrivain — visible pour la dérivation comme
 * pour qui lit le code — et seul le REJEU, c'est-à-dire la seule partie qu'on ne veut pas voir
 * divergée, vit ici. Un cliquet exige que les deux voyagent ensemble : tout `createMany` de
 * notification d'un fichier de production doit être suivi d'un `catch` qui appelle ce rejeu.
 */
export type LigneNotification = Prisma.NotificationCreateManyInput;

/**
 * Rejoue les lignes UNE PAR UNE après un lot refusé, et rend le nombre réellement écrit.
 *
 * On ne cherche pas à savoir QUI a disparu : la base répond ligne par ligne, et une garde qui
 * devinerait le coupable se tromperait sur le premier cas qu'elle n'a pas prévu (§118.16). Ce qui
 * est perdu est COMPTÉ, NOMMÉ et RENDU (§118.52) : un envoi silencieusement amputé ressemble
 * trait pour trait à un envoi réussi.
 *
 * Ne lève jamais : les six appelants sont en best-effort, et une notification perdue ne doit pas
 * faire échouer l'écriture métier qui l'a déclenchée.
 */
export async function rejouerNotifications(
  lignes: readonly LigneNotification[],
  cause: unknown,
): Promise<number> {
  console.error("[notify] lot de notifications refusé, reprise ligne à ligne", cause);
  let ecrites = 0;
  for (const ligne of lignes) {
    const ok = await prisma.notification
      .create({ data: ligne })
      .then(() => true)
      .catch(sansBloquer("ecrire.rejouerNotifications.notification", false));
    if (ok) ecrites += 1;
  }
  if (ecrites < lignes.length) {
    console.error(
      `[notify] ${lignes.length - ecrites} destinataire(s) perdu(s) sur ${lignes.length} — compte effacé entre la lecture et l'écriture`,
    );
  }
  return ecrites;
}
