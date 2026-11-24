import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { bornesDuMois, dateDeLImputation, libelleMois } from "../domaine/mois";
import {
  detailAStocker, enUsd, gesteImputation, montantDzd, repartirParSociete, versMicroUsd,
  type AppelAgrege, type GesteImputation, type RattachementPersonne, type Repartition,
} from "../domaine/imputation";
import { CLE_LIGNE_IA } from "../domaine/budget";
import { assurerDepartementInformatique } from "./departement";
import { enveloppeInformatique } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IMPUTATION MENSUELLE DU COÛT DE L'IA AU BUDGET INFORMATIQUE (Super Admin, 24/11/2026).
 *
 * Le coût mesuré (`ModelCallLog`) d'un mois, réparti par société (`repartirParSociete`), CONSOMME la ligne « Intelligence
 * artificielle (consommation) » du budget Informatique de chaque société — par une LIGNE DE DÉPENSE BUDGÉTAIRE
 * (`BudgetExpenseLine`), la même mécanique que les bons de versement saisis ou les frais de l'équipe : Budgets la compte
 * dans le consommé, sans ordre de paiement (les factures des fournisseurs d'IA suivent le circuit normal, sur « Abonnements
 * & licences »).
 *
 * IDEMPOTENTE ET RECALCULABLE : une `ImputationCoutIa` par (société, mois), qui garde sa ligne de dépense. Rejouée, elle ne
 * crée rien de plus ; un coût ou un taux changé met À JOUR la même ligne. Sérialisée par un verrou de base par (société,
 * mois) : un clic et la tâche de fond en même temps ne doublent rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface LigneBrute { userId: string | null; feature: string | null; cout: string; appels: number; sansTarif: number }

/** Les agrégats du journal sur le mois : une ligne par (personne, fonction IA). Somme exacte en base. */
export async function agregerJournalDuMois(mois: string): Promise<AppelAgrege[]> {
  const { debut, fin } = bornesDuMois(mois);
  const lignes = await prisma.$queryRaw<LigneBrute[]>`
    SELECT "userId", "feature",
           COALESCE(SUM("costUsd"), 0)::text AS "cout",
           COUNT(*)::int AS "appels",
           SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END)::int AS "sansTarif"
    FROM "ModelCallLog"
    WHERE "at" >= ${debut} AND "at" < ${fin}
    GROUP BY "userId", "feature"`;
  return lignes.map((l) => ({ userId: l.userId, feature: l.feature, coutUsd: l.cout, appels: Number(l.appels), sansTarif: Number(l.sansTarif) }));
}

/** Ce qui rattache chaque personne : la société de sa fiche, celle de son département, son département (organigramme d'abord). */
export async function rattachementsDesPersonnes(userIds: readonly string[]): Promise<Map<string, RattachementPersonne>> {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: {
      id: true,
      department: { select: { id: true, name: true, companyId: true } },
      employee: { select: { companyId: true, departmentRef: { select: { id: true, name: true, companyId: true } } } },
    },
  });
  return new Map(users.map((u) => {
    const dep = u.employee?.departmentRef ?? u.department ?? null;
    return [u.id, {
      societeEmploye: u.employee?.companyId ?? null,
      societeDepartement: dep?.companyId ?? null,
      departementId: dep?.id ?? null,
      departementNom: dep?.name ?? null,
    }];
  }));
}

/** Le coût du mois, réparti par société — sans rien écrire (l'écran le montre avant d'imputer). */
export async function calculerCoutIaDuMois(mois: string): Promise<Repartition> {
  const appels = await agregerJournalDuMois(mois);
  const personnes = await rattachementsDesPersonnes(appels.flatMap((a) => (a.userId ? [a.userId] : [])));
  return repartirParSociete(appels, personnes);
}

export interface ImputationSociete { companyId: string; geste: GesteImputation; montantDzd: number; coutUsd: number; appels: number; sansTarif: number }
export interface ResultatImputation { mois: string; taux: number; societes: ImputationSociete[]; nonRattache: Repartition["nonRattache"] }

/**
 * IMPUTE le mois — pour toutes les sociétés concernées, ou seulement celles données (`societes`, les sociétés permises à
 * la personne qui impute). Une société déjà imputée ce mois-là et qui n'a plus rien est recalculée à zéro (sa ligne aussi).
 */
export async function imputerCoutIaDuMois(p: { mois: string; taux: number; acteurId: string | null; societes?: readonly string[] | null }): Promise<ResultatImputation> {
  const rep = await calculerCoutIaDuMois(p.mois);
  const permise = (id: string) => !p.societes || p.societes.includes(id);
  const deja = await prisma.imputationCoutIa.findMany({ where: { mois: p.mois }, select: { companyId: true } });
  const vides = deja.filter((d) => permise(d.companyId) && !rep.parSociete.some((s) => s.companyId === d.companyId))
    .map((d) => ({ companyId: d.companyId, microUsd: 0, appels: 0, sansTarif: 0, parFonction: [], parDepartement: [] }));
  const parts = [...rep.parSociete.filter((s) => permise(s.companyId)), ...vides];
  const date = dateDeLImputation(p.mois);
  const societes: ImputationSociete[] = [];
  for (const part of parts) {
    const montant = montantDzd(part.microUsd, p.taux);
    await assurerDepartementInformatique(part.companyId);
    const env = await enveloppeInformatique(part.companyId, date, p.acteurId);
    const categorieIa = env.lignes[CLE_LIGNE_IA];
    const reference = `Consommation IA — ${libelleMois(p.mois)}`;
    const notes = `Coût de l'IA imputé depuis le journal des appels : ${part.appels} appel(s), ${enUsd(part.microUsd).toFixed(2)} $ au taux de ${p.taux} DZD${part.sansTarif ? ` (${part.sansTarif} appel(s) sans tarif, non comptés)` : ""}.`;
    // Sous verrou de base par (société, mois) : un clic et la tâche de fond en même temps ne doublent rien.
    const geste = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`imputation-ia:${part.companyId}:${p.mois}`}))`;
      const existante = await tx.imputationCoutIa.findUnique({ where: { companyId_mois: { companyId: part.companyId, mois: p.mois } } });
      const ligne = existante?.expenseLineId ? await tx.budgetExpenseLine.findUnique({ where: { id: existante.expenseLineId }, select: { id: true } }) : null;
      const g = gesteImputation(
        existante ? { microUsd: versMicroUsd(existante.coutUsd.toString()), taux: Number(existante.tauxUsdDzd), montantDzd: Number(existante.montantDzd), ligneExiste: !!ligne } : null,
        { microUsd: part.microUsd, taux: p.taux, montantDzd: montant, appels: part.appels },
      );
      if (g === "RIEN" || g === "INCHANGEE") return g;
      // La ligne de dépense : la même, mise à jour ; recréée seulement si on l'a retirée à la main entre-temps.
      const categoryId = ligne ? existante!.categoryId : categorieIa;
      const ligneId = ligne
        ? (await tx.budgetExpenseLine.update({ where: { id: ligne.id }, data: { amount: montant, notes, reference }, select: { id: true } })).id
        : (await tx.budgetExpenseLine.create({ data: { categoryId, reference, amount: montant, date, notes, createdById: p.acteurId }, select: { id: true } })).id;
      const donnees = {
        categoryId, expenseLineId: ligneId, coutUsd: enUsd(part.microUsd).toFixed(6), tauxUsdDzd: p.taux, montantDzd: montant,
        appels: part.appels, sansTarif: part.sansTarif, detail: detailAStocker(part) as object, calculeLe: new Date(), calculeParId: p.acteurId,
      };
      if (existante) await tx.imputationCoutIa.update({ where: { id: existante.id }, data: donnees });
      else await tx.imputationCoutIa.create({ data: { companyId: part.companyId, mois: p.mois, ...donnees } });
      return g;
    }, { timeout: 20_000 });
    societes.push({ companyId: part.companyId, geste, montantDzd: montant, coutUsd: enUsd(part.microUsd), appels: part.appels, sansTarif: part.sansTarif });
    if (geste === "CREER" || geste === "METTRE_A_JOUR") {
      await recordAudit({
        actorId: p.acteurId, action: geste === "CREER" ? "CREATE" : "UPDATE", module: "Informatique", entityId: env.envelopeId,
        summary: `Coût de l'IA de ${libelleMois(p.mois)} imputé au budget « ${env.nom} » : ${montant} DZD (${enUsd(part.microUsd).toFixed(2)} $ × ${p.taux})`,
      }).catch(sansBloquer("informatique.imputation.recordAudit"));
    }
  }
  return { mois: p.mois, taux: p.taux, societes, nonRattache: rep.nonRattache };
}

/** Le dernier taux USD → DZD fixé par une personne : celui que la tâche de fond reprend (jamais un taux deviné). */
export async function dernierTauxFixe(): Promise<number | null> {
  const d = await prisma.imputationCoutIa.findFirst({ where: { calculeParId: { not: null } }, orderBy: { calculeLe: "desc" }, select: { tauxUsdDzd: true } });
  return d ? Number(d.tauxUsdDzd) : null;
}
