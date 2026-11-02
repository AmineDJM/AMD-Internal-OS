import { prisma } from "@/lib/prisma";
import { groupesARevoir, type GroupeARevoir } from "../domaine/revue";

/**
 * LES LECTURES DES ÉCRANS DE CONSUMPTION INTELLIGENCE — sorties des pages pour que `src/app/` ne parle plus à Prisma.
 * Aucune garde de droits ici : la page appelle `requireModule("CONSUMPTION")` AVANT, comme partout.
 *
 * Dette héritée, nommée : `referentielsDeRevue` lit `MedicalInstitution` et `Product`, tables d'autres modules. Cible :
 * passer par l'`api.ts` des modules Annuaires et Produits quand ils existeront (rapport d'audit 08, plan de migration).
 */

export async function listerImports() {
  const imports = await prisma.consommationImport.findMany({
    orderBy: { createdAt: "desc" }, take: 100,
    select: { id: true, nomFichier: true, statut: true, createdAt: true, valideLe: true, _count: { select: { lignes: true } } },
  });
  const parStatut = await prisma.consommationLigne.groupBy({ by: ["importId", "statut"], where: { importId: { in: imports.map((i) => i.id) } }, _count: { _all: true } });
  const compte = (id: string, s: string) => parStatut.find((x) => x.importId === id && x.statut === s)?._count._all ?? 0;
  return imports.map((i) => ({ ...i, sures: compte(i.id, "OK"), aRevoir: compte(i.id, "A_REVOIR"), doublons: compte(i.id, "DOUBLON") }));
}

export const STATUTS_LIGNE = ["OK", "A_REVOIR", "DOUBLON", "IGNOREE"] as const;
export type StatutLigne = (typeof STATUTS_LIGNE)[number];

export function lireImport(id: string) {
  return prisma.consommationImport.findUnique({ where: { id }, select: { id: true, nomFichier: true, statut: true, analyse: true, createdAt: true, valideLe: true } });
}

/** Les lignes affichées (400 au plus, filtrables par statut) et le compte par statut. */
export async function lignesDeLImport(importId: string, filtre: StatutLigne | null) {
  const [lignes, compte] = await Promise.all([
    prisma.consommationLigne.findMany({
      where: { importId, ...(filtre ? { statut: filtre } : {}) },
      orderBy: [{ feuille: "asc" }, { ligneSource: "asc" }], take: 400,
      select: {
        id: true, feuille: true, ligneSource: true, periodeDebut: true, periodeFin: true, etablissementBrut: true, produitBrut: true, molecule: true,
        quantiteSource: true, uniteSource: true, quantite: true, unite: true, confiance: true, statut: true, anomalies: true,
        institution: { select: { name: true } }, product: { select: { canonicalName: true } },
      },
    }),
    prisma.consommationLigne.groupBy({ by: ["statut"], where: { importId }, _count: { _all: true } }),
  ]);
  const n = (s: StatutLigne) => compte.find((c) => c.statut === s)?._count._all ?? 0;
  return { lignes, n };
}

/** Ce qui reste à trancher dans un import en revue, regroupé par valeur brute (règle : `domaine/revue.ts`). */
export async function groupesDeLImport(importId: string): Promise<GroupeARevoir[]> {
  const aRevoir = await prisma.consommationLigne.findMany({
    where: { importId, statut: "A_REVOIR" },
    select: { etablissementBrut: true, produitBrut: true, molecule: true, institutionId: true, productId: true, anomalies: true },
  });
  return groupesARevoir(aRevoir);
}

/** Les établissements et produits actifs entre lesquels on tranche (dette héritée : voir l'en-tête). */
export async function referentielsDeRevue() {
  const [etablissements, produits] = await Promise.all([
    prisma.medicalInstitution.findMany({ where: { isActive: true }, select: { id: true, name: true, wilaya: true }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" } }),
  ]);
  return {
    etablissements: etablissements.map((e) => ({ id: e.id, nom: e.wilaya ? `${e.name} (${e.wilaya})` : e.name })),
    produits: produits.map((p) => ({ id: p.id, nom: p.canonicalName })),
  };
}

/** L'écran d'affinité : les produits actifs (dette héritée : table `Product`) et les configurations réglées. */
export async function produitsEtConfigsAffinite() {
  const [produits, configs] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, canonicalName: true, dci: true }, orderBy: { canonicalName: "asc" } }),
    prisma.affiniteConfig.findMany({ select: { productId: true, panier: true, periode: true, debut: true, fin: true } }),
  ]);
  return { produits, configs };
}

/** Le nom des établissements d'un résultat (dette héritée : table `MedicalInstitution`). */
export async function nomsEtablissements(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.medicalInstitution.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
  return new Map(rows.map((n) => [n.id, n.name]));
}
