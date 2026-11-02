import type { Confidentiality, SourcePiece } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { confidentialitePourEnrichissement, sourceDeLEntite, sourcePieceDe } from "@/lib/enrichissement/file";
import { cleAcces, FAMILLES, famillesDe, type Famille } from "../domaine/familles";
import { formatDe, plier, titreDe } from "../domaine/format";
import { plusStricte } from "../domaine/politique";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'INSCRIPTION UNIQUE — « toute pièce qui entre dans la plateforme, quelle que soit la porte,
 * est inscrite au même registre et lue une fois pour toutes » (J1, décision du 29/10/2026).
 *
 * Chaque point d'entrée (Drive, messagerie, pièces de module, RH, réunions, rapports terrain, courriels,
 * Assistant IA…) appelle `inscrirePiece` APRÈS son écriture métier, une fois l'objet créé :
 *
 *   1. le REGISTRE R5 — `Piece` (une par empreinte : `piece_<sha256>`, la convention de l'enrichissement)
 *      et `PieceLien` (l'endroit où elle est rangée, type ENTITE) ; un registre, pas un troisième ;
 *   2. la FICHE de bibliothèque — titre, format, source, confidentialité (la plus stricte l'emporte), et
 *      la CLÉ D'ACCÈS de l'endroit (« DRIVE_NODE:… ») : la recherche ne rend la pièce qu'à qui peut ouvrir
 *      l'un de ses endroits, par la règle de l'écran qui la sert ;
 *   3. la FILE : une fiche neuve naît `A_FAIRE` ; la tâche de fond `bibliotheque.ingestion` la lira.
 *      Une pièce déjà lue (même empreinte, ailleurs) ne se relit pas : elle gagne une clé, c'est tout.
 *
 * ── NE FAIT JAMAIS ÉCHOUER LE DÉPÔT ─────────────────────────────────────────────────────────
 *
 * Comme le signalement de l'enrichissement : un téléversement réussi reste réussi. Cette fonction ne
 * lève pas, elle rend un statut ; une inscription manquée se rattrape (`infra/rattrapage.ts`).
 *
 * Le test-cliquet `src/modules/bibliotheque/inscription-cliquet.test.ts` vérifie que tout fichier qui
 * écrit au coffre (`putBlob`, `saveFile`) inscrit ce qu'il écrit — ou figure, nommé et justifié, parmi
 * les exceptions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface InscriptionPiece {
  /** `FileBlob.id` (rendu par `putBlob` / `saveFile`). */
  blobId: string;
  /** SHA-256 du contenu quand l'appelant l'a (`putBlob().sha256`) ; sinon relu sur le blob. */
  empreinte?: string | null;
  nom: string;
  mime?: string | null;
  taille?: number | null;
  source: SourcePiece;
  /** L'endroit où la pièce est rangée — sa règle d'ouverture est celle de la recherche. */
  objet: { famille: Famille; id: string };
  /** Défaut INTERNAL ; une pièce rangée à plusieurs endroits garde la plus stricte. */
  confidentialite?: Confidentiality;
  /** Qui l'a déposée (`null` : un système — courriel entrant, synchronisation). */
  proprietaireId: string | null;
  /** Le rôle de la pièce à cet endroit (« fichier », « pièce-jointe », « version »…). */
  role?: string;
  /** La date du document (défaut : maintenant). */
  date?: Date;
}

export type ResultatInscription =
  | { statut: "INSCRITE"; pieceId: string; nouvelle: boolean }
  | { statut: "REJETEE"; raison: string };

/** L'identifiant d'une pièce : le même que celui de l'enrichissement (`enrichissement/file.ts`). */
const pieceIdDe = (empreinte: string): string => `piece_${empreinte}`;

const SHA256 = /^[0-9a-f]{64}$/;

async function empreinteDuBlob(blobId: string): Promise<string | null> {
  const b = await prisma.fileBlob.findUnique({ where: { id: blobId }, select: { sha256: true } });
  return b?.sha256 ?? null;
}

export async function inscrirePiece(p: InscriptionPiece): Promise<ResultatInscription> {
  try {
    if (!p.blobId?.trim()) return { statut: "REJETEE", raison: "blob absent" };
    const cle = cleAcces(p.objet.famille, p.objet.id);
    let empreinte = (p.empreinte ?? "").trim().toLowerCase();
    if (!SHA256.test(empreinte)) empreinte = (await empreinteDuBlob(p.blobId)) ?? "";
    // Un dépôt direct au bucket porte `direct:<clé>` tant que l'ingestion n'a pas relu ses octets.
    if (!empreinte) return { statut: "REJETEE", raison: "empreinte du blob introuvable" };

    const pieceId = pieceIdDe(empreinte);
    const nom = (p.nom ?? "").trim().slice(0, 300) || "sans-nom";
    const confidentiality: Confidentiality = p.confidentialite ?? "INTERNAL";
    const date = p.date ?? new Date();

    // 1. LE REGISTRE — la pièce (une fois), puis son lien à l'endroit.
    await prisma.piece.upsert({
      where: { id: pieceId },
      create: {
        id: pieceId, blobId: p.blobId, empreinte, nom, mime: p.mime ?? null, taille: p.taille ?? null,
        confidentiality, source: p.source, deposeeParId: p.proprietaireId, deposeeLe: date,
      },
      update: {},
    });
    if (confidentiality !== "INTERNAL") {
      const moins = confidentiality === "CONFIDENTIAL" ? (["INTERNAL", "RESTRICTED"] as const) : (["INTERNAL"] as const);
      await prisma.piece.updateMany({ where: { id: pieceId, confidentiality: { in: [...moins] } }, data: { confidentiality } });
    }
    await prisma.pieceLien.createMany({
      data: [{ pieceId, sujetType: "ENTITE", sujetId: p.objet.id, entityType: p.objet.famille, role: p.role ?? "fichier", creeParId: p.proprietaireId }],
      skipDuplicates: true,
    });

    // 2. UN ENDROIT EXCLUSIF ne désigne qu'un contenu : la clé quitte les pièces qu'il désignait avant.
    if (FAMILLES[p.objet.famille].exclusive) await retirerCleAilleurs(cle, pieceId);

    // 3. LA FICHE — née en file ; existante, elle gagne la clé (sans relecture : lue une fois pour toutes).
    const existante = await prisma.bibliothequeFiche.findUnique({ where: { pieceId }, select: { cles: true, confidentiality: true } });
    if (!existante) {
      const cles = [cle];
      const cree = await prisma.bibliothequeFiche.createMany({
        data: [{
          pieceId, blobId: p.blobId, titre: titreDe(nom), titrePlie: plier(titreDe(nom)), format: formatDe(nom, p.mime),
          mime: p.mime ?? null, taille: p.taille ?? null, source: p.source, confidentiality, cles, familles: famillesDe(cles),
          auteurId: p.proprietaireId, dateDocument: date,
        }],
        skipDuplicates: true,
      });
      if (cree.count === 1) return { statut: "INSCRITE", pieceId, nouvelle: true };
    }
    await ajouterCleALaFiche(pieceId, cle, confidentiality);
    return { statut: "INSCRITE", pieceId, nouvelle: false };
  } catch (err) {
    console.error("[bibliotheque] inscription impossible (le dépôt, lui, est fait)", err);
    return { statut: "REJETEE", raison: "inscription impossible" };
  }
}

/** Ajoute la clé (sans doublon, en une instruction : deux inscriptions simultanées ne s'écrasent pas). */
async function ajouterCleALaFiche(pieceId: string, cle: string, confidentialite: Confidentiality): Promise<void> {
  const famille = cle.slice(0, cle.indexOf(":"));
  await prisma.$executeRaw`
    UPDATE "BibliothequeFiche"
       SET "cles" = (SELECT array_agg(DISTINCT c ORDER BY c) FROM unnest(array_append(coalesce("cles", '{}'), ${cle}::text)) c),
           "familles" = (SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(array_append(coalesce("familles", '{}'), ${famille}::text)) f),
           "updatedAt" = now()
     WHERE "pieceId" = ${pieceId}`;
  const f = await prisma.bibliothequeFiche.findUnique({ where: { pieceId }, select: { confidentiality: true } });
  if (f && plusStricte(f.confidentiality, confidentialite) !== f.confidentiality) {
    await prisma.bibliothequeFiche.update({ where: { pieceId }, data: { confidentiality: confidentialite } });
  }
}

/** Retire une clé exclusive des autres fiches (l'ancienne version d'un fichier ne ressort plus par là). */
async function retirerCleAilleurs(cle: string, pieceId: string): Promise<void> {
  const autres = await prisma.bibliothequeFiche.findMany({ where: { cles: { has: cle }, NOT: { pieceId } }, select: { pieceId: true, cles: true } });
  for (const a of autres) {
    const cles = a.cles.filter((c) => c !== cle);
    await prisma.bibliothequeFiche.update({ where: { pieceId: a.pieceId }, data: { cles, familles: famillesDe(cles) } });
  }
}

// ─────────────────────────── Les formes courtes, par endroit ───────────────────────────

/** Le contenu tel que les écrivains le décrivent (ce que `putBlob` rend, et le fichier). */
interface Contenu { blobId: string; sha256?: string | null; nom: string; mime?: string | null; taille?: number | null }
const contenu = (c: Contenu) => ({ blobId: c.blobId, empreinte: c.sha256 ?? null, nom: c.nom, mime: c.mime ?? null, taille: c.taille ?? null });

/**
 * Une PIÈCE JOINTE (sujet, réunion, rapport terrain…) : la ligne créée par l'écrivain, et ce que `putBlob` a rendu.
 * Ouverte par la règle de sa famille ; rôle « pièce-jointe ».
 */
export function inscrirePieceJointe(
  famille: Famille, pj: { id: string; name: string; mime?: string | null }, ecrit: { blobId: string; sha256: string; size: number },
  p: { source: SourcePiece; proprietaireId: string | null },
): Promise<ResultatInscription> {
  return inscrirePiece({
    ...contenu({ blobId: ecrit.blobId, sha256: ecrit.sha256, nom: pj.name, mime: pj.mime, taille: ecrit.size }),
    source: p.source, objet: { famille, id: pj.id }, proprietaireId: p.proprietaireId, role: "piece-jointe",
  });
}

// ─────────────────────────── Les pièces d'un `Document` de module ───────────────────────────

/**
 * Un `Document` de module (goulots `persistUploadedDocument`, `attachFiles`, `inscrireDocumentDirect`, et les
 * écrivains qui créent la ligne eux-mêmes) : sa source vient de l'entité, sa confidentialité est relevée comme
 * pour l'enrichissement (pièce d'identité, RH, congés → CONFIDENTIELLE).
 */
export function inscrireDocument(d: {
  documentId: string; entityType: string; category?: string | null; confidentiality?: Confidentiality | null;
  blobId: string; sha256?: string | null; nom: string; mime?: string | null; taille?: number | null; deposeParId: string | null;
}): Promise<ResultatInscription> {
  return inscrirePiece({
    ...contenu(d),
    source: sourcePieceDe(sourceDeLEntite(d.entityType)),
    objet: { famille: "DOCUMENT", id: d.documentId },
    confidentialite: confidentialitePourEnrichissement(d.confidentiality ?? "INTERNAL", { category: d.category ?? null, entityType: d.entityType }),
    proprietaireId: d.deposeParId,
    role: d.category ?? "fichier",
  });
}

/** Un fichier du Drive (nouveau, ou nouvelle version : la clé `DRIVE_NODE` est exclusive). */
export function inscrireFichierDrive(f: {
  nodeId: string; blobId: string; sha256?: string | null; nom: string; mime?: string | null; taille?: number | null;
  deposeParId: string | null; version?: number | null; source?: SourcePiece; confidentialite?: Confidentiality;
}): Promise<ResultatInscription> {
  return inscrirePiece({
    ...contenu(f),
    source: f.source ?? "DRIVE",
    objet: { famille: "DRIVE_NODE", id: f.nodeId },
    confidentialite: f.confidentialite,
    proprietaireId: f.deposeParId,
    role: f.version && f.version > 1 ? "version" : "fichier",
  });
}

/**
 * La forme courte pour les écrivains qui créent le `Document` eux-mêmes (`saveFile` puis `document.create`) :
 * la ligne créée et ce que `saveFile` a rendu — `null` quand l'écriture au coffre a échoué (la fiche ne porte
 * alors que des métadonnées : il n'y a rien à lire).
 */
export async function inscrireDocumentEcrit(
  doc: {
    id: string; entityType: string; category: string; confidentiality: Confidentiality; name: string;
    mimeType: string | null; sizeBytes: number | null; uploadedById: string | null;
  },
  ecrit: { blobId: string; sha256: string } | null,
): Promise<ResultatInscription | null> {
  if (!ecrit) return null;
  return inscrireDocument({
    documentId: doc.id, entityType: doc.entityType, category: doc.category, confidentiality: doc.confidentiality,
    blobId: ecrit.blobId, sha256: ecrit.sha256, nom: doc.name, mime: doc.mimeType, taille: doc.sizeBytes, deposeParId: doc.uploadedById,
  });
}

/**
 * Un `Document` qui existe déjà et dont le fichier vient d'être (ré)écrit — l'éditeur de texte, OnlyOffice, un
 * CV rattaché à un candidat dans une transaction. Le contenu se relit sur la clé du fichier (`StoredFile`) ;
 * la clé `DOCUMENT` étant exclusive, l'ancienne version ne ressort plus.
 */
export async function inscrireDocumentExistant(documentId: string, par?: string | null): Promise<ResultatInscription | null> {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, entityType: true, category: true, confidentiality: true, name: true, mimeType: true, sizeBytes: true, uploadedById: true, fileKey: true },
    });
    if (!doc?.fileKey) return null;
    const fichier = await prisma.storedFile.findUnique({ where: { key: doc.fileKey }, select: { blobId: true } });
    if (!fichier) return null;
    return inscrireDocumentEcrit({ ...doc, uploadedById: par ?? doc.uploadedById }, { blobId: fichier.blobId, sha256: "" });
  } catch (err) {
    console.error("[bibliotheque] inscription du document impossible", err);
    return null;
  }
}

/**
 * Un document du dossier RH (`EmployeeDocument` : bulletin, contrat, attestation, pièce d'identité). Toujours
 * CONFIDENTIEL : lu et indexé sur ce serveur, ouvert par la règle de `/api/rh/document/[id]`, jamais à un modèle.
 */
export function inscrireDocumentRh(d: {
  id: string; blobId: string; sha256?: string | null; nom: string; mime?: string | null; taille?: number | null; deposeParId: string | null;
}): Promise<ResultatInscription> {
  return inscrirePiece({
    ...contenu(d), source: "RH",
    objet: { famille: "RH_DOCUMENT", id: d.id }, confidentialite: "CONFIDENTIAL", proprietaireId: d.deposeParId, role: "dossier-rh",
  });
}
