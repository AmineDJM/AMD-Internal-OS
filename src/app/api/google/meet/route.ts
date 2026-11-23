import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire, type CurrentUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { attendu } from "@/lib/journal";
import { genererLienMeetEntreprise } from "@/lib/google/meet-entreprise";
import {
  lireDemandeLienMeet, MESSAGE_REFUS_MEET, REFUS_DE_CONNEXION, type ReponseLienMeet,
} from "@/lib/google/calendar/meet-regles";

export const dynamic = "force-dynamic";

/**
 * GÉNÉRER UN LIEN GOOGLE MEET — le bouton « Générer un lien Google Meet » des formulaires de
 * l'agenda, des réunions et des événements Ad & Pro (`components/google/champ-lien-meet.tsx`).
 *
 * Une ROUTE plutôt qu'une action serveur : elle n'enregistre rien dans l'ERP (le lien rejoint le
 * champ du formulaire, et c'est l'enregistrement de la réunion qui l'écrit), et le bouton se pose
 * dans des écrans qui ne partagent aucun fichier d'actions.
 *
 * Le droit : celui de créer ce que ces écrans créent — un rendez-vous (WORKSPACE), une réunion
 * (MESSAGING) ou un événement (EVENTS). Le compte Google, lui, est celui de l'entreprise.
 */
function peutGenererLienMeet(user: CurrentUser): boolean {
  return userCan(user, "WORKSPACE", "CREATE")
    || userCan(user, "MESSAGING", "CREATE")
    || userCan(user, "EVENTS", "CREATE")
    || userCan(user, "EVENTS", "UPDATE");
}

const repondre = (corps: ReponseLienMeet, status = 200) =>
  NextResponse.json(corps, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return repondre({ ok: false, raison: "droit", message: "Session expirée : reconnectez-vous." }, 401);
  if (!peutGenererLienMeet(user)) return repondre({ ok: false, raison: "droit", message: MESSAGE_REFUS_MEET.droit }, 403);

  const corps = await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le refus", null));
  const demande = lireDemandeLienMeet(corps);
  if (!demande) return repondre({ ok: false, raison: "invalide", message: MESSAGE_REFUS_MEET.invalide }, 400);

  const r = await genererLienMeetEntreprise(demande, { nom: user.name });
  if (!r.ok) {
    return repondre({ ...r, ...(REFUS_DE_CONNEXION.has(r.raison) && hasGlobalView(user) ? { reglages: "/chief-of-staff/reglages" } : {}) });
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Agenda",
    summary: `Lien Google Meet généré — « ${demande.titre} » (compte ${r.compte})`,
  });
  return repondre(r);
}
