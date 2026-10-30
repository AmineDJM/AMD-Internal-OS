import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { journaliserVoix } from "@/modules/assistant-ia/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** La fin d'une session vocale : sa consommation au compte de la personne, ses latences au journal (lot J13). */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  let d: { entree?: number; sortie?: number; latences?: number[]; dureeMs?: number } = {};
  try { d = (await req.json()) as typeof d; } catch { return NextResponse.json({ error: "Requête invalide." }, { status: 400 }); }
  await journaliserVoix(user, { entree: d.entree ?? 0, sortie: d.sortie ?? 0, latences: d.latences ?? [], dureeMs: d.dureeMs ?? 0 });
  return NextResponse.json({ ok: true });
}
