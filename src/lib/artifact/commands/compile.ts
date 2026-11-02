/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPILATEUR DE COMMANDES — ce qui fait d'une proposition de modèle un programme.
 *
 * Même doctrine que `missions/compiler/compile.ts`, appliquée aux documents : le plan d'un
 * modèle n'est JAMAIS exécuté tel quel. Ici, quatre refus :
 *
 *   1. OPÉRATION INCONNUE      — `docx.faire_joli` n'existe pas ; on ne devine pas.
 *   2. OPÉRATION HORS FORMAT   — `pdf.supprimer_pages` sur un `.docx` est un refus, pas un
 *                                « à peu près » : c'est le signe que le modèle s'est trompé de
 *                                document ouvert, et l'appliquer détruirait le bon fichier.
 *   3. CHAMP OBLIGATOIRE MANQUANT — « supprime le paragraphe » sans dire lequel supprimerait
 *                                le premier par défaut. Refus.
 *   4. VALEUR ABERRANTE        — une police de 4 000 points, une page 0, une opacité de 12.
 *
 * Ce que le compilateur ne fait PAS : deviner. Une commande incomplète remonte une PHRASE que
 * l'assistant peut redire à la personne (« quel paragraphe ? »), pas un comportement par défaut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import { analyserPlage } from "@/lib/artifact/object-model/model";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import { OPS, OPS_PAR_FORMAT, cibleVide } from "@/lib/artifact/commands/ir";

export interface RefusCommande {
  index: number;
  op: string;
  motif: string;
}

export interface ResultatCompilation {
  ok: boolean;
  commandes: CommandeArtefact[];
  refus: RefusCommande[];
}

const ALIGNEMENTS = new Set(["left", "center", "right", "justify"]);
const POSITIONS = new Set(["avant", "apres"]);
const DIRECTIONS = new Set(["haut", "bas"]);

/** Bornes de bon sens. Aucune n'est un plafond de produit : ce sont des garde-fous de saisie. */
const MAX_TAILLE_PT = 400;
const MAX_CM = 500;
const MAX_PAGES = 5000;

const aQuelqueChose = (v: unknown): boolean => v !== null && v !== undefined;

/** Au moins UNE mise en forme demandée — sinon la commande ne ferait rien. */
function auMoinsUnFormat(c: CommandeArtefact): boolean {
  return [c.gras, c.italique, c.souligne, c.taillePt, c.police, c.couleur, c.alignement,
    c.formatNombre, c.remplissage].some(aQuelqueChose);
}

function pagesValides(pages: number[] | null): string | null {
  if (!pages || pages.length === 0) return "il faut dire quelles pages (numérotation humaine : la première page est la page 1)";
  if (pages.length > MAX_PAGES) return `trop de pages d'un coup (${pages.length})`;
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 1) return `page « ${p} » invalide : les pages se comptent à partir de 1`;
  }
  return null;
}

/** VÉRIFIE UNE commande. Rend `null` si elle passe, sinon le motif du refus, en clair. */
export function verifierCommande(c: CommandeArtefact, format: ArtifactFormat): string | null {
  if (!c.op || typeof c.op !== "string") return "commande sans opération";
  if (!(OPS as readonly string[]).includes(c.op)) return `opération inconnue « ${c.op} »`;
  if (!OPS_PAR_FORMAT[format].includes(c.op)) {
    return `« ${c.op} » ne s'applique pas à un document ${format}`;
  }

  if (c.alignement !== null && !ALIGNEMENTS.has(c.alignement)) {
    return `alignement « ${c.alignement} » inconnu (left, center, right, justify)`;
  }
  if (c.taillePt !== null && (!(c.taillePt > 0) || c.taillePt > MAX_TAILLE_PT)) {
    return `taille de police aberrante (${c.taillePt} pt)`;
  }
  if (c.couleur !== null && !/^[0-9A-Fa-f]{6}$/.test(c.couleur)) {
    return `couleur « ${c.couleur} » : attendu six chiffres hexadécimaux, sans dièse`;
  }
  for (const [nom, v] of [["largeurCm", c.largeurCm], ["hauteurCm", c.hauteurCm], ["xCm", c.xCm], ["yCm", c.yCm]] as const) {
    if (v !== null && (!Number.isFinite(v) || Math.abs(v) > MAX_CM)) return `${nom} hors limites (${v})`;
  }
  if (c.opacite !== null && (c.opacite < 0 || c.opacite > 1)) return "opacité attendue entre 0 et 1";

  switch (c.op) {
    // ── DOCX ────────────────────────────────────────────────────────────────────────────
    case "docx.align":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe centrer / aligner";
      if (c.alignement === null) return "il faut dire quel alignement";
      return null;
    case "docx.format_texte":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe mettre en forme";
      if (!auMoinsUnFormat(c)) return "aucune mise en forme demandée";
      return null;
    case "docx.espacement":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe espacer";
      if (c.avantPt === null && c.apresPt === null) return "il faut donner un espacement avant et/ou après";
      return null;
    case "docx.interligne":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe aérer";
      if (c.interligne === null) return "il faut donner l'interligne (1 = simple, 1,5, 2 = double)";
      if (c.interligne < 0.5 || c.interligne > 5) return `interligne ${c.interligne} aberrant : entre 0,5 et 5`;
      return null;
    case "docx.cellule_bordure":
      if (cibleVide(c.cible)) return "il faut dire QUEL tableau";
      if (c.ligne === null || c.colonne === null) return "il faut dire quelle LIGNE et quelle COLONNE (1-indexées)";
      if (!c.bordure) return "il faut dire quels côtés border (haut, bas, gauche, droite, contour, tout, aucun)";
      return null;
    case "docx.retrait":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe décaler";
      if (c.gaucheCm === null && c.droiteCm === null) return "il faut donner un retrait gauche et/ou droit";
      return null;
    case "docx.texte":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe réécrire";
      if (c.texte === null) return "il faut donner le nouveau texte";
      return null;
    case "docx.inserer_paragraphe":
      // Une cible VIDE est licite ici — et seulement ici : « ajoute un paragraphe » sans cible
      // signifie « à la FIN du document ». C'est un geste complet en soi, et c'est le SEUL
      // possible sur un papier en-tête au corps vide (mesuré en conversation réelle : exiger
      // une cible rendait la lettre impossible à commencer).
      if (c.texte === null) return "il faut donner le texte à insérer";
      if (c.position !== null && !POSITIONS.has(c.position)) return "position attendue : avant ou apres";
      return null;
    case "docx.inserer_tableau": {
      // Comme `docx.inserer_paragraphe` : une cible vide veut dire « à la fin ».
      const lignes = (c.texte ?? "").split("\n").filter((l) => l.trim());
      if (lignes.length === 0) return "il faut donner les lignes du tableau (une par ligne, cellules séparées par « | »)";
      if (lignes.length > 200) return "200 lignes au plus par tableau";
      if (lignes.some((l) => l.split("|").length > 20)) return "20 colonnes au plus par tableau";
      if (c.position !== null && !POSITIONS.has(c.position)) return "position attendue : avant ou apres";
      return null;
    }
    case "docx.supprimer_paragraphe":
      if (cibleVide(c.cible)) return "il faut dire QUEL paragraphe supprimer";
      return null;
    case "docx.deplacer":
      if (cibleVide(c.cible)) return "il faut dire QUOI déplacer";
      if (c.direction === null || !DIRECTIONS.has(c.direction)) return "direction attendue : haut ou bas";
      if (c.pas !== null && (!Number.isInteger(c.pas) || c.pas < 1)) return "le nombre de pas doit être un entier ≥ 1";
      return null;
    case "docx.remplacer_texte":
      if (!c.chercher) return "il faut dire quel texte chercher";
      if (c.remplacer === null) return "il faut dire par quoi remplacer";
      return null;
    case "docx.cellule":
      if (cibleVide(c.cible)) return "il faut dire QUEL tableau";
      if (c.ligne === null || c.colonne === null) return "il faut donner la ligne et la colonne (à partir de 1)";
      if (c.ligne < 1 || c.colonne < 1) return "ligne et colonne se comptent à partir de 1";
      if (c.texte === null) return "il faut donner le contenu de la cellule";
      return null;
    case "docx.inserer_ligne":
      if (cibleVide(c.cible)) return "il faut dire QUEL tableau";
      if (c.ligne !== null && c.ligne < 1) return "la ligne se compte à partir de 1";
      return null;
    case "docx.supprimer_ligne":
      if (cibleVide(c.cible)) return "il faut dire QUEL tableau";
      if (c.ligne === null || c.ligne < 1) return "il faut dire quelle ligne supprimer (à partir de 1)";
      return null;
    case "docx.image_taille":
      if (cibleVide(c.cible)) return "il faut dire QUELLE image";
      if (c.largeurCm === null && c.hauteurCm === null) return "il faut donner une largeur et/ou une hauteur";
      return null;
    case "docx.supprimer_image":
      if (cibleVide(c.cible)) return "il faut dire QUELLE image supprimer";
      return null;
    case "docx.inserer_image":
      /**
       * PAS DE CIBLE EXIGÉE, comme pour `docx.inserer_paragraphe` : sans cible, l'image entre à
       * la FIN du document. C'est le geste complet sur un papier en-tête au corps vide, et
       * exiger un paragraphe rendrait impossible la première image d'une lettre qui n'en a pas.
       */
      if (!c.imageSource) return "il faut dire QUELLE image insérer (le fichier source)";
      if (c.position !== null && !POSITIONS.has(c.position)) return "position attendue : avant ou apres";
      if (c.largeurCm !== null && c.largeurCm <= 0) return "la largeur doit être positive";
      if (c.hauteurCm !== null && c.hauteurCm <= 0) return "la hauteur doit être positive";
      return null;
    case "docx.remplacer_image":
      // ICI la cible est OBLIGATOIRE : « remplace l'image » sur un document qui en a quatre
      // n'en désigne aucune, et en choisir une reviendrait à modifier la mauvaise en annonçant
      // que c'est fait — le défaut le plus coûteux de tout ce système (§104.7).
      if (cibleVide(c.cible)) return "il faut dire QUELLE image remplacer";
      if (!c.imageSource) return "il faut dire par quelle image la remplacer (le fichier source)";
      return null;

    // ── XLSX ────────────────────────────────────────────────────────────────────────────
    case "xlsx.valeur":
      if (!c.plage) return "il faut donner la cellule ou la plage (ex. B4 ou B4:B20)";
      if (!analyserPlage(c.plage)) return `plage « ${c.plage} » illisible`;
      if (c.texte === null) return "il faut donner la valeur";
      return null;
    case "xlsx.formule":
      if (!c.plage || !analyserPlage(c.plage)) return "il faut donner une cellule ou une plage valide";
      if (!c.formule) return "il faut donner la formule";
      return null;
    case "xlsx.format":
      if (!c.plage || !analyserPlage(c.plage)) return "il faut donner une plage valide";
      if (!auMoinsUnFormat(c)) return "aucune mise en forme demandée";
      return null;
    case "xlsx.largeur_colonne":
      if (c.colonne === null || c.colonne < 1) return "il faut donner la colonne (1 = A)";
      if (c.largeurCm === null && c.taillePt === null) return "il faut donner une largeur";
      return null;
    case "xlsx.inserer_ligne":
    case "xlsx.supprimer_ligne":
      if (c.ligne === null || c.ligne < 1) return "il faut donner la ligne (à partir de 1)";
      return null;
    case "xlsx.inserer_colonne":
    case "xlsx.supprimer_colonne":
      if (c.colonne === null || c.colonne < 1) return "il faut donner la colonne (1 = A)";
      return null;
    case "xlsx.figer":
      if (c.ligne === null && c.colonne === null) return "il faut dire combien de lignes et/ou colonnes figer";
      return null;
    case "xlsx.fusionner":
      if (!c.plage || !analyserPlage(c.plage)) return "il faut donner la plage à fusionner";
      return null;
    case "xlsx.bordure":
      if (!c.plage && (c.ligne === null || c.colonne === null)) return "il faut une plage (A1:C4) ou une ligne et une colonne";
      if (!c.bordure) return "il faut dire quels côtés border (haut, bas, gauche, droite, contour, tout, aucun)";
      return null;
    case "xlsx.trier":
      if (!c.plage || !analyserPlage(c.plage)) return "il faut donner la plage à trier";
      if (c.colonne === null || c.colonne < 1) return "il faut dire sur quelle colonne trier (1 = la première de la plage)";
      return null;
    case "xlsx.ajouter_feuille":
      if (!c.nom) return "il faut donner le nom de la feuille";
      return null;
    case "xlsx.renommer_feuille":
      if (!c.feuille) return "il faut dire quelle feuille renommer";
      if (!c.nom) return "il faut donner le nouveau nom";
      return null;
    case "xlsx.supprimer_feuille":
      if (!c.feuille) return "il faut dire quelle feuille supprimer";
      return null;
    case "xlsx.inserer_image":
      // LA CELLULE est facultative — « mets le logo dans la feuille Ventes » se pose en A1, qui
      // est le coin que tout le monde regarde. Ce qui n'est PAS facultatif, c'est la source :
      // sans elle, il n'y a rien à poser.
      if (!c.imageSource) return "il faut dire QUELLE image insérer (le fichier source)";
      if (c.plage && !analyserPlage(c.plage)) return "la cellule d'ancrage doit être une référence valide (par exemple B2)";
      if (c.largeurCm !== null && c.largeurCm <= 0) return "la largeur doit être positive";
      if (c.hauteurCm !== null && c.hauteurCm <= 0) return "la hauteur doit être positive";
      return null;
    case "xlsx.remplacer_image":
      if (cibleVide(c.cible)) return "il faut dire QUELLE image remplacer (son rang, son nom, ou la cellule où elle est)";
      if (!c.imageSource) return "il faut dire par quelle image la remplacer (le fichier source)";
      return null;
    case "xlsx.supprimer_image":
      if (cibleVide(c.cible)) return "il faut dire QUELLE image supprimer (son rang, son nom, ou la cellule où elle est)";
      return null;

    // ── PPTX ────────────────────────────────────────────────────────────────────────────
    case "pptx.texte":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive (la première est la 1)";
      if (cibleVide(c.cible)) return "il faut dire QUELLE zone de texte";
      if (c.texte === null) return "il faut donner le texte";
      return null;
    case "pptx.format_texte":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive";
      if (cibleVide(c.cible)) return "il faut dire QUELLE forme";
      if (!auMoinsUnFormat(c)) return "aucune mise en forme demandée";
      return null;
    case "pptx.deplacer":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive";
      if (cibleVide(c.cible)) return "il faut dire QUELLE forme déplacer";
      if (c.dxCm === null && c.dyCm === null) return "il faut donner un déplacement";
      return null;
    case "pptx.position":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive";
      if (cibleVide(c.cible)) return "il faut dire QUELLE forme placer";
      if (c.xCm === null && c.yCm === null) return "il faut donner une position";
      return null;
    case "pptx.taille":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive";
      if (cibleVide(c.cible)) return "il faut dire QUELLE forme redimensionner";
      if (c.largeurCm === null && c.hauteurCm === null) return "il faut donner une taille";
      return null;
    case "pptx.supprimer_forme":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive";
      if (cibleVide(c.cible)) return "il faut dire QUELLE forme supprimer";
      return null;
    case "pptx.supprimer_diapo":
    case "pptx.dupliquer_diapo":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive (la première est la 1)";
      return null;
    case "pptx.deplacer_diapo":
      if (c.diapo === null || c.diapo < 1) return "il faut dire quelle diapositive déplacer";
      if (c.versIndex === null || c.versIndex < 1) return "il faut dire à quelle position la mettre (à partir de 1)";
      return null;
    case "pptx.ajouter_diapo":
      // `nom` = le titre de la nouvelle diapositive, `texte` = son contenu (une ligne par puce),
      // `diapo` = après laquelle (vide = à la fin), `position` = avant / apres.
      if (!c.nom && !c.texte) return "il faut donner au moins un titre (nom) ou un contenu (texte) à la nouvelle diapositive";
      if (c.diapo !== null && c.diapo < 1) return "la diapositive de référence se compte à partir de 1";
      if (c.position !== null && !POSITIONS.has(c.position)) return "position attendue : avant ou apres";
      return null;
    case "pptx.inserer_image":
      // La DIAPOSITIVE est obligatoire : « mets le logo » sur un deck de quarante pages ne dit
      // pas où. Le reste — position, taille — se déduit si on ne le donne pas.
      if (c.diapo === null || c.diapo < 1) return "il faut dire SUR QUELLE diapositive (1 = la première)";
      if (!c.imageSource) return "il faut dire QUELLE image insérer (le fichier source)";
      if (c.largeurCm !== null && c.largeurCm <= 0) return "la largeur doit être positive";
      if (c.hauteurCm !== null && c.hauteurCm <= 0) return "la hauteur doit être positive";
      return null;
    case "pptx.remplacer_image":
      if (c.diapo === null || c.diapo < 1) return "il faut dire SUR QUELLE diapositive (1 = la première)";
      if (cibleVide(c.cible)) return "il faut dire QUELLE image remplacer";
      if (!c.imageSource) return "il faut dire par quelle image la remplacer (le fichier source)";
      return null;

    // ── PDF ─────────────────────────────────────────────────────────────────────────────
    case "pdf.supprimer_pages":
    case "pdf.recadrer":
      return pagesValides(c.pages);
    case "pdf.pivoter": {
      const err = pagesValides(c.pages);
      if (err) return err;
      if (c.degres === null) return "il faut dire de combien de degrés pivoter";
      if (![90, 180, 270, -90, -180, -270].includes(c.degres)) return "rotation attendue : 90, 180 ou 270 degrés";
      return null;
    }
    case "pdf.reordonner":
      if (!c.ordre || c.ordre.length === 0) return "il faut donner le nouvel ordre des pages";
      if (c.ordre.some((p) => !Number.isInteger(p) || p < 1)) return "les pages se comptent à partir de 1";
      if (new Set(c.ordre).size !== c.ordre.length) return "le nouvel ordre contient deux fois la même page";
      return null;
    case "pdf.filigrane":
      if (!c.texte) return "il faut donner le texte du filigrane";
      return null;
    default:
      return `opération non implémentée « ${c.op} »`;
  }
}

/**
 * COMPILE un lot. Une commande refusée n'annule pas les autres : sur « centre le titre, réduis-le
 * à 16 et remonte le tableau », si la troisième est ambiguë, les deux premières doivent
 * s'appliquer et la troisième se redemander. Tout annuler ferait perdre à la personne deux
 * modifications correctes pour une hésitation.
 */
export function compilerCommandes(brut: CommandeArtefact[], format: ArtifactFormat): ResultatCompilation {
  const commandes: CommandeArtefact[] = [];
  const refus: RefusCommande[] = [];
  brut.forEach((c, i) => {
    const motif = verifierCommande(c, format);
    if (motif) refus.push({ index: i, op: c.op ?? "?", motif });
    else commandes.push(c);
  });
  return { ok: refus.length === 0, commandes, refus };
}
