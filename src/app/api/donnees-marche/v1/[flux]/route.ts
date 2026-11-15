import { NextResponse } from "next/server";
import { verifierCleApi, etatDesDonnees, fluxNomenclature, fluxIqvia, fluxReceptionsHopital } from "@/modules/donnees-marche/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * LES FLUX DU SERVICE PORTEFEUILLE DCI — `GET /api/donnees-marche/v1/{etat|nomenclature|iqvia|receptions-hopital}`.
 * Route sans session : la clé `DONNEES_MARCHE_API_KEY` (en-tête `Authorization: Bearer …`) est exigée, comparée à
 * temps constant ; sans clé configurée, tout est refusé (503). Lecture seule.
 */
export async function GET(req: Request, props: { params: Promise<{ flux: string }> }) {
  const cle = verifierCleApi(req.headers.get("authorization"));
  if (!cle.ok) return NextResponse.json({ ok: false }, { status: cle.statut });
  const { flux } = await props.params;
  const url = new URL(req.url);
  let corps: unknown;
  switch (flux) {
    case "etat": corps = await etatDesDonnees(); break;
    case "nomenclature": corps = await fluxNomenclature(url.searchParams.get("onglet") ?? undefined); break;
    case "iqvia": corps = await fluxIqvia(); break;
    case "receptions-hopital": corps = await fluxReceptionsHopital(); break;
    default: return NextResponse.json({ ok: false }, { status: 404 });
  }
  return NextResponse.json(corps, { headers: { "Cache-Control": "private, no-store" } });
}
