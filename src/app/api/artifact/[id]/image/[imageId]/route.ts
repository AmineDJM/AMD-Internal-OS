import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { octetsImageArtefact } from "@/platform/in-process/artifact/render";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE IMAGE DU DOCUMENT, SERVIE AU WORKSPACE.
 *
 * Sans cette route, le workspace dessinait un cadre gris portant « Image — 4,0 × 2,0 cm ». La
 * personne ne pouvait donc pas distinguer le logo de 2019 de celui de 2027 : elle ne pouvait
 * pas VÉRIFIER ce qu'Adam venait de faire, et « c'est fait » redevenait une parole à croire.
 * Or c'est exactement le geste qu'Adam ne doit jamais demander (§104.7).
 *
 * ── CE QUI REND CETTE ROUTE SÛRE ────────────────────────────────────────────────────────
 *
 * L'identifiant de SESSION, comme pour les pages de PDF : le moteur ne rend une session que si
 * son `userId` correspond. Personne ne lit l'image d'un contrat en devinant un identifiant
 * Drive. `Cache-Control: private` empêche un cache partagé de conserver le logo d'un client.
 *
 * ── LE TYPE EST CELUI DES OCTETS, PAS CELUI DU NOM ──────────────────────────────────────
 *
 * `lireImage` lit l'EN-TÊTE. Un `.png` qui contient du JPEG existe ; servir le type déduit du
 * nom afficherait un cadre cassé. Un type non reconnu part en `application/octet-stream` —
 * honnête, et le `<img>` montre alors son texte de remplacement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string; imageId: string }> }
) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const r = await octetsImageArtefact(user, params.id, params.imageId);
  if (!r.ok || !r.octets) return new NextResponse(r.motif ?? "image introuvable", { status: r.statut });

  return new NextResponse(new Uint8Array(r.octets), {
    headers: {
      "Content-Type": r.mime ?? "application/octet-stream",
      "Content-Length": String(r.octets.length),
      // L'URL porte la révision : un contenu différent a forcément une autre adresse.
      "Cache-Control": "private, max-age=300, immutable",
    },
  });
}
