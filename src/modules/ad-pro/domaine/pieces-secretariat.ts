import type { AdminRequestType } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES COMMERCIALES QU'ON FAIT ÉTABLIR PAR LE SECRÉTARIAT — module PUR.
 *
 * « On peut demander un devis pas que un BC, après le devis on peut demander un BC, après le BC
 * une facture. » Trois pièces, et il a fallu MESURER avant de conclure qu'elles demandaient trois
 * fois le même geste. Elles ne le demandent pas :
 *
 * - le **DEVIS** et la **FACTURE** sont des pièces qu'on fait ÉTABLIR ou qu'on RÉCLAME : une
 *   demande au bureau du secrétariat, avec son message, sa référence, sa file, ses pièces
 *   jointes et son cycle (prendre en charge, bloquer, terminer) — tout cela existe déjà ;
 * - le **BON DE COMMANDE**, lui, ENGAGE de l'argent : il porte le visa de la Direction puis
 *   l'émission d'un ordre de dépense par les Finances (`AdProItem.orderStage`). En faire une
 *   quatrième demande de secrétariat créerait une SECONDE vérité sur « le BC de ce poste », et
 *   c'est celle qui porte le visa qui finirait par prendre du retard (§118.5). Ce que la demande
 *   du dirigeant ajoute là-bas est une NOTIFICATION à l'assistante — elle l'établit — pas un
 *   second circuit.
 *
 * Ce fichier ne porte donc QUE les deux natures de secrétariat. Il n'importe rien (hors un type),
 * parce que l'écran ET l'action serveur en ont besoin sans avoir le droit de se parler.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE TRAVAIL DE L'ASSISTANTE POUR UN BON DE COMMANDE — une demande au secrétariat de type « autre »
 * dont le titre commence ainsi (audit 360°, I10). Le BC lui-même garde son circuit sur le poste ;
 * cette demande porte le geste de l'assistante (l'établir). Une seule écriture de ce titre, lue par
 * l'action qui la crée, celle qui la clôt, et l'écran qui la montre sur la carte du poste (§118.5).
 */
export const TITRE_BC_A_ETABLIR = "Bon de commande à établir";

/** Cette demande au secrétariat est-elle le travail « BC à établir » d'un poste ? */
export function estDemandeBcAEtablir(r: { type: string; title: string }): boolean {
  return r.type === "OTHER" && r.title.startsWith(TITRE_BC_A_ETABLIR);
}

/** Les deux pièces qu'on demande au bureau du secrétariat pour un poste. */
export type NaturePieceSecretariat = "DEVIS" | "FACTURE";

export const NATURES_PIECE_SECRETARIAT: NaturePieceSecretariat[] = ["DEVIS", "FACTURE"];

interface SpecPiece {
  /** Le libellé que la personne lit — jamais recopié à l'écran (§118.5). */
  libelle: string;
  /** Le type canonique du bureau du secrétariat, qui décide de la file où la demande tombe. */
  type: AdminRequestType;
  /** Ce que le bouton propose, à la première personne du pluriel de l'ERP. */
  bouton: string;
  /** La phrase du champ de message : ce que le dirigeant a demandé qu'on puisse y écrire. */
  aide: string;
}

export const PIECE_SECRETARIAT: Record<NaturePieceSecretariat, SpecPiece> = {
  DEVIS: {
    libelle: "Devis",
    type: "QUOTE",
    bouton: "Demander un devis (secrétariat)",
    aide: "Contenu attendu, prestataire pressenti, références — ce que le secrétariat doit transmettre.",
  },
  FACTURE: {
    libelle: "Facture",
    type: "PAYMENT",
    // « Facture » et non « Demander une facture » : c'est le fournisseur qui l'émet, le
    // secrétariat qui la réclame et la range. Annoncer « établir » ferait croire qu'on
    // la fabrique ici.
    bouton: "Réclamer la facture (secrétariat)",
    aide: "Références du bon de commande, contenu facturé, coordonnées du fournisseur.",
  },
};

/** L'état d'un poste tel que la règle d'enchaînement a besoin de le lire. */
export interface EtatPieces {
  /** Les natures pour lesquelles une demande est DÉJÀ ouverte (non close). */
  ouvertes: readonly NaturePieceSecretariat[];
  /** Le bon de commande a-t-il été demandé ? (`orderStage` différent de `NONE`.) */
  bcDemande: boolean;
}

/**
 * PEUT-ON DEMANDER CETTE PIÈCE MAINTENANT ? — et le refus NOMME le geste qui le lève (§118.30).
 *
 * Deux règles, et la première moitié compte autant que la seconde :
 *
 * - **le devis n'est PAS un préalable**. « On peut également demander un devis, pas que un BC »
 *   dit qu'on peut demander un devis EN PLUS, jamais qu'il faut en passer par lui. L'exiger
 *   interdirait le cas le plus courant — un prestataire habituel dont le prix est connu — et un
 *   refus à tort coûte plus cher que le défaut qu'il prétend éviter (§118.27) ;
 * - **la facture vient APRÈS le bon de commande**, parce qu'une facture sans engagement est
 *   précisément l'anomalie que le contrôle financier de cet ERP existe pour lever
 *   (`facture_sans_bc`). La réclamer avant le BC fabriquerait à la main le défaut qu'on
 *   surveille ailleurs.
 *
 * Une demande DÉJÀ OUVERTE ferme la sienne : deux demandes identiques dans la file du
 * secrétariat font traiter deux fois la même chose, et la seconde réponse écrase la première.
 */
export function peutDemanderPiece(
  nature: NaturePieceSecretariat,
  etat: EtatPieces,
): { ok: true } | { ok: false; raison: string } {
  if (etat.ouvertes.includes(nature)) {
    // LE REFUS NOMME LE GESTE QUI LE LÈVE (§118.30, audit 360° R08) : la demande ouverte se complète
    // ou s'annule depuis sa fiche — en ouvrir une seconde ferait traiter deux fois la même pièce.
    return {
      ok: false,
      raison: `Une demande de ${PIECE_SECRETARIAT[nature].libelle.toLowerCase()} est déjà ouverte pour ce poste : `
        + "complétez-la depuis sa fiche (modifier, ou écrire dans sa discussion), ou annulez-la avant d'en demander une autre.",
    };
  }
  if (nature === "FACTURE" && !etat.bcDemande) {
    return {
      ok: false,
      raison: "La facture se réclame APRÈS le bon de commande : demandez d'abord l'émission du bon de commande, puis revenez ici.",
    };
  }
  return { ok: true };
}

/**
 * LE TITRE DE LA DEMANDE — il doit se lire seul dans la file du secrétariat.
 *
 * L'assistante voit trente demandes dans sa journée : « Facture » ne lui dit ni de quoi ni pour
 * qui. On nomme donc la pièce, le poste et l'opération — et c'est le SEUL endroit où ce titre
 * s'écrit, pour que les deux natures ne divergent pas sur la forme.
 */
export function titrePiece(nature: NaturePieceSecretariat, poste: string, operation: string): string {
  return `${PIECE_SECRETARIAT[nature].libelle} — ${poste} (${operation})`;
}
