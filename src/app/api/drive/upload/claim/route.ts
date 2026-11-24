import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { quotaVerdict } from "@/lib/drive/quota";
import { userUsageBytes, physicalUsageBytes } from "@/lib/drive/usage";
import { validateDriveUpload } from "@/lib/storage";
import { retainBlob, releaseBlob } from "@/lib/drive-storage";
import { refusDepotDrive, enregistrerFichierDrive } from "@/lib/drive/depot";
import { lireChoixDoublon } from "@/lib/drive/depot-regles";
import { mimeFromName } from "@/lib/drive/mime-nom";
import { attendu } from "@/lib/journal";

/**
 * TÉLÉVERSEMENT INSTANTANÉ — quand le contenu est DÉJÀ là, on n'envoie pas les octets.
 *
 * Le stockage est adressé par le contenu : deux fichiers identiques partagent un seul blob. Mais
 * la déduplication ne se découvrait qu'APRÈS avoir tout envoyé au serveur. Re-déposer une
 * arborescence de 300 Mo dont 90 % existe déjà coûtait donc 300 Mo de réseau pour n'écrire
 * presque rien.
 *
 * Le navigateur calcule l'empreinte du fichier et la présente ici. Si le contenu est connu, on
 * crée le fichier en une requête, sans transférer un octet — c'est instantané, quelle que soit la
 * taille. Sinon on répond « inconnu » et l'envoi normal démarre.
 *
 * ── Pourquoi on ne se contente pas de « cette empreinte existe » ──
 * Connaître l'empreinte d'un fichier, c'est en posséder le contenu. Accepter n'importe quelle
 * empreinte transformerait cette route en oracle : « ce document précis est-il quelque part dans
 * l'ERP ? ». On exige donc que le demandeur puisse DÉJÀ VOIR au moins un fichier portant ce
 * contenu. Le cas courant — je redépose un fichier que j'ai, ou je réimporte un dossier — passe ;
 * l'oracle, non.
 */

/** Au-delà, on cesse de chercher : si aucune des premières copies n'est visible, l'envoi normal suffit. */
const MAX_CANDIDATES = 25;

export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });

  const body = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null))) as {
    sha256?: string; name?: string; size?: number;
    parentId?: string | null; spaceId?: string | null; category?: string | null;
    viewers?: string[]; editors?: string[]; siExiste?: string;
  } | null;

  const hash = (body?.sha256 ?? "").trim().toLowerCase();
  const name = (body?.name ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(hash) || !name) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

  const parentId = body?.parentId || null;
  const spaceId = body?.spaceId || null;

  // MÊMES GARDES ET MÊME CRÉATION que l'envoi normal (audit Drive, C16) — le chemin rapide n'ouvre
  // aucune porte de plus : droit de dépôt, politique de types, puis `enregistrerFichierDrive` (partages,
  // doublon, signalement aux fiches et inscription à la bibliothèque, comme tout fichier déposé).
  const cible = {
    parentId, spaceId, category: body?.category ?? null,
    viewers: body?.viewers ?? [], editors: body?.editors ?? [], siExiste: lireChoixDoublon(body?.siExiste),
  };
  const refus = await refusDepotDrive(user, cible);
  if (refus) return NextResponse.json({ error: refus.error }, { status: refus.status });
  const settings = await getAppSettings();
  const invalide = validateDriveUpload(name, Number(body?.size ?? 1), settings.maxDriveUploadMb);
  if (invalide) return NextResponse.json({ error: invalide }, { status: 400 });

  const blob = await prisma.fileBlob.findUnique({ where: { sha256: hash }, select: { id: true, size: true } });
  if (!blob) return NextResponse.json({ known: false });

  // Le demandeur voit-il déjà une copie de ce contenu ? Sinon : pas d'oracle, envoi normal.
  const carriers = await prisma.fileVersion.findMany({
    where: { blobId: blob.id }, select: { nodeId: true }, take: MAX_CANDIDATES, orderBy: { id: "asc" },
  });
  let reachable = false;
  for (const c of carriers) {
    if (canViewDrive(await resolveDriveAccess(user, c.nodeId))) { reachable = true; break; }
  }
  if (!reachable) return NextResponse.json({ known: false });

  // Les quotas s'appliquent quand même : le fichier compte dans l'espace de la personne, même si
  // le contenu ne prend pas de place NEUVE sur le disque (d'où la capacité globale inchangée).
  const [myUsage, physical] = await Promise.all([userUsageBytes(user.id), physicalUsageBytes()]);
  const verdict = quotaVerdict({
    userUsageBytes: myUsage, physicalUsageBytes: physical, fileSize: 0,
    userQuotaGb: settings.driveUserQuotaGb, capacityGb: settings.driveCapacityGb,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  // Le nouveau détenteur est compté AVANT l'inscription ; une inscription qui échoue le rend.
  if (!(await retainBlob(blob.id))) return NextResponse.json({ known: false });
  try {
    const res = await enregistrerFichierDrive(user, cible, { blobId: blob.id, size: blob.size, mimeType: mimeFromName(name), name, sha256: hash });
    return NextResponse.json({ known: true, id: res.id, ...(res.version ? { version: res.version } : {}) });
  } catch (e) {
    await releaseBlob(blob.id);
    throw e;
  }
}
