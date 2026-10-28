import { readFile } from "fs/promises";
import path from "path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { putBlob, releaseBlob, retainBlob } from "@/lib/drive-storage";
import { enSerie } from "@/lib/refs";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { mimeFromName } from "@/lib/drive/mime-nom";
import {
  ARBORESCENCE_DOSSIER, FICHIERS_MODELES, MODELE_COURRIER_RESERVES,
  cheminDrivePourDepot, cyclesDeLaFrise, nomDossierDrive,
} from "@/lib/regulatory/arborescence-dossier";
import { sansBloquer } from "@/lib/journal";

/**
 * LE DOSSIER DRIVE D'UN PRODUIT, dans la catégorie « Regulatory » (Direction, 06/10).
 *
 * Chaque dossier du suivi a UN dossier dans la catégorie Drive « Regulatory », nommé molécule +
 * dosage, organisé exactement comme le modèle (`arborescence-dossier.ts`) ; chaque pièce déposée
 * dans Regulatory y apparaît, rangée là où le modèle la met.
 *
 * ── CE QUI EST TENU ICI ─────────────────────────────────────────────────────────────────────
 *
 *   1. **La catégorie est celle que la Direction a créée — jamais une autre.** On la cherche par son
 *      nom ; absente, rien n'est créé (ni catégorie, ni dossier) et le dépôt garde l'ancien miroir.
 *      Fabriquer une catégorie ici, ce serait choisir à la place de la Direction qui la voit.
 *   2. **L'accès est celui de la catégorie**, et lui seul : aucun partage nominatif n'est posé. Un
 *      dossier VERROUILLÉ (pipeline, confidentiel) n'y entre pas — la catégorie l'exposerait à toute
 *      son audience ; il garde l'ancien miroir, privé.
 *   3. **Une pièce n'est pas recopiée : elle est RÉFÉRENCÉE.** Le fichier Drive désigne le même blob
 *      que le document (compteur de références pris) — aucun octet relu, même pour une CTD de
 *      plusieurs Go envoyée en direct au bucket.
 *   4. **Idempotent.** Le dossier produit se retrouve par sa MARQUE (`custom.regulatory.productId`),
 *      pas par son nom : on peut le renommer ou le déplacer dans la catégorie sans le dédoubler. Un
 *      fichier déjà présent (même nom, même contenu) n'est pas ajouté deux fois ; même nom, autre
 *      contenu → nouvelle version, comme partout dans le Drive.
 *   5. **Best-effort** : rien ici ne fait échouer une création de dossier ni un dépôt.
 */

/** Le nom de la catégorie Drive, tel que la Direction l'a créée. */
export const NOM_ESPACE_REGULATORY = "Regulatory";

const normaliser = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** La catégorie « Regulatory » (la plus ancienne si plusieurs portent ce nom), ou `null`. */
export async function espaceRegulatory(): Promise<string | null> {
  const candidats = await prisma.driveSpace.findMany({
    where: { isArchived: false, name: { contains: NOM_ESPACE_REGULATORY, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  return candidats.find((s) => normaliser(s.name) === normaliser(NOM_ESPACE_REGULATORY))?.id ?? null;
}

/** La marque posée sur le dossier racine d'un produit. */
const marque = (productId: string) => ({ regulatory: { productId } });
const filtreMarque = (productId: string): Prisma.DriveNodeWhereInput => ({
  type: "FOLDER", isTrashed: false, custom: { path: ["regulatory", "productId"], equals: productId },
});
const estMarque = (custom: unknown): boolean => {
  const r = (custom as { regulatory?: { productId?: unknown } } | null)?.regulatory;
  return typeof r?.productId === "string";
};

/** Le dossier racine d'un produit dans le Drive (nouvelle arborescence), s'il existe — pour l'afficher. */
export async function dossierDriveDuProduit(productId: string): Promise<string | null> {
  const n = await prisma.driveNode.findFirst({ where: filtreMarque(productId), orderBy: { createdAt: "asc" }, select: { id: true } });
  return n?.id ?? null;
}

interface ProduitPourDrive { id: string; reference: string; dci: string; dosage: string | null; dosageUnit: string | null }

/**
 * Trouve — ou crée — le dossier racine du produit dans la catégorie. Un dossier du même nom SANS
 * marque (posé à la main avant l'automatisme) est adopté plutôt que doublé ; un homonyme qui
 * appartient à un AUTRE produit fait ajouter la référence au nom (deux dossiers ne fusionnent pas).
 */
async function racineDuProduit(espaceId: string, p: ProduitPourDrive, acteurId: string): Promise<{ id: string; cree: boolean }> {
  const deja = await prisma.driveNode.findFirst({ where: { ...filtreMarque(p.id), spaceId: espaceId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (deja) return { id: deja.id, cree: false };
  // Une file pour TOUTES les racines : deux produits homonymes créés au même instant ne se disputent pas un nom.
  return enSerie("DRIVE-REGULATORY-RACINES", async () => {
    const relu = await prisma.driveNode.findFirst({ where: { ...filtreMarque(p.id), spaceId: espaceId }, select: { id: true } });
    if (relu) return { id: relu.id, cree: false };
    const nom = nomDossierDrive(p.dci, p.dosage, p.dosageUnit);
    const homonymes = await prisma.driveNode.findMany({
      where: { spaceId: espaceId, parentId: null, type: "FOLDER", isTrashed: false, name: nom },
      select: { id: true, custom: true },
    });
    const libre = homonymes.find((h) => !estMarque(h.custom));
    if (libre) {
      const custom = { ...((libre.custom as Record<string, unknown> | null) ?? {}), ...marque(p.id) };
      await prisma.driveNode.update({ where: { id: libre.id }, data: { custom: custom as Prisma.InputJsonValue } });
      return { id: libre.id, cree: false };
    }
    const n = await prisma.driveNode.create({
      data: {
        name: homonymes.length ? `${nom} (${p.reference})` : nom, type: "FOLDER", parentId: null, spaceId: espaceId,
        ownerId: acteurId, createdById: acteurId, custom: marque(p.id) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: n.id, cree: true };
  });
}

/** Le courrier modèle, lu une fois (fichier versionné à côté de ce module). */
let modele: Promise<Buffer | null> | null = null;
function lireModeleCourrier(): Promise<Buffer | null> {
  modele ??= readFile(path.join(process.cwd(), "src", "lib", "regulatory", "drive-modele", MODELE_COURRIER_RESERVES))
    .catch((e) => { console.error("[drive regulatory] courrier modèle illisible", e); modele = null; return null; });
  return modele;
}

/**
 * L'ARBORESCENCE MODÈLE sous la racine du produit, et le courrier modèle dans chaque « 2- Draft ».
 * Le courrier n'est posé qu'UNE fois : un fichier de ce nom, même mis à la corbeille, n'est pas recréé.
 */
async function poserArborescence(rootId: string, espaceId: string, acteurId: string): Promise<void> {
  const carte = await creerArborescenceDrive({ ownerId: acteurId, parentId: rootId, spaceId: espaceId, paths: ARBORESCENCE_DOSSIER });
  const contenu = await lireModeleCourrier();
  if (!contenu) return;
  for (const f of FICHIERS_MODELES) {
    const parentId = carte[f.dossier];
    if (!parentId) continue;
    const present = await prisma.driveNode.count({ where: { type: "FILE", parentId, name: f.nom } });
    if (present > 0) continue;
    const { blobId, size } = await putBlob(contenu);
    const mimeType = mimeFromName(f.nom);
    await prisma.driveNode.create({
      data: {
        name: f.nom, type: "FILE", parentId, spaceId: espaceId, ownerId: acteurId, createdById: acteurId, mimeType, size,
        versions: { create: { blobId, version: 1, size, mimeType, createdById: acteurId } },
      },
    });
  }
}

const SELECT_PRODUIT = { id: true, reference: true, dci: true, dosage: true, dosageUnit: true, isLocked: true } as const;

export type IssueDossierDrive =
  | { ok: true; rootId: string; cree: boolean }
  | { ok: false; raison: "SANS_ESPACE" | "VERROUILLE" | "INTROUVABLE" };

/**
 * CRÉE LE DOSSIER DRIVE D'UN PRODUIT du suivi — racine + arborescence modèle + courriers modèles.
 * Idempotent, sérialisé par produit (le dépôt de la CTD qui suit la création attend son tour).
 */
export async function creerDossierDriveProduit(productId: string, acteurId: string): Promise<IssueDossierDrive> {
  return enSerie(`DRIVE-REGULATORY:${productId}`, async () => {
    const p = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: SELECT_PRODUIT });
    if (!p) return { ok: false, raison: "INTROUVABLE" };
    if (p.isLocked) return { ok: false, raison: "VERROUILLE" };
    const espaceId = await espaceRegulatory();
    if (!espaceId) return { ok: false, raison: "SANS_ESPACE" };
    const racine = await racineDuProduit(espaceId, p, acteurId);
    await poserArborescence(racine.id, espaceId, acteurId);
    return { ok: true, rootId: racine.id, cree: racine.cree };
  });
}

/**
 * LE DOSSIER ENTIER, mis à jour : arborescence modèle puis TOUTES les pièces du dossier. Le geste
 * d'un dossier qui entre au suivi (cadenas ouvert) et du rattrapage. Idempotent.
 */
export async function synchroniserDossierDrive(productId: string, acteurId: string): Promise<{ dossier: IssueDossierDrive; pieces: BilanRangement }> {
  const dossier = await creerDossierDriveProduit(productId, acteurId);
  const pieces = dossier.ok
    ? await rangerDocumentsDansDrive(productId, { acteurId })
    : { range: false, raison: dossier.raison, dossierCree: false, fichiersAjoutes: 0, versionsAjoutees: 0, dejaPresents: 0, sansFichier: 0 };
  return { dossier, pieces };
}

export interface BilanRangement {
  /** `false` quand rien n'a été tenté (pas de catégorie, dossier verrouillé ou introuvable). */
  range: boolean;
  raison?: "SANS_ESPACE" | "VERROUILLE" | "INTROUVABLE";
  dossierCree: boolean;
  fichiersAjoutes: number;
  versionsAjoutees: number;
  dejaPresents: number;
  sansFichier: number;
}

/**
 * RANGE LES PIÈCES D'UN PRODUIT dans son dossier Drive — toutes, ou celles qu'on désigne (un dépôt).
 * Chaque pièce va au chemin que dit `cheminDrivePourDepot`, en RÉFÉRENÇANT son blob.
 */
export async function rangerDocumentsDansDrive(
  productId: string,
  opts: { acteurId: string; documentIds?: readonly string[] },
): Promise<BilanRangement> {
  const vide: BilanRangement = { range: false, dossierCree: false, fichiersAjoutes: 0, versionsAjoutees: 0, dejaPresents: 0, sansFichier: 0 };
  if (opts.documentIds && opts.documentIds.length === 0) return vide;
  return enSerie(`DRIVE-REGULATORY:${productId}`, async () => {
    const p = await prisma.regulatoryProduct.findUnique({
      where: { id: productId },
      select: { ...SELECT_PRODUIT, dossierSteps: { select: { id: true, kind: true, label: true, order: true } } },
    });
    if (!p) return { ...vide, raison: "INTROUVABLE" };
    if (p.isLocked) return { ...vide, raison: "VERROUILLE" };
    const espaceId = await espaceRegulatory();
    if (!espaceId) return { ...vide, raison: "SANS_ESPACE" };

    const racine = await racineDuProduit(espaceId, p, opts.acteurId);
    // Un dossier qui naît ICI (premier dépôt d'un dossier d'avant l'automatisme) reçoit tout le modèle.
    if (racine.cree) await poserArborescence(racine.id, espaceId, opts.acteurId);
    const bilan: BilanRangement = { ...vide, range: true, dossierCree: racine.cree };

    const docs = await prisma.document.findMany({
      where: {
        entityType: "REGULATORY_PRODUCT", entityId: productId,
        ...(opts.documentIds ? { id: { in: [...opts.documentIds] } } : {}),
      },
      select: { id: true, name: true, category: true, stepKey: true, folder: true, fileKey: true, mimeType: true, uploadedById: true },
      orderBy: { createdAt: "asc" }, // v1 avant v2 : les versions Drive suivent l'ordre des dépôts
    });
    if (docs.length === 0) return bilan;

    const frise = new Map(p.dossierSteps.map((s) => [s.id, s]));
    const { parEtape, total: cycles } = cyclesDeLaFrise(p.dossierSteps);
    const stockes = new Map(
      (await prisma.storedFile.findMany({
        where: { key: { in: docs.map((d) => d.fileKey).filter((k): k is string => Boolean(k)) } },
        select: { key: true, blobId: true, size: true },
      })).map((s) => [s.key, s]),
    );
    const dossiers = new Map<string, string>(); // chemin relatif → id du dossier Drive

    for (const d of docs) {
      const stocke = d.fileKey ? stockes.get(d.fileKey) : undefined;
      if (!stocke) { bilan.sansFichier++; continue; }
      try {
        const etape = d.stepKey ? frise.get(d.stepKey) : undefined;
        const chemin = cheminDrivePourDepot({
          stepKey: d.stepKey, category: d.category, folder: d.folder, name: d.name, cycles,
          frise: etape ? { kind: etape.kind, label: etape.label, cycle: parEtape.get(etape.id) ?? 0 } : null,
        });
        const cle = chemin.join("/");
        let parentId = dossiers.get(cle);
        if (!parentId) {
          parentId = cle
            ? (await creerArborescenceDrive({ ownerId: opts.acteurId, parentId: racine.id, spaceId: espaceId, paths: [cle] }))[cle]
            : racine.id;
          dossiers.set(cle, parentId);
        }
        const ownerId = d.uploadedById ?? opts.acteurId;
        const mimeType = d.mimeType || mimeFromName(d.name);
        const size = stocke.size ?? 0;
        const existant = await prisma.driveNode.findFirst({
          where: { type: "FILE", name: d.name, parentId, isTrashed: false },
          select: { id: true, versions: { where: { blobId: stocke.blobId }, select: { id: true }, take: 1 } },
        });
        if (existant && existant.versions.length > 0) { bilan.dejaPresents++; continue; }
        // La référence est prise AVANT d'écrire la version : un blob effacé entre-temps n'est pas désigné.
        if (!(await retainBlob(stocke.blobId))) { bilan.sansFichier++; continue; }
        try {
          if (existant) {
            const last = await prisma.fileVersion.findFirst({ where: { nodeId: existant.id }, orderBy: { version: "desc" }, select: { version: true } });
            await prisma.fileVersion.create({ data: { nodeId: existant.id, blobId: stocke.blobId, version: (last?.version ?? 0) + 1, size, mimeType, createdById: ownerId } });
            await prisma.driveNode.update({ where: { id: existant.id }, data: { size, mimeType } });
            bilan.versionsAjoutees++;
          } else {
            await prisma.driveNode.create({
              data: {
                name: d.name, type: "FILE", parentId, spaceId: espaceId, ownerId, createdById: ownerId, mimeType, size,
                versions: { create: { blobId: stocke.blobId, version: 1, size, mimeType, createdById: ownerId } },
              },
            });
            bilan.fichiersAjoutes++;
          }
        } catch (e) {
          // La référence prise n'a pas trouvé de détenteur : on la rend.
          await releaseBlob(stocke.blobId).catch(sansBloquer("regulatory-drive-dossier.rangerDocumentsDansDrive.releaseBlob"));
          throw e;
        }
      } catch (e) {
        console.error("[drive regulatory] pièce non rangée (non bloquant)", { documentId: d.id }, e);
      }
    }
    return bilan;
  });
}
