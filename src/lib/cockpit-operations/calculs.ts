import { evolution, moisCourt } from "@/lib/ventes-pch/calculs";
import { SEUIL_RUPTURE_MOIS, couvertureEnMois, estPerime, niveauCouverture, stockDeLaChaine } from "@/lib/stocks/pch-central";

/**
 * COCKPIT OPÉRATIONS — LES CALCULS (module PUR : n'importe que deux modules purs, eux-mêmes sans import).
 *
 * Les tuiles (livré à la PCH, exécution des marchés, demande non servie, ruptures à 60 jours), la table « Par BU » et la
 * liste « À traiter » se calculent ICI, à partir de ce que `queries/cockpit-operations.ts` a lu — testés sans base.
 * Une donnée absente n'est jamais un zéro : chaque cumul dit s'il est LISIBLE, l'écran affiche « — » et sa raison.
 */

export type Ton = "ko" | "w" | "i";
const RANG_TON: Record<Ton, number> = { ko: 0, w: 1, i: 2 };

/** Un objet rattaché à des BU est-il dans la BU choisie ? Aucune BU choisie : oui. */
export const dansLaBu = (bus: readonly { id: string }[], buId: string | null): boolean => !buId || bus.some((b) => b.id === buId);

const nb = (n: number) => Math.round(n).toLocaleString("fr-FR");
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

// ─────────────────────────── Livré à la PCH ───────────────────────────

export interface LigneLivre { recuNous: number; recuValeur: number | null; sansFournisseur: boolean; bus: readonly { id: string }[] }
export interface CumulLivre {
  /** Au moins un produit dont le fournisseur « à nous » est réglé : le sell-in se lit. */
  lisible: boolean;
  boites: number;
  /** Valeur au coût d'achat PCH (DZD) des produits valorisés. */
  valeur: number;
  valorise: boolean;
}

/** NOS RÉCEPTIONS À LA PCH sur une période, bornées à la BU — un produit sans fournisseur réglé ne compte pas (illisible). */
export function cumulLivre(lignes: readonly LigneLivre[], buId: string | null): CumulLivre {
  const l = lignes.filter((x) => dansLaBu(x.bus, buId) && !x.sansFournisseur);
  return {
    lisible: l.length > 0,
    boites: l.reduce((s, x) => s + x.recuNous, 0),
    valeur: l.reduce((s, x) => s + (x.recuValeur ?? 0), 0),
    valorise: l.some((x) => x.recuValeur !== null && x.recuNous > 0),
  };
}

/** L'évolution sur la période de comparaison : en valeur quand les deux sont valorisées, sinon en boîtes. */
export function evolutionLivre(actuel: CumulLivre, precedent: CumulLivre | null): number | null {
  if (!precedent || !actuel.lisible || !precedent.lisible) return null;
  if (actuel.valorise && precedent.valorise && precedent.valeur > 0) return evolution(actuel.valeur, precedent.valeur);
  return evolution(actuel.boites, precedent.boites);
}

// ─────────────────────────── Exécution des marchés ───────────────────────────

export interface PeriodeMarche {
  /** Statut du contrat (`LegalDocStatus`) — null pour un lot gagné sans contrat enregistré. */
  statut: string | null;
  debut: Date | null;
  fin: Date | null;
  /** Date d'attribution de l'AO. */
  attribution: Date | null;
}

/**
 * UN MARCHÉ DE L'ANNÉE EN COURS : sa période (début du contrat, à défaut l'attribution) croise l'année civile. Un
 * contrat annulé n'en est pas ; un contrat échu sans date de fin non plus. Un lot gagné sans contrat ni date compte
 * (on l'exécute) ; avec une date d'attribution, seulement s'il a été attribué cette année ou l'an dernier.
 */
export function marcheEnCours(m: PeriodeMarche, annee: number): boolean {
  if (m.statut === "CANCELLED") return false;
  const debutAn = new Date(Date.UTC(annee, 0, 1)), finAn = new Date(Date.UTC(annee + 1, 0, 1));
  const debut = m.debut ?? m.attribution;
  if (debut && debut >= finAn) return false;
  if (m.fin) return m.fin >= debutAn;
  if (m.statut === "EXPIRED") return false;
  if (!m.debut && m.attribution) return m.attribution >= new Date(Date.UTC(annee - 1, 0, 1));
  return true;
}

export interface ChaineMarche {
  nom: string;
  reference: string | null;
  bus: readonly { id: string }[];
  attribue: number;
  commande: number;
  livre: number;
  bcAvenants: number;
  enCours: boolean;
}

export interface Execution { attribue: number; livre: number; pct: number | null; marches: number }

/** LIVRÉ ÷ ATTRIBUÉ sur les marchés en cours de la BU (unités du marché). Rien d'attribué : `pct` nul (jamais 0 %). */
export function executionDesMarches(chaines: readonly ChaineMarche[], buId: string | null): Execution {
  const c = chaines.filter((x) => x.enCours && x.attribue > 0 && dansLaBu(x.bus, buId));
  const attribue = c.reduce((s, x) => s + x.attribue, 0);
  const livre = c.reduce((s, x) => s + x.livre, 0);
  return { attribue, livre, marches: c.length, pct: attribue > 0 ? Math.round((livre / attribue) * 100) : null };
}

// ─────────────────────────── Demande non servie ───────────────────────────

export interface LigneNonServie { productId: string; quantite: number }

/** La quantité demandée et non servie, sur les produits de la BU (`produits` nul = tous). */
export function cumulNonServi(lignes: readonly LigneNonServie[], produits: ReadonlySet<string> | null): number {
  return lignes.filter((l) => !produits || produits.has(l.productId)).reduce((s, l) => s + l.quantite, 0);
}

// ─────────────────────────── Couverture de la chaîne ───────────────────────────

export interface LigneCouverture {
  productId: string;
  label: string;
  buId: string | null;
  buNom: string;
  /** Le stock de la PCH centrale. Adventum n'a pas de stock propre : la chaîne = PCH central + directions régionales + hôpitaux. */
  pch: number | null;
  /** La somme du dernier relevé de chaque direction régionale de la PCH. */
  directions: number | null;
  hopitaux: number | null;
  conso: number | null;
  stock: number | null;
  couverture: number | null;
}

export function ligneCouverture(l: Omit<LigneCouverture, "stock" | "couverture">): LigneCouverture {
  const stock = stockDeLaChaine([l.pch, l.directions, l.hopitaux]);
  return { ...l, stock, couverture: couvertureEnMois(stock, l.conso) };
}

/** Un produit porté par deux BU apparaît deux fois dans la chaîne : sans BU choisie, on ne le compte qu'une fois. */
function distincts(lignes: readonly LigneCouverture[], buId: string | null): LigneCouverture[] {
  const vus = new Set<string>();
  return lignes.filter((l) => {
    if (buId && l.buId !== buId) return false;
    if (vus.has(l.productId)) return false;
    vus.add(l.productId);
    return true;
  });
}

/**
 * RUPTURES À 60 JOURS : les produits dont la couverture de la chaîne est sous 2 mois, du plus court au plus long.
 * `mesurables` = ceux dont la couverture se calcule (stock ET consommation connus) — zéro mesurable : la tuile dit « — ».
 */
export function rupturesA60Jours(lignes: readonly LigneCouverture[], buId: string | null): { mesurables: number; produits: number; enRupture: LigneCouverture[] } {
  const d = distincts(lignes, buId);
  const mesurees = d.filter((l) => l.couverture !== null);
  return {
    mesurables: mesurees.length,
    produits: d.length,
    enRupture: mesurees.filter((l) => niveauCouverture(l.couverture) === "rupture").sort((a, b) => a.couverture! - b.couverture!),
  };
}

/** La couverture la plus COURTE d'un produit de la BU — c'est elle qui dit le risque, pas une moyenne qui le cache. */
export function couvertureLaPlusCourte(lignes: readonly LigneCouverture[], buId: string): LigneCouverture | null {
  const m = lignes.filter((l) => l.buId === buId && l.couverture !== null).sort((a, b) => a.couverture! - b.couverture!);
  return m[0] ?? null;
}

// ─────────────────────────── À traiter ───────────────────────────

export interface ATraiter {
  cle: string;
  ton: Ton;
  titre: string;
  detail: string;
  href: string;
  action: string;
  /** À ton égal, le plus lourd d'abord. */
  poids: number;
}

export const MAX_A_TRAITER = 7;

/** LES 7 PREMIERS : rouge, puis orange, puis information ; à ton égal le plus lourd ; une clé ne compte qu'une fois. */
export function selectionnerATraiter(items: readonly ATraiter[], max = MAX_A_TRAITER): ATraiter[] {
  const vus = new Set<string>();
  return [...items]
    .sort((a, b) => RANG_TON[a.ton] - RANG_TON[b.ton] || b.poids - a.poids || a.titre.localeCompare(b.titre))
    .filter((x) => (vus.has(x.cle) ? false : (vus.add(x.cle), true)))
    .slice(0, max);
}

/** Rupture de la chaîne : un élément par produit sous 2 mois, avec le détail du stock. */
export function aTraiterRuptures(enRupture: readonly LigneCouverture[], href: (l: LigneCouverture) => string): ATraiter[] {
  return enRupture.map((l) => {
    const parts = [
      l.pch !== null ? `PCH ${nb(l.pch)}` : null,
      l.directions !== null ? `DR ${nb(l.directions)}` : null,
      l.hopitaux !== null ? `hôpitaux ${nb(l.hopitaux)}` : null,
      l.conso !== null ? `conso ${nb(l.conso)}/mois` : null,
    ].filter(Boolean);
    return {
      cle: `rupture:${l.productId}`, ton: "ko" as const,
      titre: `${l.label} : ${l.couverture!.toLocaleString("fr-FR")} mois de couverture`,
      detail: parts.join(" · "), href: href(l), action: "Voir",
      poids: Math.round((SEUIL_RUPTURE_MOIS - l.couverture!) * 100),
    };
  });
}

const JOUR = 86_400_000;
const debutDuJour = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export interface BcSuivi {
  id: string;
  reference: string | null;
  tenderId: string;
  statut: string;
  /** Arrivée prévue du BC, et arrivée réelle. */
  attendu: Date | null;
  arrive: Date | null;
  /** Les livraisons du BC : date prévue, date de livraison. */
  livraisons: { attendu: Date | null; livre: Date | null }[];
}

/**
 * UN BC PCH EN RETARD : encore ouvert (reçu ou validé) et dont l'arrivée prévue — ou une livraison prévue — est passée
 * sans être arrivée. Le retard est compté en jours depuis la date prévue la plus ancienne dépassée.
 */
export function bcEnRetard(bcs: readonly BcSuivi[], maintenant: Date): (BcSuivi & { jours: number })[] {
  const auj = debutDuJour(maintenant);
  const out: (BcSuivi & { jours: number })[] = [];
  for (const b of bcs) {
    if (b.statut !== "PENDING" && b.statut !== "VALIDATED") continue;
    const depassees: number[] = [];
    if (b.attendu && !b.arrive && debutDuJour(b.attendu) < auj) depassees.push(debutDuJour(b.attendu));
    for (const l of b.livraisons) if (l.attendu && !l.livre && debutDuJour(l.attendu) < auj) depassees.push(debutDuJour(l.attendu));
    if (depassees.length) out.push({ ...b, jours: Math.round((auj - Math.min(...depassees)) / JOUR) });
  }
  return out.sort((a, b) => b.jours - a.jours);
}

export function aTraiterBcEnRetard(enRetard: readonly (BcSuivi & { jours: number })[]): ATraiter[] {
  if (!enRetard.length) return [];
  const refs = enRetard.slice(0, 3).map((b) => b.reference ? `BC ${b.reference}` : "BC sans n°");
  const reste = enRetard.length - refs.length;
  return [{
    cle: "bc-retard", ton: "ko",
    titre: enRetard.length === 1 ? `1 BC PCH en retard de livraison (${enRetard[0].jours} j)` : `${enRetard.length} BC PCH en retard de livraison`,
    detail: `${refs.join(", ")}${reste > 0 ? ` et ${reste} autre${reste > 1 ? "s" : ""}` : ""} · le plus ancien : ${enRetard[0].jours} j`,
    href: enRetard.length === 1 ? `/pch/${enRetard[0].tenderId}` : "/pch", action: "Voir",
    poids: enRetard[0].jours,
  }];
}

export interface NonServiProduit { productId: string; nom: string; quantite: number; etablissements: number; drs: string[] }

/**
 * DES HÔPITAUX EN RUPTURE ALORS QUE LA PCH CENTRALE A DU STOCK : une demande non servie ce mois-ci, et un stock PCH
 * central positif au dernier relevé — le réapprovisionnement des annexes est à demander, pas une livraison de plus.
 */
export function aTraiterHopitauxEnRupture(nonServi: readonly NonServiProduit[], stockPchCentral: ReadonlyMap<string, number | null>, href: string): ATraiter[] {
  const out: ATraiter[] = [];
  for (const p of nonServi) {
    const stock = stockPchCentral.get(p.productId) ?? null;
    if (!(p.quantite > 0) || stock === null || !(stock > 0)) continue;
    out.push({
      cle: `hopitaux:${p.productId}`, ton: "w",
      titre: `${p.nom} : ${pluriel(p.etablissements, "établissement")} non servi${p.etablissements > 1 ? "s" : ""}`,
      detail: `${nb(p.quantite)} demandées · stock PCH central ${nb(stock)}${p.drs.length ? ` · ${p.drs.slice(0, 3).join(", ")}` : ""}`,
      href, action: "Voir", poids: p.quantite,
    });
  }
  return out;
}

/** AVENANT À PRÉVOIR : un marché en cours dont les BC cumulés atteignent l'attribué, sans BC d'avenant encore. */
export function aTraiterAvenants(chaines: readonly ChaineMarche[], href: string): ATraiter[] {
  return chaines
    .filter((c) => c.enCours && c.attribue > 0 && c.commande >= c.attribue && c.bcAvenants === 0)
    .map((c) => ({
      cle: `avenant:${c.nom}:${c.reference ?? ""}`, ton: "w" as const,
      titre: `${c.nom} : avenant à prévoir`,
      detail: `BC cumulés ${nb(c.commande)} / attribué ${nb(c.attribue)}${c.reference ? ` · ${c.reference}` : ""}`,
      href, action: "Voir", poids: Math.round((c.commande / c.attribue) * 100),
    }));
}

export interface SourceFraicheur { source: string; libelle: string; dernier: string | null; manquants: string[] }

/**
 * LES TROUS DANS LES FICHIERS PCH : une source (DR, réceptions) avec un mois manquant, ou en retard sur le dernier mois
 * reçu ailleurs. Un seul élément, qui nomme les sources.
 */
export function aTraiterFichiersPch(sources: readonly SourceFraicheur[], dernierMois: string | null, href: string): ATraiter[] {
  const trous: string[] = [];
  for (const s of sources) {
    if (s.manquants.length) trous.push(`${s.source} : ${s.manquants.slice(-2).map(moisCourt).join(", ")}`);
    else if (s.dernier && dernierMois && s.dernier < dernierMois) trous.push(`${s.source} : depuis ${moisCourt(s.dernier)}`);
  }
  if (!trous.length) return [];
  return [{
    cle: "fichiers-pch", ton: "i",
    titre: `Fichiers PCH incomplets (${pluriel(trous.length, "source")})`,
    detail: trous.slice(0, 3).join(" · ") + (trous.length > 3 ? " …" : ""),
    href, action: "Importer", poids: trous.length,
  }];
}

/** LE STOCK PCH (central et directions régionales) QUI VIEILLIT : le relevé le plus récent a plus de 30 jours — ou il n'y en a jamais eu. */
export function aTraiterStockPch(ageDernierReleve: number | null, produits: number, href: string): ATraiter[] {
  if (produits === 0) return [];
  if (ageDernierReleve === null) return [{ cle: "stock-pch", ton: "i", titre: "Stock PCH jamais saisi", detail: "la couverture de la chaîne s'en passe", href, action: "Saisir", poids: 0 }];
  if (!estPerime(ageDernierReleve)) return [];
  return [{ cle: "stock-pch", ton: "i", titre: `Stock PCH : dernier relevé il y a ${ageDernierReleve} j`, detail: "au-delà de 30 jours, la couverture vieillit", href, action: "Saisir", poids: ageDernierReleve }];
}

export interface RisqueBrain { id: string; level: string; title: string; object: string; href: string | null }

/** LES RISQUES D'ADVENTUM BRAIN du périmètre (déjà filtrés) : les 3 plus graves. */
export function aTraiterBrain(risques: readonly RisqueBrain[], hrefParDefaut: string): ATraiter[] {
  const rang: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...risques]
    .sort((a, b) => (rang[a.level] ?? 9) - (rang[b.level] ?? 9))
    .slice(0, 3)
    .map((r) => ({
      cle: `brain:${r.id}`, ton: r.level === "critical" ? "ko" as const : r.level === "high" ? "w" as const : "i" as const,
      titre: r.title, detail: r.object, href: r.href && r.href.startsWith("/") ? r.href : hrefParDefaut, action: "Ouvrir",
      poids: 3 - (rang[r.level] ?? 3),
    }));
}
