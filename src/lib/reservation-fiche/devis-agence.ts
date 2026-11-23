/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DEVIS DE L'AGENCE JOINT AUX FICHES D'UN POSTE AD & PRO — sa note, écrite puis relue (module PUR, zéro import).
 *
 * L'assistante joint le devis de l'agence sur une fiche (`joindreDevisAgence`) et SAISIT l'agence et le montant. Le
 * devis part au demandeur par une DEMANDE DE PIÈCE du poste, qui n'a pas de colonne pour eux : ils voyagent dans sa
 * NOTE (« Devis de l'agence pour … Agence : … Montant : … »). Ce module écrit cette note et la RELIT — une seule forme,
 * éprouvée dans les deux sens — pour qu'à l'acceptation la pièce Legal qui naît porte le montant et l'agence que
 * l'assistante a saisis (recette du 23/11/2026 : la case « Devis » du poste disait « montant non saisi »).
 *
 * Le montant relu est TOUJOURS en dinars : un montant dit en dollars porte sa conversion (« 5 000 USD (= 1 200 000
 * DZD) »), faite une fois au taux figé par l'action — on relit le chiffre en DZD, on ne reconvertit jamais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DeviseDevisAgence = "DZD" | "USD";

/** Ce que l'assistante a saisi avec le devis — relu de la note. `null` : non saisi (jamais deviné). */
export interface DevisAgenceSaisi {
  fournisseur: string | null;
  montantDzd: number | null;
}

/** Un montant tel qu'on le lit — « 1 200 000 DZD » (la forme de `montantLisible`). */
function lisible(montant: number, devise: DeviseDevisAgence): string {
  return `${montant.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${devise}`;
}

/** Le montant tel que la note et le fil le disent : en DZD, ou en USD suivi de sa conversion en DZD. */
export function montantDitDevisAgence(montant: number, devise: DeviseDevisAgence, montantDzd: number): string {
  return devise === "USD" ? `${lisible(montant, "USD")} (= ${lisible(montantDzd, "DZD")})` : lisible(montant, "DZD");
}

const AGENCE = ". Agence : ";
const MONTANT = ". Montant : ";

/**
 * LA NOTE DE LA DEMANDE DE PIÈCE — `pour` : ce que le devis couvre (« billet · Amel Haddad, billet · Karim Benali »).
 * Forme fixe : « Devis de l'agence pour <pour>. Agence : <agence>. Montant : <montant>. » (agence et montant facultatifs).
 */
export function noteDevisAgence(i: { pour: string; fournisseur: string | null; montantDit: string | null }): string {
  const fournisseur = (i.fournisseur ?? "").trim();
  return [
    `Devis de l'agence pour ${i.pour.trim()}`,
    fournisseur ? `Agence : ${fournisseur}` : null,
    i.montantDit ? `Montant : ${i.montantDit}` : null,
  ].filter(Boolean).join(". ") + ".";
}

/** Un chiffre français (« 1 200 000,5 », espaces fines comprises) — `null` s'il n'en est pas un, ou s'il n'est pas positif. */
function lireChiffre(brut: string): number | null {
  const n = Number(brut.replace(/[\s  ]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * RELIRE LA NOTE écrite par `noteDevisAgence` — l'agence et le montant en DZD (le DERNIER chiffre suivi de « DZD » dans
 * le segment « Montant », celui de la conversion quand le devis est en dollars). Une note d'une autre forme rend des `null`.
 */
export function lireNoteDevisAgence(note: string | null | undefined): DevisAgenceSaisi {
  const t = (note ?? "").trim();
  if (!t.startsWith("Devis de l'agence pour ")) return { fournisseur: null, montantDzd: null };
  const iMontant = t.lastIndexOf(MONTANT);
  const iAgence = t.indexOf(AGENCE);
  let montantDzd: number | null = null;
  if (iMontant >= 0) {
    const segment = t.slice(iMontant + MONTANT.length);
    const chiffres = [...segment.matchAll(/(\d[\d\s  ]*(?:,\d+)?)\s*DZD/g)];
    const dernier = chiffres[chiffres.length - 1];
    montantDzd = dernier ? lireChiffre(dernier[1]!) : null;
  }
  let fournisseur: string | null = null;
  if (iAgence >= 0 && (iMontant < 0 || iAgence < iMontant)) {
    const fin = iMontant > iAgence ? iMontant : t.endsWith(".") ? t.length - 1 : t.length;
    fournisseur = t.slice(iAgence + AGENCE.length, fin).trim().slice(0, 200) || null;
  }
  return { fournisseur, montantDzd };
}
