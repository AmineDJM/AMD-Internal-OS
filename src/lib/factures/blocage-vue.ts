import { PHRASE_ETAT_PAIEMENT, QUI_A_LA_MAIN, relancable, type EtatPaiement } from "@/lib/finance/relance-paiement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA PERSONNE ARRÊTÉE LIT — la facture existe déjà (Direction, 14/10/2026).
 *
 * « Si la facture existe, on la bloque, on dit qu'elle existe déjà et qu'elle est en cours de traitement, et on propose
 * UNIQUEMENT de la relancer — en un clic, plus un commentaire facultatif. »
 *
 * La phrase est construite par le CODE, jamais par Luna. Elle dit ce que la personne a sous les yeux (le numéro, le
 * fournisseur et le montant de SA pièce), où en est le paiement, et l'endroit — mais l'endroit seulement si elle y a
 * accès (`canAccessEntity`) : sans accès, ni titre ni montant du dossier, seulement « dans un dossier <module> ». Un
 * blocage n'ouvre pas une fenêtre sur les dossiers des autres.
 *
 * Module PUR et sérialisable : il voyage dans la réponse de l'action jusqu'au composant client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La cible d'une relance : l'ordre de dépense quand il existe, la demande de paiement sinon. */
export interface CibleRelance {
  type: "PAYMENT_REQUEST" | "EXPENSE_ORDER";
  id: string;
}

export interface FactureDejaConnue {
  niveau: "CERTAIN";
  /** La phrase complète, prête à afficher. */
  phrase: string;
  etat: EtatPaiement;
  /** Le module où elle vit — toujours dit. */
  module: string;
  /** Le lien vers le dossier — seulement si la personne y a accès. */
  lien: string | null;
  /** Le geste unique : relancer, quand quelqu'un attend. `null` sinon. */
  relance: { cible: CibleRelance; jeton: string } | null;
}

/** Ce que la personne a déposé — lu sur SA pièce, donc dicible. */
export interface PieceDeposee {
  numero: string | null;
  fournisseur: string | null;
  ttc: number | null;
}

/** Ce qu'on sait de l'autre côté — titre et montant du dossier seulement si la personne y a accès. */
export interface DossierConnu {
  module: string;
  acces: boolean;
  /** « PAY-2026-012 — Hôtel du congrès » — montré seulement avec l'accès. */
  titre: string | null;
  montant: number | null;
  lien: string | null;
  etat: EtatPaiement;
  quiALaMain?: string | null;
  chefDeDepartement?: string | null;
}

const dzd = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;

/** « (n° FA-12, SARL Hôtel El Djazair, 119 000 DZD) » — ce qui est lisible, rien d'inventé. */
export function descriptionDeLaPiece(p: PieceDeposee): string {
  const morceaux = [p.numero ? `n° ${p.numero}` : null, p.fournisseur, p.ttc != null ? dzd(p.ttc) : null].filter(Boolean);
  return morceaux.length > 0 ? ` (${morceaux.join(", ")})` : "";
}

/**
 * LA PHRASE DU BLOCAGE.
 *   « Cette facture existe déjà (n° …, fournisseur, montant) — elle est en cours de traitement — au centre de paiement.
 *     Elle est dans le dossier « PAY-2026-012 — … » (Demandes de paiement, 250 000 DZD). Seul geste possible : la relancer. »
 * Sans accès : « … Elle est dans un dossier Ad & Pro. »
 */
export function phraseDeBlocage(piece: PieceDeposee, d: DossierConnu): string {
  const tete = `Cette facture existe déjà${descriptionDeLaPiece(piece)} — elle est ${PHRASE_ETAT_PAIEMENT[d.etat]}.`;
  const ou = d.acces && d.titre
    ? ` Elle est dans le dossier « ${d.titre} » (${d.module}${d.montant != null ? `, ${dzd(d.montant)}` : ""}).`
    : ` Elle est dans un dossier ${d.module}.`;
  const main = d.quiALaMain ?? QUI_A_LA_MAIN[d.etat];
  const qui = relancable(d.etat) && main ? ` Qui a la main : ${main}.` : "";
  const chef = d.acces && d.chefDeDepartement ? ` Chef du département du dossier : ${d.chefDeDepartement}.` : "";
  const geste = relancable(d.etat)
    ? " Elle ne peut pas être déposée une seconde fois : vous pouvez seulement la relancer."
    : " Elle ne peut pas être déposée une seconde fois.";
  return `${tete}${ou}${qui}${chef}${geste}`;
}

/** L'AVERTISSEMENT d'un doublon PROBABLE — le dépôt passe, la marque reste. */
export function phraseDoublonPossible(raison: string, d: Pick<DossierConnu, "module" | "acces" | "titre">): string {
  const ou = d.acces && d.titre ? `la pièce du dossier « ${d.titre} » (${d.module})` : `une pièce d'un dossier ${d.module}`;
  return `Doublon possible avec ${ou} — ${raison} Le dépôt est enregistré avec la marque « doublon possible » : le centre de paiement et les Finances la verront.`;
}

/** La marque gardée sur la pièce et lue au centre de paiement et aux Finances. */
export interface MarqueDoublonPossible {
  /** La référence de l'autre pièce (« PAY-2026-012 », « Facture — Hôtel … »), et son module. */
  autre: string;
  module: string;
  raison: string;
  le: string;
}

export function phraseMarque(m: Pick<MarqueDoublonPossible, "autre" | "module" | "raison">): string {
  return `Doublon possible de ${m.autre} (${m.module}) — ${m.raison}`;
}
