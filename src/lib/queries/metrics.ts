import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { valeurDe, type MetricValue } from "@/lib/metrics/catalog";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CALCUL DES MÉTRIQUES — la seule implémentation de chaque définition.
 *
 * Le CONTRAT vit dans `src/lib/metrics/catalog.ts` (pur, sans import). ICI vit le CALCUL, et il
 * n'existe qu'ici. C'est ce qui donne son sens à la couche sémantique : si « encaissé » se
 * recalculait dans trois écrans, il finirait par valoir trois choses.
 *
 * Comme `product-360.ts`, ce fichier est une FAÇADE : les métriques traversent finance, ventes,
 * Ad&Pro, RH et réglementaire par construction.
 *
 * ── LA RÈGLE, RÉPÉTÉE PARCE QU'ELLE EST TOUJOURS TENTANTE D'ENFREINDRE ───────────────────
 *
 * Une donnée manquante rend `null` avec son `pourquoi`. Jamais zéro, jamais une estimation,
 * jamais une extrapolation « au prorata des autres ». Zéro et « on ne sait pas » sont deux
 * réponses opposées, et les confondre fait prendre des décisions sur du vide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : toNumber(v));
const DAY = 86_400_000;

export interface Periode {
  du: Date;
  au: Date;
}

/** Les douze derniers mois — la fenêtre par défaut, dite plutôt que supposée. */
export function douzeDerniersMois(reference = new Date()): Periode {
  const au = reference;
  const du = new Date(Date.UTC(au.getUTCFullYear() - 1, au.getUTCMonth(), au.getUTCDate()));
  return { du, au };
}

/** Nombre de mois (fractionnaires) que deux périodes ont en commun. Zéro si disjointes. */
export function moisEnCommun(a: Periode, b: { debut: Date; fin: Date | null }): number {
  const debut = Math.max(a.du.getTime(), b.debut.getTime());
  const fin = Math.min(a.au.getTime(), (b.fin ?? a.au).getTime());
  if (fin <= debut) return 0;
  return (fin - debut) / DAY / 30.44;
}

// ═══════════════════════════════ LES MÉTRIQUES D'UN PRODUIT ═══════════════════════════════

export interface MetriquesProduit {
  productId: string;
  periode: { du: string; au: string };
  metriques: MetricValue[];
  /** Ce qui empêche un calcul d'être complet — nommé, pas deviné. */
  limites: string[];
}

export async function metriquesProduit(productId: string, periode = douzeDerniersMois()): Promise<MetriquesProduit | null> {
  const existe = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!existe) return null;

  const fenetre = { gte: periode.du, lte: periode.au };
  const limites: string[] = [];

  const [lignes, encaisse, creances, adpro, adproSansPart, affectations, visites, dossiers] = await Promise.all([
    prisma.pchTenderLine.findMany({
      where: { productId },
      select: { id: true, status: true, quantityUnits: true, awardedUnitPriceDzd: true },
      take: 500,
    }),
    prisma.sale.aggregate({
      where: { productId, paymentStatus: "PAID", date: fenetre },
      _count: { _all: true }, _sum: { revenue: true },
    }),
    prisma.sale.aggregate({
      where: { productId, paymentStatus: { in: ["UNPAID", "PARTIAL", "OVERDUE"] }, date: fenetre },
      _count: { _all: true }, _sum: { revenue: true },
    }),
    prisma.adProProductAllocation.findMany({
      where: { productId },
      select: { sharePct: true, amountAllocated: true, item: { select: { amountGranted: true } } },
      take: 500,
    }),
    prisma.adProProductAllocation.count({ where: { productId, sharePct: null, amountAllocated: null } }),
    prisma.productAssignment.findMany({
      where: { productId, startedAt: { lte: periode.au }, OR: [{ endedAt: null }, { endedAt: { gte: periode.du } }] },
      select: {
        startedAt: true, endedAt: true, allocationPct: true,
        user: { select: { name: true, employee: { select: { employerCost: true, netToPay: true, baseSalary: true } } } },
      },
      take: 200,
    }),
    prisma.medicalVisitProduct.count({ where: { productId, visit: { date: fenetre } } }),
    prisma.regulatoryProduct.findMany({
      where: { productId },
      select: { reference: true, targetSubmissionDate: true, targetDate: true, status: true },
      take: 20,
    }),
  ]);

  // ── ATTRIBUÉ ET COMMANDÉ ────────────────────────────────────────────────────────────
  let attribue = 0;
  let gagneesSansPrix = 0;
  for (const l of lignes) {
    if (l.status !== "WON") continue;
    if (l.awardedUnitPriceDzd === null) { gagneesSansPrix++; continue; }
    attribue += Math.round(l.quantityUnits * num(l.awardedUnitPriceDzd));
  }
  if (gagneesSansPrix > 0) {
    limites.push(`${gagneesSansPrix} ligne(s) de marché gagnée(s) sans prix d'attribution : exclues de l'attribué`);
  }

  const commande = lignes.length
    ? await prisma.pchOrder.aggregate({
      where: { lineId: { in: lignes.map((l) => l.id) }, status: { not: "CANCELLED" } },
      _sum: { value: true },
    })
    : { _sum: { value: null } };

  // ── INVESTISSEMENT PROMOTIONNEL ─────────────────────────────────────────────────────
  let promo = 0;
  for (const a of adpro) {
    if (a.amountAllocated !== null) { promo += num(a.amountAllocated); continue; }
    if (a.sharePct !== null && a.item.amountGranted !== null) {
      promo += Math.round(num(a.item.amountGranted) * (num(a.sharePct) / 100));
    }
  }
  if (adproSansPart > 0) {
    limites.push(`${adproSansPart} imputation(s) Ad&Pro sans part ni montant : leur dépense n'est comptée nulle part`);
  }

  // ── COÛT HUMAIN ANALYTIQUE ──────────────────────────────────────────────────────────
  //
  // Une affectation SANS quotité ou SANS coût employeur est EXCLUE, et comptée. Répartir au
  // prorata des autres inventerait une décision d'organisation que personne n'a prise ; prendre
  // 100 % par défaut multiplierait le coût par le nombre de produits portés.
  let coutRh = 0;
  let affectationsIncompletes = 0;
  for (const a of affectations) {
    const cout = a.user.employee?.employerCost;
    if (a.allocationPct === null || cout === null || cout === undefined) { affectationsIncompletes++; continue; }
    const mois = moisEnCommun(periode, { debut: a.startedAt, fin: a.endedAt });
    coutRh += num(cout) * (num(a.allocationPct) / 100) * mois;
  }
  coutRh = Math.round(coutRh);
  const rhCalculable = affectations.length > 0 && affectationsIncompletes < affectations.length;
  if (affectationsIncompletes > 0) {
    limites.push(
      `${affectationsIncompletes} affectation(s) sur ${affectations.length} sans quotité ou sans coût employeur : `
      + "exclues du coût humain, qui est donc SOUS-ESTIMÉ",
    );
  }

  // ── RETARD RÉGLEMENTAIRE ────────────────────────────────────────────────────────────
  const maintenant = new Date();
  const cibles = dossiers.flatMap((d) => [d.targetSubmissionDate, d.targetDate]).filter((d): d is Date => d !== null);
  const depassees = cibles.filter((d) => d < maintenant);
  const retard = cibles.length === 0
    ? null
    : depassees.length === 0
      ? 0
      : Math.floor((maintenant.getTime() - Math.min(...depassees.map((d) => d.getTime()))) / DAY);

  // ── CONTRIBUTION ────────────────────────────────────────────────────────────────────
  const caEncaisse = num(encaisse._sum.revenue);
  const manquant: string[] = [];
  if (!rhCalculable) manquant.push("coût humain (aucune affectation exploitable)");
  const contribution = manquant.length === 0 ? Math.round(caEncaisse - promo - coutRh) : null;

  const moisPeriode = Math.max(1, (periode.au.getTime() - periode.du.getTime()) / DAY / 30.44);

  return {
    productId,
    periode: { du: periode.du.toISOString().slice(0, 10), au: periode.au.toISOString().slice(0, 10) },
    metriques: [
      valeurDe("awardedRevenue", attribue, { base: `${lignes.filter((l) => l.status === "WON").length} ligne(s) gagnée(s)` }),
      valeurDe("orderedRevenue", num(commande._sum.value), { base: `${lignes.length} ligne(s) de marché` }),
      valeurDe("collectedRevenue", caEncaisse, { base: `${encaisse._count._all} vente(s) réglée(s) sur la période` }),
      valeurDe("outstandingReceivables", num(creances._sum.revenue), { base: `${creances._count._all} vente(s) non soldée(s)` }),
      valeurDe("adProSpend", promo, { base: `${adpro.length} imputation(s)` }),
      rhCalculable
        ? valeurDe("hrAllocatedCost", coutRh, { base: `${affectations.length - affectationsIncompletes} affectation(s) exploitable(s)` })
        : valeurDe("hrAllocatedCost", null, {
          pourquoi: affectations.length === 0
            ? "aucune personne affectée à ce produit sur la période"
            : "aucune affectation ne porte à la fois une quotité et un coût employeur",
        }),
      contribution !== null
        ? valeurDe("productContribution", contribution, { base: "encaissé − Ad&Pro imputé − coût humain" })
        : valeurDe("productContribution", null, { pourquoi: `composante(s) manquante(s) : ${manquant.join(", ")}` }),
      retard !== null
        ? valeurDe("regulatoryDelay", retard, { base: `${dossiers.length} dossier(s), ${cibles.length} date(s) cible` })
        : valeurDe("regulatoryDelay", null, {
          pourquoi: dossiers.length === 0
            ? "aucun dossier réglementaire rattaché"
            : "aucune date cible fixée — ce n'est PAS l'absence de retard",
        }),
      valeurDe("visitFrequency", visites, {
        base: `${visites} visite(s) rattachée(s) sur ${moisPeriode.toFixed(1)} mois `
          + `(${(visites / moisPeriode).toFixed(1)}/mois)`,
      }),
    ],
    limites,
  };
}

// ═══════════════════════════════ LES MÉTRIQUES D'UN MARCHÉ ═══════════════════════════════

export async function metriquesMarche(tenderId: string): Promise<{ tenderId: string; metriques: MetricValue[] } | null> {
  const t = await prisma.pchTender.findUnique({
    where: { id: tenderId },
    select: {
      id: true,
      lines: { select: { id: true, status: true, quantityUnits: true, awardedUnitPriceDzd: true } },
      orders: { select: { value: true, status: true, paymentDate: true } },
    },
  });
  if (!t) return null;

  let attribue = 0, sansPrix = 0;
  for (const l of t.lines) {
    if (l.status !== "WON") continue;
    if (l.awardedUnitPriceDzd === null) { sansPrix++; continue; }
    attribue += Math.round(l.quantityUnits * num(l.awardedUnitPriceDzd));
  }

  let commande = 0, livre = 0, encaisse = 0;
  for (const o of t.orders) {
    if (o.status === "CANCELLED") continue;
    const v = num(o.value);
    commande += v;
    if (o.status === "DELIVERED" || o.status === "PAID") livre += v;
    if (o.status === "PAID" || o.paymentDate !== null) encaisse += v;
  }

  return {
    tenderId: t.id,
    metriques: [
      valeurDe("awardedRevenue", Math.round(attribue), {
        base: `${t.lines.filter((l) => l.status === "WON").length} ligne(s) gagnée(s)`,
        ...(sansPrix > 0 ? { pourquoi: `${sansPrix} ligne(s) gagnée(s) sans prix d'attribution, exclues` } : {}),
      }),
      valeurDe("orderedRevenue", Math.round(commande), { base: `${t.orders.length} bon(s) de commande` }),
      valeurDe("deliveredRevenue", Math.round(livre)),
      valeurDe("collectedRevenue", Math.round(encaisse)),
      valeurDe("outstandingReceivables", Math.round(commande - encaisse), { base: "commandé − encaissé" }),
    ],
  };
}
