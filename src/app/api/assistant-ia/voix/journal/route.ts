import { getCurrentUserPourEcrire } from "@/lib/session";
import { journaliserVoix } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Fin = { secondes?: number; latences?: number[]; confirme?: boolean; lignes?: { qui: "personne" | "assistant"; texte: string }[] };

/** La fin d'une conversation vocale : durée au compte de la personne, latences au journal, transcription au fil (lot J13). */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let fin: Fin;
  try { fin = (await req.json()) as Fin; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  await journaliserVoix(personne, { secondes: fin.secondes ?? 0, latences: fin.latences ?? [], confirme: fin.confirme === true, lignes: fin.lignes ?? [] });
  return Response.json({ ok: true });
}
