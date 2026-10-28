import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { validateDriveUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { quotaVerdict } from "@/lib/drive/quota";
import { userUsageBytes, physicalUsageBytes, addPhysicalUsage } from "@/lib/drive/usage";
import { objectStorageConfigured } from "@/lib/storage/object-storage";
import { startTimer, formatTiming } from "@/lib/drive/timing";
import { refusDepotDrive, enregistrerFichierDrive } from "@/lib/drive/depot";
import { BLOB_MAX_BYTES } from "@/lib/storage/limites-blob";
import { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";
import { refusSansStockageObjet } from "@/lib/storage/televersement-direct";

/** Upload a new file (under `parentId`) or a new version (of `nodeId`). */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });

  // CHRONOMÈTRE. « C'est lent » ne se corrige pas : il faut savoir quelle étape coûte, et le
  // savoir depuis la production. Chaque envoi rapporte son propre découpage.
  const timer = startTimer();
  const form = await req.formData();
  timer.mark("réception");
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  const cible = {
    nodeId: (form.get("nodeId") as string) || null,
    parentId: (form.get("parentId") as string) || null,
    spaceId: (form.get("spaceId") as string) || null,
    category: (form.get("category") as string) || null,
    viewers: form.getAll("viewers").map(String).filter(Boolean),
    editors: form.getAll("editors").map(String).filter(Boolean),
  };

  const refus = await refusDepotDrive(user, cible);
  if (refus) return NextResponse.json({ error: refus.error }, { status: refus.status });

  const settings = await getAppSettings();
  const err = validateDriveUpload(file.name, file.size, settings.maxDriveUploadMb);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  // UN TRÈS GROS FICHIER NE PASSE PAS PAR ICI. Ce chemin tient le fichier entier en mémoire puis
  // l'écrit — en BASE quand aucun stockage objet n'est configuré, ce qui remplirait Postgres
  // (≈ 1 Go sur l'offre gratuite) et ferait tomber l'application entière. Il se refuse, et le
  // refus nomme les variables à poser pour l'accepter.
  if (!objectStorageConfigured() && file.size > MAX_SANS_STOCKAGE_OBJET_MO * 1024 * 1024) {
    return NextResponse.json({ error: refusSansStockageObjet(file.size, MAX_SANS_STOCKAGE_OBJET_MO) }, { status: 413 });
  }

  // Au-delà de 2 Go, le coffre chiffré ne peut pas tenir le fichier : seul l'envoi direct au bucket
  // (parties de 32 Mo, depuis le navigateur) le reçoit. Ce chemin-ci le lirait en mémoire.
  if (file.size > BLOB_MAX_BYTES) {
    return NextResponse.json({ error: `Ce fichier (${Math.round(file.size / 1024 ** 2)} Mo) dépasse 2 Go : il doit être envoyé directement au stockage. Rechargez la page et renvoyez-le.` }, { status: 413 });
  }

  // Quotas (réglés dans Administration → Stockage Drive) : par utilisateur (somme de SES fichiers
  // actifs, relue à chaque fois — c'est elle qui refuse) et capacité globale (mesure partagée,
  // relue au plus toutes les 30 s : sans cela, chaque fichier d'un lot payait un parcours complet
  // de la table des blobs AVANT d'écrire le moindre octet).
  timer.mark("autorisation");
  const [myUsage, physical] = await Promise.all([userUsageBytes(user.id), physicalUsageBytes()]);
  timer.mark("quotas");
  const verdict = quotaVerdict({
    userUsageBytes: myUsage, physicalUsageBytes: physical, fileSize: file.size,
    userQuotaGb: settings.driveUserQuotaGb, capacityGb: settings.driveCapacityGb,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  let ecrit: Awaited<ReturnType<typeof putBlob>>;
  try {
    ecrit = await putBlob(buf);
  } catch (e) {
    // Une écriture refusée se DIT, avec sa cause — jamais une erreur 500 opaque.
    return NextResponse.json({ error: e instanceof Error ? e.message : "Écriture impossible." }, { status: 503 });
  }
  const { blobId, size, deduplicated, storedSize } = ecrit;
  timer.mark(deduplicated ? "contenu déjà présent" : "chiffrement + stockage");
  // Un contenu dédupliqué n'occupe pas de place NEUVE : le compter gonflerait l'occupation jusqu'à
  // refuser des envois qui tiennent parfaitement.
  if (!deduplicated) addPhysicalUsage(storedSize ?? size); // le COMPRIMÉ quand le stockage l'a compressé
  const mimeType = file.type || "application/octet-stream";

  const res = await enregistrerFichierDrive(user, cible, { blobId, size, mimeType, name: file.name, sha256: ecrit.sha256 });
  timer.mark("base");
  // Le découpage part dans la réponse (l'écran le montre quand un envoi traîne) ET dans le
  // journal du serveur — on peut ainsi diagnostiquer sans demander à personne de rejouer le cas.
  const t = timer.done(objectStorageConfigured() ? "objet" : "base", size);
  console.info("[drive upload]", file.name, formatTiming(t));
  return NextResponse.json({ id: res.id, ...(res.version ? { version: res.version } : {}), timing: t });
}
