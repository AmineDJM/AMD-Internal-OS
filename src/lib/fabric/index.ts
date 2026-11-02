/**
 * LA FAÇADE DE LA FABRIC — un seul point d'entrée pour les consommateurs.
 *
 * Le cliquet de frontière (`boundary-scan`) compte les imports PAR INSTRUCTION : un fichier
 * d'Adam qui consomme trois briques de la fabric par ce baril paie UN franchissement, déclaré
 * une fois — au lieu de trois lignes qui feraient monter la dette pour le même couplage.
 */
export { chercherContenu } from "@/lib/fabric/text-search";
export {
  enregistrerMentions, balayerMentions, documentsLies, resoudreEntitesDe,
  viderCacheDictionnaire,
} from "@/lib/fabric/mentions";
export { lireEtatChaud, rechaufferEtatChaud, invaliderEtatsChauds, type LectureChaude } from "@/lib/fabric/hot-state";
export { loteurNoeudsDrive, type Loteur } from "@/lib/fabric/bulk";
export { consignerProvenance } from "@/lib/fabric/provenance-store";
export { trancher, type Candidat } from "@/lib/fabric/entites-score";
