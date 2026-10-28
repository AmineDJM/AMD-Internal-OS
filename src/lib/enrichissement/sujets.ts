/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * À QUI SE RAPPORTENT LES FAITS D'UNE PIÈCE ? — la part PURE de la résolution des sujets.
 *
 * Un passeport déposé sur la fiche d'un voyageur parle de CE voyageur : le rattachement dit déjà qui
 * est le titulaire, mieux que tout rapprochement de nom. C'est le CONTEXTE. Mais le contexte n'a pas
 * le dernier mot : si le numéro du passeport (comparé par son empreinte au coffre) désigne une AUTRE
 * personne, rien n'est rattaché — deux fiches ne se confondent jamais d'office (`decision.ts`).
 *
 *   1. un identifiant fort désigne une seule fiche, sans contredire le contexte → cette fiche ;
 *   2. un identifiant désigne une fiche différente de celle du contexte → AMBIGU, à trancher à la main ;
 *   3. pas d'identifiant décisif, une seule personne en contexte → la personne du contexte ;
 *   4. sinon → aucune fiche : les faits restent proposés sans sujet, rien n'est deviné.
 *
 * Module PUR : les porteurs, les natures et l'arbitrage. Les lectures en base vivent dans `traitement.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { NatureCoffre } from "@/lib/coffre/natures";
import type { ResolutionSujet } from "./decision";
import type { NaturePiece, RoleSujet } from "./types";

/**
 * LES FICHES QUI PORTENT UNE PERSONNE — le type de rattachement, et le modèle qui tient sa colonne
 * `personneId`. `PERSONNE` désigne directement la fiche du référentiel.
 */
export const PORTEURS_DE_PERSONNE = {
  PERSONNE: null,
  AD_PRO_VOYAGEUR: "adProVoyageur",
  AD_PRO_HEBERGEMENT: "adProHebergement",
  EMPLOYEE: "employee",
  RECRUITMENT_CANDIDATE: "recruitmentCandidate",
} as const;
export type PorteurDePersonne = keyof typeof PORTEURS_DE_PERSONNE;

export const estPorteurDePersonne = (type: string): type is PorteurDePersonne => Object.hasOwn(PORTEURS_DE_PERSONNE, type);

/**
 * Les natures dont le TITULAIRE est la personne de la fiche où la pièce est déposée. Un devis déposé
 * sur un voyageur ne parle pas du voyageur : son émetteur est un fournisseur.
 */
const NATURES_DU_PORTEUR: ReadonlySet<NaturePiece> = new Set<NaturePiece>([
  "PASSEPORT", "CNI", "PERMIS_CONDUIRE", "VISA", "BULLETIN_PAIE", "CV", "DIPLOME", "RIB",
]);

/** Le sujet `role` d'une pièce `nature` est-il la personne du rattachement ? */
export function sujetEstLePorteur(nature: NaturePiece, role: RoleSujet): boolean {
  return role === "TITULAIRE" && NATURES_DU_PORTEUR.has(nature);
}

/**
 * LES ATTRIBUTS SENSIBLES ET LEUR NATURE AU COFFRE. Un RIB lu peut être un IBAN (lettres en tête) ou
 * un RIB algérien (vingt chiffres) : la valeur le dit.
 */
export function natureCoffreDe(attribut: string, valeurNormalisee: string): NatureCoffre | null {
  switch (attribut) {
    case "personne.passeport.numero": return "PASSEPORT_NUMERO";
    case "personne.passeport.expiration": return "PASSEPORT_EXPIRATION";
    case "personne.cni.numero": return "CNI_NUMERO";
    case "personne.nin": return "NIN";
    case "personne.salaire": return "SALAIRE";
    case "personne.rib":
    case "organisation.rib": return /^[A-Z]{2}\d{2}/i.test(valeurNormalisee.replace(/\s+/g, "")) ? "IBAN" : "RIB";
    default: return null;
  }
}

/** Les identifiants sensibles comparés par leur EMPREINTE au coffre pour retrouver une personne. */
export const IDENTIFIANTS_SENSIBLES_PERSONNE = ["personne.passeport.numero", "personne.cni.numero", "personne.nin"] as const;

export type ChoixSujet =
  | { sujetId: string; raison: string }
  | { sujetId: null; raison: string; ambigu: boolean };

/**
 * ARBITRE entre le contexte (les personnes des fiches où la pièce est déposée) et ce que disent les
 * identifiants (`resoudreSujet` sur les fiches qui partagent une empreinte). Voir l'en-tête.
 */
export function choisirSujet(p: { contexte: readonly string[]; parIdentifiant: ResolutionSujet | null }): ChoixSujet {
  const contexte = [...new Set(p.contexte)];
  const r = p.parIdentifiant;
  if (r?.resultat === "RATTACHER") {
    if (contexte.length > 0 && !contexte.includes(r.ficheId)) {
      return { sujetId: null, ambigu: true, raison: `${r.raison} Mais la pièce est déposée sur une autre fiche : rien n'est rattaché, à trancher à la main.` };
    }
    return { sujetId: r.ficheId, raison: r.raison };
  }
  if (r?.resultat === "AMBIGU" && r.candidats.some((c) => !contexte.includes(c.id))) {
    return { sujetId: null, ambigu: true, raison: r.raison };
  }
  if (contexte.length === 1) return { sujetId: contexte[0], raison: "La pièce est déposée sur la fiche de cette personne." };
  if (contexte.length > 1) return { sujetId: null, ambigu: true, raison: "La pièce est déposée sur plusieurs personnes : le titulaire n'est pas deviné." };
  return { sujetId: null, ambigu: false, raison: "Aucune fiche de personne ne porte cette pièce : les faits restent proposés, sans sujet." };
}
