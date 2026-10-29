import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scopeMedicalVisits, type SessionUser } from "@/lib/rbac";
import { chargerStrategie, chargerPanel } from "@/lib/segmentation/service";
import { CHEMIN_DEMANDE, LIBELLE_NATURE_DEMANDE, type TypeMedecinsConcernes } from "@/modules/ad-pro/partage";
import { ecoulementMensuel, cleMois } from "@/lib/products/fiche-360";
import { toNumber } from "@/lib/utils";
import {
  fenetreCycle, lettreDuProduit, mouvementLettres,
  type FenetreCycle, type Lettre360, type MouvementLettres,
} from "@/lib/products/sante";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRODUITS 360 — LES LECTURES DU TERRAIN, DES PRESCRIPTEURS, DE L'AD & PRO ET DES LOTS (Direction, 10/2026).
 *
 * Façade (`queries/`) : elle traverse la segmentation, la Promotion médicale, la force de vente, l'Ad & Pro et la PCH.
 * Elle ne décide d'AUCUN droit : l'appelant (`queries/produits-360.ts`) ne l'appelle que pour les modules que la
 * personne voit (`vues-360-acces.ts`). Chaque lecture vaut pour PLUSIEURS produits à la fois : la liste et la fiche
 * lisent la même chose, la liste pour tous ses produits d'un coup.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : toNumber(v as never));
const JOUR = 86_400_000;

// ─────────────────────────── Segmentation : cibles, lettres, mouvement ───────────────────────────

export interface Praticien360 {
  doctorId: string;
  nom: string;
  wilaya: string | null;
  etablissement: string | null;
  lettre: Lettre360;
  /** Le segment du PRODUIT (A–D, EN_ATTENTE, NON_CIBLE). */
  segment: string | null;
  h: boolean;
  cible: boolean;
  /** Visites requises par cycle. */
  requis: number;
  /** Visites terminées dans la fenêtre du cycle (toutes visites du praticien, la règle des cycles de segmentation). */
  vus: number;
}

export interface Segmentation360 {
  strategies: { id: string; nom: string }[];
  fenetre: FenetreCycle;
  praticiens: Praticien360[];
  /** Depuis l'instantané du dernier cycle ouvert — `null` sans cycle qui classe ce produit. */
  mouvement: MouvementLettres | null;
  cycleComparaison: string | null;
}

interface InstantaneLu { produits?: { productId: string }[]; praticiens?: { doctorId: string; affichage?: string }[] }

/** La segmentation de chaque produit, dans chaque stratégie ACTIVE qui le classe — le même moteur que le Studio. */
export async function segmentation360(productIds: readonly string[], maintenant: Date): Promise<Map<string, Segmentation360>> {
  const out = new Map<string, Segmentation360>();
  if (!productIds.length) return out;
  const liens = await prisma.segmentationStrategieProduit.findMany({
    where: { productId: { in: [...productIds] }, jusqua: null, strategie: { statut: "ACTIVE" } },
    select: { strategieId: true, productId: true },
  });
  const parStrategie = new Map<string, Set<string>>();
  for (const l of liens) (parStrategie.get(l.strategieId) ?? parStrategie.set(l.strategieId, new Set()).get(l.strategieId)!).add(l.productId);
  const debutJour = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()));

  for (const [strategieId, produits] of parStrategie) {
    const s = await chargerStrategie(strategieId);
    if (!s?.regle?.regles) continue;
    const [panel, ouvert, dernier] = await Promise.all([
      chargerPanel(s),
      prisma.segmentationCycle.findFirst({ where: { strategieId, statut: "OUVERT", debut: { lte: maintenant }, fin: { gte: debutJour } }, orderBy: { debut: "desc" }, select: { debut: true, fin: true } }),
      prisma.segmentationCycle.findFirst({ where: { strategieId, debut: { lte: maintenant } }, orderBy: { debut: "desc" }, select: { libelle: true, instantane: true } }),
    ]);
    const fenetre = fenetreCycle(maintenant, ouvert);
    const ids = panel.map((p) => p.doctorId);
    const vus = ids.length
      ? new Map((await prisma.medicalVisit.groupBy({
          by: ["doctorId"], where: { status: "COMPLETED", date: { gte: fenetre.debut, lt: fenetre.finExclue }, doctorId: { in: ids } }, _count: { _all: true },
        })).filter((g) => g.doctorId).map((g) => [g.doctorId!, g._count._all]))
      : new Map<string, number>();
    const inst = (dernier?.instantane ?? null) as InstantaneLu | null;

    for (const productId of produits) {
      const praticiens: Praticien360[] = [];
      const apres = new Map<string, string>();
      for (const p of panel) {
        const r = p.resultat;
        if (!r) continue;
        const rp = r.produits.find((x) => x.productId === productId);
        praticiens.push({
          doctorId: p.doctorId, nom: p.nom, wilaya: p.wilaya, etablissement: p.etablissement,
          lettre: lettreDuProduit({ cible: r.cible, h: r.h, etat: rp?.etat }), segment: rp?.etat ?? null,
          h: r.h, cible: r.cible, requis: r.cible ? r.visites : 0, vus: vus.get(p.doctorId) ?? 0,
        });
        if (rp) apres.set(p.doctorId, rp.etat === "NON_CIBLE" ? "NC" : rp.etat === "EN_ATTENTE" ? "?" : rp.etat);
      }
      let mouvement: MouvementLettres | null = null;
      const idx = inst?.produits?.findIndex((x) => x.productId === productId) ?? -1;
      if (inst && idx >= 0) {
        const avant = new Map((inst.praticiens ?? []).map((x) => [x.doctorId, (x.affichage ?? "").split("/")[idx]?.trim() ?? ""] as const).filter(([, l]) => l));
        mouvement = mouvementLettres(avant, apres);
      }
      const deja = out.get(productId);
      if (!deja) {
        out.set(productId, { strategies: [{ id: s.id, nom: s.nom }], fenetre, praticiens, mouvement, cycleComparaison: mouvement ? dernier?.libelle ?? null : null });
      } else {
        // Un produit classé par deux stratégies : un praticien compte une fois, les mouvements s'additionnent.
        const connus = new Set(deja.praticiens.map((x) => x.doctorId));
        deja.praticiens.push(...praticiens.filter((x) => !connus.has(x.doctorId)));
        deja.strategies.push({ id: s.id, nom: s.nom });
        if (mouvement) deja.mouvement = deja.mouvement
          ? { bVersA: deja.mouvement.bVersA + mouvement.bVersA, aPerdus: deja.mouvement.aPerdus + mouvement.aPerdus, net: deja.mouvement.net + mouvement.net }
          : mouvement;
      }
    }
  }
  return out;
}

// ─────────────────────────── Visites et messages (Promotion médicale) ───────────────────────────

export interface Visite360 {
  visitId: string; productId: string; date: Date; delegateId: string | null; delegue: string | null;
  doctorId: string | null; medecin: string | null; rapport: string | null;
}

/** Les visites TERMINÉES où le produit a été présenté, depuis `depuis`, dans la portée Promotion médicale de la personne. */
export async function visitesDesProduits(user: SessionUser, productIds: readonly string[], depuis: Date, opts: { detail?: boolean } = {}): Promise<Visite360[]> {
  if (!productIds.length) return [];
  const rows = await prisma.medicalVisitProduct.findMany({
    where: { productId: { in: [...productIds] }, visit: { AND: [scopeMedicalVisits(user), { status: "COMPLETED", date: { gte: depuis } }] } },
    select: {
      productId: true,
      visit: { select: { id: true, date: true, delegateId: true, doctorId: true, report: opts.detail ?? false, doctor: opts.detail ? { select: { name: true } } : false, delegate: opts.detail ? { select: { name: true } } : false } },
    },
    take: 20_000,
  });
  return rows.map((r) => {
    const v = r.visit as typeof r.visit & { report?: string | null; doctor?: { name: string } | null; delegate?: { name: string | null } | null };
    return {
      visitId: v.id, productId: r.productId, date: v.date, delegateId: v.delegateId, delegue: v.delegate?.name ?? null,
      doctorId: v.doctorId, medecin: v.doctor?.name ?? null, rapport: v.report ?? null,
    };
  });
}

export interface Message360 { messageId: string; productId: string; titre: string; actif: boolean; date: Date; delegateId: string | null }

/** Les messages pré-définis du produit retenus en visite depuis `depuis` (portée Promotion médicale). */
export async function messagesPortes(user: SessionUser, productIds: readonly string[], depuis: Date): Promise<Message360[]> {
  if (!productIds.length) return [];
  const rows = await prisma.medicalVisitMessage.findMany({
    where: { message: { productId: { in: [...productIds] } }, visit: { AND: [scopeMedicalVisits(user), { date: { gte: depuis } }] } },
    select: { messageId: true, message: { select: { productId: true, title: true, isActive: true } }, visit: { select: { date: true, delegateId: true } } },
    take: 20_000,
  });
  return rows.map((r) => ({ messageId: r.messageId, productId: r.message.productId!, titre: r.message.title, actif: r.message.isActive, date: r.visit.date, delegateId: r.visit.delegateId }));
}

// ─────────────────────────── Force de vente : qui porte le produit ce mois ───────────────────────────

export interface Priorite360 { productId: string; repId: string; nom: string; position: number }

/** Les affectations du cycle promotionnel du mois (P1 / P2 / P3), par produit canonique. */
export async function prioritesDuMois(productIds: readonly string[], maintenant: Date): Promise<Priorite360[]> {
  if (!productIds.length) return [];
  const rows = await prisma.promotionAssignment.findMany({
    where: { cycle: { year: maintenant.getUTCFullYear(), month: maintenant.getUTCMonth() + 1 }, product: { productId: { in: [...productIds] } } },
    select: { repId: true, position: true, product: { select: { productId: true } } },
  });
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.repId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name ?? "—"]));
  // Un KAM porte un produit une fois : s'il l'a par deux produits de BU, la meilleure priorité l'emporte.
  const meilleur = new Map<string, Priorite360>();
  for (const r of rows) {
    if (!r.product.productId) continue;
    const k = `${r.product.productId}|${r.repId}`;
    const cur = meilleur.get(k);
    if (!cur || r.position < cur.position) meilleur.set(k, { productId: r.product.productId, repId: r.repId, nom: noms.get(r.repId) ?? "—", position: r.position });
  }
  return [...meilleur.values()];
}

// ─────────────────────────── Ad & Pro : les actions de 12 mois et les médecins touchés ───────────────────────────

export interface ActionAdPro360 {
  cle: string;
  nature: TypeMedecinsConcernes | "TRAINING" | null;
  libelle: string;
  href: string | null;
  date: Date;
  montant: number;
  postes: number;
  doctorIds: string[];
}

export interface AdPro360 { montant: number; actions: ActionAdPro360[]; postesSansMontant: number }

/**
 * L'AD & PRO IMPUTÉ à chaque produit sur 12 mois, regroupé par ACTION (le sponsoring, le congrès, l'événement qui porte
 * les postes). Montant d'un poste : le montant imputé saisi, sinon la part × le montant ACCORDÉ — jamais une estimation
 * (`queries/product-360.ts`). Médecins touchés : ceux reliés à l'action (`AdProMedecin`) et les invités d'un congrès.
 */
export async function adProDesProduits(productIds: readonly string[], depuis: Date): Promise<Map<string, AdPro360>> {
  const out = new Map<string, AdPro360>();
  if (!productIds.length) return out;
  const allocs = await prisma.adProProductAllocation.findMany({
    where: { productId: { in: [...productIds] }, item: { createdAt: { gte: depuis }, status: { not: "REJECTED" } } },
    select: {
      productId: true, sharePct: true, amountAllocated: true,
      item: {
        select: {
          id: true, label: true, createdAt: true, amountGranted: true,
          sponsoring: { select: { id: true, reference: true, institution: true, requestDate: true } },
          congressNational: { select: { id: true, name: true, date: true, invitedDoctorIds: true } },
          congressInternational: { select: { id: true, name: true, startDate: true, invitedDoctorIds: true } },
          event: { select: { id: true, name: true, startDate: true } },
          training: { select: { id: true } },
        },
      },
    },
  });
  const parents: { type: TypeMedecinsConcernes; id: string }[] = [];
  for (const a of allocs) {
    const it = a.item;
    if (it.sponsoring) parents.push({ type: "SPONSORING", id: it.sponsoring.id });
    else if (it.congressNational) parents.push({ type: "CONGRESS_NATIONAL", id: it.congressNational.id });
    else if (it.congressInternational) parents.push({ type: "CONGRESS_INTERNATIONAL", id: it.congressInternational.id });
    else if (it.event) parents.push({ type: "EVENT", id: it.event.id });
  }
  const liens = parents.length
    ? await prisma.adProMedecin.findMany({ where: { OR: parents.map((p) => ({ entityType: p.type, entityId: p.id })) }, select: { entityType: true, entityId: true, doctorId: true } })
    : [];
  const medecinsDe = new Map<string, Set<string>>();
  for (const l of liens) (medecinsDe.get(`${l.entityType}:${l.entityId}`) ?? medecinsDe.set(`${l.entityType}:${l.entityId}`, new Set()).get(`${l.entityType}:${l.entityId}`)!).add(l.doctorId);

  for (const a of allocs) {
    const it = a.item;
    const montant = a.amountAllocated !== null ? num(a.amountAllocated) : a.sharePct !== null && it.amountGranted !== null ? Math.round(num(it.amountGranted) * num(a.sharePct) / 100) : null;
    let nature: ActionAdPro360["nature"] = null; let id = it.id; let libelle = it.label; let date = it.createdAt; let invites: string[] = [];
    if (it.sponsoring) { nature = "SPONSORING"; id = it.sponsoring.id; libelle = `Sponsoring ${it.sponsoring.institution}`.trim(); date = it.sponsoring.requestDate; }
    else if (it.congressNational) { nature = "CONGRESS_NATIONAL"; id = it.congressNational.id; libelle = it.congressNational.name; date = it.congressNational.date ?? it.createdAt; invites = it.congressNational.invitedDoctorIds; }
    else if (it.congressInternational) { nature = "CONGRESS_INTERNATIONAL"; id = it.congressInternational.id; libelle = it.congressInternational.name; date = it.congressInternational.startDate ?? it.createdAt; invites = it.congressInternational.invitedDoctorIds; }
    else if (it.event) { nature = "EVENT"; id = it.event.id; libelle = it.event.name; date = it.event.startDate ?? it.createdAt; }
    else if (it.training) { nature = "TRAINING"; id = it.training.id; libelle = `Formation · ${it.label}`; }
    const p = out.get(a.productId) ?? out.set(a.productId, { montant: 0, actions: [], postesSansMontant: 0 }).get(a.productId)!;
    if (montant === null) p.postesSansMontant++;
    const cle = `${nature ?? "ITEM"}:${id}`;
    let action = p.actions.find((x) => x.cle === cle);
    if (!action) {
      const medecins = nature && nature !== "TRAINING" ? [...(medecinsDe.get(`${nature}:${id}`) ?? [])] : [];
      action = {
        cle, nature, libelle, date, montant: 0, postes: 0,
        href: nature && nature !== "TRAINING" ? `${CHEMIN_DEMANDE[nature]}/${id}` : null,
        doctorIds: [...new Set([...medecins, ...invites])],
      };
      p.actions.push(action);
    }
    action.postes++;
    action.montant += montant ?? 0;
    p.montant += montant ?? 0;
  }
  for (const p of out.values()) p.actions.sort((a, b) => b.date.getTime() - a.date.getTime());
  return out;
}

export const libelleNatureAdPro = (n: ActionAdPro360["nature"]): string => (n === "TRAINING" ? "Formation" : n ? LIBELLE_NATURE_DEMANDE[n] : "Poste");

// ─────────────────────────── Les lots qui périment (livraisons PCH) ───────────────────────────

export interface Lot360 { productId: string; lot: string | null; peremption: Date; quantite: number; unite: "boîtes" | "unités"; livreLe: Date | null }

/**
 * LES LOTS LIVRÉS QUI PÉRIMENT dans les `jours` à venir — lus sur les bons de livraison de la PCH (lot et péremption,
 * quand le BL les donne), rattachés au produit par la ligne de contrat (produit canonique) ou la ligne d'AO (dossier).
 * En boîtes quand le conditionnement commandé est connu, sinon en unités.
 */
export async function lotsQuiPeriment(produits: readonly { id: string; dossierIds: string[] }[], maintenant: Date, jours = 183): Promise<Map<string, Lot360[]>> {
  const out = new Map<string, Lot360[]>();
  const ids = produits.map((p) => p.id);
  const dossiers = produits.flatMap((p) => p.dossierIds);
  if (!ids.length) return out;
  const dossierVersProduit = new Map(produits.flatMap((p) => p.dossierIds.map((d) => [d, p.id] as const)));
  const ors: Prisma.PchDeliveryLineWhereInput[] = [{ orderLine: { contractLine: { productId: { in: ids } } } }];
  if (dossiers.length) {
    ors.push({ orderLine: { tenderLine: { ourProductId: { in: dossiers } } } });
    ors.push({ orderLine: { contractLine: { tenderLine: { ourProductId: { in: dossiers } } } } });
  }
  const rows = await prisma.pchDeliveryLine.findMany({
    where: { expiryDate: { gte: maintenant, lt: new Date(maintenant.getTime() + jours * JOUR) }, quantityUnits: { gt: 0 }, OR: ors },
    select: {
      batchNumber: true, expiryDate: true, quantityUnits: true,
      delivery: { select: { deliveredAt: true } },
      orderLine: { select: { unitsPerBox: true, contractLine: { select: { productId: true, tenderLine: { select: { ourProductId: true } } } }, tenderLine: { select: { ourProductId: true, unitsPerBox: true } } } },
    },
    orderBy: { expiryDate: "asc" }, take: 500,
  });
  for (const r of rows) {
    const ol = r.orderLine;
    const productId = ol?.contractLine?.productId
      ?? (ol?.tenderLine?.ourProductId ? dossierVersProduit.get(ol.tenderLine.ourProductId) : undefined)
      ?? (ol?.contractLine?.tenderLine?.ourProductId ? dossierVersProduit.get(ol.contractLine.tenderLine.ourProductId) : undefined);
    if (!productId || !ids.includes(productId) || !r.expiryDate) continue;
    const parBoite = ol?.unitsPerBox ?? ol?.tenderLine?.unitsPerBox ?? null;
    (out.get(productId) ?? out.set(productId, []).get(productId)!).push({
      productId, lot: r.batchNumber, peremption: r.expiryDate,
      quantite: parBoite && parBoite > 0 ? Math.ceil(r.quantityUnits / parBoite) : r.quantityUnits,
      unite: parBoite && parBoite > 0 ? "boîtes" : "unités",
      livreLe: (r.delivery as { deliveredAt?: Date | null } | null)?.deliveredAt ?? null,
    });
  }
  return out;
}

// ─────────────────────────── La consommation de chaque hôpital (boîtes / mois) ───────────────────────────

/** L'écoulement mensuel de chaque établissement (consommation hospitalière importée, en boîtes, 12 derniers mois). */
export async function consommationParEtablissement(productId: string, maintenant: Date): Promise<Map<string, number>> {
  const debut = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - 11, 1));
  const lignes = await prisma.consommationLigne.findMany({
    where: { productId, statut: "OK", unite: "BOITE", import: { statut: "VALIDE" }, institutionId: { not: null }, periodeDebut: { gte: debut } },
    select: { institutionId: true, periodeDebut: true, quantite: true },
  });
  const par = new Map<string, { quantite: number; mois: string }[]>();
  for (const l of lignes) if (l.institutionId && l.periodeDebut) (par.get(l.institutionId) ?? par.set(l.institutionId, []).get(l.institutionId)!).push({ quantite: num(l.quantite), mois: cleMois(l.periodeDebut) });
  const out = new Map<string, number>();
  for (const [id, ls] of par) { const e = ecoulementMensuel(ls); if (e !== null) out.set(id, e); }
  return out;
}

// ─────────────────────────── Le matériel promotionnel ───────────────────────────

export interface Materiel360 { id: string; nom: string; actif: boolean; stock: number; remisCycle: number }

/** Les articles promotionnels du produit : stock (somme des mouvements) et remis en visite depuis `depuis`. */
export async function materielDuProduit(productId: string, depuis: Date): Promise<Materiel360[]> {
  const items = await prisma.promoStockItem.findMany({
    where: { produits: { some: { productId } } }, select: { id: true, name: true, isActive: true }, orderBy: [{ isActive: "desc" }, { name: "asc" }], take: 30,
  });
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const [stock, remis] = await Promise.all([
    prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: ids } }, _sum: { delta: true } }),
    prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, occurredAt: { gte: depuis }, annuleId: null, annulation: { is: null }, OR: [{ visitId: { not: null } }, { fieldReportId: { not: null } }] }, _sum: { delta: true } }),
  ]);
  const s = new Map(stock.map((x) => [x.itemId, num(x._sum.delta)]));
  const r = new Map(remis.map((x) => [x.itemId, Math.abs(num(x._sum.delta))]));
  return items.map((i) => ({ id: i.id, nom: i.name, actif: i.isActive, stock: Math.round(s.get(i.id) ?? 0), remisCycle: Math.round(r.get(i.id) ?? 0) }));
}
