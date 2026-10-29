import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BONS DE COMMANDE DÉJÀ ÉTABLIS DANS LEGAL POUR UN POSTE (§118.187 — audit 360°, R05/R06/R12).
 *
 * Le BC qu'une assistante établit pour un poste naît d'une demande de pièce (`DocumentRequest`,
 * `entityType = AD_PRO_ITEM`) et lit sa validation SUR LE POSTE (`portesDesBC`, `source: "POSTE"`).
 * Annuler la demande de BC (pour un BC SIGNÉ ou facturé), revoir la décision du poste ou le rendre à la Direction le laisserait
 * SANS porte — et la facture d'un BC sans porte part au règlement (`blocageParLeBC(null)`). Ces trois
 * gestes refusent donc tant qu'il en existe un, non annulé, et le refus le NOMME.
 *
 * Une lecture, deux lecteurs : les ACTIONS (qui refusent) et la CARTE du poste (qui ne propose pas un
 * geste que l'action refuserait, §118.83). Deux copies de « ce BC existe-t-il ? » finiraient par
 * répondre autrement, et le symptôme serait un bouton offert puis refusé (§118.5). La lecture se fait
 * en LOT : un écran montre vingt postes, et une requête par poste ferait vingt allers-retours
 * (§118.102b).
 *
 * Supprimer le poste, lui, n'a pas besoin de ce refus : le LOT de la corbeille emporte la demande de
 * pièce et le BC non signé avec lui, et les rend ensemble à la restauration ; un BC signé bloque la
 * suppression (`faitIrreversible`). Ce n'est pas la même question (§118.57).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/** Un BC vivant d'un poste — ce que « Annuler la demande de BC » doit savoir de lui (constat 36). */
export interface BcDuPoste {
  id: string;
  nom: string;
  /** Signé par les Finances : il engage la société, il ne s'annule plus depuis le poste. */
  signe: boolean;
  /** La facture qui en découle (non annulée) — son nom, ou `null`. */
  facture: string | null;
}

export async function bcVivantsDesPostes(itemIds: readonly string[]): Promise<Map<string, BcDuPoste[]>> {
  const res = new Map<string, BcDuPoste[]>();
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (ids.length === 0) return res;
  // DEUX CHEMINS, UNE LECTURE (§118.204) : le BC classé depuis une demande de pièce ET le BC rattaché
  // au poste (`AdProItemPiece`) — celui que la carte montre. N'en lire qu'un ferait dire « pas de BC »
  // ici quand la carte en montre un.
  const [parDemande, parLien] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { entityType: "AD_PRO_ITEM", entityId: { in: ids }, legalDocumentId: { not: null } },
      select: { entityId: true, legalDocumentId: true },
    }),
    prisma.adProItemPiece.findMany({
      where: { itemId: { in: ids }, nature: "BON_DE_COMMANDE" },
      select: { itemId: true, legalDocumentId: true },
    }),
  ]);
  const demandes = [...parDemande, ...parLien.map((l) => ({ entityId: l.itemId, legalDocumentId: l.legalDocumentId }))];
  const docIds = [...new Set(demandes.map((d) => d.legalDocumentId).filter((x): x is string => Boolean(x)))];
  if (docIds.length === 0) return res;
  const [docs, factures] = await Promise.all([
    prisma.legalDocument.findMany({
      where: { id: { in: docIds }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } },
      select: { id: true, reference: true, title: true, signedAt: true, signedById: true },
    }),
    prisma.legalDocument.findMany({
      where: { chainFromId: { in: docIds }, kind: "INVOICE", status: { not: "CANCELLED" } },
      select: { chainFromId: true, reference: true, title: true },
    }),
  ]);
  const factureDe = new Map<string, string>();
  for (const f of factures) if (f.chainFromId && !factureDe.has(f.chainFromId)) factureDe.set(f.chainFromId, f.reference?.trim() || f.title);
  const parId = new Map(docs.map((d) => [d.id, {
    id: d.id, nom: d.reference?.trim() || d.title, signe: d.signedAt != null || d.signedById != null, facture: factureDe.get(d.id) ?? null,
  } satisfies BcDuPoste]));
  for (const d of demandes) {
    const bc = d.legalDocumentId ? parId.get(d.legalDocumentId) : undefined;
    if (!bc) continue;
    const l = res.get(d.entityId) ?? [];
    if (!l.some((x) => x.id === bc.id)) l.push(bc);
    res.set(d.entityId, l);
  }
  return res;
}

export async function bcEtablisDesPostes(itemIds: readonly string[]): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  for (const [k, l] of await bcVivantsDesPostes(itemIds)) res.set(k, [...new Set(l.map((b) => b.nom))]);
  return res;
}

/**
 * POURQUOI LA DEMANDE DE BC NE S'ANNULE PAS DEPUIS LE POSTE — `null` si elle s'annule (constat 36 de
 * l'audit du 04/10). « On annule sa demande tant que l'autre ne l'a pas exécutée » : le BC établi par
 * l'assistante mais NON signé n'engage encore personne — le geste unique l'annule au registre, puis
 * retire la demande. Signé par les Finances, il engage la société ; une facture qui en découle, plus
 * encore : là, la demande est exécutée et le refus le nomme. Une lecture pour l'action et pour la carte.
 */
export function refusAnnulationBcDuPoste(bcs: readonly Pick<BcDuPoste, "nom" | "signe" | "facture">[]): string | null {
  const facture = bcs.find((b) => b.facture);
  if (facture) {
    return `Une facture (${facture.facture}) découle déjà du bon de commande ${facture.nom} : la demande est exécutée, elle ne s'annule plus d'ici — annulez d'abord la facture dans Legal si c'est bien voulu.`;
  }
  const signe = bcs.find((b) => b.signe);
  if (signe) {
    return `Le bon de commande ${signe.nom} est signé par les Finances : il engage la société, la demande ne s'annule plus depuis le poste — voyez avec les Finances.`;
  }
  return null;
}

export async function bcEtablisDuPoste(itemId: string): Promise<string[]> {
  return (await bcEtablisDesPostes([itemId])).get(itemId) ?? [];
}

/** Le refus, et le geste qui le lève — une rédaction pour les trois actions et pour la carte. */
export function refusBcEtabli(bcs: readonly string[], ensuite: string): string {
  return `Un bon de commande a déjà été établi pour ce poste (${bcs.join(", ")}) et il lit sa validation sur ce poste : `
    + `annulez d'abord la demande de BC (« Annuler la demande de BC » l'annule avec elle tant qu'il n'est pas signé), puis ${ensuite}.`;
}

/**
 * ANNULER UN BC NON SIGNÉ, DANS LA TRANSACTION DE L'APPELANT (constat 36) — `false` si la condition a perdu :
 * signé entre la lecture et l'écriture (la signature écrit sur l'`updatedAt` lu, cette annulation le change :
 * des deux gestes, un seul passe), déjà annulé, ou une facture née entre-temps. Hors de l'action : la
 * dérivation des contrats désigne l'objet d'une action par ce que SON corps écrit (§118.150g).
 */
export async function annulerBcNonSigne(tx: Prisma.TransactionClient, bcId: string, raison: string, acteurId: string): Promise<boolean> {
  const a = await tx.legalDocument.updateMany({
    where: { id: bcId, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" }, signedAt: null, signedById: null },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: raison, updatedById: acteurId },
  });
  if (a.count === 0) return false;
  const facture = await tx.legalDocument.count({ where: { chainFromId: bcId, kind: "INVOICE", status: { not: "CANCELLED" } } });
  return facture === 0;
}
