import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, canViewDrive, type DriveAccessLevel } from "@/lib/drive";
import { canAccessEntity } from "@/lib/entity-access";
import { peutLirePasseportDuSujet } from "@/lib/ad-pro/passeport-acces";
import type { SessionUser } from "@/lib/rbac";
import {
  onlyofficeConfigured, onlyofficeServerUrl, appBaseUrl, onlyofficeDocType, onlyofficeTypeOuvrable, fileExt,
  makeEditToken, makeDocEditToken, signJwt,
} from "@/lib/onlyoffice";

/**
 * OUVRIR UN FICHIER DANS L'ÉDITEUR OFFICE, À LA PLACE D'UN APERÇU (Direction, 06/10) : « quand on ouvre un Word, on
 * voit un Word, on peut le modifier, et tout se passe sur le serveur — pareil pour l'Excel, le PowerPoint, tout ce
 * qui est modifiable : le lire dans son format exact, le modifier, le supprimer ».
 *
 * C'est le Document Server (OnlyOffice) qui ouvre le fichier : il lit le format d'origine (.doc, .xls, .ppt, .rtf,
 * .odt…) sur le serveur, gère l'enregistrement, les versions et l'édition à plusieurs. Le PC n'affiche que l'interface
 * de l'éditeur — il ne décode ni ne convertit plus rien lui-même (plus de mammoth, xlsx, jszip dans l'onglet).
 *
 * LES DROITS SE LISENT ICI, UNE FOIS (§118.5) : lire un fichier ouvre l'éditeur en LECTURE ; pouvoir le modifier
 * (droit « téléverser » sur l'entité, « modifier » sur le Drive) l'ouvre en ÉDITION, pour les formats qui se
 * réenregistrent fidèlement (`onlyofficeDocType`). Un format ouvrable mais non réécrivable reste en lecture.
 */

export type CibleEditeur = { type: "drive" | "document"; id: string };

export type SessionEditeur =
  | { ok: true; apiJs: string; config: Record<string, unknown>; name: string; mode: "edit" | "view" }
  | { ok: false; reason: "not-configured" | "no-base-url" | "denied" | "not-found" | "not-openable" };

export const RAISON_EDITEUR: Record<Exclude<SessionEditeur, { ok: true }>["reason"], string> = {
  "not-configured": "L'éditeur Office n'est pas configuré sur ce serveur.",
  "no-base-url": "L'URL publique de l'application n'est pas définie : le serveur d'édition ne peut pas la joindre.",
  denied: "Vous n'avez pas le droit d'ouvrir ce fichier.",
  "not-found": "Fichier introuvable.",
  "not-openable": "Ce format ne s'ouvre pas dans l'éditeur en ligne.",
};

/**
 * Ce que l'appelant a DÉJÀ lu d'un fichier du Drive (droit résolu, nom, dernière version) : la page qui ouvre
 * le fichier le lit pour son propre affichage, et le relire ici doublerait les requêtes avant l'éditeur. Les
 * droits restent jugés ICI — ce sont les mêmes valeurs, juste pas relues.
 */
export interface DriveDejaLu { acces: DriveAccessLevel; nom: string; estFichier: boolean; version: number | null }

export async function sessionEditeur(user: SessionUser & { name?: string }, cible: CibleEditeur, dejaLu?: DriveDejaLu): Promise<SessionEditeur> {
  if (!onlyofficeConfigured()) return { ok: false, reason: "not-configured" };
  const base = appBaseUrl();
  if (!base) return { ok: false, reason: "no-base-url" };

  let nom: string;
  let peutModifier: boolean;
  let key: string;
  let urlFichier: string;
  let callbackUrl: string;

  if (cible.type === "drive") {
    const acces = dejaLu ? dejaLu.acces : await resolveDriveAccess(user, cible.id);
    if (!canViewDrive(acces)) return { ok: false, reason: "denied" };
    const node = dejaLu
      ? { name: dejaLu.nom, type: dejaLu.estFichier ? "FILE" : "FOLDER" }
      : await prisma.driveNode.findUnique({ where: { id: cible.id }, select: { name: true, type: true } });
    if (!node || node.type !== "FILE") return { ok: false, reason: "not-found" };
    const derniere = dejaLu
      ? (dejaLu.version === null ? null : { version: dejaLu.version })
      : await prisma.fileVersion.findFirst({ where: { nodeId: cible.id }, orderBy: { version: "desc" }, select: { version: true } });
    if (!derniere) return { ok: false, reason: "not-found" };
    nom = node.name;
    peutModifier = acces === "EDIT";
    // `key` change à chaque version → le Document Server n'ouvre jamais une copie périmée.
    key = `${cible.id}_${derniere.version}`;
    const jeton = makeEditToken(cible.id, user.id);
    urlFichier = `${base}/api/onlyoffice/file?token=${jeton}`;
    callbackUrl = `${base}/api/onlyoffice/callback?id=${cible.id}&token=${jeton}`;
  } else {
    const doc = await prisma.document.findUnique({
      where: { id: cible.id },
      select: { id: true, name: true, version: true, sizeBytes: true, fileKey: true, entityType: true, entityId: true, stepKey: true },
    });
    if (!doc) return { ok: false, reason: "not-found" };
    const peutLire = (await canAccessEntity(user, doc.entityType, doc.entityId, "VIEW"))
      || (await peutLirePasseportDuSujet(user.id, doc));
    if (!peutLire) return { ok: false, reason: "denied" };
    if (!doc.fileKey) return { ok: false, reason: "not-found" };
    nom = doc.name;
    peutModifier = await canAccessEntity(user, doc.entityType, doc.entityId, "UPLOAD");
    // Version ET taille : un fichier remplacé sans passer par l'éditeur ne doit pas rouvrir l'ancienne copie.
    key = `doc_${doc.id}_${doc.version}_${doc.sizeBytes ?? 0}`;
    const jeton = makeDocEditToken(doc.id, user.id);
    urlFichier = `${base}/api/onlyoffice/file?token=${jeton}`;
    callbackUrl = `${base}/api/onlyoffice/callback?docId=${doc.id}&token=${jeton}`;
  }

  const typeOuvrable = onlyofficeTypeOuvrable(nom);
  if (!typeOuvrable) return { ok: false, reason: "not-openable" };
  const modifiable = onlyofficeDocType(nom) !== null; // réécrivable fidèlement
  const mode: "edit" | "view" = peutModifier && modifiable ? "edit" : "view";

  const config: Record<string, unknown> = {
    documentType: typeOuvrable,
    document: {
      fileType: fileExt(nom),
      key,
      title: nom,
      url: urlFichier,
      permissions: { edit: mode === "edit", download: true, print: true, comment: mode === "edit" },
    },
    editorConfig: {
      mode,
      lang: "fr",
      ...(mode === "edit" ? { callbackUrl } : {}),
      user: { id: user.id, name: user.name ?? "Utilisateur" },
      customization: {
        autosave: true, forcesave: true, chat: false, plugins: false, help: false, about: false,
        compactHeader: true, hideRightMenu: false, goback: { text: "", url: "" },
      },
    },
    width: "100%",
    height: "100%",
  };
  return {
    ok: true,
    apiJs: `${onlyofficeServerUrl()}/web-apps/apps/api/documents/api.js`,
    config: { ...config, token: signJwt(config, 24 * 3600) },
    name: nom,
    mode,
  };
}
