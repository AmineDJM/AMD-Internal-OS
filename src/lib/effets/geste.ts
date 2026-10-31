import "@/lib/async-local-storage-global";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import type { CurrentUser } from "@/lib/session";
import { etatDuGeste, sousGeste, type EtatGeste, type ModeGeste, type OrigineGeste } from "./magasin";

/**
 * LE GESTE HORS REQUÊTE ET SON CONTEXTE (J8, étendu par J7 — décision 0029) — le mécanisme, sans lecture de la base.
 * La façade est `lib/contexte-geste.ts` (et, pour les assistants, `platform/ia/hors-requete.ts`) ; `session.ts` lit
 * `utilisateurDuGeste` ici, sans tirer la simulation ni le journal.
 */

/**
 * LE CONTEXTE ÉTENDU (J7, décision 0029) — en plus de la personne et de l'origine : le MODE (réel ou simulation), le
 * travail et l'étape, la clé d'idempotence. Il vit dans le magasin sans dépendance (`effets/magasin.ts`), que le
 * client Prisma, la garde de sortie et le stockage lisent aussi.
 */
export interface ContexteDuGeste {
  origine: OrigineGeste;
  mode?: ModeGeste;
  travailId?: string | null;
  etape?: string | null;
  cleIdempotence?: string | null;
}

/** La personne au nom de qui un geste hors requête s'exécute, ou `null` (le cas ordinaire : une requête). */
export function utilisateurDuGeste(): CurrentUser | null {
  return etatDuGeste()?.user ?? null;
}

/** Le contexte du geste en cours (mode, principal, travail, étape, clé), ou `null` hors geste. */
export function contexteDuGeste(): (ContexteDuGeste & { principalId: string | null; mode: ModeGeste }) | null {
  const e = etatDuGeste();
  return e ? { origine: e.origine, mode: e.mode, principalId: e.principalId, travailId: e.travailId ?? null, etape: e.etape ?? null, cleIdempotence: e.cleIdempotence ?? null } : null;
}

export interface IssueHorsRequete<T> {
  resultat: T;
  /** Les chemins et étiquettes que l'action a demandé d'invalider — sans objet hors rendu, gardés pour le journal. */
  invalidations: string[];
}

/**
 * Un « work store » minimal pour `revalidatePath` / `revalidateTag`. `forcer` : même DANS une requête (une simulation
 * n'invalide rien de réel — ses invalidations sont gardées, pas appliquées).
 */
export async function avecStoreHorsRequete<T>(origine: string, geste: () => Promise<T>, forcer = false): Promise<IssueHorsRequete<T>> {
  if (!forcer && workAsyncStorage.getStore()) return { resultat: await geste(), invalidations: [] };
  const store = {
    isStaticGeneration: false, page: `/hors-requete/${origine}`, route: `/hors-requete/${origine}`,
    // Présent pour que `revalidatePath` accepte d'enregistrer ; aucune lecture de cache ne passe par ici.
    incrementalCache: {}, pendingRevalidatedTags: [] as string[], forceDynamic: true,
  } as unknown as Parameters<typeof workAsyncStorage.run>[0];
  const resultat = await workAsyncStorage.run(store, geste);
  const s = store as unknown as { pendingRevalidatedTags?: unknown[] };
  return { resultat, invalidations: (s.pendingRevalidatedTags ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t))) };
}

/** L'état du geste, posé SOUS un geste parent éventuel : la capture et le client du parent sont gardés, et une
 *  simulation ne devient jamais réelle par un geste imbriqué. */
export function etatPour(user: CurrentUser | null, ctx: ContexteDuGeste): EtatGeste {
  const parent = etatDuGeste();
  return {
    mode: parent?.mode === "SIMULATION" ? "SIMULATION" : (ctx.mode ?? "REEL"),
    user: user ?? parent?.user ?? null,
    principalId: user?.id ?? parent?.principalId ?? null,
    origine: ctx.origine,
    travailId: ctx.travailId ?? parent?.travailId ?? null,
    etape: ctx.etape ?? parent?.etape ?? null,
    cleIdempotence: ctx.cleIdempotence ?? parent?.cleIdempotence ?? null,
    debut: parent?.debut ?? Date.now(),
    capture: parent?.capture ?? null,
    client: parent?.client ?? null,
  };
}

export async function executerHorsRequete<T>(user: CurrentUser, origine: string | ContexteDuGeste, geste: () => Promise<T>): Promise<IssueHorsRequete<T>> {
  const ctx = typeof origine === "string" ? { origine } : origine;
  const etat = etatPour(user, ctx);
  return sousGeste(etat, () => avecStoreHorsRequete(ctx.origine, geste, etat.mode === "SIMULATION"));
}
