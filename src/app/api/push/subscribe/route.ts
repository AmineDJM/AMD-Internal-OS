import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { endpointPushAutorise } from "@/lib/notifications/endpoint-push";
import { attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/** Enregistre l'abonnement push (PushSubscription) de l'appareil de l'utilisateur. */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const body = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: "Abonnement invalide" }, { status: 400 });
  // Le serveur POSTera vers cette adresse : seulement un service push de navigateur (`endpoint-push.ts`).
  if (!endpointPushAutorise(endpoint) || p256dh.length > 512 || auth.length > 256) {
    return NextResponse.json({ error: "Abonnement invalide" }, { status: 400 });
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 200) ?? null;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: user.id, endpoint, p256dh, auth, userAgent },
    update: { userId: user.id, p256dh, auth, userAgent },
  });
  return NextResponse.json({ ok: true });
}

/** Désabonne l'appareil (ex. notifications refusées / déconnexion). */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const body = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null))) as { endpoint?: string } | null;
  if (body?.endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: user.id } });
  return NextResponse.json({ ok: true });
}
