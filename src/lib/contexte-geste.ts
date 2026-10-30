import "@/lib/async-local-storage-global";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN GESTE MÉTIER HORS REQUÊTE (J8, constat remonté par J12) — l'action de l'ÉCRAN, appelée par le worker.
 *
 * ── LE DÉFAUT ────────────────────────────────────────────────────────────────────────────
 *
 * Un geste approuvé d'un travail (relance, rendez-vous, message…) appelle la server action de l'écran — c'est la
 * règle : jamais une seconde écriture. Mais cette action a été écrite pour une REQUÊTE :
 *   • `requireUser()` lit le cookie de session — sur le worker, il n'y en a pas : redirection vers /login (une
 *     exception), le geste échoue sans rien faire ;
 *   • `revalidatePath()` exige le « work store » de Next — hors requête il lève « static generation store
 *     missing », APRÈS l'écriture : le geste a eu lieu, l'étape le dit en échec (et un reçu ECHEC se rejoue).
 * Les tests remplaçaient ces deux fonctions (`vi.mock`) : le chemin réel n'était pas couvert.
 *
 * ── LA CORRECTION, À LA RACINE ───────────────────────────────────────────────────────────
 *
 * `executerHorsRequete(personne, origine, geste)` exécute le geste dans un CONTEXTE :
 *   • la PERSONNE du geste (relue en base par l'appelant juste avant, droits compris) est rendue par `requireUser`,
 *     `getCurrentUser`… (`session.ts` consulte ce contexte AVANT le cookie) — l'action revérifie tout comme au clic ;
 *   • un « work store » minimal : `revalidatePath` / `revalidateTag` y déposent leurs invalidations, qui n'ont pas
 *     d'objet hors rendu (le worker ne sert aucune page ; le web relit en base à la prochaine requête). Elles sont
 *     gardées dans le contexte, et rendues à l'appelant qui veut les journaliser.
 *
 * Le contexte ne se pose QUE par ce code serveur — aucune requête ne peut le fournir. Dans une requête (le battement
 * du web déclenché par une page), le store de Next existant est gardé ; seule l'identité du geste s'y ajoute, pour la
 * durée du geste et de sa chaîne asynchrone seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA PERSONNE, RECONSTRUITE DEPUIS SON COMPTE — sans session (worker, balayage) : compte actif, droits relus en base
 * (`getAccess`), jamais supposés. C'est elle qu'un travail passe à `executerHorsRequete` (`platform/ia/proprietaire`).
 */
export async function personneDuGeste(userId: string): Promise<CurrentUser | null> {
  const u = await prisma.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true, name: true, email: true, role: true } });
  if (!u) return null;
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false };
}

/**
 * ── J7 (décision 0029) : LA PORTE DU CONTEXTE DE GESTE ──────────────────────────────────
 *
 * Le mode (réel ou simulation), la simulation transactionnelle, le journal des effets et l'annulation honnête vivent
 * sous `lib/effets/` ; cette façade les nomme pour le reste de l'ERP et pour le socle IA (`platform/ia/hors-requete`).
 */
export {
  avecStoreHorsRequete, contexteDuGeste, etatPour, executerHorsRequete, utilisateurDuGeste,
  type ContexteDuGeste, type IssueHorsRequete,
} from "@/lib/effets/geste";
export { simulerEnDiff, simulerGeste, type IssueSimulation } from "@/lib/effets/simulation";
export { journaliserGeste, purgerJournalDesEffets, type MetaGesteAgent } from "@/lib/effets/journal";
export { annulerGeste, gestesDeLAssistant, planDAnnulation, type CompteRenduAnnulation, type GesteListe } from "@/lib/effets/annulation";
export type { DiffSimulation, LigneDiff, EffetDiff } from "@/lib/effets/diff";
