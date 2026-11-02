/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPOSEUR DU LIVE OFFICE — le seul endroit où `artifact/` rencontre le Drive.
 *
 * ── POURQUOI ICI, ET PAS DANS `artifact/` ───────────────────────────────────────────────
 *
 * Même dessein que `in-process/missions/` : le domaine déclare des PORTS, le pont les remplit.
 * Trois conséquences vérifiables :
 *
 *   • `artifact/` n'importe ni Prisma, ni `drive-storage` (un FOURNISSEUR au sens de
 *     `domains.ts`), ni `rbac` — donc aucune traversée de domaine, aucun cliquet ne bouge ;
 *   • le contrôle des DROITS est ici et nulle part ailleurs : un adaptateur ne peut pas lire un
 *     fichier auquel la personne n'a pas accès, parce qu'il n'a aucun moyen de lire un fichier ;
 *   • un test peut fournir un faux port et exercer tout le moteur sans base.
 *
 * ── LA RÈGLE DE DROITS, EXPLICITE ───────────────────────────────────────────────────────
 *
 * LIRE demande `canViewDrive`. ÉCRIRE demande `canEditDrive`. §74 : « mêmes droits que l'écran ».
 * Une personne qui ne peut pas modifier un fichier dans le Drive ne peut pas le modifier en
 * parlant à Adam — sinon la conversation serait une porte dérobée, ce que §7 du Mission Runtime
 * interdit déjà pour les missions et qui vaut identiquement ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { canEditDrive, canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { formatDeFichier } from "@/lib/artifact/adapters/registry";
import type {
  FicheDocument, PortAudit, PortDocuments, PortVision, PortsArtefact, VersionEcrite,
} from "@/lib/artifact/ports";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

/** Le dossier où atterrissent les « enregistrer sous » quand la personne n'en désigne pas. */
const DOSSIER_DEFAUT = "Documents Adam";

/**
 * Le port reçoit un `userId` ; il lui faut la personne COMPLÈTE pour évaluer les droits.
 * On la relit à chaque appel plutôt que de la porter en mémoire : un rôle révoqué à 14 h doit
 * fermer la porte à 14 h, pas à la fin de la session.
 */
async function personne(userId: string): Promise<SessionUser | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true },
  });
  if (!u || !u.isActive) return null;
  const access = await getAccess(u.id, u.role);
  return { id: u.id, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access };
}

async function ficheDeNode(nodeId: string): Promise<FicheDocument | null> {
  const node = await prisma.driveNode.findUnique({
    where: { id: nodeId },
    select: { id: true, name: true, mimeType: true, size: true, type: true, isTrashed: true },
  });
  if (!node || node.type !== "FILE" || node.isTrashed) return null;
  const derniere = await prisma.fileVersion.findFirst({
    where: { nodeId }, orderBy: { version: "desc" }, select: { version: true },
  });
  return {
    nodeId: node.id,
    nom: node.name,
    mime: node.mimeType,
    taille: node.size,
    version: derniere?.version ?? 1,
    format: formatDeFichier(node.name, node.mimeType),
  };
}

/** Ce fichier est-il le Word ou le PDF que la fabrique a produits pour CETTE pièce ? */
async function estLeFichierDeLaPiece(legalDocumentId: string, nodeId: string): Promise<boolean> {
  const doc = await prisma.legalDocument.findUnique({ where: { id: legalDocumentId }, select: { driveNodeId: true, custom: true } });
  if (!doc) return false;
  const f = (doc.custom as { fabrique?: { docx?: { nodeId?: string } | null; pdf?: { nodeId?: string } | null } } | null)?.fabrique;
  return [doc.driveNodeId, f?.docx?.nodeId, f?.pdf?.nodeId].some((id) => id === nodeId);
}

/**
 * LES DROITS DE LA PERSONNE SUR UN FICHIER, relus maintenant (Atelier, J3) : voir n'est pas modifier — un document
 * qu'on peut lire mais pas écrire s'ouvre en lecture seule, et sa modification est refusée AVANT d'être appliquée.
 */
export async function droitsSurDocument(userId: string, nodeId: string): Promise<{ voir: boolean; modifier: boolean }> {
  const u = await personne(userId);
  if (!u) return { voir: false, modifier: false };
  const acces = await resolveDriveAccess(u, nodeId);
  return { voir: canViewDrive(acces), modifier: canEditDrive(acces) };
}

/**
 * UN DOCUMENT SENSIBLE (Atelier, J3) — rattaché à un objet métier : une pièce juridique (contrat, pièce émise), un
 * courrier enregistré, un espace partagé. Rend la raison (affichée sur la carte de confirmation), ou `null`.
 */
export async function documentSensible(nodeId: string): Promise<string | null> {
  const n = await prisma.driveNode.findUnique({
    where: { id: nodeId },
    select: { spaceId: true, space: { select: { name: true } }, _count: { select: { legalDocs: true, mailEntries: true } } },
  });
  if (!n) return null;
  if (n._count.legalDocs > 0) return "ce fichier est une pièce juridique enregistrée (contrat, pièce émise)";
  if (n._count.mailEntries > 0) return "ce fichier est rattaché à un courrier enregistré";
  if (n.spaceId) return `ce fichier appartient à l'espace partagé « ${n.space?.name ?? "partagé"} »`;
  return null;
}

/** Les natures qu'aucun modèle externe ne lit (coffre, paie, contrat), et les noms qui les annoncent. */
const NATURES_SANS_VISION = new Set(["PASSEPORT", "CNI", "PERMIS_CONDUIRE", "VISA", "BULLETIN_PAIE", "RIB", "CONTRAT"]);
const NOM_SENSIBLE = /passeport|passport|\bcni\b|carte.?d.?identit|permis|visa|bulletin|fiche.?de.?paie|salaire|paie\b|\brib\b|relev[eé].?d.?identit|contrat|avenant/i;

/**
 * LA GARDE DE L'OCR VISION (décision 0019, suite) — rend la RAISON du refus, ou `null` si la page peut partir au modèle
 * de vision. Jamais : une pièce CONFIDENTIELLE, du coffre ou reconnue sensible (identité, paie, RIB), un contrat ou une
 * pièce juridique, un courrier enregistré, une pièce d'un dossier RH (famille fermée), un nom qui l'annonce.
 */
export async function gardeOcrVision(nodeId: string, version: number, nom: string): Promise<string | null> {
  if (NOM_SENSIBLE.test(nom)) return "le nom du fichier annonce une pièce sensible (identité, paie, RIB ou contrat)";
  const v = await prisma.fileVersion.findFirst({ where: { nodeId, version }, select: { blobId: true } });
  if (!v) return "version introuvable";
  const [fiches, pieces, sensible] = await Promise.all([
    prisma.bibliothequeFiche.findMany({ where: { blobId: v.blobId }, select: { confidentiality: true, sensible: true, nature: true, cles: true } }),
    prisma.piece.findMany({ where: { blobId: v.blobId }, select: { confidentiality: true, nature: true } }),
    documentSensible(nodeId),
  ]);
  if ([...fiches, ...pieces].some((f) => f.confidentiality === "CONFIDENTIAL")) return "la pièce est classée CONFIDENTIELLE";
  if (fiches.some((f) => f.sensible)) return "la pièce relève du coffre (identité, paie, RIB)";
  if ([...fiches, ...pieces].some((f) => f.nature && NATURES_SANS_VISION.has(f.nature))) return "la nature de la pièce (identité, paie, RIB ou contrat) interdit l'envoi au modèle";
  if (fiches.some((f) => f.cles.some((c) => c.startsWith("RH_DOCUMENT:")))) return "la pièce appartient à un dossier RH (famille fermée)";
  if (sensible && !sensible.startsWith("ce fichier appartient à l'espace partagé")) return sensible;
  return null;
}

const documents: PortDocuments = {
  async decrire(userId, nodeId) {
    const u = await personne(userId);
    if (!u) return null;
    if (!canViewDrive(await resolveDriveAccess(u, nodeId))) return null;
    return ficheDeNode(nodeId);
  },

  async lire(userId, nodeId, version) {
    const u = await personne(userId);
    if (!u) return null;
    if (!canViewDrive(await resolveDriveAccess(u, nodeId))) return null;
    const v = await prisma.fileVersion.findFirst({
      where: { nodeId, version }, select: { blobId: true },
    });
    if (!v) return null;
    return getBlob(v.blobId);
  },

  async ecrireVersion(userId, nodeId, octets, opts): Promise<VersionEcrite> {
    const u = await personne(userId);
    if (!u) throw new Error("compte introuvable ou désactivé");
    // ÉCRIRE exige le droit d'écrire. C'est la ligne qui empêche la conversation d'être une
    // porte dérobée : sans elle, « Adam, modifie ce contrat » contournerait le Drive.
    //
    // UNE SEULE EXCEPTION, et elle se prouve ici : la révision DÉLÉGUÉE d'une pièce de la
    // fabrique (§118.152). Le fichier d'un BC vit dans le Drive de celle qui l'a émis ; le
    // demandeur du dossier, qui le pilote, n'y a aucun droit — sa modification échouait sur une
    // exception. L'appelant nomme la PIÈCE, et le port vérifie que ce fichier est bien le SIEN
    // (son Word ou son PDF) : la délégation ouvre la pièce, jamais le Drive d'une autre personne.
    const parLaPiece = opts.piece ? await estLeFichierDeLaPiece(opts.piece, nodeId) : false;
    if (!parLaPiece && !canEditDrive(await resolveDriveAccess(u, nodeId))) {
      throw new Error("vous n'avez pas le droit de modifier ce document");
    }
    const { blobId, size, sha256 } = await putBlob(octets);
    const derniere = await prisma.fileVersion.findFirst({
      where: { nodeId }, orderBy: { version: "desc" }, select: { version: true },
    });
    const version = (derniere?.version ?? 0) + 1;
    await prisma.fileVersion.create({
      data: { nodeId, blobId, version, size, mimeType: opts.mime, note: opts.resume.slice(0, 1000), createdById: userId },
    });
    const n = await prisma.driveNode.update({ where: { id: nodeId }, data: { size, mimeType: opts.mime }, select: { name: true } });
    // La révision entre à la bibliothèque (J1) : la clé du nœud passe à ce contenu. Ne lève jamais.
    await inscrireFichierDrive({ nodeId, version, blobId, sha256, nom: n.name, mime: opts.mime, taille: size, deposeParId: userId });
    return { version, taille: size };
  },

  async creerFichier(userId, opts) {
    const u = await personne(userId);
    if (!u) throw new Error("compte introuvable ou désactivé");
    const nomDossier = opts.dossier ?? DOSSIER_DEFAUT;
    // Le fichier atterrit dans le Drive PERSONNEL de la personne : c'est là que ses droits
    // existent déjà, et cela évite qu'un « enregistrer sous » publie dans un espace partagé.
    const dossier = await prisma.driveNode.findFirst({
      where: { type: "FOLDER", name: nomDossier, ownerId: userId, spaceId: null, parentId: null, isTrashed: false },
      select: { id: true },
    }) ?? await prisma.driveNode.create({
      data: { name: nomDossier, type: "FOLDER", ownerId: userId, createdById: userId },
      select: { id: true },
    });
    const { blobId, size, sha256 } = await putBlob(opts.octets);
    const node = await prisma.driveNode.create({
      data: {
        name: opts.nom, type: "FILE", parentId: dossier.id, ownerId: userId, createdById: userId,
        mimeType: opts.mime, size, category: "Document",
        versions: { create: { blobId, version: 1, size, mimeType: opts.mime, createdById: userId } },
      },
      select: { id: true },
    });
    await inscrireFichierDrive({ nodeId: node.id, blobId, sha256, nom: opts.nom, mime: opts.mime, taille: size, deposeParId: userId });
    return { nodeId: node.id, version: 1 };
  },

  async chercher(userId, requete, limite) {
    const u = await personne(userId);
    if (!u) return [];
    const mots = requete.trim().split(/\s+/).filter((m) => m.length >= 2).slice(0, 6);
    if (mots.length === 0) return [];
    const candidats = await prisma.driveNode.findMany({
      where: {
        type: "FILE",
        isTrashed: false,
        // Tous les mots doivent figurer dans le nom : « contrat consulting mouffok » ne doit pas
        // remonter tous les contrats de l'entreprise.
        AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })),
      },
      select: { id: true, name: true, mimeType: true, size: true },
      orderBy: { updatedAt: "desc" },
      take: limite * 4,
    });
    const out: FicheDocument[] = [];
    for (const c of candidats) {
      if (out.length >= limite) break;
      // Le droit se vérifie nœud par nœud : un filtre SQL approximatif laisserait fuiter des noms.
      if (!canViewDrive(await resolveDriveAccess(u, c.id))) continue;
      const fiche = await ficheDeNode(c.id);
      if (fiche) out.push(fiche);
    }
    return out;
  },
};

const audit: PortAudit = {
  async tracer(opts) {
    await recordAudit({
      actorId: opts.userId,
      action: "UPDATE",
      module: "Drive",
      entityType: "DRIVE_NODE",
      entityId: opts.cible,
      // Le détail est un RÉSUMÉ d'opérations (« ¶1 → centré »), jamais le contenu du document :
      // §77 interdit de journaliser le corps d'un contrat.
      summary: `[${opts.action}] ${opts.detail}`.slice(0, 900),
    });
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VISION — et pourquoi elle n'écrit pas une ligne de lecture d'image de plus.
 *
 * Le repli à quatre niveaux (§38) existe déjà et il est éprouvé : parser déterministe, OCR
 * réel Tesseract, secours vision sur les pages faibles, LECTURE VISUELLE par le modèle quand
 * le texte est mince — avec sa note de méthode et de confiance. C'est le chemin qu'emprunte
 * une photo de facture jointe à la conversation.
 *
 * Une image sortie d'un document POSE EXACTEMENT LE MÊME PROBLÈME. Écrire ici un second
 * chemin donnerait deux qualités de lecture selon l'endroit d'où vient l'image, et l'un des
 * deux prendrait du retard sur l'autre. On appelle donc le même code, et la note qu'il produit
 * — celle qui dit « PROBABLE, chiffres à confirmer » — remonte telle quelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const vision: PortVision = {
  async lire(userId, octets, nom) {
    void userId; // Les droits ont été vérifiés à l'OUVERTURE du document : ici, on lit des octets.
    const { extractAttachmentText } = await import("@/platform/ia/media/assistant-files");
    const r = await extractAttachmentText(nom, octets);
    return { texte: r.text, note: r.note };
  },
};

export const portsArtefact: PortsArtefact = { documents, audit, vision };
