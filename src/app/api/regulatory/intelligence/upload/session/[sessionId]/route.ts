import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, getCurrentUserPourEcrire } from "@/lib/session";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { uploadSessionStatus, abortUploadSession } from "@/lib/regulatory/intelligence/upload/session";

/** État d'une session (reprise) + abandon. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function scope(req: NextRequest): Promise<{ companyId: string } | { error: string; status: number }> {
  // L'abandon ÉCRIT : il part au nom de la vraie session, jamais de la personne visualisée (§118.184).
  const user = req.method === "GET" ? await getCurrentUser() : await getCurrentUserPourEcrire();
  if (!user) return { error: "Non authentifié.", status: 401 };
  if (!regCan(user, "regulatory.dossier.upload")) return { error: "Non autorisé.", status: 403 };
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return { error: "Module non activé.", status: 403 };
  return { companyId };
}

export async function GET(req: NextRequest, props: { params: Promise<{ sessionId: string }> }) {
  const params = await props.params;
  const s = await scope(req);
  if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });
  const r = await uploadSessionStatus(params.sessionId, s.companyId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
  return NextResponse.json(r);
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ sessionId: string }> }) {
  const params = await props.params;
  const s = await scope(req);
  if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });
  await abortUploadSession(params.sessionId, s.companyId);
  return NextResponse.json({ ok: true });
}
