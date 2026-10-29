import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { accesAuxPiecesLegalDetaille } from "@/lib/entity-access";
import { AD_PRO_PARENTS, PARENT_COLONNE, type AdProParent } from "@/modules/ad-pro/partage";
import { LEGAL_DOC_STATUS, INVOICE_SETTLEMENT, invoiceSettlementState, natureLegale, type BadgeTone } from "@/lib/labels";
import { fichiersEmis, type FichiersEmis } from "@/lib/legal/fichiers-emis";
import { toNumber } from "@/lib/utils";
import type { DocItem } from "@/components/documents/document-list";
import { droitsSuppressionDesPieces, demandeDeLaPiece, type DroitsPieceDemande } from "@/lib/queries/pieces-demande-droits";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES LEGAL RATTACHÉES DIRECTEMENT À UNE DEMANDE — lues pour sa fiche.
 *
 * « Les anciennes pièces Legal rattachées directement à une demande ne s'affichent plus sur sa
 * fiche (elles restent dans Legal) — elles doivent s'afficher même sur la demande » (Direction,
 * 04/10). Le bloc « Pièces liées » a quitté les fiches qui portent des POSTES (sponsoring, congrès,
 * événements) : la chaîne devis → BC → facture vit désormais sur chaque poste (`AdProItemPiece`).
 * Mais une convention, un contrat, ou un devis d'AVANT les postes désigne la demande elle-même
 * (`sourceType` / `sourceId`) — et plus aucun écran de la demande ne le montrait.
 *
 * ── CE QUI N'Y EST PAS ──────────────────────────────────────────────────────────────────
 *
 * Une pièce RATTACHÉE À UN POSTE de cette demande est déjà sur la carte de ce poste : la montrer
 * ici aussi en ferait deux lignes pour une dépense (le défaut que les postes ont fermé). Seules
 * les pièces qu'aucun poste de la demande ne désigne sont lues.
 *
 * ── LA GARDE ────────────────────────────────────────────────────────────────────────────
 *
 * La porte unique des pièces (`accesAuxPiecesLegalDetaille`), en lot : une pièce que la personne
 * ne peut pas ouvrir n'est PAS rendue — ni son titre, ni son montant, ni ses fichiers — elle est
 * seulement COMPTÉE, pour qu'une liste raccourcie ne se lise pas comme complète (§118.60). Le
 * lien vers la fiche Legal suit `horsFiche` : une exception de lecture (l'arbitre d'une demande,
 * §118.185) ouvre les fichiers, pas la page — le titre se lit alors sans lien (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, la liste le DIT (§118.60) — la liste complète reste dans Legal. */
export const PIECES_DEMANDE_MAX = 40;

export interface LignePieceDemande {
  id: string;
  nature: string;
  titre: string;
  reference: string | null;
  montant: number | null;
  statut: { label: string; tone: BadgeTone } | null;
  /** La fiche `/legal/[id]` s'ouvre-t-elle à la personne ? */
  fiche: boolean;
  /** La version plateforme (Word / PDF de la fabrique). */
  plateforme: FichiersEmis;
  /** Ses fichiers — toujours ouvrables par la personne (la pièce l'est). */
  documents: DocItem[];
  /**
   * SUPPRIMER (§118.209) — la pièce (corbeille) et ses fichiers : offert ou non, et POURQUOI quand ce qui
   * engage la pièce le refuse. Lu par la même décision que les actions : un bouton offert est un geste accepté.
   */
  suppression: DroitsPieceDemande;
}

export interface PiecesLegalDeLaDemande {
  lignes: LignePieceDemande[];
  /** Pièces de la demande (hors postes) que la personne ne peut pas ouvrir — comptées, jamais rendues. */
  masquees: number;
  /** Pièces au-delà de la borne de lecture — ni lues ni jugées : la liste complète est dans Legal. */
  nonLues: number;
  /** Total des pièces de la demande hors postes, en base. */
  total: number;
}

const estParentAdPro = (t: EntityType): t is AdProParent & EntityType =>
  (AD_PRO_PARENTS as readonly string[]).includes(t);

/** La clause : rattachées à la demande, et désignées par AUCUN de ses postes. */
export function clausePiecesDeLaDemande(entityType: EntityType, entityId: string): Prisma.LegalDocumentWhereInput {
  const base: Prisma.LegalDocumentWhereInput = { sourceType: entityType, sourceId: entityId };
  if (!estParentAdPro(entityType)) return base;
  return {
    ...base,
    postesAdPro: { none: { item: { [PARENT_COLONNE[entityType]]: entityId } } },
  };
}

export async function chargerPiecesLegalDeLaDemande(
  spectateur: SessionUser,
  entityType: EntityType,
  entityId: string,
): Promise<PiecesLegalDeLaDemande> {
  const where = clausePiecesDeLaDemande(entityType, entityId);
  const [candidats, total] = await Promise.all([
    prisma.legalDocument.findMany({
      where, orderBy: { createdAt: "desc" }, take: PIECES_DEMANDE_MAX,
      select: { id: true, kind: true, title: true, reference: true, amount: true, status: true, paidDate: true, expenseOrderId: true, custom: true, createdById: true },
    }),
    prisma.legalDocument.count({ where }),
  ]);
  if (candidats.length === 0) return { lignes: [], masquees: 0, nonLues: total, total };

  const { droits, horsFiche } = await accesAuxPiecesLegalDetaille(spectateur, candidats.map((d) => d.id), ["VIEW"]);
  const lisibles = droits.get("VIEW") ?? new Set<string>();
  const ouvertes = candidats.filter((d) => lisibles.has(d.id));

  // Rien n'est lu des fichiers d'une pièce fermée : seuls les identifiants OUVERTS sont interrogés.
  const fichiers = ouvertes.length
    ? await prisma.document.findMany({
        where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ouvertes.map((d) => d.id) } },
        include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" },
      })
    : [];
  const parPiece = new Map<string, DocItem[]>();
  for (const f of fichiers) {
    const l = parPiece.get(f.entityId) ?? [];
    l.push({
      id: f.id, name: f.name, category: f.category, version: f.version, sizeBytes: f.sizeBytes,
      confidentiality: f.confidentiality, uploadedBy: f.uploadedBy?.name ?? null,
      createdAt: f.createdAt.toISOString(), hasFile: Boolean(f.fileKey),
    });
    parPiece.set(f.entityId, l);
  }

  // Les droits de suppression, en LOT : la demande se juge une fois, la pièce par la porte du serveur.
  const demande = demandeDeLaPiece({ sourceType: entityType, sourceId: entityId });
  const droitsSuppression = demande
    ? await droitsSuppressionDesPieces(spectateur, demande, ouvertes.map((d) => ({ id: d.id, createdById: d.createdById })))
    : new Map<string, DroitsPieceDemande>();
  const ferme: DroitsPieceDemande = { piece: { offert: false, raison: null }, fichiers: { offert: false, raison: null } };

  const lignes: LignePieceDemande[] = ouvertes.map((d) => {
    const st = d.kind === "INVOICE" && d.status !== "CANCELLED"
      ? INVOICE_SETTLEMENT[invoiceSettlementState(d)]
      : LEGAL_DOC_STATUS[d.status];
    return {
      id: d.id, nature: natureLegale(d.kind), titre: d.title, reference: d.reference,
      montant: d.amount !== null ? toNumber(d.amount) : null,
      statut: st ? { label: st.label, tone: st.tone } : null,
      fiche: !horsFiche.has(d.id),
      plateforme: fichiersEmis(d.custom),
      documents: parPiece.get(d.id) ?? [],
      suppression: droitsSuppression.get(d.id) ?? ferme,
    };
  });

  return { lignes, masquees: candidats.length - lignes.length, nonLues: total - candidats.length, total };
}
