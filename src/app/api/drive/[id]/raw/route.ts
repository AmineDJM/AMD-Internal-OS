import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob, cleObjetDirect, infoBlob } from "@/lib/drive-storage";
import { presignGetUrl } from "@/lib/storage/object-storage";
import { contentDisposition } from "@/lib/http/content-disposition";
import { dispositionPourBucket } from "@/lib/http/types-actifs";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { collecterPourZip, entreesDeDrive } from "@/lib/drive-zip";
import { qualiteDeLaRequete, repondreArchive, repondreEstimationArchive, repondreFichier } from "@/lib/http/telechargement";
import { recordAudit } from "@/lib/audit";

/**
 * Stream a file's current version (decrypted). `?dl=1` forces download.
 * `?qualite=max|reduite|estimer` : voir `@/lib/http/telechargement`. Un dossier part en archive ZIP
 * streamée — non compressée en qualité maximale, deflate 9 en taille réduite.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if (!canViewDrive(await resolveDriveAccess(user, params.id))) return new NextResponse(null, { status: 403 });

  const node = await prisma.driveNode.findUnique({
    where: { id: params.id },
    select: { name: true, mimeType: true, type: true, isTrashed: true },
  });
  if (!node) return new NextResponse(null, { status: 404 });
  const qualite = qualiteDeLaRequete(req);

  // Dossier → téléchargement en archive ZIP (contenu récursif).
  if (node.type === "FOLDER") {
    const res = await collecterPourZip([{ id: params.id, name: node.name, type: "FOLDER" }]);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    if (qualite === "estimer") {
      return repondreEstimationArchive({
        nomArchive: res.filename, noms: res.items.map((i) => i.chemin), octetsTotal: res.total,
        cle: `drive:${res.items.map((i) => i.blobId).join(",")}`, entrees: () => entreesDeDrive(res.items),
      });
    }
    return repondreArchive(res.filename, entreesDeDrive(res.items), qualite, {
      octetsTotal: res.total,
      journaliser: (q) => recordAudit({ actorId: user.id, action: "EXPORT", module: "Drive", entityType: "DRIVE_NODE", entityId: params.id, summary: `Téléchargement du dossier « ${node.name} » (ZIP${q === "reduite" ? " compressé" : ""}, ${res.items.length} fichier·s)` }),
    });
  }

  const version = await prisma.fileVersion.findFirst({
    where: { nodeId: params.id },
    orderBy: { version: "desc" },
    select: { blobId: true, mimeType: true },
  });
  if (!version) return new NextResponse(null, { status: 404 });

  const dl = req.nextUrl.searchParams.get("dl") === "1";
  // GROS FICHIER DÉPOSÉ EN DIRECT : le navigateur le lit dans le bucket, sur une adresse signée
  // pour quinze minutes. Le servir d'ici le ferait passer entier par la mémoire de l'instance —
  // plusieurs gigaoctets sur 512 Mo. Les droits viennent d'être vérifiés, c'est eux qui signent.
  const direct = await cleObjetDirect(version.blobId);
  const mime = node.mimeType ?? version.mimeType ?? "application/octet-stream";
  const info = await infoBlob(version.blobId);
  return repondreFichier(
    { nom: node.name, mime, charger: () => getBlob(version.blobId), empreinte: info?.sha256 ?? null, taille: info?.size ?? null },
    {
      qualite,
      telecharger: dl,
      journaliser: (q) => dl
        ? recordAudit({ actorId: user.id, action: "EXPORT", module: "Drive", entityType: "DRIVE_NODE", entityId: params.id, summary: `Téléchargement « ${node.name} »${q === "reduite" ? " (taille réduite)" : ""}` })
        : undefined,
      entetes: { "Cache-Control": "private, no-store" },
      redirection: () => direct
        // Le bucket ne porte pas de CSP : un type actif (HTML, SVG, XML) s'y télécharge (`lib/http/types-actifs.ts`).
        ? presignGetUrl(direct, 900, { "response-content-disposition": contentDisposition(node.name, dispositionPourBucket(mime, dl ? "attachment" : "inline")), "response-content-type": mime })
        : null,
    },
  );
}
