import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { attendu } from "@/lib/journal";
import { cloreLotDossier } from "@/modules/assistant-ia/api";
import { refusAssistantIA } from "../../personne";

export const dynamic = "force-dynamic";

/** Clore un lot de dépôt de dossier (téléversement fini) ou l'abandonner (annulé par la personne) — le sien seulement. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUserPourEcrire();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  const { id } = await params;
  const b = (await req.json().catch(attendu("corps illisible : le client reçoit le refus", {}))) as { statut?: unknown };
  const statut = b.statut === "ABANDONNE" ? "ABANDONNE" : "TERMINE";
  const ok = await cloreLotDossier(user, id, statut);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Dépôt introuvable." }, { status: 404 });
}
