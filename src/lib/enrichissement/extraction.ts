/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTION PAR NATURE — quel extracteur pour quelle pièce (étape 3 du moteur, §3-E).
 *
 * Le classement a dit la nature ; ce module choisit l'extracteur et le lance sur le TEXTE LU SUR CE
 * SERVEUR. Tous les extracteurs branchés ici sont des règles locales : aucun ne parle à un modèle.
 * Les pièces commerciales (devis, facture, BC, avoir) passent par la lecture des pièces
 * (`pieces-lues`), qui lit la base : elles sont rendues à l'appelant serveur (`COMMERCIALE`).
 *
 * Une nature sans extracteur (bulletin de paie, billet, attestation…) n'est pas une erreur : la pièce
 * est classée, rien n'est proposé, et c'est dit.
 *
 * Module PUR : aucune base, aucun fichier, aucun réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { extraireCarteVisite } from "./extracteurs/carte-visite";
import { extraireCni } from "./extracteurs/cni";
import { extraireContrat } from "./extracteurs/contrat";
import { extraireCv } from "./extracteurs/cv";
import { extrairePasseport } from "./extracteurs/passeport";
import { extraireProgrammeCongres } from "./extracteurs/programme-congres";
import { extraireRegistre } from "./extracteurs/registre-commerce";
import { extraireRib } from "./extracteurs/rib";
import type { NaturePiece, ResultatExtraction } from "./types";

export const NATURES_COMMERCIALES = ["DEVIS", "FACTURE", "BON_DE_COMMANDE", "AVOIR"] as const;
export type NatureCommerciale = (typeof NATURES_COMMERCIALES)[number];
export const estCommerciale = (n: NaturePiece): n is NatureCommerciale => (NATURES_COMMERCIALES as readonly string[]).includes(n);

export interface EntreeParNature {
  texte: string;
  nomFichier: string | null;
  /** Le genre du sujet de la fiche où la pièce est déposée, s'il est connu (sert au RIB). */
  titulaire?: "PERSONNE" | "ORGANISATION";
}

export type ExtractionParNature =
  | { genre: "FAITE"; resultat: ResultatExtraction }
  | { genre: "COMMERCIALE"; nature: NatureCommerciale }
  | { genre: "SANS_EXTRACTEUR"; nature: NaturePiece; note: string };

export function extraireParNature(nature: NaturePiece, e: EntreeParNature): ExtractionParNature {
  const base = { texte: e.texte, nomFichier: e.nomFichier };
  const faite = (resultat: ResultatExtraction): ExtractionParNature => ({ genre: "FAITE", resultat });
  if (estCommerciale(nature)) return { genre: "COMMERCIALE", nature };
  switch (nature) {
    case "PASSEPORT": return faite(extrairePasseport(base));
    case "CNI": return faite(extraireCni(base));
    case "CV": return faite(extraireCv(base));
    case "CARTE_VISITE": return faite(extraireCarteVisite(base));
    case "CONTRAT":
    case "CONVENTION": return faite(extraireContrat({ texte: e.texte, nature }));
    case "REGISTRE_COMMERCE":
    case "ATTESTATION_NIF":
    case "CARTE_IMMATRICULATION_FISCALE": return faite(extraireRegistre({ texte: e.texte, nature }));
    case "RIB": return faite(extraireRib({ texte: e.texte, titulaire: e.titulaire }));
    case "PROGRAMME_CONGRES": return faite(extraireProgrammeCongres({ texte: e.texte }));
    default:
      return { genre: "SANS_EXTRACTEUR", nature, note: `Aucun extracteur pour une pièce « ${nature} » : elle est classée, rien n'est proposé.` };
  }
}
