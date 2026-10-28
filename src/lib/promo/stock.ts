import { arrondirAuMillieme } from "@/lib/utils";
/**
 * LE STOCK DE MATÉRIEL PROMOTIONNEL — ce qu'on a, et pourquoi on l'a.
 *
 * On commande 5 000 blocs-notes et 300 présentoirs, on en distribue aux délégués, on en perd à
 * un congrès, on en retrouve au fond d'un carton. Sans registre, la seule réponse à « en
 * reste-t-il ? » est « je crois ». On recommande alors ce qu'on avait déjà, ou l'on part en
 * tournée sans support.
 *
 * DEUX FAÇONS DE TENIR UN STOCK, et une seule tient dans la durée :
 *
 *   • écrire une quantité et la corriger à chaque fois — le nombre est faux dès la première
 *     distribution non saisie, et rien ne dit quand ni pourquoi ;
 *   • n'écrire que des MOUVEMENTS et calculer la quantité — c'est ce qui est fait ici. Le stock
 *     est une conséquence, jamais une saisie. On peut donc toujours répondre à « pourquoi
 *     600 ? » en relisant les lignes.
 *
 * Module PUR — testé.
 */

/** Nature d'un mouvement — elle dit le SENS, et sert de motif dans le registre. */
export type MovementKind =
  /** Entrée : livraison, saisie manuelle du Super Admin. */
  | "RECEIPT"
  /** Sortie : remise (mouvements d'avant le registre par détenteur ; remise à un médecin). */
  | "DISTRIBUTION"
  /** Sortie sans contrepartie : casse, perte, péremption d'un support daté, écart de réception. */
  | "LOSS"
  /** Correction d'inventaire — dans les deux sens, et assumée comme telle. */
  | "CORRECTION"
  /** Inventaire d'ouverture : ce qu'un détenteur avait déjà quand le registre a commencé. */
  | "OPENING"
  /** Départ d'un transfert : la quantité quitte celui qui donne. */
  | "TRANSFER_OUT"
  /** Arrivée confirmée par celui qui reçoit. */
  | "TRANSFER_IN"
  /** Retour à l'envoyeur : transfert refusé ou annulé. */
  | "TRANSFER_BACK"
  /** Annulation d'un mouvement erroné — son exact inverse. */
  | "REVERSAL"
  /** Réservé pour un événement Ad & Pro : quitte le magasin à l'accord du poste (§118.167). */
  | "RESERVATION_OUT"
  /** Retour d'événement : ce qui n'a pas été remis, ou le durable rendu. */
  | "RESERVATION_BACK";

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  RECEIPT: "Entrée",
  DISTRIBUTION: "Distribution",
  LOSS: "Perte / casse",
  CORRECTION: "Correction d'inventaire",
  OPENING: "Inventaire d'ouverture",
  TRANSFER_OUT: "Départ",
  TRANSFER_IN: "Réception",
  TRANSFER_BACK: "Retour à l'envoyeur",
  REVERSAL: "Annulation",
  RESERVATION_OUT: "Réservé pour un événement",
  RESERVATION_BACK: "Retour d'événement",
};

/**
 * LES MOUVEMENTS QU'UNE ANNULATION PEUT DÉFAIRE — les saisies simples, jamais un transfert.
 *
 * Un transfert a son propre cycle (annuler tant qu'il est en route, rendre après réception) :
 * annuler sa seule jambe d'arrivée remettrait la quantité « en route » sans que personne ne l'ait
 * renvoyée. Une annulation n'annule pas une annulation non plus : on refait la saisie.
 */
export const KINDS_ANNULABLES: readonly MovementKind[] = ["RECEIPT", "OPENING", "LOSS", "CORRECTION"];

/**
 * Une quantité saisie à la main : virgule française, espaces, champ vide.
 * Rend `null` sur ce qui n'est pas un nombre — jamais NaN, qui se propagerait dans le stock.
 */
export function parseQuantity(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? "").replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type StockLevel = "OUT" | "LOW" | "OK";

/**
 * L'état d'un article, pour le signaler AVANT la rupture.
 *
 * Le seuil d'alerte est propre à chaque article — 50 présentoirs, ce n'est pas 50 stylos — et
 * il se règle. À défaut de seuil, on ne crie pas au loup : seule la rupture est signalée.
 */
export function stockLevel(current: number, threshold: number | null | undefined): StockLevel {
  if (current <= 0) return "OUT";
  if (threshold != null && threshold > 0 && current <= threshold) return "LOW";
  return "OK";
}

export const STOCK_LEVEL_LABEL: Record<StockLevel, string> = {
  OUT: "En rupture",
  LOW: "Stock bas",
  OK: "Disponible",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LE REGISTRE PAR LOT ET PAR DÉTENTEUR (§118.164)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** La clé du magasin central dans les tables de soldes — un détenteur `null`, rendu lisible. */
export const MAGASIN = "__magasin__";

export const cleDetenteur = (holderId: string | null | undefined): string => holderId ?? MAGASIN;

/**
 * LA CLÉ DES PRODUITS d'un article de stock : identifiants triés, sans doublon, joints par une
 * virgule. Écrite une fois à la création ; c'est elle que l'index d'unicité lit. L'ordre de saisie
 * ne doit pas compter — « Nivolex + Trastuzex » et « Trastuzex + Nivolex » sont le même article.
 */
export function cleProduits(ids: readonly string[]): string {
  return [...new Set(ids.map((i) => i.trim()).filter(Boolean))].sort().join(",");
}

/** « Fiche posologique — Nivolex, Trastuzex », ou le seul nom de l'article s'il n'a pas de produit. */
export function libelleArticleStock(nomCatalogue: string, produits: readonly string[]): string {
  const p = produits.map((x) => x.trim()).filter(Boolean);
  return p.length ? `${nomCatalogue} — ${p.join(", ")}` : nomCatalogue;
}

export type NatureTransfert = "DOTATION" | "TRANSFERT" | "RETOUR";

export const NATURE_TRANSFERT_LABEL: Record<NatureTransfert, string> = {
  DOTATION: "Dotation",
  TRANSFERT: "Transfert",
  RETOUR: "Retour au magasin",
};

/**
 * LA NATURE D'UN TRANSFERT se DÉDUIT de ses deux bouts — elle ne se saisit pas, donc elle ne peut
 * pas contredire ce qui a eu lieu. `null` = ce n'est pas un transfert (magasin vers magasin, ou
 * quelqu'un vers lui-même).
 */
export function natureDuTransfert(deId: string | null, versId: string | null): NatureTransfert | null {
  if (deId === null && versId === null) return null;
  if (deId !== null && deId === versId) return null;
  if (deId === null) return "DOTATION";
  if (versId === null) return "RETOUR";
  return "TRANSFERT";
}

export type EtatValidite = "SANS_DATE" | "VALIDE" | "BIENTOT" | "PERIME";

export const ETAT_VALIDITE_LABEL: Record<EtatValidite, string> = {
  SANS_DATE: "Sans date de fin",
  VALIDE: "Valide",
  BIENTOT: "Expire bientôt",
  PERIME: "Périmé",
};

const JOUR_MS = 86_400_000;

/** Combien de jours avant la fin de validité l'écran prévient. */
export const JOURS_ALERTE_VALIDITE = 30;

/**
 * L'ÉTAT DE VALIDITÉ d'un lot ou d'un support. La date est INCLUSIVE : « valable jusqu'au
 * 31/12/2027 » se distribue encore le 31 — elle est stockée à minuit (UTC) du jour dit, donc le
 * lot ne périme qu'au jour suivant. Le jour de référence est un argument OBLIGATOIRE : une valeur
 * par défaut ferait d'un test une bombe à retardement (§118.131).
 */
export function etatValidite(valableJusquau: Date | null | undefined, maintenant: Date): EtatValidite {
  if (!valableJusquau) return "SANS_DATE";
  const fin = valableJusquau.getTime() + JOUR_MS;
  if (maintenant.getTime() >= fin) return "PERIME";
  if (fin - maintenant.getTime() <= JOURS_ALERTE_VALIDITE * JOUR_MS) return "BIENTOT";
  return "VALIDE";
}

/** Une date saisie « AAAA-MM-JJ » → minuit UTC de ce jour ; `null` sur tout ce qui ne se lit pas. */
export function lireDateJour(raw: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Le 31/02 n'existe pas : `Date.UTC` le ferait glisser au 3 mars en silence.
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

export interface LotDisponible {
  lotId: string;
  numero: number;
  /** Ce que CE détenteur a de ce lot. */
  solde: number;
  valableJusquau: Date | null;
  recuLe: Date;
}

/**
 * L'ORDRE DE SORTIE — personne ne choisit un lot à la main (§118.164).
 *
 * Le lot qui expire le plus tôt d'abord (un lot sans date passe après tous ceux qui en ont une),
 * puis le plus ancien, puis le plus petit numéro : l'ordre est TOTAL, donc deux appels sur les
 * mêmes lots rendent toujours la même répartition — sans quoi deux écrans montreraient deux lots
 * différents pour la même sortie.
 */
export function ordreDeSortie(a: LotDisponible, b: LotDisponible): number {
  const ea = a.valableJusquau ? a.valableJusquau.getTime() : Number.POSITIVE_INFINITY;
  const eb = b.valableJusquau ? b.valableJusquau.getTime() : Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;
  const ra = a.recuLe.getTime();
  const rb = b.recuLe.getTime();
  if (ra !== rb) return ra - rb;
  return a.numero - b.numero;
}

export interface Tranche {
  lotId: string;
  quantite: number;
}

export type Allocation =
  | { ok: true; tranches: Tranche[] }
  | { ok: false; raison: string; disponible: number; bloqueParPeremption: number };

/**
 * QUELS LOTS SORTENT pour une quantité donnée — le lot qui expire le plus tôt d'abord.
 *
 * `inclurePerimes` : une DISTRIBUTION (dotation, transfert, remise) ne prend jamais un lot périmé
 * — on ne remet pas une fiche dont la validité est passée. Une PERTE, elle, le prend en premier :
 * c'est précisément ainsi qu'on déclare un lot périmé détruit. Le refus dit ce qui bloque, et
 * sépare ce qui manque de ce qui existe mais ne se distribue plus.
 */
export function allouer(
  lots: readonly LotDisponible[],
  quantite: number,
  opts: { maintenant: Date; inclurePerimes: boolean },
): Allocation {
  // Une quantité NÉGATIVE est refusée, pas retournée : `Math.abs` ferait sortir 5 unités sur une
  // demande de « −5 », c'est-à-dire l'inverse de ce qu'un appelant égaré a écrit.
  const q = arrondirAuMillieme(quantite);
  if (!(q > 0)) return { ok: false, raison: "Indiquez une quantité supérieure à zéro.", disponible: 0, bloqueParPeremption: 0 };
  const positifs = lots.filter((l) => l.solde > 0);
  const perimes = positifs.filter((l) => etatValidite(l.valableJusquau, opts.maintenant) === "PERIME");
  const utilisables = (opts.inclurePerimes ? positifs : positifs.filter((l) => !perimes.includes(l))).slice().sort(ordreDeSortie);
  const disponible = arrondirAuMillieme(utilisables.reduce((a, l) => a + l.solde, 0));
  const bloqueParPeremption = opts.inclurePerimes ? 0 : arrondirAuMillieme(perimes.reduce((a, l) => a + l.solde, 0));
  if (q > disponible) {
    const reste = disponible <= 0 ? "Il ne reste rien de distribuable" : `Il ne reste que ${disponible} de distribuable`;
    const peremption = bloqueParPeremption > 0
      ? ` (${bloqueParPeremption} autre(s) dans un lot périmé : déclarez-les détruits plutôt que de les remettre)`
      : "";
    return { ok: false, raison: `${reste}${peremption}.`, disponible, bloqueParPeremption };
  }
  const tranches: Tranche[] = [];
  let reste = q;
  for (const l of utilisables) {
    if (reste <= 0) break;
    const prise = arrondirAuMillieme(Math.min(l.solde, reste));
    tranches.push({ lotId: l.lotId, quantite: prise });
    reste = arrondirAuMillieme(reste - prise);
  }
  return { ok: true, tranches };
}

/**
 * CE QUI EST REÇU, ET CE QUI MANQUE, sur un transfert confirmé en partie.
 *
 * Les tranches parties (dans l'ordre de sortie) reçoivent la quantité confirmée dans le même
 * ordre : le lot qui expire le plus tôt arrive le premier. Le reste est MANQUANT — ni chez celui
 * qui donne (il l'a remis), ni chez celui qui reçoit (il ne l'a pas) — et se déclare comme tel,
 * jamais en silence.
 */
export function repartirReception(parties: readonly Tranche[], recue: number):
  { recues: Tranche[]; manquantes: Tranche[] } {
  let reste = arrondirAuMillieme(Math.max(0, recue));
  const recues: Tranche[] = [];
  const manquantes: Tranche[] = [];
  for (const t of parties) {
    const prise = arrondirAuMillieme(Math.min(t.quantite, reste));
    if (prise > 0) recues.push({ lotId: t.lotId, quantite: prise });
    const manque = arrondirAuMillieme(t.quantite - prise);
    if (manque > 0) manquantes.push({ lotId: t.lotId, quantite: manque });
    reste = arrondirAuMillieme(reste - prise);
  }
  return { recues, manquantes };
}
