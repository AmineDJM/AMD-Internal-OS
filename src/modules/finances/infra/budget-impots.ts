import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import {
  CATEGORIES_BUDGET_IMPOTS, CATEGORIES_MASSE_SALARIALE_IMPOTS, CODE_ENVELOPPE_IMPOTS, nomEnveloppeImpots,
  type CleLigneBudgetImpots, type CleLigneMasseSalariale,
} from "../domaine/budget-impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ S'IMPUTENT LES IMPÔTS ET COTISATIONS (Super Admin, 24/11/2026 — audit des dépenses) : deux lectures-écritures.
 *
 * 1. L'ENVELOPPE « IMPÔTS & TAXES » d'une société pour une année — trouvée, sinon ouverte d'office, sur le modèle des
 *    enveloppes de pôle (`lib/budget/enveloppes-pole.ts`) : une `BudgetEnvelope` ordinaire (domaine GENERAL), reconnue
 *    par son code `module = IMPOTS_TAXES`, ses deux lignes TVA_NETTE et IBS par leur `cle`, montants à 0.
 * 2. LES LIGNES IRG ET CNAS DE LA MASSE SALARIALE de chaque département : l'enveloppe de l'année de son PÔLE (la campagne
 *    budgétaire lie un pôle = un département à son enveloppe, `BudgetProposal.envelopeId`), au plus proche en remontant
 *    l'organigramme ; ses lignes MS_IRG et MS_CNAS y naissent à côté de la masse salariale si elles manquent. Un
 *    département sans enveloppe de pôle n'a pas de ligne : sa part reste « à classer » au règlement.
 *
 * Idempotent : une ligne qui existe (même clé, ou même nom créé à la main) n'est pas recréée ; sérialisé par société et
 * par année (deux envois simultanés n'ouvrent pas deux enveloppes). C'est l'IMPUTATION d'un ordre qui le demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les lignes reconnues d'une enveloppe, créées si elles manquent (à la racine, montants à 0). */
async function lignesDeLEnveloppe<K extends string>(envelopeId: string, modele: readonly { cle: K; nom: string }[]): Promise<Map<K, string>> {
  const existantes = await prisma.budgetCategoryLine.findMany({ where: { envelopeId, parentId: null }, select: { id: true, name: true, cle: true } });
  const out = new Map<K, string>();
  for (const c of modele) {
    const deja = existantes.find((e) => e.cle === c.cle) ?? existantes.find((e) => !e.cle && e.name === c.nom);
    if (deja) {
      // Une ligne du même nom, créée à la main, devient la ligne reconnue (sa clé), sans doublon.
      if (!deja.cle) await prisma.budgetCategoryLine.updateMany({ where: { id: deja.id, cle: null }, data: { cle: c.cle } });
      out.set(c.cle, deja.id);
      continue;
    }
    out.set(c.cle, (await prisma.budgetCategoryLine.create({ data: { envelopeId, name: c.nom, cle: c.cle, allocated: 0 }, select: { id: true } })).id);
  }
  return out;
}

export async function lignesBudgetImpots(companyId: string, date: Date, actorId: string | null): Promise<Map<CleLigneBudgetImpots, string>> {
  const annee = date.getUTCFullYear();
  return enSerie(`enveloppe-impots:${companyId}:${annee}`, async () => {
    let enveloppe = await prisma.budgetEnvelope.findFirst({
      where: { companyId, module: CODE_ENVELOPPE_IMPOTS, periodStart: { lte: date }, periodEnd: { gte: date } },
      orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
      select: { id: true },
    });
    if (!enveloppe) {
      enveloppe = await prisma.budgetEnvelope.create({
        data: {
          name: nomEnveloppeImpots(annee), companyId, module: CODE_ENVELOPPE_IMPOTS, modules: ["FINANCES_IMPOTS"], domaine: "GENERAL",
          periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59, 59)), totalAmount: 0,
          createdById: actorId,
        },
        select: { id: true },
      });
      await recordAudit({
        actorId, action: "CREATE", module: "Budgets", entityId: enveloppe.id,
        summary: `Enveloppe « ${nomEnveloppeImpots(annee)} » ouverte d'office (TVA nette, IBS) — montants à fixer par la campagne budgétaire`,
      });
    }
    return lignesDeLEnveloppe(enveloppe.id, CATEGORIES_BUDGET_IMPOTS);
  });
}

export interface LignesMasseSalariale {
  enveloppe: string;
  lignes: Map<CleLigneMasseSalariale, string>;
}

/**
 * LES LIGNES IRG / CNAS DE LA MASSE SALARIALE DE CHAQUE DÉPARTEMENT — clé : l'id du département de la fiche salarié.
 * Un département absent de la réponse n'a pas d'enveloppe de pôle couvrant la date : sa part reste à classer.
 */
export async function lignesMasseSalarialeParDepartement(
  companyId: string, date: Date, departementIds: readonly string[],
): Promise<Map<string, LignesMasseSalariale>> {
  const out = new Map<string, LignesMasseSalariale>();
  if (departementIds.length === 0) return out;
  const annee = date.getUTCFullYear();
  return enSerie(`masse-salariale-impots:${companyId}:${annee}`, async () => {
    const [departements, propositions] = await Promise.all([
      prisma.department.findMany({ select: { id: true, parentId: true } }),
      prisma.budgetProposal.findMany({ where: { envelopeId: { not: null }, departmentId: { not: null } }, select: { departmentId: true, envelopeId: true } }),
    ]);
    const enveloppes = await prisma.budgetEnvelope.findMany({
      where: {
        id: { in: propositions.map((p) => p.envelopeId!) }, isActive: true, periodStart: { lte: date }, periodEnd: { gte: date },
        OR: [{ companyId }, { companyId: null }],
      },
      select: { id: true, name: true },
    });
    const enveloppeDe = new Map(enveloppes.map((e) => [e.id, e]));
    const poleDe = new Map<string, { id: string; name: string }>();
    for (const p of propositions) {
      const e = enveloppeDe.get(p.envelopeId!);
      if (e) poleDe.set(p.departmentId!, e);
    }
    const parentDe = new Map(departements.map((d) => [d.id, d.parentId]));
    const lignesDe = new Map<string, Map<CleLigneMasseSalariale, string>>();
    for (const dep of new Set(departementIds)) {
      // Le pôle le plus proche en remontant l'organigramme (garde contre un cycle accidentel).
      let courant: string | null | undefined = dep;
      let env: { id: string; name: string } | undefined;
      for (let n = 0; courant && n < 30 && !env; n += 1) {
        env = poleDe.get(courant);
        courant = parentDe.get(courant);
      }
      if (!env) continue;
      if (!lignesDe.has(env.id)) lignesDe.set(env.id, await lignesDeLEnveloppe(env.id, CATEGORIES_MASSE_SALARIALE_IMPOTS));
      out.set(dep, { enveloppe: env.name, lignes: lignesDe.get(env.id)! });
    }
    return out;
  });
}
