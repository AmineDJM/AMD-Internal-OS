import type { Confidentiality, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emettrePieceDeposee, type ResultatEmission } from "./evenements";
import { validerDepot, nomPourRegistre, type ConfidentialitePiece, type PieceDeposeeInput, type Rattachement } from "./depot";
import { cleTache, confidentialitePourEnrichissement, sourceDeLEntite } from "./file";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SIGNALER UN DÉPÔT — ce que les goulots appellent une fois l'écriture métier acquise (lot V2-A).
 *
 * Deux gestes, dans cet ordre, sous l'interrupteur `AppSetting.enrichissementActif` :
 *   1. le fait public `PIECE_DEPOSEE` au registre (`emettrePieceDeposee`, idempotent) ;
 *   2. la mise en FILE (`TacheEnrichissement`) d'une ligne par rattachement — `createMany` sur la
 *      clé unique `empreinte|TYPE:id|rôle` : redéposer le même fichier au même endroit ne crée rien.
 *
 * Le registre et la file ont deux lecteurs différents : le registre se lit largement (frises,
 * missions qui attendent une pièce), la file n'a qu'un consommateur, le passage d'enrichissement.
 *
 * ── NE FAIT JAMAIS ÉCHOUER LE DÉPÔT ──────────────────────────────────────────────────────────
 *
 * Un téléversement réussi reste réussi : ce module ne lève pas, il rend un statut. Interrupteur
 * fermé (le défaut) : rien n'est écrit, pas même le fait — l'enrichissement est une nouveauté que le
 * Super Admin ouvre, et refermer doit tout couper.
 *
 * ── LE DÉPÔT DIRECT ─────────────────────────────────────────────────────────────────────────
 *
 * Un fichier écrit directement au bucket n'a pas d'empreinte (`direct:<clé>`). Il n'est pas émis
 * ici (le registre le refuserait) : il entre en file SANS empreinte, et le passage la calcule en
 * relisant le blob, puis émet.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatSignalement =
  | { statut: "INACTIF" }
  | { statut: "SIGNALE"; emission: ResultatEmission["statut"]; misesEnFile: number }
  | { statut: "REJETE"; raison: string };

/** L'interrupteur, lu en base à chaque dépôt (une ligne, par clé primaire). Illisible : fermé. */
export async function enrichissementActif(): Promise<boolean> {
  try {
    const r = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { enrichissementActif: true } });
    return r?.enrichissementActif === true;
  } catch {
    return false;
  }
}

const estDirect = (empreinte: string) => empreinte.trim().startsWith("direct:");

export async function signalerDepot(input: PieceDeposeeInput): Promise<ResultatSignalement> {
  try {
    if (!(await enrichissementActif())) return { statut: "INACTIF" };
    if (estDirect(input.empreinte ?? "")) return await mettreEnFile(input, null, "DIRECT");

    const v = validerDepot(input);
    if (!v.ok) return { statut: "REJETE", raison: v.raison };
    const emission = await emettrePieceDeposee(v.depot);
    return await mettreEnFile(v.depot, v.depot.empreinte, emission.statut);
  } catch (err) {
    console.error("[enrichissement] signalement impossible (le dépôt, lui, est fait)", err);
    return { statut: "REJETE", raison: "signalement impossible" };
  }
}

async function mettreEnFile(
  depot: PieceDeposeeInput,
  empreinte: string | null,
  emission: ResultatEmission["statut"] | "DIRECT",
): Promise<ResultatSignalement> {
  // Le dépôt direct n'est pas passé par `validerDepot` (son empreinte n'en est pas une) : on lui
  // applique ici les mêmes exigences sur ce qui reste (blob, rattachements).
  const rattachements = (empreinte ? depot.rattachements : validerSansEmpreinte(depot)) ?? [];
  if (!depot.blobId?.trim() || rattachements.length === 0) return { statut: "REJETE", raison: "blob ou rattachement absent" };
  const confidentiality = depot.confidentialite as Confidentiality;
  const data: Prisma.TacheEnrichissementCreateManyInput[] = rattachements.map((r) => ({
    cle: cleTache(empreinte, depot.blobId, r),
    empreinte,
    blobId: depot.blobId,
    nomFichier: nomPourRegistre(depot.nomFichier || "sans-nom", depot.confidentialite),
    mime: depot.mime || "application/octet-stream",
    taille: depot.taille,
    source: depot.source,
    confidentiality,
    rattachementType: r.type,
    rattachementId: r.id,
    role: r.role,
    deposeParId: depot.deposeParId,
    ...(depot.deposeLe ? { deposeLe: depot.deposeLe } : {}),
  }));
  const { count } = await prisma.tacheEnrichissement.createMany({ data, skipDuplicates: true });
  return { statut: "SIGNALE", emission: emission === "DIRECT" ? "REJETE" : emission, misesEnFile: count };
}

/** Les rattachements d'un dépôt direct, validés comme les autres — via une empreinte fictive. */
function validerSansEmpreinte(depot: PieceDeposeeInput): Rattachement[] | null {
  const v = validerDepot({ ...depot, empreinte: "0".repeat(64) });
  return v.ok ? v.depot.rattachements : null;
}

/**
 * Le dépôt d'un `Document` de module (goulots `persistUploadedDocument`, `attachFiles`) : la fiche
 * métier (« passeport » du poste, « justificatif » de la demande) et le document lui-même, dont la
 * pièce recevra la colonne `Document.pieceId`.
 */
export function rattachementsDocument(d: { id: string; entityType: string; entityId: string; category: string }): Rattachement[] {
  return [
    { type: d.entityType, id: d.entityId, role: d.category },
    { type: "DOCUMENT", id: d.id, role: "fichier" },
  ];
}

/** Un `Document` de module vient d'être écrit (goulots `persistUploadedDocument`, `attachFiles`). */
export function signalerDocumentDepose(d: {
  documentId: string; entityType: string; entityId: string; category: string; confidentiality: ConfidentialitePiece;
  blobId: string; sha256: string; nom: string; mime: string | null; taille: number; deposeParId: string | null;
}): Promise<ResultatSignalement> {
  return signalerDepot({
    blobId: d.blobId,
    empreinte: d.sha256,
    nomFichier: d.nom,
    mime: d.mime ?? "",
    taille: d.taille,
    source: sourceDeLEntite(d.entityType),
    deposeParId: d.deposeParId,
    rattachements: rattachementsDocument({ id: d.documentId, entityType: d.entityType, entityId: d.entityId, category: d.category }),
    confidentialite: confidentialitePourEnrichissement(d.confidentiality, { category: d.category, entityType: d.entityType }),
  });
}

/** Un fichier vient d'entrer au Drive, ou une nouvelle version (goulot `enregistrerFichierDrive`). */
export async function signalerFichierDrive(f: {
  nodeId: string; version: number | null; blobId: string; sha256: string | null; nom: string; mime: string; taille: number; deposeParId: string;
}): Promise<ResultatSignalement> {
  let empreinte = f.sha256;
  if (!empreinte) {
    // L'appelant n'a pas l'empreinte sous la main : celle du blob (`direct:…` pour un envoi direct).
    try {
      empreinte = (await prisma.fileBlob.findUnique({ where: { id: f.blobId }, select: { sha256: true } }))?.sha256 ?? null;
    } catch {
      empreinte = null;
    }
  }
  if (!empreinte) return { statut: "REJETE", raison: "empreinte du blob introuvable" };
  return signalerDepot({
    blobId: f.blobId,
    empreinte,
    nomFichier: f.nom,
    mime: f.mime,
    taille: f.taille,
    source: f.version && f.version > 1 ? "DRIVE_VERSION" : "DRIVE",
    deposeParId: f.deposeParId,
    rattachements: [{ type: "DRIVE_NODE", id: f.nodeId, role: f.version && f.version > 1 ? "version" : "fichier" }],
    confidentialite: "INTERNAL",
  });
}
