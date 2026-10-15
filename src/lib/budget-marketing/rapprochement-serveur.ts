import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { canManageEnvelope, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { entityHref } from "@/lib/entity-href";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import { recordAudit } from "@/lib/audit";
import { clauseAImputer } from "@/lib/finance/a-imputer";
import { engagementsBruts } from "@/lib/queries/budget-sources";
import {
  SELECT_PARENTS_POSTE, cleDemandeDuPoste, consommationIntegree, contexteDeLEnveloppe, jugerEngagements, originesDesOrdres,
  type ContexteIntegration,
} from "@/lib/queries/budget-integration";
import { estAbsenteDuFichier } from "@/lib/budget/integration-regle";
import { libellesDesDemandes } from "@/lib/queries/budget-marketing-rapport";
import { colonneParent } from "@/lib/budget-marketing/integration-serveur";
import { cleDuStepKey, lienDemande, piecesAttenduesDe, piecesRattacheesDe, type PieceRattachee } from "@/lib/budget-marketing/integration-vue";
import { ANNEE_INTEGRATION, type TypeDemandeIntegree } from "@/lib/budget-marketing/integration-2026";
import { lirePieceParLuna, refusAvantLecture } from "@/lib/budget-marketing/rapprochement-luna";
import {
  LIBELLE_TYPE_PIECE, REGLE_CERTAINE, cleNumeroPiece, doublonsProbables, dzd, estSourceDepense, estSourcePiece, extraireReferences,
  indiceHorsAdPro, rapprocherDepenses, rapprocherPieces, sansLesDecidees, trierPropositions, typeDePiece,
  type DecisionRapprochement, type DemandeCible, type DepenseARapprocher, type DoublonProbable, type ElementDoublon,
  type IndiceHorsAdPro, type LuDePiece, type NatureDepense, type PieceARapprocher, type Proposition, type SensRapprochement,
} from "@/lib/budget-marketing/rapprochement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AD & PRO — LES LECTURES ET LES ÉCRITURES (Budget Marketing › Intégration 2026 › Rapprochement).
 *
 *   • LES CIBLES : les demandes du lot d'intégration actif de l'enveloppe (les 30 « Historique 2026 » et les demandes
 *     complétées), leurs postes, leurs fournisseurs et références (BC, factures des postes), leurs pièces attendues et
 *     manquantes ;
 *   • LES DÉPENSES : ce qui compte à l'enveloppe HORS poste (écritures, lignes budgétaires, ordres en circuit — règle du
 *     lot appliquée, `queries/budget-integration.ts`) et les écritures « à imputer » de la société ;
 *   • LES PIÈCES : les fichiers de la plateforme qui peuvent justifier une demande — pièces Legal, Ad & Pro (demandes,
 *     postes), secrétariat, ordres, demandes de paiement, écritures, Budget ; fichiers commerciaux du Drive ; pièces
 *     jointes des conversations de la personne — lus par Luna PAR TRANCHES (`lireTranche`), une fois par empreinte ;
 *   • LES DÉCISIONS : accepter, refuser, choisir une autre demande, « pas Ad & Pro », annuler — auditées. Une dépense
 *     acceptée devient la preuve de paiement de la demande / du poste et ne compte plus deux fois (la règle du lot lit
 *     `AdProRapprochement`) ; une pièce acceptée rejoint les pièces RATTACHÉES de la demande (un lien, jamais une copie).
 *
 * Porte : gérer l'enveloppe du lot (gestionnaire délégué, Super Admin) — la même que l'intégration. Le livre de
 * trésorerie et les ordres ne sont JAMAIS écrits ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE_AUDIT = "Budget Marketing — rapprochement Ad & Pro";
/** Les pièces déposées depuis le 1er juillet de l'année précédente : une facture d'événement 2026 se dépose rarement avant. */
const DEPUIS = new Date(Date.UTC(ANNEE_INTEGRATION - 1, 6, 1));
const LIMITE_DOCUMENTS = 6000;
const LIMITE_DRIVE = 2000;
const LIMITE_MESSAGES = 1000;
const uniques = <T>(xs: readonly (T | null | undefined | false)[]): T[] => [...new Set(xs.filter((x): x is T => x != null && x !== false))];

// ─────────────────────────────── Le lot et ses cibles ───────────────────────────────

async function lotActif(envelopeId: string) {
  return prisma.adProIntegrationLot.findFirst({
    where: { envelopeId, annuleLe: null },
    include: { envelope: true, demandes: { orderBy: { ligne: "asc" } } },
  });
}
type Lot = NonNullable<Awaited<ReturnType<typeof lotActif>>>;
type RowDemande = Lot["demandes"][number];

/** Le lot actif d'une enveloppe que la personne GÈRE — `null` sinon (la porte de tout l'écran). */
export async function lotActifGere(user: SessionUser, envelopeId: string | null | undefined): Promise<Lot | null> {
  if (!envelopeId) return null;
  const lot = await lotActif(envelopeId);
  return lot && canManageEnvelope(user, lot.envelope) ? lot : null;
}

export async function chargerCibles(demandes: readonly RowDemande[]): Promise<DemandeCible[]> {
  if (demandes.length === 0) return [];
  const cles = demandes.map((d) => `${d.demandeType}:${d.demandeId}`);
  const [libelles, postes, deposes] = await Promise.all([
    libellesDesDemandes(cles),
    prisma.adProItem.findMany({
      where: { OR: demandes.map((d) => ({ [colonneParent(d.demandeType as TypeDemandeIntegree)]: d.demandeId }) as Prisma.AdProItemWhereInput), status: { not: "REJECTED" } },
      select: {
        id: true, label: true, amountGranted: true, amountEstimated: true, montantPayeHistorique: true, historiquePayeLe: true, supplier: true,
        ...SELECT_PARENTS_POSTE,
        pieces: { select: { legalDocumentId: true, legalDocument: { select: { reference: true, counterparty: true, title: true } } } },
      },
    }),
    prisma.document.findMany({
      where: { OR: demandes.map((d) => ({ entityType: d.demandeType as never, entityId: d.demandeId })), stepKey: { startsWith: "integration:" } },
      select: { id: true, entityId: true, stepKey: true },
    }),
  ]);
  return demandes.map((d) => {
    const cle = `${d.demandeType}:${d.demandeId}`;
    const ps = postes.filter((p) => cleDemandeDuPoste(p) === cle);
    const libelle = libelles[cle]?.libelle ?? d.libelle;
    const attendues = piecesAttenduesDe(d.piecesAttendues);
    const rattachees = piecesRattacheesDe(d.piecesRattachees);
    const deps = deposes.filter((x) => x.entityId === d.demandeId);
    const fournies = new Set(uniques([...deps.map((x) => cleDuStepKey(x.stepKey)), ...rattachees.map((r) => r.cle)]));
    const dates = ps.map((p) => p.historiquePayeLe?.getTime()).filter((x): x is number => typeof x === "number");
    return {
      rowId: d.id, cle, type: d.demandeType, libelle, montant: toNumber(d.montant),
      date: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
      historique: d.mode === "CREEE",
      fournisseurs: uniques([...ps.map((p) => p.supplier), ...ps.flatMap((p) => p.pieces.map((x) => x.legalDocument.counterparty))]),
      references: uniques([
        ...extraireReferences(libelle, d.libelle),
        ...ps.flatMap((p) => p.pieces.flatMap((x) => [cleNumeroPiece(x.legalDocument.reference), ...extraireReferences(x.legalDocument.reference, x.legalDocument.title)])),
      ]),
      postes: ps.map((p) => ({
        id: p.id, libelle: p.label, montant: toNumber(p.montantPayeHistorique ?? p.amountGranted ?? p.amountEstimated ?? 0),
        fournisseur: p.supplier, date: p.historiquePayeLe?.toISOString() ?? null,
      })).filter((p) => p.montant > 0),
      attendues,
      manquantes: attendues.filter((a) => !fournies.has(a.cle)).map((a) => a.cle),
      piecesDeja: uniques([...deps.map((x) => `DOC:${x.id}`), ...rattachees.map((r) => r.ref ?? (r.documentId ? `DOC:${r.documentId}` : null))]),
      entites: [cle, ...ps.map((p) => `AD_PRO_ITEM:${p.id}`), ...ps.flatMap((p) => p.pieces.map((x) => `LEGAL_DOCUMENT:${x.legalDocumentId}`))],
    };
  });
}

// ─────────────────────────────── Ce que Luna a déjà lu ───────────────────────────────

type LectureGardee = { etat: string; raison: string | null; lu: LuDePiece | null };

async function lecturesGardees(empreintes: readonly string[]): Promise<Map<string, LectureGardee>> {
  const out = new Map<string, LectureGardee>();
  const u = uniques(empreintes);
  for (let i = 0; i < u.length; i += 5000) {
    const lignes = await prisma.adProRapprochementLecture.findMany({ where: { empreinte: { in: u.slice(i, i + 5000) } } });
    for (const l of lignes) {
      out.set(l.empreinte, {
        etat: l.etat, raison: l.raison,
        lu: l.etat === "LUE" ? { fournisseur: l.fournisseur, montant: l.montant == null ? null : toNumber(l.montant), date: l.date, numero: l.numero, nature: l.nature, references: l.references, motsCles: l.motsCles } : null,
      });
    }
  }
  return out;
}

/** L'empreinte des fichiers de documents (`Document.fileKey` → `StoredFile` → `FileBlob`). */
async function empreintesDesDocuments(docs: readonly { id: string; fileKey: string | null }[]): Promise<Map<string, string>> {
  const cles = uniques(docs.map((d) => d.fileKey));
  if (cles.length === 0) return new Map();
  const stockes = await prisma.storedFile.findMany({ where: { key: { in: cles } }, select: { key: true, blobId: true } });
  const blobs = stockes.length ? await prisma.fileBlob.findMany({ where: { id: { in: uniques(stockes.map((s) => s.blobId)) } }, select: { id: true, sha256: true } }) : [];
  const sha = new Map(blobs.map((b) => [b.id, b.sha256]));
  const parCle = new Map(stockes.map((s) => [s.key, sha.get(s.blobId) ?? null]));
  const out = new Map<string, string>();
  for (const d of docs) { const h = d.fileKey ? parCle.get(d.fileKey) : null; if (h) out.set(d.id, h); }
  return out;
}

// ─────────────────────────────── Les dépenses ───────────────────────────────

export interface DepenseVue {
  source: string;
  nature: NatureDepense;
  aImputer: boolean;
  reference: string;
  libelle: string;
  montant: number;
  date: string;
  fournisseur: string | null;
  href: string | null;
  propositions: Proposition[];
  horsAdPro: IndiceHorsAdPro | null;
  /** Ce que Luna a lu des pièces jointes (en clair, pour l'écran). */
  piecesLues: string[];
}

const SELECT_TX = { id: true, reference: true, label: true, amount: true, date: true, counterparty: true, category: true } as const;

async function chargerDepenses(env: Lot["envelope"], ctx: ContexteIntegration): Promise<{ depenses: (DepenseARapprocher & { href: string | null })[]; jugees: { cle: string; absente: boolean }[] }> {
  const catIds = [...ctx.categories];
  const [integ, eng, aImputer] = await Promise.all([
    consommationIntegree([ctx], catIds, env.periodStart, env.periodEnd),
    engagementsBruts(catIds, env.periodEnd),
    clauseAImputer(env.periodStart, env.periodEnd, { societeId: env.companyId }).then((where) =>
      prisma.financeTransaction.findMany({ where, orderBy: { date: "desc" }, take: 300, select: SELECT_TX })),
  ]);
  // Les écritures qu'a réglées l'ordre d'un POSTE : elles sont sur la ligne du poste (tableau des dépenses), pas « hors poste ».
  const ids = integ.ecritures.map((e) => e.id);
  const ordres = ids.length ? await prisma.expenseOrder.findMany({ where: { transactionId: { in: ids } }, select: { id: true, transactionId: true, sourceType: true, sourceId: true } }) : [];
  const origines = await originesDesOrdres(ordres);
  const dePoste = new Set(ordres.filter((o) => origines.get(o.id)?.posteId).map((o) => o.transactionId));
  const ecritures = integ.ecritures.filter((e) => !dePoste.has(e.id));
  // Les ordres HORS poste émis, pas encore réglés, qui comptent à l'enveloppe.
  const horsPoste = eng.details.filter((d) => d.nature === "EN_CIRCUIT" && d.ordreId && !d.posteId);
  const ordresComptes = horsPoste.length ? (await jugerEngagements([ctx], horsPoste)).comptes : [];
  const ordresHP = ordresComptes.length
    ? await prisma.expenseOrder.findMany({ where: { id: { in: uniques(ordresComptes.map((o) => o.ordreId)) } }, select: { id: true, reference: true, label: true, amount: true, createdAt: true, beneficiary: true } })
    : [];

  // Les pièces de ces dépenses (fichiers joints aux écritures et aux ordres, factures réglées par l'écriture) — et ce que Luna en a lu.
  const txIds = uniques([...ecritures.map((e) => e.id), ...aImputer.map((t) => t.id)]);
  const factures = txIds.length ? await prisma.legalDocument.findMany({ where: { settlementTxId: { in: txIds } }, select: { id: true, settlementTxId: true } }) : [];
  const docs = txIds.length || ordresHP.length || factures.length
    ? await prisma.document.findMany({
        where: { OR: [
          ...(txIds.length ? [{ entityType: "FINANCE_TRANSACTION" as const, entityId: { in: txIds } }] : []),
          ...(ordresHP.length ? [{ entityType: "EXPENSE_ORDER" as const, entityId: { in: ordresHP.map((o) => o.id) } }] : []),
          ...(factures.length ? [{ entityType: "LEGAL_DOCUMENT" as const, entityId: { in: factures.map((f) => f.id) } }] : []),
        ] },
        select: { id: true, name: true, fileKey: true, entityType: true, entityId: true },
      })
    : [];
  const sha = await empreintesDesDocuments(docs);
  const lectures = await lecturesGardees([...sha.values()]);
  const factureDe = new Map(factures.map((f) => [f.id, f.settlementTxId as string]));
  const piecesDe = new Map<string, { nom: string; lu: LuDePiece | null }[]>();
  for (const d of docs) {
    const porteur = d.entityType === "LEGAL_DOCUMENT" ? factureDe.get(d.entityId) : d.entityId;
    if (!porteur) continue;
    const h = sha.get(d.id);
    piecesDe.set(porteur, [...(piecesDe.get(porteur) ?? []), { nom: d.name, lu: h ? lectures.get(h)?.lu ?? null : null }]);
  }
  const avecPieces = (id: string) => {
    const p = piecesDe.get(id) ?? [];
    return { indices: p.map((x) => x.nom), lu: p.filter((x) => x.lu).map((x) => ({ ...(x.lu as LuDePiece), nom: x.nom })) };
  };

  const depenses: (DepenseARapprocher & { href: string | null })[] = [
    ...ecritures.map((e) => {
      const p = avecPieces(e.id);
      return {
        source: `TX:${e.id}`, nature: "ECRITURE" as const, aImputer: false, reference: e.reference, libelle: e.label,
        montant: toNumber(e.amount as Parameters<typeof toNumber>[0]), date: e.date.toISOString(), fournisseur: e.counterparty,
        indices: [...(e.category ? [e.category] : []), ...p.indices], lu: p.lu, href: null,
      };
    }),
    ...integ.lignes.map((l) => ({
      source: `LIGNE:${l.id}`, nature: "LIGNE" as const, aImputer: false, reference: "Ligne budgétaire", libelle: l.reference,
      montant: toNumber(l.amount as Parameters<typeof toNumber>[0]), date: l.date.toISOString(), fournisseur: null, indices: [], lu: [], href: null,
    })),
    ...ordresHP.map((o) => {
      const p = avecPieces(o.id);
      return {
        source: `ORDRE:${o.id}`, nature: "ORDRE" as const, aImputer: false, reference: o.reference, libelle: o.label,
        montant: toNumber(o.amount), date: o.createdAt.toISOString(), fournisseur: o.beneficiary, indices: p.indices, lu: p.lu, href: entityHref("EXPENSE_ORDER", o.id),
      };
    }),
    ...aImputer.map((t) => {
      const p = avecPieces(t.id);
      return {
        source: `TX:${t.id}`, nature: "ECRITURE" as const, aImputer: true, reference: t.reference, libelle: t.label,
        montant: toNumber(t.amount), date: t.date.toISOString(), fournisseur: t.counterparty,
        indices: [...(t.category ? [t.category] : []), ...p.indices], lu: p.lu, href: null,
      };
    }),
  ];
  return { depenses, jugees: integ.jugees.map((j) => ({ cle: j.cle, absente: estAbsenteDuFichier(j.verdict) })) };
}

// ─────────────────────────────── Les pièces de la plateforme ───────────────────────────────

/** Les dossiers dont un fichier peut justifier une demande Ad & Pro. */
const TYPES_DOSSIERS = [
  "LEGAL_DOCUMENT", "AD_PRO_ITEM", "AD_PRO_OTHER", "SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "TRAINING",
  "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION", "ADMIN_REQUEST", "EXPENSE_ORDER", "PAYMENT_REQUEST", "FINANCE_TRANSACTION", "BUDGET",
];
const OU_DOSSIER: Record<string, string> = {
  LEGAL_DOCUMENT: "Legal", AD_PRO_ITEM: "Ad & Pro — poste", AD_PRO_OTHER: "Ad & Pro", SPONSORING: "Ad & Pro — sponsoring",
  CONGRESS_NATIONAL: "Ad & Pro — congrès national", CONGRESS_INTERNATIONAL: "Ad & Pro — congrès international", EVENT: "Ad & Pro — événement",
  TRAINING: "Formation", PROMO_MATERIAL: "Matériel promotionnel", MEDICAL_INFO_DECLARATION: "Information médicale",
  ADMIN_REQUEST: "Secrétariat", EXPENSE_ORDER: "Finances — ordre de dépense", PAYMENT_REQUEST: "Demandes de paiement",
  FINANCE_TRANSACTION: "Trésorerie — écriture", BUDGET: "Budget",
};
/** Un nom de fichier du Drive ou de la messagerie qui ressemble à une pièce commerciale (expression POSIX de Postgres). */
const MOTIF_PIECE = "(factur|invoice|devis|proforma|pro.forma|commande|convention|contrat|quittance|bordereau|versement|virement|recu|reçu|billet|honorair|sponsor|bc[ _-]|fact[ _-])";

export interface CandidatPiece {
  source: string;
  nom: string;
  ou: string;
  href: string | null;
  entite: string | null;
  entityType: string | null;
  entityId: string | null;
  blobId: string;
  empreinte: string;
  taille: number | null;
  confidentielle: boolean;
  /** Ad & Pro et Legal d'abord dans la file de lecture. */
  priorite: number;
}

/** TOUS les fichiers candidats — des métadonnées seulement (jamais les octets), en trois lectures. */
export async function listerPieces(user: SessionUser): Promise<CandidatPiece[]> {
  const [docs, drive, messages] = await Promise.all([
    prisma.$queryRaw<{ id: string; name: string; entityType: string; entityId: string; conf: string; taille: number | null; blobId: string; sha256: string }[]>`
      SELECT d.id, d.name, d."entityType"::text AS "entityType", d."entityId", d.confidentiality::text AS conf, d."sizeBytes" AS taille,
             s."blobId", b.sha256
      FROM "Document" d
      JOIN "StoredFile" s ON s.key = d."fileKey"
      JOIN "FileBlob" b ON b.id = s."blobId"
      WHERE d."entityType"::text = ANY(${TYPES_DOSSIERS}::text[]) AND d."createdAt" >= ${DEPUIS}
        AND (d."stepKey" IS NULL OR d."stepKey" NOT LIKE 'integration-lot:%')
      ORDER BY d."createdAt" DESC
      LIMIT ${LIMITE_DOCUMENTS}`,
    prisma.$queryRaw<{ id: string; name: string; taille: number | null; blobId: string; sha256: string }[]>`
      SELECT n.id, n.name, n.size AS taille, v."blobId", b.sha256
      FROM "DriveNode" n
      JOIN LATERAL (SELECT fv."blobId" FROM "FileVersion" fv WHERE fv."nodeId" = n.id ORDER BY fv.version DESC LIMIT 1) v ON TRUE
      JOIN "FileBlob" b ON b.id = v."blobId"
      LEFT JOIN "DriveTextIndex" t ON t."nodeId" = n.id
      WHERE n.type::text = 'FILE' AND n."isTrashed" = false AND n."createdAt" >= ${DEPUIS}
        AND (n.name ~* ${MOTIF_PIECE} OR coalesce(n.category, '') ~* ${MOTIF_PIECE}
             OR coalesce(t."docKind", '') ~* '(invoice|facture|quote|devis|purchase|commande|contract|contrat|convention)')
      ORDER BY n."createdAt" DESC
      LIMIT ${LIMITE_DRIVE}`,
    // LA MESSAGERIE : seulement les conversations dont la personne est membre — on ne lit pas les échanges des autres.
    prisma.$queryRaw<{ id: string; name: string; taille: number | null; blobId: string; sha256: string }[]>`
      SELECT a.id, a.name, a.size AS taille, a."blobId", b.sha256
      FROM "MessageAttachment" a
      JOIN "Message" m ON m.id = a."messageId"
      JOIN "ConversationMember" cm ON cm."conversationId" = m."conversationId" AND cm."userId" = ${user.id}
      JOIN "FileBlob" b ON b.id = a."blobId"
      WHERE a."blobId" IS NOT NULL AND a."createdAt" >= ${DEPUIS} AND a.name ~* ${MOTIF_PIECE}
      ORDER BY a."createdAt" DESC
      LIMIT ${LIMITE_MESSAGES}`,
  ]);
  const adPro = new Set(["AD_PRO_ITEM", "AD_PRO_OTHER", "SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "TRAINING", "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION", "LEGAL_DOCUMENT"]);
  return [
    ...docs.map((d) => ({
      source: `DOC:${d.id}`, nom: d.name, ou: OU_DOSSIER[d.entityType] ?? d.entityType, href: `/api/documents/${encodeURIComponent(d.id)}`,
      entite: `${d.entityType}:${d.entityId}`, entityType: d.entityType, entityId: d.entityId, blobId: d.blobId, empreinte: d.sha256,
      taille: d.taille == null ? null : Number(d.taille), confidentielle: d.conf !== "INTERNAL", priorite: adPro.has(d.entityType) ? 0 : 1,
    })),
    ...drive.map((n) => ({
      source: `DRIVE:${n.id}`, nom: n.name, ou: "Drive", href: `/api/drive/${encodeURIComponent(n.id)}/raw`, entite: null, entityType: null, entityId: null,
      blobId: n.blobId, empreinte: n.sha256, taille: n.taille == null ? null : Number(n.taille), confidentielle: false, priorite: 2,
    })),
    ...messages.map((a) => ({
      source: `MSG:${a.id}`, nom: a.name, ou: "Messagerie", href: `/api/messaging/attachment/${encodeURIComponent(a.id)}`, entite: null, entityType: null, entityId: null,
      // Une pièce jointe d'une conversation ne sort pas vers un modèle : lecture locale seulement.
      blobId: a.blobId, empreinte: a.sha256, taille: a.taille == null ? null : Number(a.taille), confidentielle: true, priorite: 2,
    })),
  ];
}

/** Ce que le registre Legal sait déjà de ses pièces (titre, référence, contrepartie, montant, nature). */
async function metaLegal(ids: readonly string[]): Promise<Map<string, PieceARapprocher["meta"] & { annulee: boolean }>> {
  const out = new Map<string, PieceARapprocher["meta"] & { annulee: boolean }>();
  const u = uniques(ids);
  for (let i = 0; i < u.length; i += 5000) {
    const rows = await prisma.legalDocument.findMany({
      where: { id: { in: u.slice(i, i + 5000) } },
      select: { id: true, title: true, reference: true, counterparty: true, amount: true, kind: true, signedAt: true, status: true },
    });
    for (const r of rows) {
      out.set(r.id, {
        titre: r.title, reference: r.reference, fournisseur: r.counterparty, montant: r.amount == null ? null : toNumber(r.amount),
        kind: r.kind, date: r.signedAt?.toISOString() ?? null, annulee: r.status === "CANCELLED",
      });
    }
  }
  return out;
}

async function piecesARapprocher(candidats: readonly CandidatPiece[], lectures: Map<string, LectureGardee>): Promise<PieceARapprocher[]> {
  const meta = await metaLegal(candidats.filter((c) => c.entityType === "LEGAL_DOCUMENT").map((c) => c.entityId as string));
  const vus = new Set<string>();
  const out: PieceARapprocher[] = [];
  for (const c of candidats) {
    if (vus.has(c.source)) continue;
    vus.add(c.source);
    const m = c.entityType === "LEGAL_DOCUMENT" ? meta.get(c.entityId as string) : undefined;
    if (m?.annulee) continue;
    out.push({ source: c.source, nom: c.nom, ou: m?.titre ? `${c.ou} — ${m.reference ?? m.titre}` : c.ou, href: c.href, entite: c.entite, meta: m ?? {}, lu: lectures.get(c.empreinte)?.lu ?? null });
  }
  return out;
}

/** La personne peut-elle OUVRIR cette pièce ? (dossier, Drive, conversation) — une proposition ne montre que ce qu'on peut voir. */
async function peutVoirPiece(user: SessionUser, c: Pick<CandidatPiece, "source" | "entityType" | "entityId">, cache: Map<string, boolean>): Promise<boolean> {
  const k = c.entityType && c.entityId ? `${c.entityType}:${c.entityId}` : c.source;
  const deja = cache.get(k);
  if (deja !== undefined) return deja;
  let ok = false;
  if (c.source.startsWith("DOC:") && c.entityType && c.entityId) ok = await canAccessEntity(user, c.entityType as never, c.entityId, "VIEW").catch(() => false);
  else if (c.source.startsWith("DRIVE:")) ok = canViewDrive(await resolveDriveAccess(user, c.source.slice(6)).catch(() => "NONE" as const));
  // La messagerie : la liste ne porte déjà que les conversations dont la personne est membre.
  else if (c.source.startsWith("MSG:")) ok = true;
  cache.set(k, ok);
  return ok;
}

// ─────────────────────────────── La lecture par tranches ───────────────────────────────

export interface ProgressionLecture { total: number; lues: number; nonLues: number; restantes: number }

function progression(candidats: readonly CandidatPiece[], lectures: Map<string, LectureGardee>): ProgressionLecture {
  const empreintes = uniques(candidats.map((c) => c.empreinte));
  let lues = 0, nonLues = 0;
  for (const e of empreintes) {
    const l = lectures.get(e);
    if (l?.etat === "LUE") lues++; else if (l) nonLues++;
  }
  return { total: empreintes.length, lues, nonLues, restantes: empreintes.length - lues - nonLues };
}

/**
 * LIRE UNE TRANCHE DE PIÈCES — au plus `max` fichiers, au plus `budgetMs` : l'écran rappelle tant qu'il en reste. Une pièce
 * lue (ou qui ne se lit pas : format, taille, échec) a sa ligne par empreinte et ne se relit JAMAIS ; une coupure ne perd
 * que la pièce en cours. Un fichier à la fois en mémoire.
 */
export async function lireTranche(
  user: SessionUser,
  opts: { max?: number; budgetMs?: number; /** Restreindre la tranche (un banc : ses seules pièces). */ filtre?: (c: CandidatPiece) => boolean } = {},
): Promise<ProgressionLecture & { luesCetteFois: number; erreurs: string[] }> {
  const max = opts.max ?? 6;
  const budget = opts.budgetMs ?? 20_000;
  const debut = Date.now();
  const tous = await listerPieces(user);
  const candidats = opts.filtre ? tous.filter(opts.filtre) : tous;
  let lectures = await lecturesGardees(candidats.map((c) => c.empreinte));
  const parEmpreinte = new Map<string, CandidatPiece>();
  for (const c of [...candidats].sort((a, b) => a.priorite - b.priorite)) {
    if (!lectures.has(c.empreinte) && !parEmpreinte.has(c.empreinte)) parEmpreinte.set(c.empreinte, c);
  }
  const erreurs: string[] = [];
  let luesCetteFois = 0;
  for (const c of [...parEmpreinte.values()].slice(0, max)) {
    if (Date.now() - debut > budget) break;
    const garder = (data: Omit<Prisma.AdProRapprochementLectureCreateInput, "empreinte">) =>
      prisma.adProRapprochementLecture.upsert({ where: { empreinte: c.empreinte }, create: { empreinte: c.empreinte, luParId: user.id, ...data }, update: {} });
    const refus = refusAvantLecture(c.nom, c.taille);
    if (refus) { await garder({ etat: "NON_LUE", raison: refus }); luesCetteFois++; continue; }
    try {
      const octets = await getBlob(c.blobId);
      if (!octets) { await garder({ etat: "NON_LUE", raison: "fichier introuvable dans le stockage" }); luesCetteFois++; continue; }
      const r = await lirePieceParLuna(user.id, octets, c.nom, !c.confidentielle);
      if (!r.ok) await garder({ etat: "NON_LUE", raison: r.raison });
      else {
        await garder({
          etat: "LUE", lectureId: r.lectureId, fournisseur: r.lu.fournisseur?.slice(0, 300) ?? null, montant: r.lu.montant, date: r.lu.date,
          numero: r.lu.numero?.slice(0, 100) ?? null, nature: r.lu.nature, references: r.lu.references, motsCles: r.lu.motsCles,
        });
      }
      luesCetteFois++;
    } catch (e) {
      erreurs.push(`${c.nom} : ${e instanceof Error ? e.message.slice(0, 160) : "lecture impossible"}`);
      await garder({ etat: "NON_LUE", raison: "la lecture a échoué" }).catch(() => undefined);
    }
  }
  lectures = await lecturesGardees(candidats.map((c) => c.empreinte));
  return { ...progression(candidats, lectures), luesCetteFois, erreurs };
}

// ─────────────────────────────── L'écran ───────────────────────────────

export interface PieceVue { source: string; nom: string; ou: string; href: string | null; type: string; resume: string | null }
export interface PropositionPiece extends Proposition { piece: PieceVue }
export interface DemandePiecesVue {
  rowId: string;
  libelle: string;
  href: string | null;
  historique: boolean;
  manquantes: { cle: string; libelle: string }[];
  propositions: PropositionPiece[];
}
export interface DoublonVue extends DoublonProbable { renvois: { libelle: string; href: string }[] }
export interface DecisionVue {
  id: string;
  sens: SensRapprochement;
  source: string;
  sourceLibelle: string;
  montant: number | null;
  decision: DecisionRapprochement;
  demandeLibelle: string | null;
  posteLibelle: string | null;
  pieceLibelle: string | null;
  certitude: string | null;
  justification: string;
  enveloppeSuggeree: string | null;
  decideLe: string;
  decidePar: string | null;
  annuleLe: string | null;
}
export interface CibleChoix { rowId: string; libelle: string; historique: boolean; postes: { id: string; libelle: string; montant: number }[]; attendues: { cle: string; libelle: string }[] }

export interface VueRapprochement {
  lotId: string;
  envelopeId: string;
  enveloppe: string;
  lecture: ProgressionLecture;
  depenses: DepenseVue[];
  pieces: DemandePiecesVue[];
  doublons: DoublonVue[];
  decisions: DecisionVue[];
  cibles: CibleChoix[];
  certaines: number;
  regleCertaine: string;
}

interface Etat {
  lot: Lot;
  cibles: DemandeCible[];
  decisionsActives: { id: string; sens: string; source: string; decision: DecisionRapprochement; demandeRowId: string | null; posteId: string | null }[];
  depenses?: DepenseVue[];
  jugees?: { cle: string; absente: boolean }[];
  pieces?: { props: PropositionPiece[]; candidats: CandidatPiece[]; lectures: Map<string, LectureGardee> };
}

async function etatDuLot(user: SessionUser, lot: Lot, quoi: { depenses?: boolean; pieces?: boolean }): Promise<Etat> {
  const ctx = await contexteDeLEnveloppe(lot.envelopeId);
  const [cibles, decisions] = await Promise.all([
    chargerCibles(lot.demandes),
    prisma.adProRapprochement.findMany({ where: { lotId: lot.id, annuleLe: null }, select: { id: true, sens: true, source: true, decision: true, demandeRowId: true, posteId: true } }),
  ]);
  const decisionsActives = decisions.map((d) => ({ ...d, decision: d.decision as DecisionRapprochement }));
  const etat: Etat = { lot, cibles, decisionsActives };
  const decDe = (sens: SensRapprochement) => decisionsActives.filter((d) => d.sens === sens);

  if (quoi.depenses && ctx) {
    const { depenses, jugees } = await chargerDepenses(lot.envelope, ctx);
    // Une dépense déjà rattachée ou dite « pas Ad & Pro » ne se repropose pas (elle est dans les décisions).
    const tranchees = new Set(decDe("DEPENSE").filter((d) => d.decision !== "REFUSEE").map((d) => d.source));
    const ouvertes = depenses.filter((d) => !tranchees.has(d.source));
    const props = rapprocherDepenses(ouvertes, cibles);
    etat.jugees = jugees;
    etat.depenses = ouvertes.map((d) => ({
      source: d.source, nature: d.nature, aImputer: d.aImputer, reference: d.reference, libelle: d.libelle, montant: d.montant, date: d.date,
      fournisseur: d.fournisseur, href: d.href,
      propositions: sansLesDecidees(props.get(d.source) ?? [], decDe("DEPENSE"), "DEPENSE"),
      horsAdPro: indiceHorsAdPro(d),
      piecesLues: d.lu.map((l) => `${l.nom} : ${[l.fournisseur, l.montant != null ? `${dzd(l.montant)} DZD` : null, l.date].filter(Boolean).join(", ") || "rien de lisible"}`),
    }));
  }

  if (quoi.pieces) {
    const candidats = await listerPieces(user);
    const lectures = await lecturesGardees(candidats.map((c) => c.empreinte));
    const pieces = await piecesARapprocher(candidats, lectures);
    const parSource = new Map(pieces.map((p) => [p.source, p]));
    const props = sansLesDecidees(rapprocherPieces(pieces, cibles), decDe("PIECE"), "PIECE");
    etat.pieces = {
      candidats, lectures,
      props: props.map((p) => {
        const piece = parSource.get(p.source) as PieceARapprocher;
        const lu = piece.lu;
        return {
          ...p,
          piece: {
            source: piece.source, nom: piece.nom, ou: piece.ou, href: piece.href,
            type: LIBELLE_TYPE_PIECE[typeDePiece({ nom: piece.nom, titre: piece.meta.titre, kind: piece.meta.kind, natureLue: lu?.nature })],
            resume: lu ? [lu.fournisseur, lu.montant != null ? `${dzd(lu.montant)} DZD` : null, lu.date, lu.numero ? `n° ${lu.numero}` : null].filter(Boolean).join(" · ") || null : null,
          },
        };
      }),
    };
  }
  return etat;
}

/** L'ÉCRAN DU RAPPROCHEMENT d'une enveloppe que la personne gère — `null` sans lot actif ou sans droit. */
export async function vueRapprochement(user: SessionUser, envelopeId: string): Promise<VueRapprochement | null> {
  const lot = await lotActifGere(user, envelopeId);
  if (!lot) return null;
  const etat = await etatDuLot(user, lot, { depenses: true, pieces: true });
  const cibles = etat.cibles;
  const libelleDe = new Map(cibles.map((c) => [c.rowId, c]));

  // Les PIÈCES, par demande — seulement celles que la personne peut ouvrir ; 8 par demande, les plus sûres d'abord.
  const candidatsParSource = new Map((etat.pieces?.candidats ?? []).map((c) => [c.source, c]));
  const acces = new Map<string, boolean>();
  const parDemande = new Map<string, PropositionPiece[]>();
  for (const p of [...(etat.pieces?.props ?? [])].sort(trierPropositions)) {
    const liste = parDemande.get(p.demandeRowId) ?? [];
    if (liste.length >= 8) continue;
    const c = candidatsParSource.get(p.source);
    if (!c || !(await peutVoirPiece(user, c, acces))) continue;
    liste.push(p);
    parDemande.set(p.demandeRowId, liste);
  }
  const pieces: DemandePiecesVue[] = cibles
    .map((c) => ({
      rowId: c.rowId, libelle: c.libelle, href: lienDemande(c.type, c.cle.split(":")[1] ?? ""), historique: c.historique,
      manquantes: c.attendues.filter((a) => c.manquantes.includes(a.cle)),
      propositions: parDemande.get(c.rowId) ?? [],
    }))
    // Les Historique 2026 qui ont des pièces manquantes d'abord.
    .sort((a, b) => Number(b.historique && b.manquantes.length > 0) - Number(a.historique && a.manquantes.length > 0) || b.propositions.length - a.propositions.length);

  const depenses = (etat.depenses ?? []).sort((a, b) => {
    const ra = a.propositions[0] ? ({ CERTAINE: 0, PROBABLE: 1, POSSIBLE: 2 } as const)[a.propositions[0].certitude] : 3;
    const rb = b.propositions[0] ? ({ CERTAINE: 0, PROBABLE: 1, POSSIBLE: 2 } as const)[b.propositions[0].certitude] : 3;
    return ra - rb || (b.propositions[0]?.score ?? 0) - (a.propositions[0]?.score ?? 0) || b.montant - a.montant;
  });

  const [doublons, decisions] = await Promise.all([
    doublonsDuLot(lot, cibles, etat),
    prisma.adProRapprochement.findMany({ where: { lotId: lot.id }, orderBy: { decideLe: "desc" }, take: 300 }),
  ]);
  const auteurs = await prisma.user.findMany({ where: { id: { in: uniques(decisions.map((d) => d.decideParId)) } }, select: { id: true, name: true } });
  const nomAuteur = new Map(auteurs.map((a) => [a.id, a.name]));
  const posteLib = new Map(cibles.flatMap((c) => c.postes.map((p) => [p.id, p.libelle] as const)));

  return {
    lotId: lot.id, envelopeId: lot.envelopeId, enveloppe: lot.envelope.name,
    lecture: progression(etat.pieces?.candidats ?? [], etat.pieces?.lectures ?? new Map()),
    depenses,
    pieces,
    doublons,
    decisions: decisions.map((d) => ({
      id: d.id, sens: d.sens as SensRapprochement, source: d.source, sourceLibelle: d.sourceLibelle, montant: d.montant == null ? null : toNumber(d.montant),
      decision: d.decision as DecisionRapprochement, demandeLibelle: d.demandeRowId ? libelleDe.get(d.demandeRowId)?.libelle ?? null : null,
      posteLibelle: d.posteId ? posteLib.get(d.posteId) ?? null : null,
      pieceLibelle: d.pieceCle && d.demandeRowId ? libelleDe.get(d.demandeRowId)?.attendues.find((a) => a.cle === d.pieceCle)?.libelle ?? d.pieceCle : null,
      certitude: d.certitude, justification: d.justification, enveloppeSuggeree: d.enveloppeSuggeree,
      decideLe: d.decideLe.toISOString(), decidePar: d.decideParId ? nomAuteur.get(d.decideParId) ?? null : null, annuleLe: d.annuleLe?.toISOString() ?? null,
    })),
    cibles: cibles.map((c) => ({ rowId: c.rowId, libelle: c.libelle, historique: c.historique, postes: c.postes.map((p) => ({ id: p.id, libelle: p.libelle, montant: p.montant })), attendues: c.attendues })),
    certaines: depenses.filter((d) => d.propositions[0]?.certitude === "CERTAINE").length + pieces.reduce((s, d) => s + d.propositions.filter((p) => p.certitude === "CERTAINE").length, 0),
    regleCertaine: REGLE_CERTAINE,
  };
}

// ─────────────────────────────── Les doublons probables ───────────────────────────────

async function doublonsDuLot(lot: Lot, cibles: readonly DemandeCible[], etat: Etat): Promise<DoublonVue[]> {
  const catIds = (await prisma.budgetCategoryLine.findMany({ where: { envelopeId: lot.envelopeId }, select: { id: true } })).map((c) => c.id);
  // Les postes NON historiques rangés dans l'enveloppe (le tableau des dépenses), avec leur demande.
  const postes = catIds.length
    ? await prisma.adProItem.findMany({
        where: { budgetCategoryId: { in: catIds }, status: "APPROVED", historiqueLotId: null, depenseAnnuleeLe: null },
        select: { id: true, label: true, amountGranted: true, supplier: true, createdAt: true, ...SELECT_PARENTS_POSTE },
        take: 1000,
      })
    : [];
  const clesPostes = uniques(postes.map((p) => cleDemandeDuPoste(p)));
  const libelles = await libellesDesDemandes(clesPostes);
  const ctx = await contexteDeLEnveloppe(lot.envelopeId);
  const libelleCible = new Map(cibles.map((c) => [c.cle, c]));
  const fournisseurPoste = new Map(cibles.flatMap((c) => c.postes.map((p) => [p.id, p.fournisseur] as const)));
  const elements: ElementDoublon[] = [
    ...(etat.depenses ?? []).map((d) => ({
      cle: d.source, nature: (d.aImputer ? "A_IMPUTER" : d.nature) as ElementDoublon["nature"], reference: d.reference, libelle: d.libelle,
      montant: d.montant, date: d.date, fournisseur: d.fournisseur, groupe: null, href: d.href,
    })),
    ...(ctx?.postes ?? []).map((h) => ({
      cle: `POSTE:${h.id}`, nature: "POSTE_HISTORIQUE" as const, reference: h.ligne ? `Fichier L${h.ligne}` : "Historique 2026",
      libelle: `${h.libelle} — ${h.demande ? libelleCible.get(h.demande)?.libelle ?? "" : ""}`, montant: h.montant, date: h.payeLe.toISOString(),
      fournisseur: fournisseurPoste.get(h.id) ?? null, groupe: h.demande, href: h.demande ? lienDemande(h.demande.split(":")[0], h.demande.split(":")[1]) : null,
    })),
    ...postes.map((p) => {
      const g = cleDemandeDuPoste(p);
      const d = g ? libelles[g] : undefined;
      return {
        cle: `POSTE:${p.id}`, nature: "POSTE" as const, reference: d?.libelle.split(" — ")[0] ?? "Poste", libelle: `${p.label} — ${d?.libelle ?? ""}`,
        montant: toNumber(p.amountGranted ?? 0), date: p.createdAt.toISOString(), fournisseur: p.supplier, groupe: g, href: d?.href ?? null,
      };
    }),
  ];
  // Les paires déjà reconnues comme UNE dépense (une dépense rattachée à un poste, ou à une demande et ses postes).
  const liens = new Set<string>();
  const rattachees = await prisma.adProRapprochement.findMany({ where: { lotId: lot.id, sens: "DEPENSE", decision: "ACCEPTEE", annuleLe: null }, select: { source: true, demandeRowId: true, posteId: true } });
  for (const r of rattachees) {
    const c = cibles.find((x) => x.rowId === r.demandeRowId);
    for (const pid of r.posteId ? [r.posteId] : c?.postes.map((p) => p.id) ?? []) liens.add([r.source, `POSTE:${pid}`].sort().join("|"));
  }
  const absentes = new Set((etat.jugees ?? []).filter((j) => j.absente).map((j) => j.cle));
  return doublonsProbables(elements, liens).slice(0, 60).map((d) => ({
    ...d,
    renvois: [
      ...(d.elements.some((e) => absentes.has(e.cle)) || d.elements.some((e) => e.nature === "POSTE")
        ? [{ libelle: "Garder ou sortir de l'intégration", href: "/budget-marketing/integration#absentes" }] : []),
      ...(d.elements.some((e) => e.nature === "ECRITURE" || e.nature === "A_IMPUTER" || e.nature === "ORDRE")
        ? [{ libelle: "Recensement des doublons de factures", href: "/finances/doublons-factures" }] : []),
    ],
  }));
}

// ─────────────────────────────── Les décisions ───────────────────────────────

export interface EntreeDecision {
  sens: SensRapprochement;
  source: string;
  decision: DecisionRapprochement;
  demandeRowId?: string | null;
  posteId?: string | null;
  pieceCle?: string | null;
  enveloppe?: string | null;
}

type Resultat = { ok: true; message: string } | { ok: false; erreur: string };

const PHRASE_DEJA = "Cette source vient d'être décidée (par vous ou quelqu'un d'autre) : rechargez la page.";

/**
 * APPLIQUER UNE DÉCISION, dans l'état lu (`etat`) : la source doit être l'une de celles que l'écran propose (une dépense de
 * l'enveloppe ou de la société, une pièce que la personne peut ouvrir), la cible une demande du lot (et le poste, l'un de
 * ses postes). La proposition du moteur, si elle existe, donne score, certitude et justification ; sinon c'est un CHOIX
 * MANUEL, dit tel quel.
 */
async function appliquer(user: SessionUser, etat: Etat, e: EntreeDecision): Promise<Resultat> {
  const lot = etat.lot;
  const cible = e.demandeRowId ? etat.cibles.find((c) => c.rowId === e.demandeRowId) : undefined;
  if ((e.decision === "ACCEPTEE" || e.decision === "REFUSEE") && !cible) return { ok: false, erreur: "Choisissez une demande du lot." };
  const poste = e.posteId && cible ? cible.postes.find((p) => p.id === e.posteId) : undefined;
  if (e.posteId && !poste) return { ok: false, erreur: "Ce poste n'appartient pas à la demande choisie." };

  if (e.sens === "DEPENSE") {
    if (!estSourceDepense(e.source)) return { ok: false, erreur: "Dépense inconnue." };
    const dep = etat.depenses?.find((d) => d.source === e.source);
    if (!dep) return { ok: false, erreur: "Cette dépense n'est plus à rapprocher (déjà décidée, ou hors de l'enveloppe)." };
    if (e.decision === "PAS_ADPRO" && e.demandeRowId) return { ok: false, erreur: "« Pas Ad & Pro » ne vise aucune demande." };
    const prop = cible ? dep.propositions.find((p) => p.demandeRowId === cible.rowId && (p.posteId ?? null) === (e.posteId ?? p.posteId ?? null)) : undefined;
    const posteId = e.posteId ?? prop?.posteId ?? (cible?.postes.length === 1 ? cible.postes[0].id : null);
    const enveloppe = e.decision === "PAS_ADPRO" ? (e.enveloppe?.trim().slice(0, 120) || dep.horsAdPro?.enveloppe || "Autre enveloppe") : null;
    const justification = e.decision === "PAS_ADPRO"
      ? `Pas Ad & Pro${dep.horsAdPro ? ` (${dep.horsAdPro.raison})` : ""} — enveloppe plausible : ${enveloppe}. Rien n'est imputé.`
      : prop?.justification ?? `Choix manuel — ${cible?.libelle ?? ""}`;
    try {
      await prisma.adProRapprochement.create({
        data: {
          lotId: lot.id, sens: "DEPENSE", source: e.source, sourceLibelle: `${dep.reference} — ${dep.libelle}`.slice(0, 300), montant: dep.montant,
          decision: e.decision, demandeRowId: cible?.rowId ?? null, demandeType: cible?.type ?? null, demandeId: cible ? cible.cle.split(":")[1] : null,
          posteId: e.decision === "PAS_ADPRO" ? null : posteId, certitude: prop?.certitude ?? null, score: prop?.score ?? 0,
          justification: justification.slice(0, 1000), enveloppeSuggeree: enveloppe, decideParId: user.id,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, erreur: PHRASE_DEJA };
      throw err;
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: lot.envelopeId, field: "rapprochement",
      newValue: e.source,
      summary: e.decision === "ACCEPTEE"
        ? `${dep.reference} (${dzd(dep.montant)} DZD) rattachée à ${cible?.libelle}${poste ? ` › ${poste.libelle}` : ""} — preuve de paiement, ne compte plus deux fois. ${justification}`
        : e.decision === "REFUSEE" ? `Proposition refusée : ${dep.reference} ≠ ${cible?.libelle}.` : `${dep.reference} signalée « pas Ad & Pro » (${enveloppe}) — rien n'est imputé.`,
    });
    return {
      ok: true,
      message: e.decision === "ACCEPTEE" ? `${dep.reference} rattachée à ${cible?.libelle} : elle ne compte plus deux fois. Le livre de trésorerie n'est pas modifié.`
        : e.decision === "REFUSEE" ? "Proposition refusée." : `Signalée « pas Ad & Pro » — enveloppe plausible : ${enveloppe}. Rien n'est imputé.`,
    };
  }

  // ── Une PIÈCE ──
  if (!estSourcePiece(e.source)) return { ok: false, erreur: "Pièce inconnue." };
  if (e.decision === "PAS_ADPRO") return { ok: false, erreur: "« Pas Ad & Pro » vise une dépense, pas une pièce." };
  const candidat = etat.pieces?.candidats.find((c) => c.source === e.source);
  if (!candidat || !(await peutVoirPiece(user, candidat, new Map()))) return { ok: false, erreur: "Pièce introuvable, ou vous ne pouvez pas l'ouvrir." };
  const c = cible as DemandeCible;
  const prop = etat.pieces?.props.find((p) => p.source === e.source && p.demandeRowId === c.rowId);
  const pieceCle = e.pieceCle ?? prop?.pieceCle ?? c.manquantes[0] ?? c.attendues[0]?.cle ?? null;
  const attendue = c.attendues.find((a) => a.cle === pieceCle);
  if (e.decision === "ACCEPTEE" && !attendue) return { ok: false, erreur: "Choisissez la pièce attendue que ce fichier couvre." };
  const justification = prop?.justification ?? `Choix manuel — ${c.libelle}`;
  const libelleSource = `${candidat.nom} (${candidat.ou})`.slice(0, 300);
  if (e.decision === "REFUSEE") {
    await prisma.adProRapprochement.create({
      data: { lotId: lot.id, sens: "PIECE", source: e.source, sourceLibelle: libelleSource, decision: "REFUSEE", demandeRowId: c.rowId, demandeType: c.type, demandeId: c.cle.split(":")[1], certitude: prop?.certitude ?? null, score: prop?.score ?? 0, justification: justification.slice(0, 1000), decideParId: user.id },
    });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: c.type as never, entityId: c.cle.split(":")[1], field: "rapprochement", summary: `Pièce « ${candidat.nom} » refusée pour ${c.libelle}.` });
    return { ok: true, message: "Proposition refusée." };
  }
  const entree: PieceRattachee = {
    cle: attendue!.cle, documentId: e.source.startsWith("DOC:") ? e.source.slice(4) : null, nom: candidat.nom.slice(0, 200), le: new Date().toISOString(), parId: user.id,
    source: `Rapprochement — ${candidat.ou}`, href: e.source.startsWith("DOC:") ? null : candidat.href, ref: e.source,
  };
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.adProIntegrationDemande.findUnique({ where: { id: c.rowId }, select: { piecesRattachees: true, updatedAt: true } });
      if (!row) throw new Error("Demande introuvable.");
      const actuelles = piecesRattacheesDe(row.piecesRattachees);
      await tx.adProRapprochement.create({
        data: {
          lotId: lot.id, sens: "PIECE", source: e.source, sourceLibelle: libelleSource, decision: "ACCEPTEE", demandeRowId: c.rowId, demandeType: c.type,
          demandeId: c.cle.split(":")[1], posteId: prop?.posteId ?? null, pieceCle: attendue!.cle, certitude: prop?.certitude ?? null, score: prop?.score ?? 0,
          justification: justification.slice(0, 1000), lien: entree as unknown as Prisma.InputJsonValue, decideParId: user.id,
        },
      });
      if (!actuelles.some((r) => (r.ref ?? (r.documentId ? `DOC:${r.documentId}` : null)) === e.source && r.cle === attendue!.cle)) {
        const n = await tx.adProIntegrationDemande.updateMany({ where: { id: c.rowId, updatedAt: row.updatedAt }, data: { piecesRattachees: [...actuelles, entree] as unknown as Prisma.InputJsonValue } });
        if (n.count !== 1) throw new Error("CONCURRENCE");
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, erreur: PHRASE_DEJA };
    if (err instanceof Error && err.message === "CONCURRENCE") return { ok: false, erreur: "La demande vient d'être modifiée : rechargez, puis rattachez de nouveau." };
    throw err;
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: c.type as never, entityId: c.cle.split(":")[1], field: "rapprochement",
    newValue: e.source, summary: `Pièce « ${candidat.nom} » (${candidat.ou}) rattachée à « ${attendue!.libelle} » — un lien, jamais une copie. ${justification}`,
  });
  return { ok: true, message: `« ${candidat.nom} » rattachée à « ${attendue!.libelle} » de ${c.libelle}.` };
}

/** UNE décision, sur l'état relu au serveur (jamais sur ce que l'écran affirme). */
export async function decider(user: SessionUser, envelopeId: string | null, e: EntreeDecision): Promise<Resultat> {
  const lot = await lotActifGere(user, envelopeId);
  if (!lot) return { ok: false, erreur: "Lot introuvable, ou vous ne gérez pas cette enveloppe." };
  const etat = await etatDuLot(user, lot, e.sens === "DEPENSE" ? { depenses: true } : { pieces: true });
  return appliquer(user, etat, e);
}

/**
 * ACCEPTER TOUTES LES PROPOSITIONS CERTAINES — et elles seules (règle `REGLE_CERTAINE`). Chacune est une décision à part
 * entière (auditée, annulable une à une).
 */
export async function accepterCertaines(user: SessionUser, envelopeId: string | null): Promise<Resultat & { acceptees?: number }> {
  const lot = await lotActifGere(user, envelopeId);
  if (!lot) return { ok: false, erreur: "Lot introuvable, ou vous ne gérez pas cette enveloppe." };
  const etat = await etatDuLot(user, lot, { depenses: true, pieces: true });
  const aFaire: EntreeDecision[] = [
    ...(etat.depenses ?? []).filter((d) => d.propositions[0]?.certitude === "CERTAINE").map((d) => ({
      sens: "DEPENSE" as const, source: d.source, decision: "ACCEPTEE" as const, demandeRowId: d.propositions[0].demandeRowId, posteId: d.propositions[0].posteId,
    })),
    ...(etat.pieces?.props ?? []).filter((p) => p.certitude === "CERTAINE" && p.pieceCle).map((p) => ({
      sens: "PIECE" as const, source: p.source, decision: "ACCEPTEE" as const, demandeRowId: p.demandeRowId, posteId: p.posteId, pieceCle: p.pieceCle,
    })),
  ];
  let acceptees = 0;
  const refus: string[] = [];
  for (const e of aFaire) {
    const r = await appliquer(user, etat, e);
    if (r.ok) acceptees++; else refus.push(r.erreur);
  }
  return { ok: true, acceptees, message: acceptees ? `${acceptees} proposition(s) certaine(s) acceptée(s).${refus.length ? ` ${refus.length} n'ont pas pu l'être : ${refus[0]}` : ""}` : "Aucune proposition certaine à accepter." };
}

/** ANNULER une décision : elle reste au journal, marquée annulée ; son effet est défait (la pièce quitte les rattachées). */
export async function annulerDecision(user: SessionUser, id: string | null): Promise<Resultat> {
  if (!id) return { ok: false, erreur: "Décision non précisée." };
  const d = await prisma.adProRapprochement.findUnique({ where: { id }, include: { lot: { include: { envelope: true } } } });
  if (!d || !canManageEnvelope(user, d.lot.envelope)) return { ok: false, erreur: "Décision introuvable, ou vous ne gérez pas cette enveloppe." };
  if (d.annuleLe) return { ok: true, message: "Déjà annulée." };
  if (d.lot.annuleLe) return { ok: false, erreur: "Le lot d'intégration est annulé : il n'y a plus rien à défaire." };
  await prisma.$transaction(async (tx) => {
    const n = await tx.adProRapprochement.updateMany({ where: { id, annuleLe: null }, data: { annuleLe: new Date(), annuleParId: user.id } });
    if (n.count !== 1) return;
    if (d.sens === "PIECE" && d.decision === "ACCEPTEE" && d.demandeRowId) {
      const row = await tx.adProIntegrationDemande.findUnique({ where: { id: d.demandeRowId }, select: { piecesRattachees: true } });
      if (row) {
        const gardees = piecesRattacheesDe(row.piecesRattachees).filter((r) => !((r.ref ?? (r.documentId ? `DOC:${r.documentId}` : null)) === d.source && r.cle === d.pieceCle));
        await tx.adProIntegrationDemande.update({ where: { id: d.demandeRowId }, data: { piecesRattachees: gardees as unknown as Prisma.InputJsonValue } });
      }
    }
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: d.lot.envelopeId, field: "rapprochement",
    oldValue: `${d.decision}:${d.source}`, newValue: null, summary: `Décision du rapprochement annulée : ${d.sourceLibelle} (${d.decision === "ACCEPTEE" ? "rattachement" : d.decision === "REFUSEE" ? "refus" : "pas Ad & Pro"}).`,
  });
  return { ok: true, message: "Décision annulée : la proposition revient à l'écran." };
}

// ─────────────────────────────── Ce que l'onglet Dépenses en dit ───────────────────────────────

/**
 * Pour l'onglet Dépenses du Budget Marketing : les écritures « à imputer » RATTACHÉES par le Rapprochement (preuve de
 * paiement d'un poste déjà au budget — retirées de la liste, et de son total) et celles signalées « pas Ad & Pro » (une
 * étiquette avec l'enveloppe plausible). Rien n'est imputé.
 */
export async function rapprochementDesAImputer(envelopeId: string, from: Date, to: Date, societeId: string | null | undefined): Promise<{ rattachees: Set<string>; total: number; nombre: number; pasAdPro: Record<string, string> }> {
  const lot = await prisma.adProIntegrationLot.findFirst({ where: { envelopeId, annuleLe: null }, select: { id: true } });
  const vide = { rattachees: new Set<string>(), total: 0, nombre: 0, pasAdPro: {} as Record<string, string> };
  if (!lot) return vide;
  const decisions = await prisma.adProRapprochement.findMany({
    where: { lotId: lot.id, sens: "DEPENSE", annuleLe: null, decision: { in: ["ACCEPTEE", "PAS_ADPRO"] }, source: { startsWith: "TX:" } },
    select: { source: true, decision: true, enveloppeSuggeree: true },
  });
  if (decisions.length === 0) return vide;
  const ids = decisions.filter((d) => d.decision === "ACCEPTEE").map((d) => d.source.slice(3));
  const agg = ids.length
    ? await prisma.financeTransaction.aggregate({ where: { AND: [await clauseAImputer(from, to, { societeId }), { id: { in: ids } }] }, _sum: { amount: true }, _count: { _all: true } })
    : null;
  return {
    rattachees: new Set(ids),
    total: agg ? toNumber(agg._sum.amount) : 0,
    nombre: agg?._count._all ?? 0,
    pasAdPro: Object.fromEntries(decisions.filter((d) => d.decision === "PAS_ADPRO").map((d) => [d.source.slice(3), `Pas Ad & Pro${d.enveloppeSuggeree ? ` → ${d.enveloppeSuggeree}` : ""}`])),
  };
}

/** Les écritures rattachées à une demande intégrée — affichées en lecture seule sur sa fiche « Historique 2026 ». */
export async function ecrituresRapprochees(demandeRowId: string): Promise<{ reference: string; montant: number; date: string; libelle: string }[]> {
  const ds = await prisma.adProRapprochement.findMany({
    where: { demandeRowId, sens: "DEPENSE", decision: "ACCEPTEE", annuleLe: null, source: { startsWith: "TX:" } },
    select: { source: true },
  });
  if (ds.length === 0) return [];
  const tx = await prisma.financeTransaction.findMany({ where: { id: { in: ds.map((d) => d.source.slice(3)) } }, select: { reference: true, amount: true, date: true, label: true } });
  return tx.map((t) => ({ reference: t.reference, montant: toNumber(t.amount), date: t.date.toISOString(), libelle: t.label }));
}
