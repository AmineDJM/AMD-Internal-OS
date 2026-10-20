/**
 * LE MENU « ⋯ » D'UN FICHIER DU DRIVE — quelles entrées, dans quel ordre, pour qui.
 *
 * Trois icônes à côté de chaque nom (Partage, Commentaires, ⋯), dans la liste ET dans le fichier ouvert : le
 * même composant les rend aux deux endroits, et c'est ICI que se décide ce qu'il montre. Une règle écrite dans
 * l'écran se perd à la première variante (« dans la corbeille », « sur un dossier », « fichier ouvert ») ; écrite
 * ici, elle se teste.
 *
 * Les droits ne se jugent pas ici : `canEdit` vient du serveur (`resolveDriveAccess`), et chaque action serveur
 * revérifie. Ce module ne fait que ne pas PROPOSER ce qui serait refusé.
 *
 * Module PUR — sans import, testé.
 */

export type EntreeMenu =
  | "pdf" | "version" | "historique" | "telecharger" | "renommer" | "deplacer" | "messagerie"
  | "legal" | "courrier" | "champs" | "plein-ecran" | "corbeille" | "restaurer" | "supprimer";

export interface ContexteMenu {
  isFile: boolean;
  /** Droit de modifier CE nœud. */
  canEdit: boolean;
  /** Vue de la corbeille. */
  trash: boolean;
  /** Format Office + convertisseur configuré + droit de créer dans le Drive. */
  convertible: boolean;
  /** Au moins un dossier de destination proposé. */
  peutDeplacer: boolean;
  /** Le fichier est OUVERT (barre du haut), pas une ligne de liste. */
  ouvert: boolean;
  /** Des champs personnalisés existent pour les fichiers du Drive. */
  champs: boolean;
}

/**
 * Les entrées, en GROUPES (un trait les sépare). La corbeille est toujours seule, en dernier : c'est le
 * geste qu'on ne doit pas faire par erreur en visant l'entrée du dessus.
 */
export function entreesMenu(c: ContexteMenu): EntreeMenu[][] {
  if (c.trash) return c.canEdit ? [["restaurer"], ["supprimer"]] : [];
  const fichier: EntreeMenu[] = [];
  if (c.isFile && c.convertible) fichier.push("pdf");
  if (c.isFile && c.canEdit) fichier.push("version");
  if (c.isFile) fichier.push("historique");
  const courant: EntreeMenu[] = ["telecharger"];
  if (c.canEdit) courant.push("renommer");
  if (c.canEdit && c.peutDeplacer) courant.push("deplacer");
  courant.push("messagerie");
  if (c.canEdit && c.isFile) courant.push("legal", "courrier");
  const ecran: EntreeMenu[] = [];
  if (c.ouvert && c.champs) ecran.push("champs");
  if (c.ouvert) ecran.push("plein-ecran");
  return [fichier, courant, ecran, c.canEdit ? ["corbeille" as const] : []].filter((g) => g.length > 0);
}

/** Les deux icônes à côté du « ⋯ ». Un dossier n'a pas de fil de commentaires ; la corbeille, ni l'un ni l'autre. */
export function iconesLigne(c: { isFile: boolean; trash: boolean }): { partage: boolean; commentaires: boolean } {
  return { partage: !c.trash, commentaires: !c.trash && c.isFile };
}

/** « Privé », « 1 personne », « 4 personnes » — la ligne « Partage » de l'en-tête du menu. */
export function libellePartage(n: number): string {
  if (n <= 0) return "Privé";
  return n === 1 ? "1 personne" : `${n} personnes`;
}

/** Le pastillage du compteur de commentaires : au-delà de 99, on n'écrit plus le nombre exact. */
export function pastilleCompteur(n: number): string | null {
  if (n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}

/**
 * OÙ REVENIR quand on quitte un fichier ouvert (ou qu'on vient de le mettre à la corbeille) : son dossier,
 * sinon la racine de sa catégorie, sinon le Drive personnel.
 */
export function dossierDuFichier(n: { parentId: string | null; spaceId: string | null }): string {
  if (n.parentId) return n.spaceId ? `/drive/espace/${n.spaceId}?folder=${n.parentId}` : `/drive?folder=${n.parentId}`;
  return n.spaceId ? `/drive/espace/${n.spaceId}` : "/drive";
}
