import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { lienEcheanceChargeFixe } from "@/lib/chemins/finances";
import { notifyRoles } from "@/lib/notify";
import {
  cleEcheance, echeancesAApparaitre, echeancesEntre, etatEcheance, LIBELLE_NATURE_CHARGE_FIXE, libellePeriode,
  peutDemanderPaiement, rubriqueDeNature, estNatureChargeFixe, type NatureChargeFixe, type SaisieChargeFixe,
} from "../domaine/charges-fixes";
import { createExpenseOrder } from "./expense-orders";
import { chargesPourCalcul, enveloppeAdministration, recalculerBudgetAdministration } from "./budget-administration";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHARGES FIXES DES LOCAUX — les écritures (Super Admin, 24/11/2026). Les règles sont dans `domaine/charges-fixes`.
 *
 *   · enregistrer / retirer une charge : la ligne de sa nature au budget de l'Administration se recalcule ;
 *   · demander le paiement d'une échéance : la facture jointe, l'ordre naît par `createExpenseOrder` (origine
 *     `FIXED_CHARGE`, source = l'échéance), ligne budgétaire posée, échéance FIXE pour le loyer ;
 *   · le rappel J-15 aux Finances (tâche planifiée), une fois par échéance.
 *
 * Aucun contrôle de droit ici : les actions (`actions-charges-fixes.ts`) ont le leur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const dzd = (n: number): string => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/** Enregistre (crée ou corrige) une charge ; chaque changement de montant se trace (ancien → nouveau, auteur). */
export async function enregistrerCharge(
  p: { companyId: string; id: string | null; saisie: SaisieChargeFixe; actorId: string },
): Promise<{ ok: true; id: string; creee: boolean } | { ok: false; error: string }> {
  const s = p.saisie;
  if (s.legalDocumentId) {
    const bail = await prisma.legalDocument.findUnique({ where: { id: s.legalDocumentId }, select: { companyId: true } });
    if (!bail || (bail.companyId && bail.companyId !== p.companyId)) {
      return { ok: false, error: "Ce document du registre Legal n'appartient pas à cette société : choisissez un bail de la société, ou aucun." };
    }
  }
  const data = {
    site: s.site, nature: s.nature, libelle: s.libelle, beneficiaire: s.beneficiaire, rib: s.rib, legalDocumentId: s.legalDocumentId,
    modeMontant: s.modeMontant, montant: s.montant, periodicite: s.periodicite, jourEcheance: s.jourEcheance, moisEcheance: s.moisEcheance,
    dateDebut: s.dateDebut, dateFin: s.dateFin, echeanceFixe: s.echeanceFixe, notes: s.notes, updatedById: p.actorId,
  };
  let id: string;
  let creee = false;
  let resume: string;
  const nature = LIBELLE_NATURE_CHARGE_FIXE[s.nature];
  if (p.id) {
    const avant = await prisma.chargeFixeSociete.findUnique({ where: { id: p.id }, select: { companyId: true, montant: true, modeMontant: true } });
    if (!avant || avant.companyId !== p.companyId) return { ok: false, error: "Cette charge n'existe plus : rechargez la page." };
    await prisma.chargeFixeSociete.update({ where: { id: p.id }, data });
    id = p.id;
    const ancien = Number(avant.montant);
    resume = ancien !== s.montant
      ? `Charge fixe « ${nature} — ${s.site} » : montant ${dzd(ancien)} → ${dzd(s.montant)}`
      : `Charge fixe « ${nature} — ${s.site} » modifiée`;
  } else {
    id = (await prisma.chargeFixeSociete.create({ data: { ...data, companyId: p.companyId, createdById: p.actorId }, select: { id: true } })).id;
    creee = true;
    resume = `Charge fixe « ${nature} — ${s.site} » ajoutée : ${dzd(s.montant)} (${s.modeMontant === "SELON_FACTURE" ? "estimation" : "fixe"}), ${s.periodicite.toLowerCase()}`;
  }
  await recordAudit({ actorId: p.actorId, action: creee ? "CREATE" : "UPDATE", module: "Informations de la société", entityId: id, summary: resume });
  await recalculerBudgetAdministration(p.companyId, p.actorId);
  return { ok: true, id, creee };
}

/** Retire une charge : elle cesse (plus d'échéance), son historique et ses ordres restent ; le budget se recalcule. */
export async function retirerCharge(p: { id: string; companyId: string; actorId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const maj = await prisma.chargeFixeSociete.updateMany({ where: { id: p.id, companyId: p.companyId, active: true }, data: { active: false, updatedById: p.actorId } });
  if (maj.count === 0) return { ok: false, error: "Cette charge est déjà retirée, ou n'existe plus : rechargez la page." };
  await recordAudit({ actorId: p.actorId, action: "UPDATE", module: "Informations de la société", entityId: p.id, summary: "Charge fixe retirée — plus aucune échéance ; l'historique reste" });
  await recalculerBudgetAdministration(p.companyId, p.actorId);
  return { ok: true };
}

/**
 * DEMANDER LE PAIEMENT D'UNE ÉCHÉANCE — la facture jointe fait le justificatif de l'ordre (rangée sur l'ordre à sa
 * naissance, comme l'état de paie ou le bon de remise) : l'ordre entre au centre de paiement d'emblée. Une échéance dont
 * un ordre vit déjà (au centre, autorisé, payé) ne se redemande pas ; refusée ou annulée, elle se redemande.
 */
export async function demanderPaiementEcheance(p: {
  chargeId: string; companyId: string; periode: string; montantFacture: number; facture: File; actorId: string;
}): Promise<{ ok: true; reference: string; ordreId: string } | { ok: false; error: string }> {
  const [c] = await chargesPourCalcul({ id: p.chargeId, companyId: p.companyId });
  if (!c) return { ok: false, error: "Cette charge n'existe plus : rechargez la page." };
  if (!estNatureChargeFixe(c.nature)) return { ok: false, error: "La nature de cette charge est inconnue : corrigez-la dans « Locaux & charges fixes »." };
  const [a, m] = p.periode.split("-").map(Number);
  const e = a && m ? echeancesEntre(c, new Date(Date.UTC(a, m - 1, 1)), new Date(Date.UTC(a, m, 0, 23, 59, 59))).find((x) => x.periode === p.periode) : undefined;
  if (!e) return { ok: false, error: "Aucune échéance de cette charge ce mois-là : vérifiez la périodicité et les dates de la charge." };

  const fiche = await prisma.chargeFixeSociete.findUnique({ where: { id: c.id }, select: { rib: true, libelle: true } });
  const existante = await prisma.echeanceChargeFixe.findUnique({ where: { chargeId_periode: { chargeId: c.id, periode: p.periode } }, select: { id: true, expenseOrderId: true } });
  if (existante?.expenseOrderId) {
    const ordre = await prisma.expenseOrder.findUnique({ where: { id: existante.expenseOrderId }, select: { reference: true, status: true, centralStatus: true } });
    if (ordre && !peutDemanderPaiement(etatEcheance(ordre))) {
      return { ok: false, error: `Le paiement de cette échéance est déjà demandé (${ordre.reference}) : suivez-le au centre de paiement, puis dans Banque & paiements.` };
    }
  }

  // La ligne du budget de l'Administration de la société, pour l'année de l'échéance — posée sur l'ordre : rien à classer au règlement.
  const env = await enveloppeAdministration(p.companyId, e.date.getUTCFullYear(), p.actorId, [c.nature]);
  const budgetCategoryId = env.lignes.get(c.nature) ?? null;

  const echeance = await prisma.echeanceChargeFixe.upsert({
    where: { chargeId_periode: { chargeId: c.id, periode: p.periode } },
    create: { chargeId: c.id, companyId: p.companyId, periode: p.periode, dateEcheance: e.date, montantPrevu: e.montant, montantFacture: p.montantFacture, demandeParId: p.actorId, demandeLe: new Date() },
    update: { montantPrevu: e.montant, montantFacture: p.montantFacture, demandeParId: p.actorId, demandeLe: new Date() },
    select: { id: true },
  });
  const nature = c.nature as NatureChargeFixe;
  const periodeLue = libellePeriode(p.periode, c.periodicite);
  const ordre = await createExpenseOrder({
    label: `${LIBELLE_NATURE_CHARGE_FIXE[nature]}${fiche?.libelle ? ` (${fiche.libelle})` : ""} — ${c.site} · ${periodeLue}`,
    amount: p.montantFacture,
    category: rubriqueDeNature(nature),
    beneficiary: c.beneficiaire,
    sourceType: "FIXED_CHARGE",
    sourceId: echeance.id,
    requestedById: p.actorId,
    companyId: p.companyId,
    dueDate: e.date,
    // Le loyer (ou toute charge marquée ainsi) a une échéance FIXE : le report exigera un motif.
    deadlineNature: c.echeanceFixe ? "FIXED" : "IMPORTANT",
    budgetCategoryId,
    requiresInvoice: true,
    notes: [fiche?.rib ? `RIB : ${fiche.rib}` : null, c.modeMontant === "SELON_FACTURE" ? `Estimation : ${dzd(e.montant)}` : `Montant fixe : ${dzd(e.montant)}`].filter(Boolean).join(" · "),
    justificatif: { fichier: p.facture, nature: "INVOICE" },
  });
  await prisma.echeanceChargeFixe.update({ where: { id: echeance.id }, data: { expenseOrderId: ordre.id } });
  await recordAudit({
    actorId: p.actorId, action: "CREATE", module: "Informations de la société", entityId: echeance.id,
    summary: `Paiement demandé — ${LIBELLE_NATURE_CHARGE_FIXE[nature]} ${c.site}, ${periodeLue} : ${dzd(p.montantFacture)} (${ordre.reference})`,
  });
  return { ok: true, reference: ordre.reference, ordreId: ordre.id };
}

/** Les clés `charge:période` dont un ordre vit (au centre, autorisé ou payé) — elles ne sont plus « à demander ». */
export async function echeancesTraitees(chargeIds: readonly string[]): Promise<Map<string, { ordreId: string; etat: ReturnType<typeof etatEcheance>; reference: string; montantFacture: number | null; id: string }>> {
  const out = new Map<string, { ordreId: string; etat: ReturnType<typeof etatEcheance>; reference: string; montantFacture: number | null; id: string }>();
  if (chargeIds.length === 0) return out;
  const lignes = await prisma.echeanceChargeFixe.findMany({
    where: { chargeId: { in: [...chargeIds] }, expenseOrderId: { not: null } },
    select: { id: true, chargeId: true, periode: true, expenseOrderId: true, montantFacture: true },
  });
  const ordres = await prisma.expenseOrder.findMany({
    where: { id: { in: lignes.map((l) => l.expenseOrderId as string) } },
    select: { id: true, reference: true, status: true, centralStatus: true },
  });
  const parId = new Map(ordres.map((o) => [o.id, o]));
  for (const l of lignes) {
    const o = parId.get(l.expenseOrderId as string);
    if (!o) continue;
    out.set(cleEcheance(l.chargeId, l.periode), {
      id: l.id, ordreId: o.id, reference: o.reference, etat: etatEcheance(o), montantFacture: l.montantFacture === null ? null : Number(l.montantFacture),
    });
  }
  return out;
}

/**
 * LE RAPPEL J-15 (tâche planifiée quotidienne) : chaque échéance qui entre dans les quinze jours sans avoir été demandée
 * prévient les Finances UNE fois (`rappelEnvoyeLe`). La ligne « Aujourd'hui » se lit, elle, sans attendre la tâche.
 */
export async function rappelerEcheancesChargesFixes(maintenant: Date = new Date()): Promise<{ rappels: number }> {
  const charges = await chargesPourCalcul({ active: true });
  if (charges.length === 0) return { rappels: 0 };
  const traitees = new Set([...(await echeancesTraitees(charges.map((c) => c.id))).entries()]
    .filter(([, v]) => !peutDemanderPaiement(v.etat)).map(([k]) => k));
  const dues = echeancesAApparaitre(charges, maintenant, traitees);
  const deja = await prisma.echeanceChargeFixe.findMany({
    where: { chargeId: { in: [...new Set(dues.map((d) => d.chargeId))] }, rappelEnvoyeLe: { not: null } },
    select: { chargeId: true, periode: true },
  });
  const rappelees = new Set(deja.map((d) => cleEcheance(d.chargeId, d.periode)));
  let rappels = 0;
  for (const e of dues) {
    if (rappelees.has(cleEcheance(e.chargeId, e.periode))) continue;
    const c = charges.find((x) => x.id === e.chargeId);
    if (!c || !estNatureChargeFixe(c.nature)) continue;
    // La ligne d'échéance naît au rappel (sans ordre) : c'est elle qui retient que le rappel est parti.
    await prisma.echeanceChargeFixe.upsert({
      where: { chargeId_periode: { chargeId: e.chargeId, periode: e.periode } },
      create: { chargeId: e.chargeId, companyId: e.companyId, periode: e.periode, dateEcheance: e.date, montantPrevu: e.montant, rappelEnvoyeLe: maintenant },
      update: { rappelEnvoyeLe: maintenant },
    });
    await notifyRoles(["FINANCE_BUDGET_MANAGER"], {
      type: "DEADLINE_NEAR",
      title: `Charge fixe à payer — ${LIBELLE_NATURE_CHARGE_FIXE[c.nature]} ${c.site}`,
      body: `${libellePeriode(e.periode, c.periodicite)} · ${dzd(e.montant)}${c.modeMontant === "SELON_FACTURE" ? " (estimation)" : ""} · dû le ${e.date.toLocaleDateString("fr-FR", { timeZone: "UTC" })} — joignez la facture et demandez le paiement.`,
      link: lienEcheanceChargeFixe(e.companyId, cleEcheance(e.chargeId, e.periode)),
    }).catch(sansBloquer("charges-fixes.rappel.notifyRoles"));
    rappels += 1;
  }
  return { rappels };
}
