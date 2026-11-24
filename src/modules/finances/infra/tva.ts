import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  bornesDeLaPeriode, calculerTvaDuMois, estPeriodeTva, raisonIncomplete, saisieDesTotaux, totauxDeLaSaisie,
  tvaAPreremplir, PHRASE_INCOMPLETE, type FacturePourTva, type LectureSaisieTva, type LigneTva, type RaisonIncomplete, type ResultatTvaDuMois,
  type SaisieTva, type SensTva, type SourceTva,
} from "../domaine/tva";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TVA DES FACTURES — l'écriture et le calcul du mois (lot « tva », 24/11/2026).
 *
 * Un seul écrivain de `FactureTva` (`enregistrerTvaFacture`) : la fabrique (facture et avoir émis), le formulaire
 * Legal (facture d'achat ou de vente saisie, préremplie par la lecture) et la facture de matériel (ses lignes) passent tous
 * par lui. La cohérence (HT + TVA = TTC, TVA = base × taux) est jugée par le domaine AVANT d'arriver ici.
 *
 * `tvaDuMois` est la source de la ligne « TVA du mois » de la G50 : par SOCIÉTÉ (la pièce porte la sienne) et par
 * mois d'émission. L'accès à la société est vérifié par l'appelant (l'écran des impôts), comme pour toute requête du
 * module : cette fonction ne lit qu'une société, celle qu'on lui nomme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Client = PrismaClient | Prisma.TransactionClient;

const dec = (x: number) => new Prisma.Decimal(x.toFixed(2));
const num = (d: Prisma.Decimal | null | undefined): number => (d == null ? 0 : Number(d));

/** ÉCRIT la TVA d'une facture (la remplace si elle existait) — détail par taux compris. */
export async function enregistrerTvaFacture(
  legalDocumentId: string,
  saisie: SaisieTva,
  ctx: { source: SourceTva; acteurId: string | null; sens?: SensTva | null },
  client: Client = prisma,
): Promise<void> {
  const t = totauxDeLaSaisie(saisie);
  const data = {
    montantHt: dec(t.ht), montantTva: dec(t.tva), autresTaxes: dec(saisie.autresTaxes), montantTtc: dec(saisie.ttc),
    source: ctx.source, saisieParId: ctx.acteurId,
  };
  // Le SENS enregistré n'est réécrit que s'il est donné : corriger la TVA d'une facture d'achat depuis sa fiche
  // ne lui fait pas perdre le « déductible » que son circuit avait posé.
  const ligne = await client.factureTva.upsert({
    where: { legalDocumentId },
    create: { legalDocumentId, ...data, sens: ctx.sens ?? null },
    update: { ...data, ...(ctx.sens !== undefined ? { sens: ctx.sens } : {}) },
    select: { id: true },
  });
  await client.factureTvaTaux.deleteMany({ where: { factureTvaId: ligne.id } });
  await client.factureTvaTaux.createMany({
    data: saisie.lignes.map((l) => ({ factureTvaId: ligne.id, taux: dec(l.taux), baseHt: dec(l.baseHt), montantTva: dec(l.tva) })),
  });
}

/**
 * APRÈS L'ÉCRITURE D'UNE PIÈCE PAR LE FORMULAIRE LEGAL : sa TVA lue (`lireTvaDeLaPiece`) est écrite, effacée (les champs
 * envoyés vides), ou laissée telle quelle (le formulaire ne les portait pas — une pièce émise, un appel d'Adam).
 */
export async function appliquerTvaDuFormulaire(legalDocumentId: string, lecture: LectureSaisieTva, acteurId: string): Promise<void> {
  if (!lecture.ok || !lecture.envoyee) return;
  if (!lecture.saisie) return effacerTvaFacture(legalDocumentId);
  await enregistrerTvaFacture(legalDocumentId, lecture.saisie, { source: lecture.lue ? "LECTURE" : "SAISIE", acteurId });
}

/** EFFACE la TVA d'une facture : elle redevient « à compléter ». */
export async function effacerTvaFacture(legalDocumentId: string, client: Client = prisma): Promise<void> {
  await client.factureTva.deleteMany({ where: { legalDocumentId } });
}

/**
 * LA TVA D'UNE PIÈCE ÉMISE PAR LA FABRIQUE, depuis ses totaux calculés — facture ou avoir seulement : un devis ou un
 * bon de commande ne déclare pas de TVA. Collectée : la plateforme n'émet que des factures de vente, au nom de la société.
 */
export async function enregistrerTvaDeLaPieceEmise(
  legalDocumentId: string,
  type: string,
  totaux: Parameters<typeof saisieDesTotaux>[0],
  acteurId: string,
  client: Client = prisma,
): Promise<void> {
  if (type !== "FACTURE" && type !== "AVOIR") return;
  await enregistrerTvaFacture(legalDocumentId, saisieDesTotaux(totaux), { source: "FABRIQUE", acteurId, sens: "COLLECTEE" }, client);
}

const SELECT_PIECE = {
  id: true, reference: true, title: true, kind: true, direction: true, amount: true, startDate: true,
  chainFrom: { select: { direction: true } },
  tva: { select: { sens: true, autresTaxes: true, montantTtc: true, taux: { select: { taux: true, baseHt: true, montantTva: true } } } },
} satisfies Prisma.LegalDocumentSelect;

type PieceLue = Prisma.LegalDocumentGetPayload<{ select: typeof SELECT_PIECE }>;

function pourTva(p: PieceLue): FacturePourTva {
  const lignes: LigneTva[] = (p.tva?.taux ?? []).map((l) => ({ taux: num(l.taux), baseHt: num(l.baseHt), tva: num(l.montantTva) }));
  return {
    id: p.id, reference: p.reference, titre: p.title, avoir: p.kind === "CREDIT_NOTE",
    // UN AVOIR SANS DIRECTION PROPRE suit sa facture : il en corrige la TVA, dans le même sens.
    direction: p.direction ?? (p.kind === "CREDIT_NOTE" ? p.chainFrom?.direction ?? null : null),
    montant: p.amount === null ? null : num(p.amount),
    dateEmission: p.startDate,
    tva: p.tva ? { sens: p.tva.sens, lignes, autresTaxes: num(p.tva.autresTaxes), montantTtc: num(p.tva.montantTtc) } : null,
  };
}

/** Les pièces qui déclarent une TVA : factures et avoirs, sauf annulés. */
const PIECES_TVA = { kind: { in: ["INVOICE", "CREDIT_NOTE"] as ("INVOICE" | "CREDIT_NOTE")[] }, status: { not: "CANCELLED" as const } };

/**
 * LA TVA DU MOIS d'une société — collectée, déductible, à payer (crédit si négatif), détail par taux, et les pièces
 * à compléter. Rattachement : la date d'émission (`REGLE_DE_RATTACHEMENT`) ; une pièce SANS date d'émission est
 * rattachée au mois de son enregistrement pour être LISTÉE à compléter, jamais comptée.
 */
export async function tvaDuMois(companyId: string, periode: string): Promise<ResultatTvaDuMois> {
  if (!companyId || !estPeriodeTva(periode)) return calculerTvaDuMois(periode, []);
  const { debut, fin } = bornesDeLaPeriode(periode);
  const pieces = await prisma.legalDocument.findMany({
    where: {
      companyId, ...PIECES_TVA,
      OR: [{ startDate: { gte: debut, lt: fin } }, { startDate: null, createdAt: { gte: debut, lt: fin } }],
    },
    select: SELECT_PIECE,
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  return calculerTvaDuMois(periode, pieces.map(pourTva));
}

/**
 * LE BRANCHEMENT DE LA G50 : ce que la ligne « TVA du mois » peut proposer — `null` quand il n'y a rien à proposer
 * ou qu'une pièce du mois est à compléter (`tvaAPreremplir`). Une source en panne ne bloque jamais : `null`.
 */
export async function tvaAPayerDuMois(companyId: string, periode: string | null): Promise<number | null> {
  if (!companyId || !estPeriodeTva(periode)) return null;
  return tvaAPreremplir(await tvaDuMois(companyId, periode));
}

export interface EtatTvaFacture {
  ht: number | null;
  tva: number | null;
  /** Pourquoi la facture est « à compléter » — `null` : sa TVA est complète. */
  aCompleter: RaisonIncomplete | null;
  phrase: string | null;
}

/** L'ÉTAT DE LA TVA de pièces données (la liste Legal) : HT, TVA, et ce qui reste à compléter. */
export async function etatTvaDesFactures(ids: readonly string[]): Promise<Map<string, EtatTvaFacture>> {
  const out = new Map<string, EtatTvaFacture>();
  if (ids.length === 0) return out;
  const pieces = await prisma.legalDocument.findMany({ where: { id: { in: [...ids] }, ...PIECES_TVA }, select: SELECT_PIECE });
  for (const p of pieces) {
    const f = pourTva(p);
    const raison = raisonIncomplete(f);
    out.set(p.id, {
      ht: p.tva ? totauxDeLaSaisie(f.tva!).ht : null,
      tva: p.tva ? totauxDeLaSaisie(f.tva!).tva : null,
      aCompleter: raison, phrase: raison ? PHRASE_INCOMPLETE[raison] : null,
    });
  }
  return out;
}

/** La TVA d'une facture telle que son formulaire la rouvre — `null` : non renseignée. */
export async function tvaDeLaFacture(legalDocumentId: string): Promise<(Pick<SaisieTva, "lignes" | "autresTaxes"> & { source: string; sens: SensTva | null }) | null> {
  const t = await prisma.factureTva.findUnique({
    where: { legalDocumentId },
    select: { source: true, sens: true, autresTaxes: true, taux: { select: { taux: true, baseHt: true, montantTva: true }, orderBy: { taux: "desc" } } },
  });
  if (!t) return null;
  return {
    source: t.source, sens: t.sens === "COLLECTEE" || t.sens === "DEDUCTIBLE" ? t.sens : null,
    autresTaxes: num(t.autresTaxes),
    lignes: t.taux.map((l) => ({ taux: num(l.taux), baseHt: num(l.baseHt), tva: num(l.montantTva) })),
  };
}
