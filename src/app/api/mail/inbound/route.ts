import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { mailProvider, verifyInboundSignature, normalizeInbound } from "@/lib/mail-smart";
import { isAutomatedSender } from "@/lib/comms/loop-safety";
import { recevoirPieces } from "@/modules/assistant-ia/api";
import { destinatairesDuCourrier, entetesDuCourrier, piecesDuCourrier } from "@/platform/ia/canaux/courrier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * RÉCEPTION DU COURRIER — le fournisseur pousse, on ne relève rien.
 *
 * Fini la boîte IMAP à interroger en boucle : le fournisseur appelle cette route dès qu'un
 * message arrive. Route PUBLIQUE (le fournisseur n'a pas de session) mais jamais ouverte :
 *   1. la signature HMAC du corps BRUT est vérifiée avant toute lecture du contenu ;
 *   2. sans `MAIL_WEBHOOK_SECRET`, la route refuse tout — pas de mode « ouvert par défaut » ;
 *   3. l'identifiant de message rend les relivraisons idempotentes (le fournisseur réessaie
 *      volontiers : on ne veut pas dix copies du même e-mail).
 *
 * Les réponses restent laconiques : on ne renseigne pas un attaquant sur ce qui a échoué.
 *
 * K6 (décision 0036) : un courrier adressé à L'ASSISTANT (`ASSISTANT_IA_MAIL`, une ou plusieurs adresses) porte des
 * pièces pour l'Assistant IA de son expéditeur — reconnu par son adresse, mêmes gardes et même stockage que WhatsApp
 * (`recevoirPieces` : idempotence, expéditeur automatique écarté, taille, injection, Drive, carte, journal).
 */
export async function POST(req: Request) {
  const secret = (process.env.MAIL_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });

  const raw = await req.text();
  const signature =
    req.headers.get("x-webhook-signature") ??
    req.headers.get("x-mail-signature") ??
    req.headers.get("svix-signature");

  if (!verifyInboundSignature(raw, signature, secret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const provider = mailProvider() ?? "resend";
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const msg = normalizeInbound(provider, payload);
  if (!msg) return NextResponse.json({ ok: false }, { status: 400 });

  // L'ASSISTANT IA (K6) : avant la boîte commune — ses pièces ne dépendent pas de l'enregistrement du courrier.
  const adressesAssistant = (process.env.ASSISTANT_IA_MAIL ?? "").toLowerCase().split(/[,;\s]+/).filter((a) => a.includes("@"));
  const pourAssistant = adressesAssistant.length > 0 && destinatairesDuCourrier(payload).some((a) => adressesAssistant.includes(a));
  if (pourAssistant) {
    const r = await recevoirPieces({
      canal: "MAIL",
      idExterne: msg.messageId || createHash("sha256").update(raw).digest("hex"),
      expediteur: msg.fromAddress,
      texte: msg.subject,
      fichiers: piecesDuCourrier(payload),
      automatique: isAutomatedSender({ from: msg.fromAddress, subject: msg.subject, headers: entetesDuCourrier(payload) }),
    });
    return NextResponse.json({ ok: true, assistant: r.issue });
  }

  try {
    // Relivraison du même message → on ne duplique pas (contrainte d'unicité sur messageId).
    if (msg.messageId) {
      const seen = await prisma.inboundEmail.findUnique({ where: { messageId: msg.messageId }, select: { id: true } });
      if (seen) return NextResponse.json({ ok: true, duplicate: true });
    }
    await prisma.inboundEmail.create({
      data: {
        provider,
        messageId: msg.messageId,
        fromAddress: msg.fromAddress,
        fromName: msg.fromName,
        toAddress: msg.toAddress,
        subject: msg.subject.slice(0, 500),
        text: msg.text.slice(0, 100_000),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[mail-smart] réception impossible", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
