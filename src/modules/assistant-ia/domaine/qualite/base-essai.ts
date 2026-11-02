/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BASE D'ESSAI DU BANC PROGRAMMÉ (J5, décision 0022) — règle PURE : le banc a-t-il le droit de partir ?
 *
 * Le banc SÈME, écrit et efface : il ne tourne JAMAIS contre la base de production. Trois verrous :
 *   1. une base d'essai DÉCLARÉE (`BANC_ESSAI_DATABASE_URL` sur le worker) — en production, sans elle, il le dit
 *      et ne tourne pas ; hors production, la base de banc locale (`amd_bench`) en tient lieu ;
 *   2. elle n'est pas la base de production : hôte, port et nom comparés (l'EMPREINTE), mot de passe ignoré ;
 *   3. elle porte le MARQUEUR d'une base d'essai (table `BancBaseEssai`, posé par le semis), et la production NE
 *      le porte PAS (vérifié en base par le worker — ce module ne lit rien).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type VerdictBaseEssai = { ok: true; url: string } | { ok: false; raison: string };

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "::1"]);

/** L'empreinte d'une base : hôte, port et nom — ce qui la désigne, sans ses secrets. */
export function empreinteBase(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    const hote = u.hostname.toLowerCase();
    return `${HOTES_LOCAUX.has(hote) ? "local" : hote}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase()}`;
  } catch {
    return null;
  }
}

export const REFUS_SANS_BASE_ESSAI =
  "Aucune base d'essai n'est configurée : le banc ne tourne pas contre la base de production. "
  + "Remède : créer une base Postgres séparée, la semer (`npm run banc:essai:semer`) et poser BANC_ESSAI_DATABASE_URL sur le worker.";

/** La base d'essai à utiliser, ou le refus dit en clair. */
export function choisirBaseEssai(env: { production: boolean; baseProduction: string; baseEssai?: string | null; baseBancLocale?: string | null }): VerdictBaseEssai {
  const essai = env.baseEssai?.trim() || (env.production ? "" : env.baseBancLocale?.trim() || "");
  if (!essai) return { ok: false, raison: REFUS_SANS_BASE_ESSAI };
  const e = empreinteBase(essai);
  if (!e) return { ok: false, raison: "L'adresse de la base d'essai est illisible : le banc ne part pas." };
  const p = empreinteBase(env.baseProduction);
  if (p && e === p) return { ok: false, raison: "La base d'essai déclarée EST la base de production (même hôte, même port, même nom) : refus." };
  return { ok: true, url: essai };
}
