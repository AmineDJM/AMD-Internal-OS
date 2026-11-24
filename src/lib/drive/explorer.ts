/**
 * LE DRIVE COMME UN EXPLORATEUR DE FICHIERS.
 *
 * Personne n'a appris à se servir de l'explorateur Windows : on le sait, c'est tout. Un volet de
 * navigation à gauche, une liste à droite, des colonnes qu'on trie en cliquant sur leur titre, un
 * accès rapide aux récents. Reproduire ces habitudes coûte moins cher que d'en enseigner d'autres,
 * et surtout : un fichier qu'on ne retrouve pas est un fichier perdu, quel que soit le soin mis à
 * le stocker.
 *
 * Ce module porte ce que l'écran ne doit pas réinventer : le TYPE lisible d'un fichier, sa taille
 * écrite comme Windows l'écrit, et le tri des colonnes — dossiers toujours en tête, comme partout.
 *
 * Module PUR — testé.
 */

/** Une entrée de la liste, réduite à ce qui sert à trier et à afficher. */
export interface ExplorerRow {
  id: string;
  name: string;
  isFile: boolean;
  /** Taille en octets (0 pour un dossier). */
  size: number;
  /** Date de dernière modification, en ISO. */
  updatedAt: string;
  mimeType?: string | null;
}

export type SortKey = "name" | "updatedAt" | "type" | "size";
export type SortDir = "asc" | "desc";

/**
 * Le TYPE d'un fichier, écrit comme un explorateur l'écrit — « Document PDF », pas
 * « application/pdf ». Un type MIME ne renseigne personne : c'est une information de protocole,
 * pas une information d'utilisateur.
 */
const BY_EXTENSION: { ext: string[]; label: string }[] = [
  { ext: ["pdf"], label: "Document PDF" },
  { ext: ["doc", "docx", "odt", "rtf"], label: "Document Word" },
  { ext: ["xls", "xlsx", "ods", "csv"], label: "Feuille de calcul" },
  { ext: ["ppt", "pptx", "odp"], label: "Présentation" },
  { ext: ["zip", "rar", "7z", "tar", "gz"], label: "Dossier compressé" },
  { ext: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"], label: "Image" },
  { ext: ["mp4", "mov", "avi", "mkv", "webm"], label: "Vidéo" },
  { ext: ["mp3", "wav", "m4a", "ogg", "flac"], label: "Fichier audio" },
  { ext: ["txt", "md", "log"], label: "Document texte" },
  { ext: ["json", "xml", "yml", "yaml"], label: "Fichier de données" },
  { ext: ["eml", "msg"], label: "Message électronique" },
];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileTypeLabel(name: string, isFile: boolean): string {
  if (!isFile) return "Dossier de fichiers";
  const ext = extensionOf(name);
  if (!ext) return "Fichier";
  const found = BY_EXTENSION.find((e) => e.ext.includes(ext));
  // À défaut d'un type connu, on nomme l'extension — « Fichier DWG » reste plus utile que « Fichier ».
  return found ? found.label : `Fichier ${ext.toUpperCase()}`;
}

/** Taille écrite comme un explorateur l'écrit : entière, en kilo-octets dès qu'on dépasse l'octet. */
export function explorerSize(bytes: number, isFile: boolean): string {
  if (!isFile) return "";
  if (bytes <= 0) return "0 Ko";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  // Sous le kilo-octet, l'explorateur affiche quand même « 1 Ko » : un fichier n'occupe jamais
  // moins d'un bloc, et « 312 o » n'apprend rien à personne.
  if (i === 0) return "1 Ko";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * LE TRI. Deux règles, et la première ne se discute pas : **les dossiers d'abord**, toujours,
 * quel que soit le sens du tri. C'est vrai dans tous les explorateurs, et l'inverse donne une
 * liste où l'on ne retrouve plus l'arborescence.
 *
 * Le tri par nom respecte l'ordre naturel (« Fichier 2 » avant « Fichier 10 ») : l'ordre
 * alphabétique brut place le 10 avant le 2, ce qui n'a de sens pour personne.
 */
export function sortRows<T extends ExplorerRow>(rows: readonly T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
  return [...rows].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // dossiers en tête, dans les deux sens
    switch (key) {
      case "updatedAt": return sign * a.updatedAt.localeCompare(b.updatedAt);
      case "size": return sign * (a.size - b.size);
      case "type": {
        const cmp = collator.compare(fileTypeLabel(a.name, a.isFile), fileTypeLabel(b.name, b.isFile));
        return sign * (cmp !== 0 ? cmp : collator.compare(a.name, b.name));
      }
      default: return sign * collator.compare(a.name, b.name);
    }
  });
}

/** Les entrées du volet de navigation — la colonne de gauche d'un explorateur. */
export interface NavEntry {
  key: string;
  label: string;
  icon: string;
  href: string;
}

/**
 * L'ACCÈS RAPIDE — et UN SEUL NOM pour l'espace personnel.
 *
 * Il en portait quatre (« Téléchargements », « Mes fichiers », « Racine (Drive) », « Drive » —
 * audit Drive du 24/11, C6) : quatre mots pour un seul endroit, et l'on cherchait son fichier au
 * mauvais. Partout, il s'appelle désormais « Mes fichiers » (`MES_FICHIERS`).
 */
export const MES_FICHIERS = "Mes fichiers";

export const QUICK_ACCESS: NavEntry[] = [
  { key: "recent", label: "Récents", icon: "Clock", href: "/drive?view=recent" },
  { key: "root", label: MES_FICHIERS, icon: "HardDrive", href: "/drive" },
];

export const TRASH_ENTRY: NavEntry = { key: "trash", label: "Corbeille", icon: "Trash2", href: "/drive?trash=1" };

export type ExplorerView = "browse" | "recent" | "trash";

/** La vue demandée, validée : une valeur inconnue retombe sur la navigation normale. */
export function parseView(raw: string | undefined, trash: boolean): ExplorerView {
  if (trash) return "trash";
  return raw === "recent" ? "recent" : "browse";
}

export const VIEW_TITLE: Record<ExplorerView, string> = {
  browse: MES_FICHIERS,
  recent: "Récents",
  trash: "Corbeille",
};
