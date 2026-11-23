import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { libellePosteScinde } from "../../domaine/choix-agences";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHOIX DES AGENCES ÉCRIT, D'UN SEUL TENANT (Direction, 23/11/2026) — `retenirLignesDesAgences`.
 *
 * Tout ou rien, dans UNE transaction : les postes nés de la scission (un par agence en plus de la première), leur
 * exécution recopiée (prospection, cahier des charges, assistante, devis transmis), le lien de CHAQUE devis déplacé sur
 * le poste de son agence, et les lignes cochées validées pour ce poste — exactement elles : une ligne non cochée d'un
 * devis retenu ne reste validée nulle part. Les écritures sont CONDITIONNELLES (§118.187) : un poste qui a changé
 * entre la lecture et l'écriture, un devis déjà déplacé, une ligne validée entre-temps pour un autre poste — tout est
 * défait et la phrase le dit. Ce qui suit (la décision, le brouillon du BC) se fait poste par poste, chacun ayant déjà
 * ses devis et ses lignes : un échec y laisse un poste « à choisir », jamais un état mêlé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un refus lu pendant l'écriture : la transaction est défaite, la phrase remonte telle quelle. */
export class RefusChoixAgences extends Error {}

/** Une agence retenue, telle que l'écriture la reçoit — la première reste sur le poste d'origine. */
interface AgenceAEcrire {
  pieceId: string;
  agence: string;
  ligneIds: readonly string[];
}

const MEME_EXECUTION = {
  prospectionDemandeeAt: true, prospectionDemandeeParId: true, cahierDesCharges: true, assistanteId: true,
  devisTransmisAt: true, devisTransmisParId: true, agenceRetenueAt: true,
} as const;

/**
 * ÉCRIRE LE CHOIX — rend, pour chaque devis retenu, le poste qui le porte désormais (le premier : le poste d'origine).
 * Lève `RefusChoixAgences` quand l'état lu a changé ; toute autre erreur remonte aussi, et rien n'est écrit.
 */
export async function ecrireChoixDesAgences(a: {
  origineId: string;
  userId: string;
  retenues: readonly AgenceAEcrire[];
}): Promise<Map<string, string>> {
  const [premiere, ...suivantes] = a.retenues;
  if (!premiere) throw new RefusChoixAgences("Cochez au moins une ligne d'un devis.");
  return prisma.$transaction(async (tx) => {
    const origine = await tx.adProItem.findUnique({
      where: { id: a.origineId },
      select: {
        id: true, label: true, kind: true, status: true, budgetKind: true, voie: true, conformiteRequise: true, addedAfterDecision: true,
        submittedAt: true, opsDecidedAt: true, opsDecidedById: true, opsDecisionNote: true,
        sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true,
        execution: { select: MEME_EXECUTION },
        productAllocations: { select: { productId: true, sharePct: true, tenderLineId: true } },
      },
    });
    if (!origine || origine.status !== "PENDING") throw new RefusChoixAgences("Ce poste vient de changer (décision prise ou renvoyé) : rouvrez la fiche.");
    const exec = origine.execution;
    if (!exec?.devisTransmisAt || exec.agenceRetenueAt) throw new RefusChoixAgences("L'agence vient d'être choisie pour ce poste : rouvrez la fiche.");

    const posteDe = new Map<string, string>([[premiere.pieceId, origine.id]]);
    if (suivantes.length > 0) {
      // LE MÊME RATTACHEMENT (une seule colonne parent renseignée, contrainte `AdProItem_one_parent`).
      const rattachement = {
        sponsoringId: origine.sponsoringId, congressNationalId: origine.congressNationalId, congressInternationalId: origine.congressInternationalId,
        eventId: origine.eventId, otherRequestId: origine.otherRequestId, trainingId: origine.trainingId,
      };
      const colonne = Object.entries(rattachement).find(([, v]) => v)?.[0];
      const dernier = colonne
        ? await tx.adProItem.findFirst({ where: { [colonne]: rattachement[colonne as keyof typeof rattachement] }, orderBy: { position: "desc" }, select: { position: true } })
        : null;
      let position = dernier?.position ?? 0;
      for (const r of suivantes) {
        const cree = await tx.adProItem.create({
          data: {
            ...rattachement,
            kind: origine.kind, label: libellePosteScinde(origine.label, r.agence), supplier: r.agence,
            notes: `Né de la scission du poste « ${origine.label} » : ${r.agence}, retenue par la Direction Marketing sur ses lignes cochées.`,
            budgetKind: origine.budgetKind, voie: origine.voie, conformiteRequise: origine.conformiteRequise, addedAfterDecision: origine.addedAfterDecision,
            // LE MÊME TEMPS DE VALIDATION que le poste d'origine : soumis, la Direction des opérations passée — il attend la Direction Marketing.
            status: "PENDING", submittedAt: origine.submittedAt, opsDecidedAt: origine.opsDecidedAt, opsDecidedById: origine.opsDecidedById,
            opsDecisionNote: origine.opsDecisionNote, position: ++position, createdById: a.userId, updatedById: a.userId,
          },
          select: { id: true },
        });
        await tx.adProExecutionPoste.create({
          data: {
            itemId: cree.id, prospectionDemandeeAt: exec.prospectionDemandeeAt, prospectionDemandeeParId: exec.prospectionDemandeeParId,
            cahierDesCharges: exec.cahierDesCharges, assistanteId: exec.assistanteId, devisTransmisAt: exec.devisTransmisAt, devisTransmisParId: exec.devisTransmisParId,
          },
        });
        // La ventilation par produit suit en PARTS (un montant saisi valait pour le poste entier : il ne se recopie pas).
        const parts = origine.productAllocations.filter((p) => p.sharePct != null);
        if (parts.length > 0) {
          await tx.adProProductAllocation.createMany({ data: parts.map((p) => ({ itemId: cree.id, productId: p.productId, sharePct: p.sharePct, tenderLineId: p.tenderLineId })) });
        }
        // LE DEVIS DE L'AGENCE PART AVEC ELLE — le lien (son déposant reste celui qui vérifie le BC), et aucun brouillon d'avant.
        const lien = await tx.adProItemPiece.updateMany({ where: { itemId: origine.id, legalDocumentId: r.pieceId, nature: "DEVIS" }, data: { itemId: cree.id } });
        if (lien.count !== 1) throw new RefusChoixAgences(`Le devis de ${r.agence} n'est plus rattaché à ce poste : rouvrez la fiche.`);
        await tx.adProDevis.updateMany({ where: { legalDocumentId: r.pieceId }, data: { bcBrouillon: Prisma.DbNull } });
        posteDe.set(r.pieceId, cree.id);
      }
    }

    // LES LIGNES COCHÉES, validées pour le poste de leur agence — exactement elles.
    const maintenant = new Date();
    for (const r of a.retenues) {
      const cible = posteDe.get(r.pieceId)!;
      const ids = [...r.ligneIds];
      const valide = await tx.adProDevisLigne.updateMany({
        where: { id: { in: ids }, devis: { legalDocumentId: r.pieceId }, OR: [{ validatedItemId: null }, { validatedItemId: origine.id }, { validatedItemId: cible }] },
        data: { validatedItemId: cible, validatedAt: maintenant, validatedById: a.userId },
      });
      if (valide.count !== ids.length) throw new RefusChoixAgences(`Une ligne du devis de ${r.agence} vient d'être validée pour un autre poste, ou retirée du devis : rouvrez la fiche.`);
      await tx.adProDevisLigne.updateMany({
        where: { devis: { legalDocumentId: r.pieceId }, id: { notIn: ids }, validatedItemId: { in: [origine.id, cible] } },
        data: { validatedItemId: null, validatedAt: null, validatedById: null },
      });
    }
    return posteDe;
  });
}

/**
 * DÉFAIRE LES LIGNES RETENUES d'un devis dont l'accord n'a pas tenu — le poste redevient « à choisir » avec ses devis :
 * ses lignes ne restent pas validées pour rien (le geste que le choix d'un devis entier faisait déjà).
 */
export async function defaireLesLignesRetenues(itemId: string, pieceId: string): Promise<void> {
  await prisma.adProDevisLigne.updateMany({
    where: { validatedItemId: itemId, devis: { legalDocumentId: pieceId }, bcId: null },
    data: { validatedItemId: null, validatedAt: null, validatedById: null },
  });
}
