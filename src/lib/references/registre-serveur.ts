import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  KIND_REGISTRE, attribuerReference, formaterReference, largeurRegistre, numeroPrevu, phraseDejaAttribuee, plancherRegistre,
  prochainNumero, registreActif, validerReferenceSaisie,
  type DemandeReference, type MagasinRegistre, type ReferenceAttribuee, type ReferenceProchaine,
} from "@/lib/references/registre";

/**
 * LE REGISTRE COMMUN DES RÉFÉRENCES NNN/DG/AAAA, CÔTÉ SERVEUR — le magasin Prisma de `registre.ts` (la règle, pure) : le
 * compteur `DocumentSequence` (kind `REGISTRE_DG`) et le registre `DocumentReference`. Chaque écriture passe par la
 * transaction du document qui reçoit la référence : le numéro et le document naissent ensemble, ou pas du tout.
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** L'année du registre : l'année civile du jour, à Alger (UTC+1, sans heure d'été). */
export function anneeDuRegistre(maintenant = new Date()): number {
  return new Date(maintenant.getTime() + 60 * 60 * 1000).getUTCFullYear();
}

export function magasinPrisma(tx: Prisma.TransactionClient): MagasinRegistre {
  return {
    async avancer(companyId, annee, plancher) {
      const rows = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO "DocumentSequence" ("id", "companyId", "kind", "year", "last", "updatedAt")
        VALUES (${randomUUID()}, ${companyId}, ${KIND_REGISTRE}, ${annee}, ${plancher}::int, now())
        ON CONFLICT ("companyId", "kind", "year")
        DO UPDATE SET "last" = GREATEST("DocumentSequence"."last" + 1, ${plancher}::int), "updatedAt" = now()
        RETURNING "last"`;
      return Number(rows[0].last);
    },
    async porterAuMoins(companyId, annee, numero) {
      await tx.$queryRaw`
        INSERT INTO "DocumentSequence" ("id", "companyId", "kind", "year", "last", "updatedAt")
        VALUES (${randomUUID()}, ${companyId}, ${KIND_REGISTRE}, ${annee}, ${numero}::int, now())
        ON CONFLICT ("companyId", "kind", "year")
        DO UPDATE SET "last" = GREATEST("DocumentSequence"."last", ${numero}::int), "updatedAt" = now()
        RETURNING "last"`;
    },
    async occupant(companyId, annee, numero) {
      return tx.documentReference.findUnique({
        where: { companyId_year_numero: { companyId, year: annee, numero } },
        select: { reference: true, docType: true },
      });
    },
    async inscrire(e) {
      // ON CONFLICT DO NOTHING : un numéro pris entre-temps ne fait pas échouer la transaction du document — il se dit.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "DocumentReference" ("id", "companyId", "year", "numero", "reference", "docType", "entityType", "entityId", "createdById", "createdAt")
        VALUES (${randomUUID()}, ${e.companyId}, ${e.annee}, ${e.numero}::int, ${e.reference}, ${e.docType}, ${e.entityType}, ${e.entityId}, ${e.createdById}, now())
        ON CONFLICT ("companyId", "year", "numero") DO NOTHING
        RETURNING "id"`;
      return rows[0]?.id ?? null;
    },
  };
}

export interface RegistreSociete {
  actif: boolean;
  plancher: number;
  largeur: number;
}

/** Les réglages du registre d'une société (son profil documentaire) — inactif sans profil. */
export async function registreDe(companyId: string | null | undefined, annee: number, client: Client = prisma): Promise<RegistreSociete> {
  if (!companyId) return { actif: false, plancher: 1, largeur: 3 };
  const p = await client.companyDocumentProfile.findUnique({ where: { companyId }, select: { settings: true } });
  const settings = p?.settings ?? null;
  return { actif: registreActif(settings), plancher: plancherRegistre(settings, annee), largeur: largeurRegistre(settings) };
}

/** Le prochain numéro du registre — PRÉVU, jamais réservé : ce que le formulaire préremplit. */
export async function prevoirReference(
  companyId: string, annee: number, r: Pick<RegistreSociete, "plancher" | "largeur">, client: Client = prisma,
): Promise<string> {
  const seq = await client.documentSequence.findUnique({
    where: { companyId_kind_year: { companyId, kind: KIND_REGISTRE, year: annee } }, select: { last: true },
  });
  const dernier = seq?.last ?? 0;
  const depart = prochainNumero(dernier, r.plancher);
  const pris = new Set(
    (await client.documentReference.findMany({ where: { companyId, year: annee, numero: { gte: depart, lt: depart + 500 } }, select: { numero: true } }))
      .map((x) => x.numero),
  );
  return formaterReference(numeroPrevu(dernier, r.plancher, (n) => pris.has(n)), annee, r.largeur);
}

/** Ce que le champ « Référence » d'un formulaire lit : la société, si elle tient le registre, et son prochain numéro. */
export async function etatDuRegistre(companyId: string | null | undefined, annee = anneeDuRegistre()): Promise<ReferenceProchaine> {
  if (!companyId) return { ok: true, actif: false, societeId: null, prochaine: null };
  const r = await registreDe(companyId, annee);
  return { ok: true, actif: r.actif, societeId: companyId, prochaine: r.actif ? await prevoirReference(companyId, annee, r) : null };
}

/** La vérification du formulaire (avant de finaliser) : bon format, bonne année, numéro encore libre pour la société. */
export async function verifierReferenceLibre(
  companyId: string, saisie: string, annee = anneeDuRegistre(),
): Promise<{ ok: true; reference: string } | { ok: false; motif: string }> {
  const r = await registreDe(companyId, annee);
  const v = validerReferenceSaisie(saisie, annee, r.largeur);
  if (!v.ok) return v;
  const pris = await prisma.documentReference.findUnique({
    where: { companyId_year_numero: { companyId, year: annee, numero: v.numero } }, select: { docType: true },
  });
  if (pris) return { ok: false, motif: phraseDejaAttribuee(v.reference, pris) };
  return { ok: true, reference: v.reference };
}

/**
 * ATTRIBUER au registre — dans la transaction `tx` du document quand il y en a une, sinon dans la sienne. Le plancher et la
 * largeur viennent du profil de la société ; l'appelant a vérifié qu'elle tient le registre (`registreDe(...).actif`).
 */
export async function attribuerAuRegistre(
  d: Omit<DemandeReference, "plancher" | "largeur">, tx?: Prisma.TransactionClient,
): Promise<ReferenceAttribuee> {
  const jouer = async (t: Prisma.TransactionClient) => {
    const r = await registreDe(d.companyId, d.annee, t);
    return attribuerReference(magasinPrisma(t), { ...d, plancher: r.plancher, largeur: r.largeur });
  };
  return tx ? jouer(tx) : prisma.$transaction(jouer);
}

/** Rattache l'entrée du registre au document qui vient de naître (sa ligne Legal, sa demande RH…). */
export async function rattacherReference(id: string, entityType: string, entityId: string, client: Client = prisma): Promise<void> {
  await client.documentReference.update({ where: { id }, data: { entityType, entityId } });
}
