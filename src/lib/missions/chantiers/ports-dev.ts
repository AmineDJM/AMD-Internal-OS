import type { PortsDev } from "@/lib/missions/chantiers/etapes";

/**
 * LE POINT DE BRANCHEMENT DES CONNECTEURS (lot C1 ↔ C2, décision 0042). Les adaptateurs réels (GitHub, Render,
 * Claude Code — lot C2) s'enregistrent ici, une fois, au chargement de leur module ; le moteur des chantiers ne les
 * importe jamais : il ne connaît que son contrat (`ports-moteur.ts`), que `adaptateur-c2.ts` remplit depuis les connecteurs. Tant que rien n'est branché, un chantier ne part
 * pas : il le DIT (« connecteurs non branchés ») au lieu de faire semblant. Les tests injectent leurs doubles
 * directement dans `conduireChantier`.
 */
let fabrique: (() => PortsDev | null) | null = null;

export function brancherPortsDev(f: (() => PortsDev | null) | null): void {
  fabrique = f;
}

export function portsDevBranches(): PortsDev | null {
  try {
    return fabrique?.() ?? null;
  } catch {
    return null;
  }
}
