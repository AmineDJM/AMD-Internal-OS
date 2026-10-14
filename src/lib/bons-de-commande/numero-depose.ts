import { prisma } from "@/lib/prisma";
import { formaterReference, lireReference, LIBELLE_TYPE_REFERENCE } from "@/lib/references/registre";
import { magasinPrisma, registreDe } from "@/lib/references/registre-serveur";
import { nettoyerNumero, phraseNumeroPris } from "@/lib/bons-de-commande/numero-reference";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE NUMÉRO D'UN BON DE COMMANDE DÉPOSÉ (fiche Legal, « Demandes de validations » depuis l'ordinateur) — Direction, 14/10/2026.
 *
 * Un BC déposé n'est pas composé par la fabrique : son numéro est ÉCRIT À LA MAIN dans la fiche, à la création comme à la
 * modification. Les mêmes règles que pour un BC émis (`bons-de-commande/numero-reference.ts`) :
 *   • unique parmi les bons de commande de la société — et, s'il a la forme NNN/DG/AAAA d'une société au registre commun,
 *     libre au registre (tous documents de la société confondus) ;
 *   • au registre, il y ENTRE (l'entrée du BC suit son numéro) et le compteur commun est porté au moins à lui : le prochain
 *     numéro automatique reste au-dessus du plus grand utilisé, sans jamais reculer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le refus d'un numéro déjà porté par un autre BC de la société, ou par un autre document au registre ; `null` : libre. */
export async function refusNumeroBcDepose(o: { companyId: string | null; reference: string | null | undefined; exclure: string | null }): Promise<string | null> {
  const ref = nettoyerNumero(o.reference);
  if (!ref || !o.companyId) return null;
  const autre = await prisma.legalDocument.findFirst({
    where: { companyId: o.companyId, kind: "PURCHASE_ORDER", reference: { equals: ref, mode: "insensitive" }, ...(o.exclure ? { id: { not: o.exclure } } : {}) },
    select: { title: true },
  });
  if (autre) return phraseNumeroPris(ref, { libelle: `le bon de commande « ${autre.title} »` });
  const lu = lireReference(ref);
  if (!lu) return null;
  const entree = await prisma.documentReference.findUnique({
    where: { companyId_year_numero: { companyId: o.companyId, year: lu.annee, numero: lu.numero } },
    select: { reference: true, docType: true, entityType: true, entityId: true },
  });
  if (entree && !(o.exclure && entree.entityType === "LEGAL_DOCUMENT" && entree.entityId === o.exclure)) {
    return phraseNumeroPris(ref, { libelle: `un ${(LIBELLE_TYPE_REFERENCE as Record<string, string>)[entree.docType] ?? "document"}`, reference: entree.reference });
  }
  return null;
}

/**
 * LE NUMÉRO DG D'UN BC DÉPOSÉ ENTRE AU REGISTRE (société au registre seulement) : son entrée suit son numéro, et le compteur
 * commun est porté AU MOINS à lui — jamais en arrière. Hors registre, ou hors forme NNN/DG/AAAA : rien à inscrire.
 */
export async function inscrireNumeroBcDepose(o: { companyId: string | null; reference: string | null | undefined; legalDocumentId: string; userId: string }): Promise<void> {
  const lu = lireReference(nettoyerNumero(o.reference));
  if (!lu || !o.companyId) return;
  const companyId = o.companyId;
  await prisma.$transaction(async (tx) => {
    const r = await registreDe(companyId, lu.annee, tx);
    if (!r.actif) return;
    const m = magasinPrisma(tx);
    await m.porterAuMoins(companyId, lu.annee, 0); // le verrou de la société
    const reference = formaterReference(lu.numero, lu.annee, r.largeur);
    const occupant = await tx.documentReference.findUnique({ where: { companyId_year_numero: { companyId, year: lu.annee, numero: lu.numero } }, select: { entityId: true } });
    if (occupant && occupant.entityId !== o.legalDocumentId) return; // pris entre-temps : le refus a déjà parlé
    const propre = await tx.documentReference.findFirst({ where: { companyId, entityType: "LEGAL_DOCUMENT", entityId: o.legalDocumentId }, select: { id: true } });
    if (propre) await tx.documentReference.update({ where: { id: propre.id }, data: { year: lu.annee, numero: lu.numero, reference } });
    else if (!occupant) await m.inscrire({ companyId, annee: lu.annee, numero: lu.numero, reference, docType: "BON_DE_COMMANDE", entityType: "LEGAL_DOCUMENT", entityId: o.legalDocumentId, createdById: o.userId });
    await m.porterAuMoins(companyId, lu.annee, lu.numero);
  });
}
