import { prisma } from "@/lib/prisma";
import { mimeFromName } from "@/lib/drive/mime-nom";
import { rangerDocumentsDansDrive } from "@/lib/regulatory-drive-dossier";
import { deposerFichierDrive } from "@/lib/drive/mirror";

export { mimeFromName };

/**
 * MIROIR DRIVE d'un dépôt Regulatory. Réplique dans le Drive — sous un dossier
 * automatiquement nommé D'APRÈS LE PRODUIT — les fichiers déposés (un/plusieurs fichiers,
 * un dossier, ou une archive ZIP décompressée), EN CONSERVANT L'ARBORESCENCE EXACTE
 * (sous-dossiers imbriqués → dossiers Drive imbriqués). Idempotent : re-déposer un même
 * chemin ajoute une NOUVELLE VERSION du fichier plutôt qu'un doublon.
 *
 * Le dossier racine « Regulatory — Dossiers produits » et le dossier produit sont propres
 * à l'utilisateur qui dépose (owner) ; le dossier produit est PARTAGÉ (lecture) avec les
 * parties prenantes du dossier — l'accès descend tout l'arbre (cf. resolveDriveAccess).
 */

export const REG_DRIVE_ROOT = "Regulatory — Dossiers produits";

/** Segments d'un chemin, nettoyés (sépar. Windows, « . »/« .. »/vides retirés). */
export function cleanPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..");
}

/** Trouve/crée un dossier Drive (par nom, sous parent, pour cet owner) — idempotent. */
async function ensureFolder(name: string, parentId: string | null, ownerId: string): Promise<string> {
  const existing = await prisma.driveNode.findFirst({
    where: { type: "FOLDER", name, parentId, ownerId, isTrashed: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", parentId, ownerId, createdById: ownerId },
    select: { id: true },
  });
  return node.id;
}

export interface MirrorEntry { path: string; data: Buffer; mime?: string }
export interface MirrorResult { productFolderId: string; created: number; updated: number; skipped: number }

/**
 * Réplique `entries` (chemins relatifs + contenu) dans le Drive sous
 * `Regulatory — Dossiers produits / <produit> [/ <subfolder>]`, arborescence préservée.
 */
export async function mirrorToProductDrive(opts: {
  productName: string;
  ownerId: string;
  entries: MirrorEntry[];
  subfolder?: string; // ex. « Dépôt du 2026-07-13 » pour dater un lot
  shareUserIds?: string[]; // parties prenantes : lecture partagée sur le dossier produit
}): Promise<MirrorResult> {
  const rootId = await ensureFolder(REG_DRIVE_ROOT, null, opts.ownerId);
  const productFolderId = await ensureFolder(opts.productName.trim() || "Produit sans nom", rootId, opts.ownerId);
  const baseId = opts.subfolder ? await ensureFolder(opts.subfolder, productFolderId, opts.ownerId) : productFolderId;

  // Partage lecture du dossier produit avec les parties prenantes (accès hérité par tout l'arbre).
  const shareIds = [...new Set((opts.shareUserIds ?? []).filter((id) => id && id !== opts.ownerId))];
  if (shareIds.length) {
    const valid = await prisma.user.findMany({ where: { id: { in: shareIds }, isActive: true }, select: { id: true } });
    if (valid.length) {
      await prisma.driveShare.createMany({
        data: valid.map((u) => ({ nodeId: productFolderId, userId: u.id, access: "VIEW" as const })),
        skipDuplicates: true,
      });
    }
  }

  const folderCache = new Map<string, string>(); // clé « parentId/seg/seg » → id (évite de re-résoudre)
  let created = 0, updated = 0, skipped = 0;

  for (const e of opts.entries) {
    const parts = cleanPathSegments(e.path);
    if (parts.length === 0) { skipped++; continue; }
    const filename = parts.pop()!;

    // Reconstitue l'arborescence de dossiers.
    let parentId = baseId;
    let key = baseId;
    for (const seg of parts) {
      key += `/${seg}`;
      let id = folderCache.get(key);
      if (!id) { id = await ensureFolder(seg, parentId, opts.ownerId); folderCache.set(key, id); }
      parentId = id;
    }

    // Dédup : même nom dans le même dossier → nouvelle VERSION (pas de doublon) ; le fichier entre à la bibliothèque.
    const { cree } = await deposerFichierDrive({ parentId, name: filename, data: e.data, mimeType: e.mime || mimeFromName(filename), ownerId: opts.ownerId });
    if (cree) created++;
    else updated++;
  }

  return { productFolderId, created, updated, skipped };
}

/**
 * MIROIR AUTOMATIQUE d'un (ou plusieurs) document(s) Regulatory officiellement téléversé(s).
 * **Best-effort** : ne doit JAMAIS faire échouer le téléversement (toute erreur est journalisée
 * et avalée).
 *
 * DEPUIS LE 06/10 (Direction) : les pièces d'un dossier du suivi vont dans SON dossier de la
 * catégorie Drive « Regulatory », rangées selon le modèle (`lib/regulatory/drive-dossier.ts`), par
 * RÉFÉRENCE au blob du document — d'où `documentIds`. L'ancien miroir (Drive de celui qui dépose,
 * « Regulatory — Dossiers produits », partagé aux parties prenantes) ne sert plus que de repli :
 * dossier verrouillé (la catégorie l'exposerait), catégorie absente. Ce qu'il a déjà rangé reste où
 * il est.
 */
export async function mirrorRegulatoryUpload(opts: {
  productId: string;
  ownerId: string;
  files: { name: string; data: Buffer; mime?: string }[];
  /** Les documents créés par ce dépôt : le rangement dans la catégorie part de leurs fiches. */
  documentIds?: readonly string[];
}): Promise<void> {
  if (opts.documentIds?.length) {
    try {
      const bilan = await rangerDocumentsDansDrive(opts.productId, { acteurId: opts.ownerId, documentIds: opts.documentIds });
      if (bilan.range) return;
    } catch (err) {
      console.error("[reg auto-mirror] rangement dans la catégorie Regulatory échoué — repli sur l'ancien miroir", err);
    }
  }
  if (opts.files.length === 0) return;
  try {
    const product = await prisma.regulatoryProduct.findUnique({
      where: { id: opts.productId },
      select: { reference: true, dci: true, responsibleId: true, assistantId: true, assignedUsers: { select: { id: true } } },
    });
    if (!product) return;
    const productName = `${product.reference} — ${product.dci}`.trim();
    const stakeholders = [product.responsibleId, product.assistantId, ...product.assignedUsers.map((u) => u.id)]
      .filter((v): v is string => Boolean(v));
    await mirrorToProductDrive({
      productName,
      ownerId: opts.ownerId,
      entries: opts.files.map((f) => ({ path: f.name, data: f.data, mime: f.mime || mimeFromName(f.name) })),
      shareUserIds: stakeholders,
    });
  } catch (err) {
    console.error("[reg auto-mirror] échec (non bloquant)", err);
  }
}
