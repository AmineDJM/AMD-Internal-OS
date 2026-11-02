import { prisma } from "@/lib/prisma";
import { confidentialitePourEnrichissement, sourceDeLEntite, TAILLE_MAX_ENRICHISSEMENT } from "@/lib/enrichissement/file";
import { enrichissementActif, rattachementsDocument, signalerDepot } from "@/lib/enrichissement/signalement";
import { bilanVide, type BilanReprise, type Reprise } from "../../domaine/reprises/types";

/**
 * LE RATTRAPAGE DES PIÈCES EXISTANTES (refonte, palier P4 « rattrapage par lots », lot V2-A).
 *
 * Les goulots ne signalent que les NOUVEAUX dépôts. Les documents de module déjà en base (passeports
 * des voyageurs, devis, contrats…) entrent ici dans la même file, comme s'ils venaient d'être déposés —
 * avec leur date de dépôt d'origine. Rejouable : la file est unique par (empreinte, rattachement), un
 * document déjà signalé ne crée rien. Exige l'interrupteur ouvert (sinon rien n'est écrit, et c'est dit).
 *
 * Hors périmètre de ce lot : les fichiers du Drive déjà présents (leur dernière version) — un second
 * rattrapage, même forme.
 */

const lireLot = (taille: number, apresId: string | null) =>
  prisma.document.findMany({
    where: { fileKey: { not: null }, ...(apresId ? { id: { gt: apresId } } : {}) },
    orderBy: { id: "asc" },
    take: taille,
    select: {
      id: true, name: true, mimeType: true, sizeBytes: true, fileKey: true, category: true, confidentiality: true,
      entityType: true, entityId: true, uploadedById: true, createdAt: true, pieceId: true,
    },
  });

export const repriseRattrapagePieces: Reprise = {
  cle: "rattrapage-pieces",
  titre: "Rattrapage des pièces existantes",
  description:
    "Met en file d'enrichissement les documents de module déjà en base (passeports, devis, contrats…), comme s'ils venaient d'être déposés. Lecture locale seulement ; un document déjà signalé ne crée rien.",

  async apercu(): Promise<BilanReprise> {
    const b = bilanVide();
    const [total, trop, deja] = await Promise.all([
      prisma.document.count({ where: { fileKey: { not: null } } }),
      prisma.document.count({ where: { fileKey: { not: null }, sizeBytes: { gt: TAILLE_MAX_ENRICHISSEMENT } } }),
      prisma.document.count({ where: { fileKey: { not: null }, pieceId: { not: null } } }),
    ]);
    b.lues = total;
    b.ignorees = trop;
    b.liees = deja;
    b.creees = Math.max(0, total - trop - deja);
    if (!(await enrichissementActif())) b.erreurs.push("L'enrichissement est fermé : l'exécution n'écrira rien tant que l'interrupteur n'est pas ouvert.");
    return b;
  },

  async executer({ taille, apresId }): Promise<BilanReprise & { suite: string | null }> {
    const b = bilanVide();
    if (!(await enrichissementActif())) {
      return { ...b, erreurs: ["L'enrichissement est fermé : ouvrez l'interrupteur avant le rattrapage."], suite: apresId ?? null };
    }
    const lot = await lireLot(Math.max(1, Math.min(taille, 500)), apresId ?? null);
    const stockes = await prisma.storedFile.findMany({ where: { key: { in: lot.map((d) => d.fileKey!) } }, select: { key: true, blobId: true } });
    const blobDe = new Map(stockes.map((s) => [s.key, s.blobId]));
    const blobs = await prisma.fileBlob.findMany({ where: { id: { in: [...new Set(stockes.map((s) => s.blobId))] } }, select: { id: true, sha256: true } });
    const empreinteDe = new Map(blobs.map((x) => [x.id, x.sha256]));

    for (const d of lot) {
      b.lues += 1;
      if (d.pieceId) { b.liees += 1; continue; }
      if ((d.sizeBytes ?? 0) > TAILLE_MAX_ENRICHISSEMENT) { b.ignorees += 1; continue; }
      const blobId = blobDe.get(d.fileKey!);
      const empreinte = blobId ? empreinteDe.get(blobId) : undefined;
      if (!blobId || !empreinte) { b.ignorees += 1; b.erreurs.push(`« ${d.name} » : contenu introuvable.`); continue; }
      const r = await signalerDepot({
        blobId, empreinte, nomFichier: d.name, mime: d.mimeType ?? "", taille: d.sizeBytes ?? 0,
        source: sourceDeLEntite(d.entityType), deposeParId: d.uploadedById, deposeLe: d.createdAt,
        rattachements: rattachementsDocument({ id: d.id, entityType: d.entityType, entityId: d.entityId, category: d.category }),
        confidentialite: confidentialitePourEnrichissement(d.confidentiality, { category: d.category, entityType: d.entityType }),
      });
      if (r.statut === "SIGNALE") {
        if (r.misesEnFile > 0) b.creees += 1;
        else b.liees += 1;
      } else {
        b.ignorees += 1;
        if (r.statut === "REJETE") b.erreurs.push(`« ${d.name} » : ${r.raison}.`);
      }
    }
    return { ...b, erreurs: b.erreurs.slice(0, 20), suite: lot.length === taille ? lot[lot.length - 1].id : null };
  },
};
