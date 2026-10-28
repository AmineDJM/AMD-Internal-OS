/**
 * LEGAL — ce que l'écran dit d'un bon de commande qu'on vient d'écrire (où il attend, ce qui a bougé).
 *
 * Sorti de `actions/legal-actions.ts` (lot V4) : pur.
 */
import type { ResultatAiguillage } from "@/lib/bons-de-commande/aiguillage";
import {
  reserveBC, reserveSansPorte, reserveEtapeBC, PHRASE_SIGNATURE_RETIREE, LIBELLE_CENTRE_BC,
} from "@/lib/bons-de-commande/regle";

/**
 * CE QUE LA PHRASE DE L'ÉCRAN DIT D'UN BC QU'ON VIENT D'ÉCRIRE (§118.32).
 *
 * « Document créé » sur un bon de commande que personne n'a encore validé le ferait partir chez
 * le fournisseur : il s'ouvre, il porte un numéro. La phrase dit où il attend, et se tait quand
 * rien n'a bougé. Un aiguillage qui n'a trouvé AUCUN siège se dit aussi — une pièce sans porte ne
 * doit pas avoir l'air validée.
 */
export function phraseAiguillage(r: ResultatAiguillage): string | null {
  const sansPorte = reserveSansPorte(r);
  if (sansPorte) return sansPorte;
  // La pièce n'est plus un BC (re-qualifiée ou annulée) : seule la porte retirée se dit.
  if (r.geste === "RETIREE") return "Sa validation en attente a été retirée du centre.";

  let tete: string | null = null;
  if (r.geste === "POSEE" || r.geste === "TRANSFEREE" || r.geste === "ROUVERTE") {
    const centre = r.porte ? LIBELLE_CENTRE_BC[r.porte.centre] : "centre de validation";
    const verbe = r.geste === "TRANSFEREE" ? "transféré au" : r.geste === "ROUVERTE" ? "renvoyé au" : "adressé au";
    tete = `Bon de commande ${verbe} ${centre}.`;
  } else if (r.geste === "SOUS_SEUIL") {
    tete = "Sa validation en attente est retirée du centre.";
  }
  // Rien n'a bougé : la phrase se tait (§118.32). Ce qui BOUGE sans geste de porte — l'entrée dans
  // la file des Finances, une signature retirée — se dit comme un geste.
  if (!tete && !r.signatureRetiree && !r.versLesFinances) return null;
  const reserve = r.etape ? reserveEtapeBC(r.etape, r.porte, r.seuil) : reserveBC(r.porte);
  return [r.signatureRetiree ? PHRASE_SIGNATURE_RETIREE : null, tete, reserve].filter(Boolean).join(" ");
}
