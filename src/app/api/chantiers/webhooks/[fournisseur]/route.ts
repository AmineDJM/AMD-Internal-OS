import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/events/ledger";
import { connecteursDev } from "@/platform/in-process/chantiers/connecteurs";
import { recevoirWebhook } from "@/platform/in-process/chantiers/reception";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * LES WEBHOOKS DES CHANTIERS DE DÉVELOPPEMENT (lot C2, décision 0041) — `POST /api/chantiers/webhooks/{github|render}`.
 *
 * Route PUBLIQUE (GitHub et Render n'ont pas de session), jamais ouverte :
 *   1. sans secret (`GITHUB_WEBHOOK_SECRET`, `RENDER_WEBHOOK_SECRET`) la source est fermée — 503 ;
 *   2. la signature du corps BRUT est vérifiée avant toute lecture (GitHub `X-Hub-Signature-256`, Render Standard
 *      Webhooks à ± 5 min) — 401 ;
 *   3. chaque fait est réclamé sous sa clé sémantique (`IngestedEvent`) : relivraisons et sondage ne l'inscrivent
 *      qu'une fois ; `recordEvent` réveille les missions qui l'attendent.
 * Réponse laconique (des comptes) ; GitHub et Render veulent un 2xx vite (Render : 15 s).
 */
export async function POST(req: Request, props: { params: Promise<{ fournisseur: string }> }) {
  const { fournisseur } = await props.params;
  const brut = await req.text();
  try {
    const issue = await recevoirWebhook(fournisseur ?? "", brut, req.headers, {
      inscrire: recordEvent,
      hebergeur: fournisseur === "render" ? connecteursDev().hebergeur : null,
    });
    if (issue.statut !== 200 || !issue.bilan) return NextResponse.json({ ok: false }, { status: issue.statut });
    return NextResponse.json({ ok: true, recus: issue.bilan.recus, nouveaux: issue.bilan.nouveaux, doublons: issue.bilan.doublons });
  } catch (err) {
    console.error("[chantiers/webhooks] réception impossible", fournisseur, err instanceof Error ? err.message : "erreur");
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
