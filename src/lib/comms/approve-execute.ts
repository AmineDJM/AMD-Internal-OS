import { OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { approveOutboundIntent, sendOutboundIntent, type MailTransport } from "./outbound";
import { markMissionAsked } from "./missions";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";

/**
 * APPROUVER ET ENVOYER — l'UNIQUE fonction qui conclut un courriel.
 *
 * LE PROBLÈME QU'ELLE FERME. Il y avait deux façons de dire oui à un message : cliquer
 * « Envoyer » sur la carte, ou l'écrire (« vas-y », « envoie-le »). La première exécutait ; la
 * seconde… réaffichait la carte. Le PDG se retrouvait à devoir cliquer ce qu'il venait
 * d'approuver à voix haute. Deux interfaces, deux logiques, et une seule des deux faisait
 * réellement partir le message.
 *
 * Ce fichier tranche : **une autorité, deux interfaces**. Le clic et la parole appellent
 * EXACTEMENT cette fonction. Elles ne partagent pas « à peu près » le même chemin — elles
 * partagent le même appel. C'est la seule façon de garantir qu'un durcissement futur (une
 * vérification de plus, une trace, un verrou) profite aux deux sans qu'on y pense.
 *
 * CE QUI NE CHANGE PAS — et il faut le dire, parce que c'est le point sensible. Une confirmation
 * en français reste une CONFIRMATION HUMAINE : même utilisateur authentifié, même approbation
 * serveur liée à l'empreinte exacte du contenu, même transition atomique, même politique relue à
 * l'instant de l'envoi. On n'a pas retiré une garantie, on a retiré un CLIC.
 */

/** Ce que rend une exécution — volontairement aligné sur `ExecuteResult` de l'assistant. */
export interface MailExecutionResult {
  ok: boolean;
  message?: string;
  link?: string;
  error?: string;
}

/**
 * L'intention qui attend — et UNE SEULE.
 *
 * Deux messages en attente rendent « oui » ambigu : choisir au hasard lequel expédier serait la
 * pire réponse possible, alors on rend `null` et la question repart à la personne. Fenêtre
 * courte : un accord donné demain matin ne porte plus sur le message d'hier soir.
 */
export const PENDING_MAIL_WINDOW_MS = 2 * 3_600_000;

export async function solePendingMailIntent(
  userId: string,
  now = Date.now(),
): Promise<{ id: string; subject: string; recipients: string[] } | null> {
  const waiting = await prisma.outboundMailIntent.findMany({
    where: {
      userId,
      status: OutboundMailStatus.AWAITING_APPROVAL,
      createdAt: { gte: new Date(now - PENDING_MAIL_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true, subject: true, recipients: true },
  }).catch(sansBloquer("approve-execute.solePendingMailIntent.outboundMailIntent", []));
  return waiting.length === 1 ? waiting[0] : null;
}

/**
 * APPROUVE le contenu EXACT présent, puis l'expédie — une fois.
 *
 * L'ordre importe et se lit de haut en bas :
 *   1. déjà parti ? on rend le reçu du PREMIER envoi (un rejeu n'est pas une erreur) ;
 *   2. `approveOutboundIntent` lie l'accord à l'empreinte du contenu ET à un approbateur humain ;
 *   3. `sendOutboundIntent` relit la politique, revérifie l'identité d'envoi et l'empreinte, puis
 *      gagne — ou perd — la transition atomique vers l'envoi.
 *
 * Le `userId` vient de la SESSION, jamais du client : c'est lui qui est enregistré comme
 * approbateur, et c'est ce qui rend l'accord opposable.
 *
 * POURQUOI LE TRANSPORT EST UN PARAMÈTRE. Ce module tranche la POLITIQUE d'envoi ; il n'a pas à
 * savoir que le courrier part chez Google. Aller chercher `gmailTransport` ici créait le seul
 * lien `comms → google` de tout le code, et donc un cycle : `google/` importe déjà la politique,
 * l'analyse de courriel et les missions de `comms/`. Un cycle entre un adaptateur et son domaine
 * empêche de remplacer l'adaptateur — exactement ce qu'on veut pouvoir faire le jour où un second
 * transport arrive.
 *
 * On l'INJECTE plutôt que de le poser dans un registre parce que le typage rend alors l'oubli
 * impossible : un appelant sans transport ne compile pas. Un registre, lui, se serait initialisé
 * ailleurs — et un message aurait pu échouer en production pour un import manquant.
 */
export async function approveAndExecuteIntent(
  user: CurrentUser,
  intentId: string,
  transport: MailTransport,
): Promise<MailExecutionResult> {
  const intent = await prisma.outboundMailIntent.findFirst({
    where: { id: intentId, userId: user.id },
    select: { id: true, status: true, subject: true, recipients: true, missionId: true, providerMessageId: true, sentAt: true },
  });
  if (!intent) return { ok: false, error: "Intention d'envoi introuvable (ou elle n'est pas à vous)." };

  // LE REJEU SE RÉPOND, IL NE S'ERREUR PAS. Une carte reconfirmée après coup — onglet resté
  // ouvert, clic répété, « oui » redit — décrit un envoi DÉJÀ fait.
  if (intent.status === OutboundMailStatus.SENT) {
    return {
      ok: true,
      message: `Déjà envoyé${intent.sentAt ? ` (${intent.sentAt.toLocaleString("fr-FR")})` : ""} — rien n'a été renvoyé.`,
      link: "/chief-of-staff",
    };
  }

  const approved = await approveOutboundIntent(intentId, user.id);
  if ("error" in approved) return { ok: false, error: approved.error };

  const sent = await sendOutboundIntent(intentId, transport);
  if (!sent.ok) return { ok: false, error: "blocked" in sent && sent.blocked ? sent.message : sent.error };

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Chief of Staff",
    summary: `Courriel envoyé (Adam) — « ${intent.subject} » à ${intent.recipients.join(", ")}`,
  });
  if (intent.missionId) await markMissionAsked(intent.missionId).catch(sansBloquer("approve-execute.approveAndExecuteIntent.markMissionAsked"));

  return {
    ok: true,
    message: sent.alreadySent ? "Déjà envoyé — rien n'a été renvoyé." : "Envoyé.",
    link: "/chief-of-staff",
  };
}
