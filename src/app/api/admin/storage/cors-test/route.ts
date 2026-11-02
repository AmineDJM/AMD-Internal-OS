import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { deleteObject, objectStorageConfigured, createMultipartUpload, presignUploadPartUrl, abortMultipartUpload } from "@/lib/storage/object-storage";
import { finaliserEnvoi, TAILLE_PARTIE, CLIENT_S3 } from "@/lib/storage/televersement-direct";
import { sansBloquer, attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * TEST DE L'ENVOI DIRECT DEPUIS LE NAVIGATEUR — le VRAI chemin des gros fichiers, de bout en bout.
 *
 * Le test de connexion prouve que le SERVEUR parle au bucket. Les gros fichiers, eux, partent du
 * NAVIGATEUR en plusieurs parties : (1) POST ouvre un envoi en parties et signe la partie 1 ;
 * (2) le navigateur la pousse au bucket (il faut une règle CORS qui autorise le PUT) ; (3) PATCH
 * recolle comme le fait l'application, en relisant les empreintes au BUCKET (`ListParts`) — l'en-tête
 * `ETag` vu par le navigateur n'est qu'un secours. Sur Supabase Storage, qui n'expose pas `ETag` et
 * dont la règle CORS ne se règle pas, c'est ce qui distingue « ça marche » de « ça ne marche pas ».
 * Préfixe `_selftest/`, objet supprimé (ou envoi abandonné) à la fin. Super Admin seulement.
 */
export async function POST() {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "ADMIN", "UPDATE")) return NextResponse.json({ error: "Réservé au Super Admin." }, { status: 403 });
  if (!objectStorageConfigured()) return NextResponse.json({ error: "Stockage objet non configuré." }, { status: 400 });
  const key = `_selftest/cors-${randomUUID()}.txt`;
  let uploadId: string;
  try {
    uploadId = await createMultipartUpload(key, "text/plain");
  } catch (err) {
    return NextResponse.json({ error: `Ouverture d'un envoi en parties refusée par le stockage : ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
  const url = presignUploadPartUrl(key, uploadId, 1, 300);
  if (!url) {
    await abortMultipartUpload(key, uploadId);
    return NextResponse.json({ error: "Signature impossible." }, { status: 500 });
  }
  return NextResponse.json({ url, key, uploadId }, { headers: { "Cache-Control": "no-store" } });
}

const CLE_TEST = /^_selftest\/cors-[0-9a-f-]{36}\.txt$/;

/** Recolle la partie envoyée par le navigateur, comme l'application : empreintes relues au bucket d'abord. */
export async function PATCH(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "ADMIN", "UPDATE")) return NextResponse.json({ error: "Réservé au Super Admin." }, { status: 403 });
  const b = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", {}))) as { key?: unknown; uploadId?: unknown; total?: unknown; etag?: unknown };
  const key = typeof b.key === "string" ? b.key : "";
  const uploadId = typeof b.uploadId === "string" ? b.uploadId : "";
  const total = typeof b.total === "number" && Number.isInteger(b.total) && b.total > 0 && b.total < 1_000_000 ? b.total : 0;
  if (!CLE_TEST.test(key) || !uploadId || !total) return NextResponse.json({ error: "Demande refusée." }, { status: 400 });
  // 1) Comme en production quand le navigateur ne voit pas l'ETag : uniquement ce que le bucket liste.
  const parBucket = await finaliserEnvoi(key, uploadId, total, TAILLE_PARTIE, CLIENT_S3);
  let viaNavigateur = false;
  let issue = parBucket;
  // 2) Secours : l'empreinte vue par le navigateur, s'il a pu la lire.
  if (!parBucket.ok && typeof b.etag === "string" && b.etag.trim()) {
    issue = await finaliserEnvoi(key, uploadId, total, TAILLE_PARTIE, CLIENT_S3, { 1: b.etag.trim() });
    viaNavigateur = issue.ok;
  }
  if (issue.ok) await deleteObject(key).catch(sansBloquer("cors-test-route.PATCH.deleteObject"));
  else await abortMultipartUpload(key, uploadId);
  return NextResponse.json(
    issue.ok ? { ok: true, empreintes: viaNavigateur ? "navigateur" : "bucket" } : { ok: false, error: issue.erreur },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "ADMIN", "UPDATE")) return NextResponse.json({ error: "Réservé au Super Admin." }, { status: 403 });
  const key = req.nextUrl.searchParams.get("key") ?? "";
  // Seul un objet de test se supprime par ici — jamais une clé quelconque.
  if (!CLE_TEST.test(key)) return NextResponse.json({ error: "Clé refusée." }, { status: 400 });
  await deleteObject(key);
  return NextResponse.json({ ok: true });
}
