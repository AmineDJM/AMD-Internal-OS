import { NextResponse } from "next/server";
import { signatureTableau, tableauDesMissions } from "@/modules/assistant-ia/api";
import { getCurrentUser } from "@/lib/session";
import { sansBloquer } from "@/lib/journal";
import { enVueExacte, refusAssistantIA } from "../../personne";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FLUX DU TABLEAU DE BORD DES MISSIONS (K3, décision 0033) — Server-Sent Events.
 *
 *   • à l'ouverture : le tableau complet (`event: tableau`) ;
 *   • chaque seconde : la SIGNATURE (une agrégation, aucune ligne rapatriée) ; elle change → le tableau est relu et
 *     poussé. Un changement d'étape s'affiche donc en ~1 s, sans sondage côté écran ;
 *   • toutes les 15 s : un commentaire (« : vivant ») — les mandataires (Render, Cloudflare) ne coupent pas un flux muet ;
 *   • après 4 min 30 : le flux se ferme proprement (`event: fin`) et le navigateur se reconnecte (`retry: 1500`) — une
 *     connexion n'est jamais tenue au-delà de ce qu'un mandataire tolère ; l'écran retombe en sondage court s'il coupe.
 * Cloisonné : la personne de la session, jamais un paramètre. En « Vue exacte », rien n'est lu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const BATTEMENT_MS = 1_000;
const VIVANT_MS = 15_000;
const DUREE_MAX_MS = 270_000;

export async function GET(req: Request): Promise<Response> {
  const session = await getCurrentUser();
  if (!session) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  const interdit = refusAssistantIA(session) ?? (enVueExacte(session) ? NextResponse.json({ error: "Vue exacte : le tableau de bord de la personne n'est pas lu." }, { status: 403 }) : null);
  if (interdit) return interdit;
  const userId = session.id;
  const encodeur = new TextEncoder();
  let arret = false;

  const flux = new ReadableStream<Uint8Array>({
    async start(controle) {
      const ecrire = (texte: string) => { if (!arret) controle.enqueue(encodeur.encode(texte)); };
      const pousser = (evenement: string, donnees: unknown) => ecrire(`event: ${evenement}\ndata: ${JSON.stringify(donnees)}\n\n`);
      const fermer = () => { if (arret) return; arret = true; try { controle.close(); } catch { /* déjà fermé par le client */ } };
      req.signal.addEventListener("abort", fermer);

      ecrire("retry: 1500\n\n");
      let signature = "";
      const debut = Date.now();
      let dernierVivant = Date.now();
      try {
        const t = await tableauDesMissions(userId);
        signature = t.signature;
        pousser("tableau", t);
        while (!arret && Date.now() - debut < DUREE_MAX_MS) {
          await new Promise((r) => setTimeout(r, BATTEMENT_MS));
          if (arret) break;
          const s = await signatureTableau(userId).catch(sansBloquer("missions.flux.signature", signature));
          if (s !== signature) {
            const t2 = await tableauDesMissions(userId);
            signature = t2.signature;
            pousser("tableau", t2);
          } else if (Date.now() - dernierVivant > VIVANT_MS) {
            ecrire(": vivant\n\n");
            dernierVivant = Date.now();
          }
        }
        pousser("fin", { raison: "reconnexion" });
      } catch (e) {
        sansBloquer("missions.flux")(e);
        pousser("erreur", { message: "Le flux s'est interrompu : reconnexion." });
      }
      fermer();
    },
    cancel() { arret = true; },
  });

  return new Response(flux, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
