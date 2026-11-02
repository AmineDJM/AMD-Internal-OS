import type { AdProItemKind } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN SPONSORING INDIRECT SE RÉPARTIT PAR NATURE (§118.175).
 *
 * « Si c'est un sponsoring indirect, on doit donner la nature ou les natures de ce sponsoring :
 * un sponsoring indirect de 1 000 000 DZD réparti en 400 000 d'imprimerie et 600 000
 * d'hôtellerie » (Direction, 01/10).
 *
 * ── POURQUOI UN POSTE PAR NATURE, ET NON DES LIGNES DANS UN POSTE ───────────────────────────
 *
 * L'imprimerie et l'hôtel sont deux fournisseurs : deux devis, deux bons de commande, deux
 * factures, deux paiements. Un poste porte UNE chaîne (devis → BC → facture → paiement) et UN
 * fournisseur : des lignes dans un seul poste n'auraient pu payer qu'un seul des deux. Et une
 * billetterie a ses voyageurs, que seule une ligne de nature « billetterie » peut porter. Chaque
 * nature devient donc un poste à part entière — qui se valide, se commande et se paie comme les
 * autres — et `repartitionId` les relie : l'écran les montre ensemble, sous leur total.
 *
 * Module PUR : la lecture des lignes envoyées par le formulaire, et rien d'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES NATURES D'UNE PRISE EN CHARGE — ce qu'un sponsoring indirect paie.
 *
 * Fermée et écrite à la main, avec sa raison pour chaque exclusion : le sponsoring DIRECT et
 * l'INDIRECT ne sont pas des natures d'un sponsoring indirect (il ne se contient pas lui-même) ;
 * le MATÉRIEL DU STOCK n'est pas de l'argent (§118.167) ; le MATÉRIEL PROMOTIONNEL suit son propre
 * circuit (visa, conformité, BAT) — l'IMPRIMERIE, elle, est l'impression payée à un imprimeur.
 */
export const NATURES_REPARTITION = [
  "PRINTING", "ACCOMMODATION", "TICKETING", "TRAVEL", "CATERING", "DINNER", "VENUE",
  "STAND", "SYMPOSIUM", "SERVICE", "CONSULTING", "OTHER",
] as const satisfies readonly AdProItemKind[];

export type NatureRepartition = (typeof NATURES_REPARTITION)[number];

export interface LigneRepartition {
  kind: NatureRepartition;
  montant: number;
  /** « Hôtel Ibis Sétif — 3 nuits » : ce qui distingue deux lignes de même nature. */
  precision: string | null;
  /** Le fournisseur, s'il est déjà connu. */
  payeA: string | null;
}

/** Une limite OPÉRATIONNELLE (§118.2) : un sponsoring ne se répartit pas en cent natures. */
export const LIGNES_MAX = 30;

const estNature = (k: unknown): k is NatureRepartition =>
  typeof k === "string" && (NATURES_REPARTITION as readonly string[]).includes(k);

const texte = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t.slice(0, 200) : null;
};

/**
 * LIRE LA RÉPARTITION envoyée par le formulaire (un JSON). Tout ce qui ne va pas se dit EN UNE
 * FOIS, ligne par ligne (§118.18). Une ligne entièrement vide est écartée, pas refusée : c'est la
 * ligne qu'on a ouverte sans la remplir.
 */
export function lireRepartition(brut: string | null | undefined):
  | { ok: true; lignes: LigneRepartition[]; total: number }
  | { ok: false; error: string } {
  let donnees: unknown;
  try {
    donnees = JSON.parse(brut ?? "[]");
  } catch {
    return { ok: false, error: "La répartition envoyée est illisible." };
  }
  if (!Array.isArray(donnees)) return { ok: false, error: "La répartition envoyée est illisible." };

  const lignes: LigneRepartition[] = [];
  const fautes: string[] = [];
  donnees.forEach((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>;
    const montantBrut = o.montant;
    const vide = !o.kind && (montantBrut === "" || montantBrut == null) && !texte(o.precision) && !texte(o.payeA);
    if (vide) return;
    const n = i + 1;
    if (!estNature(o.kind)) fautes.push(`ligne ${n} : choisissez la nature (imprimerie, hôtellerie…)`);
    const montant = typeof montantBrut === "number" ? montantBrut : Number(String(montantBrut ?? "").replace(/\s/g, "").replace(",", "."));
    if (montantBrut === "" || montantBrut == null || !Number.isFinite(montant)) fautes.push(`ligne ${n} : le montant est manquant ou illisible`);
    else if (montant <= 0) fautes.push(`ligne ${n} : le montant doit être positif`);
    if (estNature(o.kind) && Number.isFinite(montant) && montant > 0) {
      lignes.push({ kind: o.kind, montant: Math.round(montant * 100) / 100, precision: texte(o.precision), payeA: texte(o.payeA) });
    }
  });
  if (fautes.length) return { ok: false, error: `Répartition incomplète — ${fautes.join(" ; ")}.` };
  if (lignes.length === 0) return { ok: false, error: "Donnez au moins une nature et son montant (par exemple : imprimerie 400 000 DZD)." };
  if (lignes.length > LIGNES_MAX) return { ok: false, error: `Au plus ${LIGNES_MAX} natures par sponsoring indirect.` };
  const total = Math.round(lignes.reduce((s, l) => s + l.montant, 0) * 100) / 100;
  return { ok: true, lignes, total };
}

/**
 * LE LIBELLÉ D'UN POSTE NÉ D'UNE RÉPARTITION — la nature, puis ce qui la précise (« Imprimerie —
 * Affiches et programmes »). La nature est passée DÉJÀ lue (`ITEM_KIND_LABELS`), pour que ce
 * module reste sans import de valeur.
 */
export function libelleLigne(libelleNature: string, precision: string | null): string {
  return precision ? `${libelleNature} — ${precision}` : libelleNature;
}
