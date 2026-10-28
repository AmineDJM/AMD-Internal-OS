/**
 * Registre des suppressions — les entrées : l'appel d'offres PCH et sa ligne, la demande de validation, le courrier, le document légal,
 * le contrat de consulting, la demande « autre » Ad & Pro.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { prisma } from "@/lib/prisma";
import { refusSuppressionDeLaPiece } from "@/lib/queries/suppression-piece";
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
    /**
     * CE QUI DÉCOULE DU LOT NE SE DÉTACHE PAS EN SILENCE. Un bon de commande né de la ligne (`PchOrder.lineId`,
     * un lien TEXTE que Postgres ne vide pas : il désignerait un lot disparu) ou qui la porte en ligne, une
     * ligne de contrat de marché, une vente sous marché, la répartition d'un poste Ad & Pro : les quatre la
     * désignent, et la clé étrangère les viderait sans un mot — une vente sous marché passerait pour une vente
     * de VILLE (§118.118), un contrat ne dirait plus de quel lot il découle. On COMPTE sans nommer ce qui n'est
     * pas du marché : le titre d'un contrat passe par la porte de Legal, le libellé d'un poste par celle
     * d'Ad & Pro, et ce refus ne sait pas qui le lit (§118.118). Le remède est un geste qui EXISTE sur la ligne.
     */
    async refuse(id) {
      const [bons, lignesDeBon, lignesDeContrat, ventes, repartitions] = await Promise.all([
        prisma.pchOrder.findMany({ where: { lineId: id }, select: { id: true, reference: true } }),
        prisma.pchOrderLine.findMany({ where: { tenderLineId: id }, select: { order: { select: { id: true, reference: true } } } }),
        prisma.pchContractLine.count({ where: { tenderLineId: id } }),
        prisma.sale.count({ where: { tenderLineId: id } }),
        prisma.adProProductAllocation.count({ where: { tenderLineId: id } }),
      ]);
      const bc = new Map<string, string>();
      for (const b of [...bons, ...lignesDeBon.map((l) => l.order)]) bc.set(b.id, b.reference ?? "sans numéro");
      const refs = [...bc.values()];
      const pl = (n: number, un: string, des: string) => `${n} ${n > 1 ? des : un}`;
      const parts: string[] = [];
      if (refs.length) {
        const noms = refs.length <= 3 ? refs.join(", ") : `${refs.slice(0, 3).join(", ")} et ${pl(refs.length - 3, "autre", "autres")}`;
        parts.push(`${pl(refs.length, "bon de commande", "bons de commande")} (${noms})`);
      }
      if (lignesDeContrat) parts.push(pl(lignesDeContrat, "ligne de contrat de marché", "lignes de contrat de marché"));
      if (ventes) parts.push(pl(ventes, "vente sous marché", "ventes sous marché"));
      if (repartitions) parts.push(pl(repartitions, "répartition d'un poste Ad & Pro", "répartitions de postes Ad & Pro"));
      if (parts.length === 0) return null;
      const liste = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
      return `Ce lot ne se supprime pas : il porte ${liste}. Le supprimer les détacherait de leur lot — une vente sous marché passerait pour une vente de ville, un contrat ne dirait plus de quel lot il découle. Pour le sortir du marché, passez son statut à « Lot annulé » : il reste à l'historique, avec ce qui en découle.`;
    },
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
