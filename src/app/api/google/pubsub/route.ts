import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveGoogleConfig } from "@/lib/google/config";
import { verifyPubSubToken, parsePubSubEnvelope, safeEqual } from "@/lib/google/pubsub-verify";
import { syncFromHistory, adamConnection } from "@/lib/google/gmail/reconcile";
import { sansBloquer, attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * LA SONNETTE DE GOOGLE — le push Gmail.
 *
 * Ce point d'entrée est PUBLIC : il n'y a pas de session, Google n'en a pas. Toute la sécurité
 * tient donc à la preuve d'origine (voir `pubsub-verify.ts`) : un secret dans l'URL d'abonnement,
 * et surtout le jeton OIDC signé par Google, vérifié pour de bon.
 *
 * Deux principes que ce fichier applique littéralement :
 *
 *   • **La notification n'est pas le message.** On ne lit RIEN du contenu poussé pour décider
 *     quoi que ce soit : on va demander à Google ce qui a réellement changé. Croire la charge
 *     utile reviendrait à laisser un inconnu écrire dans la mémoire du PDG.
 *
 *   • **On répond 200 même quand on ne fait rien d'utile.** Pub/Sub rejoue indéfiniment ce qui
 *     échoue ; un 500 sur un message qu'on ne saura jamais traiter produit une boucle de rejeu
 *     sans fin. On ne rend une erreur QUE pour ce qui mérite d'être rejoué.
 */
export async function POST(req: NextRequest) {
  const env = process.env as Record<string, string | undefined>;
  const cfg = resolveGoogleConfig(env);

  // 1) Secret partagé dans l'URL de l'abonnement — la première barrière, contre le bruit de fond.
  const expectedToken = env.GOOGLE_PUBSUB_TOKEN?.trim();
  if (expectedToken) {
    const given = req.nextUrl.searchParams.get("token") ?? "";
    if (!safeEqual(given, expectedToken)) {
      return NextResponse.json({ ok: false, error: "jeton invalide" }, { status: 401 });
    }
  }

  // 2) Jeton OIDC signé par Google — la vraie preuve d'origine, quand l'abonnement en pose un.
  const auth = req.headers.get("authorization");
  if (auth) {
    const verdict = await verifyPubSubToken(auth, {
      expectedAudience: cfg?.pubsubAudience ?? null,
      expectedEmail: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT?.trim() || null,
    });
    if (!verdict.ok) {
      console.error("[adam][pubsub] push refusé", { reason: verdict.reason });
      return NextResponse.json({ ok: false, error: "origine non vérifiée" }, { status: 401 });
    }
  } else if (!expectedToken) {
    // Ni jeton signé, ni secret : on refuse plutôt que d'accepter n'importe qui. La
    // réconciliation périodique garantit qu'aucun message n'est perdu pour autant.
    console.error("[adam][pubsub] push sans aucune preuve d'origine — refusé");
    return NextResponse.json({ ok: false, error: "origine non vérifiée" }, { status: 401 });
  }

  const body = await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null));
  const envelope = parsePubSubEnvelope(body);
  const address = typeof envelope.data?.emailAddress === "string" ? envelope.data.emailAddress.toLowerCase() : null;

  const conn = address
    ? await prisma.googleConnection.findFirst({ where: { address, paused: false }, select: { id: true, gmail: true } })
    : await adamConnection();

  // Une notification pour une boîte qu'on ne sert pas : accusée, ignorée. La rejouer ne servirait
  // à rien, et Pub/Sub insisterait indéfiniment.
  if (!conn) return NextResponse.json({ ok: true, ignored: "boîte inconnue" });

  await prisma.gmailIngestionState.upsert({
    where: { connectionId: conn.id },
    create: { connectionId: conn.id, lastNotifiedAt: new Date() },
    update: { lastNotifiedAt: new Date() },
  }).catch(sansBloquer("pubsub-route.POST.gmailIngestionState"));

  try {
    // On ne prend PAS l'`historyId` du push comme point de départ : le nôtre fait foi. Le push ne
    // dit que « quelque chose a bougé ».
    const res = await syncFromHistory(conn.id);
    return NextResponse.json({ ok: true, ingested: res.ingested, via: res.via });
  } catch (err) {
    // Erreur transitoire (Google injoignable) : on laisse Pub/Sub rejouer.
    console.error("[adam][pubsub] synchronisation échouée", {
      error: err instanceof Error ? err.message.slice(0, 150) : "inconnue",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
