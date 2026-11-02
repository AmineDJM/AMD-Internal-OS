/**
 * LA VUE DE LA LISTE LEGAL — l'état d'affichage, sorti du composant pour être MESURABLE.
 *
 * LE BOGUE QUE CE MODULE EXISTE POUR FERMER. Le tableau Legal portait son état de filtrage dans
 * `React.useState`, initialisé depuis une propriété du serveur :
 *
 *     const [watchOnly, setWatchOnly] = React.useState(watchByDefault);
 *
 * Un initialiseur `useState` ne s'exécute qu'au MONTAGE. Or la barre de dossiers navigue par
 * `<Link href="/legal?dossier=…">` : Next re-rend le segment côté client, le composant reste
 * MONTÉ, et l'état survit. Concrètement :
 *
 *   1. le PDG arrive par un rappel d'échéance — `/legal?echeances=1` — et le filtre
 *      « à surveiller » se pose, comme prévu ;
 *   2. il clique sur le dossier « Bons de commande » : le serveur renvoie bien les 6 documents,
 *      `watchByDefault` repasse à `false`… mais `watchOnly` reste `true` ;
 *   3. aucun de ces 6 bons de commande n'expire dans les trois mois : le tableau affiche
 *      « 0 / 6 documents » et « Aucun document ne correspond à ces filtres ».
 *
 * Les documents n'avaient pas disparu : ils étaient MASQUÉS par un filtre posé pour un autre
 * écran, et dont plus rien à l'image ne rappelait la présence — les filtres de colonnes, eux,
 * étaient vides. D'où l'apparence d'intermittence : la liste « revenait » après un rechargement
 * complet (qui remonte le composant) et « repartait » dès qu'on renavigait depuis une échéance.
 *
 * LA RÈGLE, désormais explicite : un filtre appartient à UNE liste. Quand la liste change de
 * PÉRIMÈTRE — autre dossier, autre entrée d'écran — les filtres de la précédente ne s'appliquent
 * plus. Ce module porte cette règle, et les tests la tiennent.
 */

import { entierementCreditee } from "@/lib/lecteurs/avoir";

export interface LegalListRow {
  id: string;
  reference: string | null;
  title: string;
  kind: string;
  counterparty: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
  expiry: string;
  daysLeft: number | null;
  amount: number | null;
  driveNodeId: string | null;
  driveName: string | null;
  renewedFromTitle: string | null;
  restricted: boolean;
  /**
   * LE RÈGLEMENT, pour les documents de nature FACTURE — voir `lib/legal/invoices.ts`.
   * `null` partout ailleurs : un bail n'est ni réglé ni à régler.
   */
  paidDate: string | null;
  expenseOrderId: string | null;
  /** Le total des avoirs ACTIFS d'une facture (§118.195) — absent : aucun avoir. */
  avoirs?: number;
  /** UN DEVIS D'AD & PRO NON RETENU (Direction, 11/2026) : la phrase à afficher — absent : retenu, ou pas un devis de poste. */
  nonRetenu?: string | null;
}

/** Les niveaux d'échéance qui méritent qu'on s'en occupe — le filtre « à surveiller ». */
export const URGENT_EXPIRY = new Set(["SOON", "IMMINENT", "OVERDUE"]);

export interface LegalColumnFilters {
  title: string;
  kind: string;
  counterparty: string;
  status: string;
  reference: string;
  startMonth: string;
  endMonth: string;
}

export const EMPTY_FILTERS: LegalColumnFilters = {
  title: "", kind: "", counterparty: "", status: "", reference: "", startMonth: "", endMonth: "",
};

export interface LegalListState {
  /**
   * Le PÉRIMÈTRE auquel ces filtres s'appliquent. C'est la clé de tout : tant qu'il ne change
   * pas, l'état du PDG lui appartient (un `router.refresh()` après un renouvellement ne doit
   * rien effacer). Dès qu'il change, les filtres de l'écran précédent tombent.
   */
  scope: string;
  filters: LegalColumnFilters;
  watchOnly: boolean;
  /**
   * LE RESTE À RÉGLER — l'unique bouton que l'écran dédié aux factures apportait vraiment.
   * Il ne garde que les factures non réglées : c'est la question qu'on vient poser, et y
   * répondre en trois filtres de colonnes revient à ne pas y répondre.
   */
  unpaidOnly: boolean;
}

/**
 * Le périmètre d'une liste, sous forme de chaîne comparable.
 *
 * Le dossier ouvert ET l'entrée par un rappel d'échéance en font partie : ce sont les deux
 * choses qui changent l'ensemble des documents servis par le serveur.
 */
export function legalListScope(opts: {
  folderId: string | null;
  unfiledOnly?: boolean;
  fromExpiryAlert?: boolean;
  /** La NATURE demandée par l'URL (`?nature=INVOICE`) — « les factures » est une vue, pas un écran. */
  kind?: string | null;
}): string {
  const dossier = opts.unfiledOnly ? "none" : (opts.folderId ?? "all");
  return `${dossier}|${opts.fromExpiryAlert ? "echeances" : "tous"}|${opts.kind || "toutes"}`;
}

/** L'état initial d'une liste : ses filtres sont ceux que le périmètre impose, et rien d'autre. */
export function initialLegalListState(scope: string, watchByDefault: boolean, kind = ""): LegalListState {
  return { scope, filters: { ...EMPTY_FILTERS, kind }, watchOnly: watchByDefault, unpaidOnly: false };
}

/**
 * SYNCHRONISE l'état sur le périmètre servi par le serveur.
 *
 * Rend le MÊME objet quand rien n'a changé — l'appelant peut donc comparer par référence et
 * n'ordonner un re-rendu que lorsque c'est nécessaire. C'est le motif recommandé par React pour
 * « ajuster un état quand une propriété change », transcrit ici en fonction pure.
 */
export function syncLegalListState(
  state: LegalListState,
  scope: string,
  watchByDefault: boolean,
  kind = "",
): LegalListState {
  if (state.scope === scope) return state;
  return initialLegalListState(scope, watchByDefault, kind);
}

function contains(hay: string | null, needle: string): boolean {
  return (hay ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** Début et échéance se filtrent AU MOIS : « le bail qui expire en décembre » est la vraie question. */
function inMonth(iso: string | null, month: string): boolean {
  return Boolean(iso && iso.startsWith(month));
}

/** Les documents effectivement AFFICHÉS, une fois l'état appliqué aux lignes du serveur. */
export function visibleLegalRows(rows: readonly LegalListRow[], state: LegalListState): LegalListRow[] {
  const f = state.filters;
  return rows.filter((r) => {
    if (f.title && !contains(r.title, f.title)) return false;
    if (f.reference && !contains(r.reference, f.reference)) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.counterparty && !contains(r.counterparty, f.counterparty)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.startMonth && !inMonth(r.startDate, f.startMonth)) return false;
    if (f.endMonth && !inMonth(r.endDate, f.endMonth)) return false;
    if (state.watchOnly && !URGENT_EXPIRY.has(r.expiry)) return false;
    // LE RESTE À RÉGLER : les seules factures non réglées. Une facture ANNULÉE ne sera jamais
    // payée — la montrer ici gonflerait une dette qui n'existe pas.
    // « À régler » : ni réglée, ni annulée, ni entièrement créditée par ses avoirs — la lecture du compte d'en-tête.
    if (state.unpaidOnly && !(r.kind === "INVOICE" && !r.paidDate && r.status !== "CANCELLED" && !entierementCreditee(r.amount, r.avoirs ?? 0))) return false;
    return true;
  });
}

/** Y a-t-il un filtre actif ? Sert à proposer « Réinitialiser » — et à l'expliquer. */
export function hasActiveFilter(state: LegalListState): boolean {
  return state.watchOnly || state.unpaidOnly || Object.values(state.filters).some(Boolean);
}

/**
 * CE QUI MASQUE, NOMMÉ.
 *
 * « Aucun document ne correspond à ces filtres » devant des colonnes visuellement vides est un
 * message qui accuse les données. Nommer le filtre actif rend la cause lisible en une seconde —
 * et c'est ce qui distingue « il y a un filtre » de « mes documents ont disparu ».
 */
export function describeActiveFilters(state: LegalListState): string[] {
  const out: string[] = [];
  if (state.watchOnly) out.push("à surveiller (échéance proche ou dépassée)");
  if (state.unpaidOnly) out.push("factures restant à régler");
  const f = state.filters;
  if (f.reference) out.push(`référence « ${f.reference} »`);
  if (f.title) out.push(`titre « ${f.title} »`);
  if (f.kind) out.push("nature");
  if (f.counterparty) out.push(`partie « ${f.counterparty} »`);
  if (f.status) out.push("état");
  if (f.startMonth) out.push(`début ${f.startMonth}`);
  if (f.endMonth) out.push(`échéance ${f.endMonth}`);
  return out;
}
