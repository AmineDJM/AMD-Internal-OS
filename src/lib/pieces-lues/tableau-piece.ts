import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { EmetteurLu } from "@/lib/pieces-lues/emetteur-destinataire";
import { MAX_DESIGNATION, type LigneLue, type PieceLue } from "@/lib/pieces-lues/structure";
import type { LigneTableau } from "@/lib/pieces-lues/tableau";

/**
 * LA PIÈCE LUE PAR SON TABLEAU (lot B1, décision 0049) — la même forme (`PieceLue`) que celle qu'un
 * modèle rend, composée ici depuis les lignes lues par les positions (`tableau.ts`) ou par la vision,
 * et depuis l'en-tête repéré par les règles (`entetes.ts`). Tout ce qui suit — contrôle des totaux,
 * préremplissage, confirmation ligne à ligne — la lit sans savoir d'où elle vient. Pur.
 */
export function pieceDepuisTableau(
  lignes: readonly LigneTableau[],
  entetes: EntetesReperes,
  emetteur: Pick<EmetteurLu, "nom" | "nif" | "rc" | "nis" | "ai">,
  /** Les motifs d'injection d'une désignation (`scanForInjection(…).flags`) — injecté par le service. */
  suspecte: (designation: string) => string[],
): PieceLue {
  const tvas = entetes.tva.map((t) => t.taux);
  const lues: LigneLue[] = lignes.map((l, i) => {
    const designation = l.designation.slice(0, MAX_DESIGNATION);
    return {
      rang: i + 1,
      designation,
      designationCoupee: l.designation.length > MAX_DESIGNATION,
      reference: l.reference,
      unite: null,
      quantite: l.quantite,
      prixUnitaire: l.prixUnitaire,
      remise: null,
      tva: tvas.length === 1 ? tvas[0] : null,
      montantHt: l.montant,
      section: false,
      forfait: false,
      illisibles: l.doutes.map((d) => ({ champ: `ligne ${l.numero}`, brut: "", raison: d })),
      suspecte: suspecte(designation),
    };
  });
  return {
    type: entetes.type === "DEVIS" || entetes.type === "FACTURE" || entetes.type === "BON_DE_COMMANDE" || entetes.type === "AVOIR" ? entetes.type : "DEVIS",
    numero: entetes.numero?.valeur ?? null,
    date: entetes.date?.valeur ?? null,
    devise: "DZD",
    modePaiement: null,
    fournisseur: { nom: emetteur.nom, nif: emetteur.nif, rc: emetteur.rc, nis: emetteur.nis, ai: emetteur.ai, adresse: null },
    tvaDefaut: tvas.length === 1 ? tvas[0] : null,
    remiseGlobale: null,
    taxes: entetes.taxes.map((t) => ({ libelle: t.libelle, taux: t.taux, montant: t.montant.valeur })),
    lignes: lues,
    totaux: {
      ht: entetes.totalHt?.valeur ?? null,
      tva: entetes.totalTva?.valeur ?? (entetes.tva.length === 1 ? entetes.tva[0].montant.valeur : null),
      taxes: entetes.taxes.length ? entetes.taxes.reduce((s, t) => s + (t.montant.valeur ?? 0), 0) : null,
      timbre: entetes.timbre?.valeur ?? null,
      ttc: entetes.totalTtc?.valeur ?? null,
    },
    illisibles: [],
    ecartees: 0,
    coupees: 0,
  };
}
