"use client";

import { ComposerPieceButton, type RevisionComposeur } from "@/components/pieces/composer-piece";
import type { ValeursComposables } from "@/lib/legal/piece-emise";


/**
 * RÉVISER UNE PIÈCE ÉMISE (§118.194) — un devis ou un bon de commande, ENTIÈREMENT (Direction, 10/2026 : « chaque écriture
 * et détail, pas seulement quelques champs »).
 *
 * Ce n'est plus un second formulaire : c'est le COMPOSEUR (`components/pieces/composer-piece.tsx`) ouvert en révision,
 * pré-rempli de la version courante — tiers et coordonnées, lignes, dates, références, paiement, TVA, remise, taxes,
 * livraison, contact, notes, papier, coordonnées imprimées de l'émetteur, signataire, mentions. Un seul écran pour composer
 * et réviser : deux formulaires finiraient par ne pas porter les mêmes champs (§118.5). La révision produit une NOUVELLE
 * VERSION du même fichier (même numéro), et la version affichée est exigée (`versionVue`).
 */
export function ReviserPieceButton(props: {
  legalDocumentId: string;
  type: "DEVIS" | "BON_DE_COMMANDE";
  numero: string;
  version: number;
  /** La version courante, en valeurs d'écran (`valeursComposables`). */
  valeurs: ValeursComposables;
  /** La société émettrice (fixe : le numéro est le sien). */
  societe?: { id: string; label: string } | null;
  letterheads?: { id: string; name: string; companyId: string | null; companyLabel: string | null }[];
  envoyer?: RevisionComposeur["envoyer"];
  apercu?: RevisionComposeur["apercu"];
  motifFacultatif?: boolean;
  sansImpression?: boolean;
  libelle?: string;
  /** Un bouton discret (lien) plutôt qu'un bouton plein — la case d'un poste est petite. */
  discret?: boolean;
}) {
  return (
    <ComposerPieceButton
      typeInitial={props.type} typesAutorises={[props.type]}
      societes={props.societe ? [props.societe] : []} societeParDefaut={props.societe?.id ?? null}
      letterheads={props.letterheads ?? []} peutReglerNumerotation={false}
      amont={{ options: [], tronquees: [], fermees: [], limite: 0 }}
      declencheur={{ libelle: props.libelle, discret: props.discret }}
      revision={{
        legalDocumentId: props.legalDocumentId, numero: props.numero, version: props.version, valeurs: props.valeurs,
        envoyer: props.envoyer, apercu: props.apercu, motifFacultatif: props.motifFacultatif, sansImpression: props.sansImpression,
      }}
    />
  );
}
