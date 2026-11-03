import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS FINANCES — VAGUE 1 (45 ops : budgets, caisse d'avance, ordres, demandes de
 * paiement, écritures/factures, paie). Tout se joue à la PROPOSITION (aucune exécution ici —
 * les actions canoniques ont leurs propres tests) : résolution par nom/référence avec
 * ambiguïté LISTÉE, FUSION des updates (les champs non cités sont REJOUÉS à l'identique —
 * accès d'enveloppe, statut de facture, plan de caisse compris), suppressions CRITIQUES à
 * ressaisie, décisions motivées, portes du catalogue (Super Admin seul pour la matrice
 * d'accès budgets).
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__opsfin__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let finId = "";
let colleagueId = "";
let validatorId = "";
let envelopeId = "";
let categoryId = "";
let cashVentesId = "";
let paymentReqId = "";
let pieceId = "";
let employeeId = "";

const fin = () => userWith({ FINANCES: ["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE"], VALIDATIONS: ["VIEW", "CREATE"] }, "FINANCE_BUDGET_MANAGER", finId, `${TAG} Nadia`);
const budget = () => userWith({ BUDGETS: ["VIEW", "CREATE", "UPDATE", "DELETE"] }, "FINANCE_BUDGET_MANAGER", finId, `${TAG} Nadia`);
const sa = () => userWith({}, "SUPER_ADMIN", finId, `${TAG} Nadia`);
const rh = () => userWith({ RH: ["VIEW", "UPDATE"] }, "FINANCE_BUDGET_MANAGER", finId, `${TAG} Nadia`);
const outsider = () => userWith({ WORKSPACE: ["VIEW"] }, "MEDICAL_DELEGATE", colleagueId, `${TAG} Sara`);

suite("ops FINANCES vague 1 — budgets, caisse, paiements, écritures, paie (goldens)", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.paymentPiece.deleteMany({ where: { request: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.payrollEntry.deleteMany({ where: { employee: { fullName: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.budgetExpenseLine.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.pettyCashPlan.deleteMany({ where: { department: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { department: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [f, c, v] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Nadia`, email: `${TAG}f@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
      prisma.user.create({ data: { name: `${TAG} Sara`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.user.create({ data: { name: `${TAG} Yacine`, email: `${TAG}v@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    finId = f.id; colleagueId = c.id; validatorId = v.id;

    // Budgets : enveloppe AVEC accès non vides (la FUSION doit les rejouer), catégorie, dépense.
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG} Fonctionnement`, totalAmount: 8_000_000,
        periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"),
        modules: ["FINANCES"], accessUserIds: [c.id], managerUserIds: [f.id],
      },
    });
    envelopeId = env.id;
    const cat = await prisma.budgetCategoryLine.create({
      data: { envelopeId: env.id, name: `${TAG} Salaires`, allocated: 5_000_000 },
    });
    categoryId = cat.id;
    await prisma.budgetExpenseLine.create({
      data: { categoryId: cat.id, reference: `${TAG} Achat licences`, amount: 120_000 },
    });

    // Caisse d'avance : Ventes = ALLOTTED (confirmable, rallongeable) + plan mensuel réglé ;
    // Médical = RECEIVED (dépensable → rallonge demandable, soldable).
    const ventes = await prisma.department.create({ data: { name: `${TAG} Ventes`, code: `${TAG}-VTE` } });
    const medical = await prisma.department.create({ data: { name: `${TAG} Médical`, code: `${TAG}-MED` } });
    const cashV = await prisma.pettyCashAllotment.create({
      data: { departmentId: ventes.id, period: "2026-08", amount: 60_000, holderId: c.id },
    });
    cashVentesId = cashV.id;
    await prisma.pettyCashAllotment.create({
      data: { departmentId: medical.id, period: "2026-08", amount: 40_000, holderId: c.id, status: "RECEIVED" },
    });
    await prisma.pettyCashPlan.create({
      data: { departmentId: ventes.id, monthlyAmount: 40_000, rechargeDay: 5, holderId: c.id, isActive: true },
    });

    // Ordre de dépense + demande de paiement avec UNE pièce nommée.
    await prisma.expenseOrder.create({
      data: { reference: `${TAG}-OD-9`, label: `${TAG} Achat serveurs`, amount: 480_000, status: "PENDING" },
    });
    const req = await prisma.paymentRequest.create({
      data: {
        reference: `${TAG}-PAY-1`, title: `${TAG} Règlement imprimeur`, amount: 350_000,
        payee: "Imprimerie du Centre", status: "SUBMITTED", requesterId: f.id,
      },
    });
    paymentReqId = req.id;
    const doc = await prisma.document.create({
      data: {
        name: `${TAG} Facture fournisseur.pdf`, entityType: "PAYMENT_REQUEST", entityId: req.id,
        category: "INVOICE", fileKey: `${TAG}/facture.pdf`, confidentiality: "INTERNAL", uploadedById: f.id,
      },
    });
    const piece = await prisma.paymentPiece.create({
      data: { requestId: req.id, documentId: doc.id, kind: "INVOICE", position: 0, createdById: f.id },
    });
    pieceId = piece.id;

    // Écritures, compte de trésorerie, facture.
    await prisma.financeTransaction.create({
      data: {
        reference: `${TAG}-FIN-1`, date: new Date("2026-08-05"), direction: "OUT", category: "LOYER",
        label: `${TAG} Loyer dépôt`, amount: 900_000, method: "BANK_TRANSFER", account: "Banque", status: "SETTLED",
        counterparty: "SCI El Qods",
      },
    });
    await prisma.treasuryAccount.create({ data: { name: `${TAG} Banque BNA`, openingBalance: 2_000_000 } });
    // Une facture est un DOCUMENT LÉGAL de nature « facture » : sans `paidDate`, elle est à régler.
    await prisma.legalDocument.create({
      data: { title: `${TAG} Maintenance clim`, kind: "INVOICE", direction: "OUT", amount: 75_000 },
    });

    // Paie : année atypique 2031 pour des décomptes EXACTS (aucune autre ligne ne matche).
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} Samir Hadjout`, baseSalary: 150_000 } });
    employeeId = emp.id;
    await prisma.payrollEntry.create({
      data: { employeeId: emp.id, year: 2031, month: 6, gross: 150_000, net: 150_000, status: "DRAFT" },
    });
    await prisma.payrollEntry.create({
      data: { employeeId: emp.id, year: 2031, month: 7, gross: 150_000, net: 130_000, employerCost: 190_000, status: "PAID", paidDate: new Date() },
    });
  });


  describe("budgets — enveloppes, catégories, imputations (FUSION, CRITIQUE)", () => {
    it("create_envelope : nom + montant proposés, porte BUDGETS", async () => {
      const p = await buildProposal("finance_operation", { op: "create_envelope", name: `${TAG} Événementiel`, amount: "2 500 000" }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("Événementiel");
      expect(domainArgs(p).totalAmount).toBe("2500000");

      const refused = await buildProposal("finance_operation", { op: "create_envelope", name: "X" }, outsider());
      expect("error" in refused).toBe(true);
    });

    it("update_envelope : FUSION INTÉGRALE — changer le montant REJOUE nom, modules, accès et l'état actif", async () => {
      const p = await buildProposal("finance_operation", { op: "update_envelope", envelope: `${TAG} Fonctionnement`, amount: "9000000" }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.name).toBe(`${TAG} Fonctionnement`);
      expect(args.totalAmount).toBe("9000000");
      expect(args.modules).toBe("FINANCES");
      expect(args.accessUserIds).toBe(colleagueId);
      expect(args.managerUserIds).toBe(finId);
      expect(args.isActive).toBe("1");
    });

    it("delete_envelope : CRITIQUE — ressaisie du NOM exact", async () => {
      const p = await buildProposal("finance_operation", { op: "delete_envelope", envelope: `${TAG} Fonctionnement` }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.level).toBe("CRITICAL");
      expect(p.confirmText).toBe(`${TAG} Fonctionnement`);
    });

    it("create_budget_category : l'enveloppe se résout par nom ; update = FUSION (alloué seul)", async () => {
      const p = await buildProposal("finance_operation", { op: "create_budget_category", envelope: `${TAG} Fonctionnement`, name: `${TAG} Loyers`, amount: "1200000" }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).envelopeId).toBe(envelopeId);

      const u = await buildProposal("finance_operation", { op: "update_budget_category", category: `${TAG} Salaires`, amount: "5500000" }, budget());
      expect("error" in u).toBe(false);
      if ("error" in u) return;
      expect(domainArgs(u).name).toBe(`${TAG} Salaires`);
      expect(domainArgs(u).allocated).toBe("5500000");
      expect(domainArgs(u).id).toBe(categoryId);
    });

    it("attribute_transaction : « aucune » RETIRE l'imputation (budgetCategoryId null)", async () => {
      const p = await buildProposal("finance_operation", { op: "attribute_transaction", transaction: `${TAG} Loyer dépôt`, category: "aucune" }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).budgetCategoryId).toBeNull();
      expect(p.title).toContain("aucune catégorie");
    });

    it("update_budget_expense : FUSION — nouveau montant, référence conservée ; delete = CRITIQUE (référence)", async () => {
      const u = await buildProposal("finance_operation", { op: "update_budget_expense", expense: `${TAG} Achat licences`, amount: "150000" }, budget());
      expect("error" in u).toBe(false);
      if ("error" in u) return;
      expect(domainArgs(u).reference).toBe(`${TAG} Achat licences`);
      expect(domainArgs(u).amount).toBe("150000");

      const d = await buildProposal("finance_operation", { op: "delete_budget_expense", expense: `${TAG} Achat licences` }, budget());
      expect("error" in d).toBe(false);
      if ("error" in d) return;
      expect(d.level).toBe("CRITICAL");
      expect(d.confirmText).toBe(`${TAG} Achat licences`);
    });

    it("set_department_budget_access : SUPER ADMIN SEUL — ajout ciblé d'une personne sur une nature, matrice rejouée", async () => {
      const p = await buildProposal("finance_operation", {
        op: "set_department_budget_access", department: `${TAG} Ventes`, person: `${TAG} Sara`, nature: "activité",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).activityUserIds).toContain(colleagueId);
      expect(p.warnings.join(" ")).toMatch(/REMPLACÉE/);

      const refused = await buildProposal("finance_operation", {
        op: "set_department_budget_access", department: `${TAG} Ventes`, person: `${TAG} Sara`, nature: "activité",
      }, budget());
      expect("error" in refused).toBe(true);
    });

    it("set_department_budget : nature FR → enum (moyens généraux = OPERATING) ; demande SANS motif refusée", async () => {
      const p = await buildProposal("finance_operation", {
        op: "set_department_budget", department: `${TAG} Ventes`, kind: "moyens généraux", amount: "800000",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).kind).toBe("OPERATING");

      const noReason = await buildProposal("finance_operation", {
        op: "request_department_budget", department: `${TAG} Ventes`, kind: "activité", amount: "500000",
      }, sa());
      expect("error" in noReason && noReason.error).toMatch(/motif/);
    });
  });

  describe("caisse d'avance — dotation, réception, rallonge, plan mensuel", () => {
    it("allot_petty_cash : LA REMISE S'AJOUTE AU FOND — aucun mois n'est clos, et la détentrice se reprend", async () => {
      // La caisse est CONTINUE. Remettre une somme en août puis en septembre ne fusionne rien et
      // ne clôt rien : ce sont deux remises datées, et le mois n'a plus de rôle. La proposition
      // le DIT, et ne redemande pas une détentrice qui n'a pas changé.
      const p = await buildProposal("finance_operation", {
        op: "allot_petty_cash", department: `${TAG} Ventes`, amount: "20000", period: "2026-08",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("Remettre");
      expect(p.warnings.join(" ")).toMatch(/S'AJOUTE au fond/);
      // ET ELLE PASSE PAR LE CENTRE (§118.176) : « l'argent est réputé remis » était faux dès lors.
      expect(p.warnings.join(" ")).toMatch(/CENTRE DE PAIEMENT/);
      expect(p.warnings.join(" ")).not.toMatch(/réputé remis/);

      // Un « nouveau mois » ne redemande plus la détentrice : elle est reprise du fond en cours.
      const autreMois = await buildProposal("finance_operation", {
        op: "allot_petty_cash", department: `${TAG} Ventes`, amount: "20000", period: "2026-09",
      }, sa());
      expect("error" in autreMois).toBe(false);
      if ("error" in autreMois) return;
      expect(autreMois.title).toContain("Remettre");
    });

    it("confirm_petty_cash_receipt : la caisse ALLOTTED se résout par département + période FR (« août 2026 »)", async () => {
      const p = await buildProposal("finance_operation", {
        op: "confirm_petty_cash_receipt", department: `${TAG} Ventes`, period: "août 2026",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(cashVentesId);
    });

    it("request_petty_cash_topup : sur la caisse RECEIVED, montant + motif rejoués", async () => {
      const p = await buildProposal("finance_operation", {
        op: "request_petty_cash_topup", department: `${TAG} Médical`, amount: "15000", reason: "Fin de mois chargée",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(JSON.stringify(p.fields)).toContain("Fin de mois chargée");
    });

    it("set_petty_cash_plan : FUSION avec le plan existant — corriger le montant CONSERVE jour et détentrice", async () => {
      const p = await buildProposal("finance_operation", {
        op: "set_petty_cash_plan", department: `${TAG} Ventes`, amount: "45000",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.monthlyAmount).toBe("45000");
      expect(args.rechargeDay).toBe("5");
      expect(args.holderId).toBe(colleagueId);
      expect(args.isActive).toBe("1");
    });
  });

  describe("demandes de paiement — dossier, décisions motivées, pièces par nom", () => {
    it("create_payment_request : bénéficiaire + montant obligatoires, urgence FR, brouillon sur demande", async () => {
      const p = await buildProposal("finance_operation", {
        op: "create_payment_request", label: `${TAG} Achat réactifs`, payee: "BioSupply", amount: "220000", urgency: "urgent", mode: "brouillon",
      }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.urgency).toBe("URGENT");
      expect(args.submit).toBe("0");

      const noPayee = await buildProposal("finance_operation", { op: "create_payment_request", label: "X", amount: "1000" }, fin());
      expect("error" in noPayee && noPayee.error).toMatch(/bénéficiaire/);
    });

    it("decide_payment_request : « bon à payer » → APPROVE avec l'avertissement Centre de paiement ; refus/attente NON MOTIVÉS refusés", async () => {
      const p = await buildProposal("finance_operation", {
        op: "decide_payment_request", reference: `${TAG}-PAY-1`, decision: "bon à payer",
      }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).move).toBe("APPROVE");
      expect(p.warnings.join(" ")).toMatch(/Centre de paiement/);

      const holdNoNote = await buildProposal("finance_operation", { op: "decide_payment_request", reference: `${TAG}-PAY-1`, decision: "mets en attente" }, fin());
      expect("error" in holdNoNote && holdNoNote.error).toMatch(/motive/);
      const rejectNoNote = await buildProposal("finance_operation", { op: "decide_payment_request", reference: `${TAG}-PAY-1`, decision: "refuse" }, fin());
      expect("error" in rejectNoNote && rejectNoNote.error).toMatch(/motive/);
    });

    it("review_payment_piece : la pièce se résout par NOM ; mise en cause SANS motif refusée", async () => {
      const noNote = await buildProposal("finance_operation", {
        op: "review_payment_piece", reference: `${TAG}-PAY-1`, piece: "Facture fournisseur", verdict: "à revoir",
      }, fin());
      expect("error" in noNote && noNote.error).toMatch(/ne va pas/);

      const p = await buildProposal("finance_operation", {
        op: "review_payment_piece", reference: `${TAG}-PAY-1`, piece: "Facture fournisseur", verdict: "à revoir", note: "Le montant TTC ne correspond pas au devis.",
      }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).pieceId).toBe(pieceId);
      expect(domainArgs(p).verdict).toBe("CHANGES_REQUESTED");
    });

    it("PLUS DE DEMANDE DE VALIDATION sur un paiement — le centre l'a déjà autorisé", async () => {
      // Les deux ops ont été supprimées avec leurs actions : un dossier n'atteint les Finances que
      // parce que le centre l'a autorisé, et faire valider ce qui vient d'être validé n'aboutit
      // nulle part. Retirer le bouton sans retirer l'op aurait laissé une porte à l'assistant.
      for (const op of ["ask_payment_validation", "ask_piece_validation"]) {
        const p = await buildProposal("finance_operation", { op, reference: `${TAG}-PAY-1` }, fin());
        expect("error" in p, op).toBe(true);
      }
    });

    it("add_payment_comment : message OBLIGATOIRE ; submit/cancel se proposent sur le dossier résolu", async () => {
      const noMsg = await buildProposal("finance_operation", { op: "add_payment_comment", reference: `${TAG}-PAY-1` }, fin());
      expect("error" in noMsg && noMsg.error).toMatch(/message/);

      const cancel = await buildProposal("finance_operation", { op: "cancel_payment_request", reference: `${TAG}-PAY-1` }, fin());
      expect("error" in cancel).toBe(false);
      if (!("error" in cancel)) expect(domainArgs(cancel).id).toBe(paymentReqId);
    });
  });

  describe("écritures, comptes, factures — FUSION et CRITIQUE", () => {
    it("update_transaction : FUSION — nouveau montant seul, libellé/catégorie/compte REJOUÉS", async () => {
      const p = await buildProposal("finance_operation", { op: "update_transaction", reference: `${TAG}-FIN-1`, amount: "950000" }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.label).toBe(`${TAG} Loyer dépôt`);
      expect(args.category).toBe("LOYER");
      expect(args.account).toBe("Banque");
      expect(args.counterparty).toBe("SCI El Qods");
      expect(args.amount).toBe("950000");
    });

    it("delete_transaction / delete_treasury_account : CRITIQUES — ressaisie référence / nom", async () => {
      const t = await buildProposal("finance_operation", { op: "delete_transaction", reference: `${TAG}-FIN-1` }, fin());
      expect("error" in t).toBe(false);
      if (!("error" in t)) {
        expect(t.level).toBe("CRITICAL");
        expect(t.confirmText).toBe(`${TAG}-FIN-1`);
      }
      const a = await buildProposal("finance_operation", { op: "delete_treasury_account", account: `${TAG} Banque BNA` }, fin());
      expect("error" in a).toBe(false);
      if (!("error" in a)) {
        expect(a.level).toBe("CRITICAL");
        expect(a.confirmText).toBe(`${TAG} Banque BNA`);
      }
    });

    it("update_invoice : FUSION — l'échéance seule change, titre ET RÈGLEMENT existants rejoués ; delete = CRITIQUE", async () => {
      const p = await buildProposal("finance_operation", { op: "update_invoice", label: `${TAG} Maintenance clim`, dueDate: "2026-10-15" }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const args = domainArgs(p);
      expect(args.title).toBe(`${TAG} Maintenance clim`);
      // LE RÈGLEMENT EST REJOUÉ À L'IDENTIQUE (ici : aucun). Sans lui, corriger une échéance
      // effacerait la date de paiement d'une facture réglée — et RETIRERAIT son écriture du
      // livre au passage. Le statut, lui, ne se rejoue plus : il n'existe plus.
      expect(args.paidDate).toBeNull();
      expect(args.status).toBeUndefined();
      expect(args.dueDate).toBe("2026-10-15");

      const d = await buildProposal("finance_operation", { op: "delete_invoice", label: `${TAG} Maintenance clim` }, fin());
      expect("error" in d).toBe(false);
      if (!("error" in d)) expect(d.confirmText).toBe(`${TAG} Maintenance clim`);
    });
  });

  describe("paie — bulletins, paie RH (coût employeur), transfert budget", () => {
    it("create_payroll : net calculé (brut + primes − retenues), employé du registre de paie résolu", async () => {
      const p = await buildProposal("finance_operation", {
        op: "create_payroll", employee: `${TAG} Samir`, gross: "150000", bonuses: "10000", deductions: "5000", month: "septembre", year: "2031",
      }, fin());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).employeeId).toBe(employeeId);
      expect(JSON.stringify(p.fields)).toMatch(/155.000.DZD/);
    });

    it("pay_payroll N'EXISTE PLUS (§118.176) : régler un bulletin sortait l'argent du livre sans le centre de paiement", async () => {
      // Une op qui inscrivait l'écriture SALAIRE d'un bulletin, côté Finances : la seconde porte de
      // la paie, à côté de celle que le centre garde. La paie part au centre depuis RH › Paie.
      const p = await buildProposal("finance_operation", { op: "pay_payroll", employee: `${TAG} Samir`, month: "juin", year: "2031" }, fin());
      expect("error" in p).toBe(true);
    });

    it("mark_salary_paid : coût employeur et net OBLIGATOIRES et cohérents ; mois FR accepté", async () => {
      const noCost = await buildProposal("finance_operation", { op: "mark_salary_paid", employee: `${TAG} Samir`, net: "130000", month: "août", year: "2031" }, rh());
      expect("error" in noCost && noCost.error).toMatch(/coût employeur/);
      const inverted = await buildProposal("finance_operation", { op: "mark_salary_paid", employee: `${TAG} Samir`, employerCost: "100000", net: "130000", month: "août", year: "2031" }, rh());
      expect("error" in inverted && inverted.error).toMatch(/dépasser/);

      const p = await buildProposal("finance_operation", {
        op: "mark_salary_paid", employee: `${TAG} Samir`, employerCost: "190000", net: "130000", month: "août", year: "2031",
      }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).month).toBe("8");
      expect(domainArgs(p).employerCost).toBe("190000");
    });

    it("unmark_salary_paid : seule la ligne PAYÉE non transférée se résout (correction d'erreur)", async () => {
      const p = await buildProposal("finance_operation", { op: "unmark_salary_paid", employee: `${TAG} Samir`, month: "juillet", year: "2031" }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.title).toContain("Annuler");
      expect(JSON.stringify(p.fields)).toMatch(/130.000.DZD/);
    });

    it("transfer_payroll_to_budget N'EXISTE PLUS (§118.176) : la paie part au centre de paiement, jamais par une écriture par salarié", async () => {
      // Le transfert écrivait un décaissement par salarié sans que le centre l'ait vu — le chemin
      // que la Direction a fermé. L'envoi au centre est un geste d'écran (RH › Paie) ; une op qui
      // le rouvrirait ferait sortir la paie deux fois du livre.
      const p = await buildProposal("finance_operation", {
        op: "transfer_payroll_to_budget", month: "juillet", year: "2031", category: `${TAG} Salaires`,
      }, rh());
      expect("error" in p).toBe(true);
    });

    it("mark_salary_paid DIT que la saisie n'est pas le versement : le virement passe par le centre", async () => {
      const p = await buildProposal("finance_operation", {
        op: "mark_salary_paid", employee: `${TAG} Samir`, employerCost: "190000", net: "130000", month: "août", year: "2031",
      }, rh());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.warnings.join(" ")).toMatch(/centre de paiement/);
      expect(p.warnings.join(" ")).not.toMatch(/TRANSFERT du mois/);
    });
  });

  describe("ordres, lignes budgétaires, centre de paiement", () => {
    it("defer_payment : la DATE est obligatoire, et la proposition DIT ce que l'action exigera", async () => {
      // Sans date, ce n'est pas un report, c'est un oubli qui porte un nom : l'op refuse, parce
      // qu'un argument manque — pas parce qu'elle rejoue la règle métier.
      const sansDate = await buildProposal("finance_operation", { op: "defer_payment", reference: `${TAG}-OD-9` }, fin());
      expect("error" in sansDate && sansDate.error).toMatch(/date/i);

      const dans30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const p = await buildProposal("finance_operation", { op: "defer_payment", reference: `${TAG}-OD-9`, date: dans30, reason: "Trésorerie" }, fin());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(JSON.stringify(p.fields)).toContain("Trésorerie");
        // L'ordre reste DÛ : reporter ne doit jamais devenir le moyen de faire disparaître un
        // paiement qu'on ne veut pas régler.
        expect(p.warnings.join(" ")).toMatch(/reste dû/i);
        // LA RÈGLE N'EST PAS REJOUÉE ICI, elle est ANNONCÉE : « date à venir » et « motif exigé
        // sur une échéance fixe » vivent dans `checkDeferral` (testé dans settlement.test.ts) et
        // sont appliqués par l'action. Deux copies d'une même règle finissent par diverger.
        expect(p.warnings.join(" ")).toMatch(/à venir/i);
        expect(p.warnings.join(" ")).toMatch(/non négociable/i);
      }
    });

    it("resume_payment : sans report posé, il n'y a rien à lever — et on le DIT", async () => {
      const p = await buildProposal("finance_operation", { op: "resume_payment", reference: `${TAG}-OD-9` }, fin());
      expect("error" in p && p.error).toMatch(/n'est pas reporté/i);
    });

    it("create_budget_line : domaine FR → enum (marketing → MARKETING)", async () => {
      const p = await buildProposal("finance_operation", {
        op: "create_budget_line", label: `${TAG} Campagne digitale`, department: "marketing", amount: "600000",
      }, budget());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).department).toBe("MARKETING");
    });

    it("respond_payment_centre : l'ordre se résout par référence, la réponse est OBLIGATOIRE", async () => {
      const noMsg = await buildProposal("finance_operation", { op: "respond_payment_centre", reference: `${TAG}-OD-9` }, fin());
      expect("error" in noMsg && noMsg.error).toMatch(/réponse/);

      const p = await buildProposal("finance_operation", {
        op: "respond_payment_centre", reference: `${TAG}-OD-9`, message: "Devis comparatif joint au dossier.",
      }, fin());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/Centre de paiement/);
    });
  });
});
