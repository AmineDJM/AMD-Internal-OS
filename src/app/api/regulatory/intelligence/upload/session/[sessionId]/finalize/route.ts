import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { finalizeUploadSession } from "@/lib/regulatory/intelligence/upload/session";

/**
 * Finalisation d'une session d'upload (G14) : vérifie taille + SHA-256, assemble les parties,
 * PUIS lance l'ingestion sécurisée (inspection seulement après finalisation).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, props: { params: Promise<{ sessionId: string }> }) {
  const params = await props.params;
  try {
    const user = await getCurrentUserPourEcrire();
    if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
    if (!regCan(user, "regulatory.dossier.upload")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
    const companyId = await resolveRegCompanyIdFor(user.id);
    if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

    const r = await finalizeUploadSession(params.sessionId, companyId, user.id);
    // 503 (réessayable) pour un problème TRANSITOIRE (interruption, finalisation en cours) → le
    // client retente ; 422 pour une erreur DÉFINITIVE (données/quota) → remontée immédiate.
    if (!r.ok) return NextResponse.json({ error: r.error, retryable: r.retryable ?? false }, { status: r.retryable ? 503 : 422 });
    return NextResponse.json({ ok: true, versionId: r.ingest?.versionId, versionNo: r.ingest?.versionNo, summary: r.ingest?.summary });
  } catch (err) {
    // Filet ultime : jamais de 500/HTML illisible côté client. La session est réouverte en interne
    // (voir finalizeUploadSession) → « relancez le même fichier » reprend proprement.
    console.error("[reg-upload/finalize] erreur non gérée", err);
    return NextResponse.json(
      { error: "Finalisation interrompue (serveur) — relancez le même fichier pour reprendre.", retryable: true },
      { status: 503 },
    );
  }
}
