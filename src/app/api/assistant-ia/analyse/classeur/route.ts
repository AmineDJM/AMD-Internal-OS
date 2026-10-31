import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { contentDisposition } from "@/lib/http/content-disposition";
import { classeurDAnalyse } from "@/modules/assistant-ia/api";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../../personne";

export const dynamic = "force-dynamic";

/** Le corps borné : 200 lignes × 12 colonnes tiennent largement ; au-delà, c'est un abus. */
const CORPS_MAX = 2_000_000;

/**
 * LE CLASSEUR EXCEL D'UNE ANALYSE (K1, décision 0031) — l'écran envoie le tableau qu'il montre (filtré) ; la réponse
 * est un .xlsx vérifié (formules recalculées, feuille « Méthode »), ou, avec `depot: true`, le lien du classeur
 * déposé dans le Drive de la personne. Rien n'est lu de la base : la route met en forme ce que la personne voit déjà.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? refusAssistantIA(null)!;
  const texte = await req.text();
  if (texte.length > CORPS_MAX) return NextResponse.json({ error: "Tableau trop volumineux pour un export d'un clic." }, { status: 413 });
  let corps: unknown;
  try { corps = JSON.parse(texte); } catch { return NextResponse.json({ error: "Corps illisible." }, { status: 400 }); }
  const r = await classeurDAnalyse(user, corps, enVueExacte(user));
  if (!r.ok) return NextResponse.json({ error: r.erreur }, { status: r.statut });
  if ("depose" in r) return NextResponse.json(r.depose, SANS_CACHE);
  return new NextResponse(new Uint8Array(r.octets), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(r.nom, "attachment"),
      "Cache-Control": "no-store",
    },
  });
}
