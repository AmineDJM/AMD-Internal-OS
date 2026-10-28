/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDE DE STOCKS — DO → KAM (Direction, 06/10). Module PUR : ni base, ni session.
 *
 * « Le DO sélectionne le ou les hôpitaux — aucun = tous — et pour chacun le ou les produits —
 * aucun = tous. Chaque KAM reçoit la demande et ajoute, pour chaque hôpital, les stocks de chaque
 * produit demandé. »
 *
 * ── LE ROUTAGE EST CELUI DE LA PORTÉE DE STOCK (§118.134) ─────────────────────────────────
 *
 * Une case (établissement, produit) va au KAM qui VERRAIT ce stock dans le module : un secteur
 * actif qui couvre l'établissement, dans SA BU (celle de sa fiche ; à défaut, celles de ses
 * secteurs), et un produit de cette BU. Router autrement ferait demander à un KAM un stock que
 * `recordStockSnapshot` lui refuserait d'écrire.
 *
 * ── « AUCUN PRODUIT = TOUS », MAIS TOUS CEUX QUI ONT UN KAM ICI ──────────────────────────
 *
 * Pour un établissement sans produit choisi, « tous » = les produits du catalogue que portent
 * les KAM qui le couvrent. Le catalogue entier ferait des dizaines de cases que personne ne peut
 * renseigner. Un produit CHOISI explicitement reste demandé même sans KAM : la case est « sans
 * KAM », et le DO le voit — c'est un trou de couverture, pas un bruit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les types d'établissement proposés d'office (les autres y entrent par un secteur ou un lieu de stock). */
export const TYPES_HOSPITALIERS = ["CHU", "EPH", "EHS", "CLINIQUE_PRIVEE", "POLYCLINIQUE"] as const;

/** Une relance par KAM et par heure au plus — au-delà, c'est du bruit qui apprend à ignorer. */
export const DELAI_RELANCE_MS = 60 * 60 * 1000;

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

// ── 1. LA COUVERTURE : qui porte quel établissement, pour quelle BU ───────────────────────

export interface AffectationKam {
  kamId: string;
  /** La BU de sa fiche force de vente — nulle s'il n'en a pas. */
  buDuKam: string | null;
  /** La BU du secteur affecté. */
  buDuSecteur: string;
  institutionIds: readonly string[];
}

export interface PorteurKam {
  kamId: string;
  buId: string;
}

/**
 * Établissement → KAM (et la BU au titre de laquelle il le porte). Un secteur d'une autre BU
 * que celle de sa fiche ne compte pas — la règle de `composerPortee`, mot pour mot.
 */
export function couvertureDepuisAffectations(affectations: readonly AffectationKam[]): Map<string, PorteurKam[]> {
  const out = new Map<string, PorteurKam[]>();
  for (const a of affectations) {
    if (a.buDuKam && a.buDuKam !== a.buDuSecteur) continue;
    for (const inst of a.institutionIds) {
      const liste = out.get(inst) ?? [];
      if (!liste.some((p) => p.kamId === a.kamId && p.buId === a.buDuSecteur)) liste.push({ kamId: a.kamId, buId: a.buDuSecteur });
      out.set(inst, liste);
    }
  }
  return out;
}

/** Les KAM qui portent ce produit dans cet établissement. */
export function kamsDeLaCase(porteurs: readonly PorteurKam[], productId: string, produitsParBu: Readonly<Record<string, readonly string[]>>): string[] {
  return unique(porteurs.filter((p) => (produitsParBu[p.buId] ?? []).includes(productId)).map((p) => p.kamId));
}

/** « Tous les produits » d'un établissement : ceux du catalogue que ses KAM portent. */
export function produitsCouverts(porteurs: readonly PorteurKam[], catalogue: readonly string[], produitsParBu: Readonly<Record<string, readonly string[]>>): string[] {
  const portes = new Set(porteurs.flatMap((p) => produitsParBu[p.buId] ?? []));
  return catalogue.filter((id) => portes.has(id));
}

// ── 2. LE DÉVELOPPEMENT : « aucun = tous », écrit ligne à ligne ───────────────────────────

export interface EntreeDeveloppement {
  /** Les établissements cochés — vide = tous les candidats. */
  hopitauxChoisis: readonly string[];
  /** Les candidats (ce que l'écran proposait), dans l'ordre d'affichage. */
  candidats: readonly string[];
  /** Les produits cochés PAR établissement — absent ou vide = tous ceux que ses KAM portent. */
  produitsChoisis: Readonly<Record<string, readonly string[]>>;
  /**
   * Un FILTRE commun (« le stock de X dans tous les hôpitaux ») : pour un établissement sans
   * choix propre, « tous ceux que ses KAM portent » est réduit à ces produits. Vide = pas de filtre.
   */
  produitsCommuns?: readonly string[];
  /** Le catalogue (produits du module Stocks), dans l'ordre d'affichage. */
  catalogue: readonly string[];
  couverture: ReadonlyMap<string, readonly PorteurKam[]>;
  produitsParBu: Readonly<Record<string, readonly string[]>>;
}

export interface HopitalDeveloppe {
  institutionId: string;
  tousProduits: boolean;
  sansKam: boolean;
  kamIds: string[];
}

export interface LigneDeveloppee {
  institutionId: string;
  productId: string;
  kamIds: string[];
}

export type Developpement =
  | { ok: true; toutHopitaux: boolean; hopitaux: HopitalDeveloppe[]; lignes: LigneDeveloppee[]; destinataires: string[] }
  | { ok: false; error: string };

/**
 * Un identifiant inconnu fait échouer la demande ENTIÈRE (la doctrine de `creerDemandeEtatStock`) :
 * un relevé partiel qu'on croit complet est pire qu'un refus.
 */
export function developperDemande(e: EntreeDeveloppement): Developpement {
  const candidats = new Set(e.candidats);
  const catalogue = new Set(e.catalogue);
  const choisis = [...new Set(e.hopitauxChoisis.map((s) => s.trim()).filter(Boolean))];
  const inconnus = choisis.filter((id) => !candidats.has(id));
  if (inconnus.length > 0) return { ok: false, error: "Établissement inconnu dans la sélection — rechargez la page." };
  const toutHopitaux = choisis.length === 0;
  const cibles = toutHopitaux ? [...e.candidats] : e.candidats.filter((id) => choisis.includes(id));
  if (cibles.length === 0) return { ok: false, error: "Aucun établissement à interroger." };

  for (const [h, prods] of Object.entries(e.produitsChoisis)) {
    if (!cibles.includes(h) && prods.length > 0) return { ok: false, error: "Des produits visent un établissement qui n'est pas dans la demande." };
    if (prods.some((p) => !catalogue.has(p))) return { ok: false, error: "Produit inconnu dans la sélection — rechargez la page." };
  }
  const communs = new Set(e.produitsCommuns ?? []);
  if ([...communs].some((p) => !catalogue.has(p))) return { ok: false, error: "Produit inconnu dans la sélection — rechargez la page." };

  const hopitaux: HopitalDeveloppe[] = [];
  const lignes: LigneDeveloppee[] = [];
  for (const h of cibles) {
    const porteurs = e.couverture.get(h) ?? [];
    const explicites = [...new Set(e.produitsChoisis[h] ?? [])];
    const tousProduits = explicites.length === 0 && communs.size === 0;
    const produits = explicites.length > 0
      ? e.catalogue.filter((p) => explicites.includes(p))
      : produitsCouverts(porteurs, e.catalogue, e.produitsParBu).filter((p) => communs.size === 0 || communs.has(p));
    hopitaux.push({ institutionId: h, tousProduits, sansKam: porteurs.length === 0, kamIds: unique(porteurs.map((p) => p.kamId)) });
    for (const p of produits) lignes.push({ institutionId: h, productId: p, kamIds: kamsDeLaCase(porteurs, p, e.produitsParBu) });
  }
  const destinataires = unique(lignes.flatMap((l) => l.kamIds));
  if (destinataires.length === 0) {
    return { ok: false, error: "Aucun KAM ne porte ces établissements et ces produits : la demande ne partirait vers personne. Vérifiez les secteurs (Business Units › Secteurs)." };
  }
  return { ok: true, toutHopitaux, hopitaux, lignes, destinataires };
}

// ── 3. LA SAISIE DU KAM : des tableaux parallèles, relus sans complaisance ────────────────

export interface EntreeSaisie {
  institutionId: string;
  productId: string;
  /** Nul = laissé vide (brouillon). */
  quantite: number | null;
  rupture: boolean;
}

export type Saisie = { ok: true; entrees: EntreeSaisie[] } | { ok: false; error: string };

const OUI = new Set(["1", "on", "true"]);

/**
 * `hopitalId[i]`, `produitId[i]`, `quantite[i]`, `rupture[i]` décrivent la même case. Des
 * longueurs différentes = un formulaire tronqué : on refuse plutôt que d'aligner de travers (le
 * stock d'un produit écrit sur son voisin). Une rupture vaut 0, quoi qu'on ait tapé.
 */
export function lireSaisie(hopitalIds: readonly string[], produitIds: readonly string[], quantites: readonly string[], ruptures: readonly string[]): Saisie {
  const n = hopitalIds.length;
  if (produitIds.length !== n || quantites.length !== n || ruptures.length !== n) {
    return { ok: false, error: "Formulaire incomplet (colonnes de longueurs différentes) — rechargez la page." };
  }
  const vus = new Set<string>();
  const entrees: EntreeSaisie[] = [];
  for (let i = 0; i < n; i++) {
    const institutionId = String(hopitalIds[i]).trim();
    const productId = String(produitIds[i]).trim();
    if (!institutionId || !productId) return { ok: false, error: "Case sans établissement ou sans produit." };
    const cle = `${institutionId}|${productId}`;
    if (vus.has(cle)) return { ok: false, error: "La même case figure deux fois dans le formulaire." };
    vus.add(cle);
    const rupture = OUI.has(String(ruptures[i]).trim().toLowerCase());
    const brut = String(quantites[i]).replace(/\s/g, "").replace(",", ".");
    let quantite: number | null = null;
    if (rupture) quantite = 0;
    else if (brut !== "") {
      const v = Number(brut);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        return { ok: false, error: `Quantité invalide (« ${quantites[i]} ») : un nombre entier de boîtes, 0 ou plus.` };
      }
      quantite = v;
    }
    entrees.push({ institutionId, productId, quantite, rupture });
  }
  return { ok: true, entrees };
}

// ── 4. L'AVANCEMENT ET LA CONSOLIDATION ───────────────────────────────────────────────────

export interface LigneEtat {
  /** L'établissement DE LA DEMANDE (sa ligne figée), pas celui de l'annuaire — il peut avoir disparu. */
  hopitalId: string;
  productId: string | null;
  kamIds: readonly string[];
  quantite: number | null;
  rupture: boolean;
}

export const ligneRemplie = (l: Pick<LigneEtat, "quantite" | "rupture">): boolean => l.rupture || l.quantite !== null;

export interface AvancementKam {
  kamId: string;
  total: number;
  remplies: number;
  envoye: boolean;
}

export function avancementParKam(lignes: readonly LigneEtat[], destinataires: readonly { kamId: string; envoyeLe: Date | string | null }[]): AvancementKam[] {
  return destinataires.map((d) => {
    const siennes = lignes.filter((l) => l.kamIds.includes(d.kamId));
    return { kamId: d.kamId, total: siennes.length, remplies: siennes.filter(ligneRemplie).length, envoye: d.envoyeLe !== null };
  });
}

/** Ce qui manque encore avant d'envoyer — les cases du KAM ni chiffrées ni en rupture. */
export const casesManquantes = (lignes: readonly Pick<LigneEtat, "quantite" | "rupture">[]): number => lignes.filter((l) => !ligneRemplie(l)).length;

export interface AvancementGlobal {
  total: number;
  remplies: number;
  sansKam: number;
  pourcentage: number;
}

export function avancementGlobal(lignes: readonly LigneEtat[]): AvancementGlobal {
  const routees = lignes.filter((l) => l.kamIds.length > 0);
  const remplies = routees.filter(ligneRemplie).length;
  return {
    total: routees.length,
    remplies,
    sansKam: lignes.length - routees.length,
    pourcentage: routees.length === 0 ? 0 : Math.round((remplies / routees.length) * 100),
  };
}

export type Cellule =
  | { etat: "HORS" }
  | { etat: "SANS_KAM" }
  | { etat: "A_RENSEIGNER" }
  | { etat: "RUPTURE" }
  | { etat: "QUANTITE"; quantite: number };

export function celluleDe(l: LigneEtat | undefined): Cellule {
  if (!l) return { etat: "HORS" };
  if (l.rupture) return { etat: "RUPTURE" };
  if (l.quantite !== null) return { etat: "QUANTITE", quantite: l.quantite };
  if (l.kamIds.length === 0) return { etat: "SANS_KAM" };
  return { etat: "A_RENSEIGNER" };
}

export interface Matrice {
  produits: { id: string; label: string; total: number }[];
  lignes: { hopitalId: string; cellules: Cellule[] }[];
}

/**
 * LE TABLEAU CONSOLIDÉ — établissements en lignes, produits en colonnes (dans l'ordre où ils
 * apparaissent), avec le total des boîtes par produit. Une case absente de la demande est « HORS »
 * (pas un zéro : on ne l'a pas demandée).
 */
export function consolider(
  hopitaux: readonly { id: string }[],
  lignes: readonly (LigneEtat & { productLabel: string })[],
): Matrice {
  const produits: { id: string; label: string; total: number }[] = [];
  const index = new Map<string, number>();
  for (const l of lignes) {
    if (!l.productId || index.has(l.productId)) continue;
    index.set(l.productId, produits.length);
    produits.push({ id: l.productId, label: l.productLabel, total: 0 });
  }
  const parCle = new Map(lignes.filter((l) => l.productId).map((l) => [`${l.hopitalId}|${l.productId}`, l]));
  for (const l of lignes) {
    const i = l.productId ? index.get(l.productId) : undefined;
    if (i !== undefined && l.quantite !== null && !l.rupture) produits[i]!.total += l.quantite;
  }
  return {
    produits,
    lignes: hopitaux.map((h) => ({
      hopitalId: h.id,
      cellules: produits.map((p) => celluleDe(parCle.get(`${h.id}|${p.id}`))),
    })),
  };
}
