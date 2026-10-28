import { prisma } from "@/lib/prisma";
import { loadReportingLine } from "@/lib/departments";
import { subtreeOf, flattenTree } from "@/modules/rh/partage";
import { userCan, moduleScope, rolesWithModule, anyRoleFilter, getAccess, type SessionUser } from "@/lib/rbac";
import { suppressionPermise } from "@/lib/suppression/delegation";
import { companyScopedWhere, getMyCompanies, companyOptions } from "@/lib/company";
import { cheffesMarketingActuelles } from "@/lib/queries/promo-circuit";
import { ROLES_DIRECTEUR_DES_OPERATIONS } from "@/lib/promo-material/validateurs";
import { familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import {
  cleDetenteur, etatValidite, libelleArticleStock, KINDS_ANNULABLES, MAGASIN, type EtatValidite, type MovementKind, type NatureTransfert,
} from "@/lib/promo/stock";
import {
  peutAnnulerMouvement, peutEntrerAlaMain, peutGererArticles, peutVoirStockDe, tientLeMagasin, type FaitsStock,
} from "@/lib/promo/stock-acces";
import {
  alertesDuStock, comptageEnRetard, estDormant, peutDemanderComptage, peutDeciderRefonte, peutVoirComptage,
  peutVoirTableauDeBord, valeurDuStock, JOURS_TABLEAU,
  type CibleComptage, type FrequenceComptage, type GenreAlerte, type StatutComptage, type StatutRefonte,
} from "@/lib/promo/comptages";
import { chargerFaitsAlertes } from "@/lib/queries/promo-stock-alertes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE STOCK PROMOTIONNEL, TEL QUE CETTE PERSONNE A LE DROIT DE LE VOIR (§118.164).
 *
 * Les SOLDES se calculent en base (somme par article, lot et détenteur) — jamais en additionnant
 * une liste bornée. Le JOURNAL, lui, est borné, et le DIT : il montre les derniers mouvements et
 * compte ceux qu'il ne montre pas. Un solde exact à côté d'un historique tronqué en silence se
 * lirait comme un historique complet.
 *
 * Ce que la personne ne peut pas voir n'est pas CHARGÉ, pas seulement masqué : un délégué ne
 * reçoit dans sa page ni le magasin ni le stock d'un collègue.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** L'ÉQUIPE : l'arbre de l'organigramme sous la personne, plus les KAM des gammes qu'elle supervise. */
export async function equipeDe(userId: string): Promise<Set<string>> {
  const [me, gammes] = await Promise.all([
    prisma.employee.findUnique({ where: { userId }, select: { id: true } }),
    prisma.businessUnit.findMany({ where: { supervisorId: userId }, select: { id: true } }),
  ]);
  const ids = new Set<string>();
  if (me) {
    const { employees, departments } = await loadReportingLine();
    for (const n of flattenTree(subtreeOf(me.id, employees, departments))) if (n.userId) ids.add(n.userId);
  }
  if (gammes.length) {
    const kam = await prisma.salesRepProfile.findMany({ where: { businessUnitId: { in: gammes.map((g) => g.id) } }, select: { repId: true } });
    for (const k of kam) ids.add(k.repId);
  }
  ids.delete(userId);
  return ids;
}

/** LES FAITS d'une personne pour la règle du stock — établis une fois par requête. */
export async function faitsStock(user: SessionUser): Promise<FaitsStock> {
  const superAdmin = user.role === "SUPER_ADMIN";
  const roles = [user.role, user.secondaryRole ?? null];
  const [cheffes, equipe] = await Promise.all([cheffesMarketingActuelles(), equipeDe(user.id)]);
  return {
    userId: user.id,
    superAdmin,
    module: {
      voir: superAdmin || userCan(user, "PROMO_STOCK", "VIEW"),
      creer: superAdmin || userCan(user, "PROMO_STOCK", "CREATE"),
      modifier: superAdmin || userCan(user, "PROMO_STOCK", "UPDATE"),
      // Le bouton commun de suppression (corbeille) — la MÊME règle que l'action (`suppressionPermise`).
      supprimer: suppressionPermise(user, "PROMO_STOCK_ITEM"),
    },
    vueGlobale: superAdmin || moduleScope(user, "PROMO_STOCK") === "ALL",
    gereLeMagasin: superAdmin || cheffes.includes(user.id),
    directeurDesOperations: roles.some((r) => r != null && (ROLES_DIRECTEUR_DES_OPERATIONS as readonly string[]).includes(r)),
    equipe,
  };
}

/**
 * QUI TIENT LE MAGASIN, pour le prévenir (un retour arrive, une demande attend, une réception
 * traîne) : la cheffe de la Direction Marketing lue sur l'organigramme, à défaut les Super Admins.
 * Une seule lecture — les actions et le rappel du battement prévenaient sinon deux listes.
 */
export async function gestionnairesDuMagasin(): Promise<string[]> {
  const cheffes = await cheffesMarketingActuelles();
  if (cheffes.length) return cheffes;
  const sa = await prisma.user.findMany({ where: { role: "SUPER_ADMIN", isActive: true }, select: { id: true } });
  return sa.map((u) => u.id);
}

/**
 * La personne peut-elle RECEVOIR du stock — ou un comptage ? Il lui faut le module : sans lui, elle
 * ne pourrait ni confirmer la réception ni saisir son comptage, et la demande attendrait pour
 * toujours quelqu'un qui ne la voit pas. Le refus nomme le GESTE qu'elle ne pourrait pas faire.
 */
export async function peutRecevoirDuStock(userId: string, geste = "confirmer la réception"): Promise<{ ok: true; nom: string } | { ok: false; error: string }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isActive: true } });
  if (!u || !u.isActive) return { ok: false, error: "Destinataire introuvable ou inactif." };
  const acces = await getAccess(u.id, u.role);
  if (u.role !== "SUPER_ADMIN" && !acces.modules.get("PROMO_STOCK")?.actions.has("VIEW")) {
    return { ok: false, error: `${u.name} n'a pas accès au stock promotionnel, donc ne pourrait pas ${geste}. Un Super Admin lui ouvre le module dans Administration › Accès.` };
  }
  return { ok: true, nom: u.name };
}

/**
 * LES FAITS D'UNE PERSONNE QUI N'EST PAS CONNECTÉE — l'auteur d'une récurrence, relu au moment où
 * elle se déclenche (§118.168, sur le modèle de §118.119). `null` : compte supprimé ou inactif —
 * il n'y a plus d'autorité du tout, et rien ne part « au nom de personne ».
 */
export async function faitsStockDe(userId: string): Promise<FaitsStock | null> {
  const u = await prisma.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true, role: true, secondaryRole: true } });
  if (!u) return null;
  const session: SessionUser = { id: u.id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(u.id, u.role) };
  return faitsStock(session);
}

/** Les personnes à qui l'on peut transférer : rôles porteurs du module, plus les accès donnés nommément. */
export async function destinatairesPossibles(): Promise<{ id: string; nom: string }[]> {
  const [parRole, parConsole, retires] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(rolesWithModule("PROMO_STOCK")) }, select: { id: true, name: true } }),
    prisma.userAccess.findMany({ where: { module: "PROMO_STOCK", canView: true, user: { isActive: true } }, select: { user: { select: { id: true, name: true } } } }),
    prisma.userAccess.findMany({ where: { module: "PROMO_STOCK", canView: false }, select: { userId: true } }),
  ]);
  const exclus = new Set(retires.map((r) => r.userId));
  const tous = new Map<string, string>();
  for (const u of parRole) if (!exclus.has(u.id)) tous.set(u.id, u.name);
  for (const a of parConsole) tous.set(a.user.id, a.user.name);
  return [...tous].map(([id, nom]) => ({ id, nom })).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

export interface LotVue {
  id: string;
  numero: number;
  origine: string;
  recuLe: string;
  coutUnitaire: number | null;
  valableJusquau: string | null;
  libelle: string | null;
  etat: EtatValidite;
}

export interface SoldeVue {
  /** `null` = le magasin central. */
  detenteurId: string | null;
  quantite: number;
  parLot: { lotId: string; quantite: number }[];
}

export interface MouvementVue {
  id: string;
  kind: MovementKind;
  delta: number;
  detenteurId: string | null;
  lotNumero: number;
  motif: string | null;
  recipient: string | null;
  occurredAt: string;
  par: string | null;
  annule: boolean;
  annulable: boolean;
}

export interface ArticleVue {
  id: string;
  companyId: string | null;
  societe: string | null;
  catalogue: { id: string; reference: string; nom: string; famille: PromoFamille; unite: string };
  produits: { id: string; nom: string }[];
  libelle: string;
  location: string | null;
  alertThreshold: number | null;
  notes: string | null;
  isActive: boolean;
  lots: LotVue[];
  /** Les soldes que CETTE personne a le droit de voir, détenteur par détenteur. */
  soldes: SoldeVue[];
  /** Total visible (somme des soldes ci-dessus) ; `total` n'est rempli qu'en vue globale. */
  visible: number;
  total: number | null;
  enRoute: number;
  journal: MouvementVue[];
  /** Combien de mouvements visibles le journal ne montre pas. */
  journalNonAffiche: number;
}

export interface SupportVue {
  id: string;
  companyId: string | null;
  catalogue: { reference: string; nom: string };
  produits: string[];
  libelle: string;
  lien: string | null;
  valableJusquau: string | null;
  etat: EtatValidite;
  isActive: boolean;
  notes: string | null;
}

export interface TransfertVue {
  id: string;
  itemId: string;
  libelle: string;
  nature: NatureTransfert;
  deId: string | null;
  versId: string | null;
  quantite: number;
  quantiteRecue: number | null;
  statut: "EN_ROUTE" | "RECU" | "REFUSE" | "ANNULE";
  note: string | null;
  noteDecision: string | null;
  initiateurId: string;
  createdAt: string;
  decideLe: string | null;
}

export interface DemandeVue {
  id: string;
  itemId: string;
  libelle: string;
  demandeurId: string;
  quantite: number;
  note: string | null;
  statut: "OUVERTE" | "SERVIE" | "REFUSEE" | "ANNULEE";
  noteDecision: string | null;
  createdAt: string;
}

/**
 * CE QU'UN MÉDECIN A REÇU (§118.166) — net des corrections, par article, avec qui l'a remis. Ne
 * compte que les remises que la personne a le droit de voir (les mêmes détenteurs que le journal) :
 * un délégué voit ce que LUI a remis, un directeur des opérations ce que son équipe a remis.
 */
export interface RemiseMedecinVue {
  doctorId: string;
  medecin: string;
  institution: string | null;
  articles: { itemId: string; libelle: string; quantite: number }[];
  /** Les délégués qui ont remis (identifiants — les noms sont dans `personnes`). */
  delegues: string[];
  /** Le dernier mouvement (remise ou correction) pour ce médecin. */
  dernier: string;
}

/**
 * LES FAITS, tels que l'écran les reçoit — l'équipe en liste plutôt qu'en ensemble (sérialisable).
 *
 * L'écran ne reçoit PAS des drapeaux « peut doter », « peut corriger » calculés ici : il reçoit les
 * FAITS et appelle les MÊMES prédicats purs que les actions (`promo/stock-acces.ts`). Deux listes
 * de droits — une pour l'écran, une pour l'action — finiraient par diverger, et le symptôme serait
 * un bouton que l'action refuse, ou une action ouverte que l'écran cache (§118.5, §118.71).
 */
export interface FaitsStockEcran extends Omit<FaitsStock, "equipe"> {
  equipe: string[];
}

export interface PageStock {
  moi: string;
  maintenant: string;
  faits: FaitsStockEcran;
  articles: ArticleVue[];
  supports: SupportVue[];
  transferts: TransfertVue[];
  demandes: DemandeVue[];
  personnes: Record<string, string>;
  equipe: { id: string; nom: string }[];
  destinataires: { id: string; nom: string }[];
  /** Pour les saisies du magasin et du Super Admin. */
  catalogue: { id: string; reference: string; nom: string; famille: PromoFamille; unite: string; exigeProduit: boolean }[];
  produitsOptions: { id: string; nom: string }[];
  societes: { value: string; label: string }[];
  /** Articles demandables (noms seulement — un délégué ne lit pas le solde du magasin). */
  demandables: { id: string; libelle: string }[];
  /** Ce que chaque médecin a reçu, dans le périmètre de la personne (§118.166). */
  remisesAuxMedecins: RemiseMedecinVue[];
  /** Combien de médecins la liste ne montre pas (bornée, et elle le DIT). */
  remisesNonAffichees: number;
  /**
   * LE MATÉRIEL SORTI POUR DES ÉVÉNEMENTS (§118.167) — réservé à l'accord d'un poste Ad & Pro, pas
   * encore confirmé. Il a quitté le solde du magasin sans être chez personne : sans cette liste, la
   * personne qui tient le magasin verrait des kakémonos disparaître sans savoir où ils sont.
   * Chargé seulement pour qui voit le magasin.
   */
  horsMagasin: HorsMagasinVue[];
  /**
   * CE QUI A ÉTÉ REMIS LORS DES OPÉRATIONS AD & PRO (§118.173) — la seconde porte du matériel vers
   * les médecins, à côté des visites : un poste « Matériel du stock » confirmé après l'événement dit
   * combien a été remis. Ces quantités sortent du MAGASIN : `null` pour qui ne le voit pas (l'écran
   * ne montre alors pas la section, plutôt qu'une liste vide qui se lirait « rien n'a été remis »).
   */
  remisesOperations: RemiseOperationVue[] | null;
  /** Combien de remises la liste ne montre pas (bornée, et elle le DIT). */
  remisesOperationsNonAffichees: number;
  /** LES COMPTAGES que la personne voit — à faire, demandés par elle, de son équipe (§118.168). */
  comptages: ComptageVue[];
  /** Les comptages récurrents qu'elle a posés (tous, pour le Super Admin et la vue globale). */
  recurrences: RecurrenceVue[];
  /** Les propositions de refonte de supports durables qu'elle voit. */
  refontes: RefonteVue[];
  /** Le tableau de bord — chargé seulement pour qui a le droit de le voir. */
  tableau: TableauVue | null;
  /** Les personnes à qui elle peut demander un comptage (son équipe, au sens de la règle). */
  peutFaireCompter: { id: string; nom: string }[];
}

export interface ComptageVue {
  id: string;
  /** `null` = le magasin central. */
  holderId: string | null;
  famille: PromoFamille | null;
  demandeurId: string;
  recurrenceId: string | null;
  statut: StatutComptage;
  echeance: string;
  enRetard: boolean;
  note: string | null;
  createdAt: string;
  saisiLe: string | null;
  saisiParId: string | null;
  annuleMotif: string | null;
  /** La dernière correction de la saisie (§118.190, R19). */
  corrigeLe: string | null;
  corrigeParId: string | null;
  corrigeMotif: string | null;
  lignes: { itemId: string; libelle: string; attendu: number; compte: number; ecart: number }[];
}

export interface RecurrenceVue {
  id: string;
  cible: CibleComptage;
  holderId: string | null;
  famille: PromoFamille | null;
  frequence: FrequenceComptage;
  prochaineLe: string;
  delaiJours: number;
  note: string | null;
  auteurId: string | null;
  actif: boolean;
  pauseMotif: string | null;
  derniereLe: string | null;
  nbDeclenchements: number;
}

export interface RefonteVue {
  id: string;
  itemId: string;
  libelle: string;
  auteurId: string;
  motif: string;
  statut: StatutRefonte;
  decideParId: string | null;
  decideLe: string | null;
  noteDecision: string | null;
  createdAt: string;
}

export interface TableauVue {
  fenetreJours: number;
  /** La valeur du stock VISIBLE — les unités sans coût sont comptées à part, jamais à zéro. */
  valeur: { valeur: number; unitesValorisees: number; unitesSansCout: number };
  parFamille: { famille: "CONSOMMABLE" | "DURABLE"; valeur: number; unites: number }[];
  /** Ce qui est sorti sur la fenêtre, net des corrections. */
  consommation: { remisMedecins: number; remisEvenements: number; pertes: number; ecartsComptage: number };
  topConsommes: { itemId: string; libelle: string; quantite: number; unite: string }[];
  /** Les plus gros dormants, bornés pour l'écran — `dormantsTotal` dit combien il y en a en tout. */
  dormants: { itemId: string; libelle: string; quantite: number; unite: string; derniereSortie: string | null; valeur: number | null }[];
  /** Une liste coupée se lit comme exhaustive si elle ne dit pas ce qu'elle tait (§118.60). */
  dormantsTotal: number;
  alertes: { cle: string; genre: GenreAlerte; texte: string; lien: string }[];
}

export interface HorsMagasinVue {
  ligneId: string;
  itemId: string;
  libelle: string;
  quantite: number;
  /** La demande qui l'a emporté — sa référence (ou son nom), et où l'ouvrir. */
  demande: string;
  lien: string;
  depuis: string | null;
}

export interface RemiseOperationVue {
  ligneId: string;
  itemId: string;
  libelle: string;
  /** Ce qui a été REMIS pendant l'événement — le reste est revenu au magasin par la même écriture. */
  quantite: number;
  demande: string;
  lien: string;
  confirmeeLe: string | null;
  confirmeeParId: string | null;
}

const JOURNAL_PAR_ARTICLE = 40;
const MEDECINS_AFFICHES = 300;
const OPERATIONS_AFFICHEES = 100;

/** La demande qui porte un poste Ad & Pro — sa référence (ou son nom), et où l'ouvrir. */
function demandeDuPoste(it: {
  sponsoringId: string | null; eventId: string | null; congressNationalId: string | null; congressInternationalId: string | null;
  sponsoring: { reference: string } | null; event: { name: string } | null;
  congressNational: { name: string } | null; congressInternational: { name: string } | null;
}): [string, string] {
  return it.sponsoringId ? [it.sponsoring?.reference ?? "Sponsoring", `/sponsoring/${it.sponsoringId}`]
    : it.eventId ? [it.event?.name ?? "Événement", `/events/${it.eventId}`]
    : it.congressNationalId ? [it.congressNational?.name ?? "Congrès national", `/congress-national/${it.congressNationalId}`]
    : [it.congressInternational?.name ?? "Congrès international", `/congress-international/${it.congressInternationalId ?? ""}`];
}

const SELECT_POSTE = {
  sponsoringId: true, eventId: true, congressNationalId: true, congressInternationalId: true,
  sponsoring: { select: { reference: true } }, event: { select: { name: true } },
  congressNational: { select: { name: true } }, congressInternational: { select: { name: true } },
} as const;

export async function chargerPageStock(user: SessionUser, maintenant = new Date()): Promise<PageStock> {
  const f = await faitsStock(user);
  const voirMagasin = peutVoirStockDe(f, null);

  // Les articles de la société (cloisonnement d'entité), actifs ou archivés.
  const items = await prisma.promoStockItem.findMany({
    where: await companyScopedWhere(user.id, {}),
    select: {
      id: true, companyId: true, company: { select: { name: true } }, location: true, alertThreshold: true, notes: true,
      isActive: true, lien: true, valableJusquau: true,
      catalogue: { select: { id: true, reference: true, nom: true, famille: true, unite: true } },
      produits: { select: { product: { select: { id: true, canonicalName: true } } } },
      lots: { select: { id: true, numero: true, origine: true, recuLe: true, coutUnitaire: true, valableJusquau: true, libelle: true }, orderBy: { numero: "asc" } },
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  const itemIds = items.map((i) => i.id);

  // Quels détenteurs cette personne voit-elle ? `null` dans la liste = le magasin.
  const detenteursVisibles = (h: string | null): boolean => peutVoirStockDe(f, h);

  const [sommes, enRoute, transferts, demandes] = await Promise.all([
    itemIds.length
      ? prisma.promoStockMovement.groupBy({ by: ["itemId", "holderId", "lotId"], where: { itemId: { in: itemIds } }, _sum: { delta: true } })
      : Promise.resolve([] as { itemId: string; holderId: string | null; lotId: string; _sum: { delta: unknown } }[]),
    itemIds.length
      ? prisma.promoStockTransfer.groupBy({ by: ["itemId"], where: { itemId: { in: itemIds }, statut: "EN_ROUTE" }, _sum: { quantite: true } })
      : Promise.resolve([] as { itemId: string; _sum: { quantite: unknown } }[]),
    itemIds.length
      ? prisma.promoStockTransfer.findMany({
          where: {
            itemId: { in: itemIds },
            OR: [{ statut: "EN_ROUTE" }, { decideLe: { gte: new Date(maintenant.getTime() - 30 * 86_400_000) } }],
          },
          orderBy: { createdAt: "desc" },
          take: 300,
        })
      : Promise.resolve([]),
    itemIds.length
      ? prisma.promoStockRequest.findMany({
          where: { itemId: { in: itemIds }, OR: [{ statut: "OUVERTE" }, { updatedAt: { gte: new Date(maintenant.getTime() - 30 * 86_400_000) } }] },
          orderBy: { createdAt: "desc" },
          take: 300,
        })
      : Promise.resolve([]),
  ]);

  const soldesParArticle = new Map<string, Map<string, SoldeVue>>();
  const totalParArticle = new Map<string, number>();
  for (const s of sommes) {
    const q = r3(num(s._sum.delta));
    totalParArticle.set(s.itemId, r3((totalParArticle.get(s.itemId) ?? 0) + q));
    if (!detenteursVisibles(s.holderId)) continue;
    const parDet = soldesParArticle.get(s.itemId) ?? new Map<string, SoldeVue>();
    const cle = cleDetenteur(s.holderId);
    const sv = parDet.get(cle) ?? { detenteurId: s.holderId, quantite: 0, parLot: [] };
    sv.quantite = r3(sv.quantite + q);
    if (q !== 0) sv.parLot.push({ lotId: s.lotId, quantite: q });
    parDet.set(cle, sv);
    soldesParArticle.set(s.itemId, parDet);
  }
  const enRouteParArticle = new Map(enRoute.map((e) => [e.itemId, r3(num(e._sum.quantite))]));

  // LE JOURNAL — borné, et il le dit. Un détenteur que la personne ne voit pas n'y figure pas.
  const visiblesFiltre = f.superAdmin || f.vueGlobale
    ? {}
    : { OR: [
        ...(voirMagasin ? [{ holderId: null }] : []),
        { holderId: { in: [user.id, ...f.equipe] } },
      ] };
  const [mouvements, compteJournal] = itemIds.length
    ? await Promise.all([
        prisma.promoStockMovement.findMany({
          where: { itemId: { in: itemIds }, ...visiblesFiltre },
          orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
          take: Math.min(4000, JOURNAL_PAR_ARTICLE * Math.max(1, itemIds.length)),
          select: {
            id: true, itemId: true, kind: true, delta: true, holderId: true, reason: true, recipient: true, occurredAt: true,
            createdById: true, lot: { select: { numero: true } }, annulation: { select: { id: true } },
          },
        }),
        prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: itemIds }, ...visiblesFiltre }, _count: { _all: true } }),
      ])
    : [[], []];
  const comptes = new Map(compteJournal.map((c) => [c.itemId, c._count._all]));

  // CE QUE CHAQUE MÉDECIN A REÇU — la somme se fait EN BASE (remises et contre-passations portent
  // toutes deux le médecin), dans le même périmètre de détenteurs que le journal.
  const sommesMedecins = itemIds.length
    ? await prisma.promoStockMovement.groupBy({
        by: ["doctorId", "itemId", "holderId"],
        where: { itemId: { in: itemIds }, doctorId: { not: null }, kind: { in: ["DISTRIBUTION", "REVERSAL"] }, ...visiblesFiltre },
        _sum: { delta: true },
        _max: { occurredAt: true },
      })
    : [];
  const journalParArticle = new Map<string, MouvementVue[]>();
  const peutAnnuler = peutAnnulerMouvement(f);
  for (const m of mouvements) {
    const liste = journalParArticle.get(m.itemId) ?? [];
    if (liste.length >= JOURNAL_PAR_ARTICLE) continue;
    liste.push({
      id: m.id, kind: m.kind as MovementKind, delta: num(m.delta), detenteurId: m.holderId, lotNumero: m.lot.numero,
      motif: m.reason, recipient: m.recipient, occurredAt: m.occurredAt.toISOString(), par: m.createdById,
      annule: Boolean(m.annulation),
      // La MÊME liste que l'écrivain relit avant d'annuler : deux listes, et l'écran proposerait
      // « Annuler » sur un mouvement que l'action refuse (§118.5).
      annulable: peutAnnuler && !m.annulation && KINDS_ANNULABLES.includes(m.kind as MovementKind),
    });
    journalParArticle.set(m.itemId, liste);
  }

  const articles: ArticleVue[] = [];
  const supports: SupportVue[] = [];
  for (const it of items) {
    const produits = it.produits.map((p) => ({ id: p.product.id, nom: p.product.canonicalName }));
    const libelle = libelleArticleStock(it.catalogue.nom, produits.map((p) => p.nom));
    if (!familleQuantifiee(it.catalogue.famille)) {
      supports.push({
        id: it.id, companyId: it.companyId, catalogue: { reference: it.catalogue.reference, nom: it.catalogue.nom },
        produits: produits.map((p) => p.nom), libelle, lien: it.lien,
        valableJusquau: it.valableJusquau?.toISOString() ?? null, etat: etatValidite(it.valableJusquau, maintenant), isActive: it.isActive,
        notes: it.notes,
      });
      continue;
    }
    const soldes = [...(soldesParArticle.get(it.id)?.values() ?? [])];
    const visible = r3(soldes.reduce((a, s) => a + s.quantite, 0));
    const journal = journalParArticle.get(it.id) ?? [];
    articles.push({
      id: it.id, companyId: it.companyId, societe: it.company?.name ?? null,
      catalogue: it.catalogue, produits, libelle,
      location: it.location, alertThreshold: it.alertThreshold == null ? null : num(it.alertThreshold), notes: it.notes,
      isActive: it.isActive,
      lots: it.lots.map((l) => ({
        id: l.id, numero: l.numero, origine: l.origine, recuLe: l.recuLe.toISOString(),
        coutUnitaire: l.coutUnitaire == null ? null : num(l.coutUnitaire),
        valableJusquau: l.valableJusquau?.toISOString() ?? null, libelle: l.libelle, etat: etatValidite(l.valableJusquau, maintenant),
      })),
      soldes, visible,
      total: f.superAdmin || f.vueGlobale ? r3(totalParArticle.get(it.id) ?? 0) : null,
      enRoute: f.superAdmin || f.vueGlobale || voirMagasin ? enRouteParArticle.get(it.id) ?? 0 : 0,
      journal,
      journalNonAffiche: Math.max(0, (comptes.get(it.id) ?? 0) - journal.length),
    });
  }

  // LES MÉDECINS : net par article (une remise contre-passée ne compte plus), les délégués qui ont
  // remis, le plus récent d'abord. Un médecin dont tout a été repris disparaît de la liste.
  const parMedecin = new Map<string, { articles: Map<string, number>; delegues: Set<string>; dernier: number }>();
  for (const sm of sommesMedecins) {
    if (!sm.doctorId) continue;
    const net = r3(-num(sm._sum.delta));
    const e = parMedecin.get(sm.doctorId) ?? { articles: new Map<string, number>(), delegues: new Set<string>(), dernier: 0 };
    e.articles.set(sm.itemId, r3((e.articles.get(sm.itemId) ?? 0) + net));
    if (net > 0 && sm.holderId) e.delegues.add(sm.holderId);
    e.dernier = Math.max(e.dernier, sm._max.occurredAt?.getTime() ?? 0);
    parMedecin.set(sm.doctorId, e);
  }
  const medecinsActifs = [...parMedecin]
    .map(([doctorId, e]) => ({ doctorId, e, articles: [...e.articles].filter(([, q]) => q > 0) }))
    .filter((m) => m.articles.length > 0)
    .sort((a, b) => b.e.dernier - a.e.dernier);
  const medecinsAffiches = medecinsActifs.slice(0, MEDECINS_AFFICHES);
  const fiches = medecinsAffiches.length
    ? await prisma.medicalDoctor.findMany({ where: { id: { in: medecinsAffiches.map((m) => m.doctorId) } }, select: { id: true, name: true, institution: true } })
    : [];
  const ficheDe = new Map(fiches.map((d) => [d.id, d]));

  // Les transferts et demandes que cette personne a le droit de voir — ceux qui la concernent,
  // ceux de son équipe, ceux du magasin si elle le tient, tout en vue globale.
  const libelleDe = new Map([...articles.map((a) => [a.id, a.libelle] as const), ...supports.map((s) => [s.id, s.libelle] as const)]);
  const concerne = (ids: (string | null)[]) => f.superAdmin || f.vueGlobale
    || ids.some((id) => id === user.id || (id !== null && f.equipe.has(id)) || (id === null && voirMagasin));
  const transfertsVus: TransfertVue[] = transferts
    .filter((t) => concerne([t.deId, t.versId]) || t.initiateurId === user.id)
    .map((t) => ({
      id: t.id, itemId: t.itemId, libelle: libelleDe.get(t.itemId) ?? "Article", nature: t.nature,
      deId: t.deId, versId: t.versId, quantite: num(t.quantite), quantiteRecue: t.quantiteRecue == null ? null : num(t.quantiteRecue),
      statut: t.statut, note: t.note, noteDecision: t.noteDecision, initiateurId: t.initiateurId,
      createdAt: t.createdAt.toISOString(), decideLe: t.decideLe?.toISOString() ?? null,
    }));
  const demandesVues: DemandeVue[] = demandes
    .filter((d) => d.demandeurId === user.id || tientLeMagasin(f) || f.vueGlobale || f.equipe.has(d.demandeurId))
    .map((d) => ({
      id: d.id, itemId: d.itemId, libelle: libelleDe.get(d.itemId) ?? "Article", demandeurId: d.demandeurId,
      quantite: num(d.quantite), note: d.note, statut: d.statut, noteDecision: d.noteDecision, createdAt: d.createdAt.toISOString(),
    }));

  // Les noms, en un lot.
  const idsPersonnes = new Set<string>([user.id, ...f.equipe]);
  for (const a of articles) {
    for (const s of a.soldes) if (s.detenteurId) idsPersonnes.add(s.detenteurId);
    for (const m of a.journal) { if (m.detenteurId) idsPersonnes.add(m.detenteurId); if (m.par) idsPersonnes.add(m.par); }
  }
  for (const t of transfertsVus) { if (t.deId) idsPersonnes.add(t.deId); if (t.versId) idsPersonnes.add(t.versId); idsPersonnes.add(t.initiateurId); }
  for (const m of medecinsAffiches) for (const d of m.e.delegues) idsPersonnes.add(d);
  for (const d of demandesVues) idsPersonnes.add(d.demandeurId);
  const [noms, destinataires, catalogue, produitsOptions, societes] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...idsPersonnes] } }, select: { id: true, name: true } }),
    f.module.modifier || f.superAdmin ? destinatairesPossibles() : Promise.resolve([]),
    peutEntrerAlaMain(f) || peutGererArticles(f)
      ? prisma.promoCatalogueArticle.findMany({ where: { actif: true }, select: { id: true, reference: true, nom: true, famille: true, unite: true, exigeProduit: true }, orderBy: { reference: "asc" } })
      : Promise.resolve([]),
    peutEntrerAlaMain(f) || peutGererArticles(f)
      ? prisma.product.findMany({ where: { isActive: true }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" } })
      : Promise.resolve([]),
    peutEntrerAlaMain(f) || peutGererArticles(f) ? getMyCompanies(user.id).then(companyOptions) : Promise.resolve([]),
  ]);
  const personnes: Record<string, string> = Object.fromEntries(noms.map((n) => [n.id, n.name]));
  personnes[MAGASIN] = "Magasin central";

  // CE QUI EST DEHORS POUR UN ÉVÉNEMENT — pour qui voit le magasin, et pour ses seuls articles.
  const horsMagasin: HorsMagasinVue[] = [];
  if ((voirMagasin || f.vueGlobale || f.superAdmin) && itemIds.length) {
    const lignes = await prisma.adProStockLine.findMany({
      where: { statut: "RESERVEE", stockItemId: { in: itemIds } },
      orderBy: { reserveeLe: "asc" },
      take: 200,
      select: {
        id: true, stockItemId: true, quantite: true, reserveeLe: true,
        item: { select: SELECT_POSTE },
      },
    });
    for (const l of lignes) {
      const [demande, lien] = demandeDuPoste(l.item);
      horsMagasin.push({
        ligneId: l.id, itemId: l.stockItemId, libelle: libelleDe.get(l.stockItemId) ?? "Article",
        quantite: num(l.quantite), demande, lien, depuis: l.reserveeLe?.toISOString() ?? null,
      });
    }
  }

  // CE QUI A ÉTÉ REMIS LORS DES OPÉRATIONS AD & PRO (§118.173) — mêmes lecteurs que la liste du
  // dessus (le magasin, la vue globale), mêmes articles. Seul un consommable REMIS compte : un
  // durable se PRÊTE et revient (rendu, abîmé ou perdu) — le compter « remis à un médecin » ferait
  // croire qu'un kakémono a été offert.
  let remisesOperations: RemiseOperationVue[] | null = null;
  let remisesOperationsNonAffichees = 0;
  if (voirMagasin || f.vueGlobale || f.superAdmin) {
    remisesOperations = [];
    if (itemIds.length) {
      const where = { statut: "CONFIRMEE" as const, utilisee: { gt: 0 }, stockItemId: { in: itemIds } };
      const [lignes, total] = await Promise.all([
        prisma.adProStockLine.findMany({
          where,
          orderBy: [{ confirmeeLe: "desc" }, { id: "asc" }],
          take: OPERATIONS_AFFICHEES,
          select: { id: true, stockItemId: true, utilisee: true, confirmeeLe: true, confirmeeParId: true, item: { select: SELECT_POSTE } },
        }),
        prisma.adProStockLine.count({ where }),
      ]);
      for (const l of lignes) {
        const [demande, lien] = demandeDuPoste(l.item);
        remisesOperations.push({
          ligneId: l.id, itemId: l.stockItemId, libelle: libelleDe.get(l.stockItemId) ?? "Article",
          quantite: num(l.utilisee ?? 0), demande, lien,
          confirmeeLe: l.confirmeeLe?.toISOString() ?? null, confirmeeParId: l.confirmeeParId,
        });
      }
      remisesOperationsNonAffichees = Math.max(0, total - lignes.length);
      const sansNom = [...new Set(remisesOperations.map((o) => o.confirmeeParId).filter((id): id is string => Boolean(id) && !(id! in personnes)))];
      if (sansNom.length) {
        for (const u of await prisma.user.findMany({ where: { id: { in: sansNom } }, select: { id: true, name: true } })) personnes[u.id] = u.name;
      }
    }
  }

  // ─────────── ÉTAPE 5 (§118.168) : comptages, récurrences, refontes, tableau de bord ───────────
  const voitTout = f.superAdmin || f.vueGlobale;
  const fenetreComptages = new Date(maintenant.getTime() - JOURS_TABLEAU * 86_400_000);
  const [comptagesBruts, recurrencesBrutes, refontesBrutes] = await Promise.all([
    prisma.promoStockComptage.findMany({
      where: {
        OR: [{ statut: "DEMANDE" }, { updatedAt: { gte: fenetreComptages } }],
        ...(voitTout ? {} : { AND: [{ OR: [
          { demandeurId: user.id },
          { holderId: { in: [user.id, ...f.equipe] } },
          ...(voirMagasin ? [{ holderId: null }] : []),
        ] }] }),
      },
      orderBy: [{ statut: "asc" }, { echeance: "asc" }],
      take: 300,
      select: {
        id: true, holderId: true, famille: true, demandeurId: true, recurrenceId: true, statut: true, echeance: true,
        note: true, createdAt: true, saisiLe: true, saisiParId: true, annuleMotif: true, corrigeLe: true, corrigeParId: true, corrigeMotif: true,
        lignes: { select: { itemId: true, attendu: true, compte: true, ecart: true } },
      },
    }),
    prisma.promoStockComptageRecurrence.findMany({
      where: voitTout ? {} : { auteurId: user.id },
      orderBy: [{ actif: "desc" }, { prochaineLe: "asc" }],
      take: 200,
    }),
    itemIds.length
      ? prisma.promoStockRefonte.findMany({
          where: {
            itemId: { in: itemIds },
            ...(voitTout || peutDeciderRefonte(f) ? { OR: [{ statut: "OUVERTE" }, { updatedAt: { gte: fenetreComptages } }] } : { auteurId: user.id }),
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
  ]);
  // La RÈGLE relue sur chaque ligne : la requête a borné, la règle tranche — c'est la même que l'action.
  const comptages: ComptageVue[] = comptagesBruts
    .filter((c) => peutVoirComptage(f, c))
    .map((c) => ({
      id: c.id, holderId: c.holderId, famille: (c.famille as PromoFamille | null) ?? null, demandeurId: c.demandeurId,
      recurrenceId: c.recurrenceId, statut: c.statut, echeance: c.echeance.toISOString(),
      enRetard: c.statut === "DEMANDE" && comptageEnRetard(c.echeance, maintenant),
      note: c.note, createdAt: c.createdAt.toISOString(), saisiLe: c.saisiLe?.toISOString() ?? null,
      saisiParId: c.saisiParId, annuleMotif: c.annuleMotif,
      corrigeLe: c.corrigeLe ? c.corrigeLe.toISOString() : null, corrigeParId: c.corrigeParId, corrigeMotif: c.corrigeMotif,
      lignes: c.lignes
        .map((l) => ({ itemId: l.itemId, libelle: libelleDe.get(l.itemId) ?? "Article", attendu: num(l.attendu), compte: num(l.compte), ecart: num(l.ecart) }))
        .sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart) || a.libelle.localeCompare(b.libelle, "fr")),
    }));
  const recurrences: RecurrenceVue[] = recurrencesBrutes.map((r) => ({
    id: r.id, cible: r.cible, holderId: r.holderId, famille: (r.famille as PromoFamille | null) ?? null, frequence: r.frequence,
    prochaineLe: r.prochaineLe.toISOString(), delaiJours: r.delaiJours, note: r.note, auteurId: r.auteurId, actif: r.actif,
    pauseMotif: r.pauseMotif, derniereLe: r.derniereLe?.toISOString() ?? null, nbDeclenchements: r.nbDeclenchements,
  }));
  const refontes: RefonteVue[] = refontesBrutes.map((r) => ({
    id: r.id, itemId: r.itemId, libelle: libelleDe.get(r.itemId) ?? "Article", auteurId: r.auteurId, motif: r.motif,
    statut: r.statut, decideParId: r.decideParId, decideLe: r.decideLe?.toISOString() ?? null, noteDecision: r.noteDecision,
    createdAt: r.createdAt.toISOString(),
  }));
  // À QUI elle peut demander un comptage : son équipe au sens de la règle, ET qui a le stock — sans
  // le module, la personne ne pourrait pas saisir, et l'action la refuserait : la proposer dans le
  // menu serait une fausse promesse (§118.83). Pour le Super Admin : quiconque a le stock.
  const ontLeStock = new Set(destinataires.map((d) => d.id));
  const peutFaireCompter = f.superAdmin
    ? [...ontLeStock]
    : [...f.equipe].filter((id) => peutDemanderComptage(f, id) && ontLeStock.has(id));
  const idsEtape5 = new Set<string>(peutFaireCompter);
  for (const c of comptages) { if (c.holderId) idsEtape5.add(c.holderId); idsEtape5.add(c.demandeurId); if (c.saisiParId) idsEtape5.add(c.saisiParId); }
  for (const r of recurrences) { if (r.holderId) idsEtape5.add(r.holderId); if (r.auteurId) idsEtape5.add(r.auteurId); }
  for (const r of refontes) { idsEtape5.add(r.auteurId); if (r.decideParId) idsEtape5.add(r.decideParId); }
  const manquants = [...idsEtape5].filter((id) => !(id in personnes));
  if (manquants.length) {
    for (const u of await prisma.user.findMany({ where: { id: { in: manquants } }, select: { id: true, name: true } })) personnes[u.id] = u.name;
  }
  const tableau = peutVoirTableauDeBord(f)
    ? await chargerTableau({ f, user, voirMagasin, maintenant, items, sommes, articles, libelleDe })
    : null;

  return {
    moi: user.id,
    maintenant: maintenant.toISOString(),
    faits: { ...f, equipe: [...f.equipe] },
    articles,
    supports,
    transferts: transfertsVus,
    demandes: demandesVues,
    personnes,
    equipe: [...f.equipe].map((id) => ({ id, nom: personnes[id] ?? "Compte supprimé" })).sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
    destinataires,
    catalogue: catalogue.map((c) => ({ ...c, famille: c.famille as PromoFamille })),
    produitsOptions: produitsOptions.map((p) => ({ id: p.id, nom: p.canonicalName })),
    societes,
    demandables: articles.filter((a) => a.isActive).map((a) => ({ id: a.id, libelle: a.libelle })),
    remisesAuxMedecins: medecinsAffiches.map((m) => ({
      doctorId: m.doctorId,
      medecin: ficheDe.get(m.doctorId)?.name ?? "(praticien retiré)",
      institution: ficheDe.get(m.doctorId)?.institution ?? null,
      articles: m.articles
        .map(([itemId, quantite]) => ({ itemId, libelle: libelleDe.get(itemId) ?? "Article", quantite }))
        .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr")),
      delegues: [...m.e.delegues],
      dernier: new Date(m.e.dernier).toISOString(),
    })),
    remisesNonAffichees: Math.max(0, medecinsActifs.length - medecinsAffiches.length),
    horsMagasin,
    remisesOperations,
    remisesOperationsNonAffichees,
    comptages,
    recurrences,
    refontes,
    tableau,
    peutFaireCompter: peutFaireCompter
      .map((id) => ({ id, nom: personnes[id] ?? "Compte supprimé" }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
  };
}

/** Les dormants montrés à l'écran : les plus gros ; le total, lui, est toujours compté. */
const DORMANTS_AFFICHES = 50;

/** Les sorties qui font d'un article un article VIVANT : une remise, un envoi, une réservation. */
const SORTIES_VIVANTES = ["DISTRIBUTION", "TRANSFER_OUT", "RESERVATION_OUT"] as const;

/**
 * LE TABLEAU DE BORD DU STOCK (§118.168) — sur le périmètre que la personne VOIT : la gestionnaire
 * du magasin sans vue globale voit la valeur du magasin et de son équipe, pas celle du parc entier.
 * Les sommes se font EN BASE ; les alertes sont celles du battement (même chargeur, même règle).
 */
async function chargerTableau(c: {
  f: FaitsStock;
  user: SessionUser;
  voirMagasin: boolean;
  maintenant: Date;
  items: { id: string; isActive: boolean; catalogue: { famille: string; unite: string }; lots: { id: string; recuLe: Date; coutUnitaire: unknown }[] }[];
  sommes: { itemId: string; holderId: string | null; lotId: string; _sum: { delta: unknown } }[];
  articles: ArticleVue[];
  libelleDe: Map<string, string>;
}): Promise<TableauVue> {
  const { f, user, voirMagasin, maintenant } = c;
  const quantifies = c.items.filter((i) => familleQuantifiee(i.catalogue.famille as PromoFamille));
  const qIds = quantifies.map((i) => i.id);
  const famille = new Map(quantifies.map((i) => [i.id, i.catalogue.famille as "CONSOMMABLE" | "DURABLE"]));
  const unite = new Map(quantifies.map((i) => [i.id, i.catalogue.unite]));
  const cout = new Map<string, number | null>();
  for (const i of quantifies) for (const l of i.lots) cout.set(l.id, l.coutUnitaire == null ? null : num(l.coutUnitaire));

  // LA VALEUR — soldes positifs par lot, chez les détenteurs que la personne voit.
  const visibles = c.sommes.filter((s) => famille.has(s.itemId) && peutVoirStockDe(f, s.holderId));
  const lignes = visibles.map((s) => ({ itemId: s.itemId, quantite: r3(num(s._sum.delta)), coutUnitaire: cout.get(s.lotId) ?? null }));
  const parFamille = (["CONSOMMABLE", "DURABLE"] as const).map((fam) => {
    const v = valeurDuStock(lignes.filter((l) => famille.get(l.itemId) === fam));
    return { famille: fam, valeur: v.valeur, unites: r3(v.unitesValorisees + v.unitesSansCout) };
  });

  // LA CONSOMMATION — sur la fenêtre, nette des corrections, dans le même périmètre que le journal.
  const depuis = new Date(maintenant.getTime() - JOURS_TABLEAU * 86_400_000);
  const perimetre = f.superAdmin || f.vueGlobale
    ? {}
    : { OR: [...(voirMagasin ? [{ holderId: null }] : []), { holderId: { in: [user.id, ...f.equipe] } }] };
  const [remises, pertes, pertesAnnulees, ecarts, evenements, sorties] = qIds.length
    ? await Promise.all([
        prisma.promoStockMovement.groupBy({
          by: ["itemId"], _sum: { delta: true },
          where: { itemId: { in: qIds }, occurredAt: { gte: depuis }, ...perimetre, OR: [{ kind: "DISTRIBUTION" }, { kind: "REVERSAL", visitId: { not: null } }, { kind: "REVERSAL", fieldReportId: { not: null } }] },
        }),
        prisma.promoStockMovement.groupBy({ by: ["itemId"], _sum: { delta: true }, where: { itemId: { in: qIds }, occurredAt: { gte: depuis }, kind: "LOSS", ...perimetre } }),
        prisma.promoStockMovement.groupBy({ by: ["itemId"], _sum: { delta: true }, where: { itemId: { in: qIds }, occurredAt: { gte: depuis }, kind: "REVERSAL", annule: { is: { kind: "LOSS" } }, ...perimetre } }),
        prisma.promoStockMovement.groupBy({ by: ["itemId"], _sum: { delta: true }, where: { itemId: { in: qIds }, occurredAt: { gte: depuis }, kind: "CORRECTION", comptageId: { not: null }, ...perimetre } }),
        voirMagasin || f.superAdmin || f.vueGlobale
          ? prisma.adProStockLine.findMany({
              where: { stockItemId: { in: qIds }, statut: "CONFIRMEE", confirmeeLe: { gte: depuis } },
              select: { stockItemId: true, utilisee: true, abimee: true, perdue: true },
            })
          : Promise.resolve([]),
        prisma.promoStockMovement.groupBy({ by: ["itemId"], _max: { occurredAt: true }, where: { itemId: { in: qIds }, kind: { in: [...SORTIES_VIVANTES] }, ...perimetre } }),
      ])
    : [[], [], [], [], [], []];
  // Une remise est un delta NÉGATIF ; sa contre-passation, positive : le net se lit au signe près.
  const parArticle = new Map<string, number>();
  const ajouter = (itemId: string, q: number) => parArticle.set(itemId, r3((parArticle.get(itemId) ?? 0) + q));
  let remisMedecins = 0;
  for (const r of remises) { const q = r3(-num(r._sum.delta)); remisMedecins = r3(remisMedecins + q); ajouter(r.itemId, q); }
  let remisEvenements = 0;
  for (const l of evenements) {
    const q = r3(num(l.utilisee) + num(l.abimee) + num(l.perdue));
    remisEvenements = r3(remisEvenements + q);
    ajouter(l.stockItemId, q);
  }
  const totalPertes = r3(pertes.reduce((t, p) => t - num(p._sum.delta), 0) - pertesAnnulees.reduce((t, p) => t + num(p._sum.delta), 0));
  const ecartsComptage = r3(ecarts.reduce((t, e) => t + num(e._sum.delta), 0));

  // LES DORMANTS — du stock en main, aucune sortie sur la fenêtre, et un article qui a eu le temps de servir.
  const derniereSortie = new Map(sorties.map((s) => [s.itemId, s._max.occurredAt ?? null]));
  const tousDormants = c.articles
    .filter((a) => a.isActive)
    .map((a) => {
      const it = quantifies.find((i) => i.id === a.id);
      const premiereEntree = it && it.lots.length ? new Date(Math.min(...it.lots.map((l) => l.recuLe.getTime()))) : null;
      const valeur = valeurDuStock(a.soldes.flatMap((sv) => sv.parLot.map((p) => ({ quantite: p.quantite, coutUnitaire: cout.get(p.lotId) ?? null }))));
      return { a, premiereEntree, derniere: derniereSortie.get(a.id) ?? null, valeur };
    })
    .filter((x) => estDormant({ quantite: x.a.visible, premiereEntree: x.premiereEntree, derniereSortie: x.derniere }, maintenant));
  const dormants = tousDormants
    .sort((x, y) => y.a.visible - x.a.visible)
    .slice(0, DORMANTS_AFFICHES)
    .map((x) => ({
      itemId: x.a.id, libelle: x.a.libelle, quantite: x.a.visible, unite: x.a.catalogue.unite,
      derniereSortie: x.derniere?.toISOString() ?? null,
      valeur: x.valeur.unitesSansCout > 0 ? null : x.valeur.valeur,
    }));

  // LES ALERTES — celles du battement, au périmètre que la personne voit.
  const entree = await chargerFaitsAlertes({ itemIds: c.items.map((i) => i.id), comptageIds: null, maintenant });
  const alertes = alertesDuStock(entree, maintenant)
    .filter((a) => peutVoirStockDe(f, a.detenteur))
    .map((a) => ({ cle: a.cle, genre: a.genre, texte: a.texte, lien: a.lien }));

  return {
    fenetreJours: JOURS_TABLEAU,
    valeur: valeurDuStock(lignes),
    parFamille,
    consommation: { remisMedecins, remisEvenements, pertes: totalPertes, ecartsComptage },
    topConsommes: [...parArticle]
      .filter(([, q]) => q > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([itemId, quantite]) => ({ itemId, libelle: c.libelleDe.get(itemId) ?? "Article", quantite, unite: unite.get(itemId) ?? "" })),
    dormants,
    dormantsTotal: tousDormants.length,
    alertes,
  };
}

/** L'article est-il dans le périmètre d'entité de la personne ? (garde des actions) */
export async function articleDansMonPerimetre(userId: string, itemId: string) {
  return prisma.promoStockItem.findFirst({
    where: await companyScopedWhere(userId, { id: itemId }),
    select: {
      id: true, companyId: true, isActive: true, name: true, unit: true,
      catalogue: { select: { nom: true, famille: true, unite: true, reference: true } },
      produits: { select: { product: { select: { canonicalName: true } } } },
    },
  });
}
