"use server";

import { revalidatePath } from "next/cache";
import { MailSendPolicy } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { peutPiloterMissionsAdam, peutVoirAdam, REFUS_ADAM } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import {
  setMailSendPolicy,
  setOutboundPaused,
  setInboundPaused,
  getCommunicationPolicy,
  POLICY_LABEL,
} from "@/lib/comms/policy";
import { disconnectGoogle, setGooglePaused } from "@/lib/google/connection";
import { adamConnection, ensureWatch } from "@/lib/google/gmail/reconcile";
import { leverSuspensionMissions, suspendreMissions } from "@/lib/interrupteurs/missions";

/**
 * LES RÉGLAGES D'ADAM — côté SERVEUR, parce que c'est là qu'ils comptent.
 *
 * L'écran n'est qu'un client. Chaque action revérifie le droit (PDG / Super Admin), écrit la
 * décision et la JOURNALISE : une bascule de politique d'envoi est un changement de sécurité,
 * pas une préférence d'affichage. Si un jour quelqu'un se demande « depuis quand Adam envoie
 * tout seul ? », la réponse est dans le journal, avec un nom et une heure.
 */

const PATH = "/adam/reglages"; // l'onglet « Réglages d'Adam » (ex-`/chief-of-staff/reglages`, 02/11/2026)

// La phrase EXACTE à ressaisir pour armer l'envoi autonome, identique à celle du chat. Elle
// n'est PAS exportée : un module « use server » ne peut exporter que des fonctions async, et
// la faire sortir d'ici en ferait un point d'entrée distant sans intérêt.
const AUTO_SEND_CONFIRM = "ENVOI AUTONOME";

async function requireChief() {
  const user = await requireUser();
  // ADAM EST RÉSERVÉ AU SUPER ADMIN (§118.153) — ses réglages aussi. L'écran qui les porte est
  // fermé à tout autre compte ; une action serveur, elle, s'appelle sans passer par l'écran.
  if (!peutVoirAdam(user)) return { error: REFUS_ADAM, user: null };
  return { error: null, user };
}

/**
 * Change la politique d'envoi.
 *
 * Passer à AUTO_SEND, c'est retirer le dernier garde-fou entre un brouillon et un destinataire
 * réel : on exige la RESSAISIE d'une phrase, côté serveur. Revenir à l'approbation obligatoire
 * est au contraire immédiat — on ne met jamais de friction sur le chemin qui augmente la sûreté.
 */
export async function setAdamMailPolicy(
  policy: MailSendPolicy,
  confirmText?: string,
): Promise<{ ok: boolean; error?: string; needsConfirm?: boolean }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };

  if (policy === MailSendPolicy.AUTO_SEND && confirmText?.trim().toUpperCase() !== AUTO_SEND_CONFIRM) {
    return {
      ok: false,
      needsConfirm: true,
      error: `Pour armer l'envoi autonome, saisissez exactement « ${AUTO_SEND_CONFIRM} ».`,
    };
  }

  const before = await getCommunicationPolicy();
  if (before.mailSendPolicy === policy) return { ok: true };

  await setMailSendPolicy(policy, user.id);
  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Chief of Staff",
    summary: `Politique d'envoi d'Adam : « ${POLICY_LABEL[before.mailSendPolicy]} » → « ${POLICY_LABEL[policy]} »`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/** Coupe-circuit SORTANT — prime sur tout, y compris l'envoi autonome. */
export async function setAdamOutboundPaused(paused: boolean): Promise<{ ok: boolean; error?: string }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  await setOutboundPaused(paused, user.id);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Chief of Staff",
    summary: paused ? "Envoi de courriel SUSPENDU (coupe-circuit)" : "Envoi de courriel rétabli",
  });
  revalidatePath(PATH);
  return { ok: true };
}

/** Coupe-circuit ENTRANT — Adam cesse de lire. Il redevient sourd, volontairement. */
export async function setAdamInboundPaused(paused: boolean): Promise<{ ok: boolean; error?: string }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  await setInboundPaused(paused, user.id);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Chief of Staff",
    summary: paused ? "Traitement de la boîte SUSPENDU" : "Traitement de la boîte rétabli",
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — « bloque toutes les missions d'Adam ».
 *
 * Posé : plus AUCUNE mission d'exécution n'avance, ne se replanifie, ne se lance ni ne notifie,
 * pour tout le monde, jusqu'à la levée — sans toucher à une seule mission (les statuts, les
 * attentes et les reçus restent tels quels, et chacune repart où elle en était). C'est un
 * coupe-circuit de la même famille que ceux ci-dessus, et il vit dans le même fichier pour la
 * même raison : ce fichier est refusé en entier au chemin générique d'Adam (§118.78), donc
 * Adam ne peut pas LEVER cet interrupteur par une phrase — poser, oui (geste réducteur,
 * `mission_control` → `suspendre_tout`) ; lever, non (§118.15).
 */
export async function setAdamMissionsPaused(paused: boolean): Promise<{ ok: boolean; error?: string; change?: boolean }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  // Les missions d'Adam — leur interrupteur compris — sont réservées au Super Admin (§118.136).
  // Le PDG garde l'écran des réglages ; ce bouton-ci ne lui est plus présenté, et l'action le refuse.
  if (!peutPiloterMissionsAdam(user)) return { ok: false, error: "L'interrupteur des missions d'Adam est réservé au Super Admin." };
  const r = paused ? await suspendreMissions(user.id) : await leverSuspensionMissions();
  if (r.change) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Chief of Staff",
      summary: paused
        ? "Missions d'Adam SUSPENDUES (interrupteur global — rien n'avance, rien ne notifie)"
        : "Missions d'Adam rétablies (interrupteur global levé)",
    });
  }
  revalidatePath(PATH);
  revalidatePath("/centre-de-missions");
  return { ok: true, change: r.change };
}

/** Met la connexion Google en pause sans la révoquer (rien n'est perdu, tout s'arrête). */
export async function setAdamConnectionPaused(paused: boolean): Promise<{ ok: boolean; error?: string }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  await setGooglePaused(user.id, paused);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Chief of Staff",
    summary: paused ? "Connexion Google d'Adam mise en pause" : "Connexion Google d'Adam réactivée",
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Déconnexion COMPLÈTE : le consentement est révoqué CHEZ GOOGLE, puis les jetons supprimés.
 * Se contenter d'effacer notre copie laisserait une autorisation vivante côté Google — une
 * porte qu'on croit fermée et qui ne l'est pas.
 */
export async function disconnectAdamGoogle(): Promise<{ ok: boolean; error?: string; revoked?: boolean }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  const r = await disconnectGoogle(user.id);
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Chief of Staff",
    summary: `Compte Google d'Adam déconnecté${r.revoked ? " (consentement révoqué)" : " (révocation non confirmée)"}`,
  });
  revalidatePath(PATH);
  return { ok: true, revoked: r.revoked };
}

/**
 * Ré-arme la veille Gmail à la demande — le geste de mise en service quand on vient de créer
 * le sujet Pub/Sub, sans attendre le renouvellement automatique.
 */
export async function renewAdamWatch(): Promise<{ ok: boolean; error?: string; expiresAt?: string | null }> {
  const { error, user } = await requireChief();
  if (error || !user) return { ok: false, error: error ?? "Non autorisé." };
  const conn = await adamConnection();
  if (!conn) return { ok: false, error: "Aucune connexion Google active." };
  const r = await ensureWatch(conn.id, { force: true });
  revalidatePath(PATH);
  if (!r.renewed) return { ok: false, error: r.reason ?? "La veille n'a pas pu être armée." };
  return { ok: true, expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null };
}
