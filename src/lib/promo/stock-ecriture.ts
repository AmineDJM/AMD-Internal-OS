import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enSerie } from "@/lib/refs";
import {
  allouer, cleProduits, repartirReception, KINDS_ANNULABLES,
  type LotDisponible, type MovementKind, type Tranche,
} from "@/lib/promo/stock";
import { repartirRetour } from "@/lib/promo/reservations";
import { arrondirAuMillieme } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRIVAIN DU STOCK PROMOTIONNEL — le seul endroit où un solde change (§118.164).
 *
 * ── UN VERROU PAR ARTICLE ──────────────────────────────────────────────────────────────────
 *
 * Toute écriture qui touche les soldes d'un article commence par verrouiller SA ligne
 * (`SELECT … FOR UPDATE`), puis relit les soldes EN BASE, puis décide. Deux dotations lancées à la
 * même seconde sur les 300 dernières fiches passent donc l'une après l'autre : la seconde relit
 * un magasin vide et refuse. Sans verrou, chacune lisait « 300 », chacune sortait 300, et le
 * magasin affichait −300 — le défaut de l'écran d'avant, qui comptait en mémoire (§118.164).
 * Le verrou est par ARTICLE, pas global : deux dotations de deux articles différents ne
 * s'attendent pas.
 *
 * ── LE SOLDE SE CALCULE EN BASE ────────────────────────────────────────────────────────────
 *
 * Une somme SQL par lot et par détenteur — jamais une somme en mémoire sur une liste bornée :
 * l'écran d'avant additionnait les cent derniers mouvements, et devenait faux au cent-unième.
 *
 * ── RIEN NE SE SUPPRIME ────────────────────────────────────────────────────────────────────
 *
 * Une erreur se corrige par l'exact inverse (`REVERSAL`, avec `annuleId` unique : un mouvement ne
 * s'annule qu'une fois), un transfert refusé ou annulé par un retour à l'envoyeur. Un cliquet
 * (`stock-registre.test.ts`) refuse toute suppression de mouvement dans le code de production.
 *
 * Serveur seulement — ce module lit la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Tx = Prisma.TransactionClient;

export interface ArticleVerrouille {
  id: string;
  companyId: string | null;
  catalogueId: string;
  isActive: boolean;
}

const zero = (v: Prisma.Decimal | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * EXÉCUTER SOUS LE VERROU DE L'ARTICLE. Le délai est large (quinze secondes) parce qu'une
 * transaction qui attend un verrou attend la fin de l'AUTRE — sous charge, deux secondes ne
 * suffisent pas, et un refus pour délai dépassé ressemblerait à un stock insuffisant.
 */
export async function sousVerrou<T>(
  itemId: string,
  fn: (tx: Tx, article: ArticleVerrouille) => Promise<T>,
): Promise<T | { refus: string }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ArticleVerrouille[]>`
      SELECT "id", "companyId", "catalogueId", "isActive"
      FROM "PromoStockItem" WHERE "id" = ${itemId} FOR UPDATE`;
    const article = rows[0];
    if (!article) return { refus: "Article de stock introuvable." };
    return fn(tx, article);
  }, { timeout: 15_000, maxWait: 15_000 });
}

/**
 * EXÉCUTER SOUS LE VERROU DE PLUSIEURS ARTICLES (§118.166) — un rapport de visite remet souvent
 * trois ou quatre articles à la fois. Les lignes se verrouillent dans UN ordre (leur identifiant) :
 * deux rapports qui touchent les mêmes articles les prennent dans le même ordre, donc s'attendent
 * au lieu de s'interbloquer. Sans article, c'est une transaction ordinaire.
 *
 * Le refus d'un article manquant n'est pas un `{ refus }` ici : l'appelant a déjà vérifié chaque
 * article AVANT d'ouvrir la transaction, et un article supprimé entre-temps (un geste refusé dès
 * qu'il a servi) rend la liste verrouillée plus courte — `fn` le voit, et le dit.
 */
export async function sousVerrous<T>(
  itemIds: readonly string[],
  fn: (tx: Tx, verrouilles: ReadonlyMap<string, ArticleVerrouille>) => Promise<T>,
): Promise<T> {
  const ids = [...new Set(itemIds)].sort();
  return prisma.$transaction(async (tx) => {
    const rows = ids.length
      ? await tx.$queryRaw<ArticleVerrouille[]>`
          SELECT "id", "companyId", "catalogueId", "isActive"
          FROM "PromoStockItem" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`
      : [];
    return fn(tx, new Map(rows.map((r) => [r.id, r])));
  }, { timeout: 15_000, maxWait: 15_000 });
}

/** Les lots d'un article chez UN détenteur (`null` = le magasin), avec leur solde. */
export async function lotsDe(tx: Tx, itemId: string, holderId: string | null): Promise<LotDisponible[]> {
  const sommes = await tx.promoStockMovement.groupBy({
    by: ["lotId"],
    where: { itemId, holderId },
    _sum: { delta: true },
  });
  if (sommes.length === 0) return [];
  const lots = await tx.promoStockLot.findMany({
    where: { id: { in: sommes.map((s) => s.lotId) } },
    select: { id: true, numero: true, valableJusquau: true, recuLe: true },
  });
  const parId = new Map(lots.map((l) => [l.id, l]));
  return sommes.flatMap((s) => {
    const l = parId.get(s.lotId);
    return l ? [{ lotId: l.id, numero: l.numero, solde: arrondirAuMillieme(zero(s._sum.delta)), valableJusquau: l.valableJusquau, recuLe: l.recuLe }] : [];
  });
}

/** Le solde d'un détenteur, tous lots confondus. */
export async function soldeDe(tx: Tx, itemId: string, holderId: string | null): Promise<number> {
  const s = await tx.promoStockMovement.aggregate({ where: { itemId, holderId }, _sum: { delta: true } });
  return arrondirAuMillieme(zero(s._sum.delta));
}

async function prochainNumeroDeLot(tx: Tx, itemId: string): Promise<number> {
  const max = await tx.promoStockLot.aggregate({ where: { itemId }, _max: { numero: true } });
  return (max._max.numero ?? 0) + 1;
}

export interface EntreeLot {
  holderId: string | null;
  quantite: number;
  kind: Extract<MovementKind, "RECEIPT" | "OPENING" | "CORRECTION">;
  origine: "SAISIE" | "OUVERTURE" | "CORRECTION" | "ACHAT";
  coutUnitaire?: number | null;
  valableJusquau?: Date | null;
  libelle?: string | null;
  motif?: string | null;
  recuLe?: Date;
  auteurId: string;
  /** Le comptage dont cette entrée corrige l'écart (§118.168) — « retrouvé au comptage du … ». */
  comptageId?: string | null;
}

/** UNE ENTRÉE crée UN lot : la date, le coût et la fin de validité voyagent avec la quantité. */
export async function entrerLot(tx: Tx, itemId: string, e: EntreeLot): Promise<{ lotId: string; numero: number }> {
  const numero = await prochainNumeroDeLot(tx, itemId);
  const lot = await tx.promoStockLot.create({
    data: {
      itemId, numero, origine: e.origine,
      recuLe: e.recuLe ?? new Date(),
      coutUnitaire: e.coutUnitaire ?? null,
      valableJusquau: e.valableJusquau ?? null,
      libelle: e.libelle ?? null,
      createdById: e.auteurId,
    },
    select: { id: true, numero: true },
  });
  await tx.promoStockMovement.create({
    data: {
      itemId, lotId: lot.id, holderId: e.holderId, kind: e.kind, delta: arrondirAuMillieme(e.quantite),
      reason: e.motif ?? null, occurredAt: e.recuLe ?? new Date(), createdById: e.auteurId,
      comptageId: e.comptageId ?? null,
    },
  });
  return { lotId: lot.id, numero: lot.numero };
}

/**
 * UNE SORTIE SANS CONTREPARTIE (perte, correction à la baisse) : le lot qui expire le plus tôt
 * d'abord, périmés COMPRIS — c'est ainsi qu'on déclare un lot périmé détruit.
 */
export async function sortirSansContrepartie(tx: Tx, itemId: string, s: {
  holderId: string | null;
  quantite: number;
  kind: Extract<MovementKind, "LOSS" | "CORRECTION">;
  motif: string | null;
  auteurId: string;
  maintenant: Date;
  lotId?: string | null;
  /** Le comptage dont cette sortie corrige l'écart (§118.168). */
  comptageId?: string | null;
}): Promise<{ ok: true; tranches: Tranche[] } | { ok: false; refus: string }> {
  const lots = await lotsDe(tx, itemId, s.holderId);
  const cibles = s.lotId ? lots.filter((l) => l.lotId === s.lotId) : lots;
  if (s.lotId && cibles.length === 0) return { ok: false, refus: "Ce lot n'est pas dans ce stock." };
  const a = allouer(cibles, s.quantite, { maintenant: s.maintenant, inclurePerimes: true });
  if (!a.ok) return { ok: false, refus: a.raison };
  for (const t of a.tranches) {
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: t.lotId, holderId: s.holderId, kind: s.kind, delta: -t.quantite,
        reason: s.motif, createdById: s.auteurId, comptageId: s.comptageId ?? null,
      },
    });
  }
  return { ok: true, tranches: a.tranches };
}

/**
 * CORRIGER UN INVENTAIRE au nombre COMPTÉ. À la baisse : une sortie (lot le plus tôt périmé
 * d'abord). À la hausse : d'abord les lots NÉGATIFS (une anomalie héritée, qu'un comptage
 * referme), puis un lot neuf « retrouvé à l'inventaire » — on ne sait pas de quel lot viennent
 * des unités retrouvées, et le dire vaut mieux que les ranger au hasard dans un lot existant.
 */
export async function corrigerAuCompte(tx: Tx, itemId: string, c: {
  holderId: string | null;
  compte: number;
  motif: string | null;
  auteurId: string;
  maintenant: Date;
  /** Le comptage qui a produit ce nombre (§118.168) : chaque correction le porte. */
  comptageId?: string | null;
}): Promise<{ ok: true; avant: number; apres: number } | { ok: false; refus: string }> {
  const avant = await soldeDe(tx, itemId, c.holderId);
  const delta = arrondirAuMillieme(c.compte - avant);
  if (delta === 0) return { ok: false, refus: `Le solde enregistré est déjà ${avant} : rien à corriger.` };
  const comptageId = c.comptageId ?? null;
  if (delta < 0) {
    const s = await sortirSansContrepartie(tx, itemId, {
      holderId: c.holderId, quantite: -delta, kind: "CORRECTION", motif: c.motif, auteurId: c.auteurId, maintenant: c.maintenant,
      comptageId,
    });
    if (!s.ok) return s;
    return { ok: true, avant, apres: c.compte };
  }
  let reste = delta;
  const negatifs = (await lotsDe(tx, itemId, c.holderId)).filter((l) => l.solde < 0);
  for (const l of negatifs) {
    if (reste <= 0) break;
    const comble = arrondirAuMillieme(Math.min(-l.solde, reste));
    await tx.promoStockMovement.create({
      data: { itemId, lotId: l.lotId, holderId: c.holderId, kind: "CORRECTION", delta: comble, reason: c.motif, createdById: c.auteurId, comptageId },
    });
    reste = arrondirAuMillieme(reste - comble);
  }
  if (reste > 0) {
    await entrerLot(tx, itemId, {
      holderId: c.holderId, quantite: reste, kind: "CORRECTION", origine: "CORRECTION",
      libelle: comptageId ? "Retrouvé au comptage" : "Retrouvé à l'inventaire", motif: c.motif, auteurId: c.auteurId, comptageId,
    });
  }
  return { ok: true, avant, apres: c.compte };
}

/**
 * FAIRE PARTIR UN TRANSFERT : la quantité quitte celui qui donne, lot par lot (le plus tôt
 * périmé d'abord, jamais un lot périmé), et reste « en route » jusqu'à ce que celui qui reçoit
 * confirme. Rien n'arrive chez lui avant sa confirmation.
 */
export async function fairePartir(tx: Tx, itemId: string, t: {
  nature: "DOTATION" | "TRANSFERT" | "RETOUR";
  deId: string | null;
  versId: string | null;
  quantite: number;
  note: string | null;
  initiateurId: string;
  demandeId?: string | null;
  maintenant: Date;
}): Promise<{ ok: true; transfertId: string; tranches: Tranche[] } | { ok: false; refus: string }> {
  const lots = await lotsDe(tx, itemId, t.deId);
  const a = allouer(lots, t.quantite, { maintenant: t.maintenant, inclurePerimes: false });
  if (!a.ok) return { ok: false, refus: a.raison };
  const transfert = await tx.promoStockTransfer.create({
    data: {
      itemId, nature: t.nature, deId: t.deId, versId: t.versId, quantite: arrondirAuMillieme(t.quantite),
      note: t.note, initiateurId: t.initiateurId, demandeId: t.demandeId ?? null,
    },
    select: { id: true },
  });
  for (const tr of a.tranches) {
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: tr.lotId, holderId: t.deId, kind: "TRANSFER_OUT", delta: -tr.quantite,
        transferId: transfert.id, reason: t.note, createdById: t.initiateurId,
      },
    });
  }
  return { ok: true, transfertId: transfert.id, tranches: a.tranches };
}

/** Les tranches parties d'un transfert, dans l'ordre de sortie (le plus tôt périmé d'abord). */
async function tranchesParties(tx: Tx, transfertId: string): Promise<Tranche[]> {
  const departs = await tx.promoStockMovement.findMany({
    where: { transferId: transfertId, kind: "TRANSFER_OUT" },
    select: { lotId: true, delta: true, lot: { select: { valableJusquau: true, recuLe: true, numero: true } } },
  });
  return departs
    .map((d) => ({ lotId: d.lotId, quantite: arrondirAuMillieme(-zero(d.delta)), lot: d.lot }))
    .sort((a, b) => {
      const ea = a.lot.valableJusquau?.getTime() ?? Number.POSITIVE_INFINITY;
      const eb = b.lot.valableJusquau?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
      if (a.lot.recuLe.getTime() !== b.lot.recuLe.getTime()) return a.lot.recuLe.getTime() - b.lot.recuLe.getTime();
      return a.lot.numero - b.lot.numero;
    })
    .map(({ lotId, quantite }) => ({ lotId, quantite }));
}

/**
 * CONFIRMER UNE RÉCEPTION — en tout ou en partie. Ce qui est reçu entre chez le destinataire,
 * lot par lot ; ce qui manque n'est chez personne et le transfert le DIT (`quantiteRecue`).
 * Aucune écriture « manquant » chez l'envoyeur : il l'a déjà remis, et le lui retirer une seconde
 * fois compterait la perte deux fois.
 */
export async function confirmerArrivee(tx: Tx, transfertId: string, c: {
  versId: string | null;
  quantiteRecue: number;
  auteurId: string;
  note: string | null;
}): Promise<{ recue: number; manquante: number }> {
  const parties = await tranchesParties(tx, transfertId);
  const { recues, manquantes } = repartirReception(parties, c.quantiteRecue);
  const premiere = await tx.promoStockTransfer.findUnique({ where: { id: transfertId }, select: { itemId: true } });
  for (const t of recues) {
    await tx.promoStockMovement.create({
      data: {
        itemId: premiere!.itemId, lotId: t.lotId, holderId: c.versId, kind: "TRANSFER_IN", delta: t.quantite,
        transferId: transfertId, reason: c.note, createdById: c.auteurId,
      },
    });
  }
  const recue = arrondirAuMillieme(recues.reduce((a, t) => a + t.quantite, 0));
  const manquante = arrondirAuMillieme(manquantes.reduce((a, t) => a + t.quantite, 0));
  await tx.promoStockTransfer.update({
    where: { id: transfertId },
    data: { statut: "RECU", quantiteRecue: recue, decideParId: c.auteurId, decideLe: new Date(), noteDecision: c.note },
  });
  return { recue, manquante };
}

/** RENVOYER À L'ENVOYEUR (refus ou annulation) : chaque tranche partie revient, au même lot. */
export async function renvoyer(tx: Tx, transfertId: string, r: {
  statut: "REFUSE" | "ANNULE";
  deId: string | null;
  auteurId: string;
  note: string | null;
}): Promise<void> {
  const parties = await tranchesParties(tx, transfertId);
  const tr = await tx.promoStockTransfer.findUnique({ where: { id: transfertId }, select: { itemId: true } });
  for (const t of parties) {
    await tx.promoStockMovement.create({
      data: {
        itemId: tr!.itemId, lotId: t.lotId, holderId: r.deId, kind: "TRANSFER_BACK", delta: t.quantite,
        transferId: transfertId, reason: r.note, createdById: r.auteurId,
      },
    });
  }
  await tx.promoStockTransfer.update({
    where: { id: transfertId },
    data: { statut: r.statut, decideParId: r.auteurId, decideLe: new Date(), noteDecision: r.note },
  });
}

/**
 * REMETTRE À UN MÉDECIN, lors d'une visite (§118.166) : la quantité sort du stock de celui qui a
 * fait la visite, lot par lot — le plus tôt périmé d'abord, JAMAIS un lot périmé (un échantillon
 * périmé ne se remet pas, il se déclare détruit). Chaque tranche porte la visite et le médecin :
 * c'est ce qui fait l'historique « ce que ce médecin a reçu », et ce qu'une correction contre-passe.
 * L'appelant tient le verrou de l'article.
 *
 * L'ANCRE est la visite, ou — pour un compte rendu de visite (rapport terrain) qu'aucune visite ne
 * porte — le rapport lui-même (§118.204). Jamais les deux : c'est l'ancre qu'une correction relit.
 */
export type AncreRemise = { visitId: string } | { fieldReportId: string };

export async function remettreAuMedecin(tx: Tx, itemId: string, r: {
  holderId: string;
  quantite: number;
  ancre: AncreRemise;
  doctorId: string | null;
  motif: string | null;
  auteurId: string;
  maintenant: Date;
}): Promise<{ ok: true; tranches: Tranche[] } | { ok: false; refus: string }> {
  const lots = await lotsDe(tx, itemId, r.holderId);
  const a = allouer(lots, r.quantite, { maintenant: r.maintenant, inclurePerimes: false });
  if (!a.ok) return { ok: false, refus: a.raison };
  for (const t of a.tranches) {
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: t.lotId, holderId: r.holderId, kind: "DISTRIBUTION", delta: -t.quantite,
        ...r.ancre, doctorId: r.doctorId, reason: r.motif, occurredAt: r.maintenant, createdById: r.auteurId,
      },
    });
  }
  return { ok: true, tranches: a.tranches };
}

/**
 * REPRENDRE CE QU'UNE VISITE A REMIS d'un article — chaque remise encore active reçoit son exact
 * inverse (`REVERSAL`, même lot, même détenteur, même visite, `annuleId` unique). C'est ainsi
 * qu'un rapport corrigé dans sa fenêtre rend le stock juste sans rien supprimer : l'historique du
 * médecin garde la trace de la remise ET de sa correction. Rend la quantité reprise.
 * L'appelant tient le verrou de l'article.
 */
export async function reprendreRemisesDeLaVisite(tx: Tx, ancre: AncreRemise, itemId: string, auteurId: string, motif: string | null):
  Promise<number> {
  const actives = await tx.promoStockMovement.findMany({
    where: { ...ancre, itemId, kind: "DISTRIBUTION", annulation: { is: null } },
    select: { id: true, lotId: true, holderId: true, delta: true, doctorId: true },
  });
  let reprise = 0;
  for (const m of actives) {
    const inverse = arrondirAuMillieme(-zero(m.delta));
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: m.lotId, holderId: m.holderId, kind: "REVERSAL", delta: inverse,
        annuleId: m.id, ...ancre, doctorId: m.doctorId, reason: motif, createdById: auteurId,
      },
    });
    reprise = arrondirAuMillieme(reprise + inverse);
  }
  return reprise;
}

/**
 * RÉSERVER POUR UN ÉVÉNEMENT AD & PRO (§118.167) : la quantité quitte le MAGASIN, lot par lot (le
 * plus tôt périmé d'abord, jamais un lot périmé — on n'expose pas sur un stand une brochure dont la
 * validité est passée). Chaque tranche porte la ligne du poste : c'est ce qui permet de faire revenir
 * le reste dans ses lots, et de dire à l'écran où est passé ce que le magasin n'a plus.
 * L'appelant tient le verrou de l'article.
 */
export async function reserverPourEvenement(tx: Tx, itemId: string, r: {
  ligneId: string;
  quantite: number;
  motif: string | null;
  auteurId: string;
  maintenant: Date;
}): Promise<{ ok: true; tranches: Tranche[] } | { ok: false; refus: string }> {
  const lots = await lotsDe(tx, itemId, null);
  const a = allouer(lots, r.quantite, { maintenant: r.maintenant, inclurePerimes: false });
  if (!a.ok) return { ok: false, refus: a.raison };
  for (const t of a.tranches) {
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: t.lotId, holderId: null, kind: "RESERVATION_OUT", delta: -t.quantite,
        adProLineId: r.ligneId, reason: r.motif, occurredAt: r.maintenant, createdById: r.auteurId,
      },
    });
  }
  return { ok: true, tranches: a.tranches };
}

/**
 * CE QUI REVIENT AU MAGASIN d'une réservation — dans les lots d'où c'est sorti, le plus tard
 * périmé d'abord (ce qui a été remis pendant l'événement, ce sont les unités qui expiraient le
 * plus tôt). Ne rend jamais plus que ce que la ligne a fait sortir, net de ce qui est déjà revenu.
 * L'appelant tient le verrou de l'article. Rend la quantité effectivement revenue.
 */
export async function rendreAuMagasin(tx: Tx, itemId: string, r: {
  ligneId: string;
  quantite: number;
  motif: string | null;
  auteurId: string;
}): Promise<number> {
  if (!(r.quantite > 0)) return 0;
  const ms = await tx.promoStockMovement.findMany({
    where: { adProLineId: r.ligneId, kind: { in: ["RESERVATION_OUT", "RESERVATION_BACK"] } },
    select: { lotId: true, delta: true, lot: { select: { valableJusquau: true, recuLe: true, numero: true } } },
  });
  const parLot = new Map<string, { quantite: number; lot: { valableJusquau: Date | null; recuLe: Date; numero: number } }>();
  for (const m of ms) {
    const e = parLot.get(m.lotId) ?? { quantite: 0, lot: m.lot };
    e.quantite = arrondirAuMillieme(e.quantite - zero(m.delta));
    parLot.set(m.lotId, e);
  }
  const tranches = [...parLot].filter(([, e]) => e.quantite > 0)
    .map(([lotId, e]) => ({ lotId, quantite: e.quantite, valableJusquau: e.lot.valableJusquau, recuLe: e.lot.recuLe, numero: e.lot.numero }));
  let rendu = 0;
  for (const t of repartirRetour(tranches, r.quantite)) {
    await tx.promoStockMovement.create({
      data: {
        itemId, lotId: t.lotId, holderId: null, kind: "RESERVATION_BACK", delta: t.quantite,
        adProLineId: r.ligneId, reason: r.motif, createdById: r.auteurId,
      },
    });
    rendu = arrondirAuMillieme(rendu + t.quantite);
  }
  return rendu;
}

/** Le refus d'une annulation sans motif — une phrase, lue par l'écran et par les bancs. */
export const MOTIF_ANNULATION_MOUVEMENT = "Dites pourquoi ce mouvement est annulé : son inverse reste écrit pour toujours, avec ce motif.";

/**
 * ANNULER UN MOUVEMENT — son exact inverse, au même lot et chez le même détenteur. Refusé si
 * l'inverse creusait un solde sous zéro : annuler l'entrée de 500 fiches dont 300 sont déjà
 * parties chez des délégués laisserait le magasin à −300. Le refus le dit.
 */
export async function annulerMouvementEcrit(tx: Tx, mouvementId: string, auteurId: string, motif: string | null):
  Promise<{ ok: true; delta: number } | { ok: false; refus: string }> {
  const m = await tx.promoStockMovement.findUnique({
    where: { id: mouvementId },
    select: { id: true, itemId: true, lotId: true, holderId: true, kind: true, delta: true, annulation: { select: { id: true } } },
  });
  if (!m) return { ok: false, refus: "Mouvement introuvable." };
  if (m.annulation) return { ok: false, refus: "Ce mouvement est déjà annulé." };
  if (!KINDS_ANNULABLES.includes(m.kind as MovementKind)) {
    return {
      ok: false,
      refus: m.kind.startsWith("TRANSFER")
        ? "Un transfert ne s'annule pas ligne par ligne : annulez-le tant qu'il est en route, ou faites rendre le matériel."
        : m.kind === "DISTRIBUTION"
          // Une remise annulée ici laisserait le rapport de visite dire « 20 fiches remises » sur
          // un stock qui ne les a plus retirées : deux vérités sur la même remise (§118.166).
          ? "Une remise à un médecin se corrige depuis le rapport de sa visite, dans les 48 h — c'est ce qui garde le rapport et le stock d'accord. Au-delà, par un comptage du stock du délégué."
          : m.kind.startsWith("RESERVATION")
            // Même raison pour une réservation d'événement : c'est le POSTE qui la porte (§118.167).
            ? "Une réservation d'événement se gère depuis le poste « Matériel du stock » de sa demande Ad & Pro : on y confirme ce qui a été remis, et le reste revient."
            : "Ce mouvement ne s'annule pas : refaites la saisie juste.",
    };
  }
  const inverse = arrondirAuMillieme(-zero(m.delta));
  if (inverse < 0) {
    const lots = await lotsDe(tx, m.itemId, m.holderId);
    const solde = lots.find((l) => l.lotId === m.lotId)?.solde ?? 0;
    if (solde + inverse < 0) {
      return {
        ok: false,
        refus: `Annuler ce mouvement creuserait le lot sous zéro (il en reste ${solde} ici, l'annulation en retirerait ${-inverse}) : une partie est déjà sortie. Faites revenir le matériel ou corrigez l'inventaire.`,
      };
    }
  }
  // UN GESTE DÉFINITIF DIT POURQUOI (audit 360°, R17) — et seulement quand il est POSSIBLE : le motif
  // est exigé APRÈS les refus ci-dessus. Le demander d'abord ferait écrire un motif pour un mouvement
  // déjà annulé, une réservation ou une remise de visite, puis apprendre qu'aucun ne s'annule d'ici
  // (§118.18). Exigé ICI, chez l'écrivain unique, il vaut pour chaque porte qui annule (§118.106).
  if (!motif?.trim()) return { ok: false, refus: MOTIF_ANNULATION_MOUVEMENT };
  await tx.promoStockMovement.create({
    data: {
      itemId: m.itemId, lotId: m.lotId, holderId: m.holderId, kind: "REVERSAL", delta: inverse,
      annuleId: m.id, reason: motif, createdById: auteurId,
    },
  });
  return { ok: true, delta: inverse };
}

/**
 * TROUVER OU CRÉER l'article de stock (société, article du catalogue, produits). L'unicité est
 * tenue par la BASE (index d'expression) ; la file `enSerie` évite la course dans ce processus, et
 * une collision venue d'ailleurs se relit au lieu d'échouer.
 */
export async function trouverOuCreerArticle(a: {
  companyId: string | null;
  catalogueId: string;
  produitIds: readonly string[];
  nom: string;
  unite: string;
  materialType: string | null;
  auteurId: string;
}): Promise<{ id: string; cree: boolean }> {
  const produitsCle = cleProduits(a.produitIds);
  const ids = produitsCle ? produitsCle.split(",") : [];
  const where = { companyId: a.companyId, catalogueId: a.catalogueId, produitsCle };
  return enSerie(`promo-stock:${a.companyId ?? "-"}:${a.catalogueId}:${produitsCle}`, async () => {
    const existant = await prisma.promoStockItem.findFirst({ where, select: { id: true } });
    if (existant) return { id: existant.id, cree: false };
    try {
      const cree = await prisma.promoStockItem.create({
        data: {
          companyId: a.companyId, catalogueId: a.catalogueId, produitsCle, name: a.nom, unit: a.unite,
          materialType: (a.materialType as never) ?? null, createdById: a.auteurId, updatedById: a.auteurId,
          produits: { create: ids.map((productId) => ({ productId })) },
        },
        select: { id: true },
      });
      return { id: cree.id, cree: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const relu = await prisma.promoStockItem.findFirst({ where, select: { id: true } });
        if (relu) return { id: relu.id, cree: false };
      }
      throw e;
    }
  });
}
