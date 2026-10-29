/**
 * LA MISE EN PAGE D'UN DOCUMENT WORD — ce que Word calcule avant d'imprimer, refait ici.
 *
 * On part du modèle lu (`docx-lecture.ts`) et l'on produit des PAGES de tracés absolus (texte à une
 * position de ligne de base, images, filets, aplats) que `to-pdf.ts` n'a plus qu'à dessiner. Toute
 * la décision est ici, et elle est pure : la seule chose qu'elle demande au monde extérieur est la
 * LARGEUR d'une chaîne dans une police (`Mesureur`), pour couper les lignes au même mot que Word.
 *
 * Ce qui est reproduit, dans l'ordre où Word le fait :
 *   • la coupure des lignes au mot (et au trait d'union), les espaces de fin de ligne qui pendent ;
 *   • les TABULATIONS : taquets gauche / centré / droit / décimal, points de suite, taquets par
 *     défaut (`w:defaultTabStop`), taquet implicite du retrait suspendu, tabulations de position ;
 *   • l'alignement (gauche, centré, droite, JUSTIFIÉ — l'espace est réparti après le dernier taquet,
 *     la dernière ligne et les lignes forcées ne sont pas étirées) ;
 *   • la hauteur des lignes depuis les métriques de la police (interligne simple de Word), la marque
 *     de paragraphe comprise, les règles « multiple », « exactement », « au moins » ;
 *   • les espacements avant / après, l'espacement automatique « HTML » (fusion des marges), les
 *     paragraphes de même style à espacement contextuel ;
 *   • la PAGINATION : sauts de page, « saut de page avant », lignes solidaires, paragraphe lié au
 *     suivant, veuves et orphelines ; les lignes d'en-tête de tableau répétées sur chaque page ;
 *   • les en-têtes et pieds de page de chaque page (première page, pages paires), qui REPOUSSENT le
 *     corps quand ils sont plus hauts que la marge, et dont les images habillées le limitent ;
 *   • les objets ancrés (images, formes, zones de texte) positionnés par rapport à la page, à la
 *     marge ou au paragraphe, devant ou derrière le texte.
 *
 * Découpé par responsabilité en `docx-composition/` : `contrats` (police, mesureur, tracés, page),
 * `boites` et `lignes` (le paragraphe), `dessins`, `tableaux`, `flux` (le remplissage d'une zone) et
 * `document` (les pages). Ce fichier n'est plus que la PORTE qui les réexporte.
 */

export { type PoliceRendu, type Mesureur, type Trace, type PageComposee, numeroDePage } from "./docx-composition/contrats";
export { composerDocument } from "./docx-composition/document";
