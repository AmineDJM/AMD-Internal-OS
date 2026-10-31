import { cookies } from "next/headers";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { COOKIE_GESTE_ANNULABLE, DUREE_BANDEAU_SECONDES, valeurGesteAnnulable } from "./ecran-ui";
import { journaliserGeste } from "./journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ACTION DE L'ÉCRAN, RÉVERSIBLE (lot K10a, décision 0035) — le journal des effets J7, ouvert aux gestes de l'ERP.
 *
 * « Toute action qui a été faite peut être réversible » (Direction, 31/10/2026). J7 savait défaire un geste de
 * l'ASSISTANT ; l'action faite au bouton, elle, ne laissait que son audit. `annulable` l'enrobe : elle s'exécute sous
 * le journal des effets (chaque écriture garde sa ligne avant et après), et le geste se défait par la MÊME annulation
 * honnête (`annulation.ts`, avec la politique d'argent de `argent.ts`) — pas un second mécanisme.
 *
 *   • appelée par l'assistant (carte, travail, mandat) : déjà sous un geste journalisé, elle s'y fond ;
 *   • appelée par l'écran : un geste d'origine `ecran`, au nom de la personne, et un témoin court pour le bandeau
 *     « Annuler » (`ecran-ui.ts`) ; l'historique « Ce que j'ai fait » le garde (`/assistant/gestes`).
 *
 * Le MODE est une déclaration lue par le contrat (`actions:contrat`, champ `annulable`) : le registre ne classe plus
 * l'action « aucune ». `retour` : ce qu'elle écrit se remet ; `compensation` : une part se compense (écriture inverse,
 * « à récupérer », statut annulé) parce que l'effacer serait faux.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function annulable<T>(mode: "retour" | "compensation", libelle: string, corps: () => Promise<T>): Promise<T> {
  // Sans personne (tâche planifiée, banc qui ne fournit pas de session) : l'action s'exécute telle quelle, sans journal.
  let user: Awaited<ReturnType<typeof getCurrentUserPourEcrire>> = null;
  try {
    user = await getCurrentUserPourEcrire();
  } catch {
    user = null; // hors requête : aucune session à lire — c'est attendu, pas une panne
  }
  if (!user) return corps();
  const { resultat, gesteId } = await journaliserGeste(user, { origine: "ecran", libelle }, corps, { seulementSiEcrit: true });
  if (gesteId) {
    try {
      (await cookies()).set(COOKIE_GESTE_ANNULABLE, valeurGesteAnnulable({ id: gesteId, libelle, mode }), { path: "/", maxAge: DUREE_BANDEAU_SECONDES, sameSite: "lax" });
    } catch {
      // Hors requête (tâche planifiée, worker) : pas de bandeau, le geste reste à l'historique.
    }
  }
  return resultat;
}
