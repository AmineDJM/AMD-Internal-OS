import { NextResponse } from "next/server";
import { recevoirMessage } from "@/modules/assistant-ia/api";
import { messagesDepuisRelais, signatureRelaisValide } from "@/platform/ia/canaux/port";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RELAIS DU CANAL ENTRANT — lot K6, décision 0036.
 *
 * Pour un WhatsApp relié par un service extérieur (Make, n8n, Twilio…) plutôt que par le webhook Meta : le relais poste
 * `{ id, de, texte?, pieces: [{ nom, mime?, base64? | url? }] }`, signé HMAC-SHA256 hexadécimal du corps brut avec
 * `CANAUX_RELAIS_SECRET` (en-tête `x-relais-signature`). Sans secret : 503 ; mauvaise signature : 401. Ensuite, la même
 * réception que Meta (personne par numéro, idempotence, Drive, carte, journal) ; la réponse à renvoyer à l'expéditeur
 * revient dans `reponses` — c'est le relais qui l'envoie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function POST(req: Request) {
  const secret = (process.env.CANAUX_RELAIS_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });
  const brut = await req.text();
  if (brut.length > 40_000_000) return NextResponse.json({ ok: false }, { status: 413 });
  if (!signatureRelaisValide(brut, req.headers.get("x-relais-signature"), secret)) return NextResponse.json({ ok: false }, { status: 401 });
  let charge: unknown;
  try { charge = JSON.parse(brut); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  const issues: string[] = [];
  const reponses: { a: string; texte: string }[] = [];
  for (const m of messagesDepuisRelais(charge)) {
    const r = await recevoirMessage(m);
    issues.push(r.issue);
    if (r.reponse && r.issue !== "DOUBLON") reponses.push({ a: m.de, texte: r.reponse });
  }
  return NextResponse.json({ ok: true, issues, reponses });
}
