import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { finalizeDirectUploadSession } from "@/lib/regulatory/intelligence/upload/session";

/**
 * Finalisation d'un ENVOI DIRECT (chantier 1) : le fichier est déjà dans le bucket (PUT présigné
 * navigateur → S3/R2). Le serveur le LIT, l'inspecte et l'ingère, puis supprime l'archive temporaire.
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

    // MULTIPART : le navigateur renvoie l'empreinte (ETag) de chaque partie, dans l'ordre. Sans
    // elles, S3 refuse de recoller le fichier. Corps absent = envoi en un seul PUT, rien à lire.
    // Secours quand le stockage ne liste pas ses parties : un tableau (ancien protocole) ou `{ "1": "…" }`.
    let etags: string[] | Record<number, string> | undefined;
    try {
      const body = (await req.json()) as { etags?: unknown };
      if (Array.isArray(body?.etags)) etags = body.etags.map((e) => String(e));
      else if (body?.etags && typeof body.etags === "object") {
        const parPartie: Record<number, string> = {};
        for (const [k, v] of Object.entries(body.etags as Record<string, unknown>)) if (/^\d+$/.test(k) && typeof v === "string") parPartie[Number(k)] = v;
        etags = parPartie;
      }
    } catch { /* pas de corps : envoi simple */ }

    const r = await finalizeDirectUploadSession(params.sessionId, companyId, user.id, etags);
    // Un envoi INCOMPLET n'est pas un échec : la réponse nomme les parties manquantes, et le
    // navigateur rouvre la session (reprise) pour ne renvoyer qu'elles.
    if (!r.ok) return NextResponse.json({ error: r.error, manquantes: r.manquantes ?? [], reprendre: (r.manquantes?.length ?? 0) > 0, retryable: (r.manquantes?.length ?? 0) === 0 && (r.retryable ?? false) }, { status: (r.manquantes?.length ?? 0) > 0 ? 409 : 422 });
    return NextResponse.json({ ok: true, summary: r.ingest?.summary ?? null });
  } catch (err) {
    console.error("[reg-upload/direct/finalize] erreur non gérée", err);
    return NextResponse.json({ error: "Erreur serveur à la finalisation de l'envoi direct." }, { status: 500 });
  }
}
