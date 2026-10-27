import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { clauseAImputer } from "@/lib/finance/a-imputer";
import { getBudgetOverview, getEnvelopes, type BudgetOverview } from "@/lib/queries/budget";
import { generalMeansConsumption } from "@/lib/queries/budget-general-means";
import { masseSalarialeConsumption } from "@/lib/queries/budget-operations";
import { datesReellesDesEcritures, engagementsDesCategories } from "@/lib/queries/budget-sources";
import { contextesDesCategories, jugerEcritures, jugerLignes } from "@/lib/queries/budget-integration";
import { consommationHistorique } from "@/lib/budget/integration-regle";
import { lienDemande } from "@/lib/budget-marketing/integration-vue";
import { cleMois, dansLaPeriode } from "@/lib/budget/engage";
import { NATURE_NON_RENSEIGNEE, natureDeLaDepense, natureDuPoste, repartirParNature } from "@/lib/budget/natures";
import {
  moisEntre, moisSuivantAnnee, nomComparable, roulerCategories,
  type ComparaisonN1, type DemandeRef, type DonneesMarketing, type Engagement, type Fait,
} from "@/lib/budget/marketing-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LES FAITS DE LA VUE D'ENSEMBLE (maquette validée, Direction 10/2026).
 *
 * Chaque dinar PAYÉ de l'enveloppe (et chaque dépense encore sans catégorie) devient un fait : sa catégorie de tête,
 * son mois (la date RÉELLE de la dépense), sa nature (lue sur le poste Ad & Pro ou la case de prise en charge qu'il
 * paie) et sa demande d'origine. L'engagé arrive de la même lecture que le compteur (`budget-sources.ts`). L'écran,
 * l'Excel, le PDF, le CSV et les diapositives filtrent ces mêmes faits (`budget/marketing-vue.ts`).
 *
 * L'accès à l'enveloppe est déjà vérifié par l'appelant (`getBudgetOverview` rend `null` sinon).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Reallocation { le: string; par: string | null; resume: string }

export interface RapportMarketing extends DonneesMarketing {
  reallocations: Reallocation[];
}

/** Une dépense, une ligne — pour l'Excel et le CSV. */
export interface LigneDepense {
  date: string;
  mois: string;
  reference: string;
  libelle: string;
  categorieId: string | null;
  categorie: string;
  nature: string;
  demande: string;
  origine: string;
  montant: number;
}

const TYPES_DEMANDE = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "AD_PRO_OTHER", "TRAINING", "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION"] as const;
type TypeDemande = (typeof TYPES_DEMANDE)[number];
const estTypeDemande = (t: EntityType | string | null | undefined): t is TypeDemande => t != null && (TYPES_DEMANDE as readonly string[]).includes(t);
const cleDemande = (t: TypeDemande, id: string) => `${t}:${id}`;

const LIBELLE_TYPE: Record<TypeDemande, string> = {
  SPONSORING: "Sponsoring", CONGRESS_NATIONAL: "Prise en charge nationale", CONGRESS_INTERNATIONAL: "Prise en charge internationale",
  EVENT: "Événement", AD_PRO_OTHER: "Autre demande", TRAINING: "Formation",
  PROMO_MATERIAL: "Matériel promotionnel", MEDICAL_INFO_DECLARATION: "Information médicale",
};

/** Le parent d'un poste Ad & Pro, en clé de demande. */
export function demandeDuPoste(p: {
  sponsoringId: string | null; congressNationalId: string | null; congressInternationalId: string | null; eventId: string | null; trainingId: string | null;
  /** La demande « autre » (27/10/2026, décision #17). Facultative : les lectures d'avant ne la sélectionnent pas. */
  otherRequestId?: string | null;
  /** Les deux porteurs des seuls postes HISTORIQUES (intégration Ad & Pro 2026). */
  promoMaterialParentId?: string | null; declarationInfoMedId?: string | null;
}): string | null {
  if (p.sponsoringId) return cleDemande("SPONSORING", p.sponsoringId);
  if (p.congressNationalId) return cleDemande("CONGRESS_NATIONAL", p.congressNationalId);
  if (p.congressInternationalId) return cleDemande("CONGRESS_INTERNATIONAL", p.congressInternationalId);
  if (p.eventId) return cleDemande("EVENT", p.eventId);
  if (p.otherRequestId) return cleDemande("AD_PRO_OTHER", p.otherRequestId);
  if (p.trainingId) return cleDemande("TRAINING", p.trainingId);
  if (p.promoMaterialParentId) return cleDemande("PROMO_MATERIAL", p.promoMaterialParentId);
  if (p.declarationInfoMedId) return cleDemande("MEDICAL_INFO_DECLARATION", p.declarationInfoMedId);
  return null;
}

const SELECT_PARENT = { sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true, promoMaterialParentId: true, declarationInfoMedId: true } as const;

/** Les libellés et liens des demandes, lus en lot. */
export async function libellesDesDemandes(cles: Iterable<string>): Promise<Record<string, DemandeRef>> {
  const par: Record<TypeDemande, string[]> = { SPONSORING: [], CONGRESS_NATIONAL: [], CONGRESS_INTERNATIONAL: [], EVENT: [], AD_PRO_OTHER: [], TRAINING: [], PROMO_MATERIAL: [], MEDICAL_INFO_DECLARATION: [] };
  for (const c of new Set(cles)) {
    const [t, id] = c.split(":");
    if (estTypeDemande(t) && id) par[t].push(id);
  }
  const [sp, cn, ci, ev, aut, tr, pm, dim] = await Promise.all([
    par.SPONSORING.length ? prisma.sponsoringRequest.findMany({ where: { id: { in: par.SPONSORING } }, select: { id: true, reference: true, institution: true } }) : [],
    par.CONGRESS_NATIONAL.length ? prisma.congressNational.findMany({ where: { id: { in: par.CONGRESS_NATIONAL } }, select: { id: true, name: true } }) : [],
    par.CONGRESS_INTERNATIONAL.length ? prisma.congressInternational.findMany({ where: { id: { in: par.CONGRESS_INTERNATIONAL } }, select: { id: true, name: true } }) : [],
    par.EVENT.length ? prisma.event.findMany({ where: { id: { in: par.EVENT } }, select: { id: true, name: true } }) : [],
    par.AD_PRO_OTHER.length ? prisma.adProOtherRequest.findMany({ where: { id: { in: par.AD_PRO_OTHER } }, select: { id: true, reference: true, title: true } }) : [],
    par.TRAINING.length ? prisma.training.findMany({ where: { id: { in: par.TRAINING } }, select: { id: true, title: true } }) : [],
    par.PROMO_MATERIAL.length ? prisma.promoMaterial.findMany({ where: { id: { in: par.PROMO_MATERIAL } }, select: { id: true, reference: true, title: true } }) : [],
    par.MEDICAL_INFO_DECLARATION.length ? prisma.medicalInfoDeclaration.findMany({ where: { id: { in: par.MEDICAL_INFO_DECLARATION } }, select: { id: true, reference: true, label: true } }) : [],
  ]);
  const out: Record<string, DemandeRef> = {};
  for (const s of sp) out[cleDemande("SPONSORING", s.id)] = { cle: cleDemande("SPONSORING", s.id), libelle: `${s.reference} — ${s.institution}`, href: `/sponsoring/${s.id}`, type: LIBELLE_TYPE.SPONSORING };
  for (const c of cn) out[cleDemande("CONGRESS_NATIONAL", c.id)] = { cle: cleDemande("CONGRESS_NATIONAL", c.id), libelle: c.name, href: `/congress-national/${c.id}`, type: LIBELLE_TYPE.CONGRESS_NATIONAL };
  for (const c of ci) out[cleDemande("CONGRESS_INTERNATIONAL", c.id)] = { cle: cleDemande("CONGRESS_INTERNATIONAL", c.id), libelle: c.name, href: `/congress-international/${c.id}`, type: LIBELLE_TYPE.CONGRESS_INTERNATIONAL };
  for (const e of ev) out[cleDemande("EVENT", e.id)] = { cle: cleDemande("EVENT", e.id), libelle: e.name, href: `/events/${e.id}`, type: LIBELLE_TYPE.EVENT };
  for (const o of aut) out[cleDemande("AD_PRO_OTHER", o.id)] = { cle: cleDemande("AD_PRO_OTHER", o.id), libelle: `${o.reference} — ${o.title}`, href: `/ad-pro/autres/${o.id}`, type: LIBELLE_TYPE.AD_PRO_OTHER };
  for (const t of tr) out[cleDemande("TRAINING", t.id)] = { cle: cleDemande("TRAINING", t.id), libelle: t.title, href: lienDemande("TRAINING", t.id), type: LIBELLE_TYPE.TRAINING };
  for (const m of pm) out[cleDemande("PROMO_MATERIAL", m.id)] = { cle: cleDemande("PROMO_MATERIAL", m.id), libelle: `${m.reference} — ${m.title}`, href: `/promo-material/${m.id}`, type: LIBELLE_TYPE.PROMO_MATERIAL };
  for (const d of dim) out[cleDemande("MEDICAL_INFO_DECLARATION", d.id)] = { cle: cleDemande("MEDICAL_INFO_DECLARATION", d.id), libelle: `${d.reference} — ${d.label}`, href: `/information-medicale/${d.id}`, type: LIBELLE_TYPE.MEDICAL_INFO_DECLARATION };
  return out;
}

interface Origine { nature: string | null; cases: { service: string | null; montant: number | null }[]; demande: string | null }

interface Ecriture { id: string; date: Date; createdAt: Date; amount: unknown; category: string; label: string; reference: string; budgetCategoryId: string | null }

/**
 * La nature et la demande de chaque écriture réglée, lues par l'ordre qui l'a écrite : son poste Ad & Pro, ses cases de
 * prise en charge, ou sa source. Une écriture saisie à la main n'a que sa rubrique comptable.
 */
async function originesDesEcritures(ids: readonly string[]): Promise<Map<string, Origine>> {
  const out = new Map<string, Origine>();
  if (ids.length === 0) return out;
  const ordres = await prisma.expenseOrder.findMany({ where: { transactionId: { in: [...ids] } }, select: { id: true, transactionId: true, sourceType: true, sourceId: true } });
  const ordreIds = ordres.map((o) => o.id);
  const sourcesPoste = ordres.filter((o) => o.sourceType === "AD_PRO_ITEM" && o.sourceId).map((o) => o.sourceId as string);
  const [postes, cases] = ordreIds.length
    ? await Promise.all([
        prisma.adProItem.findMany({
          where: { OR: [{ expenseOrderId: { in: ordreIds } }, ...(sourcesPoste.length ? [{ id: { in: sourcesPoste } }] : [])] },
          select: { id: true, kind: true, expenseOrderId: true, ...SELECT_PARENT },
        }),
        prisma.careCell.findMany({
          where: { expenseOrderId: { in: ordreIds } },
          select: { expenseOrderId: true, serviceKind: true, amountDzd: true, beneficiary: { select: { congressNationalId: true, congressInternationalId: true } } },
        }),
      ])
    : [[], []];
  for (const o of ordres) {
    if (!o.transactionId) continue;
    const poste = postes.find((p) => p.expenseOrderId === o.id || (o.sourceType === "AD_PRO_ITEM" && p.id === o.sourceId));
    if (poste) {
      out.set(o.transactionId, { nature: natureDuPoste(poste.kind) ?? NATURE_NON_RENSEIGNEE, cases: [], demande: demandeDuPoste(poste) });
      continue;
    }
    const sesCases = cases.filter((c) => c.expenseOrderId === o.id);
    const benef = sesCases[0]?.beneficiary;
    const demande = benef?.congressInternationalId ? cleDemande("CONGRESS_INTERNATIONAL", benef.congressInternationalId)
      : benef?.congressNationalId ? cleDemande("CONGRESS_NATIONAL", benef.congressNationalId)
        : estTypeDemande(o.sourceType) && o.sourceId ? cleDemande(o.sourceType, o.sourceId) : null;
    if (sesCases.length) {
      // Le montant n'est pas connu ici : la répartition se fait au prorata des cases, à l'appel.
      out.set(o.transactionId, { nature: null, cases: sesCases.map((c) => ({ service: c.serviceKind, montant: c.amountDzd == null ? null : toNumber(c.amountDzd) })), demande });
      continue;
    }
    out.set(o.transactionId, { nature: null, cases: [], demande });
  }
  return out;
}

/** Les faits payés de la période (et les lignes, pour les exports). */
async function faitsPayes(overview: BudgetOverview, versTete: Record<string, string>, nomTete: Map<string, string>, from: Date, to: Date, demandesVues: Set<string>): Promise<{ faits: Fait[]; lignes: Omit<LigneDepense, "demande">[]; demandeDeLigne: (string | null)[]; sans: { total: number; count: number } }> {
  const catIds = overview.categories.map((c) => c.id);
  const select = { id: true, date: true, createdAt: true, amount: true, category: true, label: true, reference: true, budgetCategoryId: true } as const;
  const aImputer = await clauseAImputer(from, to, { societeId: overview.envelope.companyId ?? null });
  const [imputees, sansCat, lignesBudget, moyens, paie] = await Promise.all([
    catIds.length
      ? prisma.financeTransaction.findMany({ where: { direction: "OUT", status: "SETTLED", budgetCategoryId: { in: catIds }, date: { gte: from, lte: to } }, select })
      : Promise.resolve([] as Ecriture[]),
    prisma.financeTransaction.findMany({ where: aImputer, select }),
    catIds.length ? prisma.budgetExpenseLine.findMany({ where: { categoryId: { in: catIds }, date: { gte: from, lte: to } }, select: { id: true, date: true, createdAt: true, amount: true, reference: true, categoryId: true } }) : Promise.resolve([]),
    generalMeansConsumption(catIds, from, to),
    masseSalarialeConsumption(overview.categories.map((c) => ({
      id: c.id, cle: c.cle ?? null, businessUnitId: c.businessUnitId ?? null,
      envelope: { id: overview.envelope.id, periodStart: new Date(overview.envelope.periodStart), periodEnd: new Date(overview.envelope.periodEnd), companyId: overview.envelope.companyId ?? null },
    })), from, to),
  ]);
  // L'INTÉGRATION DES DÉPENSES RÉELLES (Ad & Pro 2026) : la règle du lot trie les écritures et les lignes de l'enveloppe ;
  // les postes historiques s'ajoutent plus bas, à leur date et dans leur catégorie (`budget/integration-regle.ts`).
  const ctxs = await contextesDesCategories(catIds);
  const imputeesComptees = ctxs.length
    ? (await jugerEcritures(ctxs, imputees.map((e) => ({ ...e, status: "SETTLED", counterparty: null })))).comptees
    : imputees;
  const lignesComptees = ctxs.length ? jugerLignes(ctxs, lignesBudget).comptees : lignesBudget;
  const ecritures: Ecriture[] = [...imputeesComptees, ...sansCat];
  const [dates, origines] = await Promise.all([datesReellesDesEcritures(ecritures), originesDesEcritures(ecritures.map((e) => e.id))]);

  const faits: Fait[] = [];
  const lignes: Omit<LigneDepense, "demande">[] = [];
  const demandeDeLigne: (string | null)[] = [];
  const nomCat = (cat: string | null) => (cat ? nomTete.get(cat) ?? "—" : "Sans catégorie");
  const pousser = (cat: string | null, date: Date, nature: string, demande: string | null, montant: number, l: { reference: string; libelle: string; origine: string; nature?: string }) => {
    const d = dansLaPeriode(date, from, to);
    const mois = cleMois(d);
    if (demande) demandesVues.add(demande);
    faits.push({ cat, mois, nature, demande, montant });
    lignes.push({ date: d.toISOString().slice(0, 10), mois, reference: l.reference, libelle: l.libelle, categorieId: cat, categorie: nomCat(cat), nature: l.nature ?? nature, origine: l.origine, montant });
    demandeDeLigne.push(demande);
  };
  let sansTotal = 0;
  for (const e of ecritures) {
    const cat = e.budgetCategoryId ? versTete[e.budgetCategoryId] ?? null : null;
    if (e.budgetCategoryId && !cat) continue; // une écriture d'une autre enveloppe ne passe jamais ici
    const montant = toNumber(e.amount);
    if (!cat) sansTotal += montant;
    const o = origines.get(e.id);
    const date = dates.get(e.id) ?? e.date;
    const base = { reference: e.reference, libelle: e.label, origine: cat ? "Trésorerie" : "À imputer" };
    if (o && o.cases.length > 0) {
      // Cases de prise en charge : une nature par case, au prorata des montants lus.
      const reparties = repartirParNature(montant, o.cases);
      const natureLigne = reparties.length === 1 ? reparties[0].nature : reparties.map((r) => r.nature).join(" + ");
      reparties.forEach((r, i) => {
        if (i === 0) pousser(cat, date, r.nature, o.demande, r.montant, { ...base, nature: natureLigne });
        else { faits.push({ cat, mois: cleMois(dansLaPeriode(date, from, to)), nature: r.nature, demande: o.demande, montant: r.montant }); lignes[lignes.length - 1].montant += r.montant; }
      });
      continue;
    }
    const nature = o?.nature ?? natureDeLaDepense({ rubrique: e.category });
    pousser(cat, date, nature, o?.demande ?? null, montant, base);
  }
  for (const l of lignesComptees) {
    const cat = versTete[l.categoryId] ?? null;
    pousser(cat, l.date, NATURE_NON_RENSEIGNEE, null, toNumber(l.amount), { reference: l.reference, libelle: l.reference, origine: "Ligne budgétaire" });
  }
  // (a) Les postes HISTORIQUES : payés, à leur date, dans leur catégorie, nature dérivée du poste.
  for (const ctx of ctxs) {
    for (const h of consommationHistorique(ctx.postes, new Set(catIds), from, to).lignes) {
      pousser(h.categoryId ? versTete[h.categoryId] ?? null : null, h.payeLe, natureDuPoste(h.kind) ?? NATURE_NON_RENSEIGNEE, h.demande, h.montant, {
        reference: h.ligne ? `Fichier L${h.ligne}` : "Historique 2026", libelle: h.libelle, origine: "Historique 2026",
      });
    }
  }
  for (const r of moyens.rows) pousser(versTete[r.categoryId] ?? null, r.date, NATURE_NON_RENSEIGNEE, null, r.amount, { reference: "Moyens généraux", libelle: r.label, origine: "Moyens généraux" });
  for (const r of paie.rows) pousser(versTete[r.categoryId] ?? null, r.date, NATURE_NON_RENSEIGNEE, null, r.amount, { reference: "Paie", libelle: `Paie — ${r.effectif} personne${r.effectif > 1 ? "s" : ""}`, origine: "Paie" });
  return { faits, lignes, demandeDeLigne, sans: { total: sansTotal, count: sansCat.length } };
}

/** L'enveloppe marketing de l'année précédente, s'il y en a une ouverte au spectateur. */
async function enveloppePrecedente(user: SessionUser, overview: BudgetOverview): Promise<string | null> {
  const annee = new Date(overview.envelope.periodStart).getUTCFullYear();
  const candidates = (await getEnvelopes(user, { portee: "MARKETING" }))
    .filter((e) => e.id !== overview.envelope.id && new Date(e.periodStart).getUTCFullYear() === annee - 1);
  if (candidates.length === 0) return null;
  const meme = candidates.find((e) => e.businessUnitId === overview.envelope.businessUnitId && e.productId === overview.envelope.productId);
  return (meme ?? candidates[0]).id;
}

export async function rapportMarketing(user: SessionUser, overview: BudgetOverview, opts: { n1?: boolean } = {}): Promise<{ rapport: RapportMarketing; lignes: LigneDepense[] }> {
  const from = new Date(overview.period.from), to = new Date(overview.period.to);
  const { tetes, versTete } = roulerCategories(overview.categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, allocated: c.allocated, consumed: c.consumed, committed: c.committed })));
  const nomTete = new Map(tetes.map((t) => [t.id, t.nom]));
  const demandesVues = new Set<string>();
  const [payes, engage, journal] = await Promise.all([
    faitsPayes(overview, versTete, nomTete, from, to, demandesVues),
    engagementsDesCategories(overview.categories.map((c) => c.id), to),
    prisma.auditLog.findMany({
      where: { entityType: "BUDGET", entityId: overview.envelope.id, field: "reallocation" },
      orderBy: { createdAt: "desc" }, take: 10,
      select: { createdAt: true, summary: true, actor: { select: { name: true } } },
    }),
  ]);

  // L'engagé, demande par demande : le poste dit sa demande, un ordre hors poste sa source.
  const posteIds = engage.details.map((d) => d.posteId).filter((x): x is string => Boolean(x));
  const postes = posteIds.length ? await prisma.adProItem.findMany({ where: { id: { in: posteIds } }, select: { id: true, ...SELECT_PARENT } }) : [];
  const demandeDuPosteId = new Map(postes.map((p) => [p.id, demandeDuPoste(p)]));
  const engagements: Engagement[] = engage.details.map((d) => {
    const demande = d.posteId ? demandeDuPosteId.get(d.posteId) ?? null : estTypeDemande(d.sourceType) && d.sourceId ? cleDemande(d.sourceType, d.sourceId) : null;
    if (demande) demandesVues.add(demande);
    return { cat: versTete[d.categoryId] ?? null, demande, montant: d.montant };
  });
  // Ce que le compteur compte en plus (écritures « à payer » saisies à la main) reste dans sa catégorie, sans demande.
  for (const t of tetes) {
    const detail = engagements.filter((e) => e.cat === t.id).reduce((a, e) => a + e.montant, 0);
    if (t.engage - detail > 0.5) engagements.push({ cat: t.id, demande: null, montant: t.engage - detail });
  }

  const demandes = await libellesDesDemandes(demandesVues);
  const lignes: LigneDepense[] = payes.lignes.map((l, i) => {
    const d = payes.demandeDeLigne[i];
    return { ...l, demande: d ? demandes[d]?.libelle ?? "" : "" };
  });

  const moisEnveloppe = moisEntre(cleMois(new Date(overview.envelope.periodStart)), cleMois(new Date(overview.envelope.periodEnd)));

  let n1: ComparaisonN1 | null = null;
  if (opts.n1 !== false) {
    const precedente = await enveloppePrecedente(user, overview);
    const ov = precedente ? await getBudgetOverview(user, precedente, null, null, { portee: "MARKETING" }) : null;
    if (ov) {
      const avant = await rapportMarketing(user, ov, { n1: false });
      const parNom = new Map(tetes.map((t) => [nomComparable(t.nom), t.id]));
      const versCourant = (cat: string | null) => {
        if (!cat) return null;
        const nom = avant.rapport.categories.find((c) => c.id === cat)?.nom;
        return nom ? parNom.get(nomComparable(nom)) ?? null : null;
      };
      const alloueParCat: Record<string, number> = {};
      for (const c of avant.rapport.categories) {
        const id = versCourant(c.id);
        if (id) alloueParCat[id] = (alloueParCat[id] ?? 0) + c.alloue;
      }
      n1 = {
        annee: new Date(ov.envelope.periodStart).getUTCFullYear(),
        enveloppe: ov.envelope.name,
        total: ov.totals.total,
        alloueParCat,
        faits: avant.rapport.faits.filter((f) => f.cat !== null).map((f) => ({ ...f, cat: versCourant(f.cat), mois: moisSuivantAnnee(f.mois) })),
      };
    }
  }

  return {
    rapport: {
      enveloppe: { id: overview.envelope.id, nom: overview.envelope.name, total: overview.totals.total, debut: overview.envelope.periodStart, fin: overview.envelope.periodEnd },
      categories: tetes,
      sansCategorie: payes.sans,
      faits: payes.faits,
      engagements,
      demandes,
      moisEnveloppe,
      n1,
      reallocations: journal.map((j) => ({ le: j.createdAt.toISOString(), par: j.actor?.name ?? null, resume: j.summary ?? "" })),
    },
    lignes,
  };
}
