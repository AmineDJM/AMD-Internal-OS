import { prisma } from "@/lib/prisma";
import { etatValidite, libelleArticleStock } from "@/lib/promo/stock";
import { remisNetParArticle } from "@/lib/promo/remises";
import type { PromoFamille } from "@/lib/promo/catalogue";
import { arrondirAuMillieme } from "@/lib/utils";

/**
 * CE QUE LE FORMULAIRE DE VISITE PROPOSE, ET CE QU'UNE VISITE A REMIS (§118.166).
 *
 * Le bloc « Matériel remis » ne montre que ce que le délégué a EN MAIN — son solde, lot par lot,
 * séparant ce qui se distribue de ce qui est périmé — et les supports numériques valides. C'est
 * une PROPOSITION d'écran : l'action relit tout sous le verrou de chaque article, et c'est elle qui
 * a raison si les deux divergent (le sens sûr : un refus après le clic, jamais une remise de trop).
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface ArticleEnMain {
  itemId: string;
  reference: string;
  libelle: string;
  unite: string;
  famille: PromoFamille;
  /** Les produits que porte l'article — l'écran met en tête ceux des produits cochés. */
  produitIds: string[];
  /** Ce qui se distribue (lots non périmés). */
  distribuable: number;
  /** Ce qui est en main mais périmé — ne se remet pas, se déclare détruit. */
  perime: number;
}

export interface SupportPresentable {
  itemId: string;
  reference: string;
  libelle: string;
  produitIds: string[];
  lien: string | null;
  valableJusquau: string | null;
}

export interface StockPourVisite {
  articles: ArticleEnMain[];
  numeriques: SupportPresentable[];
}

/**
 * LE STOCK EN MAIN D'UN DÉLÉGUÉ, pour sa visite. Les supports numériques proposés sont ceux de sa
 * société (sa fiche salarié), valides aujourd'hui ; sans société lisible, tous les supports valides
 * — mieux vaut proposer un support de trop que cacher celui qu'il présente.
 */
export async function stockPourVisite(repId: string, maintenant: Date = new Date()): Promise<StockPourVisite> {
  const sommes = await prisma.promoStockMovement.groupBy({
    by: ["itemId", "lotId"], where: { holderId: repId }, _sum: { delta: true },
  });
  const positifs = sommes.filter((s) => num(s._sum.delta) > 0);
  const itemIds = [...new Set(positifs.map((s) => s.itemId))];
  const employe = await prisma.employee.findFirst({ where: { userId: repId }, select: { companyId: true, departmentRef: { select: { companyId: true } } } });
  const societe = employe?.companyId ?? employe?.departmentRef?.companyId ?? null;
  const [items, lots, supports] = await Promise.all([
    itemIds.length
      ? prisma.promoStockItem.findMany({
          where: { id: { in: itemIds } },
          select: {
            id: true, isActive: true,
            catalogue: { select: { reference: true, nom: true, famille: true, unite: true } },
            produits: { select: { product: { select: { id: true, canonicalName: true } } } },
          },
        })
      : Promise.resolve([]),
    positifs.length
      ? prisma.promoStockLot.findMany({ where: { id: { in: positifs.map((s) => s.lotId) } }, select: { id: true, valableJusquau: true } })
      : Promise.resolve([]),
    prisma.promoStockItem.findMany({
      where: {
        isActive: true, catalogue: { famille: "NUMERIQUE" },
        ...(societe ? { OR: [{ companyId: societe }, { companyId: null }] } : {}),
      },
      select: {
        id: true, lien: true, valableJusquau: true,
        catalogue: { select: { reference: true, nom: true } },
        produits: { select: { product: { select: { id: true, canonicalName: true } } } },
      },
      orderBy: { name: "asc" },
    }),
  ]);
  const validite = new Map(lots.map((l) => [l.id, l.valableJusquau]));
  const parItem = new Map<string, { distribuable: number; perime: number }>();
  for (const s of positifs) {
    const q = num(s._sum.delta);
    const e = parItem.get(s.itemId) ?? { distribuable: 0, perime: 0 };
    if (etatValidite(validite.get(s.lotId) ?? null, maintenant) === "PERIME") e.perime = arrondirAuMillieme(e.perime + q);
    else e.distribuable = arrondirAuMillieme(e.distribuable + q);
    parItem.set(s.itemId, e);
  }
  const articles: ArticleEnMain[] = items
    .filter((it) => it.catalogue.famille !== "NUMERIQUE")
    .map((it) => {
      const produits = it.produits.map((p) => ({ id: p.product.id, nom: p.product.canonicalName }));
      const e = parItem.get(it.id) ?? { distribuable: 0, perime: 0 };
      return {
        itemId: it.id, reference: it.catalogue.reference, libelle: libelleArticleStock(it.catalogue.nom, produits.map((p) => p.nom)),
        unite: it.catalogue.unite, famille: it.catalogue.famille as PromoFamille, produitIds: produits.map((p) => p.id),
        distribuable: e.distribuable, perime: e.perime,
      };
    })
    .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
  // VALIDE AUJOURD'HUI : la même lecture que l'action (`etatValidite`) — un filtre de date écrit en
  // SQL ici et en JavaScript là finirait par trancher différemment le jour de l'échéance.
  const numeriques: SupportPresentable[] = supports.filter((s) => etatValidite(s.valableJusquau, maintenant) !== "PERIME").map((s) => {
    const produits = s.produits.map((p) => ({ id: p.product.id, nom: p.product.canonicalName }));
    return {
      itemId: s.id, reference: s.catalogue.reference, libelle: libelleArticleStock(s.catalogue.nom, produits.map((p) => p.nom)),
      produitIds: produits.map((p) => p.id), lien: s.lien, valableJusquau: s.valableJusquau?.toISOString() ?? null,
    };
  });
  return { articles, numeriques };
}

export interface RemisesDeVisite {
  /** Ce qui a été remis, NET (une remise contre-passée ne compte plus). */
  materiel: { itemId: string; libelle: string; quantite: number }[];
  numeriques: { itemId: string; libelle: string }[];
}

/** CE QUE DES VISITES ONT REMIS — une lecture pour toutes (l'emploi du temps en montre trente). */
export async function remisesDesVisites(visitIds: readonly string[]): Promise<Map<string, RemisesDeVisite>> {
  if (visitIds.length === 0) return new Map();
  const [mouvements, presentations] = await Promise.all([
    prisma.promoStockMovement.findMany({
      where: { visitId: { in: [...visitIds] }, kind: { in: ["DISTRIBUTION", "REVERSAL"] } },
      select: {
        id: true, visitId: true, itemId: true, kind: true, delta: true, annuleId: true,
        item: { select: { catalogue: { select: { nom: true } }, produits: { select: { product: { select: { canonicalName: true } } } } } },
      },
    }),
    prisma.medicalVisitSupportNumerique.findMany({
      where: { visitId: { in: [...visitIds] } },
      select: { visitId: true, itemId: true, item: { select: { catalogue: { select: { nom: true } }, produits: { select: { product: { select: { canonicalName: true } } } } } } },
    }),
  ]);
  const libelleDe = (it: { catalogue: { nom: string }; produits: { product: { canonicalName: string } }[] }) =>
    libelleArticleStock(it.catalogue.nom, it.produits.map((p) => p.product.canonicalName));
  const out = new Map<string, RemisesDeVisite>();
  const parVisite = new Map<string, typeof mouvements>();
  for (const m of mouvements) {
    if (!m.visitId) continue;
    const l = parVisite.get(m.visitId) ?? [];
    l.push(m);
    parVisite.set(m.visitId, l);
  }
  for (const [visitId, ms] of parVisite) {
    const net = remisNetParArticle(ms.map((m) => ({ id: m.id, itemId: m.itemId, kind: m.kind, delta: num(m.delta), annuleId: m.annuleId })));
    const libelles = new Map(ms.map((m) => [m.itemId, libelleDe(m.item)]));
    out.set(visitId, {
      materiel: [...net].map(([itemId, quantite]) => ({ itemId, libelle: libelles.get(itemId) ?? "Article", quantite })),
      numeriques: [],
    });
  }
  for (const p of presentations) {
    const r = out.get(p.visitId) ?? { materiel: [], numeriques: [] };
    r.numeriques.push({ itemId: p.itemId, libelle: libelleDe(p.item) });
    out.set(p.visitId, r);
  }
  return out;
}

/**
 * CE QU'UN COMPTE RENDU DE VISITE (rapport terrain) A REMIS (§118.204) — le point de départ de sa
 * correction. Le même calcul net que pour une visite : une remise contre-passée ne compte plus.
 * Un compte rendu ne porte pas de supports numériques (ils se présentent lors d'une VISITE).
 */
export async function remisesDuRapport(fieldReportId: string): Promise<RemisesDeVisite> {
  const ms = await prisma.promoStockMovement.findMany({
    where: { fieldReportId, kind: { in: ["DISTRIBUTION", "REVERSAL"] } },
    select: {
      id: true, itemId: true, kind: true, delta: true, annuleId: true,
      item: { select: { catalogue: { select: { nom: true } }, produits: { select: { product: { select: { canonicalName: true } } } } } },
    },
  });
  const net = remisNetParArticle(ms.map((m) => ({ id: m.id, itemId: m.itemId, kind: m.kind, delta: num(m.delta), annuleId: m.annuleId })));
  const libelles = new Map(ms.map((m) => [m.itemId, libelleArticleStock(m.item.catalogue.nom, m.item.produits.map((p) => p.product.canonicalName))]));
  return {
    materiel: [...net].map(([itemId, quantite]) => ({ itemId, libelle: libelles.get(itemId) ?? "Article", quantite })),
    numeriques: [],
  };
}
