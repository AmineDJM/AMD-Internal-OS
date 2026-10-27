"use server";

import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { validateDocumentUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { getBlob } from "@/lib/drive-storage";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { fdStr } from "@/lib/actions/types";
import { lireDocumentLegal, type ResultatLectureDocument } from "@/lib/pieces-lues/document-legal";

/**
 * LIRE LA PIÈCE D'UN NOUVEAU DOCUMENT LEGAL — le premier geste de « Nouveau document » et de « Nouvelle facture ».
 *
 * La lecture PROPOSE ce que le formulaire montrera ; elle n'écrit rien — ni document, ni pièce jointe. La porte est
 * celle de la création : qui ne peut pas déclarer un document dans Legal (ou une facture aux Finances) ne fait pas lire
 * de pièce ici. Le fichier vient du formulaire (`fichier`) ou du Drive (`driveNodeId`) — et dans ce cas, la porte du
 * Drive est revérifiée : un identifiant venu d'un champ ne se croit pas sur parole.
 *
 * `confidentiel=1` : la personne l'a dit AVANT la lecture — rien ne sort de l'ERP (`lireDocumentLegal`).
 */
export async function lireDocumentLegalPourSaisie(formData: FormData): Promise<ResultatLectureDocument> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "CREATE") && !userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };
  const confidentielle = fdStr(formData, "confidentiel") === "1";
  const natureImposee = fdStr(formData, "nature") === "INVOICE" ? "INVOICE" : null;

  const fichier = formData.get("fichier");
  if (fichier instanceof File && fichier.size > 0) {
    const invalide = validateDocumentUpload(fichier.name, fichier.size, (await getAppSettings()).maxUploadMb);
    if (invalide) return { ok: false, error: `« ${fichier.name} » : ${invalide}` };
    return lireDocumentLegal({ user, octets: Buffer.from(await fichier.arrayBuffer()), nomFichier: fichier.name, confidentielle, natureImposee });
  }

  const driveNodeId = fdStr(formData, "driveNodeId");
  if (!driveNodeId) return { ok: false, error: "Choisissez la pièce à lire." };
  const node = await prisma.driveNode.findUnique({
    where: { id: driveNodeId },
    select: { name: true, type: true, isTrashed: true, versions: { orderBy: { version: "desc" }, take: 1, select: { blobId: true } } },
  });
  if (!node || node.isTrashed) return { ok: false, error: "Ce fichier n'existe plus dans le Drive." };
  if (!canViewDrive(await resolveDriveAccess(user, driveNodeId))) return { ok: false, error: "Vous n'avez pas accès à ce fichier du Drive." };
  // UN DOSSIER SE RÉFÉRENCE, il ne se lit pas : le formulaire s'ouvre vide, le lien du Drive y reste.
  if (node.type !== "FILE") return { ok: false, error: "Un dossier du Drive ne se lit pas : il sera référencé tel quel. Complétez le formulaire." };
  const blobId = node.versions[0]?.blobId;
  const octets = blobId ? await getBlob(blobId) : null;
  if (!octets) return { ok: false, error: "Le contenu de ce fichier du Drive est introuvable." };
  return lireDocumentLegal({ user, octets, nomFichier: node.name, confidentielle, natureImposee });
}
