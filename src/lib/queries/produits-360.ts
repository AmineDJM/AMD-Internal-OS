import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, hasGlobalView, regulatoryLockWhere, scopeMedicalInfo, type SessionUser } from "@/lib/rbac";
import { STATUTS_REGULATORY_TERMINES } from "@/lib/products/termines";
import { dernierMoisPch, indicateursProduitsPch, type Bornes, type IndicateursProduitPch } from "@/lib/ventes-pch/requetes";
import { decalerMois } from "@/lib/ventes-pch/calculs";
import { consommationMoyenne } from "@/lib/stocks/pch-central";
import { sections360 } from "@/lib/vues-360-acces";
import { clauseCasPvVisibles, voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { chargerPorteeStock, clauseRelevesDePortee } from "@/lib/queries/stock-portee";
import { keepVisibleSnapshots, STOCK_SCOPE_LABEL, type StockScope } from "@/lib/stocks/scopes";
import { companyScopedWhere, platformScope } from "@/lib/company";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { PHARMA_FORM, DOSAGE_UNIT, ENTITY_TYPE_LABELS } from "@/lib/labels";
import { DECLARATION_KIND_LABEL, isDeclarationKind } from "@/lib/medical-info/circuits";
import { manquesIdentite } from "@/lib/products/identity";
import { titreACompleter } from "@/lib/products/produit-du-dossier";
import { regrouperParMotsCles, texteDuRapport, type VoixTerrain } from "@/lib/voix-terrain/pur";
import { toNumber } from "@/lib/utils";
import {
  etapeCycle, stockActuel, moisDeCouverture, ecoulementMensuel, cleMois, echeanceDecision, echeanceDeLaFin, montantCourt,
  type EtapeCycle,
} from "@/lib/products/fiche-360";
import {
  noteSante, noteStock, noteTerrain, notePrescripteurs, noteReglementaire, noteQualite, alertePrincipale, fenetreCycle,
  estCibleHab, decimal, moisCourtDe, LETTRES_360,
  type NoteSante, type Alerte360, type Lettre360, type MouvementLettres, type FenetreCycle,
} from "@/lib/products/sante";
import type { Fait360 } from "@/lib/products/essentiel-360";
import {
  segmentation360, visitesDesProduits, messagesPortes, prioritesDuMois, adProDesProduits, lotsQuiPeriment,
  consommationParEtablissement, materielDuProduit, libelleNatureAdPro,
  type Segmentation360, type AdPro360, type Lot360, type Materiel360,
} from "@/lib/queries/produits-360-sante";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRODUITS 360 — LE catalogue (Direction, 07/10 : « Produit = dossier réglementaire ») et, depuis la version 2
 * (Direction, 10/2026), LA SANTÉ DU PRODUIT : stocks, terrain, visites, prescripteurs, marketing, Ad & Pro,
 * réglementaire et qualité. Plus d'appels d'offres, de prix ni de marges sur cet écran — ils vivent dans leurs modules.
 *
 * ── UN CATALOGUE, DES TABLES INTERNES ────────────────────────────────────────────────────
 *
 * L'écran ne montre QU'UN objet : le produit (`Product`), né de son dossier. Ses dossiers (`RegulatoryProduct.productId`)
 * en sont l'enregistrement — et portent le STOCK, dont les relevés sont indexés sur le dossier.
 *
 * ── QUI VOIT QUOI ────────────────────────────────────────────────────────────────────────
 *
 * Un produit se voit par un dossier NON VERROUILLÉ (`regulatoryLockWhere`) ; chaque chiffre, chaque onglet, chaque
 * composante de la note suit SON module (`vues-360-acces.ts`). Une composante que la personne ne voit pas est exclue de
 * sa note (« n/d »), jamais comptée zéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TERMINES = [...STATUTS_REGULATORY_TERMINES];
const num = (v: unknown): number => (v === null || v === undefined ? 0 : toNumber(v as never));
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const jourFr = (d: Date | string) => new Date(d).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
const entier = (n: number) => Math.round(n).toLocaleString("fr-FR");
const JOUR = 86_400_000;

export type OngletListe = "commercialises" | "enregistrement";

/** Le produit a un dossier terminé que la personne peut voir — la clause de l'onglet « Commercialisés ». */
export function clauseCommercialises(user: SessionUser | null): Prisma.ProductWhereInput {
  return { regulatoryProfiles: { some: { status: { in: TERMINES }, ...regulatoryLockWhere(user) } } };
}

/** Le pipeline : un dossier en cours visible, et AUCUN dossier terminé. */
export function clauseEnEnregistrement(user: SessionUser | null): Prisma.ProductWhereInput {
  return {
    AND: [
      { regulatoryProfiles: { some: { status: { notIn: TERMINES }, ...regulatoryLockWhere(user) } } },
      { NOT: { regulatoryProfiles: { some: { status: { in: TERMINES } } } } },
    ],
  };
}

/** Le produit est-il au catalogue de cette personne (un dossier non verrouillé, ou Super Admin) ? */
export function clauseProduitAuCatalogue(user: SessionUser): Prisma.ProductWhereInput {
  if (user.role === "SUPER_ADMIN") return {};
  return { regulatoryProfiles: { some: regulatoryLockWhere(user) } };
}

function clauseRecherche(q: string): Prisma.ProductWhereInput {
  if (!q) return {};
  const c = { contains: q, mode: "insensitive" as const };
  return {
    OR: [
      { canonicalName: c }, { dci: c }, { code: c }, { aliases: { some: { label: c } } },
      { regulatoryProfiles: { some: { OR: [{ brandName: c }, { reference: c }, { dci: c }] } } },
    ],
  };
}

/** « 400 mg » — le dosage écrit comme on le dit. */
export function texteDosage(p: { dosage: string | null; dosageUnit: string | null }): string | null {
  const u = p.dosageUnit ? DOSAGE_UNIT[p.dosageUnit] ?? p.dosageUnit : "";
  return [p.dosage?.trim(), u].filter(Boolean).join(" ") || null;
}
export function texteForme(form: string | null): string | null {
  return form ? PHARMA_FORM[form] ?? form : null;
}

/**
 * L'ÉCHÉANCE D'UN DOSSIER : la fin de validité CONFIRMÉE sur le dossier (lue, déduite ou saisie) quand elle existe ;
 * sinon, pour une décision obtenue, la date de l'étape « décision » + 5 ans (dossiers d'avant la saisie de la validité).
 */
function echeanceDuDossier(d: { status: string; workflow: unknown; registrationValidUntil?: Date | null }, maintenant: Date) {
  if (d.registrationValidUntil) return echeanceDeLaFin(d.registrationValidUntil, maintenant);
  return d.status === "DECISION_OBTAINED" ? echeanceDecision(dateDecision(d.workflow), maintenant) : null;
}

/** La date de la décision d'enregistrement — l'étape « décision » du suivi ANPP, quand elle est datée. */
function dateDecision(workflow: unknown): Date | null {
  const w = (workflow ?? {}) as Record<string, { date?: string } | undefined>;
  const brut = w.decision?.date;
  if (!brut) return null;
  const d = new Date(brut);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────── Faits partagés (liste et fiche) ───────────────────────────

/** LES 12 MOIS PCH qui finissent sur le DERNIER MOIS REÇU (un mois pas encore reçu n'est pas une vente nulle). */
async function douzeMoisPch(maintenant: Date): Promise<Bornes> {
  const fin = (await dernierMoisPch()) ?? cleMois(maintenant);
  return { debut: decalerMois(fin, -11), fin };
}

export type SourceEcoulement = "PCH" | "VENTES" | "CONSOMMATION";

/**
 * L'ÉCOULEMENT MENSUEL de chaque produit — ce qui sort, pour diviser le stock. D'abord la distribution aux hôpitaux par
 * les DR de la PCH (moyenne des 3 derniers mois complets reçus, la règle de `stocks/pch-central.ts`) ; à défaut les ventes
 * saisies, sinon la consommation hospitalière comptée en BOÎTES.
 */
async function ecoulements(productIds: string[], maintenant: Date, pch?: Map<string, IndicateursProduitPch> | null): Promise<Map<string, { parMois: number; source: SourceEcoulement }>> {
  const out = new Map<string, { parMois: number; source: SourceEcoulement }>();
  for (const [id, x] of pch ?? []) {
    const c = consommationMoyenne(x.sellOutLignes, cleMois(maintenant));
    if (c !== null && c > 0) out.set(id, { parMois: c, source: "PCH" });
  }
  const reste = productIds.filter((id) => !out.has(id));
  if (!reste.length) return out;
  const debut = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - 11, 1));
  const [ventes, conso] = await Promise.all([
    prisma.sale.findMany({ where: { productId: { in: reste }, date: { gte: debut } }, select: { productId: true, date: true, quantity: true } }),
    prisma.consommationLigne.findMany({
      where: { productId: { in: reste }, statut: "OK", unite: "BOITE", import: { statut: "VALIDE" }, periodeDebut: { gte: debut } },
      select: { productId: true, periodeDebut: true, quantite: true },
    }),
  ]);
  const unitesVendues = new Map<string, number>();
  for (const v of ventes) if (v.productId) unitesVendues.set(v.productId, (unitesVendues.get(v.productId) ?? 0) + v.quantity);
  for (const [id, u] of unitesVendues) if (u > 0) out.set(id, { parMois: u / 12, source: "VENTES" });
  const parProduit = new Map<string, { quantite: number; mois: string }[]>();
  for (const c of conso) {
    if (!c.productId || !c.periodeDebut || out.has(c.productId)) continue;
    (parProduit.get(c.productId) ?? parProduit.set(c.productId, []).get(c.productId)!).push({ quantite: num(c.quantite), mois: cleMois(c.periodeDebut) });
  }
  for (const [id, lignes] of parProduit) {
    const e = ecoulementMensuel(lignes);
    if (e !== null) out.set(id, { parMois: e, source: "CONSOMMATION" });
  }
  return out;
}

/** Les relevés de stock des dossiers, dans la portée de stock de la personne (la règle de l'écran Stocks). */
async function relevesDeStock(user: SessionUser, dossierIds: string[]) {
  if (!dossierIds.length) return [];
  const portee = await chargerPorteeStock(user);
  const releves = await prisma.stockSnapshot.findMany({
    where: { AND: [await platformScope(user.id), clauseRelevesDePortee(portee), { productId: { in: dossierIds } }] },
    orderBy: { date: "desc" }, take: 5000,
    select: { id: true, productId: true, scope: true, annexId: true, drCode: true, date: true, quantity: true, annex: { select: { name: true, institutionId: true, institution: { select: { name: true } } } } },
  });
  const viewer = { canSeeSupplyChain: userCan(user, "PCH", "VIEW"), hasGlobalView: hasGlobalView(user) };
  return keepVisibleSnapshots(viewer, releves);
}
type Releve = Awaited<ReturnType<typeof relevesDeStock>>[number];

/** La clé d'un lieu de stock : portée × annexe, ou portée × direction régionale de la PCH. */
const lieuReleve = (r: { scope: string; annexId: string | null; drCode: string | null }) => `${r.scope}|${r.annexId ?? ""}|${r.drCode ?? ""}`;

/** Le dernier relevé de chaque lieu (portée × annexe / direction régionale), tous dossiers du produit confondus. */
function derniersParLieu(releves: readonly Releve[]): Releve[] {
  const parLieu = new Map<string, Map<string, Releve>>();
  for (const r of releves) {
    const lieu = lieuReleve(r);
    const m = parLieu.get(lieu) ?? parLieu.set(lieu, new Map()).get(lieu)!;
    const cur = m.get(r.productId);
    if (!cur || r.date > cur.date) m.set(r.productId, r);
  }
  // Un même lieu relevé pour deux dossiers du produit : les quantités s'additionnent, la date la plus récente reste.
  return [...parLieu.values()].map((m) => {
    const ls = [...m.values()];
    const plusRecent = ls.reduce((a, b) => (b.date > a.date ? b : a));
    return { ...plusRecent, quantity: ls.reduce((s, x) => s + x.quantity, 0) };
  });
}

/** Les cas de pharmacovigilance que la personne lit, par produit canonique (directement ou par son produit de BU). */
async function casPv(user: SessionUser, productIds: string[]) {
  const promos = await prisma.promoProduct.findMany({ where: { productId: { in: productIds } }, select: { id: true, productId: true } });
  const promoVersProduit = new Map(promos.map((p) => [p.id, p.productId!]));
  const cas = await prisma.pharmacovigilanceCase.findMany({
    where: { AND: [clauseCasPvVisibles(user), { OR: [{ productId: { in: productIds } }, { promoProductId: { in: [...promoVersProduit.keys()] } }] }] },
    select: { id: true, reference: true, status: true, severity: true, occurredOn: true, productId: true, promoProductId: true },
    orderBy: { occurredOn: "desc" }, take: 500,
  });
  return cas.map((c) => ({ ...c, produit: c.productId ?? (c.promoProductId ? promoVersProduit.get(c.promoProductId) ?? null : null) }));
}

// ─────────────────────────── La synthèse d'un produit : les 6 chiffres, la note, l'alerte ───────────────────────────

/** Ce qu'on sait d'un produit pour le noter. `null` = module non visible (jamais « zéro »). */
interface FaitsProduit {
  stock: { unites: number; couvertureMois: number | null; hopitauxEnRupture: number } | null;
  lots: Lot360[] | null;
  /** `undefined` = module non visible ; `null` = visible, produit classé par aucune stratégie. */
  seg: Segmentation360 | null | undefined;
  visites: { cycle: number; precedent: number } | null;
  adpro: AdPro360 | null;
  reglementaire: { dossiers: number; joursAvantDepot: number | null; variationsEnAttente: number } | null;
  pv: { gravitesOuvertes: (string | null)[] } | null;
}

export interface Chiffres360 {
  stock: { couvertureMois: number | null; unites: number | null } | null;
  visites: { cycle: number; evolutionPct: number | null } | null;
  cibles: { cibles: number; vues: number; pct: number | null } | null;
  prescripteurs: { a: number; segmentes: number; mouvementNet: number | null } | null;
  adpro: { montant: number; partHabPct: number | null } | null;
  pv: { ouverts: number } | null;
}

const HAB = new Set<Lettre360>(["H", "A", "B"]);

/** La part de l'Ad & Pro nominatif qui touche des cibles H·A·B (montant × part des médecins H·A·B de chaque action). */
function partHab(adpro: AdPro360, seg: Segmentation360 | null | undefined): number | null {
  if (!seg) return null;
  const lettre = new Map(seg.praticiens.map((p) => [p.doctorId, p.lettre]));
  let nominatif = 0; let hab = 0;
  for (const a of adpro.actions) {
    if (!a.doctorIds.length || a.montant <= 0) continue;
    nominatif += a.montant;
    hab += a.montant * (a.doctorIds.filter((d) => HAB.has(lettre.get(d) ?? "NC")).length / a.doctorIds.length);
  }
  return nominatif > 0 ? Math.round((hab / nominatif) * 100) : null;
}

function synthese(f: FaitsProduit): { sante: NoteSante; chiffres: Chiffres360; alerte: Alerte360 | null; hNonVus: number } {
  const praticiens = f.seg?.praticiens ?? [];
  const cibles = praticiens.filter(estCibleHab);
  const vues = cibles.filter((p) => p.vus >= p.requis).length;
  const segmentes = praticiens.filter((p) => p.segment === "A" || p.segment === "B" || p.segment === "C" || p.segment === "D").length;
  const a = praticiens.filter((p) => p.segment === "A").length;
  const mouvementNet = f.seg?.mouvement?.net ?? null;
  const hNonVus = f.seg === undefined ? 0 : praticiens.filter((p) => p.h && p.cible && p.requis > 0 && p.vus === 0).length;
  const lotsN = f.lots?.length ?? 0;
  const ouverts = f.pv?.gravitesOuvertes.length ?? 0;

  const notes = {
    stock: f.stock ? noteStock({ couvertureMois: f.stock.couvertureMois, lotsExpirant: lotsN }) : null,
    terrain: f.seg !== undefined ? noteTerrain({ cibles: cibles.length, vuesAFrequence: vues }) : null,
    prescripteurs: f.seg !== undefined ? notePrescripteurs({ a, segmentes, mouvementNet }) : null,
    reglementaire: f.reglementaire ? noteReglementaire(f.reglementaire) : null,
    qualite: noteQualite(f.pv),
  };
  const r = f.reglementaire;
  const faits = {
    stock: f.stock?.couvertureMois != null ? `${decimal(f.stock.couvertureMois)} mois${lotsN ? ` · ${lotsN} lot${lotsN > 1 ? "s" : ""} sous 6 mois` : ""}` : null,
    terrain: cibles.length ? `${vues} / ${cibles.length} cibles H·A·B vues à fréquence` : null,
    prescripteurs: segmentes ? `${a} A sur ${segmentes} segmentés${mouvementNet !== null ? ` · ${mouvementNet >= 0 ? "+" : ""}${mouvementNet} A net` : ""}` : null,
    reglementaire: r ? [r.joursAvantDepot !== null ? (r.joursAvantDepot < 0 ? "dépôt DE en retard" : `dépôt DE dans ${r.joursAvantDepot} j`) : "aucune échéance DE", r.variationsEnAttente ? `${r.variationsEnAttente} variation(s) en attente` : null].filter(Boolean).join(" · ") : null,
    qualite: f.pv ? (ouverts ? `${ouverts} cas PV ouvert${ouverts > 1 ? "s" : ""}` : "aucun cas PV ouvert") : null,
  };
  const sante = noteSante(notes, faits);
  const premierLot = f.lots?.length ? f.lots.reduce((x, y) => (y.peremption < x.peremption ? y : x)).peremption : null;
  return {
    sante, hNonVus,
    chiffres: {
      stock: f.stock ? { couvertureMois: f.stock.couvertureMois, unites: f.stock.unites } : null,
      visites: f.visites ? { cycle: f.visites.cycle, evolutionPct: f.visites.precedent > 0 ? Math.round(((f.visites.cycle - f.visites.precedent) / f.visites.precedent) * 100) : null } : null,
      cibles: f.seg !== undefined ? { cibles: cibles.length, vues, pct: cibles.length ? Math.round((vues / cibles.length) * 100) : null } : null,
      prescripteurs: f.seg !== undefined ? { a, segmentes, mouvementNet } : null,
      adpro: f.adpro ? { montant: f.adpro.montant, partHabPct: partHab(f.adpro, f.seg) } : null,
      pv: f.pv ? { ouverts } : null,
    },
    alerte: alertePrincipale({
      pvOuverts: f.pv ? ouverts : undefined,
      hopitauxEnRupture: f.stock ? f.stock.hopitauxEnRupture : undefined,
      couvertureMois: f.stock ? f.stock.couvertureMois : undefined,
      premierLotPerime: premierLot,
      hNonVus: f.seg !== undefined ? hNonVus : undefined,
      joursAvantDepotDe: r ? r.joursAvantDepot : undefined,
      variationsEnAttente: r ? r.variationsEnAttente : undefined,
    }),
  };
}

/** La plus proche échéance de dépôt d'un renouvellement de DE, parmi les dossiers à décision obtenue. */
function prochaineEcheance(dossiers: readonly { status: string; workflow: unknown; registrationValidUntil?: Date | null }[], maintenant: Date) {
  return dossiers.map((d) => echeanceDuDossier(d, maintenant))
    .filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => a.joursAvantDepot - b.joursAvantDepot)[0] ?? null;
}

// ─────────────────────────── La liste ───────────────────────────

export interface LigneProduit360 {
  id: string;
  code: string;
  nom: string;
  /** « cp pelliculé · PRD-2026-012 » */
  sousTitre: string;
  bu: string | null;
  etape: EtapeCycle;
  /** Onglet « En enregistrement » : le dossier le plus avancé et sa cible. */
  dossier: { statut: string; cible: string | null; reference: string } | null;
  sante: NoteSante | null;
  chiffres: Chiffres360 | null;
  alerte: Alerte360 | null;
}

export interface ListeProduits360 {
  lignes: LigneProduit360[];
  compte: { commercialises: number; enregistrement: number };
  colonnes: { stock: boolean; visites: boolean; prescripteurs: boolean; adpro: boolean };
  bus: { id: string; nom: string }[];
}

const ORDRE_STATUT: Record<string, number> = {
  PRE_SUBMISSION: 0, IN_PREPARATION: 1, SUBMITTED: 2, AWAITING_BV_PAYMENT: 3, AWAITING_ANPP: 4, RESPONDING_TO_QUERIES: 5, BLOCKED: 1, DECISION_OBTAINED: 9, CLOSED: 9,
};

export async function listeProduits360(user: SessionUser, opts: { q?: string; onglet: OngletListe; bu?: string | null; maintenant?: Date }): Promise<ListeProduits360> {
  const maintenant = opts.maintenant ?? new Date();
  const q = (opts.q ?? "").trim();
  const voit = sections360(user);
  const lock = regulatoryLockWhere(user);
  const clauseOnglet = opts.onglet === "commercialises" ? clauseCommercialises(user) : clauseEnEnregistrement(user);
  const clauseBu: Prisma.ProductWhereInput = opts.bu ? { promoProfiles: { some: { businessUnitId: opts.bu } } } : {};

  const [commercialises, enregistrement, produits, bus] = await Promise.all([
    prisma.product.count({ where: clauseCommercialises(user) }),
    prisma.product.count({ where: clauseEnEnregistrement(user) }),
    prisma.product.findMany({
      where: { AND: [clauseOnglet, clauseRecherche(q), clauseBu] },
      orderBy: [{ isActive: "desc" }, { canonicalName: "asc" }],
      take: 200,
      select: {
        id: true, code: true, canonicalName: true, form: true, lifecycle: true, isActive: true,
        promoProfiles: { select: { businessUnit: { select: { name: true } } } },
        regulatoryProfiles: {
          where: lock,
          select: { id: true, reference: true, status: true, targetDate: true, workflow: true, registrationValidUntil: true, variations: { where: { status: "EN_ATTENTE" }, select: { id: true } } },
        },
      },
    }),
    prisma.businessUnit.findMany({ where: { isActive: true, products: { some: { productId: { not: null } } } }, select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
  ]);

  const ids = produits.map((p) => p.id);
  const commerce = opts.onglet === "commercialises";
  const dossierVersProduit = new Map(produits.flatMap((p) => p.regulatoryProfiles.map((r) => [r.id, p.id] as const)));

  // Les faits de la note, chacun lu seulement pour le module que la personne voit.
  const periodePch = commerce && ids.length && voit.stock ? await douzeMoisPch(maintenant) : null;
  const [pch, releves, pv, seg, adpro, lots] = await Promise.all([
    periodePch ? indicateursProduitsPch(ids, periodePch).then((r) => r.parProduit) : Promise.resolve(null),
    commerce && voit.stock ? relevesDeStock(user, [...dossierVersProduit.keys()]) : Promise.resolve(null),
    commerce && voit.pharmacovigilance && ids.length ? casPv(user, ids) : Promise.resolve(null),
    commerce && voit.segmentation ? segmentation360(ids, maintenant) : Promise.resolve(null),
    commerce && voit.adpro ? adProDesProduits(ids, new Date(maintenant.getTime() - 365 * JOUR)) : Promise.resolve(null),
    commerce && voit.stock && voit.marches ? lotsQuiPeriment(produits.map((p) => ({ id: p.id, dossierIds: p.regulatoryProfiles.map((r) => r.id) })), maintenant) : Promise.resolve(null),
  ]);
  const flux = commerce && voit.stock && ids.length ? await ecoulements(ids, maintenant, pch) : null;
  // Les visites du cycle : la fenêtre de la stratégie du produit, sinon le mois — lues d'un coup depuis le plus ancien début.
  const fenetres = new Map(ids.map((id) => [id, seg?.get(id)?.fenetre ?? fenetreCycle(maintenant)]));
  const depuis = ids.length ? new Date(Math.min(...[...fenetres.values()].map((f) => f.precedent.debut.getTime()))) : maintenant;
  const visites = commerce && voit.terrain ? await visitesDesProduits(user, ids, depuis) : null;

  const lignes: LigneProduit360[] = produits.map((p) => {
    const statuts = p.regulatoryProfiles.map((r) => r.status as string);
    const forme = texteForme(p.form);
    const busP = [...new Set(p.promoProfiles.map((x) => x.businessUnit?.name).filter((x): x is string => !!x))];
    const base = {
      id: p.id, code: p.code, nom: p.canonicalName,
      sousTitre: [forme?.toLowerCase(), p.code].filter(Boolean).join(" · "),
      bu: busP.join(", ") || null,
      etape: etapeCycle({ lifecycle: p.lifecycle, isActive: p.isActive, statutsDossiers: statuts }),
    };
    if (!commerce) {
      const d = [...p.regulatoryProfiles].sort((a, b) => (ORDRE_STATUT[b.status] ?? 0) - (ORDRE_STATUT[a.status] ?? 0))[0];
      return { ...base, dossier: d ? { statut: d.status, cible: ymd(d.targetDate), reference: d.reference } : null, sante: null, chiffres: null, alerte: null };
    }

    let stock: FaitsProduit["stock"] = null;
    if (releves) {
      const miens = releves.filter((r) => dossierVersProduit.get(r.productId) === p.id);
      const unites = stockActuel(miens).unites;
      stock = {
        unites, couvertureMois: miens.length ? moisDeCouverture(unites, flux?.get(p.id)?.parMois ?? null) : null,
        hopitauxEnRupture: derniersParLieu(miens).filter((r) => r.scope === "HOSPITAL" && r.quantity === 0).length,
      };
    }
    const f = fenetres.get(p.id)!;
    const miennes = visites?.filter((v) => v.productId === p.id) ?? null;
    const e = voit.reglementaire ? prochaineEcheance(p.regulatoryProfiles, maintenant) : null;
    const s = synthese({
      stock, lots: lots ? lots.get(p.id) ?? [] : null,
      seg: seg ? seg.get(p.id) ?? null : undefined,
      visites: miennes ? {
        cycle: miennes.filter((v) => v.date >= f.debut && v.date < f.finExclue).length,
        precedent: miennes.filter((v) => v.date >= f.precedent.debut && v.date < f.precedent.finExclue).length,
      } : null,
      adpro: adpro ? adpro.get(p.id) ?? { montant: 0, actions: [], postesSansMontant: 0 } : null,
      reglementaire: voit.reglementaire ? { dossiers: p.regulatoryProfiles.length, joursAvantDepot: e?.joursAvantDepot ?? null, variationsEnAttente: p.regulatoryProfiles.reduce((n, r) => n + r.variations.length, 0) } : null,
      pv: pv ? { gravitesOuvertes: pv.filter((c) => c.produit === p.id && c.status !== "CLOS").map((c) => c.severity) } : null,
    });
    return { ...base, dossier: null, sante: s.sante, chiffres: s.chiffres, alerte: s.alerte };
  });

  // LA SANTÉ D'ABORD : ce qui va mal en haut ; une note inconnue en bas.
  if (commerce) lignes.sort((a, b) => (a.sante?.score ?? 101) - (b.sante?.score ?? 101) || a.nom.localeCompare(b.nom, "fr"));

  return {
    lignes,
    compte: { commercialises, enregistrement },
    colonnes: { stock: voit.stock, visites: voit.terrain, prescripteurs: voit.segmentation, adpro: voit.adpro },
    bus: bus.map((b) => ({ id: b.id, nom: b.name })),
  };
}

// ─────────────────────────── La fiche ───────────────────────────

export type TonFiche = "danger" | "warning" | "info" | "success" | "neutral";
export interface ASurveiller { ton: "danger" | "warning" | "info"; titre: string; detail: string; href: string | null }
export interface Evenement360 { date: string; texte: string; ton: TonFiche; href: string | null }

export interface LieuStock { cle: string; lieu: string; portee: string; quantite: number; date: string; mois: number | null; rupture: boolean }

export interface Fiche360 {
  identite: {
    id: string; code: string; nom: string; dci: string; dosage: string | null; forme: string | null; conditionnement: string | null;
    societe: string | null; etape: EtapeCycle; lifecycle: string; isActive: boolean; alias: string[];
    /** La décision d'enregistrement la plus ancienne (le produit est commercialisable depuis) et son dossier. */
    decision: { date: string; reference: string } | null;
  };
  bus: { id: string; nom: string }[];
  dossiers: {
    id: string; reference: string; nomCommercial: string | null; statut: string; detenteurDe: string | null; laboPartenaire: string | null;
    classeTherapeutique: string | null; fabricant: string | null; statutFabrication: string; dateDecision: string | null;
    echeance: { expiration: string; depotAvant: string; joursAvantDepot: number } | null; cibleEnregistrement: string | null;
    variations: { id: string; vers: string; statut: string; depot: string | null; decision: string | null }[];
  }[];
  /**
   * LES DÉCLARATIONS D'INFORMATION MÉDICALE du produit (`MedicalInfoDeclaration.productId`, repris de la source puis corrigé par
   * le pharmacien) — `null` quand la personne ne voit pas le module Information médicale.
   */
  declarationsInfoMed: { id: string; reference: string; label: string; statut: string; nature: string; date: string }[] | null;
  dossiersMasques: number;
  sante: NoteSante;
  chiffres: Chiffres360;
  pastilles: { p1: number | null; messagesActifs: number | null; echeance: { texte: string; ton: TonFiche } | null };
  cycle: { debut: string; fin: string; source: FenetreCycle["source"] };
  stock: {
    unites: number; date: string | null; lieux: LieuStock[]; couvertureMois: number | null; ecoulementMensuel: number | null;
    sourceEcoulement: SourceEcoulement | null;
    releves: { id: string; date: string; lieu: string; portee: string; quantite: number }[];
    lots: { lot: string | null; peremption: string; quantite: number; unite: string }[] | null;
  } | null;
  terrain: {
    kams: { repId: string; nom: string; position: number | null; visites: number; messages: number }[];
    recentes: { date: string; medecin: string | null; delegue: string | null; lettre: Lettre360 | null }[];
  } | null;
  segmentation: {
    strategies: { id: string; nom: string }[];
    lettres: Record<Lettre360, number>;
    couverture: { lettre: "H" | "A" | "B"; cibles: number; vues: number }[];
    hNonVus: { nom: string; wilaya: string | null; etablissement: string | null }[];
    mouvement: MouvementLettres | null; cycleComparaison: string | null;
    decideurs: { doctorId: string; nom: string; etablissement: string | null; requis: number; vus: number }[];
  } | null;
  voix: VoixTerrain | null;
  marketing: {
    messages: { id: string; titre: string; actif: boolean; portes: number; delegues: number }[] | null;
    deleguesAssignes: number;
    materiel: Materiel360[] | null;
  } | null;
  adpro: {
    montant: number; partHabPct: number | null; postesSansMontant: number;
    actions: { cle: string; libelle: string; nature: string; date: string; montant: number; href: string | null; lettres: Partial<Record<Lettre360, number>>; medecins: number }[];
  } | null;
  pv: { id: string; reference: string; statut: string; gravite: string | null; survenu: string; href: string }[] | null;
  aTraiter: ASurveiller[];
  chronologie: Evenement360[];
  faits: Fait360[];
}

/** La fiche d'UN produit — `null` quand il n'existe pas OU qu'il n'est pas au catalogue de la personne. */
export async function fiche360(user: SessionUser, productId: string, maintenant = new Date()): Promise<Fiche360 | null> {
  const voit = sections360(user);
  const p = await prisma.product.findFirst({
    where: { AND: [{ id: productId }, clauseProduitAuCatalogue(user)] },
    select: {
      id: true, code: true, canonicalName: true, dci: true, dosage: true, dosageUnit: true, form: true, packaging: true,
      lifecycle: true, isActive: true,
      company: { select: { name: true, shortName: true } },
      aliases: { select: { label: true }, orderBy: { label: "asc" } },
      promoProfiles: { select: { businessUnit: { select: { id: true, name: true } } } },
      regulatoryProfiles: { select: { id: true, status: true, isLocked: true } },
    },
  });
  if (!p) return null;

  const lock = regulatoryLockWhere(user);
  const dossiersNonVerrouilles = p.regulatoryProfiles.filter((r) => !("isLocked" in lock) || !r.isLocked);
  const dossierIds = dossiersNonVerrouilles.map((r) => r.id);
  const depuis12 = new Date(maintenant.getTime() - 365 * JOUR);

  const periodePch = voit.stock ? await douzeMoisPch(maintenant) : null;
  const [visibles, pch, releves, pv, seg, adproMap, lotsMap, messagesRef, priorites] = await Promise.all([
    voit.reglementaire
      ? prisma.regulatoryProduct.findMany({
          where: { AND: [await regulatoryVisibleWhere(user), { productId: p.id }] },
          orderBy: { reference: "asc" },
          select: {
            id: true, reference: true, brandName: true, status: true, deHolder: true, partnerLab: true, therapeuticClass: true,
            manufacturer: true, manufacturingStatus: true, workflow: true, targetDate: true, registrationValidUntil: true, registrationDecisionDate: true,
            dci: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true, packaging: true,
            variations: { select: { id: true, toStatus: true, status: true, depotDate: true, decisionDate: true }, orderBy: { createdAt: "desc" } },
          },
        })
      : Promise.resolve([]),
    periodePch ? indicateursProduitsPch([p.id], periodePch) : Promise.resolve(null),
    voit.stock ? relevesDeStock(user, dossierIds) : Promise.resolve(null),
    voit.pharmacovigilance ? casPv(user, [p.id]) : Promise.resolve(null),
    voit.segmentation ? segmentation360([p.id], maintenant) : Promise.resolve(null),
    voit.adpro ? adProDesProduits([p.id], depuis12) : Promise.resolve(null),
    voit.stock && voit.marches ? lotsQuiPeriment([{ id: p.id, dossierIds }], maintenant) : Promise.resolve(null),
    voit.forceDeVente || voit.marketing
      ? prisma.promoMessage.findMany({ where: { productId: p.id }, select: { id: true, title: true, isActive: true, createdAt: true, updatedAt: true }, orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }], take: 30 })
      : Promise.resolve(null),
    voit.forceDeVente ? prioritesDuMois([p.id], maintenant) : Promise.resolve(null),
  ]);
  // Les déclarations d'information médicale du produit — la même portée que la liste du module (entité + droits).
  const declarations = userCan(user, "MEDICAL_INFO", "VIEW")
    ? await prisma.medicalInfoDeclaration.findMany({
        where: { AND: [await companyScopedWhere(user.id, scopeMedicalInfo(user)), { productId: p.id }] },
        select: { id: true, reference: true, label: true, status: true, sourceType: true, declarationKind: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 30,
      })
    : null;

  const segP = seg ? seg.get(p.id) ?? null : undefined;
  const fenetre = segP?.fenetre ?? fenetreCycle(maintenant);
  const debutLecture = new Date(Math.min(fenetre.precedent.debut.getTime(), maintenant.getTime() - 60 * JOUR));
  const [visites, portes, materiel, consoHop] = await Promise.all([
    voit.terrain ? visitesDesProduits(user, [p.id], debutLecture, { detail: true }) : Promise.resolve(null),
    voit.terrain && messagesRef ? messagesPortes(user, [p.id], fenetre.debut) : Promise.resolve(null),
    voit.materiel ? materielDuProduit(p.id, fenetre.debut) : Promise.resolve(null),
    voit.stock ? consommationParEtablissement(p.id, maintenant) : Promise.resolve(new Map<string, number>()),
  ]);
  const flux = voit.stock ? await ecoulements([p.id], maintenant, pch?.parProduit) : null;

  // ── Stock : dernier relevé de chaque lieu, couverture ──
  let blocStock: Fiche360["stock"] = null;
  let hopitauxEnRupture = 0;
  if (releves) {
    const s = stockActuel(releves);
    const e = flux?.get(p.id) ?? null;
    const lieux: LieuStock[] = derniersParLieu(releves).map((r) => {
      const conso = r.scope === "HOSPITAL" && r.annex?.institutionId ? consoHop.get(r.annex.institutionId) ?? null : r.scope === "PCH" && !r.annexId ? e?.parMois ?? null : null;
      return {
        cle: lieuReleve(r),
        lieu: r.scope === "PCH" && !r.annexId ? "PCH central" : r.drCode ? `PCH · ${r.drCode}` : r.annex?.institution?.name ?? r.annex?.name ?? "—",
        portee: STOCK_SCOPE_LABEL[r.scope as StockScope] ?? r.scope, quantite: r.quantity, date: ymd(r.date)!,
        mois: moisDeCouverture(r.quantity, conso), rupture: r.quantity === 0,
      };
    }).sort((a, b) => (a.lieu === "PCH central" ? -1 : b.lieu === "PCH central" ? 1 : (a.mois ?? 99) - (b.mois ?? 99)));
    hopitauxEnRupture = lieux.filter((l) => l.rupture && l.cle.startsWith("HOSPITAL")).length;
    const lots = lotsMap ? lotsMap.get(p.id) ?? [] : null;
    blocStock = {
      unites: s.unites, date: ymd(s.date), lieux,
      couvertureMois: releves.length ? moisDeCouverture(s.unites, e?.parMois ?? null) : null,
      ecoulementMensuel: e ? Math.round(e.parMois) : null, sourceEcoulement: e?.source ?? null,
      releves: releves.slice(0, 30).map((r) => ({
        id: r.id, date: r.date.toISOString().slice(0, 10),
        lieu: r.drCode ? `PCH · ${r.drCode}` : r.annex?.institution?.name ?? r.annex?.name ?? "PCH",
        portee: STOCK_SCOPE_LABEL[r.scope as StockScope] ?? r.scope, quantite: r.quantity,
      })),
      lots: lots ? lots.map((l) => ({ lot: l.lot, peremption: ymd(l.peremption)!, quantite: l.quantite, unite: l.unite })) : null,
    };
  }

  // ── Dossiers ──
  const dossiers: Fiche360["dossiers"] = visibles.map((d) => {
    const dd = d.registrationDecisionDate ?? dateDecision(d.workflow);
    const e = echeanceDuDossier(d, maintenant);
    return {
      id: d.id, reference: d.reference, nomCommercial: d.brandName, statut: d.status, detenteurDe: d.deHolder, laboPartenaire: d.partnerLab,
      classeTherapeutique: d.therapeuticClass, fabricant: d.manufacturer, statutFabrication: d.manufacturingStatus,
      dateDecision: ymd(dd), cibleEnregistrement: ymd(d.targetDate),
      echeance: e ? { expiration: ymd(e.expiration)!, depotAvant: ymd(e.depotAvant)!, joursAvantDepot: e.joursAvantDepot } : null,
      variations: d.variations.map((v) => ({ id: v.id, vers: v.toStatus, statut: v.status, depot: ymd(v.depotDate), decision: ymd(v.decisionDate) })),
    };
  });
  const echeance = dossiers.map((d) => d.echeance ? { ...d.echeance, reference: d.reference, id: d.id } : null).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.joursAvantDepot - b.joursAvantDepot)[0] ?? null;
  const variationsEnAttente = dossiers.flatMap((d) => d.variations.filter((v) => v.statut === "EN_ATTENTE").map((v) => ({ ...v, reference: d.reference, dossierId: d.id })));

  // ── Pharmacovigilance ──
  const tousLesCas = voitTousLesCasPv(user);
  const blocPv: Fiche360["pv"] = pv ? pv.map((c) => ({
    id: c.id, reference: c.reference, statut: c.status, gravite: c.severity, survenu: c.occurredOn.toISOString().slice(0, 10),
    href: tousLesCas ? `/regulatory/pharmacovigilance/${c.id}` : `/medical/rapports/pharmacovigilance/${c.id}`,
  })) : null;
  const pvOuverts = (blocPv ?? []).filter((c) => c.statut !== "CLOS");

  // ── Terrain : visites du cycle, par KAM ──
  const dansCycle = (d: Date) => d >= fenetre.debut && d < fenetre.finExclue;
  const visitesCycle = visites?.filter((v) => dansCycle(v.date)) ?? null;
  const lettreDe = new Map((segP?.praticiens ?? []).map((x) => [x.doctorId, x.lettre]));
  let blocTerrain: Fiche360["terrain"] = null;
  if (visitesCycle || priorites) {
    const kams = new Map<string, { repId: string; nom: string; position: number | null; visites: number; messages: number }>();
    for (const a of priorites ?? []) kams.set(a.repId, { repId: a.repId, nom: a.nom, position: a.position, visites: 0, messages: 0 });
    for (const v of visitesCycle ?? []) {
      if (!v.delegateId) continue;
      const k = kams.get(v.delegateId) ?? kams.set(v.delegateId, { repId: v.delegateId, nom: v.delegue ?? "—", position: null, visites: 0, messages: 0 }).get(v.delegateId)!;
      k.visites++;
    }
    for (const m of portes ?? []) if (m.delegateId && kams.has(m.delegateId)) kams.get(m.delegateId)!.messages++;
    blocTerrain = {
      kams: [...kams.values()].sort((a, b) => (a.position ?? 9) - (b.position ?? 9) || b.visites - a.visites),
      recentes: (visites ?? []).sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 15).map((v) => ({
        date: ymd(v.date)!, medecin: v.medecin, delegue: v.delegue, lettre: v.doctorId ? lettreDe.get(v.doctorId) ?? null : null,
      })),
    };
  }

  // ── Segmentation ──
  let blocSeg: Fiche360["segmentation"] = null;
  if (segP) {
    const lettres = Object.fromEntries(LETTRES_360.map((l) => [l, 0])) as Record<Lettre360, number>;
    for (const x of segP.praticiens) lettres[x.lettre]++;
    const cibles = segP.praticiens.filter(estCibleHab);
    const groupe = (x: (typeof cibles)[number]): "H" | "A" | "B" => (x.h ? "H" : x.segment === "A" ? "A" : "B");
    blocSeg = {
      strategies: segP.strategies, lettres,
      couverture: (["H", "A", "B"] as const).map((l) => ({ lettre: l, cibles: cibles.filter((x) => groupe(x) === l).length, vues: cibles.filter((x) => groupe(x) === l && x.vus >= x.requis).length })),
      hNonVus: segP.praticiens.filter((x) => x.h && x.cible && x.requis > 0 && x.vus === 0).map((x) => ({ nom: x.nom, wilaya: x.wilaya, etablissement: x.etablissement })),
      mouvement: segP.mouvement, cycleComparaison: segP.cycleComparaison,
      decideurs: segP.praticiens.filter((x) => x.h).sort((a, b) => a.vus - b.vus || a.nom.localeCompare(b.nom, "fr")).slice(0, 40)
        .map((x) => ({ doctorId: x.doctorId, nom: x.nom, etablissement: x.etablissement, requis: x.requis, vus: x.vus })),
    };
  }

  // ── La voix du terrain : les comptes rendus des 60 derniers jours, rangés par mots-clés (sans appel au modèle) ──
  const rapports = (visites ?? []).filter((v) => v.rapport && v.date.getTime() >= maintenant.getTime() - 60 * JOUR)
    .map((v) => ({ id: v.visitId, texte: texteDuRapport(v.rapport!), delegateId: v.delegateId }));
  const voix = visites ? regrouperParMotsCles(rapports, 60, maintenant) : null;

  // ── Marketing ──
  const deleguesAssignes = priorites?.length ?? 0;
  const blocMarketing: Fiche360["marketing"] = messagesRef || materiel ? {
    messages: messagesRef ? messagesRef.map((m) => {
      const ls = (portes ?? []).filter((x) => x.messageId === m.id);
      return { id: m.id, titre: m.title, actif: m.isActive, portes: ls.length, delegues: new Set(ls.map((x) => x.delegateId).filter(Boolean)).size };
    }).sort((a, b) => Number(b.actif) - Number(a.actif) || b.portes - a.portes) : null,
    deleguesAssignes, materiel,
  } : null;

  // ── Ad & Pro ──
  const adproP = adproMap ? adproMap.get(p.id) ?? { montant: 0, actions: [], postesSansMontant: 0 } : null;
  const blocAdPro: Fiche360["adpro"] = adproP ? {
    montant: adproP.montant, partHabPct: null, postesSansMontant: adproP.postesSansMontant,
    actions: adproP.actions.map((a) => {
      const lettres: Partial<Record<Lettre360, number>> = {};
      for (const d of a.doctorIds) { const l = lettreDe.get(d) ?? "NC"; lettres[l] = (lettres[l] ?? 0) + 1; }
      return { cle: a.cle, libelle: a.libelle, nature: libelleNatureAdPro(a.nature), date: ymd(a.date)!, montant: a.montant, href: a.href, lettres, medecins: a.doctorIds.length };
    }),
  } : null;

  // ── La synthèse : six chiffres, la note ──
  const s = synthese({
    stock: blocStock ? { unites: blocStock.unites, couvertureMois: blocStock.couvertureMois, hopitauxEnRupture } : null,
    lots: lotsMap ? lotsMap.get(p.id) ?? [] : null,
    seg: segP,
    visites: visites ? { cycle: visitesCycle!.length, precedent: visites.filter((v) => v.date >= fenetre.precedent.debut && v.date < fenetre.precedent.finExclue).length } : null,
    adpro: adproP,
    reglementaire: voit.reglementaire ? { dossiers: dossiers.length, joursAvantDepot: echeance?.joursAvantDepot ?? null, variationsEnAttente: variationsEnAttente.length } : null,
    pv: blocPv ? { gravitesOuvertes: pvOuverts.map((c) => c.gravite) } : null,
  });
  if (blocAdPro) blocAdPro.partHabPct = s.chiffres.adpro?.partHabPct ?? null;

  // ── À traiter ──
  const aTraiter: ASurveiller[] = [];
  const ruptures = blocStock?.lieux.filter((l) => l.rupture && l.cle.startsWith("HOSPITAL")) ?? [];
  const pchCentral = blocStock?.lieux.find((l) => l.lieu === "PCH central") ?? null;
  for (const l of ruptures.slice(0, 3)) {
    aTraiter.push({ ton: "danger", titre: `${l.lieu} : rupture relevée`, detail: `relevé du ${jourFr(l.date)}${pchCentral && pchCentral.quantite > 0 ? " · la PCH a du stock" : ""}`, href: "?onglet=stocks" });
  }
  const appro = voix?.groupes.find((g) => g.categorie === "APPROVISIONNEMENT");
  if (appro) {
    const v = visites?.find((x) => x.visitId === appro.citation?.rapportId);
    aTraiter.push({ ton: "danger", titre: "Rupture ou tension signalée", detail: `${appro.rapports} rapport${appro.rapports > 1 ? "s" : ""}${v?.delegue ? ` · dont ${v.delegue}` : ""}${pchCentral && pchCentral.quantite > 0 ? " · la PCH a du stock" : ""}`, href: "?onglet=prescripteurs" });
  }
  if (blocStock?.couvertureMois != null && blocStock.couvertureMois < 2) {
    aTraiter.push({ ton: "warning", titre: "Stock bas", detail: `${decimal(blocStock.couvertureMois)} mois · ${entier(blocStock.unites)} boîtes`, href: "?onglet=stocks" });
  }
  if (blocSeg?.hNonVus.length) {
    const parWilaya = new Map<string, number>();
    for (const h of blocSeg.hNonVus) parWilaya.set(h.wilaya ?? "wilaya inconnue", (parWilaya.get(h.wilaya ?? "wilaya inconnue") ?? 0) + 1);
    aTraiter.push({
      ton: "warning", titre: `${blocSeg.hNonVus.length} décideur${blocSeg.hNonVus.length > 1 ? "s" : ""} H non vu${blocSeg.hNonVus.length > 1 ? "s" : ""} ce cycle`,
      detail: [...parWilaya.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, n]) => (n > 1 ? `${w} (${n})` : w)).join(", "), href: "?onglet=prescripteurs",
    });
  }
  const lots = blocStock?.lots ?? [];
  if (lots.length) aTraiter.push({ ton: "warning", titre: `Lot ${lots[0].lot ?? "sans numéro"} périme en ${moisCourtDe(lots[0].peremption)}`, detail: `${entier(lots[0].quantite)} ${lots[0].unite}${lots.length > 1 ? ` · ${lots.length - 1} autre(s) lot(s) sous 6 mois` : ""}`, href: "?onglet=stocks" });
  for (const d of dossiers) {
    if (d.echeance && d.echeance.joursAvantDepot <= 365) {
      aTraiter.push({ ton: "info", titre: "Renouvellement de la DE", detail: `dossier à déposer avant le ${new Date(d.echeance.depotAvant).toLocaleDateString("fr-FR", { timeZone: "UTC" })}`, href: `/regulatory/${d.id}` });
    }
  }
  for (const v of variationsEnAttente.slice(0, 2)) aTraiter.push({ ton: "info", titre: "Variation en attente", detail: `${v.reference}${v.depot ? ` · déposée le ${new Date(v.depot).toLocaleDateString("fr-FR", { timeZone: "UTC" })}` : ""}`, href: `/regulatory/${v.dossierId}` });
  if (pvOuverts.length) {
    aTraiter.push({ ton: "danger", titre: pvOuverts.length === 1 ? "1 cas de pharmacovigilance ouvert" : `${pvOuverts.length} cas de pharmacovigilance ouverts`, detail: pvOuverts.slice(0, 3).map((c) => c.reference).join(" · "), href: pvOuverts[0].href });
  }
  // PRODUIT = DOSSIER : une identité incomplète est une INDICATION de qualité, avec le lien vers le dossier où elle se complète.
  for (const d of visibles) {
    const titre = titreACompleter(manquesIdentite({ dci: d.dci, dosage: d.dosage, dosageUnit: d.dosageUnit, form: d.pharmaceuticalForm, packaging: d.packaging }));
    if (titre) aTraiter.push({ ton: "info", titre, detail: `Dossier ${d.reference}`, href: `/regulatory/${d.id}` });
  }
  const ordreTon = { danger: 0, warning: 1, info: 2 } as const;
  aTraiter.sort((a, b) => ordreTon[a.ton] - ordreTon[b.ton]);

  // ── La chronologie ──
  const chrono: (Evenement360 & { t: number })[] = [];
  const ev = (d: Date | string | null, texte: string, ton: TonFiche, href: string | null = null) => {
    if (!d) return;
    const t = new Date(d).getTime();
    if (Number.isNaN(t) || t > maintenant.getTime() + JOUR || t < maintenant.getTime() - 400 * JOUR) return;
    chrono.push({ t, date: new Date(d).toISOString().slice(0, 10), texte, ton, href });
  };
  for (const l of blocStock?.lieux ?? []) ev(l.date, l.rupture ? `Rupture relevée — ${l.lieu}` : `Relevé de stock — ${l.lieu} · ${entier(l.quantite)} boîtes`, l.rupture ? "danger" : "neutral");
  for (const v of (visites ?? []).filter((x) => x.rapport).slice(0, 4)) ev(v.date, `Rapport de visite${v.delegue ? ` — ${v.delegue}` : ""}${v.medecin ? ` chez ${v.medecin}` : ""}`, "info");
  for (const m of messagesRef ?? []) ev(m.updatedAt, `Message « ${m.title} » ${m.updatedAt.getTime() - m.createdAt.getTime() > 60_000 ? "mis à jour" : "créé"}`, "success");
  for (const a of blocAdPro?.actions ?? []) ev(a.date, `${a.libelle} · ${montantCourt(a.montant)}${a.medecins ? ` · ${a.medecins} médecin${a.medecins > 1 ? "s" : ""}` : ""}`, "info", a.href);
  for (const d of dossiers) {
    ev(d.dateDecision, `Décision d'enregistrement — ${d.reference}`, "success", `/regulatory/${d.id}`);
    for (const v of d.variations) { ev(v.depot, `Variation déposée — ${d.reference}`, "warning", `/regulatory/${d.id}`); ev(v.decision, `Décision de variation — ${d.reference}`, "success", `/regulatory/${d.id}`); }
  }
  for (const c of blocPv ?? []) ev(c.survenu, `Cas de pharmacovigilance ${c.reference}`, c.statut === "CLOS" ? "neutral" : "danger", c.href);
  const chronologie = chrono.sort((a, b) => b.t - a.t).slice(0, 12).map((e) => ({ date: e.date, texte: e.texte, ton: e.ton, href: e.href }));

  // ── Les pastilles de l'en-tête ──
  const p1 = priorites ? priorites.filter((x) => x.position === 1).length : null;
  const pastilles: Fiche360["pastilles"] = {
    p1,
    messagesActifs: messagesRef ? messagesRef.filter((m) => m.isActive).length : null,
    echeance: echeance
      ? { texte: echeance.joursAvantDepot < 0 ? "dépôt du renouvellement DE en retard" : `renouvellement DE en ${moisCourtDe(echeance.expiration)}`, ton: echeance.joursAvantDepot <= 183 ? "warning" : "neutral" }
      : variationsEnAttente.length ? { texte: "variation en attente", ton: "info" } : null,
  };

  // ── Les faits que Luna peut citer : ceux que la personne voit, déjà calculés ──
  const faits: Fait360[] = [];
  const fait = (texte: string, source: string, priorite: number) => faits.push({ id: `F${faits.length + 1}`, texte, source, priorite });
  for (const l of ruptures.slice(0, 3)) fait(`${l.lieu} : 0 boîte au relevé du ${jourFr(l.date)}${pchCentral && pchCentral.quantite > 0 ? `, alors que la PCH centrale en a ${entier(pchCentral.quantite)}` : ""}.`, "Stocks", 0);
  const sousUnMois = blocStock?.lieux.filter((l) => l.cle.startsWith("HOSPITAL") && !l.rupture && l.mois !== null && l.mois < 1) ?? [];
  if (sousUnMois.length) fait(`${sousUnMois.length} hôpital(aux) sous un mois de stock : ${sousUnMois.slice(0, 3).map((l) => l.lieu).join(", ")}.`, "Stocks", 1);
  if (pvOuverts.length) fait(`${pvOuverts.length} cas de pharmacovigilance ouvert(s) : ${pvOuverts.slice(0, 3).map((c) => c.reference).join(", ")}.`, "Pharmacovigilance", 1);
  if (blocStock?.couvertureMois != null) fait(`Couverture du stock (PCH central + directions régionales + hôpitaux) : ${decimal(blocStock.couvertureMois)} mois.`, "Stocks", blocStock.couvertureMois < 2 ? 1 : 6);
  if (lots.length) fait(`Le lot ${lots[0].lot ?? "sans numéro"} (${entier(lots[0].quantite)} ${lots[0].unite}) périme en ${moisCourtDe(lots[0].peremption)}.`, "Stocks", 2);
  if (appro) fait(`${appro.rapports} rapport(s) de visite signalent une rupture ou une tension d'approvisionnement.`, "Terrain", 1);
  if (blocSeg?.hNonVus.length) fait(`${blocSeg.hNonVus.length} décideur(s) H non vu(s) ce cycle.`, "Terrain", 2);
  if (s.chiffres.cibles?.pct != null) fait(`${s.chiffres.cibles.pct} % des cibles H·A·B vues à fréquence ce cycle (${s.chiffres.cibles.vues} sur ${s.chiffres.cibles.cibles}).`, "Terrain", 4);
  if (segP?.mouvement && (segP.mouvement.bVersA || segP.mouvement.aPerdus)) fait(`Depuis l'ouverture du cycle : ${segP.mouvement.bVersA} médecin(s) passé(s) de B à A, ${segP.mouvement.aPerdus} A perdu(s).`, "Prescripteurs", 3);
  const objection = voix?.groupes.find((g) => g.categorie === "OBJECTION");
  if (objection?.citation) fait(`Objection relevée dans ${objection.rapports} rapport(s) : « ${objection.citation.texte}${objection.citation.coupe ? "…" : ""} ».`, "Terrain", 3);
  if (s.chiffres.visites) fait(`${s.chiffres.visites.cycle} visite(s) présentant le produit ce cycle${s.chiffres.visites.evolutionPct !== null ? ` (${s.chiffres.visites.evolutionPct >= 0 ? "+" : ""}${s.chiffres.visites.evolutionPct} % sur la même durée du cycle précédent)` : ""}.`, "Terrain", 5);
  if (echeance && echeance.joursAvantDepot <= 365) fait(`Renouvellement de la DE ${echeance.reference} à déposer avant le ${new Date(echeance.depotAvant).toLocaleDateString("fr-FR", { timeZone: "UTC" })}.`, "Réglementaire", echeance.joursAvantDepot <= 183 ? 2 : 5);
  if (variationsEnAttente.length) fait(`${variationsEnAttente.length} variation(s) en attente.`, "Réglementaire", 4);
  const peuPorte = blocMarketing?.messages?.filter((m) => m.actif && m.portes === 0) ?? [];
  if (peuPorte.length && deleguesAssignes) fait(`Message actif jamais porté ce cycle : « ${peuPorte[0].titre} ».`, "Marketing", 4);
  if (blocAdPro && blocAdPro.montant > 0) fait(`Ad & Pro sur 12 mois : ${montantCourt(blocAdPro.montant)} DZD${blocAdPro.partHabPct !== null ? `, dont ${blocAdPro.partHabPct} % sur des cibles H·A·B` : ""}.`, "Ad & Pro", 6);

  const bus = [...new Map(p.promoProfiles.filter((x) => x.businessUnit).map((x) => [x.businessUnit!.id, x.businessUnit!.name])).entries()].map(([id, nom]) => ({ id, nom }));
  const decision = dossiers.filter((d) => d.dateDecision).sort((a, b) => a.dateDecision!.localeCompare(b.dateDecision!))[0] ?? null;

  return {
    identite: {
      id: p.id, code: p.code, nom: p.canonicalName, dci: p.dci, dosage: texteDosage(p), forme: texteForme(p.form), conditionnement: p.packaging,
      societe: p.company?.shortName ?? p.company?.name ?? null,
      etape: etapeCycle({ lifecycle: p.lifecycle, isActive: p.isActive, statutsDossiers: dossiersNonVerrouilles.map((r) => r.status as string) }),
      lifecycle: p.lifecycle, isActive: p.isActive, alias: p.aliases.map((a) => a.label),
      decision: decision ? { date: decision.dateDecision!, reference: decision.reference } : null,
    },
    bus, dossiers,
    declarationsInfoMed: declarations
      ? declarations.map((d) => ({
          id: d.id, reference: d.reference, label: d.label, statut: d.status, date: ymd(d.createdAt)!,
          nature: isDeclarationKind(d.declarationKind) ? DECLARATION_KIND_LABEL[d.declarationKind] : (ENTITY_TYPE_LABELS[d.sourceType] ?? d.sourceType),
        }))
      : null,
    dossiersMasques: voit.reglementaire ? Math.max(0, p.regulatoryProfiles.length - dossiers.length) : 0,
    sante: s.sante, chiffres: s.chiffres, pastilles,
    cycle: { debut: ymd(fenetre.debut)!, fin: ymd(fenetre.fin)!, source: fenetre.source },
    stock: blocStock, terrain: blocTerrain, segmentation: blocSeg, voix, marketing: blocMarketing, adpro: blocAdPro, pv: blocPv,
    aTraiter, chronologie, faits,
  };
}
