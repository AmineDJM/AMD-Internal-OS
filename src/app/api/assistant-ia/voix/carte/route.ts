import { getCurrentUserPourEcrire } from "@/lib/session";
import { resumeCarteDit } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LE RÉSUMÉ D'UNE CARTE A ÉTÉ DIT (K9, décision 0038) — le navigateur le signale à l'accusé du fournisseur
 * (`session.commentary.appended`). Avant ce signal, aucun « vas-y » n'exécute la carte.
 */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let c: { session?: unknown; intentId?: unknown; empreinte?: unknown };
  try { c = (await req.json()) as typeof c; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  return Response.json({ ok: await resumeCarteDit(personne, c.session, c.intentId, c.empreinte) });
}
