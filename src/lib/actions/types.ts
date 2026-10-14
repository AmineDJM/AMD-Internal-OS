import type { FactureDejaConnue } from "@/lib/factures/blocage-vue";

/** Shared result type returned by all server actions. */
export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  message?: string;
  /** Où aller après l'action quand l'objet n'existe plus (une demande retirée = supprimée). */
  redirect?: string;
  /**
   * LE DÉPÔT REFUSÉ PARCE QUE LA FACTURE EXISTE DÉJÀ (Direction, 14/10/2026) — la phrase, l'endroit (si la personne y a
   * accès) et le seul geste proposé : la relancer (`FactureDejaConnue`, `factures/blocage-vue.ts`). Sérialisable.
   */
  factureConnue?: FactureDejaConnue;
  /** Un dépôt ACCEPTÉ mais marqué « doublon possible » : l'avertissement à montrer. */
  avertissement?: string;
}

/** Helpers for parsing FormData values inside server actions. */
export function fdStr(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  const s = v ? String(v).trim() : "";
  return s.length ? s : null;
}

export function fdNum(formData: FormData, key: string): number | null {
  const s = fdStr(formData, key);
  if (s === null) return null;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

export function fdDate(formData: FormData, key: string): Date | null {
  const s = fdStr(formData, key);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fdBool(formData: FormData, key: string): boolean {
  const v = formData.get(key);
  return v === "on" || v === "true" || v === "1";
}

/**
 * UNE CASE À COCHER QUI PEUT DIRE « NON » — vrai, faux, ou « le formulaire n'en dit rien »
 * (§118.172).
 *
 * Une case DÉCOCHÉE n'envoie rien. Pour qu'elle dise « non », l'écran pose un témoin caché AVANT
 * elle (`<input type="hidden" name="isActive" value="off">`) : cochée, le formulaire porte alors
 * DEUX valeurs, « off » puis « on » — et `formData.get` rend la PREMIÈRE. Deux écrans lisaient
 * ainsi « off » à chaque enregistrement : enregistrer un établissement ou un message pré-défini
 * actif le DÉSACTIVAIT, et le réactiver était impossible. D'autres n'avaient pas de témoin et
 * lisaient « absent = inchangé » : décocher ne faisait rien.
 *
 * On lit donc TOUTES les valeurs : un « oui » parmi elles l'emporte (la case cochée), sinon un
 * « non » (le témoin seul), sinon `undefined` — l'appelant laisse alors le champ tel quel. Les
 * trois façons d'écrire oui (« on », « true », « 1 ») et non (« off », « false », « 0 ») sont
 * celles que les écrans du dépôt emploient déjà.
 */
export function fdCase(formData: FormData, key: string): boolean | undefined {
  const valeurs = formData.getAll(key).map((v) => String(v).trim().toLowerCase());
  if (valeurs.some((v) => v === "on" || v === "true" || v === "1")) return true;
  if (valeurs.some((v) => v === "off" || v === "false" || v === "0")) return false;
  return undefined;
}
