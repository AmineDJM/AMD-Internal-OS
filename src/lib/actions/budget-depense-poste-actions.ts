"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { canManageEnvelope, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createExpenseOrder } from "@/lib/expense-orders";
import { persistUploadedDocument } from "@/lib/documents";
import { validateAttachments } from "@/lib/attach-files";
import { ITEM_KIND_LABELS, PARENT_ENTITE, type AdProParent, facturePourPayer } from "@/modules/ad-pro/partage";
import { rattacherPieceAuPoste, refusCategoriePourLaDemande, refusSiPorteDgFermee } from "@/modules/ad-pro/api";
import { CHEMIN_PARENT_AD_PRO } from "@/lib/chemins/ad-pro";
import { DOMAINES } from "@/lib/budget/domaines";
import { depensesDesPostes } from "@/lib/queries/budget-sources";
import {
  MOTIF_MAX, refusAnnulation, refusConsommation, refusImputation, type GesteImputation,
} from "@/lib/budget/depense-poste";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { verifierFacturesAvantDepot, marquerDoublonPossible } from "@/lib/factures/connues";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LES GESTES SUR LA DÉPENSE D'UN POSTE AD & PRO (onglet « Dépenses », maquette validée 10/2026).
 *
 *   • IMPUTER — la première fois : le poste, tous ses BC signés, entre au budget (ENGAGÉE, somme des BC signés).
 *   • CHANGER DE BUDGET — à tout moment d'une dépense engagée, consommée ou payée : le poste, ses ordres de dépense et
 *     les écritures de trésorerie qu'ils ont réglées changent de catégorie ENSEMBLE, sans quoi les totaux de la vue
 *     d'ensemble compteraient le payé dans l'ancien budget et l'engagé dans le nouveau. Tracé : ancien → nouveau.
 *   • CONSOMMER — un montant ≤ l'engagé (le reste est rendu au budget), une facture FACULTATIVE : la demande de paiement
 *     du poste, par le seul écrivain des ordres (`createExpenseOrder`) — l'ordre naît au centre de paiement, que les
 *     Finances règlent ensuite (§118.176). Les Finances n'exécutent un ordre « facture exigée » qu'avec sa facture :
 *     jointe ici, ou plus tard au dossier de paiement.
 *   • ANNULER — libère l'engagement, motif facultatif ; refusé dès que la dépense est consommée.
 *
 * Porte : la gestion de l'enveloppe (`canManageEnvelope` — le droit « Modifier » du Budget Marketing, la Direction
 * Marketing par défaut) sur l'enveloppe de la catégorie visée, et sur celle d'où l'on part. Toute écriture est
 * CONDITIONNELLE sur l'état lu (`updatedAt` du poste) : deux clics, ou deux personnes, n'écrivent pas deux fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE = DOMAINES.MARKETING.titre;
const REFUS_DROIT = `Réservé à ${DOMAINES.MARKETING.gestionnaire} (${DOMAINES.MARKETING.titre}).`;
const CHANGE = "Cette dépense vient de changer : rechargez la page.";

function parentDe(p: { sponsoringId: string | null; congressNationalId: string | null; congressInternationalId: string | null; eventId: string | null; otherRequestId: string | null }): { parent: AdProParent; id: string } | null {
  if (p.sponsoringId) return { parent: "SPONSORING", id: p.sponsoringId };
  if (p.congressNationalId) return { parent: "CONGRESS_NATIONAL", id: p.congressNationalId };
  if (p.congressInternationalId) return { parent: "CONGRESS_INTERNATIONAL", id: p.congressInternationalId };
  if (p.eventId) return { parent: "EVENT", id: p.eventId };
  if (p.otherRequestId) return { parent: "AD_PRO_OTHER", id: p.otherRequestId };
  return null;
}

/** Ce que l'ordre de dépense dit de l'opération : sa référence, son bénéficiaire, sa société. */
async function operation(o: { parent: AdProParent; id: string }): Promise<{ ref: string; beneficiaire: string; companyId: string | null } | null> {
  switch (o.parent) {
    case "SPONSORING": {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id: o.id }, select: { reference: true, institution: true, companyId: true } });
      return r ? { ref: r.reference, beneficiaire: r.institution, companyId: r.companyId } : null;
    }
    case "CONGRESS_NATIONAL": {
      const r = await prisma.congressNational.findUnique({ where: { id: o.id }, select: { name: true, hostInstitution: true, companyId: true } });
      return r ? { ref: r.name, beneficiaire: r.hostInstitution ?? r.name, companyId: r.companyId } : null;
    }
    case "CONGRESS_INTERNATIONAL": {
      const r = await prisma.congressInternational.findUnique({ where: { id: o.id }, select: { name: true, companyId: true } });
      return r ? { ref: r.name, beneficiaire: r.name, companyId: r.companyId } : null;
    }
    case "EVENT": {
      const r = await prisma.event.findUnique({ where: { id: o.id }, select: { name: true, companyId: true } });
      return r ? { ref: r.name, beneficiaire: r.name, companyId: r.companyId } : null;
    }
    case "AD_PRO_OTHER": {
      const r = await prisma.adProOtherRequest.findUnique({ where: { id: o.id }, select: { reference: true, title: true, beneficiary: true, companyId: true } });
      return r ? { ref: r.reference, beneficiaire: r.beneficiary ?? r.title, companyId: r.companyId } : null;
    }
  }
}

const SELECT_CATEGORIE = {
  id: true, name: true, parent: { select: { name: true } },
  envelope: { select: { id: true, name: true, domaine: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true } },
} as const;

async function categorie(id: string | null) {
  return id ? prisma.budgetCategoryLine.findUnique({ where: { id }, select: SELECT_CATEGORIE }) : null;
}
type Categorie = NonNullable<Awaited<ReturnType<typeof categorie>>>;
const nomCategorie = (c: Categorie | null) => (c ? `${c.envelope.name} › ${c.parent ? `${c.parent.name} › ` : ""}${c.name}` : "aucun budget");

/** Un poste « Historique 2026 » (intégration des dépenses réelles) est déjà payé : sa dépense ne s'impute, ne se consomme ni ne s'annule. */
const REFUS_HISTORIQUE = "Ce poste est « Historique 2026 » : déjà payé, il compte au budget par sa ligne du fichier — sa dépense ne s'impute, ne se consomme ni ne s'annule.";

/** Le poste et l'état de sa dépense, relus à l'instant. */
async function lirePoste(id: string) {
  const poste = await prisma.adProItem.findUnique({
    where: { id },
    select: {
      id: true, label: true, kind: true, supplier: true, status: true, expenseOrderId: true, amountGranted: true, budgetCategoryId: true,
      orderStage: true, updatedAt: true, depenseImputeeLe: true, depenseAnnuleeLe: true, montantPayeHistorique: true,
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
    },
  });
  if (!poste) return null;
  const owner = parentDe(poste);
  if (!owner) return null;
  const lue = (await depensesDesPostes([poste])).get(poste.id);
  if (!lue) return null;
  return { poste, owner, lue };
}

function revalider(owner: { parent: AdProParent; id: string }) {
  revalidatePath(DOMAINES.MARKETING.chemin);
  revalidatePath(`${DOMAINES.MARKETING.chemin}/depenses`);
  revalidatePath("/budgets");
  revalidatePath(`${CHEMIN_PARENT_AD_PRO[owner.parent]}/${owner.id}`);
}

async function journal(user: SessionUser, posteId: string, field: string, summary: string, oldValue?: string | null, newValue?: string | null) {
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "AD_PRO_ITEM", entityId: posteId, field, oldValue: oldValue ?? null, newValue: newValue ?? null, summary }).catch(sansBloquer("budget-depense-poste-actions.journal.recordAudit"));
}

const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/** IMPUTER ou CHANGER DE BUDGET — un seul chemin, le geste dit lequel. */
async function imputation(formData: FormData, geste: GesteImputation): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const cibleId = fdStr(formData, "categorieId");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const lu = await lirePoste(id);
  if (!lu) return { ok: false, error: "Poste introuvable." };
  if (lu.poste.montantPayeHistorique != null) return { ok: false, error: REFUS_HISTORIQUE };
  const { poste, owner, lue } = lu;
  const [cible, actuelle] = await Promise.all([categorie(cibleId), categorie(poste.budgetCategoryId)]);
  // La porte : gérer l'enveloppe visée — et, pour un changement, celle d'où la dépense part.
  if (cible && !canManageEnvelope(user, cible.envelope)) return { ok: false, error: REFUS_DROIT };
  if (geste === "CHANGER" && actuelle && actuelle.envelope.domaine === "MARKETING" && !canManageEnvelope(user, actuelle.envelope)) return { ok: false, error: REFUS_DROIT };
  const refus = refusImputation({
    etat: lue.depense.etat, geste,
    cible: cible ? { id: cible.id, domaine: cible.envelope.domaine } : null,
    actuelleId: poste.budgetCategoryId,
  });
  if (refus || !cible) return { ok: false, error: refus ?? "Catégorie introuvable." };
  // La catégorie convient à la demande du poste : sa nature, son exercice, sa Business Unit (point 9, 27/10).
  const refusCat = await refusCategoriePourLaDemande(cible.id, owner.parent, owner.id);
  if (refusCat) return { ok: false, error: refusCat };

  const maintenant = new Date();
  const ordres = lue.ordres.filter((o) => o.statut !== "CANCELLED");
  const ecritures = ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x));
  const fait = await prisma.$transaction(async (tx) => {
    const prise = await tx.adProItem.updateMany({
      where: {
        id, updatedAt: poste.updatedAt, budgetCategoryId: poste.budgetCategoryId, depenseAnnuleeLe: null,
        ...(geste === "IMPUTER" ? { depenseImputeeLe: null, expenseOrderId: poste.expenseOrderId, status: "APPROVED" as const } : {}),
      },
      data: {
        budgetCategoryId: cible.id,
        ...(geste === "IMPUTER" || !poste.depenseImputeeLe ? { depenseImputeeLe: maintenant, depenseImputeeParId: user.id } : {}),
        updatedById: user.id,
      },
    });
    if (prise.count === 0) return false;
    // La consommation et le paiement suivent le poste : ses ordres, et les écritures qu'ils ont réglées.
    if (ordres.length) await tx.expenseOrder.updateMany({ where: { id: { in: ordres.map((o) => o.id) } }, data: { budgetCategoryId: cible.id } });
    if (ecritures.length) await tx.financeTransaction.updateMany({ where: { id: { in: ecritures } }, data: { budgetCategoryId: cible.id } });
    return true;
  });
  if (!fait) return { ok: false, error: CHANGE };

  const montant = lue.depense.consomme > 0 ? lue.depense.consomme : lue.depense.montantEngage;
  if (geste === "IMPUTER") {
    await journal(user, id, "depense-imputation", `Poste « ${poste.label} » imputé sur « ${nomCategorie(cible)} » : ${dzd(montant)} engagés.`, null, cible.id);
  } else {
    await journal(user, id, "depense-imputation",
      `Budget du poste « ${poste.label} » changé : « ${nomCategorie(actuelle)} » → « ${nomCategorie(cible)} » (${dzd(montant)}${ordres.length ? `, ${ordres.length} ordre${ordres.length > 1 ? "s" : ""} de dépense suivent` : ""}).`,
      poste.budgetCategoryId, cible.id);
  }
  revalider(owner);
  return {
    ok: true, id,
    message: geste === "IMPUTER"
      ? `Imputée sur « ${cible.name} » : ${dzd(montant)} engagés.`
      : `Budget changé : « ${actuelle?.name ?? "aucun"} » → « ${cible.name} ».`,
  };
}

/** IMPUTER une dépense à un budget marketing — ses bons de commande signés, elle devient ENGAGÉE. */
export async function imputerDepensePoste(formData: FormData): Promise<ActionResult> {
  return imputation(formData, "IMPUTER");
}

/** CHANGER LE BUDGET d'une dépense engagée, consommée ou payée — à tout moment, tracé ancien → nouveau. */
export async function changerBudgetDepensePoste(formData: FormData): Promise<ActionResult> {
  return imputation(formData, "CHANGER");
}

/**
 * CONSOMMER une dépense engagée : le montant (≤ l'engagé), la facture facultative ; l'ordre de dépense du poste naît au
 * centre de paiement. Idempotent : la prise conditionnelle refuse un second envoi.
 */
export async function consommerDepensePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const lu = await lirePoste(id);
  if (!lu) return { ok: false, error: "Poste introuvable." };
  if (lu.poste.montantPayeHistorique != null) return { ok: false, error: REFUS_HISTORIQUE };
  const { poste, owner, lue } = lu;
  const actuelle = await categorie(poste.budgetCategoryId);
  if (!actuelle || !canManageEnvelope(user, actuelle.envelope)) return { ok: false, error: REFUS_DROIT };
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : consommer, c'est demander le paiement du poste — la même porte que
  // `demanderPaiementPoste`. Sans elle, l'onglet « Dépenses » émettait l'ordre d'une demande que le DG n'a pas validée (ADPRO-02).
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  const montant = fdNum(formData, "montant");
  const refus = refusConsommation({ etat: lue.depense.etat, montant, montantEngage: lue.depense.montantEngage });
  if (refus || montant == null) return { ok: false, error: refus ?? "Indiquez le montant consommé." };
  const fichier = formData.getAll("facture").find((v): v is File => v instanceof File && v.size > 0) ?? null;
  if (fichier) {
    const refusFichier = await validateAttachments([fichier]);
    if (refusFichier) return { ok: false, error: refusFichier };
  }
  const op = await operation(owner);
  if (!op) return { ok: false, error: "Opération introuvable." };
  // LA FACTURE DÉJÀ CONNUE AILLEURS (Direction, 14/10) — jugée avant la prise et avant toute écriture.
  const garde = await verifierFacturesAvantDepot(user, fichier
    ? [{ octets: Buffer.from(await fichier.arrayBuffer()), nom: fichier.name, saisie: { ttc: montant, fournisseur: poste.supplier ?? op.beneficiaire } }]
    : [], { instances: [`POSTE:${id}`] });
  if (!garde.ok) return { ok: false, error: garde.error, factureConnue: garde.factureConnue };

  // LA PRISE : un poste à la fois — deux clics ne demandent pas deux paiements.
  const prise = await prisma.adProItem.updateMany({
    where: { id, updatedAt: poste.updatedAt, expenseOrderId: poste.expenseOrderId, status: "APPROVED", depenseAnnuleeLe: null, depenseImputeeLe: { not: null } },
    data: { orderStage: "ISSUED", updatedById: user.id },
  });
  if (prise.count === 0) return { ok: false, error: "Cette dépense vient de changer (déjà consommée ?) : rechargez la page." };

  let factureId: string | null = null;
  let ordreNe = false;
  try {
    if (fichier) {
      const bcSigne = lue.bcs.find((b) => b.signeLe) ?? null;
      const facture = await prisma.legalDocument.create({
        data: {
          title: `Facture — ${ITEM_KIND_LABELS[poste.kind]} : ${poste.label} (${op.ref})`,
          kind: "INVOICE", direction: "OUT", amount: montant,
          counterparty: bcSigne?.fournisseur ?? poste.supplier ?? op.beneficiaire,
          companyId: op.companyId,
          sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
          chainFromId: bcSigne?.id ?? null,
          createdById: user.id, updatedById: user.id,
          notes: `Facture du poste « ${poste.label} » de ${op.ref}, jointe à sa consommation (Budget Marketing).`,
        },
        select: { id: true },
      });
      factureId = facture.id;
      const depot = await persistUploadedDocument(user.id, {
        entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: fichier,
      });
      if (!depot.ok) throw new Error(depot.error ?? "Dépôt de la facture impossible.");
      await rattacherPieceAuPoste({ itemId: id, legalDocumentId: facture.id, nature: "FACTURE", acteurId: user.id });
    }
    const ordre = await createExpenseOrder({
      label: `${op.ref} — ${ITEM_KIND_LABELS[poste.kind]} : ${poste.label}`,
      amount: montant,
      category: "EVENEMENT",
      beneficiary: poste.supplier ?? op.beneficiaire,
      sourceType: PARENT_ENTITE[owner.parent],
      sourceId: owner.id,
      requestedById: user.id,
      budgetCategoryId: poste.budgetCategoryId,
      requiresInvoice: facturePourPayer(poste.kind),
      notes: `Dépense consommée depuis le Budget Marketing — poste de l'opération ${op.ref}, ${fichier ? "facture jointe" : "facture à joindre avant le règlement"}.`
        + (montant < lue.depense.montantEngage - 0.005 ? ` ${dzd(lue.depense.montantEngage - montant)} rendus au budget (engagé : ${dzd(lue.depense.montantEngage)}).` : ""),
    });
    ordreNe = true;
    await prisma.adProItem.update({ where: { id }, data: { expenseOrderId: ordre.id, orderStage: "ISSUED", updatedById: user.id } });
    if (factureId) await prisma.legalDocument.update({ where: { id: factureId }, data: { expenseOrderId: ordre.id } });
    const rendu = lue.depense.montantEngage - montant;
    await journal(user, id, "depense-consommation",
      `Dépense du poste « ${poste.label} » consommée : ${dzd(montant)} sur « ${nomCategorie(actuelle)} »${rendu > 0.5 ? `, ${dzd(rendu)} rendus au budget` : ""} — ordre ${ordre.reference}, au centre de paiement${fichier ? ", facture jointe" : ", sans facture pour l'instant"}.`,
      null, String(montant));
    for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, legalDocumentId: factureId, ordreIds: [ordre.id], acteurId: user.id });
    revalider(owner);
    revalidatePath("/finances/paiements-a-faire");
    const avertissement = garde.probables.map((p) => p.phrase).join(" ");
    return {
      ok: true, id: ordre.id, message: `Consommée : ${dzd(montant)}. Envoyée au centre de paiement (${ordre.reference}).${avertissement ? ` ${avertissement}` : ""}`,
      ...(avertissement ? { avertissement } : {}),
    };
  } catch (err) {
    console.error("[budget-marketing] consommation impossible", err);
    if (!ordreNe) {
      await prisma.adProItem.updateMany({ where: { id, expenseOrderId: poste.expenseOrderId, orderStage: "ISSUED" }, data: { orderStage: poste.orderStage } }).catch(sansBloquer("budget-depense-poste-actions.consommerDepensePoste.adProItem"));
      if (factureId) await prisma.legalDocument.updateMany({ where: { id: factureId }, data: { status: "CANCELLED" } }).catch(sansBloquer("budget-depense-poste-actions.consommerDepensePoste.legalDocument"));
    }
    return { ok: false, error: "La consommation n'a pas pu être enregistrée." };
  }
}

/** ANNULER une dépense engagée : l'engagement est libéré (motif facultatif). Refusé une fois consommée. */
export async function annulerDepensePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const lu = await lirePoste(id);
  if (!lu) return { ok: false, error: "Poste introuvable." };
  if (lu.poste.montantPayeHistorique != null) return { ok: false, error: REFUS_HISTORIQUE };
  const { poste, owner, lue } = lu;
  const actuelle = await categorie(poste.budgetCategoryId);
  if (!actuelle || !canManageEnvelope(user, actuelle.envelope)) return { ok: false, error: REFUS_DROIT };
  const refus = refusAnnulation(lue.depense.etat);
  if (refus) return { ok: false, error: refus };
  const motif = fdStr(formData, "motif")?.slice(0, MOTIF_MAX) ?? null;
  const fait = await prisma.adProItem.updateMany({
    where: { id, updatedAt: poste.updatedAt, expenseOrderId: poste.expenseOrderId, depenseAnnuleeLe: null, depenseImputeeLe: { not: null } },
    data: { depenseAnnuleeLe: new Date(), depenseAnnuleeParId: user.id, depenseAnnulationMotif: motif, updatedById: user.id },
  });
  if (fait.count === 0) return { ok: false, error: CHANGE };
  await journal(user, id, "depense-annulation",
    `Dépense du poste « ${poste.label} » annulée : l'engagement de ${dzd(lue.depense.montantEngage)} sur « ${nomCategorie(actuelle)} » est libéré${motif ? ` — motif : ${motif}` : ""}.`,
    null, motif);
  revalider(owner);
  return { ok: true, id, message: `Dépense annulée : ${dzd(lue.depense.montantEngage)} rendus au budget.` };
}
