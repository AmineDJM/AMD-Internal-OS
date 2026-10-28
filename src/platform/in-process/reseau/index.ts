/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSEAU DE L'ENTREPRISE, côté plateforme (mandat 5 §40) — la porte par laquelle Adam
 * transforme des TABLES en GRAPHE, et des WILAYAS en POINTS.
 *
 * `lib/graphe/` et `lib/geo/` sont PURS : ils ne connaissent ni Prisma, ni le RBAC, ni la
 * session. C'est ici, et seulement ici, que les droits se vérifient — un module qu'une personne
 * ne voit pas ne fournit AUCUN nœud, et un chemin ne peut donc pas passer par lui. Le graphe
 * n'est pas une porte dérobée : deux personnes aux droits différents voient deux réseaux.
 *
 * Les liens viennent de deux sources, et le code les distingue :
 *   · DÉCLARÉS — le registre `EntityLink`, ce que des humains ont relié à la main. Ce sont les
 *     liens les plus sûrs, et ils portent parfois une note qui dit pourquoi.
 *   · STRUCTURELS — ce que les tables portent déjà (un salarié appartient à un département, un
 *     produit à une société). Ils sont vrais par construction, mais ils ne disent rien qu'un
 *     schéma ne dise déjà : on les marque comme tels.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { hasGlobalView, userCan, type Module, type SessionUser } from "@/lib/rbac";
import { type Arete, type Graphe, type Noeud, construire } from "@/lib/graphe/modele";
import { type Lieu } from "@/lib/geo/distance";
import { AVERTISSEMENT_CHEF_LIEU, coordonneesDe } from "@/lib/geo/algeria";
import { sansBloquer } from "@/lib/journal";

export { type Arete, type Graphe, type Noeud, auMoment, construire, degre, estTemporel, filtrerRelations, nom, sommaire, valideA, voisins, NOEUDS_MAX } from "@/lib/graphe/modele";
export { type Chemin, type Etape, cheminsMultiples, composantes, cycles, plusCourtChemin, pointsDeRupture, portee, PROFONDEUR_MAX } from "@/lib/graphe/chemins";
export { type Centralite, type Communaute, centralites, communautes, intermediarite, pagerank, proximite } from "@/lib/graphe/mesures";
export { type Lieu, aireKm2, autour, barycentre, cap, cardinal, coordonneesValides, dansLaZone, densites, distanceKm, distanceRoutiereEstimeeKm, enveloppe, FACTEUR_DETOUR_ROUTIER } from "@/lib/geo/distance";
export { type Implantation, type Territoire, type Tournee, choisirSites, implantationOptimale, territoires, tournee } from "@/lib/geo/tournee";
export { AVERTISSEMENT_CHEF_LIEU, COORDONNEES_WILAYAS, WILAYAS, coordonneesDe, findWilaya } from "@/lib/geo/algeria";

/** Le plafond de lecture : un graphe se lit, il ne se déverse pas. */
export const LIGNES_PAR_SOURCE = 4_000;

/** Quel module ouvre quel type d'entité — la règle de visibilité du réseau, en un seul endroit. */
const MODULE_DE: Readonly<Record<string, Module | null>> = {
  EMPLOYEE: "RH",
  REGULATORY_PRODUCT: "REGULATORY",
  REGULATORY_STEP: "REGULATORY",
  LEGAL_DOCUMENT: "LEGAL",
  INVOICE: "FINANCES",
  EXPENSE_ORDER: "FINANCES",
  FINANCE_TRANSACTION: "FINANCES",
  BUDGET: "BUDGETS",
  PCH_TENDER: "PCH",
  PCH_ORDER: "PCH",
  MAIL_ENTRY: "MAIL_REGISTER",
  DOCTOR: "MEDICAL",
  SPONSORING: "SPONSORING",
  TASK: null,
  COMPANY: null,
  SUPPLIER: null,
  PARTIE: null,
  DEPARTMENT: null,
};

const peutVoir = (user: SessionUser, type: string): boolean => {
  const m = MODULE_DE[type];
  if (m === undefined) return hasGlobalView(user);
  return m === null ? true : userCan(user, m, "VIEW");
};

export interface OptionsReseau {
  /** Restreindre aux types d'entités demandés. */
  types?: readonly string[];
  /** Inclure les liens structurels (déduits des tables) en plus des liens déclarés. */
  structurels?: boolean;
  limite?: number;
}

export interface ReseauErp {
  graphe: Graphe;
  /** Ce que la personne n'a PAS le droit de voir — dit, jamais caché. */
  typesRefuses: string[];
  sources: { declares: number; structurels: number };
  tronque: boolean;
}

/**
 * CONSTRUIT LE RÉSEAU depuis l'ERP, sous les droits de la personne.
 * Un type refusé n'est pas silencieusement absent : il est NOMMÉ dans `typesRefuses`.
 */
export async function reseauErp(user: SessionUser, options: OptionsReseau = {}): Promise<ReseauErp | { erreur: string }> {
  const limite = Math.max(50, Math.min(options.limite ?? LIGNES_PAR_SOURCE, LIGNES_PAR_SOURCE));
  const demandes = options.types?.length ? options.types.map((t) => t.toUpperCase()) : null;
  const noeuds = new Map<string, Noeud>();
  const aretes: Arete[] = [];
  const typesRefuses = new Set<string>();
  let tronque = false;

  const ajouterNoeud = (type: string, id: string, libelle: string, extra: Partial<Noeud> = {}): string | null => {
    const cle = `${type}:${id}`;
    if (!peutVoir(user, type)) { typesRefuses.add(type); return null; }
    if (demandes && !demandes.includes(type)) return null;
    if (!noeuds.has(cle)) noeuds.set(cle, { id: cle, type, libelle: libelle || id, ...extra });
    return cle;
  };

  // ── 1. LES LIENS DÉCLARÉS : le registre unique des relations posées par des humains.
  const declares = await prisma.entityLink.findMany({
    orderBy: { createdAt: "desc" }, take: limite,
    select: { fromType: true, fromId: true, fromLabel: true, toType: true, toId: true, toLabel: true, note: true, createdAt: true },
  });
  if (declares.length >= limite) tronque = true;
  let nDeclares = 0;
  for (const l of declares) {
    const a = ajouterNoeud(l.fromType, l.fromId, l.fromLabel ?? l.fromId);
    const b = ajouterNoeud(l.toType, l.toId, l.toLabel ?? l.toId);
    if (!a || !b) continue;
    aretes.push({ de: a, a: b, relation: "relie_a", reciproque: true, note: l.note, depuis: l.createdAt, poids: 2 });
    nDeclares += 1;
  }

  // ── 2. LES LIENS STRUCTURELS : ce que les tables portent déjà.
  let nStructurels = 0;
  if (options.structurels !== false) {
    if (peutVoir(user, "EMPLOYEE")) {
      const employes = await prisma.employee.findMany({
        where: { isActive: true }, take: limite,
        select: { id: true, fullName: true, department: true, companyId: true, hireDate: true, company: { select: { name: true } } },
      });
      for (const e of employes) {
        const p = ajouterNoeud("EMPLOYEE", e.id, e.fullName);
        if (!p) continue;
        if (e.companyId) {
          const c = ajouterNoeud("COMPANY", e.companyId, e.company?.name ?? e.companyId);
          if (c) { aretes.push({ de: p, a: c, relation: "travaille_chez", depuis: e.hireDate }); nStructurels += 1; }
        }
        if (e.department) {
          const d = ajouterNoeud("DEPARTMENT", `dept:${e.department}`, e.department);
          if (d) { aretes.push({ de: p, a: d, relation: "affecte_a", depuis: e.hireDate }); nStructurels += 1; }
        }
      }
    } else typesRefuses.add("EMPLOYEE");

    if (peutVoir(user, "REGULATORY_PRODUCT")) {
      const produits = await prisma.regulatoryProduct.findMany({
        take: limite,
        select: { id: true, dci: true, brandName: true, companyId: true, supplierId: true, createdAt: true, company: { select: { name: true } }, supplier: { select: { name: true } } },
      });
      for (const p of produits) {
        const n = ajouterNoeud("REGULATORY_PRODUCT", p.id, p.brandName || p.dci);
        if (!n) continue;
        if (p.companyId) {
          const c = ajouterNoeud("COMPANY", p.companyId, p.company?.name ?? p.companyId);
          if (c) { aretes.push({ de: n, a: c, relation: "porte_par", depuis: p.createdAt }); nStructurels += 1; }
        }
        if (p.supplierId) {
          const f = ajouterNoeud("SUPPLIER", p.supplierId, p.supplier?.name ?? p.supplierId);
          if (f) { aretes.push({ de: f, a: n, relation: "fournit", depuis: p.createdAt }); nStructurels += 1; }
        }
      }
    } else typesRefuses.add("REGULATORY_PRODUCT");

    if (peutVoir(user, "LEGAL_DOCUMENT")) {
      const docs = await prisma.legalDocument.findMany({
        take: limite, orderBy: { createdAt: "desc" },
        select: { id: true, title: true, kind: true, counterparty: true, companyId: true, startDate: true, endDate: true, createdAt: true },
      });
      for (const d of docs) {
        const n = ajouterNoeud("LEGAL_DOCUMENT", d.id, d.title || d.kind);
        if (!n) continue;
        const depuis = d.startDate ?? d.createdAt, jusqua = d.endDate;
        // L'AUTRE PARTIE est un TEXTE dans le registre Legal, pas une clé étrangère : on en fait
        // un nœud nommé par ce texte, normalisé, pour que deux contrats du même fournisseur se
        // rejoignent. C'est un rapprochement par le NOM — il porte donc l'incertitude du nom.
        if (d.counterparty?.trim()) {
          const cle = d.counterparty.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-");
          const f = ajouterNoeud("PARTIE", cle, d.counterparty.trim());
          if (f) { aretes.push({ de: n, a: f, relation: "engage", depuis, jusqua }); nStructurels += 1; }
        }
        if (d.companyId) { const c = ajouterNoeud("COMPANY", d.companyId, d.companyId); if (c) { aretes.push({ de: c, a: n, relation: "signataire", depuis, jusqua }); nStructurels += 1; } }
      }
    } else typesRefuses.add("LEGAL_DOCUMENT");
  }

  // Les libellés des sociétés, fournisseurs et partenaires n'étaient pas tous chargés : on les complète.
  await completerLibelles(noeuds);

  if (!noeuds.size) {
    return { erreur: typesRefuses.size
      ? `Aucun élément visible pour construire un réseau : ${[...typesRefuses].join(", ")} demandent un droit que vous n'avez pas.`
      : "Aucun lien enregistré : le réseau est vide. Relier des éléments dans l'ERP (« Relié à… ») fait apparaître le graphe." };
  }
  const r = construire([...noeuds.values()], aretes);
  if (!r.ok) return { erreur: r.erreur };
  return { graphe: r.graphe, typesRefuses: [...typesRefuses], sources: { declares: nDeclares, structurels: nStructurels }, tronque };
}

/** Remplace les identifiants bruts par de vrais noms — un graphe d'identifiants ne se lit pas. */
async function completerLibelles(noeuds: Map<string, Noeud>): Promise<void> {
  const parType = new Map<string, string[]>();
  for (const n of noeuds.values()) {
    if (n.libelle !== n.id.split(":").slice(1).join(":")) continue;
    const brut = n.id.split(":").slice(1).join(":");
    if (!parType.has(n.type)) parType.set(n.type, []);
    parType.get(n.type)!.push(brut);
  }
  const poser = (type: string, lignes: { id: string; name: string }[]) => {
    for (const l of lignes) {
      const n = noeuds.get(`${type}:${l.id}`);
      if (n && l.name) n.libelle = l.name;
    }
  };
  const ids = (t: string) => (parType.get(t) ?? []).slice(0, 500);
  if (ids("COMPANY").length) poser("COMPANY", await prisma.company.findMany({ where: { id: { in: ids("COMPANY") } }, select: { id: true, name: true } }));
  if (ids("SUPPLIER").length) poser("SUPPLIER", await prisma.supplier.findMany({ where: { id: { in: ids("SUPPLIER") } }, select: { id: true, name: true } }).catch(sansBloquer("reseau.completerLibelles.supplier", [])));
}

export type SourceLieux = "medecins" | "institutions" | "contacts";

export interface LieuxErp {
  lieux: Lieu[];
  source: string;
  sansCoordonnees: number;
  avertissement: string;
}

/**
 * LES ENTITÉS SUR LA CARTE — la wilaya devient un point (chef-lieu). Ce qui n'a pas de wilaya
 * est COMPTÉ, pas deviné : une ligne sans lieu ne se place nulle part.
 */
export async function lieuxErp(user: SessionUser, source: SourceLieux, options: { limite?: number } = {}): Promise<LieuxErp | { erreur: string }> {
  const take = Math.max(10, Math.min(options.limite ?? 2_000, LIGNES_PAR_SOURCE));
  let lignes: { id: string; nom: string; wilaya: string | null; poids?: number }[] = [];
  let titre = "";
  if (source === "medecins") {
    if (!userCan(user, "MEDICAL", "VIEW")) return { erreur: "Le registre médical demande le droit MEDICAL : votre profil ne l'a pas." };
    const rows = await prisma.medicalDoctor.findMany({ take, select: { id: true, name: true, wilaya: true } });
    lignes = rows.map((r) => ({ id: r.id, nom: r.name, wilaya: r.wilaya }));
    titre = "médecins";
  } else if (source === "institutions") {
    if (!userCan(user, "MEDICAL", "VIEW")) return { erreur: "Le registre des établissements demande le droit MEDICAL : votre profil ne l'a pas." };
    const rows = await prisma.medicalInstitution.findMany({ take, select: { id: true, name: true, wilaya: true } });
    lignes = rows.map((r) => ({ id: r.id, nom: r.name, wilaya: r.wilaya }));
    titre = "établissements de santé";
  } else {
    const rows = await prisma.companyContact.findMany({ take, select: { id: true, name: true, wilaya: true } });
    lignes = rows.map((r) => ({ id: r.id, nom: r.name, wilaya: r.wilaya }));
    titre = "contacts";
  }
  const lieux: Lieu[] = [];
  let sansCoordonnees = 0;
  for (const l of lignes) {
    const c = coordonneesDe(l.wilaya);
    if (!c) { sansCoordonnees += 1; continue; }
    lieux.push({ id: l.id, libelle: l.nom, lat: c.lat, lon: c.lon, poids: l.poids ?? 1, type: source, attributs: { wilaya: c.wilaya.name, code: c.wilaya.code } });
  }
  return {
    lieux, source: titre, sansCoordonnees,
    avertissement: `${AVERTISSEMENT_CHEF_LIEU}${sansCoordonnees ? ` ${sansCoordonnees} ligne(s) sans wilaya exploitable : elles ne sont sur aucune carte.` : ""}`,
  };
}
