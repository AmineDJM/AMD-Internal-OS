import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { ErreurZip } from "@/lib/storage/zip-lecteur";
import { listerArchive, refusLisible, reponseEntreeZip, reponsePrechauffage, sourceDuBlob } from "@/lib/storage/zip-reponse";

export const dynamic = "force-dynamic";

/**
 * Navigation DANS une archive .zip du Drive (sans la décompresser durablement) :
 *  - sans `?path=` → **liste des entrées** (JSON) pour l'affichage de l'arborescence ;
 *  - avec `?path=` → **UNE entrée** (aperçu inline, ou `?dl=1` pour télécharger).
 * Accès contrôlé EXACTEMENT comme /raw (résolution héritée de l'arbre Drive).
 *
 * Le même lecteur par PLAGES que les documents (`zip-lecteur`) : l'archive n'est plus chargée en mémoire (JSZip la
 * refusait au-delà de 300 Mo), et une grosse entrée se sert en flux. Un refus pour une ENTRÉE est une phrase lisible
 * dans l'aperçu, jamais du JSON brut (Direction, 06/10).
 */

const MAX_ENTRIES = 5000; // borne la taille de la réponse « liste »

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  const path = req.nextUrl.searchParams.get("path");
  const refus = (error: string, status: number) => (path ? refusLisible(error, status) : NextResponse.json({ ok: false, error }, { status }));
  if (!user) return refus("Non authentifié.", 401);
  if (!canViewDrive(await resolveDriveAccess(user, params.id))) return refus("Accès refusé.", 403);

  const node = await prisma.driveNode.findUnique({ where: { id: params.id }, select: { name: true, size: true, type: true } });
  if (!node || node.type === "FOLDER") return refus("Élément introuvable.", 404);
  if (!/\.zip$/i.test(node.name)) return refus("Ce fichier n'est pas une archive ZIP.", 400);

  const version = await prisma.fileVersion.findFirst({ where: { nodeId: params.id }, orderBy: { version: "desc" }, select: { blobId: true, size: true } });
  if (!version) return refus("Contenu indisponible.", 404);

  try {
    const source = await sourceDuBlob(version.blobId, version.size);
    if ("erreur" in source) return refus(source.erreur, source.status);
    const { entrees, tronque } = await listerArchive(source);

    // ───────── UNE entrée (aperçu inline / téléchargement / préchauffage au survol) ─────────
    if (path) {
      const entree = entrees.find((e) => e.chemin === path && !e.dossier);
      if (!entree) return refus("Entrée introuvable dans l'archive.", 404);
      if (req.nextUrl.searchParams.get("prechauffer") === "1") return reponsePrechauffage(source, entree);
      return reponseEntreeZip(source, entree, req.nextUrl.searchParams.get("dl") === "1", req.headers.get("range"));
    }

    // ───────── Liste des entrées (fichiers uniquement ; l'arborescence est dérivée côté client) ─────────
    const fichiers = entrees.filter((e) => !e.dossier);
    const entries = fichiers.slice(0, MAX_ENTRIES).map((e) => ({ path: e.chemin, size: e.taille }));
    entries.sort((a, b) => a.path.localeCompare(b.path, "fr"));
    return NextResponse.json(
      { ok: true, name: node.name, count: entries.length, truncated: tronque || fichiers.length > MAX_ENTRIES, entries },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    if (e instanceof ErreurZip) return refus(e.message, 422);
    console.error("[drive zip]", e);
    return refus("Archive illisible ou corrompue.", 422);
  }
}
