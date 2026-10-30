/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DÉPOSER DES FICHIERS DANS LA CONVERSATION — les RÈGLES, sans un seul import lourd (navigateur
 * compris : `assistant-beta/` les lit).
 *
 * Direction, 29/10/2026 : « glisser-déposer des fichiers ET des dossiers sur la zone du chat ; chaque
 * fichier devient une puce ; rien n'est envoyé avant Entrée ». Ici : le PARCOURS récursif d'un dossier
 * déposé (sur des interfaces minimales — le navigateur passe ses `FileSystemEntry`, les bancs des
 * faux), les FICHIERS SYSTÈME ignorés, les BORNES d'un envoi (nombre, taille) et les PHRASES qui les
 * disent. Une limite n'est jamais silencieuse : un fichier écarté est nommé, avec sa raison.
 *
 * Décision 0015 : un fichier n'est TÉLÉVERSÉ qu'à l'envoi — une puce retirée avant ne laisse rien
 * dans le Drive.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { extensionDe, genreDe, nomAnnonceLeCoffre, OCTETS_MAX_LECTURE, PIECES_LUES_MAX, type GenrePiece } from "./regles";

/** Pièces au plus par message — la borne que le fil applique (`deposerMessage`, `piecesDuMessage`). */
export const PIECES_PAR_ENVOI_MAX = 10;
/** Taille au plus d'un fichier déposé : celle que la lecture accepte (au-delà, il ne serait pas lu). */
export const OCTETS_MAX_DEPOT = OCTETS_MAX_LECTURE;
/** Profondeur au plus d'un dossier parcouru (une boucle de liens ne fait pas tourner l'onglet). */
export const PROFONDEUR_MAX = 12;
/** Entrées au plus lues dans un dossier déposé : au-delà, le parcours s'arrête et le dit. */
export const ENTREES_MAX_PARCOURUES = 500;

const mo = (o: number) => `${(o / 1048576).toFixed(1).replace(".", ",")} Mo`;

/** « 1,2 Mo », « 340 ko », « 12 o » — la taille sous la puce. */
export function tailleLisible(octets: number): string {
  if (!Number.isFinite(octets) || octets < 0) return "";
  if (octets >= 1048576) return mo(octets);
  if (octets >= 1024) return `${Math.round(octets / 1024)} ko`;
  return `${octets} o`;
}

const SYSTEME = new Set(["thumbs.db", "desktop.ini", "ehthumbs.db", ".ds_store", "icon\r"]);
const DOSSIERS_SYSTEME = new Set(["__macosx", ".git", ".svn", "node_modules", "$recycle.bin", ".trash", ".trashes", ".spotlight-v100", ".fseventsd"]);

/**
 * Un fichier ou un dossier SYSTÈME (ou caché), jamais joint : `.DS_Store`, `Thumbs.db`, `desktop.ini`,
 * les fichiers de verrou d'Office (`~$rapport.docx`), tout nom commençant par un point, et ce qui vit
 * sous `__MACOSX/`, `.git/`…
 */
export function estFichierSysteme(chemin: string): boolean {
  const parties = chemin.split("/").filter(Boolean);
  if (!parties.length) return true;
  const nom = parties[parties.length - 1]!.toLowerCase();
  if (SYSTEME.has(nom) || nom.startsWith(".") || nom.startsWith("~$") || nom.startsWith("._")) return true;
  return parties.slice(0, -1).some((d) => DOSSIERS_SYSTEME.has(d.toLowerCase()) || d.startsWith("."));
}

// ─────────────────────────────── Le parcours d'un dossier déposé ───────────────────────────────

/** Le strict nécessaire d'un `FileSystemEntry` du navigateur (et d'un faux, dans les bancs). */
export interface EntreeDepot {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  /** Fichier : rend le `File` (ou ce qui en tient lieu). */
  fichier?: () => Promise<FichierDepot>;
  /** Dossier : rend ses entrées — tout le dossier, lot après lot (le navigateur les rend par 100). */
  lister?: () => Promise<EntreeDepot[]>;
}

/** Ce que l'écran garde d'un fichier : le chemin relatif, la taille, le type — et l'objet lui-même. */
export interface FichierDepot {
  name: string;
  size: number;
  type: string;
}

export interface FichierTrouve<F extends FichierDepot = FichierDepot> {
  chemin: string;
  fichier: F;
}

export interface Parcours<F extends FichierDepot = FichierDepot> {
  trouves: FichierTrouve<F>[];
  /** Fichiers système ou cachés laissés de côté (nombre). */
  ignores: number;
  /** Le parcours s'est arrêté avant la fin (trop d'entrées, trop profond) — à dire. */
  tronque: boolean;
}

/**
 * PARCOURT RÉCURSIVEMENT ce qui a été déposé — fichiers et dossiers mêlés — en gardant le CHEMIN
 * RELATIF (« Congrès Oran/devis/imprimeur.pdf »). Les fichiers et dossiers système sont ignorés
 * (comptés), la profondeur et le nombre d'entrées sont bornés. Une entrée illisible est sautée.
 */
export async function parcourirDepot<F extends FichierDepot>(racines: EntreeDepot[], max = ENTREES_MAX_PARCOURUES): Promise<Parcours<F>> {
  const out: Parcours<F> = { trouves: [], ignores: 0, tronque: false };
  let vues = 0;
  const visiter = async (e: EntreeDepot, prefixe: string, profondeur: number): Promise<void> => {
    if (vues >= max) { out.tronque = true; return; }
    vues++;
    const chemin = prefixe ? `${prefixe}/${e.name}` : e.name;
    if (estFichierSysteme(chemin)) { out.ignores++; return; }
    if (e.isFile && e.fichier) {
      try { out.trouves.push({ chemin, fichier: (await e.fichier()) as F }); } catch { /* illisible : sauté */ }
      return;
    }
    if (e.isDirectory && e.lister) {
      if (profondeur >= PROFONDEUR_MAX) { out.tronque = true; return; }
      let enfants: EntreeDepot[] = [];
      try { enfants = await e.lister(); } catch { return; }
      enfants.sort((a, b) => a.name.localeCompare(b.name, "fr"));
      for (const c of enfants) await visiter(c, chemin, profondeur + 1);
    }
  };
  for (const r of racines) await visiter(r, "", 0);
  return out;
}

// ─────────────────────────────── Les bornes d'un envoi ───────────────────────────────

export interface PieceAPlanifier {
  chemin: string;
  taille: number;
}

export interface Refus {
  chemin: string;
  raison: string;
}

export const raisonTropGros = (taille: number) =>
  `${mo(taille)} : au-delà de ${mo(OCTETS_MAX_DEPOT)}, un fichier n'est pas joint à la conversation (déposez-le dans le Drive).`;
export const raisonTropNombreux = () =>
  `${PIECES_PAR_ENVOI_MAX} pièces au plus par message : envoyez celles-ci, puis le reste dans un second message.`;
export const RAISON_VIDE = "fichier vide (0 octet).";
export const RAISON_DOUBLON = "déjà dans les pièces de ce message.";

/**
 * ACCEPTE OU REFUSE chaque nouveau fichier, dans l'ordre : vide, trop gros, doublon (même chemin et
 * même taille qu'une puce déjà là), puis le nombre au plus par message (`dejaLa` puces comptées).
 */
export function planifierDepot<T extends PieceAPlanifier>(dejaLa: PieceAPlanifier[], nouveaux: T[]): { acceptes: T[]; refus: Refus[] } {
  const acceptes: T[] = [];
  const refus: Refus[] = [];
  const cles = new Set(dejaLa.map((p) => `${p.chemin}\u0000${p.taille}`));
  let place = PIECES_PAR_ENVOI_MAX - dejaLa.length;
  for (const n of nouveaux) {
    const cle = `${n.chemin}\u0000${n.taille}`;
    if (n.taille === 0) refus.push({ chemin: n.chemin, raison: RAISON_VIDE });
    else if (n.taille > OCTETS_MAX_DEPOT) refus.push({ chemin: n.chemin, raison: raisonTropGros(n.taille) });
    else if (cles.has(cle)) refus.push({ chemin: n.chemin, raison: RAISON_DOUBLON });
    else if (place <= 0) refus.push({ chemin: n.chemin, raison: raisonTropNombreux() });
    else { acceptes.push(n); cles.add(cle); place--; }
  }
  return { acceptes, refus };
}

/** La phrase qui résume les refus d'un dépôt (aria-live) — chaque fichier nommé, jusqu'à 4. */
export function phraseRefus(refus: Refus[], ignores = 0, tronque = false, max = ENTREES_MAX_PARCOURUES): string | null {
  const parties: string[] = [];
  if (refus.length) {
    const vus = refus.slice(0, 4).map((r) => `« ${dernier(r.chemin)} » : ${r.raison}`);
    parties.push(`${refus.length} fichier${refus.length > 1 ? "s" : ""} non joint${refus.length > 1 ? "s" : ""} — ${vus.join(" ; ")}${refus.length > 4 ? ` ; et ${refus.length - 4} autre${refus.length - 4 > 1 ? "s" : ""}` : ""}`);
  }
  if (ignores) parties.push(`${ignores} fichier${ignores > 1 ? "s" : ""} système ou caché${ignores > 1 ? "s" : ""} ignoré${ignores > 1 ? "s" : ""} (.DS_Store, Thumbs.db…)`);
  if (tronque) parties.push(`dossier trop grand ou trop profond : parcours arrêté après ${max.toLocaleString("fr-FR")} entrées`);
  return parties.length ? `${parties.join(". ")}.` : null;
}

/**
 * Au-delà de `PIECES_LUES_MAX` pièces, les suivantes sont JOINTES et rangées dans le Drive mais pas
 * lues : l'écran le dit AVANT l'envoi (la lecture le redit ensuite sous chaque pièce).
 */
export function phraseLecturePartielle(nombre: number): string | null {
  if (nombre <= PIECES_LUES_MAX) return null;
  return `${nombre} pièces : les ${PIECES_LUES_MAX} premières seront lues par l'assistant ; les ${nombre - PIECES_LUES_MAX} autres seront jointes et rangées dans votre Drive, sans être lues.`;
}

/** Une pièce dont le NOM annonce le coffre (passeport, RIB, paie) : jointe, jamais lue — dit sur la puce. */
export const AVERTISSEMENT_COFFRE = "Nom de pièce du coffre (passeport, RIB, paie…) : elle sera jointe mais pas lue.";
export const avertissementPiece = (chemin: string): string | null => (nomAnnonceLeCoffre(dernier(chemin)) ? AVERTISSEMENT_COFFRE : null);

export const dernier = (chemin: string): string => chemin.split("/").filter(Boolean).pop() ?? chemin;

// ─────────────────────────────── Les puces et leur sélection ───────────────────────────────

/** Retire les puces désignées ; rend aussi celles retirées (l'écran peut les annoncer). */
export function retirerPieces<T extends { cle: string }>(pieces: T[], cles: Iterable<string>): { restantes: T[]; retirees: T[] } {
  const a = new Set(cles);
  return { restantes: pieces.filter((p) => !a.has(p.cle)), retirees: pieces.filter((p) => a.has(p.cle)) };
}

/** La famille d'icône d'une puce (l'écran choisit le dessin). */
export type FamilleIcone = "image" | "pdf" | "word" | "tableur" | "presentation" | "audio" | "video" | "archive" | "texte" | "autre";

export function familleIcone(nom: string, mime?: string | null): FamilleIcone {
  const e = extensionDe(nom);
  if (["doc", "docx", "odt", "rtf", "dotx"].includes(e)) return "word";
  if (["xls", "xlsx", "xlsm", "ods", "csv", "tsv"].includes(e)) return "tableur";
  if (["ppt", "pptx", "odp", "potx", "ppsx"].includes(e)) return "presentation";
  if (["zip", "rar", "7z", "tar", "gz"].includes(e)) return "archive";
  if (["svg", "bmp", "heic", "avif", "tif", "tiff"].includes(e)) return "image";
  const g: GenrePiece = genreDe(nom, mime);
  if (g === "image" || g === "pdf" || g === "audio" || g === "video" || g === "texte") return g;
  if (g === "presentation") return "presentation";
  return "autre";
}

/** Une image que le navigateur sait montrer en miniature (sans rien téléverser). */
export const miniaturePossible = (nom: string, mime?: string | null): boolean =>
  /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test((mime ?? "").toLowerCase()) || ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(extensionDe(nom));

// ─────────────────────────────── Les pièces de la conversation ───────────────────────────────

const RE_LIEN_DRIVE = /\/drive\/(c[a-z0-9]{20,})(?![a-z0-9])/g;

/**
 * Les pièces que l'ASSISTANT a renvoyées : les fichiers du Drive cités par son lien (`/drive/<id>`)
 * — dans le résultat d'une action exécutée (document créé, traduction, formulaire rempli) ou dans
 * le texte de la réponse. Sans doublon, dans l'ordre.
 */
export function idsDriveCites(...textes: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of textes) {
    if (!t) continue;
    for (const m of t.matchAll(RE_LIEN_DRIVE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * Un format que l'Atelier sait modifier EN PLACE (J3, décision 0017) : Word, PowerPoint, Excel (le fichier
 * d'origine, styles et mise en page conservés) et PDF (par pages : supprimer, pivoter, filigrane). Les
 * anciens formats (`.doc`, `.ppt`, `.odt`…) ne s'ouvrent pas en place : `null`, l'assistant le dit.
 */
export type Modifiable = "word" | "presentation" | "tableur" | "pdf" | null;
export function modifiable(nom: string): Modifiable {
  const e = extensionDe(nom);
  if (e === "docx") return "word";
  if (e === "pptx") return "presentation";
  if (e === "xlsx" || e === "xlsm") return "tableur";
  if (e === "pdf") return "pdf";
  return null;
}

/**
 * Le texte que « Demander une modification » pose dans la saisie — la personne le complète. La modification se
 * fait EN PLACE dans l'Atelier (jamais recomposée) ; rien n'est enregistré sans elle, et l'enregistrement crée
 * une NOUVELLE version (jamais d'écrasement).
 */
export function texteDemandeModification(nom: string): string {
  return `Modifie « ${dernier(nom)} » directement dans l'Atelier (sur le fichier d'origine, en gardant sa mise en page) : `;
}
