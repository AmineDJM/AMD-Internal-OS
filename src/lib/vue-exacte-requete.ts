import "@/lib/async-local-storage-global";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI AGIT VRAIMENT DANS CETTE REQUÊTE ? — « Agir comme cet utilisateur » (Direction, 16/11/2026).
 *
 * « Un bouton à côté de “Voir comme cet utilisateur” : le Super Admin a le plein accès de la personne, il voit exactement ce
 * qu'elle voit et fait exactement les mêmes actions — pour les simulations — et tout ce qu'il fait doit pouvoir s'annuler. »
 *
 * La session (`session.ts`) rend la personne ; elle POSE ici, pour la requête en cours, le Super Admin réel et la personne.
 * Deux lecteurs : l'audit (`parVueExacteId`, montré au Super Admin seul) et le journal des effets (chaque requête qui écrit
 * s'y inscrit et s'annule, `effets/vue-exacte.ts`).
 *
 * La case est celle de la requête de Next (le « work store » : page, action, route d'API) — jamais partagée entre deux
 * requêtes, oubliée avec elle. Hors requête (worker, banc), rien n'est posé : personne n'agit dans la peau de personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VueExacteDeRequete {
  superAdminId: string;
  superAdminNom: string;
  cibleId: string;
  cibleNom: string;
}

const g = globalThis as { __amdVueExacteParRequete?: WeakMap<object, VueExacteDeRequete> };
// UNE table par processus, même si Next charge deux copies du module.
const parRequete = (g.__amdVueExacteParRequete ??= new WeakMap<object, VueExacteDeRequete>());

/** La clé de la requête en cours (le « work store » de Next), ou `null` hors requête. */
export function cleDeRequete(): object | null {
  try {
    return (workAsyncStorage.getStore() as object | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Posé par la session quand elle rend la personne en « Agir comme » : cette requête est un geste du Super Admin. */
export function poserVueExacteDeRequete(v: VueExacteDeRequete): void {
  const k = cleDeRequete();
  if (k) parRequete.set(k, v);
}

/** Le Super Admin et la personne de l'« Agir comme » en cours, ou `null` (le cas ordinaire). */
export function vueExacteDeRequete(): VueExacteDeRequete | null {
  const k = cleDeRequete();
  return k ? parRequete.get(k) ?? null : null;
}
