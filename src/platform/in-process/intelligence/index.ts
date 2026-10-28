/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTELLIGENCE MÉTIER, côté plateforme (mandat 4 §27) — Regulatory, Legal, Finance.
 *
 * Trois lecteurs, une forme : des SIGNAUX (`src/lib/utils/signaux.ts`) datés, gradués, qui disent
 * leur calcul. Le pont LIT l'ERP sous les droits de la personne (même porte que l'écran : entité,
 * lecteurs désignés, gammes, enveloppes ouvertes) et applique des règles PURES :
 *   - Legal    → `lib/legal/clauses.ts`   (clauses, obligations datées, comparaison d'avenants, risques)
 *   - Finance  → `lib/finance/intelligence.ts` (rythme budgétaire, projection, justificatifs, échéances)
 *   - Regulatory → règles de ce fichier sur les étapes, dépôts, réserves, fournisseurs, obligations.
 *
 * Rien n'est inventé : un contrat sans texte indexé n'a pas de clauses (« sans texte »), une
 * enveloppe sans prévision déclarée n'a pas de signal de prévision. Le texte des contrats reste
 * une DONNÉE : le pont n'en fait jamais une instruction.
 *
 * Adam y accède par `lib/assistant/intelligence-tools.ts`, la boîte de décision par
 * `in-process/inbox/compose.ts`, le battement par `mettreEnCacheClausesSiDu` (clauses pré-lues la
 * nuit, relues à la volée sinon — bornées).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { ordresAvecFacture } from "@/lib/finance/facture-ordre";
import { userCan, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { expiryLevel, type LegalStatus } from "@/lib/legal/lifecycle";
import { amountDrift } from "@/lib/legal/chain";
import { comparerClauses, extraireClauses, obligationsDe, risquesDe, LIBELLE_CLAUSE, type Clause } from "@/lib/legal/clauses";
import { echeancesPaiement, justificatifsManquants, signauxBudget, type EnveloppeLue } from "@/lib/finance/intelligence";
import { getBudgetOverview, getEnvelopes } from "@/lib/queries/budget";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { submissionReadiness } from "@/lib/regulatory/intelligence/lifecycle";
import { enabledRegCompanyIds, regCan } from "@/lib/regulatory/intelligence/access";
import { toNumber, formatMontant } from "@/lib/utils";
import type { PaymentRequestStatus, RegDossierStatus } from "@prisma/client";
import { graviteParJours, isoJour, joursEntre, resumerSignaux, trierSignaux, type DomaineSignal, type Gravite, type Signal } from "@/lib/utils/signaux";

// Le PONT réexporte le vocabulaire du socle pour qu'Adam le consomme sans traverser la
// frontière — `gesteDuTour` et `isoJour` rejoignent la liste pour le prochain geste (§118.126) :
// le cliquet a compté 429 pour un plafond de 428 sur un import direct depuis `lib/assistant.ts`,
// et le remède n'est jamais de relever le plafond (§118.72, §118.114) — c'est de passer par la
// porte qui existe déjà, celle que `intelligence-tools.ts` emprunte depuis le début.
export { LIBELLE_GRAVITE, RANG_GRAVITE, gesteDuTour, isoJour, resumerSignaux, trierSignaux, type DomaineSignal, type GesteDuSignal, type Gravite, type Signal } from "@/lib/utils/signaux";
export { LIBELLE_CLAUSE, type Clause, type Obligation, type TypeClause } from "@/lib/legal/clauses";

// ─────────────────────────── Droits — la même porte que l'écran ───────────────────────────

export const peutLireLegal = (u: SessionUser): boolean => userCan(u, "LEGAL", "VIEW");
export const peutLireFinance = (u: SessionUser): boolean => userCan(u, "FINANCES", "VIEW") || userCan(u, "BUDGETS", "VIEW");
export const peutLireRegulatory = (u: SessionUser): boolean => userCan(u, "REGULATORY", "VIEW");

/** Ce qu'une lecture rend : les signaux triés, le résumé, la portée lue et ce qu'on n'a PAS pu lire. */
export interface LectureIntelligence {
  domaine: DomaineSignal;
  signaux: Signal[];
  resume: ReturnType<typeof resumerSignaux>;
  /** Ce qui a été parcouru — pour que « rien à signaler » ait un dénominateur. */
  portee: Record<string, number>;
  notes: string[];
  calculeLe: string;
  ms: number;
}

const vide = (domaine: DomaineSignal, note: string, t0: number): LectureIntelligence => ({
  domaine, signaux: [], resume: resumerSignaux([]), portee: {}, notes: [note], calculeLe: new Date().toISOString(), ms: Date.now() - t0,
});

const fr = (n: number): string => formatMontant(n);
/** Jours SIGNÉS entre aujourd'hui et une date : −15 pour « il y a 15 jours et quelques heures », jamais −16 (troncature, pas plancher). */
const joursSignes = (now: Date, d: Date): number => { const ms = d.getTime() - now.getTime(); return ms >= 0 ? Math.floor(ms / 86_400_000) : -Math.floor(-ms / 86_400_000); };
const tronquer = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ═══════════════════════════════ LEGAL ═══════════════════════════════

/** Ce que la nuit met en réserve dans `LegalDocument.custom.intelligence`. */
interface CacheClauses { versionId: string; clauses: Clause[]; calculeLe: string }

const cacheDe = (custom: unknown): CacheClauses | null => {
  if (!custom || typeof custom !== "object") return null;
  const c = (custom as { intelligence?: unknown }).intelligence;
  if (!c || typeof c !== "object") return null;
  const v = c as Partial<CacheClauses>;
  return typeof v.versionId === "string" && Array.isArray(v.clauses) ? (v as CacheClauses) : null;
};

/** Combien de contrats sans cache sont lus À LA VOLÉE par appel : le texte est déjà en base, la règle est pure, mais on borne. */
const EXTRACTIONS_A_LA_VOLEE_MAX = 12;
const DOCUMENTS_MAX = 400;

interface DocLegalLu {
  id: string; reference: string | null; title: string; kind: string; counterparty: string | null;
  startDate: Date | null; endDate: Date | null; status: string; amount: unknown; driveNodeId: string | null; custom: unknown;
  amendsId: string | null; renewedFromId: string | null;
}

/** Les clauses d'un lot de documents : cache d'abord, texte indexé ensuite (borné), sinon « sans texte ». */
async function clausesDe(docs: readonly DocLegalLu[], aLaVoleeMax = EXTRACTIONS_A_LA_VOLEE_MAX): Promise<{ parDoc: Map<string, Clause[]>; sansTexte: number; aLaVolee: number }> {
  const parDoc = new Map<string, Clause[]>();
  const aLire: DocLegalLu[] = [];
  for (const d of docs) {
    const c = cacheDe(d.custom);
    if (c) parDoc.set(d.id, c.clauses);
    else if (d.driveNodeId) aLire.push(d);
  }
  let sansTexte = docs.length - parDoc.size - aLire.length;
  let aLaVolee = 0;
  // Les plus proches de leur échéance d'abord : c'est là que les clauses comptent aujourd'hui.
  aLire.sort((a, b) => (a.endDate?.getTime() ?? Infinity) - (b.endDate?.getTime() ?? Infinity));
  const lot = aLire.slice(0, aLaVoleeMax);
  sansTexte += aLire.length - lot.length;
  if (lot.length) {
    const index = await prisma.driveTextIndex.findMany({ where: { nodeId: { in: lot.map((d) => d.driveNodeId as string) } }, select: { nodeId: true, text: true } });
    const texte = new Map(index.map((i) => [i.nodeId, i.text]));
    for (const d of lot) {
      const t = texte.get(d.driveNodeId as string);
      if (!t) { sansTexte += 1; continue; }
      parDoc.set(d.id, extraireClauses(t));
      aLaVolee += 1;
    }
  }
  return { parDoc, sansTexte, aLaVolee };
}

const GRAVITE_ECHEANCE: Record<string, Gravite | null> = { OVERDUE: "CRITIQUE", IMMINENT: "HAUTE", SOON: "NORMALE", SCHEDULED: null, NONE: null };

/** LES SIGNAUX LEGAL : échéances, obligations datées par les clauses, reconductions tacites, avenants, risques. */
export async function signauxLegal(user: SessionUser, opts: { horizonJours?: number; maintenant?: Date; filtre?: string | null; leger?: boolean } = {}): Promise<LectureIntelligence> {
  const t0 = Date.now();
  if (!peutLireLegal(user)) return vide("LEGAL", "sans droit de lecture sur le module Legal", t0);
  const now = opts.maintenant ?? new Date();
  const horizon = Math.max(7, Math.min(365, opts.horizonJours ?? 90));
  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const filtre = opts.filtre?.trim() || null;
  const where = await companyScopedWhere(user.id, {
    AND: [
      { status: "ACTIVE" as const },
      ...(lecteurs ? [lecteurs] : []),
      ...(filtre ? [{ OR: [{ title: { contains: filtre, mode: "insensitive" as const } }, { counterparty: { contains: filtre, mode: "insensitive" as const } }, { reference: { contains: filtre, mode: "insensitive" as const } }] }] : []),
    ],
  });
  const docs: DocLegalLu[] = await prisma.legalDocument.findMany({
    where,
    select: { id: true, reference: true, title: true, kind: true, counterparty: true, startDate: true, endDate: true, status: true, amount: true, driveNodeId: true, custom: true, amendsId: true, renewedFromId: true },
    orderBy: [{ endDate: "asc" }, { updatedAt: "desc" }],
    take: DOCUMENTS_MAX,
  });
  const { parDoc, sansTexte, aLaVolee } = await clausesDe(docs, opts.leger ? 0 : EXTRACTIONS_A_LA_VOLEE_MAX);
  const signaux: Signal[] = [];
  const nom = (d: DocLegalLu) => `${d.reference ? `${d.reference} — ` : ""}${d.title}${d.counterparty ? ` (${d.counterparty})` : ""}`;

  for (const d of docs) {
    const ent = { type: "LegalDocument", id: d.id, ref: d.reference ?? d.title };
    const href = `/legal/${d.id}`;
    const clauses = parDoc.get(d.id) ?? [];
    const jours = d.endDate ? joursSignes(now, d.endDate) : null;
    const niveau = expiryLevel({ status: d.status as LegalStatus, endDate: d.endDate }, now);
    const gEch = GRAVITE_ECHEANCE[niveau];
    const obligations = clauses.length ? obligationsDe(clauses, { endDate: d.endDate, titre: d.title }) : [];
    const denonciation = obligations.find((o) => o.cle === "denonciation");
    const tacite = clauses.find((c) => c.type === "RENOUVELLEMENT")?.valeurs.tacite === true;

    if (gEch && jours !== null && jours <= horizon) {
      if (niveau === "OVERDUE") {
        signaux.push({ domaine: "LEGAL", code: "contrat_echu_actif", gravite: "CRITIQUE", titre: `Échéance dépassée, toujours « en vigueur » : ${nom(d)}`, detail: `Fin le ${isoJour(d.endDate as Date)}, il y a ${-jours} j — à basculer (expiré, renouvelé) ou à prolonger.`, calcul: `fin − aujourd'hui = ${jours} j`, echeance: isoJour(d.endDate as Date), montant: toNumber(d.amount) || null, entite: ent, href, action: "Mettre à jour le statut ou enregistrer le renouvellement.", tache: true });
      } else if (!tacite) {
        signaux.push({ domaine: "LEGAL", code: "contrat_echeance", gravite: gEch, titre: `Échéance dans ${jours} j : ${nom(d)}`, detail: `Fin le ${isoJour(d.endDate as Date)}${clauses.length ? "" : " — texte non indexé : préavis et reconduction inconnus"}.`, calcul: `fin − aujourd'hui = ${jours} j`, echeance: isoJour(d.endDate as Date), montant: toNumber(d.amount) || null, entite: ent, href, action: "Décider : renouveler, renégocier ou laisser expirer." });
      }
    }
    if (denonciation && d.endDate) {
      if (denonciation.echeance) {
        const jd = joursSignes(now, new Date(denonciation.echeance));
        if (jd < 0 && (jours ?? 0) >= 0) {
          signaux.push({ domaine: "LEGAL", code: "reconduction_acquise", gravite: "HAUTE", titre: `Délai de dénonciation passé : ${nom(d)}`, detail: `${denonciation.libelle} — date limite ${denonciation.echeance} (il y a ${-jd} j). ${denonciation.sinon}`, calcul: `fin ${isoJour(d.endDate)} − préavis = ${denonciation.echeance}`, echeance: denonciation.echeance, entite: ent, href, action: "Vérifier si la dénonciation a été notifiée ; sinon la reconduction s'applique.", tache: true });
        } else if (jd >= 0 && jd <= horizon) {
          signaux.push({ domaine: "LEGAL", code: "denonciation_a_decider", gravite: graviteParJours(jd, { haute: 14, normale: 45 }), titre: `Dénoncer ou reconduire dans ${jd} j : ${nom(d)}`, detail: `${denonciation.libelle}. ${denonciation.sinon}`, calcul: `fin ${isoJour(d.endDate)} − préavis = ${denonciation.echeance}`, echeance: denonciation.echeance, entite: ent, href, action: "Décision à prendre AVANT la date limite de dénonciation, pas avant la fin du contrat." });
        }
      }
    } else if (tacite && d.endDate && jours !== null && jours >= 0 && jours <= horizon) {
      signaux.push({ domaine: "LEGAL", code: "tacite_sans_preavis", gravite: "HAUTE", titre: `Reconduction tacite sans préavis lisible : ${nom(d)}`, detail: `Le contrat se reconduit tacitement et le texte ne donne pas de préavis chiffré : la date limite de dénonciation est inconnue.`, calcul: "clause RENOUVELLEMENT tacite ∧ ¬PREAVIS", echeance: isoJour(d.endDate), entite: ent, href, action: "Relire la clause de dénonciation avec le juriste.", tache: true });
    }
    // Les obligations APRÈS TERME (confidentialité, non-concurrence, exclusivité) : elles comptent dès
    // que la fin du contrat entre dans l'horizon, et tant qu'elles courent — pas seulement à leur propre terme.
    for (const o of obligations) {
      if (o.cle === "denonciation" || !o.echeance || jours === null || jours > horizon) continue;
      const jo = joursSignes(now, new Date(o.echeance));
      if (jo < 0) continue;
      signaux.push({ domaine: "LEGAL", code: `obligation_${o.cle}`, gravite: jours < 0 ? "NORMALE" : "BASSE", titre: `${o.libelle}${jours < 0 ? " (en cours)" : ""} : ${nom(d)}`, detail: `${o.sinon} Jusqu'au ${o.echeance}.`, calcul: `depuis la fin ${isoJour(d.endDate as Date)} → ${o.echeance}`, echeance: o.echeance, entite: ent, href });
    }
    for (const r of risquesDe(clauses)) {
      signaux.push({ domaine: "LEGAL", code: `risque_${r.type.toLowerCase()}`, gravite: r.gravite === "HAUTE" ? "NORMALE" : "BASSE", titre: `Risque — ${LIBELLE_CLAUSE[r.type]} : ${nom(d)}`, detail: r.message, calcul: `clause ${LIBELLE_CLAUSE[r.type]} lue dans le texte`, echeance: d.endDate ? isoJour(d.endDate) : null, entite: ent, href });
    }
  }

  // LES AVENANTS ET RENOUVELLEMENTS se comparent en VALEURS : ce qui a changé, clause par clause.
  const parId = new Map(docs.map((d) => [d.id, d]));
  for (const d of docs) {
    const parentId = d.amendsId ?? d.renewedFromId;
    if (!parentId) continue;
    const parent = parId.get(parentId);
    const avant = parent ? parDoc.get(parent.id) : undefined;
    const apres = parDoc.get(d.id);
    if (!avant?.length || !apres?.length) continue;
    const ch = comparerClauses(avant, apres);
    if (!ch.length) continue;
    signaux.push({
      domaine: "LEGAL", code: "avenant_clauses_modifiees", gravite: ch.some((c) => c.type === "PENALITE" || c.type === "EXCLUSIVITE" || c.type === "DUREE") ? "NORMALE" : "BASSE",
      titre: `${d.amendsId ? "Avenant" : "Renouvellement"} : ${ch.length} clause(s) changée(s) — ${nom(d)}`,
      detail: ch.map((c) => `${LIBELLE_CLAUSE[c.type]} ${c.sens === "RETIREE" ? "retirée" : c.sens === "AJOUTEE" ? "ajoutée" : `${c.avant ?? "?"} → ${c.apres ?? "?"}`}`).join(" ; "),
      calcul: `comparaison des valeurs lues dans ${parent?.reference ?? parent?.title ?? "l'original"} et ${d.reference ?? d.title}`,
      entite: { type: "LegalDocument", id: d.id, ref: d.reference ?? d.title }, href: `/legal/${d.id}`,
    });
  }

  const tries = trierSignaux(signaux);
  const notes: string[] = [];
  if (sansTexte) notes.push(`${sansTexte} engagement(s) sans texte indexé : échéance lue, clauses inconnues`);
  if (aLaVolee) notes.push(`${aLaVolee} contrat(s) lu(s) à la volée (pas encore en réserve nocturne)`);
  return { domaine: "LEGAL", signaux: tries, resume: resumerSignaux(tries), portee: { engagementsActifs: docs.length, avecClauses: parDoc.size, sansTexte, horizonJours: horizon }, notes, calculeLe: now.toISOString(), ms: Date.now() - t0 };
}

// ═══════════════════════════════ FINANCE ═══════════════════════════════

const ENVELOPPES_MAX = 8;

/** LES SIGNAUX FINANCE : budgets (rythme, projection, catégories), justificatifs, échéances, factures vs BC. */
export async function signauxFinance(user: SessionUser, opts: { horizonJours?: number; maintenant?: Date; leger?: boolean } = {}): Promise<LectureIntelligence> {
  const t0 = Date.now();
  if (!peutLireFinance(user)) return vide("FINANCE", "sans droit de lecture sur les Finances ni les Budgets", t0);
  const now = opts.maintenant ?? new Date();
  const horizon = Math.max(1, Math.min(180, opts.horizonJours ?? 30));
  const signaux: Signal[] = [];
  const lus: Record<string, number> = {};
  const notes: string[] = [];

  const budgets = userCan(user, "BUDGETS", "VIEW")
    ? (async () => {
      const enveloppes = (await getEnvelopes(user)).slice(0, opts.leger ? 3 : ENVELOPPES_MAX);
      lus.enveloppes = enveloppes.length;
      const vues = await Promise.all(enveloppes.map((e) => getBudgetOverview(user, e.id).catch(() => null)));
      for (const v of vues) {
        if (!v) continue;
        const lue: EnveloppeLue = {
          id: v.envelope.id, nom: v.envelope.name, alloue: v.totals.total, consomme: v.totals.consumed, engage: v.totals.committed,
          debut: v.period.from, fin: v.period.to,
          // Une catégorie comprend ses sous-catégories (une sous-catégorie ne se rattache qu'à une catégorie de tête).
          categories: v.categories.filter((c) => !c.parentId).map((c) => ({
            id: c.id, nom: c.name, alloue: c.allocated,
            consomme: c.consumed + v.categories.filter((s) => s.parentId === c.id).reduce((a, s) => a + s.consumed, 0),
          })),
        };
        signaux.push(...signauxBudget(lue, now));
      }
      if (enveloppes.length) notes.push("aucune prévision d'atterrissage déclarée sur les enveloppes : la cohérence prévision/réel ne peut être jugée que sur le rythme");
    })()
    : Promise.resolve(void notes.push("budgets non lus : sans droit sur le module Budgets"));

  const finances = userCan(user, "FINANCES", "VIEW")
    ? (async () => {
      const [ordres, demandes, facturesSansBc, bcSansFacture, facturesChainees] = await Promise.all([
        prisma.expenseOrder.findMany({
          where: await companyScopedWhere(user.id, { status: { not: "CANCELLED" as const }, OR: [{ requiresInvoice: true }, { dueDate: { lte: new Date(now.getTime() + horizon * 86_400_000) } }] }),
          select: { id: true, reference: true, label: true, amount: true, status: true, requiresInvoice: true, paidDate: true, dueDate: true, deadlineNature: true, sourceType: true, sourceId: true },
          orderBy: [{ dueDate: "asc" }], take: 300,
        }),
        prisma.paymentRequest.findMany({
          where: await companyScopedWhere(user.id, { status: { in: ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED", "APPROVED"] as PaymentRequestStatus[] }, dueDate: { not: null, lte: new Date(now.getTime() + horizon * 86_400_000) } }),
          select: { id: true, reference: true, title: true, amount: true, status: true, dueDate: true, deadlineNature: true },
          orderBy: [{ dueDate: "asc" }], take: 300,
        }),
        prisma.legalDocument.findMany({
          where: await companyScopedWhere(user.id, { kind: "INVOICE" as const, chainFromId: null, expenseOrderId: null, status: { not: "CANCELLED" as const }, createdAt: { lt: new Date(now.getTime() - 3 * 86_400_000) } }),
          select: { id: true, reference: true, title: true, amount: true, createdAt: true, counterparty: true }, take: 100, orderBy: { createdAt: "asc" },
        }),
        prisma.legalDocument.findMany({
          where: await companyScopedWhere(user.id, { kind: "PURCHASE_ORDER" as const, status: { not: "CANCELLED" as const }, createdAt: { lt: new Date(now.getTime() - 30 * 86_400_000) }, chainNext: { none: { kind: "INVOICE" as const } } }),
          select: { id: true, reference: true, title: true, amount: true, createdAt: true, counterparty: true }, take: 100, orderBy: { createdAt: "asc" },
        }),
        prisma.legalDocument.findMany({
          where: await companyScopedWhere(user.id, { kind: "INVOICE" as const, chainFromId: { not: null }, amount: { not: null } }),
          select: { id: true, reference: true, title: true, amount: true, counterparty: true, chainFrom: { select: { id: true, reference: true, kind: true, amount: true } } }, take: 300, orderBy: { createdAt: "desc" },
        }),
      ]);
      lus.ordresDeDepense = ordres.length; lus.demandesDePaiement = demandes.length; lus.facturesChainees = facturesChainees.length;
      // La MÊME règle que le règlement (`finance/facture-ordre.ts`, §118.185) : ce signal ne lisait que
      // le registre Legal et criait « justificatif manquant » sur un ordre dont la facture était jointe.
      const liees = await ordresAvecFacture(ordres.filter((o) => o.requiresInvoice));
      signaux.push(...justificatifsManquants(ordres.filter((o) => o.requiresInvoice).map((o) => ({
        id: o.id, reference: o.reference, libelle: o.label, montant: toNumber(o.amount), statut: o.status, factureExigee: true, factureLiee: liees.has(o.id), regleLe: o.paidDate,
      }))));
      signaux.push(...echeancesPaiement([
        ...demandes.map((p) => ({ id: p.id, reference: p.reference, libelle: p.title, montant: toNumber(p.amount), statut: p.status, echeance: p.dueDate, nature: p.deadlineNature })),
        ...ordres.filter((o) => o.status === "PENDING" && o.dueDate).map((o) => ({ id: o.id, reference: o.reference, libelle: o.label, montant: toNumber(o.amount), statut: o.status, echeance: o.dueDate, nature: o.deadlineNature ?? "MODERATE" })),
      ], now, horizon).map((s) => (s.entite?.type === "PaymentRequest" && ordres.some((o) => o.id === s.entite?.id) ? { ...s, entite: { ...s.entite, type: "ExpenseOrder" }, href: `/finances/ordres-de-depense?ref=${encodeURIComponent(s.entite.ref ?? "")}` } : s)));
      for (const f of facturesSansBc) {
        const j = joursEntre(f.createdAt, now);
        signaux.push({ domaine: "FINANCE", code: "facture_sans_bc", gravite: j > 30 ? "NORMALE" : "BASSE", titre: `Facture sans bon de commande : ${f.reference ?? f.title}`, detail: `${f.title}${f.counterparty ? ` (${f.counterparty})` : ""}, déposée il y a ${j} j, sans BC chaîné ni ordre de dépense.`, calcul: "kind = INVOICE ∧ chainFrom = ∅ ∧ ordre = ∅", montant: toNumber(f.amount) || null, entite: { type: "LegalDocument", id: f.id, ref: f.reference }, href: `/legal/${f.id}`, action: "Chaîner la facture à son BC, ou justifier l'achat sans commande.", tache: true });
      }
      for (const b of bcSansFacture) {
        const j = joursEntre(b.createdAt, now);
        signaux.push({ domaine: "FINANCE", code: "bc_sans_facture", gravite: j > 90 ? "NORMALE" : "BASSE", titre: `BC sans facture depuis ${j} j : ${b.reference ?? b.title}`, detail: `${b.title}${b.counterparty ? ` (${b.counterparty})` : ""} — la facture est-elle arrivée sans être déclarée ?`, calcul: "kind = PURCHASE_ORDER ∧ aucune facture chaînée ∧ âge > 30 j", montant: toNumber(b.amount) || null, entite: { type: "LegalDocument", id: b.id, ref: b.reference }, href: `/legal/${b.id}` });
      }
      for (const f of facturesChainees) {
        const ecart = amountDrift(toNumber(f.chainFrom?.amount), toNumber(f.amount));
        if (ecart === null || Math.abs(ecart) <= 0.1) continue;
        signaux.push({ domaine: "FINANCE", code: "ecart_facture_bc", gravite: Math.abs(ecart) > 0.25 ? "HAUTE" : "NORMALE", titre: `Facture ${ecart > 0 ? "supérieure" : "inférieure"} de ${Math.round(Math.abs(ecart) * 100)} % à son ${f.chainFrom?.kind === "QUOTE" ? "devis" : "BC"} : ${f.reference ?? f.title}`, detail: `${fr(toNumber(f.amount))} DZD facturés pour ${fr(toNumber(f.chainFrom?.amount))} DZD ${f.chainFrom?.kind === "QUOTE" ? "au devis" : "commandés"} (${f.chainFrom?.reference ?? ""}).`, calcul: `(facture − amont) / amont = ${(ecart * 100).toFixed(1)} %`, montant: toNumber(f.amount) - toNumber(f.chainFrom?.amount), entite: { type: "LegalDocument", id: f.id, ref: f.reference }, href: `/legal/${f.id}`, action: "Faire justifier l'écart avant règlement.", tache: true });
      }
    })()
    : Promise.resolve(void notes.push("ordres, demandes de paiement et factures non lus : sans droit sur le module Finances"));

  await Promise.all([budgets, finances]);
  const tries = trierSignaux(signaux);
  return { domaine: "FINANCE", signaux: tries, resume: resumerSignaux(tries), portee: { ...lus, horizonJours: horizon }, notes, calculeLe: now.toISOString(), ms: Date.now() - t0 };
}

// ═══════════════════════════════ REGULATORY ═══════════════════════════════

const STATUTS_FINIS = ["DECISION_OBTAINED", "CLOSED"] as const;
const LIBELLE_STATUT: Record<string, string> = {
  PRE_SUBMISSION: "avant dépôt", IN_PREPARATION: "en préparation", SUBMITTED: "déposé", AWAITING_BV_PAYMENT: "paiement BV attendu", AWAITING_ANPP: "attente ANPP",
  RESPONDING_TO_QUERIES: "réponse aux questions", DECISION_OBTAINED: "décision obtenue", BLOCKED: "bloqué", CLOSED: "clos",
};
const SANS_ACTIVITE_JOURS = 60;
const DOSSIERS_READINESS_MAX = 25;

/** LES SIGNAUX REGULATORY : étapes bloquées ou en retard, pièces manquantes, dépôts, fournisseurs, réserves, obligations, bloqueurs de soumission. */
export async function signauxRegulatory(user: SessionUser, opts: { horizonJours?: number; maintenant?: Date; filtre?: string | null; leger?: boolean } = {}): Promise<LectureIntelligence> {
  const t0 = Date.now();
  if (!peutLireRegulatory(user)) return vide("REGULATORY", "sans droit de lecture sur le module Regulatory", t0);
  const now = opts.maintenant ?? new Date();
  const horizon = Math.max(1, Math.min(180, opts.horizonJours ?? 30));
  const filtre = opts.filtre?.trim() || null;
  const signaux: Signal[] = [];
  const notes: string[] = [];

  const produits = await prisma.regulatoryProduct.findMany({
    where: {
      AND: [
        await regulatoryVisibleWhere(user),
        { status: { notIn: [...STATUTS_FINIS] } },
        ...(filtre ? [{ OR: [{ reference: { contains: filtre, mode: "insensitive" as const } }, { dci: { contains: filtre, mode: "insensitive" as const } }, { brandName: { contains: filtre, mode: "insensitive" as const } }, { partnerLab: { contains: filtre, mode: "insensitive" as const } }] }] : []),
      ],
    },
    select: {
      id: true, reference: true, dci: true, brandName: true, status: true, priority: true, targetSubmissionDate: true, targetDate: true, updatedAt: true,
      externalDeadline: true, externalActionExpected: true, externalStatus: true, partnerLab: true,
      steps: { select: { id: true, type: true, status: true, plannedDate: true, missingDocs: true, order: true }, orderBy: { order: "asc" } },
      dossierSteps: { select: { kind: true, occurredAt: true, order: true }, orderBy: { order: "desc" }, take: 3 },
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "asc" }], take: 300,
  });

  for (const p of produits) {
    const nom = `${p.reference} — ${p.brandName ?? p.dci}`;
    const ent = { type: "RegulatoryProduct", id: p.id, ref: p.reference };
    const href = `/regulatory/${p.id}`;
    if (p.status === "BLOCKED") signaux.push({ domaine: "REGULATORY", code: "dossier_bloque", gravite: "HAUTE", titre: `Dossier bloqué : ${nom}`, detail: `Statut « bloqué » depuis la mise à jour du ${isoJour(p.updatedAt)}.`, calcul: "status = BLOCKED", entite: ent, href, action: "Nommer le blocage et son propriétaire.", tache: true });
    for (const s of p.steps) {
      if (s.status === "DONE") continue;
      const etape = String(s.type).replace(/_/g, " ").toLowerCase();
      if (s.status === "BLOCKED") signaux.push({ domaine: "REGULATORY", code: "etape_bloquee", gravite: "HAUTE", titre: `Étape bloquée — ${etape} : ${nom}`, detail: s.missingDocs ? `Pièces manquantes : ${tronquer(s.missingDocs, 160)}` : "Étape marquée bloquée.", calcul: "step.status = BLOCKED", echeance: s.plannedDate ? isoJour(s.plannedDate) : null, entite: ent, href });
      const retard = s.plannedDate ? joursEntre(s.plannedDate, now) : null;
      if (s.status === "LATE" || (retard !== null && retard > 0)) {
        const j = retard ?? 0;
        signaux.push({ domaine: "REGULATORY", code: "etape_en_retard", gravite: j > 30 ? "HAUTE" : "NORMALE", titre: `Étape en retard${j > 0 ? ` de ${j} j` : ""} — ${etape} : ${nom}`, detail: `Prévue le ${s.plannedDate ? isoJour(s.plannedDate) : "—"}, toujours « ${s.status === "LATE" ? "en retard" : s.status === "IN_PROGRESS" ? "en cours" : "non commencée"} ».${s.missingDocs ? ` Pièces manquantes : ${tronquer(s.missingDocs, 160)}.` : ""}`, calcul: s.plannedDate ? `aujourd'hui − prévue = ${j} j` : "step.status = LATE", echeance: s.plannedDate ? isoJour(s.plannedDate) : null, entite: ent, href, action: s.missingDocs ? "Obtenir les pièces manquantes, puis refixer la date." : "Refixer la date ou lever ce qui retient l'étape.", tache: true });
      } else if (s.status !== "BLOCKED" && s.missingDocs) {
        signaux.push({ domaine: "REGULATORY", code: "pieces_manquantes", gravite: "NORMALE", titre: `Pièces manquantes — ${etape} : ${nom}`, detail: tronquer(s.missingDocs, 200), calcul: "step.missingDocs ≠ ∅", echeance: s.plannedDate ? isoJour(s.plannedDate) : null, entite: ent, href, action: "Demander les pièces au partenaire (boucle fournisseur).", tache: true });
      }
    }
    if (p.targetSubmissionDate && (p.status === "PRE_SUBMISSION" || p.status === "IN_PREPARATION")) {
      const j = joursSignes(now, p.targetSubmissionDate);
      if (j < 0) signaux.push({ domaine: "REGULATORY", code: "depot_en_retard", gravite: "HAUTE", titre: `Dépôt en retard de ${-j} j : ${nom}`, detail: `Date cible de dépôt ${isoJour(p.targetSubmissionDate)}, dossier encore « ${LIBELLE_STATUT[p.status] ?? p.status} ».`, calcul: `cible − aujourd'hui = ${j} j`, echeance: isoJour(p.targetSubmissionDate), entite: ent, href, action: "Refixer la cible ou lever ce qui retient le dépôt.", tache: true });
      else if (j <= horizon) signaux.push({ domaine: "REGULATORY", code: "depot_proche", gravite: graviteParJours(j, { haute: 7, normale: horizon }), titre: `Dépôt cible dans ${j} j : ${nom}`, detail: `Dossier « ${LIBELLE_STATUT[p.status] ?? p.status} », ${p.steps.filter((s) => s.status !== "DONE").length} étape(s) restante(s).`, calcul: `cible − aujourd'hui = ${j} j`, echeance: isoJour(p.targetSubmissionDate), entite: ent, href });
    }
    if (p.externalDeadline && p.externalActionExpected) {
      const j = joursSignes(now, p.externalDeadline);
      if (j < 0) signaux.push({ domaine: "REGULATORY", code: "fournisseur_en_retard", gravite: "HAUTE", titre: `Partenaire en retard de ${-j} j : ${nom}`, detail: `Attendu : ${tronquer(p.externalActionExpected, 160)}${p.partnerLab ? ` (${p.partnerLab})` : ""}, pour le ${isoJour(p.externalDeadline)}.`, calcul: `échéance partenaire − aujourd'hui = ${j} j`, echeance: isoJour(p.externalDeadline), entite: ent, href, action: "Relancer le partenaire — jamais automatiquement.", tache: true });
      else if (j <= 7) signaux.push({ domaine: "REGULATORY", code: "fournisseur_echeance", gravite: "NORMALE", titre: `Partenaire attendu dans ${j} j : ${nom}`, detail: tronquer(p.externalActionExpected, 160), calcul: `échéance partenaire − aujourd'hui = ${j} j`, echeance: isoJour(p.externalDeadline), entite: ent, href });
    }
    if (p.status === "RESPONDING_TO_QUERIES") {
      const dernier = p.dossierSteps[0];
      if (!dernier || dernier.kind === "ANPP_RESERVES") {
        const depuis = dernier?.occurredAt ? joursEntre(dernier.occurredAt, now) : joursEntre(p.updatedAt, now);
        signaux.push({ domaine: "REGULATORY", code: "reponse_attendue", gravite: depuis > 30 ? "HAUTE" : "NORMALE", titre: `Réponse aux questions de l'agence attendue depuis ${depuis} j : ${nom}`, detail: dernier ? `Dernière étape de la frise : réserves reçues le ${dernier.occurredAt ? isoJour(dernier.occurredAt) : "—"}.` : "Aucune réponse tracée dans la frise du dossier.", calcul: "status = RESPONDING_TO_QUERIES ∧ dernière étape ≠ réponse", entite: ent, href });
      }
    }
    const inactif = joursEntre(p.updatedAt, now);
    if (inactif >= SANS_ACTIVITE_JOURS) signaux.push({ domaine: "REGULATORY", code: "dossier_sans_activite", gravite: "BASSE", titre: `Sans activité depuis ${inactif} j : ${nom}`, detail: `Statut « ${LIBELLE_STATUT[p.status] ?? p.status} », dernière mise à jour ${isoJour(p.updatedAt)}.`, calcul: `aujourd'hui − updatedAt = ${inactif} j ≥ ${SANS_ACTIVITE_JOURS}`, entite: ent, href, action: "Demander une mise à jour de statut au responsable.", tache: true });
  }

  // LES DOSSIERS DE L'ESPACE D'ANALYSE (CTD) : bloqueurs de soumission, réserves ouvertes, fournisseurs, obligations.
  let dossiersLus = 0;
  if (regCan(user, "regulatory.finding.view")) {
    const societes = await enabledRegCompanyIds();
    if (societes.length) {
      const dossiers = await prisma.regulatoryDossier.findMany({
        where: await companyScopedWhere(user.id, { companyId: { in: societes }, status: { notIn: ["ARCHIVED", "DECISION", "MAINTAINED"] as RegDossierStatus[] }, ...(filtre ? { OR: [{ reference: { contains: filtre, mode: "insensitive" as const } }, { title: { contains: filtre, mode: "insensitive" as const } }] } : {}) }),
        select: {
          id: true, reference: true, title: true, status: true, updatedAt: true,
          reserveCycles: { where: { status: "OPEN" }, select: { id: true, cycle: true, receivedAt: true, reserveType: true } },
          supplierRequests: { where: { status: "SENT" }, select: { id: true, subject: true, supplierName: true, deadline: true, sentAt: true, remindedAt: true } },
          obligations: { where: { status: { in: ["OPEN", "OVERDUE"] } }, select: { id: true, label: true, certType: true, dueDate: true } },
        },
        orderBy: { updatedAt: "asc" }, take: 100,
      });
      dossiersLus = dossiers.length;
      const readiness = await Promise.all(dossiers.filter((d) => ["ANALYSING", "IN_REVIEW", "SUPPLIER_LOOP", "READY_FOR_REVIEW"].includes(d.status)).slice(0, opts.leger ? 5 : DOSSIERS_READINESS_MAX).map(async (d) => [d.id, await submissionReadiness(d.id).catch(() => null)] as const));
      const pret = new Map(readiness);
      for (const d of dossiers) {
        const nom = `${d.reference} — ${d.title}`;
        const ent = { type: "RegulatoryDossier", id: d.id, ref: d.reference };
        const href = `/regulatory/enregistrement/analyse/${d.id}`;
        if (d.status === "ERROR") signaux.push({ domaine: "REGULATORY", code: "dossier_en_erreur", gravite: "HAUTE", titre: `Analyse en erreur : ${nom}`, detail: "Le pipeline d'analyse s'est arrêté sur une erreur ; le dossier n'avance plus.", calcul: "status = ERROR", entite: ent, href, action: "Relancer l'analyse." });
        const r = pret.get(d.id);
        if (r && r.openBlockers.length) signaux.push({ domaine: "REGULATORY", code: "bloqueurs_soumission", gravite: "HAUTE", titre: `${r.openBlockers.length} bloqueur(s) de soumission : ${nom}`, detail: tronquer(r.openBlockers.map((b) => b.title).join(" ; "), 240), calcul: `constats CRITICAL bloquants ouverts = ${r.openBlockers.length}${r.completeness !== null ? `, complétude ${Math.round(r.completeness)} %` : ""}`, entite: ent, href, action: "Lever chaque bloqueur (correction ou dérogation justifiée) avant le dépôt.", tache: true });
        for (const c of d.reserveCycles) {
          const j = joursEntre(c.receivedAt, now);
          signaux.push({ domaine: "REGULATORY", code: "reserves_sans_reponse", gravite: j > 30 ? "HAUTE" : "NORMALE", titre: `Réserves (cycle ${c.cycle}) sans réponse depuis ${j} j : ${nom}`, detail: `${c.reserveType ?? "Réserves"} reçues le ${isoJour(c.receivedAt)}.`, calcul: `aujourd'hui − réception = ${j} j`, entite: ent, href, action: "Préparer la réponse point par point.", tache: true });
        }
        for (const s of d.supplierRequests) {
          if (s.deadline && s.deadline < now) {
            const j = joursEntre(s.deadline, now);
            signaux.push({ domaine: "REGULATORY", code: "fournisseur_sans_reponse", gravite: "HAUTE", titre: `Fournisseur en retard de ${j} j : ${nom}`, detail: `${s.subject}${s.supplierName ? ` (${s.supplierName})` : ""}, échéance ${isoJour(s.deadline)}${s.remindedAt ? `, relancé le ${isoJour(s.remindedAt)}` : ", jamais relancé"}.`, calcul: `aujourd'hui − échéance = ${j} j`, echeance: isoJour(s.deadline), entite: ent, href, action: s.remindedAt ? "Escalader au partenaire." : "Relancer (brouillon prêt, envoi humain).", tache: true });
          } else if (!s.deadline && s.sentAt && joursEntre(s.sentAt, now) >= 14 && !s.remindedAt) {
            signaux.push({ domaine: "REGULATORY", code: "relance_fournisseur", gravite: "NORMALE", titre: `Demande fournisseur sans réponse depuis ${joursEntre(s.sentAt, now)} j : ${nom}`, detail: `${s.subject}${s.supplierName ? ` (${s.supplierName})` : ""}, envoyée le ${isoJour(s.sentAt)}, sans échéance ni relance.`, calcul: "envoyée ≥ 14 j ∧ ¬relancée", entite: ent, href, action: "Relancer avec une échéance.", tache: true });
          }
        }
        for (const o of d.obligations) {
          if (!o.dueDate) continue;
          const j = joursSignes(now, o.dueDate);
          if (j > horizon) continue;
          signaux.push({ domaine: "REGULATORY", code: j < 0 ? "obligation_en_retard" : "obligation_echeance", gravite: j < 0 ? "CRITIQUE" : graviteParJours(j, { haute: 7, normale: horizon }), titre: `${j < 0 ? `Obligation en retard de ${-j} j` : `Obligation dans ${j} j`} — ${o.label}${o.certType ? ` (${o.certType})` : ""} : ${nom}`, detail: `Échéance ${isoJour(o.dueDate)}.`, calcul: `échéance − aujourd'hui = ${j} j`, echeance: isoJour(o.dueDate), entite: ent, href });
        }
      }
    }
  } else notes.push("espace d'analyse des dossiers non lu : sans droit « regulatory.finding.view »");

  const tries = trierSignaux(signaux);
  return { domaine: "REGULATORY", signaux: tries, resume: resumerSignaux(tries), portee: { dossiersOuverts: produits.length, dossiersAnalyse: dossiersLus, horizonJours: horizon }, notes, calculeLe: now.toISOString(), ms: Date.now() - t0 };
}

// ═══════════════════════════════ ENSEMBLE ═══════════════════════════════

/** Les trois lectures d'un coup, chacune sous ses droits — pour la boîte de décision et « qu'est-ce qui cloche ? ». */
export async function intelligenceComplete(user: SessionUser, opts: { maintenant?: Date; leger?: boolean } = {}): Promise<{ lectures: LectureIntelligence[]; signaux: Signal[]; resume: ReturnType<typeof resumerSignaux>; ms: number }> {
  const t0 = Date.now();
  const lectures = await Promise.all([signauxRegulatory(user, opts), signauxLegal(user, opts), signauxFinance(user, opts)]);
  const signaux = trierSignaux(lectures.flatMap((l) => l.signaux));
  return { lectures, signaux, resume: resumerSignaux(signaux), ms: Date.now() - t0 };
}

// ═══════════════════════════════ LA RÉSERVE NOCTURNE DES CLAUSES ═══════════════════════════════

const HEURE_MS = 3_600_000;
let dernierCache = 0;

/**
 * ÉCRIRE LA RÉSERVE, ET ELLE SEULE.
 *
 * La réserve vit dans `custom`, à côté de ce que d'autres y écrivent — d'abord `custom.fabrique`,
 * la pièce émise par la fabrique : sa version, son historique, et la condition de version qui
 * empêche deux révisions de s'écraser (§118.194). On l'écrivait en RECOPIANT le `custom` lu au
 * début du passage (`{ ...custom, intelligence }`), jusqu'à soixante pièces plus tôt et sans
 * condition : une révision validée entre la lecture et l'écriture était DÉFAITE. `fabrique`
 * revenait à la version N pendant que le montant, le titre et le fichier Drive restaient à N+1,
 * et la révision suivante reprenait un numéro de version déjà émis — deux pièces différentes sous
 * le même numéro, l'entrée d'historique de la première effacée, aucune erreur : le registre et la
 * pièce se contredisaient en silence.
 *
 * `jsonb_set` ne touche que la clé `intelligence`, sur la valeur PRÉSENTE en base au moment de
 * l'écriture — une ligne qu'une révision tient verrouillée est relue après elle : ce que d'autres
 * ont écrit dans `custom` reste. Un `custom` qui n'est pas un objet (absent, `null`, tableau)
 * repart d'un objet vide, comme l'écriture d'avant.
 *
 * Et le SQL brut ne pose PAS `updatedAt` (`@updatedAt` est posé par le client Prisma, pas par la
 * base) — c'est voulu, et c'est la moitié qui protège. Une réserve de clauses n'est pas une
 * modification de la pièce : la dater ferait remonter chaque nuit les engagements en tête des
 * « modifiés récemment », et ferait croire au verrou de signature d'un BC
 * (`bc-signature-actions.ts`, `updatedAt: etat.majLe`) que la pièce a changé sous les yeux du
 * signataire — un refus « relisez-le » pour une pièce que personne n'a touchée.
 *
 * Rend le nombre de lignes écrites (0 si la pièce a disparu entre-temps).
 */
export async function ecrireCacheIntelligence(id: string, intelligence: unknown): Promise<number> {
  const valeur = JSON.stringify(intelligence);
  // `jsonb_set` est STRICT : un NULL en troisième argument rend NULL, et c'est la colonne ENTIÈRE
  // qui passerait à NULL — `fabrique` comprise, c'est-à-dire pire que le défaut qu'on ferme.
  // `JSON.stringify` rend `undefined` pour `undefined` ou une fonction : on n'écrit rien, et on le dit.
  if (valeur === undefined) throw new Error("Réserve des clauses : valeur non sérialisable — rien n'est écrit.");
  return prisma.$executeRaw`UPDATE "LegalDocument" SET custom = jsonb_set(CASE WHEN jsonb_typeof(custom) = 'object' THEN custom ELSE '{}'::jsonb END, '{intelligence}', ${valeur}::jsonb, true) WHERE id = ${id}`;
}

/** Lit les clauses des engagements ACTIFS dont le texte indexé a changé et les met en réserve dans `custom.intelligence`. */
export async function mettreEnCacheClauses(limite = 60): Promise<{ examines: number; misAJour: number; sansTexte: number }> {
  const docs = await prisma.legalDocument.findMany({
    where: { status: "ACTIVE", driveNodeId: { not: null } },
    select: { id: true, driveNodeId: true, custom: true },
    orderBy: { updatedAt: "desc" }, take: Math.max(1, Math.min(500, limite)),
  });
  if (!docs.length) return { examines: 0, misAJour: 0, sansTexte: 0 };
  const index = await prisma.driveTextIndex.findMany({ where: { nodeId: { in: docs.map((d) => d.driveNodeId as string) } }, select: { nodeId: true, versionId: true, text: true } });
  const parNoeud = new Map(index.map((i) => [i.nodeId, i]));
  let misAJour = 0; let sansTexte = 0;
  for (const d of docs) {
    const i = parNoeud.get(d.driveNodeId as string);
    if (!i) { sansTexte += 1; continue; }
    if (cacheDe(d.custom)?.versionId === i.versionId) continue;
    const clauses = extraireClauses(i.text).map((c) => ({ ...c, extrait: tronquer(c.extrait, 400) }));
    // `d.custom` n'a servi qu'à savoir si la réserve est à jour : il date du début du passage, et
    // le réécrire défaisait ce qui s'était écrit depuis (voir `ecrireCacheIntelligence`).
    misAJour += await ecrireCacheIntelligence(d.id, { versionId: i.versionId, clauses, calculeLe: new Date().toISOString() });
  }
  return { examines: docs.length, misAJour, sansTexte };
}

/** Une fois par jour, dans le battement — jamais dans une requête. */
export async function mettreEnCacheClausesSiDu(now: Date = new Date()): Promise<{ examines: number; misAJour: number; sansTexte: number } | null> {
  if (process.env.INTELLIGENCE_CACHE_DISABLED === "1") return null;
  if (now.getTime() - dernierCache < 24 * HEURE_MS) return null;
  dernierCache = now.getTime();
  return mettreEnCacheClauses();
}
