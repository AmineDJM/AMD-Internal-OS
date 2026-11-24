import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { startUploadSession, startDirectUploadSession, objectStorageConfigured, DEFAULT_PART_SIZE, SMALL_FILE_THRESHOLD, MAX_TOTAL_BYTES, UPLOAD_CONCURRENCY } from "@/lib/regulatory/intelligence/upload/session";
import { refusSansStockageObjet } from "@/lib/storage/phrases-stockage";
import { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";

/**
 * Ouverture d'une SESSION d'upload résumable (G14) — pour les gros dossiers CTD.
 * Les petits fichiers (< seuil) restent servis par la route directe /upload.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!regCan(user, "regulatory.dossier.upload")) return NextResponse.json({ error: "Téléversement non autorisé." }, { status: 403 });
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return NextResponse.json({ error: "Module non activé pour cette entité." }, { status: 403 });

  let body: { dossierId?: string; filename?: string; totalBytes?: number; partSize?: number; sha256?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  if (!body.dossierId || !body.filename || !body.totalBytes) return NextResponse.json({ error: "Paramètres manquants." }, { status: 400 });

  // CHANTIER 1 — si un stockage objet est configuré, on route vers l'envoi DIRECT (navigateur →
  // bucket, bypass serveur + Postgres). Sinon, envoi résumable en base (comportement historique).
  if (objectStorageConfigured()) {
    const d = await startDirectUploadSession({
      companyId, dossierId: body.dossierId, createdById: user.id, filename: body.filename,
      contentType: body.contentType ?? null, totalBytes: Number(body.totalBytes), expectedSha256: body.sha256 ?? null,
    });
    if (!d.ok) return NextResponse.json({ error: d.error }, { status: 422 });
    // MULTIPART : le navigateur reçoit le PLAN — une adresse signée par partie MANQUANTE, et la
    // liste de celles que le bucket a déjà (reprise) — et envoie les parties EN PARALLÈLE.
    if (d.plan) {
      return NextResponse.json({
        ok: true, mode: "direct-multipart", sessionId: d.sessionId, plan: d.plan, resumed: d.resumed ?? false,
        partSize: d.partSize, concurrency: d.concurrency, maxTotalBytes: MAX_TOTAL_BYTES,
      });
    }
    return NextResponse.json({ ok: true, mode: "direct", sessionId: d.sessionId, uploadUrl: d.uploadUrl, maxTotalBytes: MAX_TOTAL_BYTES });
  }

  // SANS STOCKAGE OBJET, un très gros dossier ne s'écrit PAS en base : il remplirait Postgres
  // (≈ 1 Go sur l'offre gratuite) et ferait tomber l'application. Le refus nomme les variables.
  if (Number(body.totalBytes) > MAX_SANS_STOCKAGE_OBJET_MO * 1024 * 1024) {
    return NextResponse.json({ error: refusSansStockageObjet(Number(body.totalBytes), MAX_SANS_STOCKAGE_OBJET_MO, user.role === "SUPER_ADMIN") }, { status: 413 });
  }

  const r = await startUploadSession({
    companyId, dossierId: body.dossierId, createdById: user.id, filename: body.filename,
    contentType: body.contentType ?? null, totalBytes: Number(body.totalBytes), partSize: body.partSize, expectedSha256: body.sha256 ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422 });
  return NextResponse.json({ ok: true, mode: "resumable", sessionId: r.sessionId, partSize: r.partSize, expectedParts: r.expectedParts, receivedIndices: r.receivedIndices ?? [], resumed: r.resumed ?? false, concurrency: UPLOAD_CONCURRENCY, smallFileThreshold: SMALL_FILE_THRESHOLD, defaultPartSize: DEFAULT_PART_SIZE, maxTotalBytes: MAX_TOTAL_BYTES });
}
