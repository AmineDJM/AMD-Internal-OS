import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { ErreurZip } from "@/lib/storage/zip-lecteur";
import { listerArchive, refusLisible, reponseEntreeZip, reponsePrechauffage, sourceDuFichierStocke } from "@/lib/storage/zip-reponse";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * Parcourir un ZIP DÉPOSÉ COMME DOCUMENT, sans le télécharger :
 *  - sans `?path=` → la liste des entrées (JSON) ;
 *  - avec `?path=` → UNE entrée (aperçu en ligne, ou `?dl=1` pour l'enregistrer).
 *
 * Les droits sont ceux du téléchargement du document (la même porte). L'archive n'est JAMAIS lue en
 * entier quand elle est dans le bucket : on lit son répertoire, puis l'entrée demandée, par plages —
 * une archive CTD de plusieurs Go s'ouvre en une seconde sur une instance à 512 Mo.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });

  const doc = await prisma.document.findUnique({ where: { id: params.id }, select: { name: true, fileKey: true, entityType: true, entityId: true } });
  if (!doc) return NextResponse.json({ ok: false, error: "Introuvable." }, { status: 404 });
  if (!(await canAccessEntity(user, doc.entityType, doc.entityId, "VIEW"))) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 403 });
  if (!doc.fileKey) return NextResponse.json({ ok: false, error: "Aucun fichier binaire associé." }, { status: 404 });
  if (!/\.zip$/i.test(doc.name)) return NextResponse.json({ ok: false, error: "Ce fichier n'est pas une archive ZIP." }, { status: 400 });

  const chemin = req.nextUrl.searchParams.get("path");
  // UNE ENTRÉE s'affiche dans l'aperçu : ses refus sont des phrases, pas du JSON (Direction, 06/10).
  const refus = (error: string, status: number) => (chemin ? refusLisible(error, status) : NextResponse.json({ ok: false, error }, { status }));
  try {
    const source = await sourceDuFichierStocke(doc.fileKey);
    if ("erreur" in source) return refus(source.erreur, source.status);
    const { entrees, tronque } = await listerArchive(source);

    if (!chemin) {
      // Même forme que la liste du Drive : la visionneuse est UNE seule, pour les deux.
      const fichiers = entrees.filter((e) => !e.dossier);
      return NextResponse.json({
        ok: true, name: doc.name, count: fichiers.length, truncated: tronque,
        entries: fichiers.map((e) => ({ path: e.chemin, size: e.taille })),
      }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const entree = entrees.find((e) => e.chemin === chemin && !e.dossier);
    if (!entree) return refus("Entrée introuvable dans l'archive.", 404);
    // Survol / sélection d'une grosse entrée : l'extraction démarre avant le clic (zip-reponse).
    if (req.nextUrl.searchParams.get("prechauffer") === "1") return reponsePrechauffage(source, entree);
    const dl = req.nextUrl.searchParams.get("dl") === "1";
    // Une reprise de téléchargement (plage au-delà du début) n'est pas un nouveau téléchargement.
    const reprise = /^bytes=(?!0-)/i.test(req.headers.get("range") ?? "");
    if (dl && !reprise) {
      await recordAudit({
        actorId: user.id, action: "EXPORT", module: "Documents", entityType: doc.entityType, entityId: doc.entityId,
        summary: `Téléchargement de « ${entree.chemin} » dans « ${doc.name} »`,
      }).catch(sansBloquer("zip-route.GET.recordAudit"));
    }
    return reponseEntreeZip(source, entree, dl, req.headers.get("range"));
  } catch (e) {
    if (e instanceof ErreurZip) return refus(e.message, 422);
    console.error("[documents zip]", e);
    return refus("Lecture de l'archive impossible.", 500);
  }
}
