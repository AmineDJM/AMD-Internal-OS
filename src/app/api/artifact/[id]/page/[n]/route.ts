import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rendrePageArtefact } from "@/platform/ia/artifact/render";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PAGE DE PDF, EN IMAGE — la seule chose que le navigateur ne peut pas dessiner lui-même.
 *
 * Word, Excel et PowerPoint sont rendus PAR le navigateur depuis leur modèle (voir
 * `artifact.tsx`) : c'est plus fidèle, plus rapide, et le texte y reste cliquable. Un PDF, lui,
 * EST une mise en page — il n'y a pas de modèle à re-dessiner. MuPDF rastérise donc la page
 * demandée, et elle seule.
 *
 * ── CE QUI REND CETTE ROUTE SÛRE ────────────────────────────────────────────────────────
 *
 * L'identifiant de SESSION, pas celui du fichier. Le moteur ne rend une session que si son
 * `userId` correspond ; personne ne peut donc lire la page d'un document en devinant un
 * identifiant Drive. `Cache-Control: private` empêche un cache partagé de conserver la page
 * d'un contrat.
 *
 * ── POURQUOI L'ÉTAT COURANT, ET NON LE FICHIER DU DRIVE ─────────────────────────────────
 *
 * On rend l'état EN COURS D'ÉDITION. Après « supprime les pages 12, 14 et 18 », la page 12
 * affichée doit être l'ancienne 13 — sinon la personne verrait le fichier d'avant et croirait
 * que rien ne s'est passé. Le paramètre `?r=<revision>` du client sert exactement à cela :
 * changer l'URL à chaque modification pour que le navigateur ne re-serve pas son cache.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string; n: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const page = Number(params.n);
  if (!Number.isInteger(page) || page < 1) return new NextResponse("page invalide", { status: 400 });

  const echelle = Number(req.nextUrl.searchParams.get("s"));
  const rendu = await rendrePageArtefact(user, params.id, page, {
    echelle: Number.isFinite(echelle) && echelle >= 0.5 && echelle <= 4 ? echelle : undefined,
  });
  if (!rendu.ok) return new NextResponse(rendu.motif, { status: rendu.statut });

  return new NextResponse(new Uint8Array(rendu.png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(rendu.png.length),
      // `private` : un contrat ne doit jamais atterrir dans un cache partagé. `immutable` parce
      // que l'URL porte la révision — un contenu différent aura forcément une autre adresse.
      "Cache-Control": "private, max-age=300, immutable",
    },
  });
}
