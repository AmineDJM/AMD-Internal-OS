/**
 * LE RENDU D'UNE PAGE, COMPOSÉ — la route HTTP appelle ici, pas le moteur.
 *
 * Ce fichier fait la seule chose que le domaine ne peut pas faire seul : reconstituer les OCTETS
 * courants d'une session (base Drive + opérations rejouées) puis les donner au rastériseur. Il
 * vit dans le pont parce qu'il a besoin des deux côtés, et il porte le contrôle d'accès — le
 * moteur ne rend une session que si son `userId` correspond.
 */

import type { CurrentUser } from "@/lib/session";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";
import { compilerCommandes } from "@/lib/artifact/commands/compile";
import { rendrePagePdf } from "@/lib/artifact/render/raster";
import { octetsImageDeSession } from "@/lib/artifact/runtime/engine";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { magasinSessions } from "@/platform/ia/artifact/store";

export type ResultatRendu =
  | { ok: true; png: Buffer }
  | { ok: false; statut: number; motif: string };

/**
 * REND la page `page` (1-indexée) du document ouvert dans cette session, DANS SON ÉTAT COURANT.
 *
 * Le rejeu se refait ici plutôt que de partager le cache du moteur : la route est un chemin de
 * lecture, elle peut tourner dans un autre processus, et la reconstruction coûte quelques
 * millisecondes sur un adaptateur déterministe. Partager un cache mutable entre une route et un
 * moteur serait la porte ouverte à une image qui ne correspond pas à ce que la personne voit.
 */
export async function rendrePageArtefact(
  user: CurrentUser, sessionId: string, page: number, opts: { echelle?: number } = {},
): Promise<ResultatRendu> {
  const session = await magasinSessions.lire(sessionId, user.id);
  if (!session) return { ok: false, statut: 404, motif: "session introuvable" };
  if (session.format !== "PDF") return { ok: false, statut: 400, motif: "ce document n'est pas un PDF" };

  const base = await portsArtefact.documents.lire(user.id, session.nodeId, session.baseVersion);
  if (!base) return { ok: false, statut: 403, motif: "contenu inaccessible" };

  const doc = await adaptateurPour("PDF").ouvrir(base);
  for (const op of await magasinSessions.operations(session.id)) {
    if (op.undone) continue;
    // On repasse par le COMPILATEUR : un journal ne doit pas pouvoir faire exécuter, par une
    // route de lecture, une commande que le compilateur refuserait aujourd'hui.
    const { commandes } = compilerCommandes([op.command], "PDF");
    for (const c of commandes) doc.appliquer(c);
  }

  const rendu = await rendrePagePdf(await doc.serialiser(), page, opts);
  if (!rendu) return { ok: false, statut: 404, motif: "cette page n'existe plus" };
  return { ok: true, png: rendu.png };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OCTETS D'UNE IMAGE DU DOCUMENT — pour que le workspace la MONTRE.
 *
 * Un cadre gris annonçant « Image — 4,0 × 2,0 cm » n'est pas un rendu : la personne ne peut pas
 * distinguer le logo de 2019 de celui de 2027, donc elle ne peut pas VÉRIFIER ce qu'Adam vient
 * de faire, et « c'est fait » redevient une parole qu'il faut croire.
 *
 * ── POURQUOI CETTE FONCTION NE REJOUE RIEN ELLE-MÊME ────────────────────────────────────
 *
 * La route des pages de PDF reconstruit l'état à la main, parce qu'un PDF n'a besoin d'aucune
 * ressource extérieure. Une image, si : le rejeu doit RELIRE les octets de la source à travers
 * le port. `etatCourant` le fait déjà, avec les droits courants de la personne. En réécrire une
 * seconde version ici donnerait deux chemins de rejeu qui divergeraient — et le jour où ils
 * divergent, le workspace affiche une image que le document ne contient pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ResultatImage {
  ok: boolean;
  statut: number;
  motif?: string;
  octets?: Buffer;
  mime?: string;
}

export async function octetsImageArtefact(
  user: CurrentUser, sessionId: string, imageId: string,
): Promise<ResultatImage> {
  const { contexte } = await import("@/platform/ia/artifact/office");
  const r = await octetsImageDeSession(contexte(user), sessionId, imageId);
  if (!r.ok) return { ok: false, statut: 404, motif: r.motif === "session" ? "session introuvable" : r.motif };
  return { ok: true, statut: 200, octets: r.octets, mime: r.mime };
}
