import { prisma } from "@/lib/prisma";
import { familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import { libelleArticleStock, JOURS_ALERTE_VALIDITE } from "@/lib/promo/stock";
import { JOURS_ALERTE_EN_ROUTE, type EntreeAlertes } from "@/lib/promo/comptages";
import { arrondirAuMillieme } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAITS DONT LES ALERTES DU STOCK SE CALCULENT — un seul chargeur (§118.168).
 *
 * Le battement qui ENVOIE les alertes et le tableau de bord qui les MONTRE lisent ce chargeur, puis
 * la même règle pure (`alertesDuStock`). Deux chargeurs finiraient par diverger — l'un oubliant les
 * articles archivés, l'autre les lots déjà périmés —, et le symptôme serait une alerte reçue que
 * l'écran ne montre pas, ou l'inverse (§118.5).
 *
 * Les soldes se calculent EN BASE ; aucune liste bornée n'est additionnée. Le périmètre se borne
 * par articles et par comptages : `null` = tout (le battement), une liste = un écran ou un banc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const JOUR_MS = 86_400_000;

export async function chargerFaitsAlertes(p: {
  itemIds: readonly string[] | null;
  comptageIds: readonly string[] | null;
  maintenant: Date;
}): Promise<EntreeAlertes> {
  const items = await prisma.promoStockItem.findMany({
    where: p.itemIds ? { id: { in: [...p.itemIds] } } : {},
    select: {
      id: true, isActive: true, alertThreshold: true, valableJusquau: true,
      catalogue: { select: { nom: true, famille: true } },
      produits: { select: { product: { select: { canonicalName: true } } } },
    },
  });
  const libelle = new Map(items.map((i) => [i.id, libelleArticleStock(i.catalogue.nom, i.produits.map((x) => x.product.canonicalName))]));
  const quantifies = items.filter((i) => familleQuantifiee(i.catalogue.famille as PromoFamille));
  const qIds = quantifies.map((i) => i.id);

  const horizon = new Date(p.maintenant.getTime() + (JOURS_ALERTE_VALIDITE + 1) * JOUR_MS);
  const limiteEnRoute = new Date(p.maintenant.getTime() - JOURS_ALERTE_EN_ROUTE * JOUR_MS);
  const limiteComptage = new Date(p.maintenant.getTime() - JOUR_MS);

  const [auMagasin, lotsDates, transferts, comptages] = await Promise.all([
    qIds.length
      ? prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: qIds }, holderId: null }, _sum: { delta: true } })
      : Promise.resolve([]),
    qIds.length
      ? prisma.promoStockLot.findMany({
          where: { itemId: { in: qIds }, valableJusquau: { not: null, lte: horizon } },
          select: { id: true, itemId: true, numero: true, valableJusquau: true },
        })
      : Promise.resolve([]),
    qIds.length
      ? prisma.promoStockTransfer.findMany({
          where: { itemId: { in: qIds }, statut: "EN_ROUTE", createdAt: { lte: limiteEnRoute } },
          select: { id: true, itemId: true, deId: true, versId: true, initiateurId: true, quantite: true, createdAt: true },
        })
      : Promise.resolve([]),
    prisma.promoStockComptage.findMany({
      where: {
        statut: "DEMANDE", echeance: { lte: limiteComptage },
        ...(p.comptageIds ? { id: { in: [...p.comptageIds] } } : {}),
      },
      select: { id: true, holderId: true, demandeurId: true, famille: true, echeance: true, createdAt: true },
    }),
  ]);

  // Les soldes POSITIFS par lot daté et par détenteur — c'est ce qui expire entre des mains.
  const soldesLots = lotsDates.length
    ? await prisma.promoStockMovement.groupBy({ by: ["lotId", "holderId"], where: { lotId: { in: lotsDates.map((l) => l.id) } }, _sum: { delta: true } })
    : [];
  const lotParId = new Map(lotsDates.map((l) => [l.id, l]));
  const soldeMagasin = new Map(auMagasin.map((s) => [s.itemId, arrondirAuMillieme(Number(s._sum.delta ?? 0))]));

  const personnes = new Set<string>();
  for (const s of soldesLots) if (s.holderId) personnes.add(s.holderId);
  for (const t of transferts) { if (t.deId) personnes.add(t.deId); if (t.versId) personnes.add(t.versId); }
  for (const c of comptages) if (c.holderId) personnes.add(c.holderId);
  const noms = personnes.size
    ? new Map((await prisma.user.findMany({ where: { id: { in: [...personnes] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();

  return {
    articles: quantifies.map((i) => ({
      itemId: i.id, libelle: libelle.get(i.id) ?? "Article", actif: i.isActive,
      seuil: i.alertThreshold == null ? null : Number(i.alertThreshold),
      auMagasin: soldeMagasin.get(i.id) ?? 0,
    })),
    lotsDates: soldesLots.flatMap((s) => {
      const lot = lotParId.get(s.lotId);
      const q = arrondirAuMillieme(Number(s._sum.delta ?? 0));
      return lot && lot.valableJusquau && q > 0
        ? [{ itemId: lot.itemId, lotId: lot.id, numero: lot.numero, libelle: libelle.get(lot.itemId) ?? "Article", holderId: s.holderId, quantite: q, valableJusquau: lot.valableJusquau }]
        : [];
    }),
    supports: items
      .filter((i) => !familleQuantifiee(i.catalogue.famille as PromoFamille))
      .map((i) => ({ itemId: i.id, libelle: libelle.get(i.id) ?? "Support", valableJusquau: i.valableJusquau, actif: i.isActive })),
    transferts: transferts.map((t) => ({
      id: t.id, itemId: t.itemId, libelle: libelle.get(t.itemId) ?? "Article", deId: t.deId, versId: t.versId,
      initiateurId: t.initiateurId, quantite: Number(t.quantite), createdAt: t.createdAt,
    })),
    comptages: comptages.map((c) => ({
      id: c.id, holderId: c.holderId, demandeurId: c.demandeurId, famille: (c.famille as PromoFamille | null) ?? null,
      echeance: c.echeance, createdAt: c.createdAt,
    })),
    nomDe: (id) => (id === null ? "le magasin" : noms.get(id) ?? "Compte supprimé"),
  };
}
