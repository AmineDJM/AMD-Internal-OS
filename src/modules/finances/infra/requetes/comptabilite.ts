import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { getMyCompanies, companyLabel, companyIdForNew } from "@/lib/company";
import { hasGlobalView } from "@/lib/rbac";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { entityHref } from "@/lib/entity-href";
import { fichiersEmis, lienFichierEmis } from "@/lib/lecteurs/fichiers-emis";
import { ENTITY_TYPE_LABELS, FINANCE_CATEGORY, FINANCE_METHOD, ROLE_LABELS } from "@/lib/labels";
import { toNumber } from "@/lib/utils";
import { usagesDesDocumentsLegal } from "@/lib/actions/internes/paiement/pieces-legal";
import { recenserDoublonsFactures } from "@/lib/factures/recensement";
import { dossierHrefByOrder } from "../expense-orders";
import { getResultatMensuel } from "./compta";
import { auditLedger, auditSummary } from "../../domaine/ledger-audit";
import { lirePeriode, moisAlger, debutDuMoisAlger, type ResultatPeriode } from "../../domaine/resultat-mensuel";
import {
  choixDePeriode, etatDeLaFacture, libelleJustificatif, libelleTiers, LIBELLE_ETAT_FACTURE, lirePeriodeListe, lireVueCompta,
  montantRecherche, origineDeLEcriture, peutDemanderLePaiement, peutRattacherAUnPaiement, SENS_DE_LA_VUE,
  texteRecherche, type EtatFacture, type PeriodeListe, type VueCompta,
} from "../../domaine/comptabilite-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN « COMPTABILITÉ » LIT (maquette validée, 24/11/2026) — une société, une période, un onglet.
 *
 * LA SOCIÉTÉ : l'une de celles auxquelles la personne a droit (`getMyCompanies`, la liste du sélecteur), jamais une
 * liste codée ; une société demandée hors de ses droits retombe sur la sienne. Toutes les lectures se font AU NOM de
 * cette société (`companyId` strict) — le cloisonnement est dans la requête, pas dans l'écran. Les écritures sans
 * société restent atteignables par qui voit tout le groupe (« Sans société »), pour être rattachées.
 *
 * Rien n'est écrit ici. Les justificatifs se lisent EN LOT pour toutes les lignes (§118.102b) : les fichiers posés sur
 * l'écriture, sur l'ordre qu'elle règle, ceux de la facture du registre qui la porte (réglée directement ou envoyée au
 * règlement), et les pièces du dossier de paiement. (Le lot « justificatif obligatoire » pose sa propre lecture des
 * justificatifs d'un ORDRE, `lireJustificatifs` : à la fusion, la colonne des ordres la lira — une seule vérité.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SANS_SOCIETE = "sans";

export interface PieceCompta { id: string; nom: string; href: string; mime: string | null }

export interface LigneCompta {
  id: string;
  reference: string;
  date: string;
  direction: "IN" | "OUT";
  statut: string;
  tiers: string;
  objet: string;
  montant: number;
  compte: { court: string; long: string };
  justificatif: { present: boolean; libelle: string };
  origine: string;
  /** Une écriture inverse la compense : elle reste visible, barrée. */
  contrePassee: boolean;
  /** Prévue (pas encore réalisée) : elle ne bouge pas la trésorerie. */
  prevue: boolean;
}

export interface EtapeChaine { etape: string; qui: string; date: string | null; attention: boolean }

export interface DetailEcriture extends LigneCompta {
  tiersLabel: "Payé à" | "Reçu de";
  categorie: string;
  categorieCode: string;
  moyen: string;
  methodCode: string;
  compteId: string | null;
  invoiceRef: string;
  notes: string;
  pieces: PieceCompta[];
  chaine: EtapeChaine[];
  budget: string;
  origineHref: string | null;
  /** « Contre-passée le … » / « Écriture inverse de FIN-… » — la trace de la compensation. */
  compensationTexte: string | null;
  /** La pièce a été demandée : à qui, quand, combien de fois. */
  demandePiece: { a: string; le: string; fois: number } | null;
  /** À qui « Demander la pièce » peut s'adresser : le demandeur de l'ordre, celui qui a saisi l'écriture. */
  destinataires: { id: string; nom: string }[];
  /** Les factures du registre que « Joindre » propose : même partie, sans paiement. */
  facturesProposees: { id: string; titre: string; montant: number | null; maison: string; suggeree: boolean }[];
  /** L'écriture est le règlement d'un ordre : son montant, son sens et son statut ne se réécrivent pas. */
  reglementDe: string | null;
}

export interface FactureCompta {
  id: string;
  titre: string;
  reference: string | null;
  type: "Facture" | "Facture de vente";
  tiers: string;
  montant: number | null;
  date: string | null;
  echeance: string | null;
  maison: string;
  etat: EtatFacture;
  etatLibelle: string;
  ecriture: { id: string; reference: string } | null;
  ordreRef: string | null;
  demandes: string[];
  doublon: string | null;
  pieces: PieceCompta[];
  peutDemander: boolean;
  peutRattacher: boolean;
}

export interface CandidatRattachement { id: string; reference: string; tiers: string; montant: number; date: string; suggere: boolean }

export interface ControleCompta {
  kind: "MISSING_ENTRY" | "DOUBLE_ORDER" | "DUPLICATE_ENTRY";
  titre: string;
  detail: string;
  /** Les écritures à ouvrir (référence → identifiant), quand elles existent. */
  ouvrir: { id: string; reference: string }[];
}

export interface DonneesComptabilite {
  societes: { id: string; label: string }[];
  societeId: string;
  vue: VueCompta;
  periode: PeriodeListe;
  periodes: PeriodeListe[];
  totaux: { dep: number; rec: number };
  comptes: { id: string; nom: string }[];
  compteId: string | null;
  sansJustif: boolean;
  lignes: LigneCompta[];
  q: string;
  recherche: { depenses: LigneCompta[]; recettes: LigneCompta[]; factures: FactureCompta[] } | null;
  ecriture: DetailEcriture | null;
  facture: (FactureCompta & { candidats: CandidatRattachement[] }) | null;
  resultat: { annee: string; donnees: ResultatPeriode };
  controles: { resume: string; propre: boolean; points: ControleCompta[]; passage: string };
  budgets: { id: string; libelle: string }[];
}

export interface ParamsComptabilite {
  societe?: string; vue?: string; periode?: string; q?: string; ecriture?: string; facture?: string; compte?: string; sans?: string;
}

const jourIso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const nomCourtCompte = (nom: string) => nom.split(/\s+[—–-]\s+|\s+/)[0] || nom;
const montantSigne = (amount: Prisma.Decimal | number) => toNumber(amount);

/** La société de l'écran : demandée, si elle est parmi les siennes ; sinon celle où la personne travaille ; sinon la première. */
async function societeDeLEcran(user: CurrentUser, demandee: string | undefined) {
  const mes = await getMyCompanies(user.id);
  const societes = mes.map((c) => ({ id: c.id, label: companyLabel(c) }));
  // Les écritures SANS société : seul qui voit tout le groupe les lit (la règle de `platformScope`), et seulement s'il y en a.
  if (hasGlobalView(user) && (await prisma.financeTransaction.count({ where: { companyId: null } })) > 0) {
    societes.push({ id: SANS_SOCIETE, label: "Sans société" });
  }
  if (demandee && societes.some((s) => s.id === demandee)) return { societes, societeId: demandee };
  const travail = await companyIdForNew(user.id);
  const societeId = travail && societes.some((s) => s.id === travail) ? travail : societes[0]?.id ?? SANS_SOCIETE;
  return { societes, societeId };
}

const filtreSociete = (societeId: string): { companyId: string | null } => ({ companyId: societeId === SANS_SOCIETE ? null : societeId });

/** Le premier instant d'un mois (`AAAA-MM`) à Alger, et le premier instant APRÈS le dernier mois. */
function bornes(p: PeriodeListe): { gte: Date; lt: Date } {
  const [a, m] = p.fin.split("-").map(Number) as [number, number];
  const suivant = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  return { gte: debutDuMoisAlger(p.debut), lt: debutDuMoisAlger(suivant) };
}

const SELECT_ECRITURE = {
  id: true, reference: true, date: true, direction: true, category: true, label: true, amount: true, method: true,
  account: true, counterparty: true, invoiceRef: true, status: true, notes: true, companyId: true, treasuryAccountId: true,
  createdById: true, createdAt: true, compensation: true, compensationDeId: true, budgetCategoryId: true,
  justificatifFactureId: true,
} as const;
type EcritureLue = Prisma.FinanceTransactionGetPayload<{ select: typeof SELECT_ECRITURE }>;

/**
 * LES LIENS DES ÉCRITURES, EN LOT — l'ordre réglé (et sa caisse, sa source), la facture réglée directement, la paie,
 * les compensations, et les pièces qui les justifient.
 */
async function liensDesEcritures(ecritures: readonly EcritureLue[]) {
  const ids = ecritures.map((e) => e.id);
  const [ordres, factures, virements, caisses, compensees, comptes] = await Promise.all([
    ids.length ? prisma.expenseOrder.findMany({
      where: { transactionId: { in: ids } },
      select: {
        id: true, reference: true, transactionId: true, sourceType: true, sourceId: true, category: true, requestedById: true,
        createdAt: true, centralDecidedById: true, centralDecidedAt: true, centralStatus: true, paidById: true, paidDate: true,
        pettyCashAllotment: { select: { id: true } },
      },
    }) : [],
    ids.length ? prisma.legalDocument.findMany({
      where: { settlementTxId: { in: ids } }, select: { id: true, title: true, reference: true, settlementTxId: true, custom: true },
    }) : [],
    ids.length ? prisma.payrollWire.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true } }) : [],
    ids.length ? prisma.pettyCashAllotment.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true } }) : [],
    ids.length ? prisma.financeTransaction.findMany({
      where: { compensationDeId: { in: ids }, compensation: "CONTRE_PASSATION", status: { not: "CANCELLED" } },
      select: { id: true, reference: true, compensationDeId: true, createdAt: true, notes: true },
    }) : [],
    prisma.treasuryAccount.findMany({ select: { id: true, name: true } }),
  ]);
  const ordreIds = ordres.map((o) => o.id);
  const demandesSources = ordres.filter((o) => o.sourceType === "PAYMENT_REQUEST" && o.sourceId).map((o) => o.sourceId as string);
  const [facturesDesOrdres, demandes] = await Promise.all([
    ordreIds.length ? prisma.legalDocument.findMany({
      where: { expenseOrderId: { in: ordreIds } }, select: { id: true, title: true, reference: true, expenseOrderId: true, custom: true },
    }) : [],
    prisma.paymentRequest.findMany({
      where: { OR: [...(ordreIds.length ? [{ expenseOrderId: { in: ordreIds } }] : []), ...(demandesSources.length ? [{ id: { in: demandesSources } }] : [])] },
      select: { id: true, expenseOrderId: true },
    }),
  ]);
  const rattachees = ecritures.some((e) => e.justificatifFactureId)
    ? await prisma.legalDocument.findMany({
        where: { id: { in: ecritures.map((e) => e.justificatifFactureId).filter((x): x is string => Boolean(x)) } },
        select: { id: true, title: true, reference: true, custom: true },
      })
    : [];
  const toutesFactures = [...factures, ...facturesDesOrdres, ...rattachees];
  const [docs, piecesDemandes] = await Promise.all([
    prisma.document.findMany({
      where: {
        OR: [
          ...(ids.length ? [{ entityType: "FINANCE_TRANSACTION" as const, entityId: { in: ids } }] : []),
          ...(ordreIds.length ? [{ entityType: "EXPENSE_ORDER" as const, entityId: { in: ordreIds } }] : []),
          ...(toutesFactures.length ? [{ entityType: "LEGAL_DOCUMENT" as const, entityId: { in: toutesFactures.map((f) => f.id) } }] : []),
        ],
      },
      select: { id: true, name: true, mimeType: true, entityType: true, entityId: true },
      orderBy: { createdAt: "asc" },
    }),
    demandes.length ? prisma.paymentPiece.findMany({
      where: { requestId: { in: demandes.map((d) => d.id) }, status: { not: "REJECTED" } },
      select: { requestId: true, documentId: true },
      orderBy: { createdAt: "asc" },
    }) : [],
  ]);
  // Les fichiers des pièces du dossier de paiement (`PaymentPiece` ne porte que l'identifiant du document).
  const docsDemandes = piecesDemandes.length
    ? await prisma.document.findMany({ where: { id: { in: piecesDemandes.map((p) => p.documentId) } }, select: { id: true, name: true, mimeType: true } })
    : [];

  const piece = (d: { id: string; name: string; mimeType: string | null }): PieceCompta => ({ id: d.id, nom: d.name, href: `/api/documents/${d.id}`, mime: d.mimeType });
  const docsDe = (type: string, id: string) => docs.filter((d) => d.entityType === type && d.entityId === id).map(piece);
  const piecesFacture = (f: { id: string; title: string; reference: string | null; custom: unknown }): PieceCompta[] => {
    const emis = fichiersEmis(f.custom);
    return [
      ...docsDe("LEGAL_DOCUMENT", f.id),
      ...(emis.pdf ? [{ id: `${f.id}-pdf`, nom: `${f.reference ?? f.title}.pdf`, href: lienFichierEmis(f.id, "pdf"), mime: "application/pdf" }] : []),
    ];
  };
  const demandesDeLOrdre = (o: (typeof ordres)[number]) => demandes.filter((d) => d.expenseOrderId === o.id || (o.sourceType === "PAYMENT_REQUEST" && d.id === o.sourceId)).map((d) => d.id);
  const nomCompte = new Map(comptes.map((c) => [c.id, c.name]));
  const paies = new Set(virements.map((v) => v.transactionId));
  const caisseDirecte = new Set(caisses.map((c) => c.transactionId));

  return ecritures.map((e) => {
    const ordre = ordres.find((o) => o.transactionId === e.id) ?? null;
    const facture = factures.find((f) => f.settlementTxId === e.id) ?? null;
    const rattachee = e.justificatifFactureId ? rattachees.find((f) => f.id === e.justificatifFactureId) ?? null : null;
    const pieces: PieceCompta[] = [
      ...docsDe("FINANCE_TRANSACTION", e.id),
      ...(facture ? piecesFacture(facture) : []),
      ...(rattachee ? piecesFacture(rattachee) : []),
      ...(ordre ? [
        ...docsDe("EXPENSE_ORDER", ordre.id),
        ...facturesDesOrdres.filter((f) => f.expenseOrderId === ordre.id).flatMap(piecesFacture),
        ...piecesDemandes.filter((p) => demandesDeLOrdre(ordre).includes(p.requestId))
          .flatMap((p) => docsDemandes.filter((d) => d.id === p.documentId).map(piece)),
      ] : []),
    ];
    const vues = new Set<string>();
    const uniques = pieces.filter((p) => (vues.has(p.id) ? false : (vues.add(p.id), true)));
    const origine = origineDeLEcriture({
      category: e.category,
      ordre: ordre ? { reference: ordre.reference, sourceType: ordre.sourceType, category: ordre.category, caisse: Boolean(ordre.pettyCashAllotment) } : null,
      compensation: e.compensation,
      factureReglee: facture ? facture.reference ?? facture.title : null,
      paie: paies.has(e.id),
      notes: e.notes,
    });
    const compteNom = (e.treasuryAccountId && nomCompte.get(e.treasuryAccountId)) || e.account;
    const contre = compensees.find((c) => c.compensationDeId === e.id) ?? null;
    return {
      e, ordre, facture, pieces: uniques, contre,
      origine: caisseDirecte.has(e.id) && !ordre ? "Caisse" : origine,
      compte: { court: nomCourtCompte(compteNom), long: compteNom },
    };
  });
}

type Liee = Awaited<ReturnType<typeof liensDesEcritures>>[number];

function versLigne(l: Liee, demandees: ReadonlySet<string>): LigneCompta {
  const { e } = l;
  return {
    id: e.id, reference: e.reference, date: e.date.toISOString(), direction: e.direction === "IN" ? "IN" : "OUT",
    statut: e.status, tiers: e.counterparty?.trim() || "—", objet: e.label, montant: montantSigne(e.amount),
    compte: l.compte, justificatif: libelleJustificatif(l.pieces, demandees.has(e.id)), origine: l.origine,
    contrePassee: Boolean(l.contre), prevue: e.status === "PENDING",
  };
}

/** Les écritures dont la pièce a été demandée (« ✕ manquant · demandé ») — lues dans le journal du geste. */
async function piecesDemandees(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const traces = await prisma.auditLog.findMany({
    where: { entityType: "FINANCE_TRANSACTION", entityId: { in: [...ids] }, field: CHAMP_DEMANDE_PIECE },
    select: { entityId: true },
  });
  return new Set(traces.map((t) => t.entityId as string));
}

/** Le champ du journal d'audit qui porte « la pièce a été demandée à … » (`demanderPieceEcriture`). */
export const CHAMP_DEMANDE_PIECE = "demandePiece";

const RECHERCHE_MAX = 30;

export async function chargerComptabilite(user: CurrentUser, params: ParamsComptabilite): Promise<DonneesComptabilite> {
  const maintenant = new Date();
  const moisCourant = moisAlger(maintenant);
  const { societes, societeId } = await societeDeLEcran(user, params.societe);
  const parSociete = filtreSociete(societeId);
  const vue = lireVueCompta(params.vue);
  const periode = lirePeriodeListe(params.periode, moisCourant);
  const dates = bornes(periode);
  const q = texteRecherche(params.q);
  const sansJustif = params.sans === "1";

  const comptesSociete = await prisma.treasuryAccount.findMany({
    where: societeId === SANS_SOCIETE ? {} : { OR: [{ companyId: societeId }, { companyId: null }] },
    orderBy: [{ principal: "desc" }, { name: "asc" }], select: { id: true, name: true },
  });
  const compteId = params.compte && comptesSociete.some((c) => c.id === params.compte) ? params.compte : null;

  // ── LES TOTAUX DES ONGLETS — la période, la société ; une écriture annulée ne compte pas. ──
  const sommes = await prisma.financeTransaction.groupBy({
    by: ["direction"], where: { ...parSociete, status: { not: "CANCELLED" }, date: dates }, _sum: { amount: true },
  });
  const total = (d: "IN" | "OUT") => toNumber(sommes.find((s) => s.direction === d)?._sum.amount ?? 0);

  // ── LA LISTE DE L'ONGLET ──
  let lignes: LigneCompta[] = [];
  if (vue !== "res") {
    const ecritures = await prisma.financeTransaction.findMany({
      where: { ...parSociete, direction: SENS_DE_LA_VUE[vue], status: { not: "CANCELLED" }, date: dates, ...(compteId ? { treasuryAccountId: compteId } : {}) },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }], select: SELECT_ECRITURE,
    });
    const liees = await liensDesEcritures(ecritures);
    const demandees = await piecesDemandees(ecritures.map((e) => e.id));
    lignes = liees.map((l) => versLigne(l, demandees));
    if (sansJustif) lignes = lignes.filter((l) => !l.justificatif.present);
  }

  // ── LA RECHERCHE — les écritures de toute période ET les factures du registre de la société. ──
  let recherche: DonneesComptabilite["recherche"] = null;
  let facturesTrouvees: FactureCompta[] = [];
  if (q) {
    const montant = montantRecherche(q);
    const texte = { contains: q, mode: "insensitive" as const };
    const ecritures = await prisma.financeTransaction.findMany({
      where: {
        ...parSociete, status: { not: "CANCELLED" },
        OR: [{ reference: texte }, { label: texte }, { counterparty: texte }, { invoiceRef: texte }, { notes: texte }, ...(montant !== null ? [{ amount: montant }] : [])],
      },
      orderBy: { date: "desc" }, take: RECHERCHE_MAX * 2, select: SELECT_ECRITURE,
    });
    const liees = await liensDesEcritures(ecritures);
    const demandees = await piecesDemandees(ecritures.map((e) => e.id));
    const trouvees = liees.map((l) => versLigne(l, demandees));
    facturesTrouvees = await facturesDuRegistre(user, societeId, {
      OR: [{ title: texte }, { reference: texte }, { counterparty: texte }, ...(montant !== null ? [{ amount: montant }] : [])],
    }, RECHERCHE_MAX);
    recherche = {
      depenses: trouvees.filter((l) => l.direction === "OUT").slice(0, RECHERCHE_MAX),
      recettes: trouvees.filter((l) => l.direction === "IN").slice(0, RECHERCHE_MAX),
      factures: facturesTrouvees,
    };
  }

  // ── LE PANNEAU D'UNE ÉCRITURE — derrière la même clause que la liste (une écriture d'une autre société n'existe pas). ──
  const ecriture = params.ecriture ? await chargerDetailEcriture(user, params.ecriture, parSociete) : null;

  // ── LE PANNEAU D'UNE FACTURE ──
  let facture: DonneesComptabilite["facture"] = null;
  if (params.facture) {
    const f = facturesTrouvees.find((x) => x.id === params.facture)
      ?? (await facturesDuRegistre(user, societeId, { id: params.facture }, 1))[0] ?? null;
    if (f) facture = { ...f, candidats: f.peutRattacher ? await candidatsDeRattachement(parSociete, f) : [] };
  }

  // ── LE RÉSULTAT — l'année en cours, mois par mois, calculé en base depuis les écritures réglées. ──
  const annee = moisCourant.slice(0, 4);
  const resultat = await getResultatMensuel(user.id, lirePeriode({ periode: "perso", du: `${annee}-01`, au: moisCourant }, moisCourant), {
    societeId: societeId === SANS_SOCIETE ? null : societeId,
  });

  return {
    societes, societeId, vue, periode, periodes: choixDePeriode(moisCourant),
    totaux: { dep: total("OUT"), rec: total("IN") },
    comptes: comptesSociete.map((c) => ({ id: c.id, nom: c.name })), compteId, sansJustif,
    lignes, q, recherche, ecriture, facture,
    resultat: { annee, donnees: resultat },
    controles: await controlesDuLivre(parSociete, maintenant),
    budgets: await budgetsDeLaSociete(societeId),
  };
}

/** Les catégories budgétaires de la société (« Enveloppe › Catégorie ») — le choix « Budget imputé » de la saisie. */
async function budgetsDeLaSociete(societeId: string) {
  const lignes = await prisma.budgetCategoryLine.findMany({
    where: { envelope: societeId === SANS_SOCIETE ? { companyId: null } : { OR: [{ companyId: societeId }, { companyId: null }] } },
    select: { id: true, name: true, envelope: { select: { name: true } } },
    orderBy: [{ envelope: { name: "asc" } }, { name: "asc" }],
    take: 200,
  });
  return lignes.map((l) => ({ id: l.id, libelle: `${l.envelope.name} › ${l.name}` }));
}

/** LA FICHE D'UNE ÉCRITURE — sa chaîne (qui a demandé, autorisé, payé), son budget, ses pièces, sa compensation. */
async function chargerDetailEcriture(user: CurrentUser, id: string, parSociete: { companyId: string | null }): Promise<DetailEcriture | null> {
  const e = await prisma.financeTransaction.findFirst({ where: { id, ...parSociete }, select: SELECT_ECRITURE });
  if (!e) return null;
  const [l] = await liensDesEcritures([e]);
  const demandees = await piecesDemandees([e.id]);
  const ligne = versLigne(l!, demandees);
  const ordre = l!.ordre;

  const personnes = [e.createdById, ordre?.requestedById, ordre?.centralDecidedById, ordre?.paidById].filter((x): x is string => Boolean(x));
  const [gens, budget, origineDe, traces, inverse, factures] = await Promise.all([
    personnes.length ? prisma.user.findMany({ where: { id: { in: personnes } }, select: { id: true, name: true, role: true } }) : [],
    e.budgetCategoryId ? prisma.budgetCategoryLine.findUnique({ where: { id: e.budgetCategoryId }, select: { name: true, envelope: { select: { name: true } } } }) : null,
    ordre ? dossierHrefByOrder([ordre.id]) : Promise.resolve(new Map<string, string>()),
    prisma.auditLog.findMany({
      where: { entityType: "FINANCE_TRANSACTION", entityId: e.id, field: CHAMP_DEMANDE_PIECE },
      orderBy: { createdAt: "desc" }, select: { createdAt: true, newValue: true },
    }),
    e.compensationDeId ? prisma.financeTransaction.findUnique({ where: { id: e.compensationDeId }, select: { reference: true } }) : null,
    e.direction === "OUT" && e.counterparty ? facturesDuRegistre(user, e.companyId ?? SANS_SOCIETE, { counterparty: { contains: e.counterparty.trim(), mode: "insensitive" } }, 10) : [],
  ]);
  const qui = (uid: string | null | undefined) => {
    const g = gens.find((x) => x.id === uid);
    return g ? `${g.name} · ${ROLE_LABELS[g.role] ?? g.role}` : "—";
  };
  const jour = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  const chaine: EtapeChaine[] = ordre
    ? [
        { etape: "Demandé par", qui: qui(ordre.requestedById), date: jour(ordre.createdAt), attention: !ordre.requestedById },
        ordre.centralDecidedById
          ? { etape: "Autorisé au centre par", qui: qui(ordre.centralDecidedById), date: jour(ordre.centralDecidedAt), attention: false }
          : { etape: "Centre de paiement", qui: "aucune autorisation enregistrée", date: null, attention: true },
        { etape: "Payé par", qui: qui(ordre.paidById), date: jour(ordre.paidDate ?? e.date), attention: !ordre.paidById },
      ]
    : [
        { etape: l!.origine === "Import relevé" ? "Importée du relevé par" : "Saisie par", qui: qui(e.createdById), date: jour(e.createdAt), attention: !e.createdById },
        ...(e.compensation ? [] : [{ etape: "Centre de paiement", qui: "non passée par le centre", date: null, attention: e.direction === "OUT" }]),
      ];

  const derniere = traces[0];
  const destinataires = [ordre?.requestedById, e.createdById].filter((x): x is string => Boolean(x))
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((uid) => ({ id: uid, nom: qui(uid) }));

  let compensationTexte: string | null = null;
  if (l!.contre) compensationTexte = `Contre-passée le ${l!.contre.createdAt.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })} · écriture inverse ${l!.contre.reference}${l!.contre.notes ? ` · ${l!.contre.notes}` : ""}`;
  else if (inverse) compensationTexte = `Écriture inverse de ${inverse.reference}${e.notes ? ` · ${e.notes}` : ""}`;

  return {
    ...ligne,
    tiersLabel: libelleTiers(e.direction),
    categorie: FINANCE_CATEGORY[e.category] ?? e.category,
    categorieCode: e.category,
    moyen: FINANCE_METHOD[e.method] ?? e.method,
    methodCode: e.method,
    compteId: e.treasuryAccountId,
    invoiceRef: e.invoiceRef ?? "",
    notes: e.notes ?? "",
    pieces: l!.pieces,
    chaine,
    budget: budget ? `${budget.envelope.name} › ${budget.name}` : e.direction === "IN" ? "Recette (hors budget)" : "Non imputé",
    origineHref: ordre ? origineDe.get(ordre.id) ?? entityHref(ordre.sourceType, ordre.sourceId) : l!.facture ? `/legal/${l!.facture.id}` : null,
    compensationTexte,
    demandePiece: derniere ? { a: qui(derniere.newValue), le: derniere.createdAt.toISOString(), fois: traces.length } : null,
    destinataires,
    facturesProposees: factures
      .filter((f) => f.peutRattacher)
      .map((f) => ({ id: f.id, titre: f.titre, montant: f.montant, maison: f.maison, suggeree: f.montant !== null && Math.abs(f.montant - Math.abs(ligne.montant)) < 0.01 })),
    reglementDe: ordre?.reference ?? null,
  };
}

/**
 * LES FACTURES DU REGISTRE LEGAL (nature INVOICE) DE LA SOCIÉTÉ — lues avec les lecteurs désignés (une facture
 * restreinte n'apparaît pas à qui n'y est pas nommé), leur état de paiement, et la marque « ressemble à une autre »
 * du recensement des doublons (`recenserDoublonsFactures`, la règle unique des doublons de factures).
 */
async function facturesDuRegistre(user: CurrentUser, societeId: string, filtre: Prisma.LegalDocumentWhereInput, take: number): Promise<FactureCompta[]> {
  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const docs = await prisma.legalDocument.findMany({
    where: { AND: [{ kind: "INVOICE", status: { not: "CANCELLED" } }, filtreSociete(societeId), filtre, ...(lecteurs ? [lecteurs] : [])] },
    orderBy: { createdAt: "desc" }, take,
    select: {
      id: true, title: true, reference: true, counterparty: true, amount: true, startDate: true, endDate: true, createdAt: true,
      direction: true, paidDate: true, settlementTxId: true, expenseOrderId: true, custom: true, sourceType: true, sourceId: true,
      justifieEcriture: { select: { id: true, reference: true } },
    },
  });
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.id);
  const [usages, ordres, ecritures, fichiers, doublons] = await Promise.all([
    usagesDesDocumentsLegal(ids),
    prisma.expenseOrder.findMany({ where: { id: { in: docs.map((d) => d.expenseOrderId).filter((x): x is string => Boolean(x)) } }, select: { id: true, reference: true, status: true, transactionId: true } }),
    prisma.financeTransaction.findMany({ where: { id: { in: docs.map((d) => d.settlementTxId).filter((x): x is string => Boolean(x)) } }, select: { id: true, reference: true } }),
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true, name: true, mimeType: true, entityId: true }, orderBy: { createdAt: "asc" } }),
    doublonsDesFactures(ids),
  ]);
  const ecrituresOrdres = await prisma.financeTransaction.findMany({
    where: { id: { in: ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x)) } }, select: { id: true, reference: true },
  });
  return docs.map((d) => {
    const ordre = ordres.find((o) => o.id === d.expenseOrderId) ?? null;
    const usage = usages.get(d.id) ?? { demandes: [], envoyeAuReglement: false, regle: false };
    const etat = etatDeLaFacture({
      direction: d.direction, paidDate: d.paidDate, settlementTxId: d.settlementTxId, expenseOrderId: d.expenseOrderId,
      statutOrdre: ordre?.status ?? null, demandes: usage.demandes, justifiePaiement: Boolean(d.justifieEcriture),
    });
    const ecriture = ecritures.find((x) => x.id === d.settlementTxId) ?? ecrituresOrdres.find((x) => x.id === ordre?.transactionId) ?? d.justifieEcriture ?? null;
    const emis = fichiersEmis(d.custom);
    const recue = d.direction !== "IN";
    return {
      id: d.id, titre: d.title, reference: d.reference, type: recue ? "Facture" as const : "Facture de vente" as const,
      tiers: d.counterparty?.trim() || "—", montant: d.amount !== null ? toNumber(d.amount) : null,
      date: jourIso(d.startDate ?? d.createdAt), echeance: jourIso(d.endDate),
      maison: d.sourceType ? `Registre Legal · ${ENTITY_TYPE_LABELS[d.sourceType] ?? d.sourceType}` : "Registre Legal",
      etat, etatLibelle: LIBELLE_ETAT_FACTURE[etat], ecriture, ordreRef: ordre?.reference ?? null, demandes: [...usage.demandes],
      doublon: doublons.get(d.id) ?? null,
      pieces: [
        ...fichiers.filter((f) => f.entityId === d.id).map((f) => ({ id: f.id, nom: f.name, href: `/api/documents/${f.id}`, mime: f.mimeType })),
        ...(emis.pdf ? [{ id: `${d.id}-pdf`, nom: `${d.reference ?? d.title}.pdf`, href: lienFichierEmis(d.id, "pdf"), mime: "application/pdf" }] : []),
      ],
      peutDemander: peutDemanderLePaiement(etat),
      peutRattacher: peutRattacherAUnPaiement(etat),
    };
  });
}

/**
 * « CETTE PIÈCE RESSEMBLE À UNE AUTRE » — la règle des doublons de factures, telle quelle (même fichier ; même
 * fournisseur et même numéro ; même fournisseur, même montant et même date). Le recensement lit TOUTES les factures
 * connues : on ne l'appelle que lorsque la recherche a ramené des factures.
 */
async function doublonsDesFactures(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { groupes } = await recenserDoublonsFactures();
  for (const g of groupes) {
    for (const id of ids) {
      if (!g.membres.some((m) => m.cle === `REGISTRE:${id}`)) continue;
      const autres = g.membres.filter((m) => m.cle !== `REGISTRE:${id}`).map((m) => `${m.piece} (${m.module})`);
      out.set(id, `${g.niveau === "CERTAIN" ? "Doublon" : "Ressemble à"} ${autres.join(", ")} — ${g.raisons[0] ?? "même fournisseur, même montant"}`);
    }
  }
  return out;
}

/** « Rattacher à un paiement fait » : les DÉPENSES de la société sans justificatif — la même partie et le même montant d'abord. */
async function candidatsDeRattachement(parSociete: { companyId: string | null }, f: FactureCompta): Promise<CandidatRattachement[]> {
  const ecritures = await prisma.financeTransaction.findMany({
    where: { ...parSociete, direction: "OUT", status: "SETTLED", compensation: null },
    orderBy: { date: "desc" }, take: 200, select: SELECT_ECRITURE,
  });
  const liees = await liensDesEcritures(ecritures);
  const tiers = f.tiers.toLowerCase();
  return liees
    .filter((l) => l.pieces.length === 0 && !l.contre && !l.e.justificatifFactureId)
    .map((l) => ({
      id: l.e.id, reference: l.e.reference, tiers: l.e.counterparty?.trim() || "—", montant: montantSigne(l.e.amount), date: l.e.date.toISOString(),
      suggere: (l.e.counterparty ?? "").toLowerCase().includes(tiers) && f.montant !== null && Math.abs(montantSigne(l.e.amount) - f.montant) < 0.01,
    }))
    .sort((a, b) => Number(b.suggere) - Number(a.suggere))
    .slice(0, 20);
}

/**
 * LES CONTRÔLES DU LIVRE (rangés sous ⋯, sans rien perdre) — la même règle qu'avant (`auditLedger`), sur la société :
 * un ordre réglé sans écriture, une même source réglée deux fois, deux écritures identiques. On SIGNALE, rien ne s'efface.
 */
async function controlesDuLivre(parSociete: { companyId: string | null }, maintenant: Date): Promise<DonneesComptabilite["controles"]> {
  const [ordres, ecritures, remises] = await Promise.all([
    prisma.expenseOrder.findMany({
      where: { ...parSociete, status: "PAID" }, orderBy: { paidDate: "desc" }, take: 500,
      select: { id: true, reference: true, label: true, amount: true, transactionId: true, sourceType: true, sourceId: true, paidDate: true },
    }),
    prisma.financeTransaction.findMany({
      where: { ...parSociete, status: { not: "CANCELLED" } }, orderBy: { date: "desc" }, take: 3000,
      select: { id: true, reference: true, direction: true, amount: true, label: true, counterparty: true, date: true, compensation: true, compensationDeId: true },
    }),
    // Une remise de caisse n'a de société que par son ordre : celles d'avant la règle (sans ordre) se lisent sous « Sans société ».
    prisma.pettyCashAllotment.findMany({
      where: parSociete.companyId === null ? { expenseOrderId: null } : { expenseOrder: { status: "PAID", companyId: parSociete.companyId } },
      orderBy: { createdAt: "desc" }, take: 300,
      select: { id: true, amount: true, period: true, transactionId: true, createdAt: true, department: { select: { name: true } } },
    }),
  ]);
  // Une écriture contre-passée et sa contre-passation ne sont plus un doublon : on les retire de la comparaison.
  const compensees = new Set(ecritures.filter((e) => e.compensationDeId).flatMap((e) => [e.id, e.compensationDeId as string]));
  const audit = auditLedger(
    ordres.map((o) => ({ ...o, amount: toNumber(o.amount) })),
    ecritures.filter((e) => !compensees.has(e.id)).map((e) => ({ ...e, amount: toNumber(e.amount) })),
    remises.map((r) => ({
      id: r.id, label: `Caisse d'avance — ${r.department?.name ?? "service"} (${r.period})`, amount: toNumber(r.amount), transactionId: r.transactionId, date: r.createdAt,
    })),
  );
  const parReference = new Map(ecritures.map((e) => [e.reference, e.id]));
  const ecritureDeLOrdre = new Map(ordres.map((o) => [o.reference, o.transactionId]));
  const points: ControleCompta[] = audit.findings.map((f) => ({
    kind: f.kind, titre: f.title, detail: f.detail,
    ouvrir: f.references.flatMap((r) => {
      const id = parReference.get(r) ?? ecritureDeLOrdre.get(r) ?? null;
      return id ? [{ id, reference: ecritures.find((e) => e.id === id)?.reference ?? r }] : [];
    }),
  }));
  return {
    resume: auditSummary(audit), propre: audit.clean, points,
    passage: maintenant.toLocaleTimeString("fr-FR", { timeZone: "Africa/Algiers", hour: "2-digit", minute: "2-digit" }),
  };
}

