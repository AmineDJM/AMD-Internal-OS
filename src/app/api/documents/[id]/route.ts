import { NextRequest, NextResponse } from "next/server";
import { dispositionPourBucket } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { readFileByKey } from "@/lib/storage";
import { cleObjetDirect, infoBlob } from "@/lib/drive-storage";
import { presignGetUrl } from "@/lib/storage/object-storage";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { contentDisposition } from "@/lib/http/content-disposition";
import { qualiteDeLaRequete, repondreFichier } from "@/lib/http/telechargement";

/**
 * Secure document download: authenticates, enforces row-level access, streams.
 *
 * `?qualite=max|reduite|estimer` — voir `@/lib/http/telechargement` (la porte unique). Les DROITS
 * sont ceux d'avant et ne dépendent pas de la qualité : la version réduite n'ouvre rien de plus.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc) return NextResponse.json({ error: "Introuvable" }, { status: 404 });

  // La règle est partagée avec la recherche de la bibliothèque (`entity-access/ouverture-pieces.ts`).
  if (!(await peutOuvrirDocument(user, doc))) return NextResponse.json({ error: "Accès refusé" }, { status: 403 });

  if (!doc.fileKey) {
    return NextResponse.json(
      { error: "Aucun fichier binaire associé (métadonnées uniquement)." },
      { status: 404 },
    );
  }

  try {
    // Aperçu in-app : on sert le fichier « inline » par défaut (l'iframe/img peut
    // l'afficher) ; `?dl=1` force le téléchargement. On ne journalise que le téléchargement.
    const download = req.nextUrl.searchParams.get("dl") === "1";
    const fileKey = doc.fileKey;
    const stocke = await prisma.storedFile.findUnique({ where: { key: fileKey }, select: { blobId: true } });
    const info = stocke ? await infoBlob(stocke.blobId) : null;
    // GROS FICHIER DÉPOSÉ EN DIRECT : le navigateur le lit dans le bucket, sur une adresse signée
    // pour quinze minutes — le servir d'ici le ferait passer ENTIER par la mémoire de l'instance
    // (plusieurs gigaoctets sur 512 Mo). Les droits viennent d'être vérifiés, ce sont eux qui signent.
    const direct = stocke ? await cleObjetDirect(stocke.blobId) : null;
    const mime = doc.mimeType ?? "application/octet-stream";
    return await repondreFichier(
      { nom: doc.name, mime, charger: () => readFileByKey(fileKey), empreinte: info?.sha256 ?? null, taille: info?.size ?? doc.sizeBytes },
      {
        qualite: qualiteDeLaRequete(req),
        telecharger: download,
        journaliser: (q) => download
          ? recordAudit({
            actorId: user.id, action: "EXPORT", module: "Documents",
            entityType: doc.entityType, entityId: doc.entityId,
            summary: `Téléchargement de « ${doc.name} »${q === "reduite" ? " (taille réduite)" : ""}`,
          })
          : undefined,
        redirection: () => direct
          ? presignGetUrl(direct, 900, {
            // Le bucket ne porte pas de CSP : un type actif (HTML, SVG, XML) s'y télécharge (`lib/http/types-actifs.ts`).
            "response-content-disposition": contentDisposition(doc.name, dispositionPourBucket(mime, download ? "attachment" : "inline")),
            "response-content-type": mime,
          })
          : null,
      },
    );
  } catch {
    return NextResponse.json({ error: "Fichier indisponible" }, { status: 404 });
  }
}
