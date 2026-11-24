import { NextRequest, NextResponse } from "next/server";
import { dispositionPourBucket, typeAEmettre } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { readFileByKey } from "@/lib/storage";
import { cleObjetDirect, infoBlob } from "@/lib/drive-storage";
import { presignGetUrl, VALIDITE_MAX_LECTURE_S } from "@/lib/storage/object-storage";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { contentDisposition } from "@/lib/http/content-disposition";
import { qualiteDeLaRequete, repondreFichier } from "@/lib/http/telechargement";
import { cleDeVersionDocument } from "@/lib/document-versions";
import { nomDeVersion } from "@/lib/document-versions-partage";

/**
 * Secure document download: authenticates, enforces row-level access, streams.
 *
 * `?qualite=max|reduite|estimer` — voir `@/lib/http/telechargement` (la porte unique). Les DROITS
 * sont ceux d'avant et ne dépendent pas de la qualité : la version réduite n'ouvre rien de plus.
 *
 * `?version=N` — une ANCIENNE version (« Versions » de la fiche, `DocumentVersion`), sous les mêmes droits que la
 * version d'aujourd'hui : qui peut ouvrir le document peut ouvrir son historique.
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
    const demandee = Number(req.nextUrl.searchParams.get("version") ?? "");
    const ancienne = Number.isInteger(demandee) && demandee > 0 && demandee !== doc.version ? await cleDeVersionDocument(doc.id, demandee) : null;
    if (Number.isInteger(demandee) && demandee > 0 && demandee !== doc.version && !ancienne) {
      return NextResponse.json({ error: `La version ${demandee} de ce document n'existe pas.` }, { status: 404 });
    }
    const fileKey = ancienne ?? doc.fileKey;
    const nom = ancienne ? nomDeVersion(doc.name, demandee) : doc.name;
    const stocke = await prisma.storedFile.findUnique({ where: { key: fileKey }, select: { blobId: true } });
    const info = stocke ? await infoBlob(stocke.blobId) : null;
    // GROS FICHIER DÉPOSÉ EN DIRECT : le navigateur le lit dans le bucket, sur une adresse signée
    // pour quinze minutes — le servir d'ici le ferait passer ENTIER par la mémoire de l'instance
    // (plusieurs gigaoctets sur 512 Mo). Les droits viennent d'être vérifiés, ce sont eux qui signent.
    const direct = stocke ? await cleObjetDirect(stocke.blobId) : null;
    const mime = doc.mimeType ?? "application/octet-stream";
    return await repondreFichier(
      { nom, mime, charger: () => readFileByKey(fileKey), empreinte: info?.sha256 ?? null, taille: info?.size ?? (ancienne ? null : doc.sizeBytes) },
      {
        qualite: qualiteDeLaRequete(req),
        telecharger: download,
        journaliser: (q) => download
          ? recordAudit({
            actorId: user.id, action: "EXPORT", module: "Documents",
            entityType: doc.entityType, entityId: doc.entityId,
            summary: `Téléchargement de « ${nom} »${q === "reduite" ? " (taille réduite)" : ""}`,
          })
          : undefined,
        redirection: () => direct
          ? presignGetUrl(direct, VALIDITE_MAX_LECTURE_S, {
            // Le bucket ne porte pas de CSP : un type actif (HTML, SVG, XML) s'y télécharge (`lib/http/types-actifs.ts`).
            "response-content-disposition": contentDisposition(nom, dispositionPourBucket(mime, download ? "attachment" : "inline")),
            "response-content-type": typeAEmettre(mime),
          })
          : null,
      },
    );
  } catch {
    return NextResponse.json({ error: "Fichier indisponible" }, { status: 404 });
  }
}
