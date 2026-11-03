import { prisma } from "@/lib/prisma";
import { userCan, hasGlobalView, peutDemanderEtatStock, type SessionUser } from "@/lib/rbac";
import {
  TYPES_HOSPITALIERS, couvertureDepuisAffectations, avancementGlobal, avancementParKam, consolider, ligneRemplie,
  type AffectationKam, type PorteurKam, type AvancementKam, type AvancementGlobal, type Matrice,
} from "@/lib/stocks/demande-stocks";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDES DE STOCKS (DO → KAM) — les chargeurs. La DÉCISION vit dans `lib/stocks/demande-stocks.ts`
 * (pur) ; ici on lit les FAITS : affectations de secteur, fiches force de vente, produits des BU,
 * établissements candidats, demandes et leurs lignes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * QUI LANCE ET PILOTE une demande de stocks : la règle de « Demander un état de stock »
 * (`canRequestStockState` — chaîne d'approvisionnement, vue globale, Super Admin), pas une seconde.
 * Le directeur des opérations l'a (PCH et STOCKS en gestion).
 */
export function peutPiloterDemandesStocks(user: SessionUser): boolean {
  return peutDemanderEtatStock(user);
}

/** Ce que les règles de stock (`lib/stocks/scopes.ts`, pures) savent d'une personne — un seul endroit pour le construire. */
export function lecteurDeStocks(user: SessionUser) {
  return {
    canSeeSupplyChain: userCan(user, "PCH", "VIEW"),
    hasGlobalView: hasGlobalView(user),
    isSuperAdmin: user.role === "SUPER_ADMIN",
    roles: [user.role, user.secondaryRole],
  };
}

export interface CouvertureKams {
  couverture: Map<string, PorteurKam[]>;
  produitsParBu: Record<string, string[]>;
  noms: Map<string, string>;
}

/**
 * QUI PORTE QUOI — les affectations ACTIVES (secteur actif, BU active, compte actif), lues comme
 * `chargerPorteeStock` les lit pour un KAM, mais pour TOUS à la fois.
 */
export async function chargerCouvertureKams(): Promise<CouvertureKams> {
  const affectations = await prisma.salesSectorRep.findMany({
    where: { rep: { isActive: true }, sector: { isActive: true, businessUnit: { isActive: true } } },
    select: {
      repId: true,
      rep: { select: { name: true } },
      sector: { select: { businessUnitId: true, institutions: { select: { institutionId: true } } } },
    },
  });
  const repIds = [...new Set(affectations.map((a) => a.repId))];
  const [profils, produits] = await Promise.all([
    repIds.length
      ? prisma.salesRepProfile.findMany({ where: { repId: { in: repIds } }, select: { repId: true, businessUnitId: true } })
      : Promise.resolve([] as { repId: string; businessUnitId: string | null }[]),
    prisma.promoProduct.findMany({
      where: { isActive: true, regulatoryProductId: { not: null }, businessUnitId: { not: null }, businessUnit: { isActive: true } },
      select: { businessUnitId: true, regulatoryProductId: true },
    }),
  ]);
  const buDuKam = new Map(profils.map((p) => [p.repId, p.businessUnitId ?? null]));
  const entrees: AffectationKam[] = affectations.map((a) => ({
    kamId: a.repId,
    buDuKam: buDuKam.get(a.repId) ?? null,
    buDuSecteur: a.sector.businessUnitId,
    institutionIds: a.sector.institutions.map((i) => i.institutionId),
  }));
  const produitsParBu: Record<string, string[]> = {};
  for (const p of produits) {
    if (!p.businessUnitId || !p.regulatoryProductId) continue;
    const liste = (produitsParBu[p.businessUnitId] ??= []);
    if (!liste.includes(p.regulatoryProductId)) liste.push(p.regulatoryProductId);
  }
  return {
    couverture: couvertureDepuisAffectations(entrees),
    produitsParBu,
    noms: new Map(affectations.map((a) => [a.repId, a.rep.name])),
  };
}

export interface HopitalCandidat {
  id: string;
  name: string;
  wilaya: string | null;
}

/**
 * LES ÉTABLISSEMENTS PROPOSÉS — et donc « tous » quand le DO n'en coche aucun : les établissements
 * actifs de type hospitalier, ceux qu'un secteur actif couvre, et ceux qui ont déjà un lieu de stock.
 */
export async function chargerHopitauxCandidats(): Promise<HopitalCandidat[]> {
  const rows = await prisma.medicalInstitution.findMany({
    where: {
      isActive: true,
      OR: [
        { type: { in: [...TYPES_HOSPITALIERS] } },
        { sectors: { some: { sector: { isActive: true } } } },
        { stockLocation: { isNot: null } },
      ],
    },
    select: { id: true, name: true, wilaya: true },
  });
  return rows.sort((a, b) => (a.wilaya ?? "~").localeCompare(b.wilaya ?? "~", "fr") || a.name.localeCompare(b.name, "fr"));
}

// ── LES LISTES ─────────────────────────────────────────────────────────────────────────────

export interface DemandeResumeDTO {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  createdAt: string;
  auteur: string | null;
  hopitaux: number;
  kams: number;
  envoyes: number;
  lignes: number;
  remplies: number;
}

/** Les demandes, côté pilotage (qui peut réquisitionner) — les plus récentes d'abord. */
export async function chargerDemandesStocks(): Promise<DemandeResumeDTO[]> {
  const demandes = await prisma.stockCountRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, title: true, status: true, dueDate: true, createdAt: true,
      createdBy: { select: { name: true } },
      _count: { select: { hopitaux: true } },
      destinataires: { select: { submittedAt: true } },
    },
  });
  if (demandes.length === 0) return [];
  const ids = demandes.map((d) => d.id);
  const [totaux, remplies] = await Promise.all([
    prisma.stockCountRequestLine.groupBy({ by: ["requestId"], where: { requestId: { in: ids }, NOT: { kamIds: { isEmpty: true } } }, _count: { _all: true } }),
    prisma.stockCountRequestLine.groupBy({
      by: ["requestId"],
      where: { requestId: { in: ids }, NOT: { kamIds: { isEmpty: true } }, OR: [{ quantity: { not: null } }, { rupture: true }] },
      _count: { _all: true },
    }),
  ]);
  const t = new Map(totaux.map((x) => [x.requestId, x._count._all]));
  const r = new Map(remplies.map((x) => [x.requestId, x._count._all]));
  return demandes.map((d) => ({
    id: d.id, title: d.title, status: d.status,
    dueDate: d.dueDate?.toISOString() ?? null, createdAt: d.createdAt.toISOString(),
    auteur: d.createdBy?.name ?? null,
    hopitaux: d._count.hopitaux,
    kams: d.destinataires.length,
    envoyes: d.destinataires.filter((x) => x.submittedAt).length,
    lignes: t.get(d.id) ?? 0,
    remplies: r.get(d.id) ?? 0,
  }));
}

export interface MaDemandeDTO {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  createdAt: string;
  auteur: string | null;
  envoyeLe: string | null;
  lignes: number;
  remplies: number;
}

/** Les demandes adressées à ce KAM. */
export async function chargerMesDemandesStocks(kamId: string): Promise<MaDemandeDTO[]> {
  const recues = await prisma.stockCountRequestRecipient.findMany({
    where: { kamId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      submittedAt: true,
      request: { select: { id: true, title: true, status: true, dueDate: true, createdAt: true, createdBy: { select: { name: true } } } },
    },
  });
  if (recues.length === 0) return [];
  const ids = recues.map((x) => x.request.id);
  const lignes = await prisma.stockCountRequestLine.findMany({
    where: { requestId: { in: ids }, kamIds: { has: kamId } },
    select: { requestId: true, quantity: true, rupture: true },
  });
  return recues.map((x) => {
    const siennes = lignes.filter((l) => l.requestId === x.request.id);
    return {
      id: x.request.id, title: x.request.title, status: x.request.status,
      dueDate: x.request.dueDate?.toISOString() ?? null, createdAt: x.request.createdAt.toISOString(),
      auteur: x.request.createdBy?.name ?? null,
      envoyeLe: x.submittedAt?.toISOString() ?? null,
      lignes: siennes.length,
      remplies: siennes.filter((l) => ligneRemplie({ quantite: l.quantity, rupture: l.rupture })).length,
    };
  });
}

// ── LE DÉTAIL ──────────────────────────────────────────────────────────────────────────────

export interface LigneDTO {
  id: string;
  hopitalId: string;
  institutionId: string | null;
  productId: string | null;
  productLabel: string;
  kamIds: string[];
  quantite: number | null;
  rupture: boolean;
  savedAt: string | null;
  savedBy: string | null;
}

export interface HopitalDTO {
  id: string;
  institutionId: string | null;
  name: string;
  wilaya: string | null;
  tousProduits: boolean;
  sansKam: boolean;
  note: string | null;
}

export interface DestinataireDTO {
  kamId: string;
  nom: string;
  envoyeLe: string | null;
  relanceLe: string | null;
  relances: number;
}

export interface DemandeDetailDTO {
  id: string;
  title: string;
  status: string;
  notes: string | null;
  dueDate: string | null;
  createdAt: string;
  closedAt: string | null;
  toutHopitaux: boolean;
  createdById: string | null;
  auteur: string | null;
  hopitaux: HopitalDTO[];
  lignes: LigneDTO[];
  destinataires: DestinataireDTO[];
}

export async function chargerDemandeStocks(id: string): Promise<DemandeDetailDTO | null> {
  const d = await prisma.stockCountRequest.findUnique({
    where: { id },
    select: {
      id: true, title: true, status: true, notes: true, dueDate: true, createdAt: true, closedAt: true, toutHopitaux: true,
      createdById: true, createdBy: { select: { name: true } },
      hopitaux: { select: { id: true, institutionId: true, name: true, wilaya: true, tousProduits: true, sansKam: true, note: true } },
      lignes: {
        select: { id: true, hospitalId: true, productId: true, productLabel: true, kamIds: true, quantity: true, rupture: true, savedAt: true, savedById: true, hospital: { select: { institutionId: true } } },
        orderBy: { productLabel: "asc" },
      },
      destinataires: { select: { kamId: true, submittedAt: true, remindedAt: true, remindCount: true, kam: { select: { name: true } } } },
    },
  });
  if (!d) return null;
  const auteursSaisie = [...new Set(d.lignes.map((l) => l.savedById).filter((x): x is string => !!x))];
  const noms = new Map((auteursSaisie.length
    ? await prisma.user.findMany({ where: { id: { in: auteursSaisie } }, select: { id: true, name: true } })
    : []).map((u) => [u.id, u.name]));
  const hopitaux = [...d.hopitaux].sort((a, b) => (a.wilaya ?? "~").localeCompare(b.wilaya ?? "~", "fr") || a.name.localeCompare(b.name, "fr"));
  return {
    id: d.id, title: d.title, status: d.status, notes: d.notes,
    dueDate: d.dueDate?.toISOString() ?? null, createdAt: d.createdAt.toISOString(), closedAt: d.closedAt?.toISOString() ?? null,
    toutHopitaux: d.toutHopitaux, createdById: d.createdById, auteur: d.createdBy?.name ?? null,
    hopitaux,
    lignes: d.lignes.map((l) => ({
      id: l.id, hopitalId: l.hospitalId, institutionId: l.hospital.institutionId, productId: l.productId, productLabel: l.productLabel,
      kamIds: l.kamIds, quantite: l.quantity, rupture: l.rupture,
      savedAt: l.savedAt?.toISOString() ?? null, savedBy: l.savedById ? noms.get(l.savedById) ?? null : null,
    })),
    destinataires: d.destinataires
      .map((x) => ({ kamId: x.kamId, nom: x.kam.name, envoyeLe: x.submittedAt?.toISOString() ?? null, relanceLe: x.remindedAt?.toISOString() ?? null, relances: x.remindCount }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
  };
}

export interface SuiviDemande {
  global: AvancementGlobal;
  parKam: (AvancementKam & { nom: string; relanceLe: string | null; relances: number })[];
  matrice: Matrice;
}

/** L'avancement et le tableau consolidé — calculés par le module pur, sur les lignes chargées. */
export function suiviDemande(d: DemandeDetailDTO): SuiviDemande {
  const etats = d.lignes.map((l) => ({ hopitalId: l.hopitalId, productId: l.productId, productLabel: l.productLabel, kamIds: l.kamIds, quantite: l.quantite, rupture: l.rupture }));
  const parKam = avancementParKam(etats, d.destinataires.map((x) => ({ kamId: x.kamId, envoyeLe: x.envoyeLe })))
    .map((a) => {
      const dest = d.destinataires.find((x) => x.kamId === a.kamId)!;
      return { ...a, nom: dest.nom, relanceLe: dest.relanceLe, relances: dest.relances };
    });
  return { global: avancementGlobal(etats), parKam, matrice: consolider(d.hopitaux, etats) };
}
