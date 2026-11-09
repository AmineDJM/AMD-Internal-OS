import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { moneyEntityOf } from "@/lib/company";
import { persistUploadedDocument } from "@/lib/documents";
import { readFileByKey, deleteFileByKey } from "@/lib/storage";
import { sansBloquer } from "@/lib/journal";
import { SELECT_DEVIS, devisLu } from "@/lib/queries/promo-circuit";
import { totauxDuDevis } from "@/lib/promo-material/devis";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DEVIS DU MATÉRIEL PROMOTIONNEL ENTRE AU REGISTRE LEGAL (Direction, 09/11/2026).
 *
 * « Quand on ajoute un devis dans Ad & Pro, il doit être ajouté automatiquement à Legal. » Le devis d'un POSTE y entrait
 * déjà (`ajouterDevisPoste`), celui du SECRÉTARIAT aussi (`deposerDevisDemande`) ; celui du MATÉRIEL PROMOTIONNEL —
 * retranscrit par l'assistante — ne vivait que dans le dossier : son scan comme pièce du dossier, ses lignes à part. Le
 * registre n'en savait rien, et l'on cherchait dans Legal un devis qui n'y était jamais arrivé.
 *
 * Chaque devis retranscrit porte désormais SA pièce Legal (`PromoQuote.legalDocumentId`) : nature « devis », source le
 * dossier, le fournisseur de l'annuaire en partie, son numéro, sa date, son total TTC calculé sur ses lignes, et son
 * scan. Une correction met la pièce à jour (et y joint le nouveau scan) ; un devis retiré pendant la retranscription
 * retire sa pièce. Les lecteurs du dossier la lisent par la porte des pièces de matériel promotionnel
 * (`accesAuxPiecesLegal`, source PROMO_MATERIAL) ; le module Legal la voit au registre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le fichier d'un scan du dossier, relu pour être joint à la pièce Legal (un devis enregistré sans nouveau scan). */
async function fichierDuScan(documentId: string): Promise<File | null> {
  const d = await prisma.document.findUnique({ where: { id: documentId }, select: { name: true, fileKey: true, mimeType: true } });
  if (!d?.fileKey) return null;
  const octets = await readFileByKey(d.fileKey).catch(sansBloquer("devis-au-registre.lecture-scan", null));
  return octets ? new File([new Uint8Array(octets)], d.name, { type: d.mimeType ?? "application/octet-stream" }) : null;
}

/**
 * INSCRIRE (ou mettre à jour) LA PIÈCE LEGAL D'UN DEVIS RETRANSCRIT. `scan` : le fichier que ce geste vient de joindre —
 * il rejoint la pièce ; sans lui, une pièce NOUVELLE reprend le scan que le devis porte déjà. Rend l'identifiant de la
 * pièce, ou la raison d'un échec (le devis, lui, est enregistré : l'appelant le dit sans rien annuler).
 */
export async function inscrireDevisPromoAuRegistre(
  userId: string, quoteId: string, scan: File | null,
): Promise<{ ok: true; legalDocumentId: string; cree: boolean } | { ok: false; raison: string }> {
  const q = await prisma.promoQuote.findUnique({
    where: { id: quoteId },
    select: {
      ...SELECT_DEVIS, legalDocumentId: true,
      promoMaterial: { select: { id: true, reference: true, title: true, companyId: true, requesterId: true } },
    },
  });
  if (!q) return { ok: false, raison: "devis introuvable" };
  const pm = q.promoMaterial;
  const ttc = totauxDuDevis(devisLu(q)).ttc;
  const champs = {
    title: `Devis ${q.supplierName}${q.reference ? ` n° ${q.reference}` : ""} — ${pm.reference} ${pm.title}`.trim(),
    reference: q.reference,
    counterparty: q.supplierName,
    counterpartyIds: q.supplierId ? [q.supplierId] : [],
    amount: ttc > 0 ? ttc : null,
    startDate: q.quoteDate,
    updatedById: userId,
  };

  const existante = q.legalDocumentId
    ? await prisma.legalDocument.findUnique({ where: { id: q.legalDocumentId }, select: { id: true } })
    : null;
  let legalDocumentId: string;
  let cree = false;
  if (existante) {
    await prisma.legalDocument.update({ where: { id: existante.id }, data: champs });
    legalDocumentId = existante.id;
  } else {
    const nouvelle = await prisma.legalDocument.create({
      data: {
        ...champs,
        kind: "QUOTE",
        companyId: pm.companyId ?? (pm.requesterId ? await moneyEntityOf(pm.requesterId) : null),
        sourceType: "PROMO_MATERIAL", sourceId: pm.id,
        createdById: userId,
        notes: `Devis retranscrit pour le matériel promotionnel ${pm.reference} — ${pm.title}.`,
      },
      select: { id: true },
    });
    // UNE SEULE PIÈCE PAR DEVIS, même à deux enregistrements simultanés : le rattachement est conditionnel, et la
    // pièce du perdant est retirée aussitôt.
    const rattache = await prisma.promoQuote.updateMany({ where: { id: q.id, legalDocumentId: null }, data: { legalDocumentId: nouvelle.id } });
    if (rattache.count === 0) {
      await prisma.legalDocument.delete({ where: { id: nouvelle.id } }).catch(sansBloquer("devis-au-registre.course"));
      const gagnant = await prisma.promoQuote.findUnique({ where: { id: q.id }, select: { legalDocumentId: true } });
      if (!gagnant?.legalDocumentId) return { ok: false, raison: "devis retiré entre-temps" };
      await prisma.legalDocument.update({ where: { id: gagnant.legalDocumentId }, data: champs }).catch(sansBloquer("devis-au-registre.maj-gagnant"));
      legalDocumentId = gagnant.legalDocumentId;
    } else {
      legalDocumentId = nouvelle.id;
      cree = true;
    }
  }

  // LE SCAN, JOINT À LA PIÈCE : celui de ce geste, ou — pour une pièce neuve — celui que le devis porte déjà.
  const fichier = scan ?? (cree && q.documentId ? await fichierDuScan(q.documentId) : null);
  if (fichier) {
    const depot = await persistUploadedDocument(userId, {
      entityType: "LEGAL_DOCUMENT", entityId: legalDocumentId, category: "QUOTE", confidentiality: "INTERNAL", stepKey: null, file: fichier,
    });
    if (!depot.ok) console.error("[devis promo → Legal] scan non joint à la pièce", depot.error);
  }
  await recordAudit({
    actorId: userId, action: cree ? "CREATE" : "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: legalDocumentId,
    summary: `${cree ? "Devis inscrit au registre" : "Devis mis à jour"} depuis le matériel promotionnel ${pm.reference} — ${q.supplierName}`,
  });
  return { ok: true, legalDocumentId, cree };
}

/** UN DEVIS RETIRÉ pendant la retranscription retire sa pièce Legal — ses fichiers compris. Sans pièce : rien. */
export async function retirerDevisPromoDuRegistre(userId: string, legalDocumentId: string | null, quoi: string): Promise<void> {
  if (!legalDocumentId) return;
  const fichiers = await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: legalDocumentId }, select: { id: true, fileKey: true } });
  await prisma.document.deleteMany({ where: { id: { in: fichiers.map((f) => f.id) } } });
  for (const f of fichiers) if (f.fileKey) await deleteFileByKey(f.fileKey).catch(sansBloquer("devis-au-registre.fichier"));
  await prisma.legalDocument.delete({ where: { id: legalDocumentId } }).catch(sansBloquer("devis-au-registre.retrait"));
  await recordAudit({
    actorId: userId, action: "DELETE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: legalDocumentId,
    summary: `Devis retiré du registre — ${quoi} (retiré pendant la retranscription)`,
  });
}
