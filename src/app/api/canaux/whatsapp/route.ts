import { NextResponse } from "next/server";
import { recevoirPieces, type FichierRecu } from "@/modules/assistant-ia/api";
import {
  configWhatsApp, envoyerTexteWhatsApp, lireNotificationWhatsApp, nomDuMedia, signatureWhatsAppValide, telechargerMediaWhatsApp, verifierAbonnement,
} from "@/platform/ia/canaux/whatsapp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE WEBHOOK WHATSAPP (API Cloud de Meta) — lot K6, décision 0036 : les pièces envoyées à l'assistant.
 *
 * Route PUBLIQUE (Meta n'a pas de session), jamais ouverte :
 *   • GET : l'abonnement — le défi n'est rendu que si `hub.verify_token` est `WHATSAPP_VERIFY_TOKEN` ;
 *   • POST : la signature `X-Hub-Signature-256` du corps BRUT (secret `WHATSAPP_APP_SECRET`) est vérifiée AVANT toute
 *     lecture ; sans secret, tout est refusé (503) — pas de mode « ouvert par défaut ».
 * Chaque message : la personne reconnue par son numéro (inconnue → refus poli, rien n'est stocké), le média téléchargé
 * (deux appels, jeton), puis la réception du module (idempotence par `wamid`, Drive, conversation, carte, journal).
 * Meta réessaie tant qu'on ne répond pas 200 : une erreur interne répond quand même 200, elle est au journal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export async function GET(req: Request) {
  const defi = verifierAbonnement(new URL(req.url).searchParams, (process.env.WHATSAPP_VERIFY_TOKEN ?? "").trim());
  if (defi === null) return new NextResponse("Refusé.", { status: 403 });
  return new NextResponse(defi, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(req: Request) {
  const secret = (process.env.WHATSAPP_APP_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });
  const brut = await req.text();
  if (brut.length > 1_000_000) return NextResponse.json({ ok: false }, { status: 413 });
  if (!signatureWhatsAppValide(brut, req.headers.get("x-hub-signature-256"), secret)) return NextResponse.json({ ok: false }, { status: 401 });
  let charge: unknown;
  try { charge = JSON.parse(brut); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const cfg = configWhatsApp();
  const issues: string[] = [];
  for (const m of lireNotificationWhatsApp(charge).slice(0, 20)) {
    // Le média n'est téléchargé qu'une fois l'expéditeur reconnu (chargement différé) : un inconnu ne coûte rien.
    const charger = async (): Promise<FichierRecu[]> => {
      if (!m.media) return [];
      const nom = nomDuMedia(m);
      if (!cfg) return [{ nom, mime: m.media.mime, octets: null, taille: null, raison: "WhatsApp n'est pas configuré pour télécharger les médias (WHATSAPP_TOKEN)" }];
      const t = await telechargerMediaWhatsApp(cfg, m.media.id, 25 * 1024 * 1024);
      return [t.ok ? { nom, mime: t.mime ?? m.media.mime, octets: t.octets, taille: t.octets.length } : { nom, mime: m.media.mime, octets: null, taille: null, raison: t.raison }];
    };
    const r = await recevoirPieces({ canal: "WHATSAPP", idExterne: m.id, expediteur: m.de, texte: m.texte, fichiers: charger });
    issues.push(r.issue);
    if (r.reponse && r.issue !== "DOUBLON") await envoyerTexteWhatsApp(cfg, m.de, r.reponse);
  }
  return NextResponse.json({ ok: true, issues });
}
