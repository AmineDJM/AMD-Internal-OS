import { companyIdForNew } from "@/lib/company";
import { sansBloquer } from "@/lib/journal";
import { expect } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { annulerGeste } from "@/lib/effets/annulation";
import { decideApproval, finishRequest } from "@/lib/actions/admin-request-actions";
import { decideCareQuote } from "@/modules/ad-pro/actions-prise-en-charge";
import { requestSlipPayment, validateDeclarationByDirection } from "@/lib/actions/medical-info-actions";
import { emettreAvoir, emettrePieceCommerciale } from "@/lib/actions/fabrique-actions";
import { emettreDocumentDrive } from "@/platform/ia/artifact/factory";
import { totauxAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { aLEcran, cycle, fd, outilsDeTest, type CasReversible } from "./banc";

/**
 * K10b (décision 0040) — LES CAS « EXÉCUTER PUIS ANNULER » DES DÉCISIONS ET DES PIÈCES : une décision qui fait naître un
 * ordre de dépense (l'annuler le retire ; payé entre-temps, l'annulation est refusée en entier), une imputation au
 * budget, une pièce numérotée (annulée, jamais effacée : son numéro reste consommé). Joués par `communications.test.ts`.
 */

const ANNEE = new Date().getUTCFullYear();
const alea = () => Math.random().toString(36).slice(2, 8);
const ordresDe = (sourceId: string) => prisma.expenseOrder.findMany({ where: { sourceId }, select: { id: true, status: true }, orderBy: { id: "asc" } });

// ── DEMANDES ADMINISTRATIVES ─────────────────────────────────────────────────────────────────

/** Une demande ouverte et son approbation CHIFFRÉE en attente, adressée à la personne du banc. */
async function approbationChiffree(moi: CurrentUser, tag: string) {
  const req = await prisma.administrativeRequest.create({ data: { reference: `${tag}REQ-${alea()}`, title: `${tag} achat`, type: "OTHER", status: "IN_PROGRESS", companyId: await companyIdForNew(moi.id), createdById: moi.id } });
  const a = await prisma.adminApproval.create({ data: { requestId: req.id, validatorId: moi.id, requestedById: moi.id, amount: 12_000 } });
  return { requestId: req.id, approvalId: a.id };
}
const lireDecision = async (requestId: string, approvalId: string) => ({
  approbation: await prisma.adminApproval.findUnique({ where: { id: approvalId }, select: { status: true, decidedById: true, decidedAt: true, decisionNote: true } }),
  demande: (await prisma.administrativeRequest.findUnique({ where: { id: requestId }, select: { status: true } }))?.status,
  ordres: await ordresDe(requestId),
});

const DEMANDES: CasReversible[] = [
  { id: "admin-request-actions:decideApproval", titre: "l'accord chiffré retiré : l'approbation revient en attente, l'ordre de dépense né est retiré", jouer: async (moi, tag) => {
    const { requestId, approvalId } = await approbationChiffree(moi, tag);
    await cycle({ id: "admin-request-actions:decideApproval", moi, faire: () => decideApproval(fd({ approvalId, decision: "APPROVED" })), lire: () => lireDecision(requestId, approvalId) });
  } },
  { id: "admin-request-actions:decideApproval", titre: "TOUT OU RIEN : l'ordre né est payé depuis — l'annulation est refusée et rien ne bouge", jouer: async (moi, tag) => {
    const { requestId, approvalId } = await approbationChiffree(moi, tag);
    const debut = new Date();
    const r = await aLEcran(moi, () => decideApproval(fd({ approvalId, decision: "APPROVED" })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [ordre] = await ordresDe(requestId);
    await outilsDeTest.payerOrdre!(ordre!.id, moi.id);
    const avant = await lireDecision(requestId, approvalId);
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: moi.id, capaciteId: "admin-request-actions:decideApproval", creeLe: { gte: debut } }, orderBy: { creeLe: "desc" } });
    const compte = await annulerGeste(g.id, moi);
    expect("refus" in compte, JSON.stringify(compte)).toBe(true);
    // Le refus nomme l'ordre réglé (son statut a changé depuis le geste).
    expect((compte as { refus: string }).refus).toMatch(/^Rien n'est annulé : .*ordre de dépense.*« status »/);
    expect(await lireDecision(requestId, approvalId), "un refus n'écrit rien").toEqual(avant);
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g.id } })).annuleLe, "le geste n'est pas marqué annulé").toBeNull();
  } },
  { id: "admin-request-actions:finishRequest", titre: "la demande terminée rouvre, l'imputation au budget du département est remise", jouer: async (moi, tag) => {
    const dept = await prisma.department.create({ data: { name: `${tag} Moyens généraux`, code: `${tag}MG${alea()}` } });
    const req = await prisma.administrativeRequest.create({ data: { reference: `${tag}REQ-${alea()}`, title: `${tag} fournitures`, type: "OTHER", status: "IN_PROGRESS", assignedToId: moi.id, companyId: await companyIdForNew(moi.id), createdById: moi.id } });
    await cycle({ id: "admin-request-actions:finishRequest", moi,
      faire: () => finishRequest(fd({ id: req.id, budgetDepartmentId: dept.id, budgetAmount: "8500" })),
      lire: async () => ({
        demande: await prisma.administrativeRequest.findUnique({ where: { id: req.id }, select: { status: true, completedAt: true, archivedNodeId: true } }),
        imputations: await prisma.departmentBudgetExpense.findMany({ where: { departmentId: dept.id }, select: { id: true, amount: true, adminRequestId: true } }),
      }) });
  } },
];

const nettoyerDemandes = async (tag: string) => {
  const demandes = (await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: tag } }, select: { id: true, archivedNodeId: true } }).catch(sansBloquer("banc-k10b.cas-decisions", [])));
  const ids = demandes.map((d) => d.id);
  await prisma.departmentBudgetExpense.deleteMany({ where: { adminRequestId: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.department.deleteMany({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.adminApproval.deleteMany({ where: { requestId: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.administrativeRequest.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
};

// ── PRISE EN CHARGE (Ad & Pro) ───────────────────────────────────────────────────────────────

const PRISE_EN_CHARGE: CasReversible[] = [
  { id: "care-actions:decideCareQuote", titre: "le devis accepté revient en attente, ses cases aussi, l'ordre de dépense né est retiré", jouer: async (moi, tag) => {
    // Une demande internationale prévalidée, une personne accordée, un hôtel, une enveloppe et sa catégorie, un devis retenu.
    const intId = (await prisma.congressInternational.create({ data: { name: `${tag}Int`, requestStatus: "APPROVED", requesterId: moi.id, usdDzdRate: 240 } })).id;
    const personne = (await prisma.careBeneficiary.create({ data: { congressInternationalId: intId, firstName: "Nora", lastName: `${tag}Voyageuse`, status: "APPROVED" } })).id;
    const hotel = (await prisma.careCell.create({ data: { beneficiaryId: personne, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Paris", currency: "USD" } })).id;
    const env = await prisma.budgetEnvelope.create({ data: { name: `${tag}Enveloppe`, modules: ["CONGRESS_INTERNATIONAL"], periodStart: new Date(`${ANNEE}-01-01`), periodEnd: new Date(`${ANNEE}-12-31`), totalAmount: 10_000_000 } });
    const cat = await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${tag}Congrès`, module: "CONGRESS_INTERNATIONAL", allocated: 5_000_000 } });
    const quoteId = (await prisma.careQuote.create({
      data: { congressInternationalId: intId, supplier: `${tag}Hôtel`, amountDzd: 120_000, amount: 500, currency: "USD", retainedAt: new Date(), retainedById: moi.id, cells: { create: [{ cellId: hotel }] } },
    })).id;
    await cycle({ id: "care-actions:decideCareQuote", moi,
      faire: () => decideCareQuote(undefined, fd({ id: quoteId, decision: "ACCEPTED", budgetCategoryId: cat.id })),
      lire: async () => ({
        devis: await prisma.careQuote.findUnique({ where: { id: quoteId }, select: { status: true, decidedById: true, decidedAt: true, expenseOrderId: true } }),
        cases: await prisma.careCell.findMany({ where: { id: hotel }, select: { status: true, quoteId: true, expenseOrderId: true } }),
        ordres: await ordresDe(intId),
      }) });
  } },
];

const nettoyerPriseEnCharge = async (tag: string) => {
  const ints = (await prisma.congressInternational.findMany({ where: { name: { startsWith: tag } }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((c) => c.id);
  await prisma.careQuote.deleteMany({ where: { congressInternationalId: { in: ints } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.careBeneficiary.deleteMany({ where: { congressInternationalId: { in: ints } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: ints } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ints } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.congressInternational.deleteMany({ where: { id: { in: ints } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
};

// ── INFORMATION MÉDICALE ─────────────────────────────────────────────────────────────────────

const declaration = (tag: string, data: { sourceType: "SPONSORING" | "PROMO_MATERIAL"; sourceId: string; status?: "AWAITING_DIRECTION"; amount?: number; pharmacistId?: string }) =>
  prisma.medicalInfoDeclaration.create({ data: { reference: `${tag}DIM-${alea()}`, label: `${tag} dossier`, ...data } });

const INFORMATION_MEDICALE: CasReversible[] = [
  { id: "medical-info-actions:validateDeclarationByDirection", titre: "la validation finale retirée : le dossier revient en attente, l'ordre né et son report sur la source sont défaits", jouer: async (moi, tag) => {
    const spo = await prisma.sponsoringRequest.create({ data: { reference: `${tag}SPO-${alea()}`, institution: `${tag} Hôpital`, type: "Congrès", status: "APPROVED", amountGranted: 30_000 } });
    const d = await declaration(tag, { sourceType: "SPONSORING", sourceId: spo.id, status: "AWAITING_DIRECTION", amount: 30_000 });
    await cycle({ id: "medical-info-actions:validateDeclarationByDirection", moi,
      faire: () => validateDeclarationByDirection(fd({ id: d.id })),
      lire: async () => ({
        dossier: await prisma.medicalInfoDeclaration.findUnique({ where: { id: d.id }, select: { status: true, validatedAt: true, validatedById: true, expenseOrderId: true } }),
        source: (await prisma.sponsoringRequest.findUnique({ where: { id: spo.id }, select: { expenseOrderId: true } }))?.expenseOrderId,
        ordres: await ordresDe(spo.id),
      }) });
  } },
  { id: "medical-info-actions:requestSlipPayment", titre: "la quittance demandée est retirée : le bon redevient à demander, la demande de paiement et son ordre disparaissent", jouer: async (moi, tag) => {
    const d = await declaration(tag, { sourceType: "PROMO_MATERIAL", sourceId: `${tag}pm-${alea()}`, pharmacistId: moi.id });
    const v = await prisma.validationRequest.create({ data: { reference: `${tag}V${alea()}`, module: "Information médicale", title: `${tag} lot`, requesterId: moi.id, status: "APPROVED", entityType: "MEDICAL_INFO_DECLARATION", entityId: d.id } });
    await prisma.medicalInfoDeclaration.update({ where: { id: d.id }, data: { bvValidationId: v.id } });
    const slip = await prisma.medicalInfoSlip.create({ data: { declarationId: d.id, label: `${tag} affiches`, amount: 15_000 } });
    await cycle({ id: "medical-info-actions:requestSlipPayment", moi,
      faire: () => requestSlipPayment(undefined, fd({ slipId: slip.id, amount: "15000" })),
      lire: async () => {
        const demandes = await prisma.paymentRequest.findMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: d.id }, select: { id: true, status: true, expenseOrderId: true } });
        return {
          bon: await prisma.medicalInfoSlip.findUnique({ where: { id: slip.id }, select: { requestId: true, deliveredAt: true } }),
          demandes,
          ordres: await prisma.expenseOrder.count({ where: { id: { in: demandes.map((x) => x.expenseOrderId).filter((x): x is string => !!x) } } }),
        };
      } });
  } },
];

const nettoyerInformationMedicale = async (tag: string) => {
  const ids = (await prisma.medicalInfoDeclaration.findMany({ where: { reference: { startsWith: tag } }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((d) => d.id);
  const spos = (await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: tag } }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((s) => s.id);
  const demandes = await prisma.paymentRequest.findMany({ where: { entityId: { in: ids } }, select: { id: true, expenseOrderId: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []));
  await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: demandes.map((x) => x.id) } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes.map((x) => x.id) } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.sponsoringRequest.updateMany({ where: { id: { in: spos } }, data: { expenseOrderId: null } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.expenseOrder.deleteMany({ where: { OR: [{ id: { in: demandes.map((x) => x.expenseOrderId).filter((x): x is string => !!x) } }, { sourceId: { in: spos } }] } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.medicalInfoSlip.deleteMany({ where: { declarationId: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.comment.deleteMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
};

// ── LA FABRIQUE : PIÈCES NUMÉROTÉES ──────────────────────────────────────────────────────────

/** Une société émettrice, son identité légale complète (la fabrique la reprend sur chaque pièce). */
async function societe(tag: string): Promise<string> {
  const c = await prisma.company.create({ data: { name: `${tag} Pharma ${alea()}`, shortName: `K${alea()}`, color: "#1B7F79" } });
  await outilsDeTest.identiteLegale!(c.id, tag);
  return c.id;
}

/** Les lignes d'un formulaire du composeur, en listes parallèles. */
function lignes(f: FormData, l: { designation: string; quantite: number; prix: number }[]): FormData {
  for (const x of l) {
    f.append("ligneDesignation", x.designation); f.append("ligneDetails", ""); f.append("ligneQuantite", String(x.quantite));
    f.append("lignePrix", String(x.prix)); f.append("ligneRemise", ""); f.append("ligneTva", ""); f.append("ligneSection", "0");
  }
  return f;
}

/** Ce qui doit revenir après l'annulation d'une pièce : aucune pièce ACTIVE de la société (la pièce elle-même reste, annulée). */
const piecesActives = (companyId: string) => prisma.legalDocument.findMany({ where: { companyId, status: { not: "CANCELLED" } }, select: { id: true, reference: true, kind: true } });

const FABRIQUE: CasReversible[] = [
  { id: "fabrique-actions:emettrePieceCommerciale", titre: "la facture émise passe à CANCELLED, son numéro reste consommé", jouer: async (moi, tag) => {
    const companyId = await societe(tag);
    const { apres } = await cycle({ id: "fabrique-actions:emettrePieceCommerciale", moi,
      faire: () => emettrePieceCommerciale(undefined, lignes(fd({ type: "FACTURE", societe: companyId, tiersNom: `${tag} Pharmacie`, tiersAdresse: "Alger", date: `${ANNEE}-09-05`, echeance: `${ANNEE}-10-05`, modePaiement: "VIREMENT" }),
        [{ designation: "Fiches posologiques", quantite: 100, prix: 250 }])),
      lire: () => piecesActives(companyId) });
    const [piece] = apres as { id: string; reference: string }[];
    expect(await prisma.legalDocument.findUnique({ where: { id: piece!.id }, select: { status: true, reference: true } }), "la pièce numérotée reste, annulée, sous son numéro").toEqual({ status: "CANCELLED", reference: piece!.reference });
  } },
  { id: "fabrique-actions:emettreAvoir", titre: "l'avoir émis passe à CANCELLED et ne compte plus dans le net de la facture", jouer: async (moi, tag) => {
    const companyId = await societe(tag);
    const f = await emettreDocumentDrive(moi, { type: "FACTURE", societe: companyId, tiers: { nom: `${tag} Pharmacie A`, adresse: "Alger" }, lignes: [{ designation: "Kakémonos", quantite: 2, prixUnitaire: 9_000 }], date: `${ANNEE}-09-05`, echeance: `${ANNEE}-10-05`, modePaiement: "VIREMENT" });
    if (!f.ok) throw new Error(`facture refusée : ${f.motif}`);
    const { apres } = await cycle({ id: "fabrique-actions:emettreAvoir", moi,
      faire: () => emettreAvoir(undefined, lignes(fd({ factureId: f.legalDocumentId, motif: "Retour d'un kakémono abîmé." }), [{ designation: "Retour d'un kakémono", quantite: 1, prix: 9_000 }])),
      lire: async () => ({ avoirs: (await piecesActives(companyId)).filter((p) => p.kind === "CREDIT_NOTE"), credite: (await totauxAvoirsActifs([f.legalDocumentId])).get(f.legalDocumentId) ?? 0 }) });
    const [avoir] = (apres as { avoirs: { id: string; reference: string }[] }).avoirs;
    expect(await prisma.legalDocument.findUnique({ where: { id: avoir!.id }, select: { status: true, reference: true } })).toEqual({ status: "CANCELLED", reference: avoir!.reference });
  } },
];

const nettoyerFabrique = async (tag: string) => {
  const societes = (await prisma.company.findMany({ where: { name: { startsWith: tag } }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((c) => c.id);
  const comptes = (await prisma.user.findMany({ where: { email: { startsWith: tag } }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((u) => u.id);
  // Par le tiers aussi : un autre ménage du banc retire les sociétés du `tag` avant celui-ci (la pièce perd sa société).
  const pieces = (await prisma.legalDocument.findMany({ where: { OR: [{ companyId: { in: societes } }, { counterparty: { startsWith: tag } }] }, select: { id: true } }).catch(sansBloquer("banc-k10b.cas-decisions", []))).map((p) => p.id);
  await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { chainFromId: null } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: pieces } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: comptes } } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: societes } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
  await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(sansBloquer("banc-k10b.cas-decisions"));
};

const nettoyerDecisions = async (tag: string) => {
  await nettoyerDemandes(tag);
  await nettoyerPriseEnCharge(tag);
  await nettoyerInformationMedicale(tag);
  await nettoyerFabrique(tag);
  // Les notifications nées des décisions (centre de paiement, secrétariat) et les rectificatifs, retirés avec leur lien.
  await prisma.notification.deleteMany({ where: { OR: [{ body: { contains: tag } }, { title: { contains: tag } }] } }).catch(sansBloquer("banc-k10b.cas-decisions"));
};

export const CAS_DECISIONS: CasReversible[] = [
  ...[...DEMANDES, ...PRISE_EN_CHARGE, ...INFORMATION_MEDICALE, ...FABRIQUE].map((c, i) => (i === 0 ? { ...c, nettoyer: nettoyerDecisions } : c)),
];
