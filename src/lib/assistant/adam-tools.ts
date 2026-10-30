import type { PowerTool } from "@/platform/ia/outil";
import { OUTILS_GMAIL } from "./adam-tools/gmail";
import { OUTILS_MISSIONS } from "./adam-tools/missions";
import { OUTILS_AGENDA_DRIVE } from "./adam-tools/agenda-drive";
import { OUTILS_BUREAUTIQUE_CONTACTS } from "./adam-tools/bureautique-contacts";

/**
 * LES OUTILS D'ADAM — les sens et les mains du Chief sur ses canaux de communication.
 *
 * Une seule ligne de partage gouverne tout ce fichier :
 *
 *   • **LIRE, COMPRENDRE, RELIER, PRÉPARER → autonome.** Adam fouille sa boîte, ouvre les pièces,
 *     suit les fils, tient ses missions et RÉDIGE des messages sans demander la permission. Un
 *     chef de cabinet qui demanderait l'autorisation d'ouvrir le courrier ne servirait à rien.
 *
 *   • **FRANCHIR LA FRONTIÈRE EXTERNE → carte de confirmation.** Envoyer, partager un fichier
 *     avec quelqu'un, inviter à une réunion : ces gestes passent par une INTENTION canonique et
 *     la carte du PDG. Aucun outil de ce fichier n'expédie quoi que ce soit — `gmail_prepare_mail`
 *     ne fait que PRÉPARER et rendre l'identifiant de l'intention.
 *
 * Le contenu reçu (messages, pièces jointes) est toujours livré au modèle ENCADRÉ comme donnée
 * non fiable (`comms/untrusted.ts`) : un courriel ne donne pas d'ordres.
 *
 * Découpé dans `adam-tools/` : `commun.ts` (les aides partagées) et un fichier par canal
 * (Gmail, missions, agenda & Drive, bureautique & contacts) ; ce fichier recompose `ADAM_TOOLS`
 * dans l'ordre d'origine et garde les aides appelées hors du moteur.
 */

export const ADAM_TOOLS: PowerTool[] = [
  ...OUTILS_GMAIL,
  ...OUTILS_MISSIONS,
  ...OUTILS_AGENDA_DRIVE,
  ...OUTILS_BUREAUTIQUE_CONTACTS,
];

