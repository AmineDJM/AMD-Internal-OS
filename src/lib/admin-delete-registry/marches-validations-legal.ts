/**
 * Registre des suppressions — les entrées : l'appel d'offres PCH et sa ligne, la demande de validation, le courrier, le document légal,
 * le contrat de consulting, la demande « autre » Ad & Pro.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { prisma } from "@/lib/prisma";
import { refusSuppressionDeLaPiece } from "@/lib/queries/suppression-piece";
import { refusSuppressionCommandePch, refusSuppressionLotDeMarche } from "@/lib/queries/suppression-refus";
import { retirerEnAttente } from "@/lib/bons-de-commande/aiguillage";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_MARCHES_VALIDATIONS_LEGAL = {
  PCH_TENDER: {
    label: "appel d'offres",
    module: "PCH",
    redirect: "/pch",
    model: "pchTender",
    entityType: "PCH_TENDER",
    // Ses lots, ses bons de commande, leurs lignes et leurs livraisons partaient en CASCADE, sans
    // corbeille (audit 360°, I17) : un clic effaçait des mois de suivi de marché. Le lot les instantane
    // tous, et tout revient ensemble à la restauration (§118.162) ; ce qui a quitté l'ERP refuse.
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.pchTender.findUnique({ where: { id }, select: { title: true, reference: true } });
      return r ? `${r.reference}${r.title ? ` — ${r.title}` : ""}` : null;
    },
    async remove(id) {
      await prisma.pchTender.delete({ where: { id } });
    },
  },
  PCH_ORDER: {
    label: "bon de commande de marché",
    module: "PCH",
    redirect: "/pch",
    model: "pchOrder",
    entityType: "PCH_ORDER",
    refuse: refusSuppressionCommandePch,
    // UN LOT (DONNEES-15) : lignes et livraisons attendues partent et reviennent avec lui (avant : un `delete` nu).
    lot: true,
    async describe(id) {
      const r = await prisma.pchOrder.findUnique({ where: { id }, select: { reference: true, tender: { select: { reference: true } } } });
      return r ? `${r.reference ?? "Bon de commande"} — marché ${r.tender.reference}` : null;
    },
    async remove(id) {
      await prisma.pchOrder.delete({ where: { id } });
    },
  },
  PCH_TENDER_LINE: {
    label: "lot d'appel d'offres",
    module: "PCH",
    redirect: "/pch",
    model: "pchTenderLine",
    // SANS type d'entité : un lot n'a ni pièces jointes ni commentaires à lui — ils vivent sur son marché.
    // Il partait d'un seul `delete`, sans corbeille ni journal (vague « restes ») ; le lot instantane la
    // ligne et ses affectations à des BU, et tout revient ensemble à la restauration (§118.162).
    lot: true,
    searchFields: ["designation"],
    async describe(id) {
      const r = await prisma.pchTenderLine.findUnique({ where: { id }, select: { designation: true, tender: { select: { reference: true } } } });
      return r ? `${r.designation} — ${r.tender.reference}` : null;
    },
    refuse: refusSuppressionLotDeMarche,
    async remove(id) {
      await prisma.pchTenderLine.delete({ where: { id } });
    },
  },
  VALIDATION_REQUEST: {
    label: "demande de validation",
    module: "Validations",
    redirect: "/validations",
    model: "validationRequest",
    entityType: "VALIDATION_REQUEST",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.validationRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.validationRequest.delete({ where: { id } });
    },
  },
  MAIL_ENTRY: {
    label: "courrier",
    module: "Courriers",
    redirect: "/courriers",
    model: "mailEntry",
    entityType: "MAIL_ENTRY",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.mailEntry.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? (r.reference ? `${r.reference} — ${r.title}` : r.title) : null;
    },
    async creatorOf(id) {
      const r = await prisma.mailEntry.findUnique({ where: { id }, select: { createdById: true } });
      return r?.createdById ?? null;
    },
    async remove(id) {
      await prisma.mailEntry.delete({ where: { id } });
    },
  },
  LEGAL_DOCUMENT: {
    label: "document légal",
    module: "Legal",
    redirect: "/legal",
    model: "legalDocument",
    entityType: "LEGAL_DOCUMENT",
    searchFields: ["reference", "title"],
    // CE QUI NE SE SUPPRIME PAS (§118.209) : une pièce signée, réglée, partie au règlement, validée par un
    // centre, ou dont une autre pièce découle. Le refus vit chez l'ÉCRIVAIN : la fiche Legal, la demande
    // Ad & Pro et la corbeille du Super Admin passent par ici, et deux règles finiraient par ne pas refuser
    // la même chose (§118.106). Il NOMME le geste qui reste (annuler, supprimer l'aval d'abord…).
    refuse: (id) => refusSuppressionDeLaPiece(id),
    async describe(id) {
      const r = await prisma.legalDocument.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? (r.reference ? `${r.reference} — ${r.title}` : r.title) : null;
    },
    async creatorOf(id) {
      const r = await prisma.legalDocument.findUnique({ where: { id }, select: { createdById: true } });
      return r?.createdById ?? null;
    },
    async remove(id) {
      // Une validation qui attend au centre sur une pièce qui n'existe plus serait un arbitrage à rendre sur
      // rien : la porte part avec le bon de commande (la fiche Legal ne la retirait pas, l'action d'Adam si).
      // APRÈS la suppression de la ligne : la porte est désignée par un couple (type, identifiant) que rien ne
      // lie par clé étrangère — si la suppression refuse (lien bloquant), la porte reste, la pièce aussi.
      await prisma.legalDocument.delete({ where: { id } });
      await retirerEnAttente(id);
    },
  },

  /**
   * UN CONTRAT DE CONSULTING et UNE « AUTRE DEMANDE » Ad & Pro — les deux natures du pôle qui
   * n'avaient AUCUNE suppression (§118.162). « Toute demande est liée du début à la fin à ses
   * branches » ne pouvait pas valoir pour cinq natures sur sept : elles passent par le même lot.
   */
  CONSULTING_CONTRACT: {
    label: "contrat de consulting",
    module: "Consulting",
    redirect: "/consulting",
    model: "consultingContract",
    entityType: "CONSULTING_CONTRACT",
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.consultingContract.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.consultingContract.delete({ where: { id } });
    },
  },
  AD_PRO_OTHER: {
    label: "autre demande Ad & Pro",
    module: "Ad & Pro",
    redirect: "/ad-pro/autres",
    model: "adProOtherRequest",
    entityType: "AD_PRO_OTHER",
    lot: true,
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.adProOtherRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.adProOtherRequest.delete({ where: { id } });
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
