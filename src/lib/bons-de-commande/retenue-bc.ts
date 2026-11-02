import type { LegalDocKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { userCan, type SessionUser } from "@/lib/rbac";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { legalKindVisible } from "@/lib/lecteurs/legal";
import { aiguillerBC, porteDuBC, retirerEnAttente, type ResultatAiguillage } from "./aiguillage";
import { OBJET_PREVALIDATION_BC, refusSoumissionBC, type BCASoumettre } from "./prevalidation";
import { sansBloquer } from "@/lib/journal";
import { devisNonRetenus } from "./copie-signee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRÉ-VALIDATION D'UN BC — ce qui lit et écrit la base (la règle est dans `prevalidation.ts`).
 *
 * Trois gestes, et l'aiguillage reste l'unique porte d'entrée vers un centre :
 *   • RETENIR — la demande de validation est créée : le BC est marqué en pré-validation, une porte qui attendait est
 *     retirée (personne ne l'a vue), et il sort du circuit le temps des avis ;
 *   • LIBÉRER — validation finale (ou demande retirée) : la marque tombe et `aiguillerBC` fait le reste, exactement
 *     comme pour un BC émis ailleurs — même centre, même seuil, même file de signature ;
 *   • LIRE — ce qu'on peut importer, et où en est le BC d'une demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'il faut savoir d'un BC pour le soumettre — `null` si la pièce n'existe pas. */
export async function bcASoumettre(docId: string): Promise<(BCASoumettre & { id: string; amount: number | null; reference: string | null; title: string }) | null> {
  const doc = await prisma.legalDocument.findUnique({
    where: { id: docId },
    select: { id: true, kind: true, status: true, signedAt: true, signedById: true, amount: true, reference: true, title: true, bcPrevalidationRequestId: true },
  });
  if (!doc) return null;
  const porte = await porteDuBC(doc.id);
  return {
    id: doc.id,
    kind: String(doc.kind),
    status: String(doc.status),
    // Une date de signature SANS signataire n'est pas la signature des Finances (`aiguillerBC`).
    signe: doc.signedAt !== null && doc.signedById !== null,
    porte: porte?.etat ?? null,
    retenuPar: doc.bcPrevalidationRequestId,
    amount: doc.amount == null ? null : Number(doc.amount),
    reference: doc.reference,
    title: doc.title,
  };
}

/**
 * RETENIR LE BC POUR SA PRÉ-VALIDATION — appelée juste après la création de la demande de validation qui le vise.
 *
 * Revérifie la règle (`refusSoumissionBC`) : entre l'écran et l'écriture, un centre a pu décider. La marque se pose
 * sous condition (le BC n'est retenu par AUCUNE autre demande) : deux demandes simultanées sur le même BC ne le
 * retiennent pas deux fois.
 */
export async function retenirPourPrevalidation(docId: string, demandeId: string, acteurId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const bc = await bcASoumettre(docId);
  if (!bc) return { ok: false, error: "Bon de commande introuvable." };
  const refus = refusSoumissionBC(bc, demandeId);
  if (refus) return { ok: false, error: refus };

  const pose = await prisma.legalDocument.updateMany({
    where: { id: docId, OR: [{ bcPrevalidationRequestId: null }, { bcPrevalidationRequestId: demandeId }] },
    // Il SORT du circuit le temps des avis : sans cela, un BC déjà entré (composé, déposé) se lirait « sans porte » et
    // la fiche proposerait « Adresser au centre » — la porte dérobée exacte que la pré-validation ferme.
    data: { bcPrevalidationAt: new Date(), bcPrevalidationRequestId: demandeId, bcCircuitAt: null },
  });
  if (pose.count === 0) return { ok: false, error: "Ce bon de commande est déjà soumis à une autre demande de validation." };

  const retires = await retirerEnAttente(docId);
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: docId,
    summary: `Bon de commande soumis à pré-validation${retires > 0 ? " — sa validation en attente au centre est retirée, la validation finale la reposera" : ""}.`,
  }).catch(sansBloquer("retenue-bc.retenirPourPrevalidation.recordAudit"));
  return { ok: true };
}

/**
 * LIBÉRER LE BC — la marque tombe (seulement si c'est bien CETTE demande qui le retient), puis l'aiguillage ordinaire.
 * `demandeId` nul : un BC retenu sans demande (composé puis abandonné) — on ne libère que celui-là.
 */
export async function libererPrevalidation(docId: string, demandeId: string | null, acteurId: string, motif: string): Promise<{ libere: boolean; aiguillage: ResultatAiguillage | null }> {
  const r = await prisma.legalDocument.updateMany({
    where: { id: docId, bcPrevalidationAt: { not: null }, bcPrevalidationRequestId: demandeId },
    data: { bcPrevalidationAt: null, bcPrevalidationRequestId: null },
  });
  if (r.count === 0) return { libere: false, aiguillage: null };
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: docId,
    summary: `Bon de commande — ${motif}`,
  }).catch(sansBloquer("retenue-bc.libererPrevalidation.recordAudit"));
  return { libere: true, aiguillage: await aiguillerBC(docId, { acteurId }) };
}

/**
 * UN BC RETENU SANS DEMANDE VIVANTE — composé depuis le formulaire puis abandonné, ou dont la demande a été retirée.
 * La fiche Legal le libère alors par « Adresser au centre » : une retenue sans personne pour la lever serait un BC
 * bloqué pour toujours.
 */
export async function retenueOrpheline(doc: { bcPrevalidationAt: Date | null; bcPrevalidationRequestId: string | null }): Promise<boolean> {
  if (!doc.bcPrevalidationAt) return false;
  if (!doc.bcPrevalidationRequestId) return true;
  const demande = await prisma.validationRequest.findUnique({ where: { id: doc.bcPrevalidationRequestId }, select: { status: true } });
  return !demande || demande.status === "CANCELLED";
}

export interface BCImportable { id: string; label: string; montant: number | null }

/**
 * LES BC QU'ON PEUT IMPORTER DEPUIS LEGAL — ceux que la personne LIT au registre (la même porte que la liste Legal,
 * `perimetreLegal`) ou qu'elle a elle-même créés, ni annulés, ni signés, ni déjà retenus ; les plus récents d'abord.
 * Ce qu'un centre a déjà décidé est écarté ensuite par la règle (`refusSoumissionBC`), pièce par pièce.
 */
export async function bcImportables(user: SessionUser, limite = 60): Promise<BCImportable[]> {
  const { portee, where } = await perimetreLegal(user);
  const lit = where !== null && legalKindVisible(portee, "PURCHASE_ORDER");
  const rows = await prisma.legalDocument.findMany({
    where: {
      kind: "PURCHASE_ORDER" as LegalDocKind,
      status: { not: "CANCELLED" },
      signedAt: null,
      bcPrevalidationAt: null,
      OR: [{ createdById: user.id }, ...(lit ? [where!] : [])],
    },
    select: { id: true, reference: true, title: true, counterparty: true, amount: true },
    orderBy: { createdAt: "desc" },
    take: limite * 2,
  });
  const out: BCImportable[] = [];
  for (const r of rows) {
    const porte = await porteDuBC(r.id);
    if (porte?.etat === "VALIDE" || porte?.etat === "REFUSE") continue;
    const montant = r.amount == null ? null : Number(r.amount);
    out.push({
      id: r.id,
      label: [r.reference, r.title, r.counterparty].filter(Boolean).join(" — "),
      montant,
    });
    if (out.length >= limite) break;
  }
  return out;
}

/** Peut-on DÉPOSER ou COMPOSER un BC ? La porte d'écriture du registre (Legal, ou les Finances pour la chaîne d'achat). */
export function peutCreerUnBC(user: SessionUser): boolean {
  return userCan(user, "LEGAL", "CREATE") || userCan(user, "FINANCES", "CREATE");
}

/** Le BC qu'une demande de pré-validation vise, et où il en est — pour la carte du demandeur. */
export async function bcDesDemandes(demandeIds: readonly string[]): Promise<Map<string, { docId: string; retenu: boolean }>> {
  const out = new Map<string, { docId: string; retenu: boolean }>();
  if (demandeIds.length === 0) return out;
  const demandes = await prisma.validationRequest.findMany({
    where: { id: { in: [...demandeIds] }, objectType: OBJET_PREVALIDATION_BC, entityType: "LEGAL_DOCUMENT" },
    select: { id: true, entityId: true },
  });
  const docs = await prisma.legalDocument.findMany({
    where: { id: { in: demandes.map((d) => d.entityId).filter((v): v is string => Boolean(v)) } },
    select: { id: true, bcPrevalidationRequestId: true },
  });
  const parDoc = new Map(docs.map((d) => [d.id, d]));
  for (const d of demandes) {
    if (!d.entityId) continue;
    const doc = parDoc.get(d.entityId);
    if (doc) out.set(d.id, { docId: doc.id, retenu: doc.bcPrevalidationRequestId === d.id });
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NON RETENUS D'UN POSTE (Direction, 11/2026) — l'écriture et la lecture.
 *
 * La règle (quels devis) est pure : `devisNonRetenus` (`bons-de-commande/devis-non-retenus.ts`). Ici, ce qu'elle écrit sur le lien
 * poste ↔ pièce (`AdProItemPiece.nonRetenuAt`) et ce que Legal en lit. Un devis qui couvre plusieurs postes n'est « non retenu »
 * dans Legal que s'il ne l'a été sur AUCUN : retenu pour l'un, il a servi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Marque ces devis du poste « non retenus » — une fois : une marque déjà posée garde sa date. */
export async function marquerNonRetenus(itemId: string, pieceIds: readonly string[], parId: string | null): Promise<number> {
  if (pieceIds.length === 0) return 0;
  const { count } = await prisma.adProItemPiece.updateMany({
    where: { itemId, legalDocumentId: { in: [...pieceIds] }, nature: "DEVIS", nonRetenuAt: null },
    data: { nonRetenuAt: new Date(), nonRetenuParId: parId },
  });
  return count;
}

/** Efface les marques du poste — son BC signé a été annulé : les offres redeviennent comparables. */
export async function effacerNonRetenusDuPoste(itemId: string): Promise<void> {
  await prisma.adProItemPiece.updateMany({
    where: { itemId, nature: "DEVIS", nonRetenuAt: { not: null } },
    data: { nonRetenuAt: null, nonRetenuParId: null },
  });
}

/** Efface les marques des postes que ce BC (pièce Legal) servait — appelé quand il est annulé ou supprimé. */
export async function effacerNonRetenusDuBC(legalDocumentId: string): Promise<void> {
  const liens = await prisma.adProItemPiece.findMany({ where: { legalDocumentId, nature: "BON_DE_COMMANDE" }, select: { itemId: true } });
  for (const l of liens) await effacerNonRetenusDuPoste(l.itemId);
}

/**
 * LES DEVIS NON RETENUS PARMI CES PIÈCES LEGAL : la date (la plus récente) et qui a validé l'offre retenue. Une pièce retenue sur
 * un seul de ses postes n'y est pas.
 */
export async function nonRetenusDesPieces(legalDocumentIds: readonly string[]): Promise<Map<string, { le: Date; par: string | null }>> {
  const res = new Map<string, { le: Date; par: string | null }>();
  if (legalDocumentIds.length === 0) return res;
  const liens = await prisma.adProItemPiece.findMany({
    where: { legalDocumentId: { in: [...legalDocumentIds] }, nature: "DEVIS" },
    select: { legalDocumentId: true, nonRetenuAt: true, nonRetenuParId: true },
  });
  const parPiece = new Map<string, typeof liens>();
  for (const l of liens) parPiece.set(l.legalDocumentId, [...(parPiece.get(l.legalDocumentId) ?? []), l]);
  const personnes = [...new Set(liens.map((l) => l.nonRetenuParId).filter((x): x is string => Boolean(x)))];
  const noms = personnes.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: personnes } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  for (const [id, ls] of parPiece) {
    if (!ls.every((l) => l.nonRetenuAt)) continue;
    const dernier = ls.reduce((a, b) => ((b.nonRetenuAt as Date) > (a.nonRetenuAt as Date) ? b : a));
    res.set(id, { le: dernier.nonRetenuAt as Date, par: dernier.nonRetenuParId ? noms.get(dernier.nonRetenuParId) ?? null : null });
  }
  return res;
}

/**
 * AU MOMENT OÙ LE BC D'UN POSTE EST SIGNÉ : les devis de ce poste qui n'ont AUCUNE ligne validée pour lui sont marqués « non
 * retenus » — avec la personne qui a validé les lignes du devis retenu (celui dont le BC découle). Un BC qui ne sert aucun poste
 * ne marque rien. Rend le nombre de devis marqués.
 */
export async function marquerNonRetenusDuBC(bcId: string): Promise<number> {
  const bc = await prisma.legalDocument.findUnique({ where: { id: bcId }, select: { chainFromId: true } });
  const liens = await prisma.adProItemPiece.findMany({ where: { legalDocumentId: bcId, nature: "BON_DE_COMMANDE" }, select: { itemId: true } });
  let marques = 0;
  for (const { itemId } of liens) {
    const devis = await prisma.adProItemPiece.findMany({
      where: { itemId, nature: "DEVIS" },
      select: { legalDocumentId: true, legalDocument: { select: { status: true, cancelledAt: true } } },
    });
    const valides = await prisma.adProDevisLigne.groupBy({
      by: ["devisId"], where: { validatedItemId: itemId, devis: { legalDocumentId: { in: devis.map((d) => d.legalDocumentId) } } }, _count: { _all: true },
    });
    const parDevis = new Map((await prisma.adProDevis.findMany({ where: { id: { in: valides.map((v) => v.devisId) } }, select: { id: true, legalDocumentId: true } }))
      .map((d) => [d.legalDocumentId, valides.find((v) => v.devisId === d.id)?._count._all ?? 0]));
    const ecartes = devisNonRetenus(devis.map((d) => ({
      pieceId: d.legalDocumentId, nbValidees: parDevis.get(d.legalDocumentId) ?? 0,
      annule: d.legalDocument.status === "CANCELLED" || d.legalDocument.cancelledAt !== null,
    })));
    const validateur = bc?.chainFromId
      ? (await prisma.adProDevisLigne.findFirst({
          where: { devis: { legalDocumentId: bc.chainFromId }, validatedItemId: itemId }, orderBy: { validatedAt: "desc" }, select: { validatedById: true },
        }))?.validatedById ?? null
      : null;
    marques += await marquerNonRetenus(itemId, ecartes, validateur);
  }
  return marques;
}
