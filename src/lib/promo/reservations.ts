/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL DU STOCK RÉSERVÉ POUR UN ÉVÉNEMENT AD & PRO (§118.167) — la règle, sans base.
 *
 * « Un poste "Matériel du stock" sur les demandes Ad & Pro : réserver avant, confirmer après, et le
 * reste revient automatiquement » (Direction, 10/2026). Le matériel d'un événement — kakémonos,
 * présentoirs, brochures, objets — sort du MAGASIN CENTRAL : c'est le seul stock qu'une demande
 * Ad & Pro engage, et la Direction Marketing, qui le tient, est aussi celle qui valide les postes.
 *
 * ── LE CYCLE D'UNE LIGNE ───────────────────────────────────────────────────────────────────
 *
 *   DEMANDÉE  le demandeur liste l'article et la quantité ; rien ne bouge encore au magasin —
 *             la liste est une demande, pas une confiscation ;
 *   RÉSERVÉE  à l'ACCORD du poste, la quantité quitte le magasin (sortie « réservé pour
 *             l'événement ») : personne ne peut plus la doter ailleurs. Au-delà de ce que le
 *             magasin a de distribuable, l'accord est REFUSÉ, ligne nommée — on n'accorde pas un
 *             matériel qui n'existe pas ;
 *   CONFIRMÉE après l'événement : ce qui a été remis (consommable) ou ce qui revient, s'abîme ou se
 *             perd (durable, PRÊTÉ) est déclaré une fois, et le reste revient AU MAGASIN par la
 *             même écriture — personne n'a à organiser un retour.
 *
 * ── QUATRE RÈGLES ──────────────────────────────────────────────────────────────────────────
 *
 * 1. UN DURABLE EST PRÊTÉ, PAS DONNÉ : sa confirmation rend compte de CHAQUE unité — rendue, abîmée
 *    ou perdue —, et la somme doit faire le compte réservé. Un kakémono dont on ne dit rien n'est
 *    ni rentré ni perdu : c'est exactement le trou que le registre existe pour fermer.
 * 2. UN CONSOMMABLE SE REMET : on dit combien ont été remis, le reste revient. Remettre plus qu'on
 *    n'a réservé n'existe pas.
 * 3. CE QUI REVIENT REVIENT DANS SES LOTS, le plus tard périmé d'abord : ce qu'on a remis pendant
 *    l'événement, ce sont les unités qui expiraient le plus tôt — sorties les premières.
 * 4. UNE DEMANDE NE SE CLÔTURE PAS SUR DU MATÉRIEL RÉSERVÉ : tant qu'une ligne attend sa
 *    confirmation, une partie du magasin est « dehors » sans que personne sache si elle revient.
 *
 * Module PUR — aucune base. Testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { MENU_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import type { PromoFamille } from "@/lib/promo/catalogue";
import { arrondirAuMillieme } from "@/lib/utils";

const EPS = 0.0005;
const nombre = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

export type StatutLigneReservation = "DEMANDEE" | "RESERVEE" | "CONFIRMEE";

export const STATUT_LIGNE_LABEL: Record<StatutLigneReservation, string> = {
  DEMANDEE: "Demandée",
  RESERVEE: "Réservée au magasin",
  CONFIRMEE: "Confirmée",
};

/** « 4 800 », « 12,5 » → nombre ; vide → null (non saisi) ; illisible → NaN. */
function lire(brut: unknown): number | null {
  const s = String(brut ?? "").replace(/\s/g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? arrondirAuMillieme(n) : Number.NaN;
}

export interface SaisieConfirmation {
  /** Consommable : combien ont été remis pendant l'événement. */
  utilisee?: unknown;
  /** Durable : combien sont revenus en état. */
  rendue?: unknown;
  abimee?: unknown;
  perdue?: unknown;
}

export interface Confirmation {
  utilisee: number | null;
  rendue: number;
  abimee: number | null;
  perdue: number | null;
  /** Ce qui revient au magasin, par la même écriture. */
  retour: number;
}

/**
 * LIRE LA CONFIRMATION D'UNE LIGNE — selon la famille de l'article. Rend la répartition, ou ce qui
 * ne va pas, nommé (l'appelant réunit les fautes de toutes les lignes, §118.18).
 */
export function lireConfirmation(
  famille: PromoFamille,
  reservee: number,
  s: SaisieConfirmation,
  libelle: string,
): { ok: true; confirmation: Confirmation } | { ok: false; faute: string } {
  if (famille === "DURABLE") {
    const rendue = lire(s.rendue) ?? 0;
    const abimee = lire(s.abimee) ?? 0;
    const perdue = lire(s.perdue) ?? 0;
    if ([rendue, abimee, perdue].some((x) => Number.isNaN(x))) return { ok: false, faute: `« ${libelle} » : une quantité est illisible` };
    if ([rendue, abimee, perdue].some((x) => x < 0)) return { ok: false, faute: `« ${libelle} » : une quantité est négative` };
    const total = arrondirAuMillieme(rendue + abimee + perdue);
    if (Math.abs(total - reservee) > EPS) {
      return {
        ok: false,
        faute: `« ${libelle} » est prêté : rendez compte de chaque unité — ${nombre(reservee)} réservée(s), ${nombre(total)} déclarée(s) (rendues + abîmées + perdues)`,
      };
    }
    return { ok: true, confirmation: { utilisee: null, rendue, abimee, perdue, retour: rendue } };
  }
  const utilisee = lire(s.utilisee);
  if (utilisee == null) return { ok: false, faute: `« ${libelle} » : dites combien ont été remis pendant l'événement (0 si rien)` };
  if (Number.isNaN(utilisee)) return { ok: false, faute: `« ${libelle} » : la quantité remise est illisible` };
  if (utilisee < 0) return { ok: false, faute: `« ${libelle} » : la quantité remise est négative` };
  if (utilisee > reservee + EPS) {
    return { ok: false, faute: `« ${libelle} » : ${nombre(utilisee)} remis, mais ${nombre(reservee)} seulement étaient réservés` };
  }
  const retour = arrondirAuMillieme(reservee - utilisee);
  return { ok: true, confirmation: { utilisee, rendue: retour, abimee: null, perdue: null, retour } };
}

export interface TrancheReservee {
  lotId: string;
  quantite: number;
  /** Fin de validité du lot (`null` = sans date) — décide l'ordre des retours. */
  valableJusquau: Date | null;
  recuLe: Date;
  numero: number;
}

/**
 * QUELS LOTS REÇOIVENT CE QUI REVIENT — le plus tard périmé d'abord (règle 3). Les unités remises
 * pendant l'événement sont celles qui expiraient le plus tôt : sorties les premières, consommées
 * les premières. Un retour ne dépasse jamais ce qu'une tranche a fait sortir.
 */
export function repartirRetour(tranches: readonly TrancheReservee[], retour: number): { lotId: string; quantite: number }[] {
  const fin = (t: TrancheReservee) => t.valableJusquau?.getTime() ?? Number.POSITIVE_INFINITY;
  const ordre = [...tranches].sort((a, b) =>
    fin(b) - fin(a) || b.recuLe.getTime() - a.recuLe.getTime() || b.numero - a.numero);
  const out: { lotId: string; quantite: number }[] = [];
  let reste = arrondirAuMillieme(retour);
  for (const t of ordre) {
    if (reste <= EPS) break;
    const q = arrondirAuMillieme(Math.min(t.quantite, reste));
    if (q > 0) out.push({ lotId: t.lotId, quantite: q });
    reste = arrondirAuMillieme(reste - q);
  }
  return out;
}

/**
 * LA PHRASE QUI BLOQUE L'ACCORD quand le magasin n'a pas de quoi réserver — elle nomme l'article,
 * la quantité, ce qui reste, et le geste (§118.30).
 */
export function refusReservation(libelle: string, quantite: number, raisonAllocation: string): string {
  return `${nombre(quantite)} « ${libelle} » à réserver, mais le magasin ne le permet pas : ${raisonAllocation.replace(/\.$/, "")}. `
    + `Rien n'est accordé. Réduisez la quantité du poste, ou faites d'abord entrer du stock (${MENU_STOCK_PROMO}).`;
}

export interface LignePourCloture {
  libelle: string;
  statut: StatutLigneReservation | string;
}

/** Ce que la clôture d'une demande refuse tant que du matériel réservé n'est pas confirmé (règle 4). */
export function manqueMaterielReserve(lignes: readonly LignePourCloture[]): string | null {
  const enAttente = lignes.filter((l) => l.statut === "RESERVEE");
  if (enAttente.length === 0) return null;
  const noms = enAttente.slice(0, 3).map((l) => `« ${l.libelle} »`).join(", ");
  const autres = enAttente.length > 3 ? ` et ${enAttente.length - 3} autre(s)` : "";
  return `${enAttente.length} article(s) du stock réservé(s) pour l'événement attendent leur confirmation (remis, rendus, abîmés ou perdus) : ${noms}${autres}`;
}

/** Un poste « Matériel du stock » n'engage pas d'argent : ni montant ni budget ne s'y exigent. */
export const NATURE_MATERIEL_STOCK = "STOCK_MATERIAL" as const;

/**
 * UN POSTE « MATÉRIEL DU STOCK » NE PORTE PAS D'ARGENT — la phrase qui refuse un geste d'argent sur
 * lui (montant, budget, bon de commande, ordre de dépense, pièce au secrétariat). L'écran ne les
 * montre pas ; l'action le refuse aussi, parce qu'une requête forgée ignore un écran (§118.71).
 * Rend `null` sur tout autre poste.
 */
export function refusArgentSurPosteStock(nature: string, geste: string): string | null {
  return nature === NATURE_MATERIEL_STOCK
    ? `Un poste « Matériel du stock » n'engage pas d'argent : ${geste} n'y a pas d'objet. `
      + "Son matériel se réserve au magasin à l'accord du poste, et se confirme après l'événement."
    : null;
}

export interface FaitsChangementNature {
  statut: string;
  /** Les articles du stock listés sur le poste. */
  lignesStock: number;
  /** Un montant, un budget, un bon de commande, un ordre ou une pièce demandée au secrétariat. */
  argentEngage: boolean;
}

/**
 * CHANGER LA NATURE D'UN POSTE VERS OU DEPUIS « MATÉRIEL DU STOCK » — seulement sur un brouillon
 * vierge. La nature d'un poste « décrit la dépense et se corrige à tout moment » ; celle-ci
 * non, parce qu'elle change ce que le poste EST. Un poste de dépense devenu poste de stock
 * garderait son montant, son BC ou sa pièce demandée sous une nature qui n'en a pas ; un poste de
 * stock devenu poste de dépense laisserait ses lignes — et le matériel réservé — accrochées à une
 * nature qui ne sait plus les rendre au magasin : sa décision suivante ne libérerait rien, et sa
 * suppression effacerait des lignes dont le matériel est dehors. Rend la phrase qui refuse, ou
 * `null` (aucun passage, ou passage permis).
 */
export function refusChangementNature(actuelle: string, voulue: string, faits: FaitsChangementNature): string | null {
  const depuis = actuelle === NATURE_MATERIEL_STOCK;
  const vers = voulue === NATURE_MATERIEL_STOCK;
  if (depuis === vers) return null;
  if (faits.statut !== "DRAFT") {
    return "La nature « Matériel du stock » se choisit sur un brouillon : une fois le poste soumis, elle ne change plus. "
      + "Ajoutez plutôt un nouveau poste de la nature voulue.";
  }
  if (depuis && faits.lignesStock > 0) {
    return "Ce poste liste des articles du stock : retirez-les d'abord (quantité 0), ou ajoutez plutôt un nouveau poste de dépense.";
  }
  if (vers && faits.argentEngage) {
    return "Ce poste porte déjà une dépense (montant, budget, bon de commande ou pièce demandée) : il ne devient pas un poste « Matériel du stock ». "
      + "Ajoutez plutôt un nouveau poste « Matériel du stock ».";
  }
  return null;
}

export interface LigneStockPourFait {
  statut: string;
  utilisee?: unknown;
  abimee?: unknown;
  perdue?: unknown;
}

/**
 * CE QU'UNE LIGNE DE MATÉRIEL A FAIT AU STOCK — et qui interdit donc d'effacer le poste ou la
 * demande qui la porte. Rend la phrase qui le NOMME, ou `null`.
 *
 *   · RÉSERVÉE : le matériel est sorti du magasin et personne n'a dit s'il revient — effacer la
 *     ligne le laisserait dehors pour toujours, sans que le registre sache pour qui il est sorti ;
 *   · CONFIRMÉE avec du remis, de l'abîmé ou du perdu : le stock a réellement diminué, et la ligne
 *     en est la cause — un fait qui a quitté l'ERP (§118.162).
 *
 * Une ligne confirmée dont tout est revenu, ou une réservation rendue (redevenue DEMANDÉE), ne
 * justifie plus rien : ses mouvements s'annulent, et la refuser serait un refus à tort (§118.27).
 * Lue par la suppression d'un poste ET par le lot de la corbeille : deux règles finiraient par
 * diverger, et une demande que la corbeille refuse se laisserait vider poste par poste (§118.71).
 */
export function faitDeStock(l: LigneStockPourFait): string | null {
  if (l.statut === "RESERVEE") {
    return "du matériel du stock est réservé pour cet événement et n'a pas été confirmé — confirmez d'abord ce qui a été remis (0 si rien) : le reste reviendra au magasin";
  }
  if (l.statut === "CONFIRMEE" && [l.utilisee, l.abimee, l.perdue].some((x) => Number(x ?? 0) > 0)) {
    return "du matériel du stock a été remis, abîmé ou perdu lors de cet événement — ces sorties du stock en dépendent";
  }
  return null;
}

export interface FaitsConfirmation {
  superAdmin: boolean;
  /** L'auteur de la demande : il a tenu l'événement. */
  estLeDemandeur: boolean;
  /** Qui tient le magasin : c'est chez elle que le reste revient. */
  gereLeMagasin: boolean;
  /** Qui décide des postes de cette opération (la Direction, ou la validation du module). */
  decideLesPostes: boolean;
}

/**
 * QUI CONFIRME LE MATÉRIEL APRÈS L'ÉVÉNEMENT. Confirmer n'attribue de stock à PERSONNE : ce qui a
 * été remis sort du registre, ce qui revient rentre au magasin — à l'inverse de la réception d'une
 * dotation, que seul son destinataire confirme parce qu'elle met le stock à SON nom (§118.15).
 * L'audit porte donc le nom de celui qui atteste, et quatre personnes savent ce qui s'est passé :
 * le demandeur, la gestionnaire du magasin, la Direction qui a accordé le poste, le Super Admin.
 */
export function peutConfirmerMateriel(f: FaitsConfirmation): boolean {
  return f.superAdmin || f.estLeDemandeur || f.gereLeMagasin || f.decideLesPostes;
}

export const REFUS_CONFIRMATION_MATERIEL =
  "La confirmation du matériel revient au demandeur, à la gestionnaire du magasin ou à la Direction qui décide des postes.";
