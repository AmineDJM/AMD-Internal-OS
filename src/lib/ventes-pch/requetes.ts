import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  SOURCE_RECEPTIONS, chaineContrat, coutDeReference, dateDuMois, decalerMois, evolution, moisDeDate, moisEntre, moisManquants,
  partDeMarche as partDeMarchePct, partsFournisseurs, serieSurMois, valeurAuCout, type ChaineContrat,
} from "./calculs";
import { cleClient, moleculeDe, motsDistinctifs } from "./normalisation";

/**
 * VENTES PCH — LES LECTURES (serveur). Les écrans de « Ventes PCH » ET les autres modules (cockpit, Produits 360,
 * Stocks) lisent ici, jamais les tables directement.
 *
 * API EXPOSÉE (périodes en « AAAA-MM », bornes incluses) :
 *   • `venteParProduitEtMois({ debut, fin, productIds? })` — par produit et par mois : quantité livrée aux hôpitaux par
 *     les DR (sell-out de la molécule), commandée, non servie, valeur au coût d'achat PCH (DZD) ;
 *   • `demandeNonServie({ debut, fin, productIds? })` — par produit et par DR : quantité demandée et non servie (lignes
 *     livrées à 0) et nombre d'établissements qui l'ont demandée — le signal de rupture ;
 *   • `consommationHospitaliereMensuelle(productId, { debut?, fin? })` — par établissement et par mois : livré, non servi ;
 *   • `receptionsPch(productId, { debut, fin })` — réceptions FO de la PCH centrale par mois et par fournisseur, en
 *     distinguant les nôtres (sell-in) ;
 *   • `partDeMarche(productId, { debut, fin })` — nos réceptions FO ÷ toutes les réceptions FO des mêmes postes PCH ;
 *   • `indicateursProduitsPch(productIds, { debut, fin })` — tout cela d'un coup pour une liste de produits (Produits 360) ;
 *   • `dernierMoisPch()` — le dernier mois reçu, fin des « 12 mois » des autres modules.
 * Un produit est relié à ses postes PCH par `PchPoste` ; une ligne sans produit est une donnée de marché.
 */

export interface Bornes { debut: string; fin: string }
const entreMois = (b: Bornes) => ({ gte: dateDuMois(b.debut), lte: dateDuMois(b.fin) });
const n = (v: unknown) => toNumber(v);

// ─────────────────────────── Référentiels ───────────────────────────

export interface BuPch { id: string; nom: string }
export interface ProduitPch { id: string; nom: string; code: string; bus: BuPch[] }

export async function busPch(): Promise<BuPch[]> {
  const rows = await prisma.businessUnit.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } });
  return rows.map((r) => ({ id: r.id, nom: r.name }));
}

/** NOS produits présents dans les données PCH (un poste rattaché) ou dans un marché gagné — filtrés par BU. */
export async function produitsVentesPch(buId?: string | null): Promise<ProduitPch[]> {
  const rows = await prisma.product.findMany({
    where: {
      OR: [{ postesPch: { some: {} } }, { tenderLines: { some: { status: "WON" } } }, { contractLines: { some: {} } }],
      ...(buId ? { promoProfiles: { some: { businessUnitId: buId } } } : {}),
    },
    orderBy: { canonicalName: "asc" },
    select: { id: true, canonicalName: true, code: true, promoProfiles: { select: { businessUnit: { select: { id: true, name: true } } } } },
  });
  return rows.map((p) => ({
    id: p.id, nom: p.canonicalName, code: p.code,
    bus: [...new Map(p.promoProfiles.filter((x) => x.businessUnit).map((x) => [x.businessUnit!.id, { id: x.businessUnit!.id, nom: x.businessUnit!.name }])).values()],
  }));
}

async function fournisseursActifs(productIds: string[]): Promise<Map<string, Map<string, string>>> {
  const rows = await prisma.pchFournisseurProduit.findMany({ where: { productId: { in: productIds }, actif: true }, select: { productId: true, fournisseurCle: true, libelle: true } });
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) (out.get(r.productId) ?? out.set(r.productId, new Map()).get(r.productId)!).set(r.fournisseurCle, r.libelle);
  return out;
}

// ─────────────────────────── API exposée ───────────────────────────

export interface VenteProduitMois { productId: string; mois: string; livre: number; commande: number; nonServi: number; valeurAchat: number }

export async function venteParProduitEtMois(opts: Bornes & { productIds?: string[] }): Promise<VenteProduitMois[]> {
  const where: Prisma.PchVenteLigneWhereInput = { mois: entreMois(opts), productId: opts.productIds ? { in: opts.productIds } : { not: null } };
  const [tout, ns] = await Promise.all([
    prisma.pchVenteLigne.groupBy({ by: ["productId", "mois"], where, _sum: { qteLivree: true, qteCommandee: true, valeurAchat: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["productId", "mois"], where: { ...where, statut: "NON_SERVIE" }, _sum: { qteCommandee: true } }),
  ]);
  const nsDe = new Map(ns.map((r) => [`${r.productId}|${moisDeDate(r.mois)}`, n(r._sum.qteCommandee)]));
  return tout.map((r) => ({
    productId: r.productId!, mois: moisDeDate(r.mois),
    livre: n(r._sum.qteLivree), commande: n(r._sum.qteCommandee), valeurAchat: n(r._sum.valeurAchat),
    nonServi: nsDe.get(`${r.productId}|${moisDeDate(r.mois)}`) ?? 0,
  })).sort((a, b) => a.mois.localeCompare(b.mois));
}

export interface DemandeNonServie { productId: string; dr: string; quantite: number; etablissements: number; lignes: number }

export async function demandeNonServie(opts: Bornes & { productIds?: string[] }): Promise<DemandeNonServie[]> {
  const rows = await prisma.pchVenteLigne.groupBy({
    by: ["productId", "dr", "clientCle"],
    where: { mois: entreMois(opts), statut: "NON_SERVIE", productId: opts.productIds ? { in: opts.productIds } : { not: null } },
    _sum: { qteCommandee: true }, _count: { _all: true },
  });
  const out = new Map<string, DemandeNonServie>();
  for (const r of rows) {
    const k = `${r.productId}|${r.dr}`;
    const x = out.get(k) ?? out.set(k, { productId: r.productId!, dr: r.dr, quantite: 0, etablissements: 0, lignes: 0 }).get(k)!;
    x.quantite += n(r._sum.qteCommandee); x.etablissements++; x.lignes += r._count._all;
  }
  return [...out.values()].sort((a, b) => b.quantite - a.quantite);
}

export interface ConsommationEtablissementMois { institutionId: string | null; clientCle: string; mois: string; livre: number; nonServi: number }

export async function consommationHospitaliereMensuelle(productId: string, opts: Partial<Bornes> = {}): Promise<ConsommationEtablissementMois[]> {
  const mois: Prisma.DateTimeFilter = {};
  if (opts.debut) mois.gte = dateDuMois(opts.debut);
  if (opts.fin) mois.lte = dateDuMois(opts.fin);
  const where: Prisma.PchVenteLigneWhereInput = { productId, mois };
  const [tout, ns] = await Promise.all([
    prisma.pchVenteLigne.groupBy({ by: ["institutionId", "clientCle", "mois"], where, _sum: { qteLivree: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["institutionId", "clientCle", "mois"], where: { ...where, statut: "NON_SERVIE" }, _sum: { qteCommandee: true } }),
  ]);
  const cle = (r: { clientCle: string; mois: Date }) => `${r.clientCle}|${moisDeDate(r.mois)}`;
  const nsDe = new Map(ns.map((r) => [cle(r), n(r._sum.qteCommandee)]));
  return tout.map((r) => ({ institutionId: r.institutionId, clientCle: r.clientCle, mois: moisDeDate(r.mois), livre: n(r._sum.qteLivree), nonServi: nsDe.get(cle(r)) ?? 0 }));
}

// ─────────────────────────── Synthèse ───────────────────────────

/** Le coût d'achat PCH de référence d'un produit : valeur ÷ quantité livrée, sur toutes les données (stable). */
async function coutsDeReference(ids: string[]): Promise<Map<string, number | null>> {
  if (!ids.length) return new Map();
  const rows = await prisma.pchVenteLigne.groupBy({ by: ["productId"], where: { productId: { in: ids }, qteLivree: { gt: 0 }, valeurAchat: { not: null } }, _sum: { qteLivree: true, valeurAchat: true } });
  return new Map(rows.map((c) => [c.productId!, coutDeReference(n(c._sum.valeurAchat), n(c._sum.qteLivree))]));
}

interface Agregat { distribue: number; valeurAchat: number; nonServi: number; recuNous: number; recuMarche: number }

async function agregats(ids: string[], b: Bornes): Promise<Map<string, Agregat>> {
  const out = new Map<string, Agregat>();
  if (!ids.length) return out;
  const get = (id: string) => out.get(id) ?? out.set(id, { distribue: 0, valeurAchat: 0, nonServi: 0, recuNous: 0, recuMarche: 0 }).get(id)!;
  const mois = entreMois(b);
  const [ventes, ns, recus, nos] = await Promise.all([
    prisma.pchVenteLigne.groupBy({ by: ["productId"], where: { productId: { in: ids }, mois }, _sum: { qteLivree: true, valeurAchat: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["productId"], where: { productId: { in: ids }, mois, statut: "NON_SERVIE" }, _sum: { qteCommandee: true } }),
    prisma.pchReceptionLigne.groupBy({ by: ["productId", "fournisseurCle"], where: { productId: { in: ids }, mois, type: "FO" }, _sum: { qte: true } }),
    fournisseursActifs(ids),
  ]);
  for (const r of ventes) { const a = get(r.productId!); a.distribue = n(r._sum.qteLivree); a.valeurAchat = n(r._sum.valeurAchat); }
  for (const r of ns) get(r.productId!).nonServi = n(r._sum.qteCommandee);
  for (const r of recus) {
    const a = get(r.productId!), q = n(r._sum.qte);
    a.recuMarche += q;
    if (nos.get(r.productId!)?.has(r.fournisseurCle)) a.recuNous += q;
  }
  return out;
}

export interface LigneSynthese {
  productId: string; nom: string; code: string; bus: BuPch[];
  /** Nos réceptions FO à la PCH (boîtes) et leur valeur au coût d'achat PCH (DZD). */
  recuNous: number; recuValeur: number | null; recuMarche: number; partPct: number | null;
  /** Distribué aux hôpitaux par les DR (boîtes) et sa valeur au coût PCH. */
  distribue: number; distribueValeur: number;
  nonServi: number;
  evolRecu: number | null; evolDistribue: number | null;
  /** Aucun fournisseur « à nous » réglé : le sell-in ne se lit pas encore. */
  sansFournisseur: boolean;
}

/** SYNTHÈSE PAR BU → PRODUIT sur la période, avec l'évolution sur la période précédente de même longueur. */
export async function synthesePch(periode: Bornes, precedente: Bornes, buId?: string | null): Promise<LigneSynthese[]> {
  const produits = await produitsVentesPch(buId);
  const ids = produits.map((p) => p.id);
  const [cur, prev, cout, nos] = await Promise.all([agregats(ids, periode), agregats(ids, precedente), coutsDeReference(ids), fournisseursActifs(ids)]);
  return produits.map((p) => {
    const a = cur.get(p.id) ?? { distribue: 0, valeurAchat: 0, nonServi: 0, recuNous: 0, recuMarche: 0 };
    const b = prev.get(p.id);
    const c = cout.get(p.id) ?? null;
    return {
      productId: p.id, nom: p.nom, code: p.code, bus: p.bus,
      recuNous: a.recuNous, recuValeur: c !== null ? Math.round(a.recuNous * c) : null, recuMarche: a.recuMarche,
      partPct: partDeMarchePct(a.recuNous, a.recuMarche),
      distribue: a.distribue, distribueValeur: a.valeurAchat, nonServi: a.nonServi,
      evolRecu: b ? evolution(a.recuNous, b.recuNous) : null,
      evolDistribue: b ? evolution(a.distribue, b.distribue) : null,
      sansFournisseur: !(nos.get(p.id)?.size),
    };
  });
}

// ─────────────────────────── Produits 360 ───────────────────────────

/** Le dernier mois présent dans les données PCH (ventes des DR ou réceptions) — `null` sans aucune donnée. */
export async function dernierMoisPch(): Promise<string | null> {
  const [v, r] = await Promise.all([prisma.pchVenteLigne.aggregate({ _max: { mois: true } }), prisma.pchReceptionLigne.aggregate({ _max: { mois: true } })]);
  return [v._max.mois, r._max.mois].filter((d): d is Date => !!d).map(moisDeDate).sort().at(-1) ?? null;
}

export interface IndicateursProduitPch {
  productId: string;
  /** Nos réceptions FO à la PCH centrale (sell-in, boîtes), leur valeur au coût PCH (DZD), l'évolution sur la période d'avant. */
  recuNous: number; recuValeur: number | null; recuNousPrecedent: number; evolRecu: number | null;
  /** Toutes les réceptions FO des mêmes postes (le marché de la molécule-dosage-forme) et notre part. */
  recuMarche: number; partPct: number | null;
  /** Mois par mois (les mois de la période) : nos réceptions, la distribution aux hôpitaux par les DR (sell-out). */
  sellIn: number[]; sellOut: number[];
  /** Les seuls mois où les DR ont une ligne du produit (un mois sans fichier n'est pas une consommation nulle). */
  sellOutLignes: { mois: string; livre: number }[];
  distribue: number; nonServi: number; etablissementsNonServis: number;
  /** Les 3 derniers mois de la période — la demande non servie qui fait le signal. */
  recent: { nonServi: number; livre: number; etablissements: number };
  fournisseurs: { fournisseur: string; qte: number; nous: boolean; partPct: number | null }[];
  /** Aucun fournisseur « à nous » réglé : le sell-in ne se lit pas encore. */
  sansFournisseur: boolean;
}

/**
 * LES CHIFFRES PCH DE PLUSIEURS PRODUITS (Produits 360 : la liste et la fiche) sur une période, en une poignée de
 * requêtes groupées : sell-in, part de marché, sell-out mensuel, demande non servie, fournisseurs.
 */
export async function indicateursProduitsPch(productIds: string[], periode: Bornes): Promise<{ mois: string[]; parProduit: Map<string, IndicateursProduitPch> }> {
  const mois = moisEntre(periode.debut, periode.fin);
  const parProduit = new Map<string, IndicateursProduitPch>();
  if (!productIds.length) return { mois, parProduit };
  const precedente = { debut: decalerMois(periode.debut, -mois.length), fin: decalerMois(periode.debut, -1) };
  const recente = { debut: [periode.debut, decalerMois(periode.fin, -2)].sort().at(-1)!, fin: periode.fin };
  const ou = { productId: { in: productIds }, type: "FO" };
  const [recus, recusAvant, ventes, ns, nsRecent, couts, nos] = await Promise.all([
    prisma.pchReceptionLigne.groupBy({ by: ["productId", "mois", "fournisseurCle", "fournisseur"], where: { ...ou, mois: entreMois(periode) }, _sum: { qte: true } }),
    prisma.pchReceptionLigne.groupBy({ by: ["productId", "fournisseurCle"], where: { ...ou, mois: entreMois(precedente) }, _sum: { qte: true } }),
    venteParProduitEtMois({ ...periode, productIds }),
    demandeNonServie({ ...periode, productIds }),
    demandeNonServie({ ...recente, productIds }),
    coutsDeReference(productIds),
    fournisseursActifs(productIds),
  ]);
  for (const id of productIds) {
    const miens = nos.get(id) ?? new Map<string, string>();
    const r = recus.filter((x) => x.productId === id);
    const four = new Map<string, { fournisseur: string; qte: number; nous: boolean }>();
    let recuNous = 0, recuMarche = 0;
    const sellIn: { mois: string; qte: number }[] = [];
    for (const x of r) {
      const q = n(x._sum.qte), estNous = miens.has(x.fournisseurCle);
      recuMarche += q;
      if (estNous) { recuNous += q; sellIn.push({ mois: moisDeDate(x.mois), qte: q }); }
      const f = four.get(x.fournisseurCle) ?? four.set(x.fournisseurCle, { fournisseur: x.fournisseur, qte: 0, nous: estNous }).get(x.fournisseurCle)!;
      f.qte += q;
    }
    const recuNousPrecedent = recusAvant.filter((x) => x.productId === id && miens.has(x.fournisseurCle)).reduce((s, x) => s + n(x._sum.qte), 0);
    const v = ventes.filter((x) => x.productId === id);
    const nsRecents = nsRecent.filter((x) => x.productId === id);
    const vRecentes = v.filter((x) => x.mois >= recente.debut);
    parProduit.set(id, {
      productId: id,
      recuNous, recuValeur: valeurAuCout(recuNous, couts.get(id) ?? null), recuNousPrecedent, evolRecu: evolution(recuNous, recuNousPrecedent),
      recuMarche, partPct: partDeMarchePct(recuNous, recuMarche),
      sellIn: serieSurMois(mois, sellIn), sellOut: serieSurMois(mois, v.map((x) => ({ mois: x.mois, qte: x.livre }))),
      sellOutLignes: v.map((x) => ({ mois: x.mois, livre: x.livre })),
      distribue: v.reduce((s, x) => s + x.livre, 0), nonServi: v.reduce((s, x) => s + x.nonServi, 0),
      etablissementsNonServis: ns.filter((x) => x.productId === id).reduce((s, x) => s + x.etablissements, 0),
      recent: {
        nonServi: nsRecents.reduce((s, x) => s + x.quantite, 0), etablissements: nsRecents.reduce((s, x) => s + x.etablissements, 0),
        livre: vRecentes.reduce((s, x) => s + x.livre, 0),
      },
      fournisseurs: partsFournisseurs([...four.values()]),
      sansFournisseur: miens.size === 0,
    });
  }
  return { mois, parProduit };
}

// ─────────────────────────── Contrats ───────────────────────────

export interface LigneContrat {
  cle: string;
  productId: string; nom: string; bus: BuPch[];
  marche: { id: string; reference: string; titre: string | null } | null;
  contrat: { id: string; reference: string | null; titre: string } | null;
  chaine: ChaineContrat;
  bcs: number;
  bcAvenants: number;
}

/**
 * LA CHAÎNE DE CHAQUE CONTRAT, PRODUIT PAR PRODUIT (unités du marché) : attribué (lignes contractuelles, avenants
 * compris ; à défaut la quantité attribuée du lot gagné) → BC cumulés (hors annulés) → livré (BL datés) → reste,
 * dépassement, avenant. Les faits viennent du module Marchés PCH, rien n'est ressaisi.
 */
export async function chainesContratsPch(buId?: string | null, productIds?: readonly string[]): Promise<LigneContrat[]> {
  const produits = (await produitsVentesPch(buId)).filter((p) => !productIds || productIds.includes(p.id));
  const ids = produits.map((p) => p.id);
  if (!ids.length) return [];
  const parId = new Map(produits.map((p) => [p.id, p]));
  const [lignesContrat, lots, bons] = await Promise.all([
    prisma.pchContractLine.findMany({ where: { productId: { in: ids } }, select: { productId: true, contractId: true, quantityUnits: true, contract: { select: { id: true, reference: true, title: true, tenderId: true, tender: { select: { id: true, reference: true, title: true } } } } } }),
    prisma.pchTenderLine.findMany({ where: { productId: { in: ids }, status: "WON" }, select: { productId: true, quantityUnits: true, submittedQuantityUnits: true, awardedQuantityUnits: true, tender: { select: { id: true, reference: true, title: true } } } }),
    prisma.pchOrderLine.findMany({
      where: { OR: [{ contractLine: { productId: { in: ids } } }, { tenderLine: { productId: { in: ids } } }], order: { status: { not: "CANCELLED" } } },
      select: {
        id: true, quantityUnits: true,
        contractLine: { select: { productId: true, contractId: true } },
        tenderLine: { select: { productId: true, tenderId: true } },
        order: { select: { id: true, estAvenant: true, contractId: true, tenderId: true } },
        deliveryLines: { select: { quantityUnits: true, delivery: { select: { deliveredAt: true } } } },
      },
    }),
  ]);
  type G = { productId: string; marche: LigneContrat["marche"]; contrat: LigneContrat["contrat"]; attribue: number; commande: number; livre: number; bcs: Set<string>; avenants: Set<string> };
  const groupes = new Map<string, G>();
  const marchesCouverts = new Set<string>();
  for (const l of lignesContrat) {
    const k = `${l.productId}|${l.contractId}`;
    const g = groupes.get(k) ?? groupes.set(k, {
      productId: l.productId!, attribue: 0, commande: 0, livre: 0, bcs: new Set(), avenants: new Set(),
      contrat: { id: l.contract.id, reference: l.contract.reference, titre: l.contract.title },
      marche: l.contract.tender ? { id: l.contract.tender.id, reference: l.contract.tender.reference, titre: l.contract.tender.title } : null,
    }).get(k)!;
    g.attribue += l.quantityUnits;
    if (l.contract.tenderId) marchesCouverts.add(`${l.productId}|${l.contract.tenderId}`);
  }
  for (const l of lots) {
    if (marchesCouverts.has(`${l.productId}|${l.tender.id}`)) continue;
    const k = `${l.productId}|ao:${l.tender.id}`;
    const g = groupes.get(k) ?? groupes.set(k, { productId: l.productId!, attribue: 0, commande: 0, livre: 0, bcs: new Set(), avenants: new Set(), contrat: null, marche: { id: l.tender.id, reference: l.tender.reference, titre: l.tender.title } }).get(k)!;
    g.attribue += l.awardedQuantityUnits ?? l.submittedQuantityUnits ?? l.quantityUnits;
  }
  for (const b of bons) {
    const productId = b.contractLine?.productId ?? b.tenderLine?.productId;
    if (!productId) continue;
    const contractId = b.contractLine?.contractId ?? b.order.contractId;
    const k = contractId && groupes.has(`${productId}|${contractId}`) ? `${productId}|${contractId}` : `${productId}|ao:${b.tenderLine?.tenderId ?? b.order.tenderId}`;
    const g = groupes.get(k) ?? groupes.set(k, { productId, attribue: 0, commande: 0, livre: 0, bcs: new Set(), avenants: new Set(), contrat: null, marche: null }).get(k)!;
    g.commande += b.quantityUnits;
    g.livre += b.deliveryLines.filter((d) => d.delivery.deliveredAt).reduce((s, d) => s + d.quantityUnits, 0);
    g.bcs.add(b.order.id);
    if (b.order.estAvenant) g.avenants.add(b.order.id);
  }
  return [...groupes.entries()].map(([cle, g]) => {
    const p = parId.get(g.productId)!;
    return { cle, productId: g.productId, nom: p?.nom ?? "", bus: p?.bus ?? [], marche: g.marche, contrat: g.contrat, chaine: chaineContrat(g.attribue, g.commande, g.livre, g.avenants.size > 0), bcs: g.bcs.size, bcAvenants: g.avenants.size };
  }).sort((a, b) => a.nom.localeCompare(b.nom) || (a.marche?.reference ?? "").localeCompare(b.marche?.reference ?? ""));
}

// ─────────────────────────── Territoires ───────────────────────────

export interface DirectionRegionale { code: string; libelle: string; wilayas: string[] }

export async function directionsRegionales(): Promise<DirectionRegionale[]> {
  const rows = await prisma.pchDirectionRegionale.findMany({ orderBy: { code: "asc" }, select: { code: true, libelle: true, wilayas: true } });
  return rows;
}

export interface LigneTerritoire { cle: string; libelle: string; livre: number; nonServi: number; etablissements: number }
export interface LigneEtablissement { cle: string; institutionId: string | null; nom: string; wilaya: string | null; dr: string; livre: number; nonServi: number }

export async function territoiresPch(periode: Bornes, opts: { buId?: string | null; productId?: string | null; dr?: string | null }) {
  const produits = await produitsVentesPch(opts.buId);
  const ids = opts.productId ? produits.filter((p) => p.id === opts.productId).map((p) => p.id) : produits.map((p) => p.id);
  const vide = { parDr: [] as LigneTerritoire[], parWilaya: [] as LigneTerritoire[], etablissements: [] as LigneEtablissement[], produits };
  if (!ids.length) return vide;
  const where: Prisma.PchVenteLigneWhereInput = { productId: { in: ids }, mois: entreMois(periode), ...(opts.dr ? { dr: opts.dr } : {}) };
  const [tout, ns, drs] = await Promise.all([
    prisma.pchVenteLigne.groupBy({ by: ["dr", "clientCle", "institutionId", "client"], where, _sum: { qteLivree: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["dr", "clientCle"], where: { ...where, statut: "NON_SERVIE" }, _sum: { qteCommandee: true } }),
    directionsRegionales(),
  ]);
  const inst = [...new Set(tout.map((r) => r.institutionId).filter((x): x is string => !!x))];
  const etabs = inst.length ? await prisma.medicalInstitution.findMany({ where: { id: { in: inst } }, select: { id: true, name: true, wilaya: true } }) : [];
  const etabDe = new Map(etabs.map((e) => [e.id, e]));
  const nsDe = new Map(ns.map((r) => [`${r.dr}|${r.clientCle}`, n(r._sum.qteCommandee)]));
  const parEtab = new Map<string, LigneEtablissement>();
  for (const r of tout) {
    const k = `${r.dr}|${r.clientCle}`;
    const e = r.institutionId ? etabDe.get(r.institutionId) : undefined;
    const x = parEtab.get(k) ?? parEtab.set(k, { cle: r.clientCle, institutionId: r.institutionId, nom: e?.name ?? r.client, wilaya: e?.wilaya ?? null, dr: r.dr, livre: 0, nonServi: nsDe.get(k) ?? 0 }).get(k)!;
    x.livre += n(r._sum.qteLivree);
  }
  const etablissements = [...parEtab.values()];
  const libDr = new Map(drs.map((d) => [d.code, d.libelle]));
  const cumul = (cle: (e: LigneEtablissement) => string, lib: (k: string) => string) => {
    const m = new Map<string, LigneTerritoire>();
    for (const e of etablissements) {
      const k = cle(e);
      const x = m.get(k) ?? m.set(k, { cle: k, libelle: lib(k), livre: 0, nonServi: 0, etablissements: 0 }).get(k)!;
      x.livre += e.livre; x.nonServi += e.nonServi; x.etablissements++;
    }
    return [...m.values()].sort((a, b) => b.livre - a.livre);
  };
  return {
    parDr: cumul((e) => e.dr, (k) => (libDr.get(k) && libDr.get(k) !== k ? `${k} — ${libDr.get(k)}` : k)),
    parWilaya: cumul((e) => e.wilaya ?? "", (k) => k || "À rattacher"),
    etablissements: etablissements.sort((a, b) => b.livre - a.livre || b.nonServi - a.nonServi),
    produits,
  };
}

/** UN ÉTABLISSEMENT (clé PCH) : sa série mensuelle, produit par produit, sur 12 mois finissant sur `fin`. */
export async function etablissementPch(cle: string, fin: string, buId?: string | null) {
  const produits = await produitsVentesPch(buId);
  const ids = produits.map((p) => p.id);
  const debut = decalerMois(fin, -11);
  const where: Prisma.PchVenteLigneWhereInput = { clientCle: cle, productId: { in: ids }, mois: entreMois({ debut, fin }) };
  const [exemple, tout, ns] = await Promise.all([
    prisma.pchVenteLigne.findFirst({ where: { clientCle: cle }, orderBy: { mois: "desc" }, select: { client: true, dr: true, institution: { select: { id: true, name: true, wilaya: true } } } }),
    prisma.pchVenteLigne.groupBy({ by: ["productId", "mois"], where, _sum: { qteLivree: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["productId", "mois"], where: { ...where, statut: "NON_SERVIE" }, _sum: { qteCommandee: true } }),
  ]);
  const mois = moisEntre(debut, fin);
  const nom = new Map(produits.map((p) => [p.id, p.nom]));
  const series = new Map<string, { productId: string; nom: string; livre: number[]; nonServi: number[] }>();
  const serie = (pid: string) => series.get(pid) ?? series.set(pid, { productId: pid, nom: nom.get(pid) ?? "", livre: mois.map(() => 0), nonServi: mois.map(() => 0) }).get(pid)!;
  for (const r of tout) serie(r.productId!).livre[mois.indexOf(moisDeDate(r.mois))] += n(r._sum.qteLivree);
  for (const r of ns) serie(r.productId!).nonServi[mois.indexOf(moisDeDate(r.mois))] += n(r._sum.qteCommandee);
  return { exemple, mois, series: [...series.values()].sort((a, b) => a.nom.localeCompare(b.nom)) };
}

// ─────────────────────────── Non servi ───────────────────────────

export async function matriceNonServi(periode: Bornes, buId?: string | null) {
  const produits = await produitsVentesPch(buId);
  const ids = produits.map((p) => p.id);
  const lignes = ids.length ? await demandeNonServie({ ...periode, productIds: ids }) : [];
  const drs = [...new Set(lignes.map((l) => l.dr))].sort();
  const parProduit = new Map<string, { productId: string; nom: string; bus: BuPch[]; total: number; etablissements: number; parDr: Record<string, { quantite: number; etablissements: number }> }>();
  const pDe = new Map(produits.map((p) => [p.id, p]));
  for (const l of lignes) {
    const p = pDe.get(l.productId);
    if (!p) continue;
    const x = parProduit.get(l.productId) ?? parProduit.set(l.productId, { productId: l.productId, nom: p.nom, bus: p.bus, total: 0, etablissements: 0, parDr: {} }).get(l.productId)!;
    x.total += l.quantite; x.etablissements += l.etablissements;
    x.parDr[l.dr] = { quantite: l.quantite, etablissements: l.etablissements };
  }
  return { drs, lignes: [...parProduit.values()].sort((a, b) => b.total - a.total) };
}

// ─────────────────────────── Fraîcheur ───────────────────────────

export interface FraicheurSource { source: string; libelle: string; dernier: string | null; manquants: string[] }

/** PAR SOURCE (chaque DR, les réceptions) : le dernier mois reçu, et les mois manquants jusqu'au dernier mois connu. */
export async function fraicheurPch(): Promise<{ sources: FraicheurSource[]; dernierMois: string | null }> {
  const [ventes, recus, drs] = await Promise.all([
    prisma.pchVenteLigne.groupBy({ by: ["dr", "mois"] }),
    prisma.pchReceptionLigne.groupBy({ by: ["mois"] }),
    directionsRegionales(),
  ]);
  const parSource = new Map<string, Set<string>>();
  for (const r of ventes) (parSource.get(r.dr) ?? parSource.set(r.dr, new Set()).get(r.dr)!).add(moisDeDate(r.mois));
  for (const d of drs) if (!parSource.has(d.code)) parSource.set(d.code, new Set());
  const recusMois = new Set(recus.map((r) => moisDeDate(r.mois)));
  const tousMois = [...parSource.values()].flatMap((s) => [...s]);
  const dernierVentes = tousMois.sort().at(-1) ?? null;
  const libDr = new Map(drs.map((d) => [d.code, d.libelle]));
  const sources: FraicheurSource[] = [...parSource.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dr, s]) => {
    const m = [...s].sort();
    return { source: dr, libelle: libDr.get(dr) ?? dr, dernier: m.at(-1) ?? null, manquants: m.length && dernierVentes ? moisManquants(s, m[0], dernierVentes) : [] };
  });
  const r = [...recusMois].sort();
  sources.push({ source: SOURCE_RECEPTIONS, libelle: "Réceptions PCH centrale", dernier: r.at(-1) ?? null, manquants: r.length ? moisManquants(recusMois, r[0], r.at(-1)!) : [] });
  const dernierMois = [dernierVentes, r.at(-1) ?? null].filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { sources, dernierMois };
}

// ─────────────────────────── Import : listes « à rattacher » ───────────────────────────

export async function importsPch(limit = 40) {
  return prisma.pchVenteImport.findMany({
    orderBy: { createdAt: "desc" }, take: limit,
    select: { id: true, nature: true, nomFichier: true, sources: true, mois: true, annuel: true, periodeAnnee: true, periodeMois: true, periodeChoisie: true, lignes: true, remplaceParId: true, createdAt: true, taille: true },
  });
}

export interface EtablissementARattacher { cle: string; client: string; drs: string[]; lignes: number; suggestions: { id: string; nom: string; wilaya: string | null }[] }

/** Les clients des DR qu'aucun établissement de l'annuaire ne désigne à coup sûr — les plus fréquents d'abord. */
export async function etablissementsARattacher(limit = 150): Promise<{ total: number; liste: EtablissementARattacher[] }> {
  const rows = await prisma.pchVenteLigne.groupBy({ by: ["clientCle", "client", "dr"], where: { institutionId: null }, _count: { _all: true } });
  const parCle = new Map<string, { cle: string; client: string; drs: Set<string>; lignes: number }>();
  for (const r of rows) {
    const x = parCle.get(r.clientCle) ?? parCle.set(r.clientCle, { cle: r.clientCle, client: r.client, drs: new Set(), lignes: 0 }).get(r.clientCle)!;
    x.drs.add(r.dr); x.lignes += r._count._all;
  }
  const tries = [...parCle.values()].sort((a, b) => b.lignes - a.lignes).slice(0, limit);
  const etabs = tries.length ? await prisma.medicalInstitution.findMany({ where: { isActive: true }, select: { id: true, name: true, wilaya: true } }) : [];
  const motsEtab = etabs.map((e) => ({ e, mots: new Set(motsDistinctifs(cleClient(e.name))) }));
  return {
    total: parCle.size,
    liste: tries.map((x) => {
      const mots = motsDistinctifs(x.cle).filter((w) => !["EPH", "EPSP", "EHS", "CHU", "EHU", "CAC", "CLINIQUE", "CABINET", "MEDICAL"].includes(w));
      const suggestions = mots.length
        ? motsEtab.map(({ e, mots: m }) => ({ e, score: mots.filter((w) => m.has(w)).length })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(({ e }) => ({ id: e.id, nom: e.name, wilaya: e.wilaya }))
        : [];
      return { cle: x.cle, client: x.client, drs: [...x.drs].sort(), lignes: x.lignes, suggestions };
    }),
  };
}

export interface PosteARattacher { poste: number; designation: string; statut: string; productId: string | null; produit: string | null; manuel: boolean; candidats: { id: string; nom: string }[] }

/** Les postes PCH de NOS molécules : ceux qui ne désignent aucun produit à coup sûr, et ceux rattachés (pour revoir). */
export async function postesNosMolecules(): Promise<PosteARattacher[]> {
  const produits = await prisma.product.findMany({ where: { isActive: true }, select: { id: true, canonicalName: true, dci: true } });
  const parMolecule = new Map<string, { id: string; nom: string }[]>();
  for (const p of produits) {
    const m = moleculeDe(p.dci);
    if (m) (parMolecule.get(m) ?? parMolecule.set(m, []).get(m)!).push({ id: p.id, nom: p.canonicalName });
  }
  const postes = await prisma.pchPoste.findMany({
    where: { OR: [{ productId: { not: null } }, { molecule: { in: [...parMolecule.keys()] } }] },
    orderBy: [{ molecule: "asc" }, { designation: "asc" }],
    select: { poste: true, designation: true, statut: true, productId: true, manuel: true, molecule: true, product: { select: { canonicalName: true } } },
  });
  return postes.map((p) => ({
    poste: p.poste, designation: p.designation, statut: p.statut, productId: p.productId, produit: p.product?.canonicalName ?? null, manuel: p.manuel,
    candidats: parMolecule.get(p.molecule ?? "") ?? [],
  }));
}

export interface FournisseursProduit { productId: string; nom: string; livreurs: { fournisseur: string; cle: string; qte: number; nous: boolean; origine: string | null }[] }

/** Par produit rattaché : les fournisseurs FO de ses postes (quantités reçues) et ceux qui sont « nous ». */
export async function fournisseursParProduit(): Promise<FournisseursProduit[]> {
  const [livreurs, reglages, produits] = await Promise.all([
    prisma.pchReceptionLigne.groupBy({ by: ["productId", "fournisseurCle", "fournisseur"], where: { productId: { not: null }, type: "FO" }, _sum: { qte: true } }),
    prisma.pchFournisseurProduit.findMany({ select: { productId: true, fournisseurCle: true, libelle: true, actif: true, origine: true } }),
    prisma.product.findMany({ where: { OR: [{ postesPch: { some: {} } }, { fournisseursPch: { some: {} } }] }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" } }),
  ]);
  return produits.map((p) => {
    const regle = new Map(reglages.filter((r) => r.productId === p.id).map((r) => [r.fournisseurCle, r]));
    const liste = new Map<string, FournisseursProduit["livreurs"][number]>();
    for (const l of livreurs.filter((x) => x.productId === p.id)) {
      const r = regle.get(l.fournisseurCle);
      liste.set(l.fournisseurCle, { fournisseur: l.fournisseur, cle: l.fournisseurCle, qte: n(l._sum.qte), nous: !!r?.actif, origine: r?.origine ?? null });
    }
    for (const r of regle.values()) if (!liste.has(r.fournisseurCle)) liste.set(r.fournisseurCle, { fournisseur: r.libelle, cle: r.fournisseurCle, qte: 0, nous: r.actif, origine: r.origine });
    return { productId: p.id, nom: p.canonicalName, livreurs: [...liste.values()].sort((a, b) => Number(b.nous) - Number(a.nous) || b.qte - a.qte) };
  });
}
