import type { ProductChannel } from "@prisma/client";

/** Priorité de détail : P1 se travaille en premier, P3 se mentionne. */
export function positionLabel(position: number): string {
  return position >= 1 && position <= 3 ? `P${position}` : `P${Math.max(1, Math.min(3, position))}`;
}

export interface PortfolioProduct {
  productId: string;
  name: string;
  code: string | null;
  channel: ProductChannel;
  /** Rang de détail : 1 = prioritaire. */
  position: number;
  plannedVisits: number;
  /** Vrai si le produit vient de l'équipe et non d'une affectation personnelle. */
  viaTeam: boolean;
}

/**
 * Fusionne le portefeuille PERSONNEL et celui de l'ÉQUIPE (pour un superviseur).
 *
 * Un superviseur porte souvent quelques produits en direct tout en pilotant les autres. Quand
 * un produit apparaît des deux côtés, **l'affectation personnelle gagne** : elle est plus
 * précise, et sa priorité est celle qui l'engage personnellement. À priorité égale on garde la
 * plus forte (le plus petit rang) — on ne rétrograde jamais un produit en le fusionnant.
 *
 * Fonction PURE — testée.
 */
export function mergePortfolio(own: PortfolioProduct[], team: PortfolioProduct[]): PortfolioProduct[] {
  const byId = new Map<string, PortfolioProduct>();

  for (const p of own) byId.set(p.productId, { ...p, viaTeam: false });

  for (const p of team) {
    const existing = byId.get(p.productId);
    if (!existing) {
      byId.set(p.productId, { ...p, viaTeam: true });
      continue;
    }
    // Le produit est déjà porté en propre : on ne le dégrade pas, on garde la meilleure priorité.
    if (p.position < existing.position) byId.set(p.productId, { ...existing, position: p.position });
  }

  return [...byId.values()].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name, "fr"),
  );
}

/**
 * Les gammes réellement couvertes.
 *
 * Un produit `BOTH` couvre les deux : quelqu'un qui ne porte que des produits mixtes fait bien
 * de la ville ET de l'hôpital. Ne pas le déplier reviendrait à dire qu'il ne fait ni l'un ni
 * l'autre. Fonction PURE — testée.
 */
export function portfolioGammes(products: { channel: ProductChannel }[]): ("RETAIL" | "HOSPITAL")[] {
  const out = new Set<"RETAIL" | "HOSPITAL">();
  for (const p of products) {
    if (p.channel === "RETAIL" || p.channel === "BOTH") out.add("RETAIL");
    if (p.channel === "HOSPITAL" || p.channel === "BOTH") out.add("HOSPITAL");
  }
  // Ordre stable : la ville d'abord, c'est la gamme la plus large.
  return (["RETAIL", "HOSPITAL"] as const).filter((g) => out.has(g));
}

/** Libellé lisible des gammes couvertes — « Ville », « Hôpital », ou « Ville et hôpital ». */
export function gammesLabel(products: { channel: ProductChannel }[]): string {
  const g = portfolioGammes(products);
  if (g.length === 0) return "Aucune gamme";
  if (g.length === 2) return "Ville et hôpital";
  return g[0] === "RETAIL" ? "Ville" : "Hôpital";
}

export interface Portfolio {
  products: PortfolioProduct[];
  /** Cycle réellement lu (« 2026-08 »), ou null si aucune affectation n'existe nulle part. */
  cycleLabel: string | null;
  /**
   * Vrai quand le cycle EN COURS n'a pas encore été saisi et qu'on montre le dernier connu.
   * L'écran doit le dire : un délégué ne doit pas croire que son portefeuille a été reconduit
   * alors que la Direction ne l'a pas encore arrêté.
   */
  fromPreviousCycle: boolean;
  /** Vrai si la personne pilote une équipe (des produits viennent de ses KAM). */
  hasTeam: boolean;
}

/** Répartition par priorité — ce qu'on affiche en tête de la carte « Ma gamme ». */
export function byPosition(products: PortfolioProduct[]): { position: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const p of products) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([position, count]) => ({ position, count }));
}
