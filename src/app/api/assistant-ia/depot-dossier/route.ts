import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, getCurrentUserPourEcrire } from "@/lib/session";
import { refusDepotDrive } from "@/lib/drive/depot";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { attendu } from "@/lib/journal";
import { etatDesLots, ouvrirLotDossier } from "@/modules/assistant-ia/api";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../personne";

export const dynamic = "force-dynamic";

/**
 * LE DÉPÔT DE DOSSIER DE L'ASSISTANT IA (lot J11, décision 0030).
 *
 * POST : ouvre (ou reprend) un lot — le corps ne porte que des CHEMINS et des TAILLES ; la racine nommée et ses
 * sous-dossiers sont créés dans le Drive personnel, la carte « chemin → dossier » revient au navigateur, qui envoie
 * chaque fichier dans SON dossier par le dépôt ordinaire du Drive (droits, quotas, chiffrement, envoi direct au-delà du
 * seuil, inscription à la Bibliothèque). Le droit est celui d'un dépôt à la racine du Drive personnel.
 * GET : l'état des derniers lots (arrivés, lus, échoués, en file) — le panneau de suivi.
 */
/** L'identité selon la méthode : une lecture voit la personne visualisée (Vue exacte), une écriture la session réelle. */
const identite = async (req: NextRequest) => (req.method === "GET" ? await getCurrentUser() : await getCurrentUserPourEcrire());

export async function POST(req: NextRequest) {
  const user = await identite(req);
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });
  const drive = await refusDepotDrive(user, {});
  if (drive) return NextResponse.json({ error: "Le dépôt dans votre Drive ne vous est pas ouvert (droit « Téléverser » du Drive)." }, { status: drive.status });

  const b = (await req.json().catch(attendu("corps illisible : le client reçoit le refus", {}))) as { fichiers?: unknown; mode?: unknown };
  const fichiers = Array.isArray(b.fichiers)
    ? b.fichiers.slice(0, 20_000).map((f) => ({ chemin: String((f as { chemin?: unknown })?.chemin ?? ""), taille: Number((f as { taille?: unknown })?.taille) }))
    : [];
  const r = await ouvrirLotDossier(user, { fichiers, mode: b.mode === "MESSAGE" ? "MESSAGE" : "DOSSIER" }, {
    creerArborescence: ({ ownerId, parentId, paths }) => creerArborescenceDrive({ ownerId, parentId, spaceId: null, paths }),
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r, SANS_CACHE);
}

export async function GET(req: NextRequest) {
  const user = await identite(req);
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (enVueExacte(user)) return NextResponse.json({ lots: [] }, SANS_CACHE);
  const lotId = req.nextUrl.searchParams.get("lot") ?? undefined;
  return NextResponse.json({ lots: await etatDesLots(user, { lotId, max: 5 }) }, SANS_CACHE);
}
