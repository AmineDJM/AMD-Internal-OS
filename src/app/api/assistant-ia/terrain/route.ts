import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire, getCurrentUser } from "@/lib/session";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { capterPhoto, capterVocal, lireCaptations, peutCapterTerrain, TAILLE_MAX_CAPTATION } from "@/modules/assistant-ia/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * LE TERRAIN (lot J13, décision 0025) — la file hors ligne du téléphone envoie ici chaque vocal ou photo, avec sa CLÉ
 * d'idempotence : un renvoi rend la captation déjà faite. La réponse porte les cartes à confirmer ; rien de métier
 * n'est écrit par cette route. Les statuts disent à la file quoi faire : 4xx = refus définitif (gardé, à relire),
 * 5xx / réseau = réessayer plus tard.
 */
export async function POST(req: Request) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutCapterTerrain(user)) return NextResponse.json({ error: "Le terrain s'ouvre avec le module Rapports terrain." }, { status: 403 });
  if (await interrupteurIaCoupe()) return NextResponse.json({ error: REFUS_IA_COUPEE }, { status: 503 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Requête invalide." }, { status: 400 }); }
  const fichier = form.get("fichier");
  if (!(fichier instanceof File) || fichier.size === 0) return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  if (fichier.size > TAILLE_MAX_CAPTATION) return NextResponse.json({ error: "Fichier trop lourd (25 Mo au plus)." }, { status: 413 });
  const sorte = String(form.get("sorte") ?? "");
  const entree = {
    cle: String(form.get("cle") ?? ""),
    octets: Buffer.from(await fichier.arrayBuffer()),
    nom: fichier.name || (sorte === "photo" ? "photo.jpg" : "vocal.webm"),
    mime: (fichier.type || "application/octet-stream").split(";")[0].trim().toLowerCase(),
    dureeS: Number.isFinite(Number(form.get("dureeS"))) ? Math.round(Number(form.get("dureeS"))) : null,
    sorte: (String(form.get("sortePhoto") ?? "") || null) as never,
  };
  const r = sorte === "photo" ? await capterPhoto(user, entree) : await capterVocal(user, entree);
  if (!r.ok) return NextResponse.json({ error: r.erreur }, { status: r.definitif ? 422 : 503 });
  return NextResponse.json({ captation: r.captation, deja: r.deja });
}

/** Les captations récentes de la personne (l'écran les relit au retour du réseau). */
export async function GET(req: Request) {
  // Une lecture : elle voit comme la personne (vue exacte comprise) — `peutCapterTerrain` la ferme alors.
  const user = req.method === "GET" ? await getCurrentUser() : await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutCapterTerrain(user)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  return NextResponse.json({ captations: await lireCaptations(user) });
}
