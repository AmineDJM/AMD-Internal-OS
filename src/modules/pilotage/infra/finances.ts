import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import { chargerTresorerie, santeBudget } from "@/modules/finances/api";
import { enveloppesLues, signauxFinance } from "@/platform/in-process/intelligence";
import {
  jourAlger, ligneDeSignalFinance, ligneDisponible, ligneSanteBudget, resumeFinances, type LigneSignal,
} from "../domaine/signaux";
import { ecrireSignaux } from "./ecriture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INSTANTANÉ QUOTIDIEN DES FINANCES, PAR SOCIÉTÉ (lot « mémoire ») — les signaux des finances n'étaient calculés qu'à la
 * lecture, pour Adam : aucun historique, aucune tendance. Une fois par jour, par le planificateur :
 *   • la SANTÉ de chaque enveloppe et sa PROJECTION de fin d'exercice (`santeBudget`), même saine ;
 *   • chaque signal des finances (`signauxFinance` : budgets, justificatifs manquants, échéances de paiement, factures sans
 *     BC, écarts facture/BC) rattaché à SA société par l'entité qu'il nomme ;
 *   • le DISPONIBLE de chaque société (`chargerTresorerie` : comptes − paiements autorisés) ;
 *   • un résumé par société.
 * Les MÊMES règles et lectures que la boîte de décision (§118.5) ; lues sous les droits du Super Admin (le seul lecteur
 * de ces signaux), comme les risques terrain du Pulse (`adventum/risks-plus.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Toutes les enveloppes (la boîte de décision en lit 8 pour répondre vite ; une tâche de fond n'a pas cette contrainte). */
const ENVELOPPES_MAX = 500;

async function sessionSuperAdmin(): Promise<SessionUser | null> {
  const sa = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!sa) return null;
  return { id: sa.id, role: "SUPER_ADMIN", access: await getAccess(sa.id, "SUPER_ADMIN") };
}

/** La société de chaque entité nommée par un signal — lue où elle est écrite, jamais devinée. */
async function societesDesEntites(entites: readonly { type: string; id: string }[]): Promise<Map<string, string | null>> {
  const ids = (t: string) => [...new Set(entites.filter((e) => e.type === t).map((e) => e.id))];
  const [enveloppes, categories, ordres, demandes, pieces] = await Promise.all([
    prisma.budgetEnvelope.findMany({ where: { id: { in: ids("BudgetEnvelope") } }, select: { id: true, companyId: true } }),
    prisma.budgetCategoryLine.findMany({ where: { id: { in: ids("BudgetCategoryLine") } }, select: { id: true, envelope: { select: { companyId: true } } } }),
    prisma.expenseOrder.findMany({ where: { id: { in: ids("ExpenseOrder") } }, select: { id: true, companyId: true } }),
    prisma.paymentRequest.findMany({ where: { id: { in: ids("PaymentRequest") } }, select: { id: true, companyId: true } }),
    prisma.legalDocument.findMany({ where: { id: { in: ids("LegalDocument") } }, select: { id: true, companyId: true } }),
  ]);
  const out = new Map<string, string | null>();
  for (const e of enveloppes) out.set(`BudgetEnvelope:${e.id}`, e.companyId);
  for (const c of categories) out.set(`BudgetCategoryLine:${c.id}`, c.envelope?.companyId ?? null);
  for (const o of ordres) out.set(`ExpenseOrder:${o.id}`, o.companyId);
  for (const d of demandes) out.set(`PaymentRequest:${d.id}`, d.companyId);
  for (const p of pieces) out.set(`LegalDocument:${p.id}`, p.companyId);
  return out;
}

export interface BilanInstantane { jour: string; lignes: number; societes: number; notes: string[] }

/** L'INSTANTANÉ du jour. Idempotent (même jour = mêmes lignes réécrites). */
export async function instantaneFinances(maintenant: Date = new Date()): Promise<BilanInstantane> {
  const jour = jourAlger(maintenant);
  const notes: string[] = [];
  const sa = await sessionSuperAdmin();
  if (!sa) return { jour, lignes: 0, societes: 0, notes: ["aucun Super Admin actif : rien n'est lu"] };

  const lignes: LigneSignal[] = [];
  // 1. La santé et la projection de chaque enveloppe.
  for (const e of await enveloppesLues(sa, { max: ENVELOPPES_MAX }).catch(sansBloquer("pilotage.instantaneFinances.enveloppes", []))) {
    lignes.push(ligneSanteBudget(e.lue, santeBudget(e.lue, maintenant), { jour, companyId: e.companyId, buId: e.buId, productId: e.productId }));
  }
  // 2. Les signaux des finances, chacun à sa société.
  const lecture = await signauxFinance(sa, { maintenant, horizonJours: 30 });
  notes.push(...lecture.notes);
  const societeDe = await societesDesEntites(lecture.signaux.flatMap((s) => (s.entite ? [s.entite] : [])));
  for (const s of lecture.signaux) {
    lignes.push(ligneDeSignalFinance(s, { jour, companyId: s.entite ? societeDe.get(`${s.entite.type}:${s.entite.id}`) ?? null : null }));
  }
  // 3. Le disponible de chaque société.
  const societes = await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
  for (const c of societes) {
    const t = await chargerTresorerie(sa.id, c.id).catch(sansBloquer("pilotage.instantaneFinances.tresorerie", null));
    if (t && t.comptes.length > 0) lignes.push(ligneDisponible({ disponible: t.disponible, total: t.total, autorises: t.autorises, comptes: t.comptes.length }, { jour, companyId: c.id }));
  }
  // 4. Le résumé de chaque société (et des signaux sans société, s'il y en a).
  const parSociete = new Set(lignes.map((l) => l.companyId ?? null));
  for (const companyId of parSociete) lignes.push(resumeFinances(lignes, { jour, companyId }));

  const n = await ecrireSignaux(lignes);
  return { jour, lignes: n, societes: [...parSociete].filter(Boolean).length, notes };
}
