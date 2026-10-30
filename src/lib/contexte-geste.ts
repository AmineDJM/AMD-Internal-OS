import { AsyncLocalStorage } from "node:async_hooks";
import "@/lib/async-local-storage-global";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
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

interface ContexteGeste {
  user: CurrentUser;
  origine: string;
}

const contexte = new AsyncLocalStorage<ContexteGeste>();

/** La personne au nom de qui un geste hors requête s'exécute, ou `null` (le cas ordinaire : une requête). */
export function utilisateurDuGeste(): CurrentUser | null {
  return contexte.getStore()?.user ?? null;
}

export interface IssueHorsRequete<T> {
  resultat: T;
  /** Les chemins et étiquettes que l'action a demandé d'invalider — sans objet hors rendu, gardés pour le journal. */
  invalidations: string[];
}

export async function executerHorsRequete<T>(user: CurrentUser, origine: string, geste: () => Promise<T>): Promise<IssueHorsRequete<T>> {
  const existant = workAsyncStorage.getStore();
  if (existant) return { resultat: await contexte.run({ user, origine }, geste), invalidations: [] };
  const store = {
    isStaticGeneration: false, page: `/hors-requete/${origine}`, route: `/hors-requete/${origine}`,
    // Présent pour que `revalidatePath` accepte d'enregistrer ; aucune lecture de cache ne passe par ici.
    incrementalCache: {}, pendingRevalidatedTags: [] as string[], forceDynamic: true,
  } as unknown as Parameters<typeof workAsyncStorage.run>[0];
  const resultat = await contexte.run({ user, origine }, () => workAsyncStorage.run(store, geste));
  const s = store as unknown as { pendingRevalidatedTags?: unknown[] };
  return { resultat, invalidations: (s.pendingRevalidatedTags ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t))) };
}
