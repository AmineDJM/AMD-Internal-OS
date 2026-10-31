import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { etatVisuel } from "@/modules/assistant-ia/api";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../../personne";

export const dynamic = "force-dynamic";

/**
 * L'ÉTAT D'UN VISUEL (lot K2, décision 0032) — relu par la carte « Vidéo en cours » toutes les quelques secondes,
 * jusqu'à ce que le fichier soit prêt (ou l'échec dit). Seule la personne qui l'a demandé le lit ; en « Vue exacte »,
 * rien n'est lu.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus!;
  if (enVueExacte(user)) return NextResponse.json({ error: "Vue exacte : non lu." }, { status: 403 });
  const vue = await etatVisuel(user.id, id);
  return vue ? NextResponse.json(vue, SANS_CACHE) : NextResponse.json({ error: "Introuvable." }, { status: 404 });
}
