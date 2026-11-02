/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARTIFACT COMMAND IR (§8) — la seule chose qu'un modèle a le droit de produire.
 *
 * ── LA LIGNE QUI NE SE FRANCHIT PAS (§9) ────────────────────────────────────────────────
 *
 * « Les modèles décident QUOI. Le code décide COMMENT. » Un modèle ne voit JAMAIS d'XML, ne
 * produit JAMAIS d'OOXML, ne touche JAMAIS un octet de PDF. Il produit une COMMANDE — un objet
 * plat, typé, borné — et un adaptateur déterministe la traduit en manipulation de fichier.
 *
 * La raison n'est pas esthétique. Un modèle qui écrirait du `w:jc w:val="center"` se tromperait
 * un jour sur l'ordre des enfants de `w:pPr`, et le fichier s'ouvrirait « corrompu » chez un
 * client, une fois sur cinquante, sans que rien ne l'ait signalé. Avec une commande, l'erreur
 * possible est « mauvaise cible » — visible, réversible, et rattrapée par le compilateur.
 *
 * ── POURQUOI UN OBJET PLAT PLUTÔT QU'UNE UNION IMBRIQUÉE ────────────────────────────────
 *
 * Les sorties structurées STRICTES exigent `additionalProperties:false` et un `required` qui
 * liste TOUTES les propriétés — une union discriminée à quarante formes différentes y devient
 * un schéma illisible que les modèles remplissent mal. Un objet plat où tout est nullable
 * s'exprime en un schéma simple ; c'est ensuite `compile.ts` qui REFUSE une commande dont les
 * champs obligatoires pour son `op` manquent. Le contrôle n'est pas perdu : il est déplacé du
 * schéma vers un compilateur qui a le droit d'expliquer POURQUOI il refuse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";

/**
 * COMMENT ON DÉSIGNE UNE CHOSE (§11).
 *
 * Quatre voies, essayées DANS CET ORDRE par le résolveur :
 *   `id`        — l'identifiant stable rendu par `inspect`. Sans ambiguïté ; c'est ce que
 *                 renvoie un clic dans le workspace, et ce que réutilise « encore un peu ».
 *   `index`     — le rang HUMAIN, 1-indexé : « le troisième paragraphe ».
 *   `contient`  — un fragment de texte : « le paragraphe qui parle de la rémunération ».
 *   `role`      — `titre` | `premier` | `dernier`.
 */
export interface Cible {
  id: string | null;
  index: number | null;
  contient: string | null;
  role: string | null;
  /**
   * La PAGE où chercher (1 = la première) — « le troisième paragraphe de la page 12 ». Quand
   * elle est donnée, `index` se compte À L'INTÉRIEUR de la page, et `contient` n'y cherche que
   * là. C'est ce qui rend un document de 300 pages adressable sans en réciter les 6 000
   * paragraphes. Pour un Word, la page vient de la dernière pagination enregistrée ou d'une
   * estimation (`DocxModel.paginationSource`).
   */
  page?: number | null;
  /**
   * LE MOT visé À L'INTÉRIEUR de la cible, 1-indexé — « uniquement le troisième mot en Arial 10 ».
   *
   * C'est ce qui distingue une édition de PRÉCISION d'une mise en forme de paragraphe : sans
   * lui, « le troisième mot en Arial » repeint les quarante mots du paragraphe, et la personne
   * ne s'en aperçoit qu'en relisant. Un nombre négatif compte depuis la fin (-1 = le dernier).
   */
  mot?: number | null;
}

export const CIBLE_VIDE: Cible = { id: null, index: null, contient: null, role: null, page: null, mot: null };
export const ciblePage = (page: number, reste: Partial<Cible> = {}): Cible => ({ ...CIBLE_VIDE, ...reste, page });

export const cibleId = (id: string): Cible => ({ ...CIBLE_VIDE, id });
export const cibleIndex = (index: number): Cible => ({ ...CIBLE_VIDE, index });
export const cibleTexte = (contient: string): Cible => ({ ...CIBLE_VIDE, contient });
export const cibleRole = (role: "titre" | "premier" | "dernier"): Cible => ({ ...CIBLE_VIDE, role });

export const cibleVide = (c: Cible | null | undefined): boolean =>
  !c || (c.id === null && c.index === null && c.contient === null && c.role === null && (c.page === null || c.page === undefined));

/** Les opérations reconnues, par format. Une opération absente d'ici n'existe pas. */
export const OPS_DOCX = [
  "docx.align",
  "docx.format_texte",
  "docx.espacement",
  "docx.retrait",
  "docx.texte",
  "docx.inserer_paragraphe",
  "docx.supprimer_paragraphe",
  "docx.deplacer",
  "docx.remplacer_texte",
  "docx.cellule",
  "docx.inserer_ligne",
  "docx.supprimer_ligne",
  "docx.image_taille",
  "docx.supprimer_image",
  /**
   * INSÉRER UNE IMAGE, et REMPLACER celle qui est là.
   *
   * Deux opérations et non une, parce que ce ne sont pas les mêmes gestes : insérer ajoute un
   * paragraphe, remplacer garde la place, la taille et l'habillage de l'image existante — ce
   * qu'on veut quand on dit « remplace le logo ». Les fondre obligerait à supprimer puis
   * réinsérer, donc à perdre la mise en page que quelqu'un avait réglée.
   */
  "docx.inserer_image",
  "docx.remplacer_image",
  /**
   * L'INTERLIGNE — « augmente l'interligne de ce paragraphe », « interligne 1,5 ».
   * Distinct de `docx.espacement`, qui règle l'air AUTOUR du paragraphe (avant / après) :
   * ici c'est l'air ENTRE ses lignes. Les confondre donne un paragraphe qui s'éloigne du
   * précédent alors qu'on voulait l'aérer lui-même.
   */
  "docx.interligne",
  /** La bordure d'UNE cellule — « change seulement la bordure de cette cellule ». */
  "docx.cellule_bordure",
  /**
   * INSÉRER UN TABLEAU (Atelier, J3) — `texte` porte les lignes (une par ligne, cellules séparées par « | »),
   * la première est l'en-tête ; `cible` + `position` disent où (sans cible : à la fin du document).
   */
  "docx.inserer_tableau",
] as const;

export const OPS_XLSX = [
  "xlsx.valeur",
  "xlsx.formule",
  "xlsx.format",
  "xlsx.largeur_colonne",
  "xlsx.inserer_ligne",
  "xlsx.supprimer_ligne",
  "xlsx.inserer_colonne",
  "xlsx.supprimer_colonne",
  "xlsx.figer",
  "xlsx.fusionner",
  "xlsx.trier",
  /** La bordure d'une cellule ou d'une plage — sans toucher au reste de son style. */
  "xlsx.bordure",
  "xlsx.ajouter_feuille",
  "xlsx.renommer_feuille",
  "xlsx.supprimer_feuille",
  /**
   * Poser une image sur une feuille, remplacer celle qui y est, la retirer. `plage` porte la
   * CELLULE d'ancrage (« B2 ») : dans un classeur, une image se pose sur une cellule, pas à un
   * rang de paragraphe.
   */
  "xlsx.inserer_image",
  "xlsx.remplacer_image",
  "xlsx.supprimer_image",
] as const;

export const OPS_PPTX = [
  "pptx.texte",
  "pptx.format_texte",
  "pptx.deplacer",
  "pptx.position",
  "pptx.taille",
  "pptx.supprimer_forme",
  "pptx.supprimer_diapo",
  "pptx.deplacer_diapo",
  "pptx.dupliquer_diapo",
  "pptx.ajouter_diapo",
  /** Poser une image sur une diapositive, et remplacer celle qui y est (même famille que Word). */
  "pptx.inserer_image",
  "pptx.remplacer_image",
] as const;

export const OPS_PDF = [
  "pdf.supprimer_pages",
  "pdf.reordonner",
  "pdf.pivoter",
  "pdf.filigrane",
  "pdf.recadrer",
] as const;

export const OPS = [...OPS_DOCX, ...OPS_XLSX, ...OPS_PPTX, ...OPS_PDF] as const;

export const OPS_PAR_FORMAT: Record<ArtifactFormat, readonly string[]> = {
  DOCX: OPS_DOCX,
  XLSX: OPS_XLSX,
  PPTX: OPS_PPTX,
  PDF: OPS_PDF,
};

/**
 * UNE COMMANDE. Tout est nullable sauf `op` ; `compile.ts` exige ensuite ce qu'il faut.
 *
 * Les unités sont celles dans lesquelles un humain PARLE : des points pour une police, des
 * centimètres pour une position, des degrés pour une rotation. Les EMU, twips et demi-points
 * de l'OOXML ne remontent jamais jusqu'ici.
 */
export interface CommandeArtefact {
  op: string;

  /** L'objet visé (paragraphe, tableau, forme, image). */
  cible: Cible | null;
  /** Second objet, pour les opérations qui en prennent deux (cellule d'un tableau visé). */
  cible2: Cible | null;

  // Mise en forme du texte — `null` = « ne touche pas à ça ».
  alignement: string | null;
  gras: boolean | null;
  italique: boolean | null;
  souligne: boolean | null;
  taillePt: number | null;
  police: string | null;
  couleur: string | null;

  // Géométrie, en centimètres.
  xCm: number | null;
  yCm: number | null;
  dxCm: number | null;
  dyCm: number | null;
  largeurCm: number | null;
  hauteurCm: number | null;
  avantPt: number | null;
  apresPt: number | null;
  /** L'interligne, en MULTIPLES de la ligne : 1 = simple, 1,5, 2 = double. */
  interligne: number | null;
  /** Les côtés à border : « haut », « bas », « gauche », « droite », « contour », « tout », « aucun ». */
  bordure: string | null;
  /** Le style du trait : « fin », « epais », « double », « pointille ». */
  bordureStyle: string | null;
  gaucheCm: number | null;
  droiteCm: number | null;

  // Contenus.
  texte: string | null;
  chercher: string | null;
  remplacer: string | null;
  formule: string | null;
  formatNombre: string | null;
  remplissage: string | null;

  // Adressage tabulaire et paginé — TOUJOURS 1-indexé (§17).
  feuille: string | null;
  plage: string | null;
  ligne: number | null;
  colonne: number | null;
  pages: number[] | null;
  ordre: number[] | null;
  diapo: number | null;
  versIndex: number | null;

  /**
   * LA SOURCE D'UNE IMAGE — une RÉFÉRENCE, jamais les octets (§104.3).
   *
   * L'état d'un document est un REJEU : les commandes sont journalisées et rejouées à chaque
   * ouverture. Y mettre les octets d'une image ferait un journal de plusieurs mégaoctets par
   * insertion, rejoué à chaque fois. La commande porte donc l'identifiant du fichier source ;
   * c'est le MOTEUR qui en résout les octets, à travers le port — donc sous les droits de la
   * personne, à chaque application comme à chaque rejeu.
   */
  imageSource: string | null;
  /** Le texte de remplacement (accessibilité) — ce que Word appelle « description ». */
  imageAlt: string | null;

  // Divers.
  position: string | null;
  direction: string | null;
  pas: number | null;
  degres: number | null;
  opacite: number | null;
  tout: boolean | null;
  nom: string | null;
}

/** Gabarit d'une commande — sert à en construire une sans énumérer trente `null`. */
export const COMMANDE_VIDE: Omit<CommandeArtefact, "op"> = {
  cible: null, cible2: null,
  alignement: null, gras: null, italique: null, souligne: null, taillePt: null, police: null, couleur: null,
  xCm: null, yCm: null, dxCm: null, dyCm: null, largeurCm: null, hauteurCm: null,
  avantPt: null, apresPt: null, interligne: null, bordure: null, bordureStyle: null, gaucheCm: null, droiteCm: null,
  texte: null, chercher: null, remplacer: null, formule: null, formatNombre: null, remplissage: null,
  feuille: null, plage: null, ligne: null, colonne: null, pages: null, ordre: null, diapo: null, versIndex: null,
  imageSource: null, imageAlt: null,
  position: null, direction: null, pas: null, degres: null, opacite: null, tout: null, nom: null,
};

export function commande(op: string, champs: Partial<CommandeArtefact> = {}): CommandeArtefact {
  return { ...COMMANDE_VIDE, op, ...champs };
}
