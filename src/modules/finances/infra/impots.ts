import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter, rolesWithModule } from "@/lib/rbac";
import { getCompanies, predicatEntitePermise, type CompanyLite } from "@/lib/company";
import { notifyUser } from "@/lib/notify";
import {
  AUCUNE_PROPOSITION, dateEcheance, estCompositionFiscale, estPeriodiciteFiscale, etatDesOrdres, periodeCourante,
  periodeSelonAvis, propositionsDesFiches, partPatronaleDeLaFiche, rappelDu, texteEcheance,
  type CompositionFiscale, type EtatEcheance, type PeriodiciteFiscale, type PropositionsPaie, type SaisiesFiscales,
} from "../domaine/impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IMPÔTS & COTISATIONS — CE QUE L'ÉCRAN LIT, ET CE QUE LE CALENDRIER FAIT NAÎTRE (24/11/2026).
 *
 *   • les sociétés : TOUTES celles du groupe auxquelles la personne a droit (la base, jamais une liste codée) ;
 *   • les lignes, leur état LU sur l'ordre de dépense (au centre, autorisé, payé, refusé) et le motif d'un refus ;
 *   • les PROPOSITIONS de la paie : la somme des retenues FIXES que les RH ont inscrites sur chaque fiche salarié
 *     (`Employee.retIrg`, `retSS9`, `retSS35`) — la paie ne calcule ni l'IRG ni la CNAS du mois ;
 *   • le calendrier, qui fait naître les lignes de la période et le rappel J-7 (tâche planifiée).
 *
 * Pas de `"use server"` : ces fonctions ne vérifient pas qui appelle — la page et les actions l'ont fait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CHEMIN_IMPOTS = "/finances/impots-cotisations";

/** Les sociétés de la personne — toutes celles du groupe qu'elle a le droit de voir. */
export async function societesDesImpots(userId: string): Promise<CompanyLite[]> {
  const [toutes, permise] = await Promise.all([getCompanies(), predicatEntitePermise(userId)]);
  return toutes.filter((c) => permise(c.id));
}

// ── Les fiches du mois ───────────────────────────────────────────────────────────────────────

export interface FicheRetenue {
  nom: string;
  poste: string | null;
  retIrg: number | null;
  retSS9: number | null;
  retSS35: number | null;
  partPatronale: number | null;
}

export interface PaieDuMois {
  propositions: PropositionsPaie;
  fiches: FicheRetenue[];
  /** Sur quoi reposent les fiches : les salariés payés ce mois-là, ou à défaut les fiches actives de la société. */
  base: "PAIE_DU_MOIS" | "FICHES_ACTIVES" | "HORS_MOIS";
}

const dec = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

/**
 * LA TVA DU MOIS PROPOSÉE PAR LES FACTURES — la PLACE de la source (Super Admin, 24/11/2026 : la TVA de la G50 se calcule
 * depuis les factures, collectée − déductible). Le lot « tva » enregistre la TVA des factures (HT / TVA / TTC, taux) et
 * expose son calcul par société et par mois : il se branche ICI, à la fusion. Aujourd'hui aucune source : `null`, et la
 * ligne « TVA du mois » se saisit depuis la déclaration (collectée et déductible). Proposée, elle se corrige comme l'IRG,
 * l'écart tracé à l'envoi. Une source en panne ne bloque jamais la préparation : `null`.
 */
export async function prerempliTva(companyId: string, periode: string | null): Promise<number | null> {
  if (!companyId || !periode || !/^\d{4}-\d{2}$/.test(periode)) return null;
  return null;
}

/**
 * LA PAIE D'UNE SOCIÉTÉ POUR UN MOIS (`2026-11`) — les fiches des salariés qui ont une ligne de paie ce mois-là ; s'il
 * n'y en a pas encore (la paie n'est pas saisie), les fiches ACTIVES de la société. Une période qui n'est pas un mois
 * (trimestre, année) n'a pas de proposition : rien n'est multiplié ni deviné.
 */
export async function paieDuMois(companyId: string, periode: string | null): Promise<PaieDuMois> {
  const m = periode ? /^(\d{4})-(\d{2})$/.exec(periode) : null;
  if (!m) return { propositions: AUCUNE_PROPOSITION, fiches: [], base: "HORS_MOIS" };
  const tva = await prerempliTva(companyId, periode).catch(() => null);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const SELECT = { fullName: true, position: true, retIrg: true, retSS9: true, retSS35: true } as const;
  let base: PaieDuMois["base"] = "PAIE_DU_MOIS";
  let employes = await prisma.employee.findMany({
    where: { companyId, payrolls: { some: { year, month } } }, select: SELECT, orderBy: { fullName: "asc" },
  });
  if (employes.length === 0) {
    base = "FICHES_ACTIVES";
    employes = await prisma.employee.findMany({ where: { companyId, isActive: true }, select: SELECT, orderBy: { fullName: "asc" } });
  }
  const fiches = employes.map((e) => {
    const r = { retIrg: dec(e.retIrg), retSS9: dec(e.retSS9), retSS35: dec(e.retSS35) };
    return { nom: e.fullName, poste: e.position, ...r, partPatronale: partPatronaleDeLaFiche(r) };
  });
  return { propositions: { ...propositionsDesFiches(fiches), tva }, fiches, base };
}

// ── L'écran ──────────────────────────────────────────────────────────────────────────────────

export interface EcheanceVue {
  id: string;
  companyId: string;
  obligationId: string | null;
  organisme: string;
  nature: string;
  composition: CompositionFiscale;
  periode: string | null;
  periodeLibelle: string;
  echeance: string | null;
  echeanceTexte: string;
  jourAConfirmer: boolean;
  etat: EtatEcheance;
  saisies: SaisiesFiscales;
  montant: number | null;
  decomposition: { cle?: string; label: string; source: string; montant: number; propose: number | null; origine: string }[];
  justificatif: { id: string; nom: string } | null;
  quittance: { id: string; numero: string | null } | null;
  motifRefus: string | null;
  motifRefusPrecedent: string | null;
  ordre: {
    id: string; reference: string; references: string[]; demandeurId: string | null; envoyePar: string | null; envoyeLe: string | null;
    decidePar: string | null; decideLe: string | null; payeLe: string | null; payePar: string | null; compte: string | null;
    relances: number;
  } | null;
}

export interface ObligationVue {
  id: string;
  companyId: string;
  organisme: string;
  nature: string;
  composition: CompositionFiscale;
  periodicite: PeriodiciteFiscale;
  jourLimite: number | null;
  moisLimite: number | null;
  confirme: boolean;
  confirmeLe: string | null;
  confirmePar: string | null;
  rappel: boolean;
}

export interface DonneesImpots {
  societes: CompanyLite[];
  lignes: EcheanceVue[];
  calendrier: ObligationVue[];
  /** La paie de chaque (société, mois) d'une ligne à préparer — clé `companyId|2026-11`. */
  paies: Record<string, PaieDuMois>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** Les ordres d'une ligne : tous ceux de l'envoi en cours (un par ligne du budget), à défaut le principal seul. */
const idsDe = (l: { ordresIds: string[]; expenseOrderId: string | null }): string[] => (l.ordresIds.length ? l.ordresIds : l.expenseOrderId ? [l.expenseOrderId] : []);

/** TOUT CE QUE L'ÉCRAN MONTRE, pour les sociétés de la personne. */
export async function chargerImpotsCotisations(userId: string): Promise<DonneesImpots> {
  const societes = await societesDesImpots(userId);
  const ids = societes.map((s) => s.id);
  if (ids.length === 0) return { societes, lignes: [], calendrier: [], paies: {} };
  const [lignes, obligations] = await Promise.all([
    prisma.echeanceFiscale.findMany({ where: { companyId: { in: ids } }, orderBy: [{ echeance: "asc" }, { createdAt: "desc" }], take: 600 }),
    prisma.obligationFiscale.findMany({ where: { companyId: { in: ids }, retireeLe: null }, orderBy: [{ createdAt: "asc" }] }),
  ]);
  const ordreIds = lignes.flatMap(idsDe);
  const ordres = ordreIds.length
    ? await prisma.expenseOrder.findMany({
        where: { id: { in: ordreIds } },
        select: {
          id: true, reference: true, status: true, centralStatus: true, centralDecidedById: true, centralDecidedAt: true,
          paidDate: true, paidById: true, transactionId: true, requestedById: true, createdAt: true,
          centralMessages: { select: { decision: true, body: true, createdAt: true }, orderBy: { createdAt: "desc" } },
        },
      })
    : [];
  const transactions = await prisma.financeTransaction.findMany({
    where: { id: { in: ordres.map((o) => o.transactionId).filter((v): v is string => Boolean(v)) } },
    select: { id: true, reference: true, account: true, treasuryAccount: { select: { name: true } } },
  });
  const personnes = new Set<string>();
  for (const o of ordres) for (const u of [o.centralDecidedById, o.paidById, o.requestedById]) if (u) personnes.add(u);
  for (const ob of obligations) if (ob.jourConfirmeParId) personnes.add(ob.jourConfirmeParId);
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: [...personnes] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const ordreDe = new Map(ordres.map((o) => [o.id, o]));
  const transactionDe = new Map(transactions.map((t) => [t.id, t]));
  const obligationDe = new Map(obligations.map((o) => [o.id, o]));

  const vues: EcheanceVue[] = lignes.map((l) => {
    // Une G50 ventilée sur plusieurs lignes du budget a plusieurs ordres : l'état les lit TOUS ; le principal porte la
    // pièce, la quittance et le nom de qui a envoyé.
    const tous = idsDe(l).map((id) => ordreDe.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    const vivants = tous.filter((x) => x.status !== "CANCELLED");
    const o = (l.expenseOrderId ? ordreDe.get(l.expenseOrderId) : undefined) ?? vivants[0];
    const etat = etatDesOrdres(tous);
    const ob = l.obligationId ? obligationDe.get(l.obligationId) : undefined;
    const jourAConfirmer = Boolean(ob && !ob.jourConfirmeLe);
    const refus = vivants.flatMap((x) => x.centralMessages).find((m) => m.decision === "REFUSE");
    const payes = vivants.map((x) => x.paidDate).filter((d): d is Date => Boolean(d));
    const t = o?.transactionId ? transactionDe.get(o.transactionId) : undefined;
    return {
      id: l.id, companyId: l.companyId, obligationId: l.obligationId, organisme: l.organisme, nature: l.nature,
      composition: estCompositionFiscale(l.composition) ? l.composition : "MONTANT",
      periode: l.periode, periodeLibelle: l.periodeLibelle,
      echeance: iso(l.echeance), echeanceTexte: texteEcheance(l.echeance, jourAConfirmer), jourAConfirmer, etat,
      saisies: (l.saisies ?? {}) as SaisiesFiscales,
      montant: l.montant === null ? null : Number(l.montant),
      decomposition: Array.isArray(l.decomposition) ? (l.decomposition as unknown as EcheanceVue["decomposition"]) : [],
      justificatif: l.justificatifId ? { id: l.justificatifId, nom: l.justificatifNom ?? "justificatif" } : null,
      quittance: l.quittanceId ? { id: l.quittanceId, numero: l.quittanceNumero } : null,
      motifRefus: etat === "REFUSE" ? (refus?.body ?? null) : null,
      motifRefusPrecedent: l.motifRefusPrecedent,
      ordre: o ? {
        id: o.id, reference: o.reference, references: vivants.map((x) => x.reference), demandeurId: o.requestedById,
        envoyePar: o.requestedById ? noms.get(o.requestedById) ?? null : null, envoyeLe: iso(l.envoyeLe ?? o.createdAt),
        decidePar: o.centralDecidedById ? noms.get(o.centralDecidedById) ?? null : null, decideLe: iso(o.centralDecidedAt),
        payeLe: etat === "PAYE" && payes.length ? iso(new Date(Math.max(...payes.map((d) => d.getTime())))) : iso(o.paidDate), payePar: o.paidById ? noms.get(o.paidById) ?? null : null,
        compte: t ? [t.treasuryAccount?.name ?? t.account, t.reference].filter(Boolean).join(" · ") : null,
        relances: vivants.flatMap((x) => x.centralMessages).filter((m) => !m.decision && m.body.startsWith("Relance")).length,
      } : null,
    };
  });

  // La paie n'est lue que pour ce qui se PRÉPARE : une ligne envoyée garde la proposition de son envoi.
  const paies: Record<string, PaieDuMois> = {};
  for (const v of vues) {
    if (v.etat !== "A_PREPARER" || v.composition === "MONTANT") continue;
    const cle = `${v.companyId}|${v.periode ?? ""}`;
    if (!paies[cle]) paies[cle] = await paieDuMois(v.companyId, v.periode);
  }

  const calendrier: ObligationVue[] = obligations.map((o) => ({
    id: o.id, companyId: o.companyId, organisme: o.organisme, nature: o.nature,
    composition: estCompositionFiscale(o.composition) ? o.composition : "MONTANT",
    periodicite: estPeriodiciteFiscale(o.periodicite) ? o.periodicite : "MENSUELLE",
    jourLimite: o.jourLimite, moisLimite: o.moisLimite, confirme: Boolean(o.jourConfirmeLe), confirmeLe: iso(o.jourConfirmeLe),
    confirmePar: o.jourConfirmeParId ? noms.get(o.jourConfirmeParId) ?? null : null, rappel: o.rappel,
  }));
  return { societes, lignes: vues, calendrier, paies };
}

// ── Le calendrier fait naître les lignes ─────────────────────────────────────────────────────

/**
 * LES LIGNES DE LA PÉRIODE EN COURS — une par obligation active, créée une fois (clé unique obligation × période :
 * rejouer ne crée rien). « Selon avis » : une ligne à la fois — la suivante naît quand la précédente est payée.
 * Rend le nombre de lignes créées.
 */
export async function assurerLignesDuCalendrier(maintenant: Date, companyIds?: readonly string[]): Promise<number> {
  const obligations = await prisma.obligationFiscale.findMany({
    where: { retireeLe: null, ...(companyIds ? { companyId: { in: [...companyIds] } } : {}) },
  });
  let crees = 0;
  for (const o of obligations) {
    const periodicite = estPeriodiciteFiscale(o.periodicite) ? o.periodicite : "MENSUELLE";
    let cle: string;
    let libelle: string;
    let echeance: Date | null = null;
    const p = periodeCourante(periodicite, maintenant);
    if (p) {
      // Une obligation annuelle tombe au mois réglé de l'année suivante (le solde de l'IBS : avril), janvier sinon.
      const mois = periodicite === "ANNUELLE" ? o.moisLimite ?? p.echeanceMois : p.echeanceMois;
      cle = p.cle; libelle = p.libelle; echeance = dateEcheance(o.jourLimite, p.echeanceAnnee, mois);
    } else {
      const annee = maintenant.getUTCFullYear();
      const deLAnnee = await prisma.echeanceFiscale.findMany({
        where: { obligationId: o.id, periode: { startsWith: `${annee}-A` } }, select: { expenseOrderId: true, ordresIds: true },
      });
      const ouvertes = deLAnnee.filter((l) => !l.expenseOrderId);
      const enCours = deLAnnee.flatMap(idsDe);
      const nonPayes = enCours.length ? await prisma.expenseOrder.count({ where: { id: { in: enCours }, status: { notIn: ["PAID", "CANCELLED"] } } }) : 0;
      if (ouvertes.length > 0 || nonPayes > 0) continue;
      ({ cle, libelle } = periodeSelonAvis(annee, deLAnnee.length + 1));
    }
    const r = await prisma.echeanceFiscale.createMany({
      data: [{
        companyId: o.companyId, obligationId: o.id, organisme: o.organisme, nature: o.nature, composition: o.composition,
        periode: cle, periodeLibelle: libelle, echeance,
      }],
      skipDuplicates: true,
    });
    crees += r.count;
  }
  return crees;
}

// ── Le rappel avant échéance ─────────────────────────────────────────────────────────────────

/** Qui tient « Impôts & cotisations » en écriture : le défaut des rôles, plus la console (accordé ou bloqué). */
async function gestionnairesDesImpots(): Promise<string[]> {
  const [parRole, acces] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(rolesWithModule("FINANCES_IMPOTS", "UPDATE")) }, select: { id: true } }),
    prisma.userAccess.findMany({ where: { module: "FINANCES_IMPOTS" }, select: { userId: true, canView: true, canUpdate: true, user: { select: { isActive: true } } } }),
  ]);
  const ids = new Set(parRole.map((u) => u.id));
  for (const a of acces) {
    if (a.canView && a.canUpdate && a.user.isActive) ids.add(a.userId);
    else ids.delete(a.userId);
  }
  return [...ids];
}

/**
 * LE RAPPEL J-7 — une fois par ligne (`rappelEnvoyeLe`, posé AVANT d'envoyer et seulement s'il était vide : deux
 * exécutants simultanés n'envoient pas deux rappels), aux gestionnaires de la société de la ligne.
 */
export async function rappelerEcheancesFiscales(maintenant: Date): Promise<number> {
  const limite = new Date(maintenant.getTime() + 8 * 86_400_000);
  const candidates = await prisma.echeanceFiscale.findMany({
    where: { expenseOrderId: null, rappelEnvoyeLe: null, echeance: { not: null, lte: limite }, obligation: { rappel: true, retireeLe: null } },
    include: { obligation: { select: { rappel: true } }, company: { select: { name: true, shortName: true } } },
    take: 200,
  });
  if (candidates.length === 0) return 0;
  const gestionnaires = await gestionnairesDesImpots();
  const permis = new Map(await Promise.all(gestionnaires.map(async (u) => [u, await predicatEntitePermise(u)] as const)));
  let envoyes = 0;
  for (const l of candidates) {
    if (!rappelDu({ echeance: l.echeance, rappel: Boolean(l.obligation?.rappel), etat: "A_PREPARER", rappelEnvoyeLe: l.rappelEnvoyeLe, maintenant })) continue;
    const pris = await prisma.echeanceFiscale.updateMany({ where: { id: l.id, rappelEnvoyeLe: null, expenseOrderId: null }, data: { rappelEnvoyeLe: maintenant } });
    if (pris.count === 0) continue;
    envoyes += 1;
    const societe = l.company.shortName ?? l.company.name;
    for (const u of gestionnaires) {
      if (!permis.get(u)?.(l.companyId)) continue;
      await notifyUser({
        userId: u, type: "DEADLINE_NEAR",
        title: `${l.nature} — ${l.periodeLibelle} : échéance ${texteEcheance(l.echeance, false)}`,
        body: `${societe} · ${l.organisme} — la ligne est encore à préparer.`,
        link: `${CHEMIN_IMPOTS}?ligne=${l.id}`,
      });
    }
  }
  return envoyes;
}

/** La tâche planifiée : les lignes de la période, puis les rappels. Idempotente. */
export async function echeancesFiscalesDues(maintenant = new Date()): Promise<void> {
  await assurerLignesDuCalendrier(maintenant);
  await rappelerEcheancesFiscales(maintenant);
}
