import type { EntityType, LegalDocKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUELS ORDRES DE DÉPENSE ONT LEUR FACTURE ? — une règle, trois lecteurs (§118.185 — audit 360°, I6).
 *
 * « Facture obligatoire » bloque le règlement d'une dépense événementielle tant que la facture n'est
 * pas là. La règle ne regardait que DEUX endroits — un fichier « Facture » joint à l'ordre, ou au
 * dossier source — pendant que la plateforme range les factures à QUATRE autres : au registre Legal
 * (la facture chaînée à son BC, ou rattachée à la fiche), sur le POSTE qui a émis l'ordre, sur le
 * DOSSIER compagnon que l'ordre ouvre en naissant, et parmi les PIÈCES de ce dossier. Un ordre de
 * poste, de congrès ou de sponsoring dont la facture était parfaitement rangée restait impayable —
 * « joignez la facture » à quelqu'un qui l'avait jointe, à l'endroit que l'écran lui proposait.
 *
 * Et elle était écrite trois fois, trois fois différemment : le règlement, la colonne « Facture » de
 * Règlements à effectuer, et le signal « justificatif manquant » de l'intelligence financière — qui
 * ne lisait, lui, que le registre. Deux lectures du même fait divergent toujours (§118.5) : le
 * symptôme était un ordre que l'écran disait « facture jointe » et que le règlement refusait.
 *
 * CE QUI COMPTE COMME LA FACTURE D'UN ORDRE :
 *   • un fichier de catégorie « Facture » sur l'ordre, sur son dossier source, sur le poste qui l'a
 *     émis, ou sur son dossier compagnon ;
 *   • une pièce « Facture » du dossier compagnon que les Finances n'ont pas refusée ;
 *   • une facture du registre Legal, non annulée, partie au règlement sur CET ordre, rattachée à
 *     la même fiche source, ou qui SUIT (« Fait suite à », `chainFromId`) un devis ou un bon de
 *     commande non annulé rattaché à cette fiche — et qui porte au moins un fichier : une ligne de
 *     registre sans pièce n'est pas la preuve qu'on demande avant de payer.
 *
 * LE TROISIÈME CAS EST UN LIEN, JAMAIS UNE RESSEMBLANCE (lot E5, §118.36) : la facture désigne son BC
 * par son identifiant, et ce BC désigne sa fiche par le sien. La facture qui suit le BC d'une AUTRE
 * fiche ne compte pas pour celle-ci, quels que soient son montant, son fournisseur ou son titre.
 * Son en-tête annonçait déjà « la facture chaînée à son BC » ; le code ne le lisait pas.
 *
 * DEUX LECTEURS DE LA PART « FICHE » (lot E5) : les ordres (ci-dessous) et la FIN d'une demande d'achat
 * au secrétariat (`ficheAFacture`), qui refusait de se terminer sur une facture parfaitement rangée au
 * registre par « Pièces liées → Facture ». Une seule fonction (`fichesAvecFacture`) : deux lectures
 * auraient divergé — une demande terminée sur une facture que le règlement ne voyait pas, ou l'inverse.
 *
 * Les lectures sont EN LOT (une table de cent ordres = une poignée de requêtes, pas cent).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface OrdrePourFacture {
  id: string;
  sourceType: string | null;
  sourceId: string | null;
}

/** Une fiche — une demande au secrétariat, un congrès, un sponsoring… — qui porte des ordres et des pièces. */
export interface FicheSource {
  entityType: EntityType;
  entityId: string;
}

const cleFiche = (t: string | null | undefined, i: string | null | undefined) => `${t ?? ""}:${i ?? ""}`;

/** Les pièces qu'une facture SUIT dans la chaîne d'un achat (« Fait suite à ») : un devis, un bon de commande. */
const AMONT_D_UNE_FACTURE: LegalDocKind[] = ["QUOTE", "PURCHASE_ORDER"];

/** Les pièces du registre qui portent au moins un fichier — une ligne sans pièce ne prouve rien. */
async function piecesAvecFichier(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await prisma.document.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: { in: [...ids] } },
    select: { entityId: true },
  });
  return new Set(docs.map((d) => d.entityId));
}

/**
 * LES FICHES QUI ONT LEUR FACTURE — la part « fiche source » de la règle, lue par les ordres ET par la fin
 * d'une demande d'achat (lot E5). Rend les clés `type:id` des fiches qui l'ont. EN LOT : trois à cinq
 * requêtes, quel que soit le nombre de fiches.
 *
 * CE QUI COMPTE :
 *   • un fichier de catégorie « Facture » déposé sur la fiche ;
 *   • une facture du registre, non annulée, qui porte au moins un fichier, et qui est RATTACHÉE à la fiche
 *     (`sourceType` / `sourceId` — ce que crée « Pièces liées → Facture ») ou qui SUIT un devis ou un bon de
 *     commande non annulé rattaché à cette fiche (`chainFromId` — ce que crée le registre, « Fait suite à »).
 *     Un seul maillon : le BC créé depuis la fiche lui est toujours rattaché.
 */
export async function fichesAvecFacture(fiches: readonly FicheSource[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (fiches.length === 0) return out;
  const parSource = fiches.map((f) => ({ sourceType: f.entityType, sourceId: f.entityId }));
  const [fichiers, rattachees, amont] = await Promise.all([
    prisma.document.findMany({
      where: { category: "INVOICE", OR: fiches.map((f) => ({ entityType: f.entityType, entityId: f.entityId })) },
      select: { entityType: true, entityId: true },
    }),
    prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" }, OR: parSource },
      select: { id: true, sourceType: true, sourceId: true },
    }),
    // LE DEVIS OU LE BC DE LA FICHE — rattaché à elle par son identifiant. Un BC annulé ne relie plus rien.
    prisma.legalDocument.findMany({
      where: { kind: { in: AMONT_D_UNE_FACTURE }, status: { not: "CANCELLED" }, OR: parSource },
      select: { id: true, sourceType: true, sourceId: true },
    }),
  ]);
  const ficheDeLAmont = new Map(amont.map((a) => [a.id, cleFiche(a.sourceType, a.sourceId)]));
  const chainees = ficheDeLAmont.size
    ? await prisma.legalDocument.findMany({
        where: { kind: "INVOICE", status: { not: "CANCELLED" }, chainFromId: { in: [...ficheDeLAmont.keys()] } },
        select: { id: true, chainFromId: true },
      })
    : [];
  const factures = [
    ...rattachees.map((f) => ({ id: f.id, fiche: cleFiche(f.sourceType, f.sourceId) })),
    ...chainees.map((f) => ({ id: f.id, fiche: (f.chainFromId && ficheDeLAmont.get(f.chainFromId)) || null })),
  ];
  const avecPiece = await piecesAvecFichier(factures.map((f) => f.id));
  for (const f of fichiers) out.add(cleFiche(f.entityType, f.entityId));
  for (const f of factures) if (f.fiche && avecPiece.has(f.id)) out.add(f.fiche);
  return out;
}

export async function ordresAvecFacture(ordres: readonly OrdrePourFacture[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ordres.length === 0) return out;
  const ids = ordres.map((o) => o.id);
  const sources = ordres
    .filter((o) => o.sourceType && o.sourceId)
    .map((o) => ({ entityType: o.sourceType as EntityType, entityId: o.sourceId as string }));

  const [postes, dossiers, fiches] = await Promise.all([
    prisma.adProItem.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true, expenseOrderId: true } }),
    prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true, expenseOrderId: true } }),
    // LA FICHE SOURCE — la règle de `fichesAvecFacture`, la même que lit la fin d'une demande (lot E5).
    fichesAvecFacture(sources),
  ]);
  const ordreDuPoste = new Map(postes.map((p) => [p.id, p.expenseOrderId as string]));
  const ordreDuDossier = new Map(dossiers.map((d) => [d.id, d.expenseOrderId as string]));

  const fichiersOu: Prisma.DocumentWhereInput[] = [
    { entityType: "EXPENSE_ORDER", entityId: { in: ids } },
    ...(postes.length ? [{ entityType: "AD_PRO_ITEM" as const, entityId: { in: [...ordreDuPoste.keys()] } }] : []),
    ...(dossiers.length ? [{ entityType: "PAYMENT_REQUEST" as const, entityId: { in: [...ordreDuDossier.keys()] } }] : []),
  ];
  const [fichiers, pieces, factures] = await Promise.all([
    prisma.document.findMany({ where: { category: "INVOICE", OR: fichiersOu }, select: { entityType: true, entityId: true } }),
    dossiers.length
      ? prisma.paymentPiece.findMany({
          where: { requestId: { in: [...ordreDuDossier.keys()] }, kind: "INVOICE", status: { not: "REJECTED" } },
          select: { requestId: true },
        })
      : Promise.resolve([] as { requestId: string }[]),
    prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" }, expenseOrderId: { in: ids } },
      select: { id: true, expenseOrderId: true },
    }),
  ]);
  const avecPiece = await piecesAvecFichier(factures.map((f) => f.id));

  for (const f of fichiers) {
    if (f.entityType === "EXPENSE_ORDER") out.add(f.entityId);
    else if (f.entityType === "AD_PRO_ITEM") { const o = ordreDuPoste.get(f.entityId); if (o) out.add(o); }
    else if (f.entityType === "PAYMENT_REQUEST" && ordreDuDossier.has(f.entityId)) out.add(ordreDuDossier.get(f.entityId) as string);
  }
  for (const p of pieces) { const o = ordreDuDossier.get(p.requestId); if (o) out.add(o); }
  for (const f of factures) if (avecPiece.has(f.id) && f.expenseOrderId) out.add(f.expenseOrderId);
  // Une facture de la fiche source vaut pour chaque ordre de cette fiche (règle d'avant, gardée).
  for (const o of ordres) if (o.sourceType && o.sourceId && fiches.has(cleFiche(o.sourceType, o.sourceId))) out.add(o.id);
  return out;
}

/** La même règle, pour un ordre. */
export async function ordreAFacture(ordre: OrdrePourFacture): Promise<boolean> {
  return (await ordresAvecFacture([ordre])).has(ordre.id);
}

/**
 * LA MÊME RÈGLE, POUR UNE FICHE — « Fin de la demande » d'un achat au secrétariat (lot E5) : la fiche a sa
 * facture, ou l'un de ses ordres de dépense non annulés a la sienne (sur l'ordre, son dossier compagnon, ou
 * partie au règlement sur lui).
 */
export async function ficheAFacture(fiche: FicheSource): Promise<boolean> {
  if ((await fichesAvecFacture([fiche])).has(cleFiche(fiche.entityType, fiche.entityId))) return true;
  const ordres = await prisma.expenseOrder.findMany({
    where: { sourceType: fiche.entityType, sourceId: fiche.entityId, status: { not: "CANCELLED" } },
    select: { id: true, sourceType: true, sourceId: true },
  });
  return ordres.length > 0 && (await ordresAvecFacture(ordres)).size > 0;
}
