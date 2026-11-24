import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import {
  CLE_MOYENS_GENERAUX, CODE_ENVELOPPE_ADMINISTRATION, GESTIONNAIRES_ADMINISTRATION, LIBELLE_NATURE_CHARGE_FIXE,
  LIGNES_STRUCTURE_ADMINISTRATION, NATURES_CHARGE_FIXE, nomEnveloppeAdministration, totauxAnnuelsParNature,
  type ChargeFixePourCalcul, type NatureChargeFixe,
} from "../domaine/charges-fixes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUDGET DE L'ADMINISTRATION — une enveloppe par société et par année, TENUE PAR LES FINANCES (Super Admin, 24/11/2026).
 *
 * Sur le modèle des enveloppes ouvertes d'office (`lib/budget/enveloppes-pole.ts`, l'enveloppe « Impôts & taxes ») : une
 * `BudgetEnvelope` ordinaire — domaine GENERAL, Budgets la lit avec les autres —, reconnue par son code
 * `module = ADMINISTRATION`, gérée par le rôle des Finances (`managerRoles`), ses lignes reconnues par leur `cle` stable :
 * une par nature de charge fixe (montant = les échéances de l'année, recalculé à chaque modification d'une charge), et
 * les lignes de structure (moyens généraux, dons et mécénat, réserve pour imprévus, remboursement d'emprunt).
 *
 * Idempotent et sérialisé par un verrou de base (`pg_advisory_xact_lock`) : deux ouvertures simultanées (deux onglets,
 * la page des moyens généraux et une charge enregistrée) trouvent la même enveloppe. Une ligne créée à la main sous le
 * même nom devient la ligne reconnue (sa clé), sans doublon.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

async function sousVerrou<T>(cle: string, corps: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cle}))`;
    return corps(tx);
  }, { timeout: 20_000 });
}

const milieuDAnnee = (annee: number) => new Date(Date.UTC(annee, 5, 30));

/** L'enveloppe « Administration <année> » de la société — trouvée, sinon ouverte (montant 0, tenue par les Finances). */
async function trouverOuOuvrir(tx: Tx, companyId: string, annee: number, actorId: string | null): Promise<{ id: string; creee: boolean }> {
  const milieu = milieuDAnnee(annee);
  const existe = await tx.budgetEnvelope.findFirst({
    where: { companyId, module: CODE_ENVELOPPE_ADMINISTRATION, periodStart: { lte: milieu }, periodEnd: { gte: milieu } },
    orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
    select: { id: true },
  });
  if (existe) return { id: existe.id, creee: false };
  const cree = await tx.budgetEnvelope.create({
    data: {
      name: nomEnveloppeAdministration(annee), companyId, module: CODE_ENVELOPPE_ADMINISTRATION, modules: [], domaine: "GENERAL",
      managerRoles: [...GESTIONNAIRES_ADMINISTRATION],
      periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59, 59)), totalAmount: 0,
      notes: "Budget de l'Administration, tenu par les Finances : charges fixes des locaux, moyens généraux, dons et mécénat, réserve pour imprévus, remboursement d'emprunt.",
      createdById: actorId,
    },
    select: { id: true },
  });
  return { id: cree.id, creee: true };
}

/** Une ligne de premier niveau, reconnue par sa clé (ou par son nom, créée à la main) — sinon créée. */
async function ligne(tx: Tx, envelopeId: string, cle: string, nom: string, module: string | null = null): Promise<string> {
  const deja = await tx.budgetCategoryLine.findFirst({ where: { envelopeId, parentId: null, cle }, select: { id: true } })
    ?? await tx.budgetCategoryLine.findFirst({ where: { envelopeId, parentId: null, cle: null, name: nom }, select: { id: true } });
  if (deja) {
    await tx.budgetCategoryLine.updateMany({ where: { id: deja.id, cle: null }, data: { cle } });
    return deja.id;
  }
  return (await tx.budgetCategoryLine.create({ data: { envelopeId, name: nom, cle, module, allocated: 0 }, select: { id: true } })).id;
}

export interface EnveloppeAdministration {
  id: string;
  creee: boolean;
  /** Les lignes de premier niveau, par clé (natures demandées + lignes de structure). */
  lignes: Map<string, string>;
}

/**
 * L'ENVELOPPE DE L'ADMINISTRATION D'UNE SOCIÉTÉ POUR UNE ANNÉE, avec ses lignes de structure et celles des natures
 * demandées. C'est l'IMPUTATION (une échéance demandée, une dépense des moyens généraux) ou la saisie d'une charge qui la
 * demande — pas un geste de gestion : sans contrôle de droit ici, les appelants ont le leur.
 */
export async function enveloppeAdministration(
  companyId: string, annee: number, actorId: string | null, natures: readonly NatureChargeFixe[] = [],
): Promise<EnveloppeAdministration> {
  const r = await sousVerrou(`enveloppe-administration:${companyId}:${annee}`, async (tx) => {
    const env = await trouverOuOuvrir(tx, companyId, annee, actorId);
    const lignes = new Map<string, string>();
    for (const n of NATURES_CHARGE_FIXE.filter((x) => natures.includes(x))) lignes.set(n, await ligne(tx, env.id, n, LIBELLE_NATURE_CHARGE_FIXE[n]));
    for (const l of LIGNES_STRUCTURE_ADMINISTRATION) {
      lignes.set(l.cle, await ligne(tx, env.id, l.cle, l.nom, l.cle === CLE_MOYENS_GENERAUX ? "GENERAL_MEANS" : null));
    }
    return { ...env, lignes };
  });
  if (r.creee) {
    await recordAudit({
      actorId, action: "CREATE", module: "Budgets", entityId: r.id,
      summary: `Enveloppe « ${nomEnveloppeAdministration(annee)} » ouverte d'office pour la société — tenue par les Finances, montants à fixer`,
    }).catch(sansBloquer("budget-administration.enveloppe.recordAudit"));
  }
  return r;
}

/** Les charges d'une société, prêtes au calcul. */
export async function chargesPourCalcul(where: Prisma.ChargeFixeSocieteWhereInput): Promise<ChargeFixePourCalcul[]> {
  const rows = await prisma.chargeFixeSociete.findMany({
    where,
    select: {
      id: true, companyId: true, nature: true, site: true, beneficiaire: true, modeMontant: true, montant: true, periodicite: true,
      jourEcheance: true, moisEcheance: true, dateDebut: true, dateFin: true, echeanceFixe: true, active: true,
    },
  });
  return rows.map((r) => ({ ...r, montant: Number(r.montant) }));
}

/**
 * LE MONTANT DES LIGNES « CHARGES FIXES » EST RECALCULÉ quand une charge change : pour l'année en cours (l'enveloppe est
 * ouverte au besoin) et pour toute année suivante dont l'enveloppe existe déjà. Chaque nature qui a (ou a eu) une charge
 * porte la somme de ses échéances de l'année ; le TOTAL de l'enveloppe est relevé s'il ne couvre plus ses lignes (une
 * charge contractuelle n'est pas une option). Les lignes de structure ne sont jamais touchées : leurs montants se décident.
 */
export async function recalculerBudgetAdministration(companyId: string, actorId: string | null, maintenant: Date = new Date()): Promise<number> {
  const charges = await chargesPourCalcul({ companyId });
  const anneeCourante = maintenant.getUTCFullYear();
  const suivantes = await prisma.budgetEnvelope.findMany({
    where: { companyId, module: CODE_ENVELOPPE_ADMINISTRATION, periodStart: { gt: new Date(Date.UTC(anneeCourante, 11, 31)) } },
    select: { periodStart: true },
  });
  const annees = [...new Set([anneeCourante, ...suivantes.map((e) => e.periodStart.getUTCFullYear())])];
  const natures = NATURES_CHARGE_FIXE.filter((n) => charges.some((c) => c.nature === n));
  let lignesMaj = 0;
  for (const annee of annees) {
    const env = await enveloppeAdministration(companyId, annee, actorId, natures);
    const totaux = totauxAnnuelsParNature(charges, annee);
    // Toutes les lignes « charges fixes » de l'enveloppe, y compris celle d'une nature qui n'a plus de charge (passée à 0).
    const lignesNatures = await prisma.budgetCategoryLine.findMany({
      where: { envelopeId: env.id, parentId: null, cle: { in: [...NATURES_CHARGE_FIXE] } }, select: { id: true, cle: true },
    });
    for (const l of lignesNatures) {
      const montant = Math.round((totaux.get(l.cle as NatureChargeFixe) ?? 0) * 100) / 100;
      const maj = await prisma.budgetCategoryLine.updateMany({ where: { id: l.id, NOT: { allocated: montant } }, data: { allocated: montant } });
      lignesMaj += maj.count;
    }
    const [enveloppe, lignes] = await Promise.all([
      prisma.budgetEnvelope.findUnique({ where: { id: env.id }, select: { totalAmount: true } }),
      prisma.budgetCategoryLine.findMany({ where: { envelopeId: env.id, parentId: null }, select: { allocated: true } }),
    ]);
    const somme = lignes.reduce((s, l) => s + Number(l.allocated), 0);
    if (enveloppe && Number(enveloppe.totalAmount) < somme) {
      await prisma.budgetEnvelope.update({ where: { id: env.id }, data: { totalAmount: somme } });
      await recordAudit({
        actorId, action: "UPDATE", module: "Budgets", entityId: env.id,
        summary: `${nomEnveloppeAdministration(annee)} : total relevé à ${Math.round(somme).toLocaleString("fr-FR")} DZD — les charges fixes de la société le dépassaient`,
      }).catch(sansBloquer("budget-administration.recalculer.recordAudit"));
    }
  }
  return lignesMaj;
}

/** La ligne « Moyens généraux » de la société pour cette année (enveloppe ouverte au besoin) — pour les natures `MG_*`. */
export async function ligneMoyensGeneraux(companyId: string, annee: number, actorId: string | null): Promise<{ envelopeId: string; ligneId: string }> {
  const env = await enveloppeAdministration(companyId, annee, actorId);
  return { envelopeId: env.id, ligneId: env.lignes.get(CLE_MOYENS_GENERAUX) as string };
}
