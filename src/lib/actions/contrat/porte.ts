/**
 * LA PORTE LUE DANS LE CORPS D'UNE ACTION — module et verbe RBAC, entité, gardes nommées, module
 * en français de l'audit. Décrit, n'autorise rien : l'action revérifie à l'exécution.
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import type { PorteLue } from "./types";

export function lirePorte(corps: string, constantes: Readonly<Record<string, string>>): PorteLue {
  let module: string | null = null, verbe: string | null = null, entite: string | null = null;
  const audit = /recordAudit\s*\(\s*\{[^}]*?\bmodule\s*:\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/s.exec(corps);
  const moduleFr = audit ? (audit[1] ?? constantes[audit[2]!] ?? null) : null;
  const gardes = new Set<string>();

  const rc = /userCan\s*\(\s*[A-Za-z0-9_.]+\s*,\s*(?:"([A-Z_]+)"|([A-Z_0-9]+))\s*,\s*"([A-Z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = rc.exec(corps)) !== null) {
    module ??= m[1] ?? constantes[m[2]!] ?? m[2]!;
    verbe ??= m[3]!;
    gardes.add("userCan");
  }
  const re = /canAccessEntity\s*\(\s*[A-Za-z0-9_.]+\s*,\s*(?:"([A-Z_]+)"|([A-Z_0-9]+))\s*,/g;
  while ((m = re.exec(corps)) !== null) {
    entite ??= m[1] ?? constantes[m[2]!] ?? m[2]!;
    gardes.add("canAccessEntity");
  }
  // Les autres gardes de l'ERP, telles qu'écrites. La liste est OUVERTE par construction :
  // on relève ce qui ressemble à une garde, et ne pas en reconnaître une ne rend rien faux —
  // l'exécution revérifie de toute façon.
  // `peut…` : les prédicats de droit écrits en français au socle (`peutPiloterMissionsAdam`,
  // `peutEmettrePieces`) — sans eux, une action gardée par une RÈGLE et non par un module
  // sortait avec `gardes: []`, c'est-à-dire l'air de n'être gardée par rien (§118.136).
  //
  // `sits…`, `siege…`, `holds…` : les prédicats de SIÈGE et de VERROU. Mesuré sur les fichiers
  // `"use server"` du parc — trois gardes réelles qu'aucun préfixe ne voyait : le siège du centre
  // de PAIEMENT (`sitsOnPaymentCentre`, en production depuis toujours), celui du centre Ad & Pro
  // (`siegeAuCentreAdPro`) et le cadenas d'un dossier confidentiel (`holdsRegulatoryLock`) — cette
  // dernière NOMMÉE par §118.80, constatée et laissée. Ce n'est pas un fait de sécurité qui change
  // (l'action garde exactement les mêmes gardes) : c'est ce que la CARTE de confirmation sait dire
  // à la personne avant qu'elle clique (§118.80, §118.120).
  //
  // `allowed…` et `autorise…` sont DÉLIBÉRÉMENT dehors : la même mesure a trouvé
  // `allowedGeneralMeansCategoryIds`, qui rend une LISTE D'IDENTIFIANTS et non un droit. On relève
  // une garde sur un fait, jamais sur un nom plausible (§118.79a) — l'inscrire ferait annoncer une
  // garde là où il n'y a qu'une lecture de catégories.
  //
  // Un APPEL DE MÉTHODE n'est pas une garde (§118.172) : `Array.isArray(`, `Number.isFinite(`,
  // `Number.isNaN(` s'écrivent comme un prédicat de droit, et 37 fiches du parc annonçaient
  // « isFinite » ou « isArray » parmi leurs gardes. Mesuré sur toutes les sources d'actions : aucun
  // prédicat de droit ne s'appelle comme méthode — le point qui précède suffit à les écarter.
  for (const g of corps.matchAll(/(?<![.\w$])(require[A-Z][A-Za-z]*|assert[A-Z][A-Za-z]*|can[A-Z][A-Za-z]*|has[A-Z][A-Za-z]*|is[A-Z][A-Za-z]*|peut[A-Z][A-Za-z]*|sits[A-Z][A-Za-z]*|siege[A-Z][A-Za-z]*|holds[A-Z][A-Za-z]*)\s*\(/g)) {
    if (g[1] !== "requireUser") gardes.add(g[1]!);
  }
  return { module, verbe, entite, moduleFr, gardes: [...gardes].sort() };
}
