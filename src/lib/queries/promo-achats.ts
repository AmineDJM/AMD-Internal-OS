import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { estAction, type PromoAction } from "@/lib/promo-material/actions-fournisseur";
import type { ArticleDemandeLu, FamillePromo, LigneFactureLue, OptionCatalogue } from "@/lib/promo-material/achats";
import { codesPromus, libellesPromus, lirePromusStockes } from "@/lib/promo-material/promus";
import { optionsPromus } from "@/lib/queries/promo-promus";

/**
 * LE CHARGEUR DES ACHATS DU MATÉRIEL PROMOTIONNEL (§118.165) — ce que la règle pure ne lit pas.
 *
 * Les articles demandés d'un dossier, le détail d'une facture (ses lignes, sa réception), et les
 * listes que les formulaires proposent (catalogue actif, produits). L'action ET l'écran lisent
 * ici : deux lectures du même article demandé finiraient par en annoncer deux versions.
 */

const num = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));
const actions = (xs: readonly string[]): PromoAction[] => xs.filter(estAction);

export const SELECT_ARTICLE_DEMANDE = {
  id: true, position: true, catalogueId: true, quantite: true, actions: true, commentaire: true, promus: true,
  catalogue: { select: { reference: true, nom: true, famille: true, unite: true, horsCatalogue: true, description: true } },
  produits: { select: { product: { select: { id: true, canonicalName: true } } } },
} satisfies Prisma.PromoRequestItemSelect;

type ArticleBrut = Prisma.PromoRequestItemGetPayload<{ select: typeof SELECT_ARTICLE_DEMANDE }>;

export function articleDemandeLu(a: ArticleBrut): ArticleDemandeLu {
  const promus = lirePromusStockes(a.promus);
  return {
    ...(promus ? { promus: libellesPromus(promus), choixPromus: { codes: codesPromus(promus), autre: promus.autre } } : {}),
    // « Autre article » saisi librement, pas encore au catalogue (Direction, 10/2026).
    ...(a.catalogue.horsCatalogue ? { horsCatalogue: { description: a.catalogue.description } } : {}),
    id: a.id, position: a.position, catalogueId: a.catalogueId,
    reference: a.catalogue.reference, nom: a.catalogue.nom, famille: a.catalogue.famille as FamillePromo, unite: a.catalogue.unite,
    produits: a.produits.map((p) => ({ id: p.product.id, nom: p.product.canonicalName })).sort((x, y) => x.nom.localeCompare(y.nom, "fr")),
    quantite: num(a.quantite), actions: actions(a.actions), commentaire: a.commentaire,
  };
}

/** Les articles demandés d'un dossier, dans l'ordre où le demandeur les a posés. */
export async function articlesDemandesDuDossier(promoMaterialId: string): Promise<ArticleDemandeLu[]> {
  const rows = await prisma.promoRequestItem.findMany({
    where: { promoMaterialId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: SELECT_ARTICLE_DEMANDE,
  });
  return rows.map(articleDemandeLu);
}

/** Le type vit dans le domaine (`promo-material/achats.ts`) : le chargeur le réexporte. */
export type { OptionCatalogue } from "@/lib/promo-material/achats";

/**
 * CE QUE LE FORMULAIRE D'UN ARTICLE DEMANDÉ PROPOSE — le catalogue ACTIF et ce qu'une ligne peut promouvoir.
 *
 * Pas de garde du module « Catalogue » ici : le demandeur PIOCHE dans le catalogue pour composer
 * sa demande ; le module règle qui consulte et tient le catalogue lui-même (son écran), pas qui
 * peut nommer « une fiche posologique » dans une demande d'achat. Le fermer bloquerait toute
 * demande d'un délégué à qui personne n'a ouvert l'écran du catalogue (§118.27).
 */
export async function optionsDesArticlesDemandes(): Promise<{ catalogue: OptionCatalogue[]; produits: { id: string; nom: string }[] }> {
  const [catalogue, produits] = await Promise.all([
    prisma.promoCatalogueArticle.findMany({
      where: { actif: true },
      select: { id: true, reference: true, nom: true, famille: true, unite: true, exigeProduit: true },
      orderBy: { reference: "asc" },
    }),
    // LES PRODUITS PROMUS (§118.204) — la société, les gammes et les produits des Business Units, sous
    // leurs CODES : la liste lisait `Product` (canonique), vide en production, et affichait « Aucun produit ».
    optionsPromus(),
  ]);
  return {
    catalogue: catalogue.map((c) => ({ ...c, famille: c.famille as FamillePromo })),
    produits,
  };
}

export const SELECT_LIGNE_FACTURE = {
  id: true, position: true, designation: true, action: true, unite: true, quantite: true, prixUnitaire: true,
  quoteLineId: true, requestItemId: true, quantiteRecue: true, recueLe: true, renonce: true, stockItemId: true, stockLotId: true,
} satisfies Prisma.PromoFactureLigneSelect;

type LigneBrute = Prisma.PromoFactureLigneGetPayload<{ select: typeof SELECT_LIGNE_FACTURE }>;

export function ligneFactureLue(l: LigneBrute): LigneFactureLue {
  return {
    id: l.id, position: l.position, designation: l.designation, action: l.action && estAction(l.action) ? l.action : null,
    unite: l.unite, quantite: Number(l.quantite), prixUnitaire: Number(l.prixUnitaire),
    quoteLineId: l.quoteLineId, requestItemId: l.requestItemId,
    quantiteRecue: num(l.quantiteRecue), recueLe: l.recueLe, renonce: l.renonce, stockItemId: l.stockItemId, stockLotId: l.stockLotId,
  };
}

export interface DetailFacture {
  id: string;
  tvaRate: number;
  extraTaxLabel: string | null;
  extraTaxRate: number | null;
  totalImprime: number | null;
  lignes: LigneFactureLue[];
}

/** Le DÉTAIL des factures données (une lecture pour toutes) — absent pour une facture d'avant ce lot. */
export async function detailsDesFactures(legalDocumentIds: readonly string[]): Promise<Map<string, DetailFacture>> {
  if (legalDocumentIds.length === 0) return new Map();
  const rows = await prisma.promoFacture.findMany({
    where: { legalDocumentId: { in: [...legalDocumentIds] } },
    select: {
      id: true, legalDocumentId: true, tvaRate: true, extraTaxLabel: true, extraTaxRate: true, totalImprime: true,
      lignes: { orderBy: { position: "asc" }, select: SELECT_LIGNE_FACTURE },
    },
  });
  return new Map(rows.map((r) => [r.legalDocumentId, {
    id: r.id, tvaRate: Number(r.tvaRate), extraTaxLabel: r.extraTaxLabel, extraTaxRate: num(r.extraTaxRate),
    totalImprime: num(r.totalImprime), lignes: r.lignes.map(ligneFactureLue),
  }]));
}
