import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { putUploadPart } from "@/lib/regulatory/intelligence/upload/session";

/**
 * Envoi d'UNE partie d'une session d'upload (G14). Corps = octets bruts de la partie ;
 * `?index=N` = numéro de partie. Idempotent → reprise/retente possible. Le chemin d'upload
 * ne charge qu'UNE partie en mémoire (jamais l'archive complète).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function PUT(req: NextRequest, props: { params: Promise<{ sessionId: string }> }) {
  const params = await props.params;
  try {
    const user = await getCurrentUserPourEcrire();
    if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
    if (!regCan(user, "regulatory.dossier.upload")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
    const companyId = await resolveRegCompanyIdFor(user.id);
    if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

    const index = Number(req.nextUrl.searchParams.get("index"));
    if (!Number.isInteger(index) || index < 0) return NextResponse.json({ error: "Index de partie invalide." }, { status: 400 });

    let data: Buffer;
    try {
      data = Buffer.from(await req.arrayBuffer());
    } catch {
      return NextResponse.json({ error: "Lecture de la partie impossible." }, { status: 400 });
    }
    if (data.length === 0) return NextResponse.json({ error: "Partie vide." }, { status: 400 });

    const r = await putUploadPart({ sessionId: params.sessionId, companyId, index, data });
    // 422 = erreur métier/DB RÉESSAYABLE (le client retente la même partie sans perdre le reste).
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Filet de sécurité : jamais de 500 non géré (sinon le client échoue sèchement). Journalisé.
    console.error("[reg-upload/part] erreur non gérée", err);
    return NextResponse.json({ error: "Erreur serveur au stockage de la partie — réessai." }, { status: 500 });
  }
}
