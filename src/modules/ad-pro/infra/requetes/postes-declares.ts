import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { lienPosteAdPro, PARENT_COLONNE, type AdProParent } from "@/lib/chemins/ad-pro";
import { ITEM_KIND_LABELS, ITEM_STATUS_LABELS } from "../../domaine/postes";
import { lireStatutConformite, type StatutConformite } from "../../domaine/parcours-agence";
import { payeeDuPoste } from "../../domaine/payee-poste";
import { piecesDesPostes } from "../pieces-poste";
import { ETAPE_BAT, ETAPE_RECEPTION } from "./agence";

/**
 * CE QUE DÉCLARE UN DOSSIER D'INFORMATION MÉDICALE (Direction, 23/11/2026) — les postes de la demande, déclarés ensemble.
 *
 * La fiche `DIM-…` ne disait que le libellé de l'événement et un montant : le pharmacien déclarait à l'ANPP sans voir ce
 * qu'il déclarait. Chaque poste, ici : sa nature, son montant, l'agence (ou le bénéficiaire), son bon de commande et où il
 * en est, la conformité de son BAT, et ses pièces. Un poste refusé ou resté en brouillon n'est pas déclaré : il n'y figure pas.
 */

export interface PieceDeclaree {
  /** La pièce Legal (devis retenu, BC, facture) — la page ne l'ouvre qu'à qui la porte de la pièce l'ouvre. */
  legalId: string;
  type: "Devis retenu" | "Bon de commande" | "Facture";
  reference: string | null;
  fichiers: { id: string; nom: string }[];
}

export interface PosteDeclare {
  id: string;
  label: string;
  nature: string;
  /** Le statut du poste, en clair. */
  statut: string;
  montant: number | null;
  /** Qui est payé : l'agence retenue, à défaut le tiers du BC, le fournisseur du poste, le devis accepté (`payeeDuPoste`). */
  payee: string | null;
  bc: { reference: string | null; etape: string | null } | null;
  conformite: { requise: boolean; statut: StatutConformite | null; note: string | null };
  pieces: PieceDeclaree[];
  /** Les fichiers du poste lui-même : BAT, photos et PV de réception. */
  fichiers: { id: string; nom: string; nature: "BAT" | "Réception" }[];
  lien: string;
}

export async function postesDeclares(sourceType: string, sourceId: string): Promise<PosteDeclare[]> {
  if (!(sourceType in PARENT_COLONNE)) return [];
  const parent = sourceType as AdProParent;
  const postes = await prisma.adProItem.findMany({
    where: { [PARENT_COLONNE[parent]]: sourceId, status: { notIn: ["REJECTED", "DRAFT"] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, label: true, kind: true, status: true, amountGranted: true, amountEstimated: true, supplier: true, conformiteRequise: true,
      execution: { select: { agenceDevisId: true, conformiteStatut: true, conformiteNote: true } },
    },
  });
  if (postes.length === 0) return [];
  const ids = postes.map((p) => p.id);
  const devisRetenus = postes.map((p) => p.execution?.agenceDevisId).filter((x): x is string => Boolean(x));
  const [pieces, fichiers, tiers] = await Promise.all([
    piecesDesPostes(ids),
    prisma.document.findMany({
      where: { entityType: "AD_PRO_ITEM", entityId: { in: ids }, stepKey: { in: [ETAPE_BAT, ETAPE_RECEPTION] } },
      orderBy: { createdAt: "desc" }, select: { id: true, name: true, entityId: true, stepKey: true },
    }),
    // LE TIERS de chaque pièce : le devis retenu (l'agence), mais aussi les BC et devis rattachés aux postes — un poste
    // commandé hors parcours agence (la billetterie) n'a que son BC pour dire qui est payé (`domaine/payee-poste.ts`).
    prisma.legalDocument.findMany({
      where: { OR: [{ id: { in: devisRetenus } }, { postesAdPro: { some: { itemId: { in: ids } } } }] },
      select: { id: true, counterparty: true },
    }),
  ]);
  const tiersDe = new Map(tiers.map((a) => [a.id, a.counterparty]));
  return postes.map((p) => {
    const pc = pieces.get(p.id);
    const retenu = p.execution?.agenceDevisId ?? null;
    const devis = (pc?.devis ?? []).filter((d) => !d.annulee && (retenu ? d.id === retenu : !d.nonRetenu));
    const liste: PieceDeclaree[] = [
      ...devis.map((d) => ({ legalId: d.id, type: "Devis retenu" as const, reference: d.reference, fichiers: d.fichiersListe })),
      ...(pc?.bcs ?? []).filter((b) => !b.annulee).map((b) => ({ legalId: b.id, type: "Bon de commande" as const, reference: b.reference, fichiers: b.fichiersListe })),
      ...(pc?.factures ?? []).filter((f) => !f.annulee).map((f) => ({ legalId: f.id, type: "Facture" as const, reference: f.reference, fichiers: f.fichiersListe })),
    ];
    const montant = p.amountGranted ?? p.amountEstimated;
    return {
      id: p.id, label: p.label, nature: ITEM_KIND_LABELS[p.kind], statut: ITEM_STATUS_LABELS[p.status]?.label ?? String(p.status),
      montant: montant != null ? toNumber(montant) : null,
      payee: payeeDuPoste({
        agenceRetenue: retenu ? tiersDe.get(retenu) ?? null : null,
        bcs: (pc?.bcs ?? []).filter((b) => !b.annulee).map((b) => ({ tiers: tiersDe.get(b.id) ?? null, etape: b.etape })),
        fournisseur: p.supplier ?? null,
        devis: devis.map((d) => ({ tiers: tiersDe.get(d.id) ?? null })),
      }),
      bc: pc?.bc ? { reference: pc.bc.reference, etape: pc.bc.etape } : null,
      conformite: { requise: p.conformiteRequise, statut: lireStatutConformite(p.execution?.conformiteStatut), note: p.execution?.conformiteNote ?? null },
      pieces: liste,
      fichiers: fichiers.filter((f) => f.entityId === p.id).map((f) => ({ id: f.id, nom: f.name, nature: f.stepKey === ETAPE_BAT ? "BAT" as const : "Réception" as const })),
      lien: lienPosteAdPro(parent, sourceId, p.id),
    };
  });
}
