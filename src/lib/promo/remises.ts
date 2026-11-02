/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL REMIS EN VISITE (§118.166) — la règle, sans base.
 *
 * « Un bloc "Matériel remis" dans le rapport terrain, déduit du stock du délégué. » Et la décision
 * de la Direction : au-delà du stock enregistré, la visite est BLOQUÉE — on ne remet pas ce qu'on
 * n'a pas en main, et un solde négatif ne se « régularise » pas plus tard.
 *
 * ── QUATRE RÈGLES ──────────────────────────────────────────────────────────────────────────
 *
 * 1. CE QUI EST REMIS SORT DU STOCK DE CELUI QUI A FAIT LA VISITE — le délégué de la visite, même
 *    quand un superviseur rapporte à sa place : c'est sa voiture qui se vide.
 * 2. TOUT OU RIEN. Le rapport, ses produits, ses messages et ses remises s'écrivent ensemble, ou
 *    pas du tout : une visite enregistrée dont la remise a été refusée laisserait le médecin noté
 *    « visité » sans ce qu'on lui a donné, et le stock du délégué faux dans l'autre sens.
 * 3. CORRIGER N'EST PAS RECOMPTER. Dans la fenêtre de 48 h, un rapport corrigé ne touche que les
 *    articles dont la quantité CHANGE : l'ancienne remise est contre-passée (son exact inverse),
 *    la nouvelle s'écrit. Rien ne se supprime, et un rapport renvoyé à l'identique n'écrit rien.
 * 4. UN SUPPORT NUMÉRIQUE SE PRÉSENTE, IL NE SE REMET PAS : il compte une utilisation, sans rien
 *    retirer d'un stock qui n'a pas de quantité.
 *
 * Module PUR — aucune base. Testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { MENU_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { arrondirAuMillieme } from "@/lib/utils";

const nombre = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

export interface RemiseSaisie {
  itemId: string;
  quantite: number;
}

/** « 4 800 », « 12,5 » → nombre ; vide → 0 (une rangée non utilisée) ; illisible → null. */
function lireQuantite(brut: unknown): number | null {
  const s = String(brut ?? "").replace(/\s/g, "").replace(",", ".");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * LIRE LES REMISES D'UN FORMULAIRE — deux colonnes appariées par leur rang (l'article, la
 * quantité). Une quantité vide ou nulle est une rangée non utilisée : elle est ignorée, pas
 * refusée. Une quantité illisible ou négative, un article en double, sont refusés et NOMMÉS — tout
 * ce qui ne va pas, en une fois (§118.18).
 */
export function lireRemises(items: readonly unknown[], quantites: readonly unknown[]):
  { ok: true; remises: RemiseSaisie[] } | { ok: false; error: string } {
  const fautes: string[] = [];
  const vus = new Set<string>();
  const remises: RemiseSaisie[] = [];
  items.forEach((brut, i) => {
    const itemId = String(brut ?? "").trim();
    if (!itemId) return;
    const q = lireQuantite(quantites[i]);
    if (q == null) { fautes.push(`la quantité de la ligne ${i + 1} est illisible`); return; }
    if (q < 0) { fautes.push(`la quantité de la ligne ${i + 1} est négative`); return; }
    if (q === 0) return;
    if (vus.has(itemId)) { fautes.push(`un article figure deux fois (ligne ${i + 1})`); return; }
    vus.add(itemId);
    remises.push({ itemId, quantite: arrondirAuMillieme(q) });
  });
  if (fautes.length) return { ok: false, error: `Matériel remis à revoir : ${fautes.join(" ; ")}.` };
  return { ok: true, remises };
}

/** Les supports numériques cochés « présenté », sans doublon. */
export function lireNumeriques(items: readonly unknown[]): string[] {
  return [...new Set(items.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

export interface MouvementDeVisite {
  id: string;
  itemId: string;
  kind: string;
  /** Variation signée : une remise est NÉGATIVE (elle sort du stock du délégué). */
  delta: number;
  /** Le mouvement que celui-ci annule (une contre-passation). */
  annuleId: string | null;
}

/**
 * CE QUI A ÉTÉ REMIS, NET, DANS UNE VISITE — par article. Une remise contre-passée ne compte plus :
 * c'est ce qui rend une correction juste, et un historique de médecin exact.
 */
export function remisNetParArticle(mouvements: readonly MouvementDeVisite[]): Map<string, number> {
  const annules = new Set(mouvements.filter((m) => m.annuleId).map((m) => m.annuleId as string));
  const net = new Map<string, number>();
  for (const m of mouvements) {
    if (m.kind !== "DISTRIBUTION" || annules.has(m.id)) continue;
    net.set(m.itemId, arrondirAuMillieme((net.get(m.itemId) ?? 0) - m.delta));
  }
  // Pas de filtre « net > 0 » ici : une remise est TOUJOURS négative (l'écrivain l'écrit ainsi),
  // donc chaque article retenu a un net positif. Le filtre qui vivait là ne pouvait pas se
  // déclencher — son sabotage est passé au vert — et une garde inexerçable n'est pas une garde.
  return net;
}

export type Geste = "AUCUN" | "REMETTRE" | "REPRENDRE" | "REMPLACER";

export interface GesteDeRemise {
  itemId: string;
  avant: number;
  apres: number;
  geste: Geste;
}

/**
 * CE QU'UNE (RE)SOUMISSION DOIT ÉCRIRE, article par article. Une quantité inchangée n'écrit rien
 * (rapport renvoyé à l'identique = registre intact) ; une quantité retirée se contre-passe ; une
 * quantité qui change se contre-passe puis se remet — jamais un « delta » écrit à côté, qui ferait
 * deux lignes pour une remise et rendrait l'historique du médecin illisible.
 */
export function gestesDeRemise(avant: ReadonlyMap<string, number>, apres: readonly RemiseSaisie[]): GesteDeRemise[] {
  const cible = new Map(apres.map((r) => [r.itemId, r.quantite]));
  const ids = [...new Set([...avant.keys(), ...cible.keys()])].sort();
  return ids.map((itemId) => {
    const a = avant.get(itemId) ?? 0;
    const b = cible.get(itemId) ?? 0;
    const geste: Geste = Math.abs(a - b) < 0.0005 ? "AUCUN" : a === 0 ? "REMETTRE" : b === 0 ? "REPRENDRE" : "REMPLACER";
    return { itemId, avant: a, apres: b, geste };
  });
}

/**
 * LE REFUS D'UNE REMISE QUI DÉPASSE LE STOCK — il dit l'article, la quantité demandée, ce qui est
 * réellement distribuable, et le geste qui débloque. « Bloquer » ne veut pas dire laisser deviner.
 */
export function refusRemise(libelle: string, quantite: number, raisonAllocation: string): string {
  return `${nombre(quantite)} « ${libelle} » remis, mais votre stock ne le permet pas : ${raisonAllocation.replace(/\.$/, "")}. `
    + `Rien n'est enregistré — ni la visite, ni la remise. Corrigez la quantité, ou demandez une dotation (${MENU_STOCK_PROMO}).`;
}

/** « 20 Fiche posologique — Nivolex, 5 Stylo » — ce que l'audit et l'écran disent d'une visite. */
export function resumeRemises(r: readonly { libelle: string; quantite: number }[]): string {
  return r.map((x) => `${nombre(x.quantite)} ${x.libelle}`).join(", ");
}
