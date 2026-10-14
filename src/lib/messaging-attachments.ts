/**
 * LES PIÈCES JOINTES DE LA MESSAGERIE — deux natures, et la différence compte.
 *
 * • **Un fichier TÉLÉVERSÉ** : le contenu part dans le message. C'est une copie, figée à l'instant
 *   de l'envoi. Parfait pour un scan, une photo, une pièce qui n'existe nulle part ailleurs.
 *
 * • **Une RÉFÉRENCE au Drive** : rien n'est recopié. Le message pointe vers le nœud, et les
 *   destinataires reçoivent un accès en LECTURE. C'est la bonne façon d'envoyer un document de
 *   travail : recopier un contrat de 40 Mo à chaque conversation, c'est multiplier le stockage
 *   par le nombre d'envois, et surtout FIGER une version — six mois plus tard, cinq personnes
 *   travaillent sur cinq copies différentes et personne ne sait laquelle fait foi.
 *
 * Un DOSSIER se référence comme un fichier : une liasse (l'original, ses annexes, le ZIP du
 * fournisseur) s'envoie d'un geste, et n'accepter que des fichiers obligerait à choisir lequel
 * des cinq « fait foi ».
 *
 * Module PUR — testé, sans base de données, importable côté serveur comme côté client.
 * (Sa seule importation, la table des aperçus, est elle-même un module pur sans importation.)
 */

import { extensionDe, natureApercu } from "@/lib/formats/apercu";

/** Au-delà, ce n'est plus un message : c'est un envoi de fichiers déguisé. */
export const MAX_ATTACHMENTS = 10;

export interface DriveRefInput {
  id: string;
  name: string;
  isFolder: boolean;
}

/**
 * Ce que le destinataire lit à la place du nom brut.
 *
 * La mention « Drive » n'est pas décorative : elle dit que le fichier n'est PAS une copie reçue
 * mais le document lui-même, celui qui bougera si son auteur le corrige. Sans elle, on croit
 * avoir reçu une pièce jointe et on la re-téléverse ailleurs.
 */
export function driveRefLabel(name: string, isFolder: boolean): string {
  return isFolder ? `Dossier « ${name} » — Drive` : `${name} — Drive`;
}

/** Où mène « Ouvrir dans le Drive » : la page du fichier, ou le dossier qui se navigue. */
export function driveRefHref(nodeId: string, isFolder: boolean): string {
  return isFolder ? `/drive?folder=${nodeId}` : `/drive/${nodeId}`;
}

// ─────────────────────────── Ouvrir une pièce SANS quitter la conversation ───────────────────────────

/**
 * OUVRIR, REGARDER, FERMER — « je dois juste pouvoir ouvrir et fermer l'image » (Direction, 14/10).
 *
 * Un clic sur « Capture PJ.png — Fichier du Drive » emmenait sur la page Drive du fichier (Nouvelle
 * version, Renommer, Corbeille, Partage…) : on quittait la conversation pour regarder une capture.
 * Désormais la pièce s'ouvre EN SURIMPRESSION au-dessus de la conversation, et se referme d'un geste.
 *
 *   image           → la visionneuse plein écran (←/→ entre les images du même message) ;
 *   apercu          → PDF, Word, Excel, PowerPoint, texte, vidéo… dans l'aperçu universel, même panneau ;
 *   dossier         → un dossier se NAVIGUE : il reste une page du Drive ;
 *   telechargement  → archive, binaire : rien à montrer, le fichier se télécharge.
 */
export type OuverturePiece = "image" | "apercu" | "dossier" | "telechargement";

/** Ce qu'il faut d'une pièce jointe pour savoir comment l'ouvrir — un sous-ensemble du DTO. */
export interface PieceOuvrable {
  id: string;
  name: string;
  mime: string;
  /** Référence au Drive (rien de recopié) — null pour un fichier téléversé dans le message. */
  driveNodeId: string | null;
  isFolder: boolean;
}

/**
 * Les images qu'un navigateur AFFICHE. Une photo HEIC d'iPhone ou un TIFF de scanner sont bien des
 * « image/* », mais `<img>` les montre en cadre vide : mieux vaut les traiter comme des fichiers.
 */
const IMAGES_NON_AFFICHABLES = new Set(["tif", "tiff", "heic", "heif", "psd", "raw", "cr2", "nef", "dng"]);
const MIMES_NON_AFFICHABLES = /^image\/(tiff|x-tiff|heic|heif|heic-sequence|heif-sequence|vnd\.adobe\.photoshop|x-canon-cr2|x-nikon-nef|x-adobe-dng)$/i;

/** Cette pièce est-elle une image que le navigateur sait montrer (PNG, JPEG, GIF, WebP, SVG…) ? */
export function estImageAffichable(nom: string, mime?: string | null): boolean {
  if (IMAGES_NON_AFFICHABLES.has(extensionDe(nom))) return false;
  if (MIMES_NON_AFFICHABLES.test((mime ?? "").trim())) return false;
  return natureApercu(nom, (mime ?? "").trim()) === "image";
}

/** Comment s'ouvre une pièce jointe au clic. */
export function ouverturePiece(p: Pick<PieceOuvrable, "name" | "mime" | "isFolder">): OuverturePiece {
  if (p.isFolder) return "dossier";
  if (estImageAffichable(p.name, p.mime)) return "image";
  const n = natureApercu(p.name, p.mime);
  return n === "zip" || n === "autre" ? "telechargement" : "apercu";
}

/**
 * L'ADRESSE DU CONTENU d'une pièce — toujours par LA porte de la messagerie.
 *
 * `/api/messaging/attachment/<id>` vérifie d'abord qu'on est PARTICIPANT ACTIF de la conversation.
 * Pour une référence au Drive, `?contenu=1` la fait ensuite passer au contenu du fichier
 * (`/api/drive/<nœud>/raw`), qui vérifie À SON TOUR le droit de lecture du Drive : deux portes, et
 * jamais d'adresse du Drive écrite en dur dans la page.
 */
export function urlContenuPiece(p: Pick<PieceOuvrable, "id" | "driveNodeId">, opts: { telecharger?: boolean } = {}): string {
  const q: string[] = [];
  if (p.driveNodeId) q.push("contenu=1");
  if (opts.telecharger) q.push("dl=1");
  return `/api/messaging/attachment/${encodeURIComponent(p.id)}${q.length ? `?${q.join("&")}` : ""}`;
}

/**
 * OÙ LA ROUTE DE LA MESSAGERIE RENVOIE UNE RÉFÉRENCE AU DRIVE, une fois la participation vérifiée.
 * Sans `contenu` : la page du Drive (ancien comportement, liens déjà émis). Avec : les octets de la
 * version courante, servis par le Drive après SON contrôle d'accès. Un dossier n'a pas d'octets.
 */
export function redirectionReferenceDrive(nodeId: string, isFolder: boolean, opts: { contenu?: boolean; telecharger?: boolean } = {}): string {
  if (isFolder || !opts.contenu) return driveRefHref(nodeId, isFolder);
  return `/api/drive/${encodeURIComponent(nodeId)}/raw${opts.telecharger ? "?dl=1" : ""}`;
}

/** Les images d'un message, dans l'ordre : ce que ←/→ parcourent dans la visionneuse. */
export function imagesDuMessage<T extends PieceOuvrable>(pieces: readonly T[]): T[] {
  return pieces.filter((p) => ouverturePiece(p) === "image");
}

/**
 * QUI DOIT RECEVOIR UN ACCÈS quand on partage un nœud du Drive dans une conversation.
 *
 * Trois exclusions, et chacune évite une ligne inutile en base :
 *   • l'EXPÉDITEUR — il a déjà accès, c'est bien pour cela qu'il peut le partager ;
 *   • le PROPRIÉTAIRE du nœud — se partager son propre fichier n'a pas de sens ;
 *   • ceux qui ont DÉJÀ un partage — un `VIEW` posé par-dessus un `EDIT` existant serait une
 *     RÉGRESSION de droit : on ne retire jamais l'édition à quelqu'un en lui envoyant un message.
 *
 * On n'accorde jamais que la LECTURE : envoyer un document, ce n'est pas déléguer sa tenue.
 */
export function recipientsToGrant(
  memberIds: readonly string[],
  opts: { senderId: string; ownerId?: string | null; alreadyShared?: readonly string[] },
): string[] {
  const already = new Set(opts.alreadyShared ?? []);
  const out = new Set<string>();
  for (const id of memberIds) {
    if (!id) continue;
    if (id === opts.senderId) continue;
    if (opts.ownerId && id === opts.ownerId) continue;
    if (already.has(id)) continue;
    out.add(id);
  }
  return [...out];
}

/**
 * L'AVERTISSEMENT AVANT L'ENVOI — dit à l'expéditeur ce qu'il s'apprête à ouvrir.
 *
 * Partager un document du Drive DONNE UN ACCÈS, et un accès ne se reprend pas d'un clic. La
 * phrase se lit avant d'appuyer sur Envoyer, pas après : c'est là qu'on peut encore changer
 * d'avis.
 */
export function shareWarning(recipientCount: number): string {
  if (recipientCount <= 0) return "Aucun accès supplémentaire ne sera accordé.";
  if (recipientCount === 1) return "Le destinataire recevra un accès en lecture à ce contenu du Drive.";
  return `Les ${recipientCount} destinataires recevront un accès en lecture à ce contenu du Drive.`;
}

// ─────────────────────────── Les gros envois : par le chemin du Drive ───────────────────────────

/**
 * ENVOYER DE GROS FICHIERS ET DES DOSSIERS EN MESSAGERIE — avec les performances du Drive
 * (Direction, 06/10 : « pas que Drive ou Regulatory, et avec les exactes et mêmes performances »).
 *
 * Ce que l'on dépose dans une conversation part dans le Drive de l'EXPÉDITEUR, sous
 * « Messagerie / <conversation> / Envoi du … », par le MÊME moteur que l'import du Drive : envoi en
 * arrière-plan, six fichiers en parallèle, reprise, envoi direct au stockage au-delà du seuil,
 * contenu déjà connu non retransféré, arborescence exacte d'un dossier. Le message joint ensuite le
 * contenu du lot comme des RÉFÉRENCES au Drive — les destinataires reçoivent la lecture.
 *
 * Plus d'archive .zip faite en mémoire par le serveur, plus de limite de pièce jointe à 200 Mo :
 * la seule limite est celle d'un fichier du Drive.
 */
export const DOSSIER_MESSAGERIE = "Messagerie";

/** Le dossier d'une conversation dans « Messagerie » : son titre, nettoyé, ou « Conversation ». */
export function nomDossierConversation(titre: string | null | undefined): string {
  const propre = (titre ?? "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
  return /[\p{L}\p{N}]/u.test(propre) ? propre : "Conversation";
}

/** Le dossier d'UN envoi : daté à la seconde, à l'heure d'Alger (le serveur peut tourner en UTC). */
export function nomLotMessagerie(date: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `Envoi du ${p.year}-${p.month}-${p.day} à ${p.hour}h${p.minute}m${p.second}`;
}

/**
 * CE QUE LE MESSAGE JOINT D'UN LOT : ses éléments un par un tant qu'ils tiennent dans la place
 * restante (chacun s'ouvre d'un clic), sinon le DOSSIER du lot lui-même — quarante fichiers déposés
 * ne font pas quarante pièces, ils font un dossier qui se navigue. Un lot vide ne joint rien.
 */
export function piecesDuLot(nbElements: number, placeRestante: number): "elements" | "dossier" | "rien" {
  if (nbElements <= 0) return "rien";
  return nbElements <= Math.max(0, placeRestante) ? "elements" : "dossier";
}

/** Où en est un lot déposé dans le compositeur — ce que dit la pastille, et si l'on peut envoyer. */
export interface EtatLot {
  total: number;
  recus: number;
  echecs: number;
  annules: number;
  enCours: boolean;
}

export function libelleLot(e: EtatLot): { texte: string; pret: boolean } {
  const n = (k: number) => `${k} fichier${k > 1 ? "s" : ""}`;
  if (e.enCours) return { texte: `Envoi ${e.recus}/${e.total}…`, pret: false };
  if (e.recus === 0) {
    return { texte: e.annules > 0 && e.echecs === 0 ? "Envoi annulé" : "Échec de l'envoi", pret: false };
  }
  const manque = e.echecs + e.annules;
  return manque > 0
    ? { texte: `${n(e.recus)} prêt${e.recus > 1 ? "s" : ""} · ${manque} non envoyé${manque > 1 ? "s" : ""}`, pret: true }
    : { texte: `${n(e.recus)} prêt${e.recus > 1 ? "s" : ""}`, pret: true };
}

/**
 * Le nom du ZIP produit quand on envoie un DOSSIER de son ordinateur.
 *
 * Un navigateur ne sait pas envoyer un dossier : il envoie ses fichiers à plat, et le message
 * afficherait alors quarante pièces jointes sans hiérarchie. On rassemble donc en une archive —
 * qui porte le nom du dossier, sans quoi le destinataire reçoit un « archive.zip » de plus.
 */
export function folderZipName(folderName: string): string {
  const clean = folderName
    .replace(/[\\/:*?"<>|]/g, "-") // caractères refusés par les systèmes de fichiers
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.zip$/i, "");
  // Un nom qui ne contient AUCUNE lettre ni chiffre n'est pas un nom : « ---.zip » n'apprend rien
  // de plus que « Dossier.zip », et se lit moins bien.
  const usable = /[\p{L}\p{N}]/u.test(clean) ? clean : "";
  return `${usable || "Dossier"}.zip`;
}

/**
 * Le nom du dossier racine d'une sélection `webkitdirectory`.
 *
 * Le navigateur ne donne PAS le nom du dossier choisi : il donne, pour chaque fichier, un chemin
 * relatif (« Contrats/2026/bail.pdf »). Le premier segment est donc la seule trace du dossier
 * qu'on a désigné.
 */
export function rootFolderName(relativePaths: readonly string[]): string | null {
  for (const p of relativePaths) {
    const first = (p ?? "").split("/")[0];
    if (first) return first;
  }
  return null;
}
