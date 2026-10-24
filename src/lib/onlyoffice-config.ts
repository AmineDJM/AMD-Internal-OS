import { prisma } from "@/lib/prisma";
import { resolveDriveAccess } from "@/lib/drive";
import type { SessionUser } from "@/lib/rbac";
import {
  onlyofficeConfigured, onlyofficeServerUrl, appBaseUrl, onlyofficeDocType, fileExt, makeFileReadToken, makeSaveToken, signJwt,
} from "@/lib/onlyoffice";
import { blankOffice } from "@/lib/office-templates";

/**
 * LA CONFIGURATION DE L'ÉDITEUR, construite UNE FOIS.
 *
 * Deux écrans ouvrent le même éditeur : la page d'édition d'un fichier, et l'onglet d'édition du
 * plan de travail multi-documents (qui l'embarque sans le cadre de l'application). Recopier la
 * construction dans les deux, c'est garantir qu'une correction — un jeton, une permission, un
 * réglage de sauvegarde — ne sera appliquée qu'à l'un des deux.
 *
 * La vérification de droit est ICI, pas chez l'appelant : un écran de plus ne doit pas pouvoir
 * l'oublier.
 */
export type EditorSetup =
  | { ok: true; apiJs: string; config: Record<string, unknown>; name: string; vierge: boolean }
  | { ok: false; reason: "not-configured" | "no-base-url" | "denied" | "not-found" | "not-editable" };

export async function buildEditorSetup(
  user: SessionUser & { name?: string },
  nodeId: string,
): Promise<EditorSetup> {
  if (!onlyofficeConfigured()) return { ok: false, reason: "not-configured" };
  const base = appBaseUrl();
  if (!base) return { ok: false, reason: "no-base-url" };

  if ((await resolveDriveAccess(user, nodeId)) !== "EDIT") return { ok: false, reason: "denied" };

  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, type: true, size: true } });
  if (!node || node.type !== "FILE") return { ok: false, reason: "not-found" };

  const docType = onlyofficeDocType(node.name);
  if (!docType) return { ok: false, reason: "not-editable" };

  const last = await prisma.fileVersion.findFirst({
    where: { nodeId }, orderBy: { version: "desc" }, select: { version: true },
  });
  // LIRE n'est pas ENREGISTRER (`lib/onlyoffice.ts`) : `document.url` part au navigateur, il ne porte qu'un
  // jeton de lecture ; le jeton d'enregistrement ne vit que dans `callbackUrl` (on est en édition ici).
  const readToken = makeFileReadToken(nodeId, user.id);
  const saveToken = makeSaveToken("drive", nodeId, user.id);
  // `key` change à chaque version → invalide le cache du Document Server après sauvegarde.
  const key = `${nodeId}_${last?.version ?? 1}`;

  const config: Record<string, unknown> = {
    documentType: docType,
    document: {
      fileType: fileExt(node.name),
      key,
      title: node.name,
      url: `${base}/api/onlyoffice/file?token=${readToken}`,
      permissions: { edit: true, download: true, print: true },
    },
    editorConfig: {
      mode: "edit",
      lang: "fr",
      callbackUrl: `${base}/api/onlyoffice/callback?id=${nodeId}&token=${saveToken}`,
      user: { id: user.id, name: user.name ?? "Utilisateur" },
      // Allègement de l'initialisation : on désactive les sous-systèmes inutiles ici (chat,
      // plugins, aide, page « à propos ») pour un démarrage plus rapide et une surface d'édition
      // plus nette. L'autosave reste actif.
      customization: {
        autosave: true, forcesave: true, chat: false, plugins: false,
        help: false, about: false, compactHeader: false, hideRightMenu: false,
      },
    },
    width: "100%",
    height: "100%",
  };

  return {
    ok: true,
    apiJs: `${onlyofficeServerUrl()}/web-apps/apps/api/documents/api.js`,
    config: { ...config, token: signJwt(config, 24 * 3600) },
    name: node.name,
    vierge: estDocumentVierge(node.name, node.size, last?.version ?? 1),
  };
}

/**
 * UN DOCUMENT ENCORE VIERGE — tel que « Nouveau document » l'a créé, jamais enregistré depuis.
 *
 * Quand l'éditeur est injoignable, l'écran montre un aperçu de secours ; pour un document neuf,
 * cet aperçu serait une page blanche sans explication. Le modèle vierge est DÉTERMINISTE
 * (`blankOffice`) : une version unique, de la taille exacte du modèle, c'est lui.
 */
const modelesVierges = new Map<string, { ext: string; taille: number }>();
export function estDocumentVierge(name: string, size: number | null | undefined, version: number): boolean {
  if (version !== 1 || !size) return false;
  const kind = onlyofficeDocType(name);
  if (!kind) return false;
  let modele = modelesVierges.get(kind);
  if (!modele) {
    const b = blankOffice(kind);
    modele = { ext: b.ext, taille: b.data.length };
    modelesVierges.set(kind, modele);
  }
  return fileExt(name) === modele.ext && size === modele.taille;
}

/** Le message à afficher quand l'éditeur ne peut pas s'ouvrir — le même partout. */
export const EDITOR_REASON: Record<Exclude<EditorSetup, { ok: true }>["reason"], string> = {
  "not-configured": "L'éditeur Office n'est pas configuré sur ce serveur.",
  "no-base-url": "L'URL publique de l'application n'est pas définie : le serveur d'édition ne peut pas la joindre.",
  denied: "Vous n'avez pas le droit de modifier ce fichier.",
  "not-found": "Fichier introuvable.",
  "not-editable": "Ce type de fichier ne s'édite pas dans l'éditeur en ligne.",
};
