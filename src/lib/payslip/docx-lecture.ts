/**
 * LIRE UN `.docx` COMME WORD LE MET EN PAGE — le modèle complet dont le rendu PDF a besoin.
 *
 * `docx-blocks.ts` rend une suite de blocs « à plat » (texte, graisse, cellules) : suffisant pour
 * relire un bulletin, insuffisant pour le REDESSINER à l'identique. La Direction l'a constaté sur
 * l'ordre de mission : le PDF ne reprenait que le texte — la date poussée à droite par ses
 * tabulations revenait à gauche, les intertitres soulignés perdaient leur trait, les tailles du
 * document étaient ignorées.
 *
 * Ce module relit donc ce qui FAIT la page :
 *   • la CASCADE DES STYLES — `docDefaults` → style de tableau → style de paragraphe (et sa chaîne
 *     `basedOn`) → style de caractère → mise en forme directe ; polices du THÈME (`minorHAnsi`…) ;
 *   • les paragraphes : alignement, retraits, espacements (y compris l'espacement AUTOMATIQUE
 *     `beforeAutospacing` des documents issus du web), interligne, TABULATIONS (gauche, droite,
 *     centrée, décimale, points de suite), bordures, trame, enchaînements ;
 *   • les fragments : police, taille, graisse, italique, soulignement, barré, couleur, surlignage,
 *     majuscules, exposant/indice, espacement des caractères, liens hypertexte ;
 *   • les LISTES (`numbering.xml`) : puces et numéros, compteurs par liste, remises à zéro ;
 *   • les champs PAGE / NUMPAGES (numéro de page dans un pied) ;
 *   • les IMAGES en ligne et ANCRÉES (position, alignement, rognage, devant/derrière le texte),
 *     les FORMES (rectangles, filets, ellipses) et les ZONES DE TEXTE, groupes compris — et leur
 *     équivalent VML des documents anciens ;
 *   • les tableaux : grille, largeurs, fusions horizontales ET verticales, bordures cellule par
 *     cellule (style de tableau, mise en forme conditionnelle de la ligne d'en-tête et des bandes),
 *     marges de cellule, trames, alignement vertical, hauteurs de ligne, lignes d'en-tête répétées ;
 *   • les SECTIONS : format, marges, distances d'en-tête et de pied, en-têtes/pieds par défaut,
 *     de première page et de pages paires, numérotation des pages.
 *
 * Module PUR : il prend des octets, il rend un modèle. Ni fichier, ni PDF, ni base.
 *
 * Découpé par responsabilité en `docx-lecture/` : `modele` (les types), `unites`, `theme`, `proprietes`,
 * `styles`, `listes`, `contexte`, `dessins` (DrawingML + VML), `paragraphes`, `blocs` (tableaux,
 * conteneurs, bandes) et `document` (sections, `lireDocx`). Ce fichier n'est plus que la PORTE.
 */

export type { Bordure, ProprietesTexte, Tabulation, ProprietesParagraphe, Rognage, ElementGraphique, ImageDocx, Inline, PositionAncre, Ancre, Etiquette, Paragraphe, Cellule, Rangee, Tableau, Bloc, Bande, Section, DocumentDocx } from "./docx-lecture/modele";
export { romain, formaterNombre } from "./docx-lecture/listes";
export { lireDocx } from "./docx-lecture/document";
