/**
 * MODULE DONNÉES MARCHÉ — LA PORTE PURE. Lecteurs de la nomenclature nationale et de l'audit IQVIA (sans Node ni
 * Prisma), importables partout.
 */
export { normEntete, texte, nombre, dateIso, ligneEntete, type Feuille } from "./domaine/commun";
export {
  ONGLETS_NOMENCLATURE, lireNomenclature, ongletDe, dateDuTitre,
  type LigneNomenclature, type NomenclatureLue, type OngletNomenclature,
} from "./domaine/nomenclature";
export { lireIqvia, type IqviaLu, type PresentationIqvia } from "./domaine/iqvia";
