import { prisma } from "@/lib/prisma";
import { calculerAffinites, type ConfigAffinite, type TypePeriode, type LigneAffinite } from "./affinite";

/**
 * L'AFFINITÉ PAR ÉTABLISSEMENT, lue en base : les lignes OK des imports VALIDÉS, la configuration du produit.
 * Sans configuration, pas d'affinité — aucun panier ni aucune période n'est supposé.
 */

export function lireConfig(row: { productId: string; panier: unknown; periode: string; debut: Date | null; fin: Date | null }): ConfigAffinite {
  const p = (row.panier ?? {}) as { productIds?: unknown; molecules?: unknown };
  return {
    productId: row.productId,
    panier: {
      productIds: Array.isArray(p.productIds) ? p.productIds.filter((x): x is string => typeof x === "string") : [],
      molecules: Array.isArray(p.molecules) ? p.molecules.filter((x): x is string => typeof x === "string") : [],
    },
    periode: (["MOIS", "ROLLING_3M", "ROLLING_6M", "ROLLING_12M", "PERSONNALISEE"].includes(row.periode) ? row.periode : "ROLLING_12M") as TypePeriode,
    debut: row.debut?.toISOString().slice(0, 10) ?? null,
    fin: row.fin?.toISOString().slice(0, 10) ?? null,
  };
}

/** Les lignes du marché : celles des imports VALIDÉS — plus, pour un APERÇU, celles d'un import encore en revue. */
export async function lignesDuMarche(cfg: ConfigAffinite, inclureImportId?: string): Promise<LigneAffinite[]> {
  const rows = await prisma.consommationLigne.findMany({
    where: {
      statut: "OK", import: inclureImportId ? { OR: [{ statut: "VALIDE" }, { id: inclureImportId }] } : { statut: "VALIDE" }, institutionId: { not: null }, quantite: { not: null }, periodeDebut: { not: null }, periodeFin: { not: null },
      OR: [
        { productId: { in: [cfg.productId, ...cfg.panier.productIds] } },
        // Les molécules se comparent sans accents ni casse dans le calcul pur : on lit ici toute ligne qui en porte une.
        ...(cfg.panier.molecules.length ? [{ molecule: { not: null } }] : []),
      ],
    },
    select: { institutionId: true, productId: true, molecule: true, periodeDebut: true, periodeFin: true, quantite: true, unite: true },
  });
  return rows.map((r) => ({
    institutionId: r.institutionId!, productId: r.productId, molecule: r.molecule,
    periodeDebut: r.periodeDebut!.toISOString().slice(0, 10), periodeFin: r.periodeFin!.toISOString().slice(0, 10),
    quantite: Number(r.quantite), unite: r.unite,
  }));
}

/** Pour le moteur de segmentation : institution → produit → affinité, et les noms des établissements. */
export async function affinitesEtablissements(productIds: string[], inclureImportId?: string): Promise<{ affiniteEtablissement: Record<string, Record<string, { valeur: number; periode: string }>>; nomsEtablissements: Record<string, string> }> {
  const affiniteEtablissement: Record<string, Record<string, { valeur: number; periode: string }>> = {};
  if (productIds.length === 0) return { affiniteEtablissement, nomsEtablissements: {} };
  const configs = await prisma.affiniteConfig.findMany({ where: { productId: { in: productIds } } });
  const ids = new Set<string>();
  for (const row of configs) {
    const cfg = lireConfig(row);
    const { parEtablissement } = calculerAffinites(await lignesDuMarche(cfg, inclureImportId), cfg);
    for (const a of parEtablissement) {
      (affiniteEtablissement[a.institutionId] ??= {})[cfg.productId] = { valeur: a.valeur, periode: a.periode };
      ids.add(a.institutionId);
    }
  }
  const noms = ids.size ? await prisma.medicalInstitution.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }) : [];
  return { affiniteEtablissement, nomsEtablissements: Object.fromEntries(noms.map((n) => [n.id, n.name])) };
}
