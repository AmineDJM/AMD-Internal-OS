import { annuaireDeLecture, proposerLecture } from "@/lib/pieces-lues/service";
import type { FactureLue } from "@/lib/bons-de-commande/copie-signee";

/**
 * LA FACTURE D'UN POSTE, LUE PAR LUNA (Direction, 06/10) — « Luna vérifie uniquement la cohérence avec le bon de
 * commande ». On n'en tire que ce que le contrôle compare : le total (TTC, sinon net à payer), les numéros de BC
 * qu'elle cite, et son émetteur. La lecture est celle de toutes les pièces (`proposerLecture` : Luna quand la pièce
 * peut sortir, le moteur local sinon).
 *
 * Une lecture qui échoue ne fait jamais échouer le dépôt : la facture est là, le contrôle dira « montant illisible »
 * — et le montant saisi, s'il y en a un, prend le relais.
 *
 * Hors d'un fichier « use server » : l'auteur est reçu en argument, ce n'est pas une action d'écran (§118.153).
 */
export async function lireFactureDuPoste(i: { userId: string; octets: Buffer; nomFichier: string; montantSaisi: number | null }): Promise<FactureLue> {
  const repli = (methode: string): FactureLue => ({ montantLu: null, montantSaisi: i.montantSaisi, bcCites: [], fournisseurLu: null, methode });
  try {
    const { annuaireVisible, groupe } = await annuaireDeLecture(i.userId);
    const r = await proposerLecture({
      user: { id: i.userId }, octets: i.octets, nomFichier: i.nomFichier,
      contexte: { cible: "LEGAL_DOCUMENT", sortieCloudPermise: true, annuaireVisible, groupe },
    });
    if (!r.ok) return repli(`Facture non lue : ${r.error}`);
    const p = r.proposition;
    const e = p.entetes;
    // LE TOTAL IMPRIMÉ, repéré sur le papier d'abord (avec sa preuve) ; celui que le modèle a lu ensuite.
    const montantLu = e.totalTtc?.valeur ?? e.netAPayer?.valeur ?? p.piece?.totaux.ttc ?? null;
    const bcCites = e.references.filter((x) => x.type === "BON_DE_COMMANDE").map((x) => x.numero);
    return {
      montantLu: typeof montantLu === "number" && montantLu > 0 ? montantLu : null,
      montantSaisi: i.montantSaisi,
      bcCites: [...new Set(bcCites)],
      fournisseurLu: p.emetteur?.nom?.trim() || null,
      methode: p.noteMethode.slice(0, 300),
    };
  } catch (err) {
    console.error("[facture-poste] lecture impossible", err);
    return repli("La lecture de la facture a échoué (erreur technique).");
  }
}
