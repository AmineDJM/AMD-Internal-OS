/**
 * LES EXPORTS DE L'ERP, POUR LES ASSISTANTS (lot K7, décision 0037) — la porte du socle IA.
 *
 * Les exports d'écran (Excel du suivi Regulatory, budget, pilotage, PDF du plan de tournée…) sont des fonctions de
 * l'ERP (façade `lib/exports/`, une par fichier), que la route d'écran appelle aussi. L'assistant les atteint par cette
 * seule porte : le catalogue (une fiche par export), la porte d'écran (`exportOuvert`) et la production
 * (`produireExport`, sous les droits de la personne). Un seul franchissement compté vers l'ERP (`SOCLE_IA_CEILING`).
 */
export {
  CATALOGUE_EXPORTS, DOSSIER_EXPORTS, exportOuvert, nomDeFichierSur, produireExport, type FicheExport,
} from "@/lib/exports/producteurs";
