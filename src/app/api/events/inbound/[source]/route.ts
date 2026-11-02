import { NextResponse } from "next/server";
import { EN_TETES_SIGNATURE, autoriser, ingerer } from "@/platform/in-process/events/ingestion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * L'ENTRÉE DES FAITS EXTERNES (mandat 5 §37) — `POST /api/events/inbound/{source}`.
 *
 * DocuSign, SAP, HubSpot, la plateforme PCH, IQVIA, une e-signature, ou n'importe quel système
 * (`generic`) poussent ici. Route PUBLIQUE (le fournisseur n'a pas de session), jamais ouverte :
 *   1. la source doit être connue (400 sinon) ;
 *   2. sans secret pour cette source, la route refuse tout (503) — pas de mode « ouvert » ;
 *   3. la signature HMAC-SHA256 du corps BRUT est vérifiée avant toute lecture (401 sinon) ;
 *   4. le corps doit être du JSON (400 sinon) ;
 *   5. l'identifiant fournisseur rend les relivraisons idempotentes (`IngestedEvent`).
 *
 * La réponse reste laconique — des comptes, jamais le détail d'un refus : on ne renseigne pas un
 * attaquant sur ce qui a échoué. Le détail est dans `inbound_events`, sous la vue globale.
 */
export async function POST(req: Request, props: { params: Promise<{ source: string }> }) {
  const params = await props.params;
  const raw = await req.text();
  let signature: string | null = null;
  for (const h of EN_TETES_SIGNATURE) { signature = req.headers.get(h); if (signature) break; }
  const a = autoriser(params.source ?? "", raw, signature);
  if (!a.ok) return NextResponse.json({ ok: false }, { status: a.statut });

  let corps: unknown;
  try { corps = JSON.parse(raw); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  if (corps === null || typeof corps !== "object") return NextResponse.json({ ok: false }, { status: 400 });

  try {
    const r = await ingerer(a.source, corps);
    return NextResponse.json({ ok: true, recus: r.recus, acceptes: r.acceptes, doublons: r.doublons, rejetes: r.rejetes, aVerifier: r.aVerifier });
  } catch (err) {
    console.error("[events/inbound] ingestion impossible", a.source, err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
