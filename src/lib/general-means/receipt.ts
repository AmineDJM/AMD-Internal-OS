import { arrondirAuCentime } from "@/lib/utils";
/**
 * LE TICKET DE CAISSE ET SES ARTICLES.
 *
 * On n'achète presque jamais une seule chose. Une dépense réduite à « courses — 12 400 DZD »
 * dit ce qui est sorti de la caisse et rien de ce qui a été acheté : ni ce qu'on consomme le
 * plus, ni à quel prix, ni si le total correspond à ce qu'on a réellement mis dans le panier.
 *
 * Un ticket porte donc des LIGNES : un article (repris du catalogue, ou saisi librement pour un
 * achat unique), une quantité, un montant. Le total de la dépense est **calculé** à partir des
 * lignes — il n'est jamais saisi à côté. Deux nombres censés dire la même chose finissent
 * toujours par diverger, et c'est alors le budget qui devient faux.
 *
 * Module PUR — testé. Aucun accès base, aucune dépendance lourde : il est appelé par les actions
 * serveur ET par le formulaire côté navigateur, qui affiche le même total avant d'envoyer.
 */

export interface ReceiptLineInput {
  /** Article du catalogue, ou null pour un achat hors catalogue. */
  articleId?: string | null;
  label?: string | null;
  quantity?: unknown;
  amount?: unknown;
  /** Case budgétaire de CET article (le même ticket mélange souvent plusieurs budgets). */
  budgetCategoryId?: string | null;
}

export interface ReceiptLine {
  articleId: string | null;
  label: string;
  quantity: number;
  amount: number;
  budgetCategoryId: string | null;
}

/** Un ticket ne se compte pas au centime près sur 20 articles : deux décimales suffisent. */

/**
 * Lit un nombre saisi à la main : virgule décimale française, espaces de milliers, champ vide.
 * Rend `null` sur ce qui n'est pas un nombre — jamais NaN, qui contaminerait le total en
 * silence jusqu'à afficher « NaN DZD » dans un budget.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? "").replace(/\s/g, "").replace(/ /g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Quantité par défaut : 1. « Un paquet de ramettes » sans quantité reste un achat valable. */
export function parseQuantity(raw: unknown): number {
  const n = parseAmount(raw);
  return n != null && n > 0 ? n : 1;
}

/**
 * Nettoie les lignes saisies. Une ligne sans désignation NI article est du bruit de formulaire
 * (une ligne ajoutée puis abandonnée) : on la laisse tomber sans rien dire. Une ligne nommée
 * est retenue même à zéro dinar — un article offert ou repris figure sur le ticket.
 */
export function normalizeLines(raw: ReceiptLineInput[]): ReceiptLine[] {
  return raw
    .map((l) => ({
      articleId: l.articleId ? String(l.articleId) : null,
      label: String(l.label ?? "").trim(),
      quantity: parseQuantity(l.quantity),
      amount: arrondirAuCentime(Math.max(0, parseAmount(l.amount) ?? 0)),
      budgetCategoryId: l.budgetCategoryId ? String(l.budgetCategoryId) : null,
    }))
    .filter((l) => l.label.length > 0 || l.articleId !== null);
}

/** Le total du ticket = la somme de ses lignes. Il n'y a pas d'autre source. */
export function receiptTotal(lines: ReceiptLine[]): number {
  return arrondirAuCentime(lines.reduce((a, l) => a + l.amount, 0));
}

/**
 * Le ticket est-il enregistrable ?
 *
 * Deux refus seulement, et ils disent quoi faire : aucune ligne retenue, ou un total à zéro. Le
 * second mérite d'être bloqué — une dépense de 0 DZD consommerait une pièce justificative sans
 * rien imputer au budget, ce qui donne une trace mais fausse la lecture.
 *
 * Chaque ligne doit être NOMMÉE : un article du catalogue apporte son nom, un achat unique
 * exige qu'on l'écrive. « Ligne 3 : 2 300 DZD » ne renseigne personne dans six mois.
 */
export function validateReceipt(lines: ReceiptLine[]): { ok: boolean; error?: string } {
  if (lines.length === 0) {
    return { ok: false, error: "Ajoutez au moins un article : c'est le détail du ticket qui fait la dépense." };
  }
  const unnamed = lines.findIndex((l) => !l.label);
  if (unnamed >= 0) {
    return { ok: false, error: `Ligne ${unnamed + 1} : choisissez un article du catalogue ou écrivez ce qui a été acheté.` };
  }
  if (receiptTotal(lines) <= 0) {
    return { ok: false, error: "Le total du ticket est nul : indiquez le montant de chaque article." };
  }
  return { ok: true };
}

/**
 * Le libellé de la dépense, résumé depuis ses lignes quand l'utilisateur n'en donne pas.
 *
 * Une dépense apparaît dans les listes budgétaires par une seule phrase : autant qu'elle dise
 * ce qu'il y avait sur le ticket. Au-delà de trois articles on abrège — un libellé de trois
 * lignes dans un tableau ne se lit plus.
 */
export function receiptLabel(lines: ReceiptLine[], given?: string | null): string {
  const explicit = (given ?? "").trim();
  if (explicit) return explicit;
  if (lines.length === 0) return "Dépense";
  const head = lines.slice(0, 3).map((l) => l.label).join(", ");
  return lines.length > 3 ? `${head} +${lines.length - 3} autre${lines.length - 3 > 1 ? "s" : ""}` : head;
}

/**
 * Décode les lignes envoyées par le formulaire (un seul champ JSON plutôt que N champs
 * numérotés, qui se désynchronisent dès qu'on supprime une ligne du milieu).
 *
 * Une saisie illisible rend un tableau VIDE et non une erreur : la validation qui suit dira
 * « ajoutez au moins un article », message autrement plus utile qu'un défaut de format.
 */
export function parseLinesField(raw: unknown): ReceiptLine[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeLines(parsed as ReceiptLineInput[]);
  } catch {
    return [];
  }
}
