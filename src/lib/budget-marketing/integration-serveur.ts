import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import type { AdProItemKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { buildRef } from "@/lib/refs";
import { canManageEnvelope, type SessionUser } from "@/lib/rbac";
import { getBudgetOverview } from "@/lib/queries/budget";
import { engagementsBruts } from "@/lib/queries/budget-sources";
import {
  consommationIntegree, contexteDeLEnveloppe, jugerEngagements,
  type ContexteIntegration, type SourceJugee,
} from "@/lib/queries/budget-integration";
import { estAbsenteDuFichier, LIBELLE_RAISON, regleDuLot, type PosteHistorique } from "@/lib/budget/integration-regle";
import {
  ANNEE_INTEGRATION, CATEGORIES_2026, DEMANDEUR_AFFICHE, FEUILLE, SOUS_CATEGORIES_EVENEMENTS, TOTAL_ATTENDU_CENTIMES,
  VERSION_INTEGRATION_2026, categorieCorrespond, controlerFichier, dateDeLaDepense, incoherences, lireLignes,
  montantDeLaDemande, sousCategorieCorrespond,
  type Categorie2026, type DemandePrevue, type PlanIntegration, type PostePrevu, type SousCategorie2026, type TypeDemandeIntegree,
} from "@/lib/budget-marketing/integration-2026";
import { apparierPostes, suggestions, SEUIL_PRESELECTION, type Candidate, type Suggestion } from "@/lib/budget-marketing/integration-suggestions";
import { lienDemande, piecesAttenduesDe, piecesRattacheesDe } from "@/lib/budget-marketing/integration-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 — LIRE, PROPOSER, VÉRIFIER, ÉCRIRE, ANNULER (serveur).
 *
 * Les décisions vivent dans `integration-2026.ts` (versionné), la règle de budget dans `budget/integration-regle.ts`.
 * Ici : la lecture du fichier (xlsx), les demandes candidates, l'aperçu avant → après (la MÊME règle, appliquée à un lot
 * simulé), l'écriture ATOMIQUE du lot et son annulation d'un bloc.
 *
 * Ce qui n'est JAMAIS touché : le livre de trésorerie (aucune `FinanceTransaction` créée, modifiée ou supprimée) et les
 * ordres de dépense (aucun `ExpenseOrder`). Une écriture de trésorerie existante se RELIE en lecture seule.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const empreinte = (octets: Uint8Array): string => createHash("sha256").update(octets).digest("hex");
const dzd = (centimes: number) => centimes / 100;
const vers = (n: unknown) => Math.round(toNumber(n as Parameters<typeof toNumber>[0]) * 100);

// ─────────────────────────────── 1. Lire le fichier ───────────────────────────────

export type LectureFichier = { ok: true; sha256: string; plan: PlanIntegration } | { ok: false; erreurs: string[] };

export function lireFichierIntegration(octets: Uint8Array): LectureFichier {
  const internes = incoherences();
  if (internes.length) return { ok: false, erreurs: [`Les décisions enregistrées sont incohérentes : ${internes.join(" ")}`] };
  let classeur: XLSX.WorkBook;
  try {
    classeur = XLSX.read(octets, { type: "array" });
  } catch {
    return { ok: false, erreurs: ["Le fichier ne se lit pas comme un classeur Excel (.xlsx)."] };
  }
  const feuille = classeur.Sheets[FEUILLE];
  if (!feuille) return { ok: false, erreurs: [`La feuille « ${FEUILLE} » est introuvable : c'est elle qui fait foi.`] };
  const cellules = XLSX.utils.sheet_to_json<unknown[]>(feuille, { header: 1, raw: true, defval: null, blankrows: true });
  const lu = lireLignes(cellules);
  if (!lu.ok) return { ok: false, erreurs: [lu.erreur] };
  const r = controlerFichier(lu.lignes);
  if (!r.ok) return { ok: false, erreurs: r.erreurs };
  if (r.plan.totalCentimes !== TOTAL_ATTENDU_CENTIMES) return { ok: false, erreurs: [`Total ${r.plan.totalCentimes / 100} ≠ 33 558 715,94 DZD.`] };
  return { ok: true, sha256: empreinte(octets), plan: r.plan };
}

// ─────────────────────────────── 2. L'enveloppe et ses catégories ───────────────────────────────

export interface EnveloppeCandidate { id: string; nom: string; debut: string; fin: string; actif: boolean; lotActif: string | null }

/** Les enveloppes MARKETING couvrant 2026 que la personne gère. */
export async function enveloppesGerees(user: SessionUser): Promise<EnveloppeCandidate[]> {
  const debut = new Date(Date.UTC(ANNEE_INTEGRATION, 0, 1)), fin = new Date(Date.UTC(ANNEE_INTEGRATION, 11, 31, 23, 59, 59));
  const envs = await prisma.budgetEnvelope.findMany({
    where: { domaine: "MARKETING", periodStart: { lte: fin }, periodEnd: { gte: debut } },
    orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
    include: { lotsIntegration: { where: { annuleLe: null }, select: { id: true } } },
  });
  const gerees = envs.filter((e) => canManageEnvelope(user, e));
  // L'enveloppe Ad & Pro d'abord.
  const adpro = (n: string) => /ad\s*(&|et)?\s*pro/i.test(n);
  return gerees
    .sort((a, b) => Number(adpro(b.name)) - Number(adpro(a.name)))
    .map((e) => ({ id: e.id, nom: e.name, debut: e.periodStart.toISOString(), fin: e.periodEnd.toISOString(), actif: e.isActive, lotActif: e.lotsIntegration[0]?.id ?? null }));
}

export interface CorrespondanceCategories {
  categories: Record<Categorie2026, { id: string | null; nom: string }>;
  sousCategories: Record<SousCategorie2026, { id: string | null; nom: string }>;
}

/** Les catégories du plan retrouvées dans l'enveloppe (par leurs noms) ; `id: null` = à créer (allouée à 0). */
export async function correspondanceCategories(envelopeId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<CorrespondanceCategories> {
  const cats = await db.budgetCategoryLine.findMany({ where: { envelopeId }, select: { id: true, name: true, parentId: true }, orderBy: { createdAt: "asc" } });
  const tetes = cats.filter((c) => c.parentId === null);
  const categories = {} as CorrespondanceCategories["categories"];
  for (const k of CATEGORIES_2026) {
    const t = tetes.find((c) => categorieCorrespond(c.name, k));
    categories[k] = { id: t?.id ?? null, nom: t?.name ?? k };
  }
  const sousCategories = {} as CorrespondanceCategories["sousCategories"];
  const evts = categories["Événements"].id;
  for (const s of SOUS_CATEGORIES_EVENEMENTS) {
    const sc = evts ? cats.find((c) => c.parentId === evts && sousCategorieCorrespond(c.name, s)) : undefined;
    sousCategories[s] = { id: sc?.id ?? null, nom: sc?.name ?? s };
  }
  return { categories, sousCategories };
}

const idImputation = (corr: CorrespondanceCategories, p: Pick<PostePrevu, "categorie" | "sousCategorie">): string | null =>
  p.sousCategorie ? corr.sousCategories[p.sousCategorie].id : corr.categories[p.categorie].id;

// ─────────────────────────────── 3. Les demandes candidates ───────────────────────────────

const DEBUT_ANNEE = new Date(Date.UTC(ANNEE_INTEGRATION, 0, 1));
const SELECT_POSTES = { id: true, label: true, amountGranted: true, amountEstimated: true, supplier: true, montantPayeHistorique: true, status: true } as const;
type PosteLu = { id: string; label: string; amountGranted: unknown; amountEstimated: unknown; supplier: string | null; montantPayeHistorique: unknown; status: string };
const postesVus = (items: PosteLu[]): Candidate["postes"] => items.filter((i) => i.status !== "REJECTED").map((i) => ({
  id: i.id, libelle: i.label, montant: i.amountGranted != null ? vers(i.amountGranted) : i.amountEstimated != null ? vers(i.amountEstimated) : null,
  fournisseur: i.supplier, historique: i.montantPayeHistorique != null,
}));
const montantDe = (...v: unknown[]) => { const x = v.find((y) => y != null); return x == null ? null : vers(x); };

/** Les demandes 2026 de chaque nature, hors celles déjà portées par un lot actif. */
export async function chargerCandidates(): Promise<Candidate[]> {
  const deja = new Set((await prisma.adProIntegrationDemande.findMany({ where: { lot: { annuleLe: null } }, select: { demandeType: true, demandeId: true } })).map((d) => `${d.demandeType}:${d.demandeId}`));
  const depuis = { gte: DEBUT_ANNEE };
  const [sp, cn, ci, ev, tr, pm, dim] = await Promise.all([
    prisma.sponsoringRequest.findMany({ where: { OR: [{ createdAt: depuis }, { requestDate: depuis }] }, select: { id: true, reference: true, institution: true, requestDate: true, amountGranted: true, amountRequested: true, items: { select: SELECT_POSTES } }, take: 500 }),
    prisma.congressNational.findMany({ where: { OR: [{ createdAt: depuis }, { date: depuis }] }, select: { id: true, name: true, date: true, finalAmount: true, estimatedBudget: true, items: { select: SELECT_POSTES } }, take: 500 }),
    prisma.congressInternational.findMany({ where: { OR: [{ createdAt: depuis }, { startDate: depuis }] }, select: { id: true, name: true, startDate: true, finalAmount: true, estimatedBudget: true, items: { select: SELECT_POSTES } }, take: 500 }),
    prisma.event.findMany({ where: { OR: [{ createdAt: depuis }, { startDate: depuis }] }, select: { id: true, name: true, startDate: true, finalAmount: true, estimatedBudget: true, items: { select: SELECT_POSTES } }, take: 500 }),
    prisma.training.findMany({ where: { OR: [{ createdAt: depuis }, { startDate: depuis }] }, select: { id: true, reference: true, title: true, startDate: true, amountGranted: true, amount: true, items: { select: SELECT_POSTES } }, take: 500 }),
    prisma.promoMaterial.findMany({ where: { createdAt: depuis }, select: { id: true, reference: true, title: true, createdAt: true, chosenAmount: true, amount: true, postesHistoriques: { select: SELECT_POSTES } }, take: 500 }),
    prisma.medicalInfoDeclaration.findMany({ where: { createdAt: depuis, declarationKind: "AD_VISA" }, select: { id: true, reference: true, label: true, createdAt: true, amount: true, postesHistoriques: { select: SELECT_POSTES } }, take: 500 }),
  ]);
  const out: Candidate[] = [
    ...sp.map((r) => ({ type: "SPONSORING" as const, id: r.id, reference: r.reference, libelle: r.institution, date: r.requestDate.toISOString(), montant: montantDe(r.amountGranted, r.amountRequested), postes: postesVus(r.items) })),
    ...cn.map((r) => ({ type: "CONGRESS_NATIONAL" as const, id: r.id, reference: null, libelle: r.name, date: r.date?.toISOString() ?? null, montant: montantDe(r.finalAmount, r.estimatedBudget), postes: postesVus(r.items) })),
    ...ci.map((r) => ({ type: "CONGRESS_INTERNATIONAL" as const, id: r.id, reference: null, libelle: r.name, date: r.startDate?.toISOString() ?? null, montant: montantDe(r.finalAmount, r.estimatedBudget), postes: postesVus(r.items) })),
    ...ev.map((r) => ({ type: "EVENT" as const, id: r.id, reference: null, libelle: r.name, date: r.startDate?.toISOString() ?? null, montant: montantDe(r.finalAmount, r.estimatedBudget), postes: postesVus(r.items) })),
    ...tr.map((r) => ({ type: "TRAINING" as const, id: r.id, reference: r.reference, libelle: r.title, date: r.startDate?.toISOString() ?? null, montant: montantDe(r.amountGranted, r.amount), postes: postesVus(r.items) })),
    ...pm.map((r) => ({ type: "PROMO_MATERIAL" as const, id: r.id, reference: r.reference, libelle: r.title, date: r.createdAt.toISOString(), montant: montantDe(r.chosenAmount, r.amount), postes: postesVus(r.postesHistoriques) })),
    ...dim.map((r) => ({ type: "MEDICAL_INFO_DECLARATION" as const, id: r.id, reference: r.reference, libelle: r.label, date: r.createdAt.toISOString(), montant: montantDe(r.amount), postes: postesVus(r.postesHistoriques) })),
  ];
  return out.filter((c) => !deja.has(`${c.type}:${c.id}`));
}

export interface PropositionDemande {
  cle: string;
  suggestions: Suggestion[];
  /** Le choix proposé d'avance : la candidate repérée par un indice de la maquette, sinon la création. */
  parDefaut: { mode: "CREEE" } | { mode: "COMPLETEE"; demandeId: string; type: TypeDemandeIntegree };
}

export function proposer(plan: PlanIntegration, candidates: readonly Candidate[]): PropositionDemande[] {
  return plan.demandes.map((d) => {
    const s = suggestions(d, candidates);
    const top = s[0];
    return {
      cle: d.cle,
      suggestions: s,
      parDefaut: top && top.score >= SEUIL_PRESELECTION ? { mode: "COMPLETEE", demandeId: top.candidate.id, type: top.candidate.type } : { mode: "CREEE" },
    };
  });
}

/** Les pièces de la plateforme repérées d'avance (la facture ePrint 226-00572…), rattachables sans redépôt. */
export async function piecesConnuesDuPlan(plan: PlanIntegration): Promise<Record<string, { legalDocumentId: string; documentId: string | null; nom: string; cle: string }[]>> {
  const out: Record<string, { legalDocumentId: string; documentId: string | null; nom: string; cle: string }[]> = {};
  for (const d of plan.demandes) {
    const f = d.existant?.facture;
    if (!f) continue;
    const docs = await prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" }, OR: [{ reference: { contains: f.numero } }, { title: { contains: f.numero } }] },
      select: { id: true, reference: true, title: true }, take: 3,
    });
    for (const doc of docs) {
      const fichier = await prisma.document.findFirst({ where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
      (out[d.cle] ??= []).push({ legalDocumentId: doc.id, documentId: fichier?.id ?? null, nom: fichier?.name ?? doc.reference ?? doc.title, cle: d.piecesAttendues[0]?.cle ?? "facture" });
    }
  }
  return out;
}

// ─────────────────────────────── 4. Vérifier : avant → après ───────────────────────────────

export type ChoixDemande =
  | { cle: string; mode: "CREEE" }
  | { cle: string; mode: "COMPLETEE"; type: TypeDemandeIntegree; demandeId: string; posteRepere?: string | null };

export interface EntreeIntegration {
  envelopeId: string;
  choix: readonly ChoixDemande[];
  decisions: readonly { cleSource: string; decision: "GARDER" | "SORTIR" }[];
  /** Le dossier de matériel promotionnel que couvre le visa : `lot:<clé de demande>` (créé par ce lot), un id, ou rien. */
  dossierPromoDuVisa?: string | null;
  /** Rattacher d'office les pièces de la plateforme repérées (la facture ePrint…). */
  rattacherConnues?: boolean;
}

export interface LigneAvantApres {
  id: string;
  nom: string;
  parentId: string | null;
  alloue: number;
  avant: { consomme: number; engage: number };
  apres: { consomme: number; engage: number };
  /** Catégorie du plan qui n'existe pas encore dans l'enveloppe : elle sera créée (allouée à 0). */
  creee: boolean;
}

export interface AbsenteVue {
  cle: string;
  nature: "ECRITURE" | "LIGNE" | "ENGAGEMENT";
  libelle: string;
  reference: string;
  montant: number;
  categorie: string;
  date: string;
  decision: "GARDER" | "SORTIR" | null;
  raison: string;
}

export interface Apercu {
  lignes: LigneAvantApres[];
  totalAvant: { consomme: number; engage: number };
  totalApres: { consomme: number; engage: number };
  /** Ce qui entre du fichier (centimes). */
  historiqueCentimes: number;
  remplacees: { cle: string; libelle: string; montant: number; raison: string }[];
  absentes: AbsenteVue[];
}

/** Les postes historiques du plan, tels que la règle les lira (catégorie de l'enveloppe, ou virtuelle « à créer »). */
function postesDuPlan(plan: PlanIntegration, corr: CorrespondanceCategories): PosteHistorique[] {
  return plan.demandes.flatMap((d) => d.postes.map((p, i) => ({
    id: `plan:${d.cle}:${i}`,
    categoryId: idImputation(corr, p) ?? `nouvelle:${p.sousCategorie ?? p.categorie}`,
    montant: dzd(p.montant), payeLe: dateDeLaDepense(d.mois), kind: p.nature, libelle: p.libelle, demande: null, ligne: p.ligne,
  })));
}

/** Les postes existants qu'un choix « compléter » reprend (ils deviennent historiques). */
async function postesRepris(plan: PlanIntegration, choix: readonly ChoixDemande[]): Promise<Map<string, (string | null)[]>> {
  const out = new Map<string, (string | null)[]>();
  for (const c of choix) {
    if (c.mode !== "COMPLETEE") continue;
    const d = plan.demandes.find((x) => x.cle === c.cle);
    if (!d) continue;
    const existants = await postesDeLaDemande(prisma, c.type, c.demandeId);
    out.set(c.cle, apparierPostes(d.postes, existants, c.posteRepere ?? null));
  }
  return out;
}

async function postesDeLaDemande(db: Prisma.TransactionClient | typeof prisma, type: TypeDemandeIntegree, id: string) {
  const items = await db.adProItem.findMany({ where: { [colonneParent(type)]: id, status: { not: "REJECTED" } }, select: SELECT_POSTES, orderBy: { position: "asc" } });
  return postesVus(items as PosteLu[]);
}

/**
 * L'APERÇU — le budget AVANT (celui que l'écran montre aujourd'hui) et APRÈS (la même règle, appliquée à un lot SIMULÉ :
 * mêmes demandes complétées, mêmes postes historiques, mêmes choix « garder / sortir »). Aucune écriture.
 */
export async function apercuIntegration(user: SessionUser, plan: PlanIntegration, entree: EntreeIntegration): Promise<Apercu | { erreur: string }> {
  const env = await prisma.budgetEnvelope.findUnique({ where: { id: entree.envelopeId }, include: { categories: { orderBy: { createdAt: "asc" } } } });
  if (!env || !canManageEnvelope(user, env)) return { erreur: "Enveloppe introuvable, ou vous ne la gérez pas." };
  if (await contexteDeLEnveloppe(env.id)) return { erreur: "Un lot d'intégration est déjà validé sur cette enveloppe : annulez-le d'abord." };
  const ov = await getBudgetOverview(user, env.id, null, null, { portee: "MARKETING" });
  if (!ov) return { erreur: "Enveloppe illisible pour vous." };
  const corr = await correspondanceCategories(env.id);
  const repris = await postesRepris(plan, entree.choix);
  const catIds = env.categories.map((c) => c.id);
  const historiques = postesDuPlan(plan, corr);
  // Les écritures que la maquette relie (FIN-2026-119…) : elles seront reliées à leur demande, donc remplacées.
  const reliees = new Map<string, string>();
  for (const [cle, txId] of Object.entries(await ecrituresIndiquees(plan))) {
    const ch = entree.choix.find((x) => x.cle === cle);
    reliees.set(txId, ch?.mode === "COMPLETEE" ? `${ch.type}:${ch.demandeId}` : `plan:${cle}`);
  }
  const ctx: ContexteIntegration = {
    regle: regleDuLot({
      lotId: "apercu", enveloppeId: env.id, integreLe: new Date(),
      demandes: [
        ...entree.choix.filter((c): c is Extract<ChoixDemande, { mode: "COMPLETEE" }> => c.mode === "COMPLETEE").map((c) => ({ type: c.type, id: c.demandeId })),
        ...[...reliees.values()].filter((k) => k.startsWith("plan:")).map((k) => ({ type: "plan", id: k.slice(5) })),
      ],
      postesHistoriques: [...repris.values()].flat().filter((x): x is string => Boolean(x)),
      decisions: entree.decisions,
    }),
    categories: new Set(catIds),
    postes: historiques,
    ecrituresReliees: reliees,
  };
  const from = env.periodStart, to = env.periodEnd;
  const integ = await consommationIntegree([ctx], catIds, from, to);
  const eng = await engagementsBruts(catIds, to);
  const juges = await jugerEngagements([ctx], eng.details);
  const jugees: SourceJugee[] = [...integ.jugees, ...juges.jugees];

  const retire = { consomme: new Map<string, number>(), engage: new Map<string, number>() };
  const ajoute = (m: Map<string, number>, k: string | null, v: number) => { if (k) m.set(k, (m.get(k) ?? 0) + v); };
  const statutDe = new Map((await prisma.financeTransaction.findMany({ where: { id: { in: integ.jugees.filter((j) => j.nature === "ECRITURE").map((j) => j.cle.slice(3)) } }, select: { id: true, status: true } })).map((t) => [t.id, t.status]));
  for (const j of jugees) {
    if (j.verdict.compte) continue;
    if (j.nature === "ENGAGEMENT") ajoute(retire.engage, j.categoryId, j.montant);
    else if (j.nature === "LIGNE") ajoute(retire.consomme, j.categoryId, j.montant);
    else ajoute(statutDe.get(j.cle.slice(3)) === "PENDING" ? retire.engage : retire.consomme, j.categoryId, j.montant);
  }
  const hist = new Map<string, number>();
  for (const h of historiques) ajoute(hist, h.categoryId, h.montant);

  const lignes: LigneAvantApres[] = ov.categories.map((c) => ({
    id: c.id, nom: c.name, parentId: c.parentId, alloue: c.allocated, creee: false,
    avant: { consomme: c.consumed, engage: c.committed },
    apres: {
      consomme: c.consumed - (retire.consomme.get(c.id) ?? 0) + (hist.get(c.id) ?? 0),
      engage: c.committed - (retire.engage.get(c.id) ?? 0),
    },
  }));
  // Les catégories à créer (allouées à 0) — sous « Événements » pour une sous-catégorie.
  const evts = corr.categories["Événements"].id ?? "nouvelle:Événements";
  for (const k of CATEGORIES_2026) if (!corr.categories[k].id) {
    const id = `nouvelle:${k}`;
    lignes.push({ id, nom: k, parentId: null, alloue: 0, creee: true, avant: { consomme: 0, engage: 0 }, apres: { consomme: hist.get(id) ?? 0, engage: 0 } });
  }
  for (const s of SOUS_CATEGORIES_EVENEMENTS) if (!corr.sousCategories[s].id) {
    const id = `nouvelle:${s}`;
    lignes.push({ id, nom: s, parentId: evts, alloue: 0, creee: true, avant: { consomme: 0, engage: 0 }, apres: { consomme: hist.get(id) ?? 0, engage: 0 } });
  }
  const somme = (f: (l: LigneAvantApres) => number) => Math.round(lignes.reduce((s, l) => s + f(l), 0) * 100) / 100;
  const nomCat = new Map(ov.categories.map((c) => [c.id, c.name]));
  return {
    lignes,
    totalAvant: { consomme: somme((l) => l.avant.consomme), engage: somme((l) => l.avant.engage) },
    totalApres: { consomme: somme((l) => l.apres.consomme), engage: somme((l) => l.apres.engage) },
    historiqueCentimes: plan.totalCentimes,
    remplacees: jugees.filter((j) => !j.verdict.compte && !estAbsenteDuFichier(j.verdict)).map((j) => ({ cle: j.cle, libelle: `${j.reference} — ${j.libelle}`, montant: j.montant, raison: LIBELLE_RAISON[j.verdict.raison] })),
    absentes: jugees.filter((j) => estAbsenteDuFichier(j.verdict)).map((j) => vueAbsente(j, nomCat)),
  };
}

function vueAbsente(j: SourceJugee, nomCat: Map<string, string>): AbsenteVue {
  return {
    cle: j.cle, nature: j.nature, libelle: j.libelle, reference: j.reference, montant: j.montant,
    categorie: nomCat.get(j.categoryId ?? "") ?? "—", date: j.date.toISOString(),
    decision: j.verdict.raison === "ABSENTE_GARDEE" ? "GARDER" : j.verdict.raison === "ABSENTE_SORTIE" ? "SORTIR" : null,
    raison: LIBELLE_RAISON[j.verdict.raison],
  };
}

// ─────────────────────────────── 5. Écrire le lot — d'un bloc ───────────────────────────────

const COLONNE_PARENT: Record<TypeDemandeIntegree, string> = {
  SPONSORING: "sponsoringId", CONGRESS_NATIONAL: "congressNationalId", CONGRESS_INTERNATIONAL: "congressInternationalId",
  EVENT: "eventId", TRAINING: "trainingId", PROMO_MATERIAL: "promoMaterialParentId", MEDICAL_INFO_DECLARATION: "declarationInfoMedId",
};
export const colonneParent = (t: TypeDemandeIntegree) => COLONNE_PARENT[t];

async function prochaineRef(tx: Prisma.TransactionClient, prefixe: "SPO" | "FORM" | "MP" | "DIM"): Promise<string> {
  const debut = `${prefixe}-${ANNEE_INTEGRATION}-`;
  const where = { reference: { startsWith: debut } };
  const refs = prefixe === "SPO" ? await tx.sponsoringRequest.findMany({ where, select: { reference: true } })
    : prefixe === "FORM" ? await tx.training.findMany({ where, select: { reference: true } })
      : prefixe === "MP" ? await tx.promoMaterial.findMany({ where, select: { reference: true } })
        : await tx.medicalInfoDeclaration.findMany({ where, select: { reference: true } });
  return buildRef(prefixe, ANNEE_INTEGRATION, refs.map((r) => r.reference));
}

/** Crée la demande historique d'une ligne (aucun circuit : statuts terminaux, aucune validation, aucun ordre). */
async function creerDemande(
  tx: Prisma.TransactionClient, d: DemandePrevue, userId: string, companyId: string | null,
  ctx: { promoCreees: Map<string, string>; dossierPromoDuVisa: string | null; lotId: string; categorieVisa: string | null },
): Promise<string> {
  const date = dateDeLaDepense(d.mois);
  const total = dzd(montantDeLaDemande(d));
  const note = `${"Historique 2026"} — dépense réelle intégrée du fichier « Dépenses AP » (ligne${d.lignes.length > 1 ? "s" : ""} ${d.lignes.map((l) => `L${l}`).join(" + ")}).`;
  switch (d.type) {
    case "SPONSORING": {
      const r = await tx.sponsoringRequest.create({
        data: {
          reference: await prochaineRef(tx, "SPO"), companyId, requestDate: date, institution: d.libelle, city: d.lieu, type: d.sousType,
          description: note, amountRequested: total, amountProposed: total, amountGranted: total, status: "CLOSED", nature: "DIRECT",
          validationDate: date, finalAt: date, closedAt: date, closingNote: note, finalDecision: note, createdById: userId, updatedById: userId,
        },
        select: { id: true },
      });
      return r.id;
    }
    case "CONGRESS_NATIONAL": {
      const r = await tx.congressNational.create({
        data: {
          name: d.libelle, companyId, city: d.lieu, country: "Algérie", date, status: "COMPLETED", requestStatus: "COMPLETED",
          estimatedBudget: total, finalAmount: total, budget: total, finalAt: date, finalNote: note, createdById: userId, updatedById: userId,
        },
        select: { id: true },
      });
      return r.id;
    }
    case "CONGRESS_INTERNATIONAL": {
      const r = await tx.congressInternational.create({
        data: {
          name: d.libelle, companyId, city: d.lieu, startDate: date, status: "COMPLETED", requestStatus: "COMPLETED",
          estimatedBudget: total, finalAmount: total, actualBudget: total, finalAt: date, finalNote: note, createdById: userId, updatedById: userId,
        },
        select: { id: true },
      });
      return r.id;
    }
    case "EVENT": {
      const r = await tx.event.create({
        data: {
          name: d.libelle, companyId, type: d.typeEvenement ?? "OTHER", status: "COMPLETED", requestStatus: "COMPLETED", startDate: date,
          city: d.lieu, description: note, estimatedBudget: total, finalAmount: total, finalAt: date, finalNote: note, createdById: userId,
        },
        select: { id: true },
      });
      return r.id;
    }
    case "TRAINING": {
      const r = await tx.training.create({
        data: {
          reference: await prochaineRef(tx, "FORM"), companyId, title: d.libelle, origin: "HR", status: "DONE", stage: "DONE",
          description: note, startDate: date, endDate: date, amount: total, amountGranted: total, createdById: userId,
        },
        select: { id: true },
      });
      return r.id;
    }
    case "PROMO_MATERIAL": {
      const r = await tx.promoMaterial.create({
        data: {
          reference: await prochaineRef(tx, "MP"), companyId, title: d.libelle, description: note, status: "SETTLED", circuitState: "COMPLETED",
          chosenAmount: total, amount: total, paymentDoneAt: date, createdById: userId, updatedById: userId,
        },
        select: { id: true },
      });
      ctx.promoCreees.set(d.cle, r.id);
      return r.id;
    }
    case "MEDICAL_INFO_DECLARATION": {
      // LE VISA DE PUBLICITÉ : une déclaration d'information médicale de type « visa publicitaire », validée, avec son bon
      // de versement PAYÉ. Rattachée au dossier promotionnel qu'elle couvre quand il est choisi.
      const couvert = ctx.dossierPromoDuVisa?.startsWith("lot:") ? ctx.promoCreees.get(ctx.dossierPromoDuVisa.slice(4)) ?? null : ctx.dossierPromoDuVisa ?? null;
      const libre = couvert ? (await tx.medicalInfoDeclaration.count({ where: { sourceType: "PROMO_MATERIAL", sourceId: couvert } })) === 0 : false;
      const r = await tx.medicalInfoDeclaration.create({
        data: {
          reference: await prochaineRef(tx, "DIM"), companyId,
          sourceType: libre && couvert ? "PROMO_MATERIAL" : "MEDICAL_INFO_DECLARATION",
          sourceId: libre && couvert ? couvert : `integration_${ctx.lotId}_L${d.ligne}`,
          label: d.libelle, declarationKind: "AD_VISA", status: "VALIDATED", amount: total, budgetCategoryId: ctx.categorieVisa,
          authorityNotes: note, validatedAt: date, pharmacistValidatedAt: date, createdById: userId,
          slips: { create: [{ label: "Bon de versement — visa de publicité", amount: total, note: "Payé — Historique 2026 (quittance en pièce jointe).", deliveredAt: date, deliveredById: userId, deliveryNote: note }] },
        },
        select: { id: true },
      });
      return r.id;
    }
  }
}

const NATURE_KIND: Record<PostePrevu["nature"], AdProItemKind> = {
  ASSOCIATION_SUPPORT: "ASSOCIATION_SUPPORT", SYMPOSIUM: "SYMPOSIUM", TICKETING: "TICKETING", ACCOMMODATION: "ACCOMMODATION",
  TRAVEL: "TRAVEL", SERVICE: "SERVICE", CATERING: "CATERING", PRINTING: "PRINTING", VENUE: "VENUE", OTHER: "OTHER",
};

export interface ResultatEcriture { lotId: string; demandes: number; creees: number; completees: number; total: number }

/**
 * ÉCRIRE LE LOT — UNE transaction : le lot, les catégories manquantes (allouées à 0), chaque demande créée ou complétée,
 * ses postes historiques, ses pièces attendues, les choix « garder / sortir ». Tout passe, ou rien. Le fichier est relu et
 * recontrôlé par l'appelant juste avant (jamais un plan venu du navigateur).
 */
export async function ecrireLot(user: SessionUser, plan: PlanIntegration, fichier: { nom: string; sha256: string }, entree: EntreeIntegration): Promise<{ ok: true; resultat: ResultatEcriture } | { ok: false; erreur: string }> {
  const env = await prisma.budgetEnvelope.findUnique({ where: { id: entree.envelopeId }, select: { id: true, name: true, companyId: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true, domaine: true } });
  if (!env || !canManageEnvelope(user, env)) return { ok: false, erreur: "Enveloppe introuvable, ou vous ne la gérez pas." };
  if (env.domaine !== "MARKETING") return { ok: false, erreur: "L'intégration Ad & Pro se pose sur une enveloppe Budget Marketing." };
  if (plan.totalCentimes !== TOTAL_ATTENDU_CENTIMES) return { ok: false, erreur: "Le total ne tombe pas au centime : rien n'est écrit." };
  const choix = new Map(entree.choix.map((c) => [c.cle, c]));
  for (const d of plan.demandes) if (!choix.has(d.cle)) return { ok: false, erreur: `La ligne L${d.ligne} (${d.libelle}) n'a pas de choix : compléter une demande, ou la créer.` };
  // Une demande ne se complète qu'une fois dans le même lot.
  const vus = new Set<string>();
  for (const c of entree.choix) if (c.mode === "COMPLETEE") {
    const k = `${c.type}:${c.demandeId}`;
    if (vus.has(k)) return { ok: false, erreur: "Une même demande est choisie pour deux lignes du fichier." };
    vus.add(k);
  }
  const ov = await getBudgetOverview(user, env.id, null, null, { portee: "MARKETING" });
  if (!ov) return { ok: false, erreur: "Enveloppe illisible pour vous." };
  const instantaneAvant = { categories: ov.categories.map((c) => ({ id: c.id, nom: c.name, parentId: c.parentId, alloue: c.allocated, consomme: c.consumed, engage: c.committed })), consomme: ov.totals.consumed, engage: ov.totals.committed, le: new Date().toISOString() };
  const connues = entree.rattacherConnues === false ? {} : await piecesConnuesDuPlan(plan);
  const ecritures = await ecrituresIndiquees(plan);

  try {
    const resultat = await prisma.$transaction(async (tx) => {
      // Le lot d'abord (l'index partiel refuse un second lot actif, même simultané).
      const lot = await tx.adProIntegrationLot.create({
        data: {
          envelopeId: env.id, configVersion: VERSION_INTEGRATION_2026, fichierNom: fichier.nom, fichierSha256: fichier.sha256,
          total: dzd(plan.totalCentimes), creeParId: user.id, instantaneAvant: instantaneAvant as Prisma.InputJsonValue, lignes: [] as Prisma.InputJsonValue,
        },
        select: { id: true, integreLe: true },
      });
      // Les catégories manquantes, allouées à 0 (les montants ALLOUÉS existants ne bougent pas).
      const corr = await correspondanceCategories(env.id, tx);
      const creees: string[] = [];
      for (const k of CATEGORIES_2026) if (!corr.categories[k].id) {
        const c = await tx.budgetCategoryLine.create({ data: { envelopeId: env.id, name: k, allocated: 0, notes: "Créée par l'intégration des dépenses réelles Ad & Pro 2026 (allouée à 0)." }, select: { id: true } });
        corr.categories[k] = { id: c.id, nom: k }; creees.push(c.id);
      }
      for (const s of SOUS_CATEGORIES_EVENEMENTS) if (!corr.sousCategories[s].id) {
        const c = await tx.budgetCategoryLine.create({ data: { envelopeId: env.id, parentId: corr.categories["Événements"].id, name: s, allocated: 0, notes: "Créée par l'intégration des dépenses réelles Ad & Pro 2026 (allouée à 0)." }, select: { id: true } });
        corr.sousCategories[s] = { id: c.id, nom: s }; creees.push(c.id);
      }

      const ctxCreation = { promoCreees: new Map<string, string>(), dossierPromoDuVisa: entree.dossierPromoDuVisa ?? null, lotId: lot.id, categorieVisa: corr.categories["Matériel promotionnel"].id };
      // Les dossiers promotionnels avant la déclaration du visa (elle peut se rattacher à l'un d'eux, créé par ce lot).
      const ordre = [...plan.demandes].sort((a, b) => Number(a.type === "MEDICAL_INFO_DECLARATION") - Number(b.type === "MEDICAL_INFO_DECLARATION"));
      let nbCreees = 0, nbCompletees = 0;
      const journal: unknown[] = [];
      for (const d of ordre) {
        const c = choix.get(d.cle)!;
        const date = dateDeLaDepense(d.mois);
        let type: TypeDemandeIntegree = d.type;
        let demandeId: string;
        let repris: (string | null)[] = d.postes.map(() => null);
        if (c.mode === "CREEE") {
          demandeId = await creerDemande(tx, d, user.id, env.companyId, ctxCreation);
          nbCreees++;
        } else {
          type = c.type; demandeId = c.demandeId;
          const existe = await existeDemande(tx, type, demandeId);
          if (!existe) throw new ErreurIntegration(`La demande choisie pour L${d.ligne} (${d.libelle}) n'existe plus.`);
          const deja = await tx.adProIntegrationDemande.count({ where: { demandeType: type, demandeId, lot: { annuleLe: null } } });
          if (deja) throw new ErreurIntegration(`La demande choisie pour L${d.ligne} est déjà portée par un lot actif.`);
          repris = apparierPostes(d.postes, await postesDeLaDemande(tx, type, demandeId), c.posteRepere ?? null);
          nbCompletees++;
        }
        const postes: { id: string; repris: boolean }[] = [];
        for (const [i, p] of d.postes.entries()) {
          const cat = idImputation(corr, p);
          const histo = { historiqueLotId: lot.id, historiqueLigne: p.ligne, montantPayeHistorique: dzd(p.montant), historiquePayeLe: date, budgetCategoryId: cat };
          const existant = repris[i];
          if (existant) {
            const avant = await tx.adProItem.findUniqueOrThrow({ where: { id: existant }, select: { budgetCategoryId: true, montantPayeHistorique: true } });
            // Conditionnel : un poste devenu historique entre-temps (un autre lot, un double clic) n'est pas repris deux fois.
            const n = await tx.adProItem.updateMany({
              where: { id: existant, montantPayeHistorique: null },
              data: { ...histo, historiqueAvant: { budgetCategoryId: avant.budgetCategoryId } as Prisma.InputJsonValue, updatedById: user.id },
            });
            if (n.count !== 1) throw new ErreurIntegration(`Le poste repris pour L${p.ligne} est déjà historique.`);
            postes.push({ id: existant, repris: true });
          } else {
            const cree = await tx.adProItem.create({
              data: {
                [colonneParent(type)]: demandeId,
                kind: NATURE_KIND[p.nature], label: p.libelle, supplier: p.fournisseur ?? null,
                amountEstimated: dzd(p.montant), amountGranted: dzd(p.montant), status: "APPROVED", decidedAt: date,
                decisionNote: "Historique 2026 — payé, intégré du fichier (aucun circuit).", position: i, createdById: user.id, updatedById: user.id,
                ...histo,
              } as Prisma.AdProItemUncheckedCreateInput,
              select: { id: true },
            });
            postes.push({ id: cree.id, repris: false });
          }
        }
        const rattachees = (connues[d.cle] ?? []).map((r) => ({ cle: r.cle, documentId: r.documentId, nom: r.nom, le: new Date().toISOString(), parId: user.id, source: `LEGAL:${r.legalDocumentId}` }));
        await tx.adProIntegrationDemande.create({
          data: {
            lotId: lot.id, ligne: d.ligne, lignes: [...d.lignes], libelle: d.libelle, demandeType: type, demandeId, mode: c.mode,
            demandeurAffiche: c.mode === "CREEE" ? DEMANDEUR_AFFICHE : null, montant: dzd(montantDeLaDemande(d)),
            piecesAttendues: d.piecesAttendues.map((p) => ({ ...p })) as Prisma.InputJsonValue,
            piecesRattachees: rattachees as Prisma.InputJsonValue,
            ecritureId: ecritures[d.cle] ?? null,
            avant: c.mode === "COMPLETEE" ? ({ postesRepris: postes.filter((p) => p.repris).map((p) => p.id), postesCrees: postes.filter((p) => !p.repris).map((p) => p.id) } as Prisma.InputJsonValue) : undefined,
          },
        });
        journal.push({ cle: d.cle, ligne: d.ligne, lignes: d.lignes, type, demandeId, mode: c.mode, postes });
      }
      for (const dec of entree.decisions) {
        await tx.adProIntegrationDecision.create({ data: { lotId: lot.id, cleSource: dec.cleSource, decision: dec.decision, libelle: dec.cleSource, montant: 0, decideParId: user.id } });
      }
      await tx.adProIntegrationLot.update({ where: { id: lot.id }, data: { lignes: { version: VERSION_INTEGRATION_2026, categoriesCreees: creees, demandes: journal } as Prisma.InputJsonValue } });
      return { lotId: lot.id, demandes: plan.demandes.length, creees: nbCreees, completees: nbCompletees, total: dzd(plan.totalCentimes) };
    }, { timeout: 120_000, maxWait: 20_000 });
    return { ok: true, resultat };
  } catch (err) {
    if (err instanceof ErreurIntegration) return { ok: false, erreur: err.message };
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002") {
      return { ok: false, erreur: "Un lot d'intégration est déjà validé sur cette enveloppe (validation simultanée ?) : rien n'a été écrit." };
    }
    throw err;
  }
}

class ErreurIntegration extends Error {}

async function existeDemande(tx: Prisma.TransactionClient, type: TypeDemandeIntegree, id: string): Promise<boolean> {
  switch (type) {
    case "SPONSORING": return (await tx.sponsoringRequest.count({ where: { id } })) === 1;
    case "CONGRESS_NATIONAL": return (await tx.congressNational.count({ where: { id } })) === 1;
    case "CONGRESS_INTERNATIONAL": return (await tx.congressInternational.count({ where: { id } })) === 1;
    case "EVENT": return (await tx.event.count({ where: { id } })) === 1;
    case "TRAINING": return (await tx.training.count({ where: { id } })) === 1;
    case "PROMO_MATERIAL": return (await tx.promoMaterial.count({ where: { id } })) === 1;
    case "MEDICAL_INFO_DECLARATION": return (await tx.medicalInfoDeclaration.count({ where: { id } })) === 1;
  }
}

/** L'écriture de trésorerie indiquée par la maquette (FIN-2026-119…) — RELIÉE en lecture seule, jamais touchée. */
async function ecrituresIndiquees(plan: PlanIntegration): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of plan.demandes) {
    const e = d.existant?.ecriture;
    if (!e) continue;
    const t = await prisma.financeTransaction.findUnique({ where: { reference: e.reference }, select: { id: true } });
    if (t) out[d.cle] = t.id;
  }
  return out;
}

// ─────────────────────────────── 6. Annuler — d'un bloc ───────────────────────────────

/**
 * ANNULER UN LOT : retirer les demandes historiques qu'il a créées (leurs postes partent avec elles), rendre aux postes
 * repris leur état d'avant, retirer les postes ajoutés aux demandes complétées, retirer les catégories qu'il a créées
 * si plus rien ne les porte. Les demandes non historiques ne sont jamais touchées au-delà de ce que le lot y avait mis.
 * Le lot reste, marqué annulé (date, auteur, motif) : l'historique dit ce qui a été fait et défait.
 */
export async function annulerLot(user: SessionUser, lotId: string, motif: string): Promise<{ ok: true; retirees: number; rendues: number } | { ok: false; erreur: string }> {
  const lot = await prisma.adProIntegrationLot.findUnique({ where: { id: lotId }, include: { envelope: true, demandes: true } });
  if (!lot || !canManageEnvelope(user, lot.envelope)) return { ok: false, erreur: "Lot introuvable, ou vous ne gérez pas son enveloppe." };
  if (lot.annuleLe) return { ok: false, erreur: "Ce lot est déjà annulé." };
  const categoriesCreees = (() => {
    const j = lot.lignes as { categoriesCreees?: unknown } | null;
    return Array.isArray(j?.categoriesCreees) ? (j!.categoriesCreees as unknown[]).filter((x): x is string => typeof x === "string") : [];
  })();
  let retirees = 0, rendues = 0;
  await prisma.$transaction(async (tx) => {
    // Conditionnel : deux annulations simultanées n'en font qu'une.
    const n = await tx.adProIntegrationLot.updateMany({ where: { id: lot.id, annuleLe: null }, data: { annuleLe: new Date(), annuleParId: user.id, annulationMotif: motif } });
    if (n.count !== 1) throw new ErreurIntegration("Ce lot vient d'être annulé.");
    for (const d of lot.demandes) {
      const type = d.demandeType as TypeDemandeIntegree;
      if (d.mode === "CREEE") {
        await tx.document.deleteMany({ where: { entityType: type, entityId: d.demandeId } });
        await supprimerDemande(tx, type, d.demandeId);
        retirees++;
      } else {
        const avant = (d.avant ?? {}) as { postesRepris?: string[]; postesCrees?: string[] };
        for (const id of avant.postesCrees ?? []) await tx.adProItem.deleteMany({ where: { id, historiqueLotId: lot.id } });
        for (const id of avant.postesRepris ?? []) {
          const p = await tx.adProItem.findUnique({ where: { id }, select: { historiqueAvant: true, historiqueLotId: true } });
          if (!p || p.historiqueLotId !== lot.id) continue;
          const a = (p.historiqueAvant ?? {}) as { budgetCategoryId?: string | null };
          await tx.adProItem.update({
            where: { id },
            data: { budgetCategoryId: a.budgetCategoryId ?? null, historiqueLotId: null, historiqueLigne: null, montantPayeHistorique: null, historiquePayeLe: null, historiqueAvant: undefined, updatedById: user.id },
          });
          await tx.$executeRaw`UPDATE "AdProItem" SET "historiqueAvant" = NULL WHERE "id" = ${id}`;
        }
        rendues++;
      }
    }
    // Les catégories créées par le lot : retirées seulement si plus rien ne les porte (jamais une écriture rendue orpheline).
    for (const id of categoriesCreees) {
      const [tx1, lignes, postes, ordres, sous] = await Promise.all([
        tx.financeTransaction.count({ where: { budgetCategoryId: id } }),
        tx.budgetExpenseLine.count({ where: { categoryId: id } }),
        tx.adProItem.count({ where: { budgetCategoryId: id } }),
        tx.expenseOrder.count({ where: { budgetCategoryId: id } }),
        tx.budgetCategoryLine.count({ where: { parentId: id, id: { notIn: categoriesCreees } } }),
      ]);
      if (tx1 + lignes + postes + ordres + sous === 0) await tx.budgetCategoryLine.deleteMany({ where: { id } });
    }
  }, { timeout: 120_000, maxWait: 20_000 }).catch((err) => {
    if (err instanceof ErreurIntegration) throw err;
    throw err;
  });
  return { ok: true, retirees, rendues };
}

async function supprimerDemande(tx: Prisma.TransactionClient, type: TypeDemandeIntegree, id: string): Promise<void> {
  // Les postes historiques partent avec leur demande (cascade) ; une demande créée par le lot n'a ni ordre ni écriture.
  switch (type) {
    case "SPONSORING": await tx.sponsoringRequest.deleteMany({ where: { id } }); break;
    case "CONGRESS_NATIONAL": await tx.congressNational.deleteMany({ where: { id } }); break;
    case "CONGRESS_INTERNATIONAL": await tx.congressInternational.deleteMany({ where: { id } }); break;
    case "EVENT": await tx.event.deleteMany({ where: { id } }); break;
    case "TRAINING": await tx.training.deleteMany({ where: { id } }); break;
    case "PROMO_MATERIAL": await tx.promoMaterial.deleteMany({ where: { id } }); break;
    case "MEDICAL_INFO_DECLARATION": await tx.medicalInfoDeclaration.deleteMany({ where: { id } }); break;
  }
}

// ─────────────────────────────── 7. Lire un lot ───────────────────────────────

export interface DemandeDuLot {
  id: string;
  ligne: number;
  lignes: number[];
  libelle: string;
  type: TypeDemandeIntegree;
  demandeId: string;
  mode: "CREEE" | "COMPLETEE";
  montant: number;
  href: string | null;
  attendues: number;
  manquantes: number;
  /** « Demandé par » affiché sur une demande créée par le lot (« Direction Marketing »). */
  demandeurAffiche: string | null;
}

export interface VueLot {
  id: string;
  integreLe: string;
  fichierNom: string;
  version: string;
  total: number;
  creePar: string | null;
  demandes: DemandeDuLot[];
  absentes: AbsenteVue[];
  remplacees: { cle: string; libelle: string; montant: number; raison: string }[];
  peutGerer: boolean;
}

/** Le lot actif d'une enveloppe, avec ses demandes, ses pièces manquantes et la liste « absentes du fichier ». */
export async function vueDuLot(user: SessionUser, envelopeId: string): Promise<VueLot | null> {
  const lot = await prisma.adProIntegrationLot.findFirst({ where: { envelopeId, annuleLe: null }, include: { envelope: true, demandes: { orderBy: { ligne: "asc" } } } });
  if (!lot) return null;
  const ctx = await contexteDeLEnveloppe(envelopeId);
  const catIds = ctx ? [...ctx.categories] : [];
  const [integ, eng, cats, auteur, docs] = await Promise.all([
    ctx ? consommationIntegree([ctx], catIds, lot.envelope.periodStart, lot.envelope.periodEnd) : null,
    ctx ? engagementsBruts(catIds, lot.envelope.periodEnd).then((e) => e.details) : null,
    prisma.budgetCategoryLine.findMany({ where: { envelopeId }, select: { id: true, name: true } }),
    lot.creeParId ? prisma.user.findUnique({ where: { id: lot.creeParId }, select: { name: true } }) : null,
    prisma.document.findMany({ where: { OR: lot.demandes.map((d) => ({ entityType: d.demandeType as never, entityId: d.demandeId })), stepKey: { startsWith: "integration:" } }, select: { entityId: true, stepKey: true } }),
  ]);
  const juges = ctx && eng ? await jugerEngagements([ctx], eng) : { jugees: [] as SourceJugee[] };
  const jugees = [...(integ?.jugees ?? []), ...juges.jugees];
  const nomCat = new Map(cats.map((c) => [c.id, c.name]));
  return {
    id: lot.id, integreLe: lot.integreLe.toISOString(), fichierNom: lot.fichierNom, version: lot.configVersion, total: toNumber(lot.total),
    creePar: auteur?.name ?? null,
    demandes: lot.demandes.map((d) => {
      const attendues = piecesAttenduesDe(d.piecesAttendues);
      const rattachees = piecesRattacheesDe(d.piecesRattachees);
      const fournies = new Set([
        ...docs.filter((x) => x.entityId === d.demandeId).map((x) => (x.stepKey ?? "").slice("integration:".length)),
        ...rattachees.map((r) => r.cle),
      ]);
      return {
        id: d.id, ligne: d.ligne, lignes: d.lignes, libelle: d.libelle, type: d.demandeType as TypeDemandeIntegree, demandeId: d.demandeId,
        mode: d.mode as "CREEE" | "COMPLETEE", montant: toNumber(d.montant), href: lienDemande(d.demandeType, d.demandeId),
        attendues: attendues.length, manquantes: attendues.filter((a) => !fournies.has(a.cle)).length,
        demandeurAffiche: d.demandeurAffiche,
      };
    }),
    absentes: jugees.filter((j) => estAbsenteDuFichier(j.verdict)).map((j) => vueAbsente(j, nomCat)),
    remplacees: jugees.filter((j) => !j.verdict.compte && !estAbsenteDuFichier(j.verdict)).map((j) => ({ cle: j.cle, libelle: `${j.reference} — ${j.libelle}`, montant: j.montant, raison: LIBELLE_RAISON[j.verdict.raison] })),
    peutGerer: canManageEnvelope(user, lot.envelope),
  };
}

// ─────────────────────────────── 8. Le bloc « Historique 2026 » d'une demande ───────────────────────────────

export interface PosteHistoriqueVue {
  id: string;
  libelle: string;
  montant: number;
  ligne: number | null;
  payeLe: string | null;
  imputation: string | null;
  repris: boolean;
}

export interface BlocHistorique {
  demandeRowId: string;
  lotId: string;
  mode: "CREEE" | "COMPLETEE";
  badge: boolean;
  demandeurAffiche: string | null;
  lignes: number[];
  montant: number;
  postes: PosteHistoriqueVue[];
  pieces: import("@/lib/budget-marketing/integration-vue").EtatPiece[];
  manquantes: number;
  /** L'écriture de trésorerie qui a payé la dépense (lecture seule) et l'écart avec le montant retenu. */
  ecriture: { reference: string; montant: number; date: string; ecart: number } | null;
  /** Les pièces déjà dans la plateforme, sur cette demande et ses postes — rattachables sans redépôt. */
  rattachables: { documentId: string; nom: string; ou: string }[];
  peutJoindre: boolean;
  /** La page de la demande (une formation n'a pas de fiche à elle). */
  href: string | null;
  fichesVoyageurs: boolean;
}

/** Le bloc d'une demande portée par un lot ACTIF, ou `null` (le cas de toutes les autres demandes). */
export async function blocHistoriqueDe(user: SessionUser, type: TypeDemandeIntegree, demandeId: string): Promise<BlocHistorique | null> {
  const row = await prisma.adProIntegrationDemande.findFirst({
    where: { demandeType: type, demandeId, lot: { annuleLe: null } },
    include: { lot: { include: { envelope: true } } },
  });
  if (!row) return null;
  const { etatDesPieces } = await import("@/lib/budget-marketing/integration-vue");
  const postes = await prisma.adProItem.findMany({
    where: { [colonneParent(type)]: demandeId, historiqueLotId: row.lotId },
    select: { id: true, label: true, montantPayeHistorique: true, historiqueLigne: true, historiquePayeLe: true, historiqueAvant: true, budgetCategory: { select: { name: true, parent: { select: { name: true } } } } },
    orderBy: [{ historiqueLigne: "asc" }, { position: "asc" }],
  });
  const posteIds = postes.map((p) => p.id);
  const [deposes, surPostes, piecesLegal, ecriture] = await Promise.all([
    prisma.document.findMany({ where: { entityType: type, entityId: demandeId }, select: { id: true, name: true, stepKey: true }, orderBy: { createdAt: "asc" } }),
    posteIds.length ? prisma.document.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: posteIds } }, select: { id: true, name: true } }) : [],
    posteIds.length ? prisma.adProItemPiece.findMany({ where: { itemId: { in: posteIds } }, select: { legalDocumentId: true, legalDocument: { select: { reference: true, title: true } } } }) : [],
    row.ecritureId ? prisma.financeTransaction.findUnique({ where: { id: row.ecritureId }, select: { reference: true, amount: true, date: true } }) : null,
  ]);
  const fichiersLegal = piecesLegal.length
    ? await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: piecesLegal.map((p) => p.legalDocumentId) } }, select: { id: true, name: true, entityId: true } })
    : [];
  const attendues = piecesAttenduesDe(row.piecesAttendues);
  const rattachees = piecesRattacheesDe(row.piecesRattachees);
  const etat = etatDesPieces(attendues, deposes.map((d) => ({ id: d.id, nom: d.name, stepKey: d.stepKey })), rattachees);
  const dejaRattaches = new Set(rattachees.map((r) => r.documentId));
  const montant = toNumber(row.montant);
  return {
    demandeRowId: row.id, lotId: row.lotId, mode: row.mode as "CREEE" | "COMPLETEE", badge: row.mode === "CREEE",
    demandeurAffiche: row.demandeurAffiche, lignes: row.lignes.length ? row.lignes : [row.ligne], montant,
    postes: postes.map((p) => ({
      id: p.id, libelle: p.label, montant: toNumber(p.montantPayeHistorique), ligne: p.historiqueLigne, payeLe: p.historiquePayeLe?.toISOString() ?? null,
      imputation: p.budgetCategory ? (p.budgetCategory.parent ? `${p.budgetCategory.parent.name} › ${p.budgetCategory.name}` : p.budgetCategory.name) : null,
      repris: p.historiqueAvant != null,
    })),
    pieces: etat.pieces,
    manquantes: etat.manquantes.length,
    ecriture: ecriture ? { reference: ecriture.reference, montant: toNumber(ecriture.amount), date: ecriture.date.toISOString(), ecart: Math.round((montant - toNumber(ecriture.amount)) * 100) / 100 } : null,
    rattachables: [
      ...deposes.filter((d) => !d.stepKey?.startsWith("integration:")).map((d) => ({ documentId: d.id, nom: d.name, ou: "sur la demande" })),
      ...surPostes.map((d) => ({ documentId: d.id, nom: d.name, ou: "sur un poste" })),
      ...fichiersLegal.map((d) => {
        const p = piecesLegal.find((x) => x.legalDocumentId === d.entityId);
        return { documentId: d.id, nom: d.name, ou: `au registre (${p?.legalDocument.reference ?? p?.legalDocument.title ?? "pièce du poste"})` };
      }),
    ].filter((r) => !dejaRattaches.has(r.documentId)),
    peutJoindre: await peutJoindrePieces(user, type, demandeId, row.lot.envelope),
    href: lienDemande(type, demandeId),
    fichesVoyageurs: type === "CONGRESS_INTERNATIONAL" || type === "CONGRESS_NATIONAL",
  };
}

/**
 * QUI JOINT LES PIÈCES d'une demande intégrée : qui gère l'enveloppe du lot, ou qui peut modifier la demande dans son
 * module (la même porte que la fiche).
 */
export async function peutJoindrePieces(user: SessionUser, type: TypeDemandeIntegree, demandeId: string, enveloppe: Parameters<typeof canManageEnvelope>[1]): Promise<boolean> {
  if (canManageEnvelope(user, enveloppe)) return true;
  const { canAccessEntity } = await import("@/lib/entity-access");
  return canAccessEntity(user, type, demandeId, "UPDATE").catch(() => false);
}

/** « Demandé par » d'une demande créée par un lot actif (« Direction Marketing ») — `null` pour toute autre demande. */
export async function demandeurAfficheDe(type: TypeDemandeIntegree, demandeId: string): Promise<string | null> {
  const row = await prisma.adProIntegrationDemande.findFirst({ where: { demandeType: type, demandeId, lot: { annuleLe: null } }, select: { demandeurAffiche: true } });
  return row?.demandeurAffiche ?? null;
}
