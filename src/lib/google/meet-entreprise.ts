import { prisma } from "@/lib/prisma";
import { resolveGoogleConfig } from "./config";
import { isScopeSatisfied, normalizeScopes } from "./scopes";
import { getActiveGoogleConnection } from "./connection";
import { GoogleApiError } from "./client";
import { creerReunionMeet, LienMeetAbsent } from "./calendar/meet";
import {
  creneauGoogle, refusDepuisErreurGoogle, MESSAGE_REFUS_MEET, type DemandeLienMeet, type RefusMeet,
} from "./calendar/meet-regles";

/**
 * LE LIEN GOOGLE MEET DE L'ENTREPRISE — généré en un clic depuis l'agenda, les réunions et les
 * événements Ad & Pro.
 *
 * LE COMPTE : celui d'Adam, seule connexion Google de l'ERP. La règle de choix est celle de la
 * boîte Gmail d'Adam (`gmail/envoi.ts`, `boiteGmailAdam`) : l'adresse `GOOGLE_ADAM_EMAIL` quand
 * elle est posée, sinon la plus ancienne connexion. Un collaborateur ne connecte pas SON compte :
 * le lien appartient à l'entreprise, il survit au départ de qui l'a demandé.
 *
 * LE DROIT : `calendar.events` (ou `calendar`, qui le couvre — `scopes.ts`). Il fait partie des
 * droits demandés à la connexion d'Adam ; un consentement qui l'a décoché se dit, il ne se devine
 * pas sur un 403.
 *
 * Aucun refus n'est une exception : chaque cas rend la phrase qui dit quoi connecter et où.
 */

const DROIT_AGENDA = "https://www.googleapis.com/auth/calendar.events";

export type ResultatLienMeet =
  | { ok: true; lien: string; compte: string }
  | { ok: false; raison: RefusMeet; message: string };

const refus = (raison: RefusMeet): ResultatLienMeet => ({ ok: false, raison, message: MESSAGE_REFUS_MEET[raison] });

/** La connexion Google de l'entreprise, sans jeton — `null` : aucune. */
async function compteGoogleEntreprise() {
  const adam = process.env.GOOGLE_ADAM_EMAIL?.trim().toLowerCase();
  return prisma.googleConnection.findFirst({
    where: {
      status: { in: ["connected", "needs-reconnect"] },
      ...(adam ? { address: { equals: adam, mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: { userId: true, status: true, paused: true, grantedScopes: true },
  });
}

export async function genererLienMeetEntreprise(
  demande: DemandeLienMeet,
  auteur: { nom: string },
  maintenant: Date = new Date(),
): Promise<ResultatLienMeet> {
  if (!resolveGoogleConfig(process.env as Record<string, string | undefined>)) return refus("non-configure");

  const compte = await compteGoogleEntreprise();
  if (!compte) return refus("non-connecte");
  if (compte.paused) return refus("suspendu");
  if (compte.status !== "connected") return refus("reconnecter");
  if (!isScopeSatisfied(DROIT_AGENDA, new Set(normalizeScopes(compte.grantedScopes)))) return refus("droit-agenda");

  try {
    const conn = await getActiveGoogleConnection(compte.userId);
    if (!conn) return refus("suspendu");
    const r = await creerReunionMeet(conn.accessToken, {
      titre: demande.titre,
      description:
        `Visioconférence Google Meet créée depuis AMD Internal OS par ${auteur.nom}.\n` +
        "Cet événement porte le lien de la réunion : le supprimer peut couper le lien.",
      creneau: creneauGoogle(demande, maintenant),
    });
    return { ok: true, lien: r.lien, compte: conn.address };
  } catch (e) {
    if (e instanceof LienMeetAbsent) return refus(e.raison);
    if (e instanceof GoogleApiError) return refus(refusDepuisErreurGoogle(e.kind, e.reason));
    throw e;
  }
}
