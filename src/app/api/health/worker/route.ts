import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { lireSanteTachesDeFond } from "@/lib/taches-de-fond/sante";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * SANTÉ DES TÂCHES DE FOND (refonte V2-F) — le dernier battement de chaque tâche, qui l'a fait,
 * en combien de temps, avec quelle issue.
 *
 * Lisible sans session, pour qu'une sonde externe (moniteur de disponibilité, `curl` pendant la
 * bascule) puisse s'y brancher : la réponse publique ne contient que des clés de tâches, des
 * instants, des durées et des statuts. L'identité des processus et les messages d'erreur ne sont
 * rendus qu'au Super Admin connecté.
 *
 * 200 quand une tâche est partie depuis moins de cinq minutes, 503 sinon — un moniteur n'a pas à
 * lire le corps pour savoir que plus personne ne bat. Ne lit que la table des baux : appeler cette
 * route n'arme aucun battement et ne charge pas la chaîne des tâches.
 */
export async function GET() {
  const user = await getCurrentUser().catch(sansBloquer("worker-route.GET.getCurrentUser", null));
  try {
    const sante = await lireSanteTachesDeFond({ detail: user?.role === "SUPER_ADMIN" });
    return NextResponse.json(sante, {
      status: sante.vivant ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ vivant: false, erreur: "Base injoignable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
