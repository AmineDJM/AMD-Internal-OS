import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/events/ledger";
import { jetonRelais } from "@/platform/dev/config";
import { jetonRelaisValide, type SortieRelais } from "@/platform/dev/relais";
import { rendreOrdre, tirerEnAttendant } from "@/platform/in-process/chantiers/relais";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * LE RELAIS CLAUDE CODE TIRE SES ORDRES (lot C2, décision 0043 § 3 bis) — `GET` (tirer, long-polling ≤ 25 s, battement
 * de cœur en paramètres) et `POST` (rendre la sortie brute d'un ordre).
 *
 * Route PUBLIQUE (le relais n'a pas de session), jamais ouverte : sans `CLAUDE_RELAIS_TOKEN` posé, 503 ; jeton faux,
 * 401 (comparaison en temps constant). L'ordre conclu inscrit un fait `DEV_SESSION` (registre canonique) qui réveille
 * la mission de l'ordre.
 */
function refus(req: Request): NextResponse | null {
  const attendu = jetonRelais();
  if (!attendu) return NextResponse.json({ ok: false }, { status: 503 });
  if (!jetonRelaisValide(req.headers.get("authorization"), attendu)) return NextResponse.json({ ok: false }, { status: 401 });
  return null;
}

export async function GET(req: Request) {
  const r = refus(req);
  if (r) return r;
  const q = new URL(req.url).searchParams;
  const code = q.get("authCode");
  const ordre = await tirerEnAttendant({ version: q.get("version") || null, authStatus: q.get("authStatus") || null, authCode: code && /^\d+$/.test(code) ? Number(code) : null }, 25_000);
  return NextResponse.json({ ordre });
}

export async function POST(req: Request) {
  const r = refus(req);
  if (r) return r;
  let c: Partial<SortieRelais>;
  try { c = (await req.json()) as Partial<SortieRelais>; } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  if (typeof c.id !== "string") return NextResponse.json({ ok: false }, { status: 400 });
  const sortie: SortieRelais = {
    id: c.id, code: typeof c.code === "number" ? c.code : null, stdout: String(c.stdout ?? "").slice(-8_000), stderr: String(c.stderr ?? "").slice(-8_000),
    delaiDepasse: c.delaiDepasse === true, avantClaude: typeof c.avantClaude === "string" ? c.avantClaude : null,
  };
  const fini = await rendreOrdre(sortie);
  if (fini) {
    await recordEvent({
      type: "DEV_SESSION", sourceDomain: "DEV", missionId: fini.missionId,
      relatedRefs: [`ORDRE:${fini.ordreId}`, ...(fini.sessionId ? [`SESSION:${fini.sessionId}`] : [])],
      payload: { ordreId: fini.ordreId, type: fini.type, statut: fini.statut, sessionId: fini.sessionId, sessionUrl: fini.sessionUrl, erreur: fini.erreur },
    });
  }
  return NextResponse.json({ ok: true, conclu: Boolean(fini) });
}
