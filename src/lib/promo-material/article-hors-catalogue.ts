import { prisma } from "@/lib/prisma";
import { createWithRetry, enSerie } from "@/lib/refs";
import { FAMILLES as FAMILLES_PROMO, prochaineReference, type PromoFamille } from "@/lib/promo/catalogue";

/**
 * « AUTRE ARTICLE » — UN ARTICLE ABSENT DU CATALOGUE, SAISI LIBREMENT (Direction, 10/2026).
 *
 * Il entre au catalogue ARCHIVÉ et marqué hors catalogue (il ne se propose à personne), le temps qu'un gestionnaire
 * l'y ajoute (« Proposer au catalogue »). Une seule écriture pour les deux portes : la ligne ajoutée sur la fiche
 * (`enregistrerArticleDemandePromo`) et, depuis le lot F2 (banc réel du 02/11, TR-LM-04), la ligne saisie dès la
 * CRÉATION de la demande (`createPromoMaterial`) — « 3 cartons de brochures Daclavir » était retiré de la demande
 * faute d'article au catalogue, au lieu d'être proposé en saisie libre.
 *
 * Hors d'un fichier « use server » : une fonction qui reçoit l'auteur en argument, exportée d'un tel fichier, serait
 * un point d'entrée public (§118.153).
 */
export interface ArticleLibre {
  nom: string;
  famille: string;
  description?: string | null;
}

/** La règle d'un article libre — le nom et la famille — dite en une phrase ; `null` s'il est lisible. */
export function refusArticleLibre(a: Partial<ArticleLibre>): string | null {
  if (!a.nom?.trim()) return "Écrivez le nom de l'article (« Autre article »).";
  if (!a.famille || !(FAMILLES_PROMO as readonly string[]).includes(a.famille)) return "Choisissez la famille de l'article (consommable, durable ou numérique).";
  return null;
}

/** Crée l'article libre (archivé, hors catalogue) et rend son identifiant. */
export async function creerArticleHorsCatalogue(auteurId: string, a: ArticleLibre): Promise<string> {
  const cree = await enSerie("catalogue-promo", () => createWithRetry(async () => {
    const refs = await prisma.promoCatalogueArticle.findMany({ select: { reference: true } });
    return prisma.promoCatalogueArticle.create({
      data: {
        reference: prochaineReference(refs.map((r) => r.reference)), nom: a.nom.trim(), famille: a.famille as PromoFamille,
        description: a.description ?? null, actif: false, horsCatalogue: true, createdById: auteurId, updatedById: auteurId,
      },
      select: { id: true },
    });
  }));
  return cree.id;
}
