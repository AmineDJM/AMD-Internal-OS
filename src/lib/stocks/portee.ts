
/** Ce qui manque quand une portée restreinte est vide — pour le DIRE au lieu de montrer une page blanche. */
export type RaisonPorteeVide =
  | "SANS_BU"
  | "SANS_SECTEUR"
  | "SECTEURS_HORS_BU"
  | "SECTEURS_SANS_ETABLISSEMENT"
  | "BU_SANS_PRODUIT";

export interface SecteurDePortee {
  id: string;
  nom: string;
  businessUnitId: string;
  institutionIds: readonly string[];
}

export type PorteeStock =
  | { mode: "GLOBALE" }
  | {
      mode: "BU" | "SECTEUR";
      buIds: string[];
      /** Les établissements de l'annuaire que la personne voit — triés, sans doublon. */
      institutionIds: string[];
      /** Les produits (dossiers Regulatory) de ses BU — triés, sans doublon. */
      productIds: string[];
      /** Les secteurs qui fondent la portée, pour l'afficher (« vos secteurs : Est, Oranais »). */
      secteurs: { id: string; nom: string }[];
      raisons: RaisonPorteeVide[];
    };

export type PorteeRestreinte = Extract<PorteeStock, { mode: "BU" | "SECTEUR" }>;

export const porteeGlobale = (): PorteeStock => ({ mode: "GLOBALE" });

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

// ── 1. LE MODE, décidé sur les faits ───────────────────────────────────────────────────────

export interface FaitsDeMode {
  /** Chaîne d'approvisionnement (PCH), vue globale ou Super Admin. */
  voitTout: boolean;
  /** Les BU ACTIVES dont la personne est le superviseur. */
  buSupervisees: readonly string[];
  /** La BU de sa fiche force de vente, s'il en a une. */
  buDuKam: string | null;
  /** Les secteurs ACTIFS auxquels elle est affectée (leur BU suffit ici). */
  secteurs: readonly { businessUnitId: string }[];
}

export type ModeDecide = { mode: "GLOBALE" } | { mode: "BU"; buIds: string[] } | { mode: "SECTEUR"; buIds: string[] };

/**
 * Qui voit tout voit tout ; sinon superviser l'emporte sur être affecté ; sinon on est un KAM,
 * dont la BU est celle de sa FICHE — et seulement à défaut de fiche, celles de ses secteurs
 * (un KAM affecté avant que sa fiche soit remplie ne doit pas voir une page vide pour ça).
 */
export function modeDepuisFaits(f: FaitsDeMode): ModeDecide {
  if (f.voitTout) return { mode: "GLOBALE" };
  const supervisees = unique(f.buSupervisees);
  if (supervisees.length > 0) return { mode: "BU", buIds: supervisees };
  const buIds = f.buDuKam ? [f.buDuKam] : unique(f.secteurs.map((s) => s.businessUnitId));
  return { mode: "SECTEUR", buIds };
}

// ── 2. LA PORTÉE, composée ─────────────────────────────────────────────────────────────────

export interface EntreesDePortee {
  mode: "BU" | "SECTEUR";
  buIds: readonly string[];
  /** BU : tous les secteurs actifs des BU ; SECTEUR : ceux où la personne est affectée. */
  secteurs: readonly SecteurDePortee[];
  /** Les produits par BU (dossiers Regulatory des produits promus actifs de la BU). */
  produitsParBu: Readonly<Record<string, readonly string[]>>;
}

/**
 * Les secteurs RETENUS sont ceux des BU de la portée : en mode SECTEUR, un secteur d'une autre
 * BU que celle de la fiche est écarté — et compté, pour que l'écran puisse le dire.
 */
export function composerPortee(e: EntreesDePortee): PorteeRestreinte {
  const buIds = unique(e.buIds);
  const bu = new Set(buIds);
  const retenus = e.secteurs.filter((s) => bu.has(s.businessUnitId));
  const ecartes = e.secteurs.length - retenus.length;
  const institutionIds = unique(retenus.flatMap((s) => s.institutionIds));
  const productIds = unique(buIds.flatMap((b) => e.produitsParBu[b] ?? []));

  const raisons: RaisonPorteeVide[] = [];
  if (buIds.length === 0) raisons.push("SANS_BU");
  if (buIds.length > 0 && retenus.length === 0) raisons.push("SANS_SECTEUR");
  if (e.mode === "SECTEUR" && ecartes > 0) raisons.push("SECTEURS_HORS_BU");
  if (retenus.length > 0 && institutionIds.length === 0) raisons.push("SECTEURS_SANS_ETABLISSEMENT");
  if (buIds.length > 0 && productIds.length === 0) raisons.push("BU_SANS_PRODUIT");

  return {
    mode: e.mode,
    buIds,
    institutionIds,
    productIds,
    secteurs: retenus
      .map((s) => ({ id: s.id, nom: s.nom }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
    raisons,
  };
}

// ── 3. LES QUESTIONS que tout le monde pose à la portée ────────────────────────────────────

export const estRestreinte = (p: PorteeStock): p is PorteeRestreinte => p.mode !== "GLOBALE";

/** Un lieu de stock SANS établissement (hérité) n'est dans aucune portée restreinte : il n'est dans aucun secteur. */
export function etablissementDansPortee(p: PorteeStock, institutionId: string | null | undefined): boolean {
  if (!estRestreinte(p)) return true;
  return !!institutionId && p.institutionIds.includes(institutionId);
}

export function produitDansPortee(p: PorteeStock, productId: string): boolean {
  if (!estRestreinte(p)) return true;
  return p.productIds.includes(productId);
}

export interface ReleveSituable {
  scope: string;
  /** L'établissement du lieu du relevé — nul pour la PCH, une annexe, ou un hôpital hérité. */
  institutionId: string | null | undefined;
  productId: string;
}

/**
 * Un relevé se voit si son LIEU et son PRODUIT sont dans la portée — et, pour une portée
 * restreinte, seulement s'il est un relevé d'HÔPITAL : la centrale d'achat et ses annexes sont la
 * chaîne d'approvisionnement, que `scopes.ts` réserve déjà à qui la tient.
 */
export function releveDansPortee(p: PorteeStock, r: ReleveSituable): boolean {
  if (!estRestreinte(p)) return true;
  return r.scope === "HOSPITAL" && etablissementDansPortee(p, r.institutionId) && produitDansPortee(p, r.productId);
}

export function filtrerReleves<T extends ReleveSituable>(p: PorteeStock, rows: readonly T[]): T[] {
  return rows.filter((r) => releveDansPortee(p, r));
}

/** Vrai quand une portée restreinte ne peut rien montrer — ni hôpital, ni produit. */
export const porteeVide = (p: PorteeStock): boolean =>
  estRestreinte(p) && (p.institutionIds.length === 0 || p.productIds.length === 0);

// ── 4. CE QU'ON DIT quand il n'y a rien à montrer ──────────────────────────────────────────

const PHRASES: Record<RaisonPorteeVide, string> = {
  SANS_BU:
    "Aucune Business Unit ne vous est rattachée : votre fiche force de vente n'en porte pas, et aucun secteur ne vous est affecté.",
  SANS_SECTEUR:
    "Aucun secteur de votre BU ne vous est affecté : les stocks d'hôpitaux se lisent par secteur (Business Units › Secteurs).",
  SECTEURS_HORS_BU:
    "Vous êtes affecté à des secteurs d'une autre BU que celle de votre fiche : ils ne comptent pas ici.",
  SECTEURS_SANS_ETABLISSEMENT:
    "Vos secteurs ne contiennent aucun établissement : un secteur est une sélection d'hôpitaux de l'annuaire des établissements.",
  BU_SANS_PRODUIT:
    "Votre BU n'a aucun produit promu rattaché à un dossier Regulatory : il n'y a donc aucun produit dont suivre le stock.",
};

/**
 * La phrase de l'écran vide — `null` quand il y a quelque chose à montrer, ou pour la vue
 * globale. On NOMME ce qui manque, dans l'ordre où il se répare : la BU, puis les secteurs,
 * puis leurs établissements, puis les produits.
 */
export function explicationPortee(p: PorteeStock): string | null {
  if (!estRestreinte(p) || !porteeVide(p)) return null;
  const ordre: RaisonPorteeVide[] = ["SANS_BU", "SANS_SECTEUR", "SECTEURS_HORS_BU", "SECTEURS_SANS_ETABLISSEMENT", "BU_SANS_PRODUIT"];
  const phrases = ordre.filter((r) => p.raisons.includes(r)).map((r) => PHRASES[r]);
  return phrases.length > 0 ? phrases.join(" ") : "Aucun hôpital ni produit ne relève de votre périmètre de stock.";
}

/** Le refus d'écriture, avec le remède : on ne relève pas un hôpital qui n'est pas dans son secteur. */
export function refusHorsPortee(p: PorteeStock, quoi: "etablissement" | "produit" | "lieu-herite"): string {
  const ou = p.mode === "BU" ? "de votre BU" : "de votre secteur";
  if (quoi === "produit") return `Ce produit n'est pas dans la gamme ${ou} : le stock ne se relève que pour les produits de la BU.`;
  if (quoi === "lieu-herite") {
    return "Ce lieu de stock n'est rattaché à aucun établissement de l'annuaire : il n'appartient à aucun secteur. Le Super Admin peut le rattacher depuis l'écran des stocks.";
  }
  return `Cet établissement n'est pas dans un secteur ${ou} : vous ne relevez que les hôpitaux ${ou}.`;
}
