/**
 * Fabrique de documents — LE NUMÉRO CHOISI OU MODIFIÉ (Direction, 14/10/2026) : série portée au
 * moins à un numéro, porteur d'un numéro, jugement d'un numéro révisé, vérification du numéro d'une pièce.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { legalWriteAllowed } from "@/lib/legal/invoices";
import { LIBELLE_TYPE, NATURE_LEGALE, validerMotifNumero, type SpecDocumentCommercial, type TypeDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { LIBELLE_TYPE_REFERENCE, validerReferenceSaisie } from "@/lib/references/registre";
import { magasinPrisma } from "@/lib/references/registre-serveur";
import { memeNumero, nettoyerNumero, phraseNumeroPris, refusNumeroLibre, sequenceDuNumero } from "@/lib/bons-de-commande/numero-reference";
import { changementDeNumeroSeul } from "@/lib/bons-de-commande/numero-seul";
import { profilDocumentaire, type ProfilDocumentaire } from "./profil";
import { type Fabrique, fabriqueDe } from "./demande";
import { prefixeDe, ReferenceRefusee, registreDeLaPiece } from "./emission";
import { type ModificationsDocument, profilDeLaRevision, specRevisee } from "./revision";

// ─────────────────────────── Le numéro choisi ou modifié (Direction, 14/10/2026) ───────────────────────────

/**
 * PORTE LE COMPTEUR DE LA SÉRIE AU MOINS À `sequence` — jamais en arrière (`GREATEST`) — et le VERROUILLE pour la suite de la
 * transaction : deux saisies concurrentes du même numéro s'attendent. `null` : le numéro ne suit pas le motif ; le compteur
 * est seulement verrouillé.
 */
export async function porterSerieAuMoins(tx: Prisma.TransactionClient, companyId: string, kind: string, year: number, sequence: number | null): Promise<void> {
  const n = sequence ?? 0;
  await tx.$queryRaw`
    INSERT INTO "DocumentSequence" ("id", "companyId", "kind", "year", "last", "updatedAt")
    VALUES (${randomUUID()}, ${companyId}, ${kind}, ${year}, ${n}::int, now())
    ON CONFLICT ("companyId", "kind", "year")
    DO UPDATE SET "last" = GREATEST("DocumentSequence"."last", ${n}::int), "updatedAt" = now()
    RETURNING "last"`;
}

/** Le motif du numéro d'une nature pour la société (celui du profil, sinon le défaut). */
export const motifDe = (type: TypeDocumentCommercial, profil: ProfilDocumentaire): string => {
  const m = profil.reglages.numerotation[type] ?? null;
  return m && !validerMotifNumero(m) ? m.trim() : "{prefixe}-{aaaa}-{n:4}";
};

/**
 * QUI PORTE DÉJÀ CE NUMÉRO ? — dans sa série : au registre commun (tous documents de la société, l'année du numéro), et parmi
 * les pièces de même nature de la société (une pièce d'avant le registre, une pièce déposée). `exclure` : la pièce elle-même
 * (son propre numéro n'est pas « pris »). `null` : libre.
 */
export async function porteurDuNumero(
  client: Prisma.TransactionClient | typeof prisma,
  o: { companyId: string; kind: string; numero: string; registre: { annee: number; numero: number } | null; exclure: string | null },
): Promise<{ libelle: string; reference: string | null } | null> {
  if (o.registre) {
    const entree = await client.documentReference.findUnique({
      where: { companyId_year_numero: { companyId: o.companyId, year: o.registre.annee, numero: o.registre.numero } },
      select: { reference: true, docType: true, entityType: true, entityId: true },
    });
    if (entree && !(o.exclure && entree.entityType === "LEGAL_DOCUMENT" && entree.entityId === o.exclure)) {
      const lib = (LIBELLE_TYPE_REFERENCE as Record<string, string>)[entree.docType] ?? "document";
      return { libelle: `un ${lib}`, reference: entree.reference };
    }
  }
  const autre = await client.legalDocument.findFirst({
    where: { companyId: o.companyId, kind: o.kind as Prisma.LegalDocumentWhereInput["kind"], reference: { equals: o.numero, mode: "insensitive" }, ...(o.exclure ? { id: { not: o.exclure } } : {}) },
    select: { reference: true, title: true },
  });
  return autre ? { libelle: `la pièce « ${autre.title ?? autre.reference} »`, reference: null } : null;
}

/** Ce qu'une révision fait du numéro : rien, ou un NOUVEAU numéro jugé sur sa forme (l'unicité se juge au registre). */
type NumeroRevise =
  | { change: false }
  | { change: true; ancien: string; numero: string; annee: number; registre: { numero: number } | null; sequence: number | null; kind: string };

/**
 * LE NUMÉRO D'UNE PIÈCE RÉVISÉE (Direction, 14/10/2026 — « modifié quand on modifie ou qu'on révise n'importe quel bon de
 * commande ») : un BC ou un devis émis change de numéro DANS sa révision. Au registre commun NNN/DG/AAAA : la forme et l'année
 * de la pièce ; hors registre : un numéro libre, lisible. Le même numéro (casse, espaces) n'est pas un changement.
 */
export function jugerNumeroRevise(f: Fabrique, saisie: string | null | undefined, date: string, profil: ProfilDocumentaire): NumeroRevise | { refus: string } {
  const s = nettoyerNumero(saisie);
  if (!s || memeNumero(s, f.numero)) return { change: false };
  if (f.type !== "BON_DE_COMMANDE" && f.type !== "DEVIS") return { refus: `Le numéro d'une ${LIBELLE_TYPE[f.type].toLowerCase()} ne se modifie pas.` };
  const annee = Number(date.slice(0, 4));
  if (!Number.isFinite(annee)) return { refus: "La date de la pièce ne se lit pas : son numéro ne peut pas être jugé." };
  const kind = NATURE_LEGALE[f.type];
  const registre = registreDeLaPiece(f.type, profil, annee);
  if (registre) {
    const v = validerReferenceSaisie(s, annee, registre.largeur);
    if (!v.ok) return { refus: v.motif };
    if (memeNumero(v.reference, f.numero)) return { change: false };
    return { change: true, ancien: f.numero, numero: v.reference, annee, registre: { numero: v.numero }, sequence: null, kind };
  }
  const refus = refusNumeroLibre(s);
  if (refus) return { refus };
  return { change: true, ancien: f.numero, numero: s, annee, registre: null, sequence: sequenceDuNumero(s, { prefixe: prefixeDe(f.type, profil), annee, motif: motifDe(f.type, profil) }), kind };
}

/**
 * LA RÉVISION NE CHANGE-T-ELLE QUE LE NUMÉRO ? (Direction, 14/10/2026) — la saisie (`apres`, composée comme la révision, même
 * numéro) comparée à la pièce ENREGISTRÉE, champ saisi par champ saisi ; un autre papier en-tête choisi est un changement.
 */
export function revisionDeNumeroSeul(f: Fabrique, apres: SpecDocumentCommercial, m: ModificationsDocument): boolean {
  const papierChange = m.letterheadId !== undefined && ((m.letterheadId ?? "").trim() || null) !== (f.papierEnTeteId ?? null);
  return changementDeNumeroSeul(f.spec as unknown as Record<string, unknown>, apres as unknown as Record<string, unknown>, { numeroChange: true, papierChange }).seul;
}

/**
 * LE GESTE NE CHANGE-T-IL QUE LE NUMÉRO D'UNE PIÈCE ÉMISE ? — pour les portes qui retiennent un BC SIGNÉ (le poste Ad & Pro,
 * la demande au secrétariat) : un numéro seul s'y modifie, rien d'autre. Lecture seule, la même composition que la révision.
 */
export async function estRevisionDeNumeroSeul(user: CurrentUser, legalDocumentId: string, modifications: ModificationsDocument): Promise<boolean> {
  const doc = await prisma.legalDocument.findUnique({ where: { id: legalDocumentId }, select: { companyId: true, custom: true } });
  const f = doc ? fabriqueDe(doc.custom) : null;
  if (!doc || !f) return false;
  const lu = await profilDeLaRevision(user, doc.companyId, f, modifications);
  if (!lu.ok) return false;
  const apres = specRevisee(f, modifications, lu.p.profil);
  const renum = jugerNumeroRevise(f, modifications.numero, apres.date, lu.p.profil);
  return !("refus" in renum) && renum.change && revisionDeNumeroSeul(f, apres, modifications);
}

/**
 * ÉCRIT LE NOUVEAU NUMÉRO, sous verrou, dans la transaction de la révision : au registre, l'entrée de la pièce change de
 * numéro (ou naît, pour une pièce d'avant le registre) et le compteur commun est porté au moins à lui ; hors registre, le
 * compteur de la série est porté au moins à sa séquence. Un numéro pris entre-temps fait échouer la révision ENTIÈRE.
 */
export async function appliquerNumeroRevise(
  tx: Prisma.TransactionClient, n: Extract<NumeroRevise, { change: true }>, piece: { id: string; companyId: string; type: TypeDocumentCommercial }, userId: string,
): Promise<void> {
  const magasin = magasinPrisma(tx);
  if (n.registre) await magasin.porterAuMoins(piece.companyId, n.annee, 0); // le verrou de la société d'abord
  else await porterSerieAuMoins(tx, piece.companyId, n.kind, n.annee, n.sequence);
  const pris = await porteurDuNumero(tx, { companyId: piece.companyId, kind: n.kind, numero: n.numero, registre: n.registre ? { annee: n.annee, numero: n.registre.numero } : null, exclure: piece.id });
  if (pris) throw new ReferenceRefusee(phraseNumeroPris(n.numero, pris));
  if (!n.registre) return;
  const propre = await tx.documentReference.findFirst({ where: { companyId: piece.companyId, entityType: "LEGAL_DOCUMENT", entityId: piece.id }, select: { id: true } });
  if (propre) {
    await tx.documentReference.update({ where: { id: propre.id }, data: { year: n.annee, numero: n.registre.numero, reference: n.numero } });
  } else {
    const id = await magasin.inscrire({ companyId: piece.companyId, annee: n.annee, numero: n.registre.numero, reference: n.numero, docType: piece.type, entityType: "LEGAL_DOCUMENT", entityId: piece.id, createdById: userId });
    if (!id) throw new ReferenceRefusee(phraseNumeroPris(n.numero, null));
  }
  await magasin.porterAuMoins(piece.companyId, n.annee, n.registre.numero);
}

/**
 * LE NUMÉRO EST-IL LIBRE POUR CETTE PIÈCE ? — la vérification EN DIRECT du champ « N° de référence » du composeur, en
 * révision (la pièce elle-même exclue) comme à la composition hors registre. Lecture seule : rien n'est réservé.
 */
export async function verifierNumeroDeLaPiece(
  user: CurrentUser, o: { legalDocumentId?: string | null; societe?: string | null; type?: TypeDocumentCommercial; date?: string | null; numero: string },
): Promise<{ ok: true; numero: string; change: boolean } | { ok: false; motif: string }> {
  if (o.legalDocumentId) {
    const doc = await prisma.legalDocument.findUnique({ where: { id: o.legalDocumentId }, select: { id: true, companyId: true, custom: true } });
    const f = doc ? fabriqueDe(doc.custom) : null;
    if (!doc || !f) return { ok: false, motif: "Pièce introuvable." };
    const p = await profilDocumentaire(user, doc.companyId);
    if (!p.ok) return { ok: false, motif: p.motif };
    const j = jugerNumeroRevise(f, o.numero, (o.date ?? "").trim() || f.spec.date, p.profil);
    if ("refus" in j) return { ok: false, motif: j.refus };
    if (!j.change) return { ok: true, numero: f.numero, change: false };
    const pris = await porteurDuNumero(prisma, { companyId: f.societeId, kind: j.kind, numero: j.numero, registre: j.registre ? { annee: j.annee, numero: j.registre.numero } : null, exclure: doc.id });
    return pris ? { ok: false, motif: phraseNumeroPris(j.numero, pris) } : { ok: true, numero: j.numero, change: true };
  }
  const type = o.type ?? "BON_DE_COMMANDE";
  const p = await profilDocumentaire(user, o.societe ?? null);
  if (!p.ok) return { ok: false, motif: p.motif };
  const annee = Number((o.date ?? "").slice(0, 4)) || new Date().getUTCFullYear();
  const registre = registreDeLaPiece(type, p.profil, annee);
  const kind = NATURE_LEGALE[type];
  if (registre) {
    const v = validerReferenceSaisie(o.numero, annee, registre.largeur);
    if (!v.ok) return { ok: false, motif: v.motif };
    const pris = await porteurDuNumero(prisma, { companyId: p.profil.societe.id, kind, numero: v.reference, registre: { annee, numero: v.numero }, exclure: null });
    return pris ? { ok: false, motif: phraseNumeroPris(v.reference, pris) } : { ok: true, numero: v.reference, change: true };
  }
  const refus = refusNumeroLibre(o.numero);
  if (refus) return { ok: false, motif: refus };
  const numero = nettoyerNumero(o.numero);
  const pris = await porteurDuNumero(prisma, { companyId: p.profil.societe.id, kind, numero, registre: null, exclure: null });
  return pris ? { ok: false, motif: phraseNumeroPris(numero, pris) } : { ok: true, numero, change: true };
}

export function peutEcrire(user: CurrentUser, verbe: "CREATE" | "UPDATE", type: TypeDocumentCommercial): boolean {
  return legalWriteAllowed({ onLegal: userCan(user, "LEGAL", verbe), onFinances: userCan(user, "FINANCES", verbe), kind: NATURE_LEGALE[type] });
}
