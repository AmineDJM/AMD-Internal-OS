import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { ouvrirDepotDirect } from "@/lib/drive/depot-direct";
import { attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * OUVRE (ou REPREND) l'envoi direct d'un gros fichier vers le bucket. Le corps ne porte que des
 * métadonnées ; les octets partent ensuite du navigateur au stockage, sur les adresses rendues.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });
  const b = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", {}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const nom = str(b.name);
  const taille = Number(b.size);
  if (!nom) return NextResponse.json({ error: "Nom de fichier manquant." }, { status: 400 });
  if (!Number.isFinite(taille) || taille <= 0) return NextResponse.json({ error: `« ${nom} » est vide (0 octet).` }, { status: 400 });
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  try {
    const r = await ouvrirDepotDirect(user, {
      nom, taille, type: str(b.type) ?? "application/octet-stream", modifieLe: Number(b.lastModified ?? 0),
      cible: {
        nodeId: str(b.nodeId), parentId: str(b.parentId), spaceId: str(b.spaceId), category: str(b.category),
        viewers: liste(b.viewers), editors: liste(b.editors),
      },
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, sessionId: r.sessionId, plan: r.plan, repris: r.repris }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Le stockage refuse d'ouvrir l'envoi (${e instanceof Error ? e.message : "erreur"}).` }, { status: 503 });
  }
}
