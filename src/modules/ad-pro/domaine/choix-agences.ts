import { totauxValides, type EnteteDevisPoste, type LigneDevisPoste } from "./devis-poste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHOIX DES AGENCES, LIGNE À LIGNE (Direction, 23/11/2026, après la recette du parcours agence).
 *
 * « La Direction Marketing coche, dans CHAQUE devis transmis, les lignes qu'elle commande : un BC par agence, rien que
 * les lignes cochées. » Un devis sans ligne cochée n'a pas de BC — son agence n'est pas retenue.
 *
 *   • UNE agence retenue : le poste reste UN poste, accordé au total des seules lignes cochées ;
 *   • PLUSIEURS agences : le poste est SCINDÉ, un poste par agence — chacune est payée à part, donc chacune a sa chaîne
 *     (BC, signatures, réception, facture, ordre de dépense). Le poste d'origine garde l'agence au plus gros total ; les
 *     autres naissent « <libellé d'origine> — <agence> ».
 *
 * Ce module est PUR : l'écran (totaux en direct, phrase de confirmation) et l'action (lecture du formulaire, plan) lisent
 * la MÊME règle, et le montant est celui de `totauxValides` — l'arithmétique du BC (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une ligne telle que le choix la lit — la vue de la carte (`LigneDevisVue`) convient telle quelle. */
interface LigneChoisissable {
  id: string;
  position: number;
  reference: string;
  unit: string | null;
  quantity: number | null;
  unitPrice: number | null;
  lue: number | null;
  aVerifier: string | null;
  /** Validée pour un AUTRE poste : le libellé de ce poste — elle ne se commande qu'une fois. */
  valideeAilleurs: string | null;
  /** Incomplète : ce qui manque ; `null` : elle peut être retenue. */
  refusValidation: string | null;
}

/** Un devis transmis, tel que le choix le lit. */
interface DevisChoisissable {
  pieceId: string;
  /** Le nom de l'agence (fournisseur du devis, à défaut sa référence ou son titre). */
  agence: string;
  entete: EnteteDevisPoste;
  lignes: readonly LigneChoisissable[];
}

/** Une agence retenue : son devis, ses lignes cochées, et ce qu'elles valent. */
interface AgenceRetenue {
  pieceId: string;
  agence: string;
  ligneIds: string[];
  /** Le montant accordé : TTC quand la TVA est imprimée, HT sinon (jamais devinée) — comme le choix d'un devis entier. */
  montant: number;
  ttc: boolean;
}

/** L'agence d'un devis telle que le choix la nomme : son fournisseur, à défaut sa référence ou son titre. */
export const nomAgence = (d: { fournisseur: string | null; fournisseurLu: { nom: string | null } | null; reference: string | null; titre: string }): string =>
  d.fournisseur?.trim() || d.fournisseurLu?.nom?.trim() || d.reference?.trim() || d.titre;

/** Le séparateur du champ `ligne` : « <pieceId>:<ligneId> ». */
const SEP = ":";

/** La valeur d'une case cochée — ce que l'écran envoie, ce que l'action relit. */
export const valeurDeLigne = (pieceId: string, ligneId: string): string => `${pieceId}${SEP}${ligneId}`;

/**
 * LIRE LES CASES COCHÉES — les valeurs répétées du champ `ligne`, regroupées par devis, sans doublon, dans l'ordre reçu.
 * Une valeur mal formée est refusée (un formulaire forgé ne passe pas pour une sélection vide).
 */
export function lireLignesCochees(valeurs: readonly unknown[]): { ok: true; parDevis: Map<string, string[]> } | { ok: false; error: string } {
  const parDevis = new Map<string, string[]>();
  for (const brut of valeurs) {
    const v = String(brut ?? "").trim();
    if (!v) continue;
    const i = v.indexOf(SEP);
    const pieceId = i > 0 ? v.slice(0, i).trim() : "";
    const ligneId = i > 0 ? v.slice(i + 1).trim() : "";
    if (!pieceId || !ligneId) return { ok: false, error: "Une ligne cochée est illisible : rechargez la fiche et cochez à nouveau." };
    const deja = parDevis.get(pieceId) ?? [];
    if (!deja.includes(ligneId)) deja.push(ligneId);
    parDevis.set(pieceId, deja);
  }
  return { ok: true, parDevis };
}

/** Le marqueur qui fait lire « validée » aux lignes cochées — `totauxValides` compte ce qui est validé pour UN poste. */
const COCHEE = "__cochee__";

/** CE QUE VALENT LES LIGNES COCHÉES D'UN DEVIS — la même arithmétique que le BC (lignes complètes seulement). */
export function totalDesLignes(d: Pick<DevisChoisissable, "entete" | "lignes">, cochees: ReadonlySet<string>): { montant: number; ttc: boolean; nombre: number } {
  const lignes: LigneDevisPoste[] = d.lignes.map((l) => ({
    id: l.id, position: l.position, reference: l.reference, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice,
    lue: l.lue, aVerifier: l.aVerifier, validatedItemId: cochees.has(l.id) ? COCHEE : null, bcId: null,
  }));
  const t = totauxValides(d.entete, lignes, COCHEE);
  const ttc = d.entete.tvaRate !== null;
  return { montant: Math.round((ttc ? t.ttc : t.ht) * 100) / 100, ttc, nombre: t.lignes };
}

/**
 * LE PLAN DU CHOIX — chaque devis coché devient une agence retenue, dans l'ordre où les postes se décident : la première
 * (le plus gros total ; à égalité, l'ordre des devis) reste sur le poste d'origine. Refusé, avec la phrase à dire, quand
 * rien n'est coché, qu'une ligne n'appartient pas au devis, qu'elle est déjà commandée ailleurs ou incomplète, ou que les
 * lignes d'une agence ne valent rien.
 */
export function planDuChoix(
  devis: readonly DevisChoisissable[], parDevis: ReadonlyMap<string, readonly string[]>,
): { ok: true; retenues: AgenceRetenue[]; ecartes: string[] } | { ok: false; error: string } {
  const coches = [...parDevis.entries()].filter(([, ids]) => ids.length > 0);
  if (coches.length === 0) return { ok: false, error: "Cochez au moins une ligne d'un devis : seules les lignes cochées sont commandées, un bon de commande par agence." };
  const rang = new Map(devis.map((d, i) => [d.pieceId, i]));
  const retenues: AgenceRetenue[] = [];
  for (const [pieceId, ids] of coches) {
    const d = devis.find((x) => x.pieceId === pieceId);
    if (!d) return { ok: false, error: "Un des devis cochés n'est plus transmis sur ce poste : rechargez la fiche." };
    const parId = new Map(d.lignes.map((l) => [l.id, l]));
    for (const id of ids) {
      const l = parId.get(id);
      if (!l) return { ok: false, error: `Une des lignes cochées n'appartient pas au devis de ${d.agence} : rechargez la fiche.` };
      if (l.valideeAilleurs) return { ok: false, error: `« ${l.reference.slice(0, 60)} » (${d.agence}) est déjà commandée pour le poste « ${l.valideeAilleurs} » : une ligne ne se commande qu'une fois.` };
      if (l.refusValidation) return { ok: false, error: `${d.agence} — ${l.refusValidation}` };
    }
    const t = totalDesLignes(d, new Set(ids));
    if (!(t.montant > 0)) return { ok: false, error: `Les lignes cochées du devis de ${d.agence} ne valent rien : cochez des lignes chiffrées, ou décochez ce devis.` };
    retenues.push({ pieceId, agence: d.agence, ligneIds: [...ids], montant: t.montant, ttc: t.ttc });
  }
  retenues.sort((a, b) => b.montant - a.montant || (rang.get(a.pieceId) ?? 0) - (rang.get(b.pieceId) ?? 0));
  const gardes = new Set(retenues.map((r) => r.pieceId));
  return { ok: true, retenues, ecartes: devis.filter((d) => !gardes.has(d.pieceId)).map((d) => d.pieceId) };
}

/** Le libellé d'un poste né de la scission : « Stand — Agence Atlas ». */
export const libellePosteScinde = (libelle: string, agence: string): string => `${libelle.trim()} — ${agence.trim()}`;

/** LA PHRASE DE CONFIRMATION — ce qui va se passer, dit avant le clic. */
export function phraseDuChoix(retenues: readonly { agence: string; nombre: number }[]): string {
  const n = retenues.length;
  if (n === 0) return "Cochez les lignes à commander dans un ou plusieurs devis : un bon de commande par agence, rien que les lignes cochées.";
  if (n === 1) {
    const r = retenues[0]!;
    return `1 agence retenue (${r.agence}) : le poste est accordé au total de ses ${r.nombre} ligne${r.nombre > 1 ? "s" : ""} cochée${r.nombre > 1 ? "s" : ""}, un BC naît chez l'assistante. Les autres devis sont « non retenus ».`;
  }
  return `${n} agences retenues : le poste sera scindé en ${n} postes, un BC par agence (${retenues.map((r) => r.agence).join(", ")}). Les devis sans ligne cochée sont « non retenus ».`;
}
