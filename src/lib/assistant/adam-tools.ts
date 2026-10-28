import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { MissionStatus } from "@prisma/client";
import { getActiveGoogleConnection } from "@/lib/google/connection";
import { searchMessages } from "@/lib/google/gmail/messages";
import { recordMissionEvent } from "@/lib/comms/missions";
import { sansBloquer } from "@/lib/journal";
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

/**
 * Recherche Gmail EN DIRECT (au-delà de ce qui est ingéré) — utilisée par la recherche fédérée
 * quand l'index local ne rend rien. Bornée, tolérante : une panne Google ne casse pas la
 * recherche du Chief.
 */
export async function liveGmailSearch(user: CurrentUser, query: string, limit = 8): Promise<{ subject: string; from: string; date: string; snippet: string }[]> {
  if (!hasGlobalView(user)) return [];
  try {
    const conn = await getActiveGoogleConnection(user.id);
    if (!conn) return [];
    const messages = await searchMessages(conn.accessToken, { q: query, maxResults: limit });
    return messages.map((m) => ({
      subject: m.subject,
      from: m.from.address,
      date: m.sentAt?.toISOString() ?? "",
      snippet: m.snippet.slice(0, 200),
    }));
  } catch {
    return [];
  }
}

/** Journalise un geste de mission depuis l'extérieur du moteur (envoi approuvé, relance). */
export async function noteMissionActivity(missionId: string, summary: string): Promise<void> {
  await recordMissionEvent(missionId, "NOTE", summary).catch(sansBloquer("adam-tools.noteMissionActivity.recordMissionEvent"));
}

export const ADAM_MISSION_STATUSES = MissionStatus;
