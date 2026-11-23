import { MaterialType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createWithRetry, enSerie } from "@/lib/refs";
import { prochaineReference, validerArticle, type ArticleValide } from "@/lib/promo/catalogue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE UNE LIGNE DU CATALOGUE PROMOTIONNEL — la référence CAT-NNNN attribuée ici, une fois.
 *
 * Deux portes : l'écran du catalogue (`creerArticleCatalogue`, droit `PROMO_CATALOG`), et — depuis
 * le 23/11/2026 — l'ENTRÉE MANUELLE AU MAGASIN. La Direction : « le matériel promotionnel doit
 * pouvoir être ajouté manuellement par Assia ». Un support qui arrive au magasin sans être au
 * catalogue (un don, un reliquat de salon) bloquait l'entrée : la gestionnaire du magasin n'a pas
 * le catalogue en écriture. Celle qui a le droit d'entrer du stock à la main (`peutEntrerAlaMain`)
 * ajoute donc AU CATALOGUE le support qu'elle entre — nom et famille, rien de plus ; le reste se
 * corrige ensuite depuis le catalogue, par qui l'a en écriture.
 *
 * Hors d'un fichier « use server » : une fonction qui reçoit l'auteur en argument, exportée d'un tel
 * fichier, serait un point d'entrée public (§118.153).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La série qui tient l'attribution des références : une création à la fois (§118.148). */
export const SERIE_CATALOGUE = "catalogue-promo";

/** CRÉER la ligne — à appeler DANS la série `SERIE_CATALOGUE` ; l'unicité de la référence reste tenue par la base. */
export async function creerLigneCatalogue(auteurId: string, a: ArticleValide): Promise<{ id: string; reference: string }> {
  return createWithRetry(async () => {
    const refs = await prisma.promoCatalogueArticle.findMany({ select: { reference: true } });
    return prisma.promoCatalogueArticle.create({
      data: {
        reference: prochaineReference(refs.map((r) => r.reference)),
        nom: a.nom, famille: a.famille, materialType: (a.materialType as MaterialType | null) ?? null,
        unite: a.unite, description: a.description, exigeProduit: a.exigeProduit,
        createdById: auteurId, updatedById: auteurId,
      },
      select: { id: true, reference: true },
    });
  });
}

/**
 * LE SUPPORT D'UNE ENTRÉE AU MAGASIN, ABSENT DE LA LISTE : retrouvé s'il est déjà au catalogue (même
 * nom, actif — un second « Porte-badge » ferait deux stocks de la même chose), créé sinon. Une
 * chose qu'on COMPTE seulement : un support numérique se déclare, il n'entre pas en stock.
 */
export async function trouverOuCreerAuCatalogue(
  auteurId: string,
  s: { nom: string | null; famille: string | null; exigeProduit: boolean },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!s.nom?.trim()) return { ok: false, error: "Écrivez le nom du nouvel article (« Autre article — absent du catalogue »)." };
  if (s.famille !== "CONSOMMABLE" && s.famille !== "DURABLE") {
    return { ok: false, error: "Choisissez la famille du nouvel article : consommable ou durable (un support numérique se déclare, il n'entre pas en stock)." };
  }
  const v = validerArticle({ nom: s.nom, famille: s.famille, materialType: null, unite: null, description: null, exigeProduit: s.exigeProduit }, new Set());
  if (!v.ok) return { ok: false, error: v.error };
  const a = v.article;
  return enSerie(SERIE_CATALOGUE, async () => {
    const existant = await prisma.promoCatalogueArticle.findFirst({
      where: { actif: true, nom: { equals: a.nom, mode: "insensitive" } },
      orderBy: { reference: "asc" },
      select: { id: true },
    });
    if (existant) return { ok: true, id: existant.id } as const;
    const cree = await creerLigneCatalogue(auteurId, a);
    await recordAudit({
      actorId: auteurId, action: "CREATE", module: "Catalogue promotionnel", entityId: cree.id,
      summary: `Article ${cree.reference} ajouté au catalogue depuis une entrée manuelle au magasin — ${a.nom}`,
    });
    return { ok: true, id: cree.id } as const;
  });
}
