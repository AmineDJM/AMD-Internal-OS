import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { deleteFileByKey, saveFile } from "@/lib/storage";
import { engagementsDesCategories } from "@/lib/queries/budget-sources";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { apercuSuppressionDefinitiveAdPro, supprimerDefinitivementDemandeAdPro } from "./actions-suppression-definitive";
import { REFUS_REFERENCE, REFUS_SOUS_VUE_EXACTE, REFUS_SUPPRESSION_DEFINITIVE } from "./partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SUPPRESSION DÉFINITIVE D'UNE DEMANDE AD & PRO, SUR LA BASE (Super Admin, 24/11/2026).
 *
 *  • une prise en charge nationale v2 : BC numéroté SIGNÉ, ligne ACHETÉE, ordre PAYÉ et son écriture de trésorerie,
 *    dossier compagnon, visa du centre, porte du DG, circuit, pièce jointe, commentaire, rappel, notification, lien ;
 *  • un sponsoring : poste accordé et imputé, ordre ENGAGÉ (au centre, autorisé), BC propre signé, devis PARTAGÉ ;
 *  • une demande VOISINE non liée qui partage le médecin, la ligne budgétaire, le devis Legal et un fichier.
 * Après : tout le lié a disparu (table par table), le budget a remonté EXACTEMENT de ce que l'aperçu annonçait, la
 * voisine est intacte ; DG, DIRECTION, FINANCES et « Agir comme » sont refusés ; une référence mal retapée aussi ;
 * l'audit survit — seule trace, pas de corbeille.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `__adprosuppr${Date.now().toString(36)}`;
const ROLES = { sa: "SUPER_ADMIN", dg: "GENERAL_MANAGER", dir: "DIRECTION", fin: "FINANCE_BUDGET_MANAGER" } as const;
type Qui = keyof typeof ROLES;
const SANS_FIN = new Date("9999-12-31T00:00:00Z");

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

suite("Ad & Pro — suppression définitive par le Super Admin (base réelle)", () => {
  const u = {} as Record<Qui, string>;
  const comme = async (qui: Qui, extra: Partial<CurrentUser> = {}) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u[qui] } });
    ACTOR = { id: x.id, name: x.name, email: x.email, role: ROLES[qui] as UserRole, secondaryRole: null, access: await getAccess(x.id, ROLES[qui] as UserRole), mustChangePassword: false, ...extra } as CurrentUser;
    return ACTOR;
  };
  const I = {
    company: "", env: "", cat: "", doctor: "", definition: "",
    pec: "", benef: "", cell: "", chiffrage: "", prix: "", bcLegal: "", bc: "", bcLigne: "", tx: "", odPaye: "", compagnon: "", visa: "", porte: "",
    workflow: "", docPec: "", comPec: "", rappel: "", lien: "", notif: "",
    sp: "", poste: "", odEngage: "", compagnon2: "", bcPropre: "", devisPartage: "", piecePropre: "", pieceDevis: "",
    voisin: "", posteVoisin: "", odVoisin: "", pieceVoisin: "", docVoisin: "",
  };
  const cles = { propre: `${RUN}/facture-pec.pdf`, partagee: `${RUN}/convention-commune.pdf` };
  const refPec = () => I.pec.slice(-6).toUpperCase();

  beforeAll(async () => {
    const qui = Object.keys(ROLES) as Qui[];
    const comptes = await Promise.all(qui.map((k) => prisma.user.create({ data: { name: `${RUN}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    qui.forEach((k, i) => { u[k] = comptes[i]!.id; });
    I.company = (await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12) } })).id;
    I.env = (await prisma.budgetEnvelope.create({ data: { name: `${RUN}Enveloppe`, modules: ["SPONSORING", "CONGRESS_NATIONAL"], totalAmount: 10_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") } })).id;
    I.cat = (await prisma.budgetCategoryLine.create({ data: { envelopeId: I.env, name: `${RUN}Ligne commune`, module: "SPONSORING", allocated: 5_000_000 } })).id;
    I.doctor = (await prisma.medicalDoctor.create({ data: { name: `${RUN} Dr Commun` } })).id;
    I.definition = (await prisma.workflowDefinition.create({ data: { category: `${RUN}cat`, name: `${RUN} circuit` } })).id;
    await saveFile(cles.propre, Buffer.from(`%PDF-1.4 ${RUN} facture`));
    await saveFile(cles.partagee, Buffer.from(`%PDF-1.4 ${RUN} commune`));

    // ── LA DEMANDE VOISINE, non liée : même médecin, même ligne budgétaire, même devis Legal, même fichier ──
    I.voisin = (await prisma.sponsoringRequest.create({ data: { reference: `${RUN}SPV`, institution: `${RUN} Association voisine`, type: "CONGRESS", companyId: I.company } })).id;
    I.odVoisin = (await prisma.expenseOrder.create({ data: { reference: `${RUN}ODV`, label: "Voisin", amount: 50_000, status: "PENDING", centralStatus: "APPROVED", sourceType: "SPONSORING", sourceId: I.voisin, budgetCategoryId: I.cat, companyId: I.company } })).id;
    I.posteVoisin = (await prisma.adProItem.create({ data: { sponsoringId: I.voisin, label: "Stand voisin", status: "APPROVED", amountGranted: 50_000, budgetCategoryId: I.cat, depenseImputeeLe: new Date(), expenseOrderId: I.odVoisin } })).id;
    await prisma.adProMedecin.create({ data: { entityType: "SPONSORING", entityId: I.voisin, doctorId: I.doctor, createdById: u.sa } });
    I.docVoisin = (await prisma.document.create({ data: { name: "Convention commune", entityType: "SPONSORING", entityId: I.voisin, fileKey: cles.partagee } })).id;

    // ── LA PRISE EN CHARGE NATIONALE v2 : BC signé, achat, ordre PAYÉ (écriture de trésorerie) ──
    I.pec = (await prisma.congressNational.create({ data: { name: `${RUN} Congrès de diabétologie`, requesterId: u.sa, requestStatus: "APPROVED", companyId: I.company, circuitAchatAt: new Date() } })).id;
    I.benef = (await prisma.careBeneficiary.create({ data: { congressNationalId: I.pec, doctorId: I.doctor } })).id;
    I.cell = (await prisma.careCell.create({ data: { beneficiaryId: I.benef, kind: "SERVICE", serviceKind: "TRANSPORT", label: "Billet Alger-Oran", amountDzd: 120_000 } })).id;
    I.chiffrage = (await prisma.careChiffrage.create({ data: { congressNationalId: I.pec } })).id;
    I.prix = (await prisma.carePrixHistorique.create({ data: { cellId: I.cell, motif: "chiffrage" } })).id;
    I.bcLegal = (await prisma.legalDocument.create({ data: { title: `${RUN} BC n°1`, kind: "PURCHASE_ORDER", amount: 120_000, sourceType: "CONGRESS_NATIONAL", sourceId: I.pec, signedAt: new Date(), signedById: u.fin, companyId: I.company } })).id;
    I.tx = (await prisma.financeTransaction.create({ data: { reference: `${RUN}FIN1`, direction: "OUT", category: "EVENEMENT", label: "Règlement BC n°1", amount: 120_000, status: "SETTLED", budgetCategoryId: I.cat, companyId: I.company } })).id;
    I.odPaye = (await prisma.expenseOrder.create({ data: { reference: `${RUN}OD1`, label: "BC n°1", amount: 120_000, status: "PAID", centralStatus: "APPROVED", sourceType: "CONGRESS_NATIONAL", sourceId: I.pec, transactionId: I.tx, paidDate: new Date(), paidById: u.fin, budgetCategoryId: I.cat, companyId: I.company } })).id;
    I.bc = (await prisma.carePecBc.create({ data: { congressNationalId: I.pec, numero: 1, legalDocumentId: I.bcLegal, fournisseur: "Agence", budgetCategoryId: I.cat, expenseOrderId: I.odPaye } })).id;
    I.bcLigne = (await prisma.carePecBcLigne.create({ data: { bcId: I.bc, cellId: I.cell, libelle: "Billet", montantDzd: 120_000, statut: "ACHETEE" } })).id;
    // Le compagnon n'a pas d'entité : il n'est rattaché qu'à son ordre — c'est le RETOUR qui le trouve.
    I.compagnon = (await prisma.paymentRequest.create({ data: { reference: `${RUN}PAY1`, title: "BC n°1", amount: 120_000, payee: "Agence", requesterId: u.sa, expenseOrderId: I.odPaye, origin: "EXPENSE_ORDER" } })).id;
    await prisma.paymentRequestEvent.create({ data: { requestId: I.compagnon, kind: "SUBMIT", actorId: u.sa } });
    await prisma.paymentCentreMessage.create({ data: { orderId: I.odPaye, body: "Autorisé", decision: "APPROVE" } });
    I.visa = (await prisma.adProGateVisa.create({ data: { entityType: "LEGAL_DOCUMENT", entityId: I.bcLegal } })).id;
    I.porte = (await prisma.adProPorteDg.create({ data: { entityType: "CONGRESS_NATIONAL", entityId: I.pec } })).id;
    I.workflow = (await prisma.workflowInstance.create({ data: { definitionId: I.definition, entityType: "CONGRESS_NATIONAL", entityId: I.pec, category: `${RUN}cat`, skippedSlugs: [] } })).id;
    await prisma.workflowStepEvent.create({ data: { instanceId: I.workflow, stepSlug: "creation", stepTitle: "Création", action: "CREATE", actorId: u.sa } });
    I.docPec = (await prisma.document.create({ data: { name: "Facture", entityType: "CONGRESS_NATIONAL", entityId: I.pec, fileKey: cles.propre } })).id;
    // Le même fichier que la voisine (une copie déposée sur les deux fiches) : il doit lui rester.
    await prisma.document.create({ data: { name: "Convention (copie)", entityType: "CONGRESS_NATIONAL", entityId: I.pec, fileKey: cles.partagee } });
    I.comPec = (await prisma.comment.create({ data: { entityType: "CONGRESS_NATIONAL", entityId: I.pec, body: "Discussion de la demande" } })).id;
    I.rappel = (await prisma.reminder.create({ data: { userId: u.sa, title: "Relancer", remindAt: new Date(), entityType: "CONGRESS_NATIONAL", entityId: I.pec } })).id;
    // Un lien « relié à » vers la voisine : SEUL le lien part.
    I.lien = (await prisma.entityLink.create({ data: { fromType: "CONGRESS_NATIONAL", fromId: I.pec, toType: "SPONSORING", toId: I.voisin } })).id;
    I.notif = (await prisma.notification.create({ data: { userId: u.dg, title: "Nouvelle prise en charge", link: `/congress-national/${I.pec}` } })).id;
    await prisma.adProMedecin.create({ data: { entityType: "CONGRESS_NATIONAL", entityId: I.pec, doctorId: I.doctor, createdById: u.sa } });

    // ── LE SPONSORING : poste accordé et imputé, ordre ENGAGÉ, BC propre signé, devis PARTAGÉ avec la voisine ──
    I.sp = (await prisma.sponsoringRequest.create({ data: { reference: `${RUN}SP1`, institution: `${RUN} Société savante`, type: "CONGRESS", companyId: I.company } })).id;
    I.odEngage = (await prisma.expenseOrder.create({ data: { reference: `${RUN}OD2`, label: "Stand", amount: 200_000, status: "PENDING", centralStatus: "APPROVED", sourceType: "SPONSORING", sourceId: I.sp, budgetCategoryId: I.cat, companyId: I.company } })).id;
    I.poste = (await prisma.adProItem.create({ data: { sponsoringId: I.sp, label: "Stand", status: "APPROVED", amountGranted: 300_000, budgetCategoryId: I.cat, depenseImputeeLe: new Date(), expenseOrderId: I.odEngage } })).id;
    I.compagnon2 = (await prisma.paymentRequest.create({ data: { reference: `${RUN}PAY2`, title: "Stand", amount: 200_000, payee: "Société", requesterId: u.sa, expenseOrderId: I.odEngage, origin: "EXPENSE_ORDER", entityType: "SPONSORING", entityId: I.sp } })).id;
    I.bcPropre = (await prisma.legalDocument.create({ data: { title: `${RUN} BC stand`, kind: "PURCHASE_ORDER", amount: 300_000, signedAt: new Date(), signedById: u.fin, companyId: I.company } })).id;
    I.piecePropre = (await prisma.adProItemPiece.create({ data: { itemId: I.poste, legalDocumentId: I.bcPropre, nature: "BON_DE_COMMANDE" } })).id;
    I.devisPartage = (await prisma.legalDocument.create({ data: { title: `${RUN} Devis commun`, kind: "QUOTE", amount: 80_000, sourceType: "SPONSORING", sourceId: I.sp, companyId: I.company } })).id;
    I.pieceDevis = (await prisma.adProItemPiece.create({ data: { itemId: I.poste, legalDocumentId: I.devisPartage, nature: "DEVIS" } })).id;
    I.pieceVoisin = (await prisma.adProItemPiece.create({ data: { itemId: I.posteVoisin, legalDocumentId: I.devisPartage, nature: "DEVIS" } })).id;
    await prisma.adProMedecin.create({ data: { entityType: "SPONSORING", entityId: I.sp, doctorId: I.doctor, createdById: u.sa } });
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ids = Object.values(u).filter(Boolean);
    const sources = [I.pec, I.sp, I.voisin];
    await retirerDocumentsEtContenu({ where: { entityId: { in: sources } } }).catch(() => {});
    for (const k of Object.values(cles)) await deleteFileByKey(k).catch(() => {});
    await prisma.adProMedecin.deleteMany({ where: { entityId: { in: sources } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { legalDocumentId: { in: [I.devisPartage, I.bcPropre, I.bcLegal] } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: [I.poste, I.posteVoisin] } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: [I.compagnon, I.compagnon2] } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: RUN } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: I.pec } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { definitionId: I.definition } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { id: I.definition } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { id: I.cat } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: I.env } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { id: I.doctor } }).catch(() => {});
    await prisma.entityLink.deleteMany({ where: { id: I.lien } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: sources } }] } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: I.company } }).catch(() => {});
  }, 120_000);

  /** L'engagé et la consommation de la ligne commune, et l'engagé de la voisine — par la règle des budgets elle-même. */
  const budget = async () => {
    const e = await engagementsDesCategories([I.cat], SANS_FIN);
    const conso = await prisma.financeTransaction.aggregate({ where: { budgetCategoryId: I.cat, direction: "OUT", status: "SETTLED" }, _sum: { amount: true } });
    const voisin = e.details.filter((d) => d.posteId === I.posteVoisin || d.ordreId === I.odVoisin).reduce((s, d) => s + d.montant, 0);
    return { engage: e.parCategorie.get(I.cat) ?? 0, conso: Number(conso._sum.amount ?? 0), voisin };
  };

  it("1. DG, DIRECTION, FINANCES — et le Super Admin sous « Agir comme » — sont refusés, aperçu compris ; rien ne bouge", async () => {
    for (const qui of ["dg", "dir", "fin"] as const) {
      await comme(qui);
      expect(await apercuSuppressionDefinitiveAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec }))).toEqual({ ok: false, error: REFUS_SUPPRESSION_DEFINITIVE });
      expect(await supprimerDefinitivementDemandeAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec, reference: refPec() }))).toEqual({ ok: false, error: REFUS_SUPPRESSION_DEFINITIVE });
    }
    await comme("sa", { impersonatedBy: { id: "x", name: "Super Admin", agir: true } });
    expect(await supprimerDefinitivementDemandeAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec, reference: refPec() }))).toEqual({ ok: false, error: REFUS_SOUS_VUE_EXACTE });
    expect(await prisma.congressNational.count({ where: { id: I.pec } })).toBe(1);
    expect(await prisma.expenseOrder.count({ where: { id: I.odPaye } })).toBe(1);
  });

  it("2. l'aperçu de la prise en charge chiffre ce qui part : l'ordre PAYÉ, son écriture, la consommation rendue à la ligne", async () => {
    await comme("sa");
    const r = await apercuSuppressionDefinitiveAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.reference).toBe(refPec());
    expect(r.nature).toBe("Prise en charge nationale");
    expect(r.apercu.ordres).toMatchObject({ nombre: 1, payes: 1, montantPaye: 120_000 });
    expect(r.apercu.ecritures).toMatchObject({ nombre: 1, sorties: 120_000 });
    expect(r.apercu.budget).toEqual([expect.objectContaining({ categorieId: I.cat, consommation: 120_000 })]);
    expect(r.apercu.pieces).toMatchObject({ legal: 1, jointes: 2 });
    expect(r.apercu.faits.join(" ")).toMatch(/réglé/);
    expect(r.apercu.bloquants).toEqual([]);
  });

  it("3. une référence mal retapée est refusée — rien n'est supprimé", async () => {
    await comme("sa");
    for (const saisie of ["", `${refPec()}X`, "SP-2026-001"]) {
      expect(await supprimerDefinitivementDemandeAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec, reference: saisie }))).toEqual({ ok: false, error: REFUS_REFERENCE });
    }
    expect(await prisma.congressNational.count({ where: { id: I.pec } })).toBe(1);
  });

  it("4. la prise en charge part, avec TOUT ce qui lui est lié — et seulement cela ; la consommation remonte exactement", async () => {
    await comme("sa");
    const avant = await budget();
    const ap = await apercuSuppressionDefinitiveAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec }));
    const r = await supprimerDefinitivementDemandeAdPro(fd({ kind: "CONGRESS_NATIONAL", id: I.pec, reference: ` ${refPec().toLowerCase()} ` }));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // Table par table : le lié a disparu.
    const zero = {
      congressNational: await prisma.congressNational.count({ where: { id: I.pec } }),
      careBeneficiary: await prisma.careBeneficiary.count({ where: { id: I.benef } }),
      careCell: await prisma.careCell.count({ where: { id: I.cell } }),
      careChiffrage: await prisma.careChiffrage.count({ where: { id: I.chiffrage } }),
      carePrixHistorique: await prisma.carePrixHistorique.count({ where: { id: I.prix } }),
      carePecBc: await prisma.carePecBc.count({ where: { id: I.bc } }),
      carePecBcLigne: await prisma.carePecBcLigne.count({ where: { id: I.bcLigne } }),
      legalDocument: await prisma.legalDocument.count({ where: { id: I.bcLegal } }),
      expenseOrder: await prisma.expenseOrder.count({ where: { id: I.odPaye } }),
      financeTransaction: await prisma.financeTransaction.count({ where: { id: I.tx } }),
      paymentRequest: await prisma.paymentRequest.count({ where: { id: I.compagnon } }),
      paymentRequestEvent: await prisma.paymentRequestEvent.count({ where: { requestId: I.compagnon } }),
      paymentCentreMessage: await prisma.paymentCentreMessage.count({ where: { orderId: I.odPaye } }),
      adProGateVisa: await prisma.adProGateVisa.count({ where: { id: I.visa } }),
      adProPorteDg: await prisma.adProPorteDg.count({ where: { id: I.porte } }),
      workflowInstance: await prisma.workflowInstance.count({ where: { id: I.workflow } }),
      workflowStepEvent: await prisma.workflowStepEvent.count({ where: { instanceId: I.workflow } }),
      document: await prisma.document.count({ where: { entityType: "CONGRESS_NATIONAL", entityId: I.pec } }),
      comment: await prisma.comment.count({ where: { id: I.comPec } }),
      reminder: await prisma.reminder.count({ where: { id: I.rappel } }),
      entityLink: await prisma.entityLink.count({ where: { id: I.lien } }),
      notification: await prisma.notification.count({ where: { id: I.notif } }),
      adProMedecin: await prisma.adProMedecin.count({ where: { entityId: I.pec } }),
      fichierPropre: await prisma.storedFile.count({ where: { key: cles.propre } }),
    };
    expect(Object.entries(zero).filter(([, n]) => n !== 0)).toEqual([]);

    // Rien d'autre : le médecin, la ligne, le fichier partagé, la voisine et son lien d'origine.
    expect(await prisma.medicalDoctor.count({ where: { id: I.doctor } })).toBe(1);
    expect(await prisma.budgetCategoryLine.count({ where: { id: I.cat } })).toBe(1);
    expect(await prisma.storedFile.count({ where: { key: cles.partagee } }), "le fichier encore cité par la voisine reste").toBe(1);
    expect(await prisma.sponsoringRequest.count({ where: { id: I.voisin } })).toBe(1);
    expect(await prisma.deletedRecord.count({ where: { sourceId: I.pec } }), "pas de corbeille").toBe(0);

    // Le budget remonte EXACTEMENT de ce que l'aperçu annonçait.
    const apres = await budget();
    expect(ap.ok && ap.apercu.totalBudget.consommation).toBe(120_000);
    expect(avant.conso - apres.conso).toBe(120_000);
    expect(apres.voisin).toBe(avant.voisin);
  });

  it("5. le sponsoring : le devis partagé avec la voisine est GARDÉ (seul le lien part), l'engagé rendu est exact", async () => {
    await comme("sa");
    const avant = await budget();
    const ap = await apercuSuppressionDefinitiveAdPro(fd({ kind: "SPONSORING", id: I.sp }));
    expect(ap.ok, JSON.stringify(ap)).toBe(true);
    if (!ap.ok) return;
    expect(ap.reference).toBe(`${RUN}SP1`);
    expect(ap.apercu).toMatchObject({ postes: 1, ordres: { nombre: 1, payes: 0, enCircuit: 1, montantEnCircuit: 200_000 }, pieces: { legal: 1 } });
    expect(ap.apercu.gardees.map((g) => g.libelle)).toEqual([`${RUN} Devis commun`]);
    expect(ap.apercu.totalBudget.engagement).toBeGreaterThanOrEqual(200_000);

    const r = await supprimerDefinitivementDemandeAdPro(fd({ kind: "SPONSORING", id: I.sp, reference: `${RUN}SP1` }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const zero = {
      sponsoringRequest: await prisma.sponsoringRequest.count({ where: { id: I.sp } }),
      adProItem: await prisma.adProItem.count({ where: { id: I.poste } }),
      expenseOrder: await prisma.expenseOrder.count({ where: { id: I.odEngage } }),
      paymentRequest: await prisma.paymentRequest.count({ where: { id: I.compagnon2 } }),
      bcPropre: await prisma.legalDocument.count({ where: { id: I.bcPropre } }),
      piecesDuPoste: await prisma.adProItemPiece.count({ where: { id: { in: [I.piecePropre, I.pieceDevis] } } }),
      adProMedecin: await prisma.adProMedecin.count({ where: { entityId: I.sp } }),
    };
    expect(Object.entries(zero).filter(([, n]) => n !== 0)).toEqual([]);

    // Le devis partagé reste, détaché de la demande supprimée, toujours rattaché au poste voisin.
    const devis = await prisma.legalDocument.findUniqueOrThrow({ where: { id: I.devisPartage } });
    expect([devis.sourceType, devis.sourceId]).toEqual([null, null]);
    expect(await prisma.adProItemPiece.count({ where: { id: I.pieceVoisin } })).toBe(1);

    // La voisine, intacte : sa demande, son poste, son ordre, son médecin, son document.
    expect(await prisma.adProItem.count({ where: { id: I.posteVoisin } })).toBe(1);
    expect(await prisma.expenseOrder.findUniqueOrThrow({ where: { id: I.odVoisin } })).toMatchObject({ status: "PENDING", sourceId: I.voisin });
    expect(await prisma.adProMedecin.count({ where: { entityId: I.voisin, doctorId: I.doctor } })).toBe(1);
    expect(await prisma.document.count({ where: { id: I.docVoisin } })).toBe(1);

    const apres = await budget();
    expect(Math.round((avant.engage - apres.engage) * 100) / 100).toBe(ap.apercu.totalBudget.engagement);
    expect(apres.voisin).toBe(avant.voisin);
    expect(apres.voisin).toBeGreaterThan(0);
  });

  it("6 bis. les autres natures (événement, autre demande, prise en charge internationale, matériel) se détruisent de même", async () => {
    await comme("sa");
    const tetes = {
      EVENT: (await prisma.event.create({ data: { name: `${RUN} Soirée scientifique`, companyId: I.company } })).id,
      AD_PRO_OTHER: (await prisma.adProOtherRequest.create({ data: { reference: `${RUN}AUT`, title: `${RUN} Autre`, companyId: I.company } })).id,
      CONGRESS_INTERNATIONAL: (await prisma.congressInternational.create({ data: { name: `${RUN} Congrès européen`, companyId: I.company } })).id,
      PROMO_MATERIAL: (await prisma.promoMaterial.create({ data: { reference: `${RUN}MAT`, title: `${RUN} Brochures`, companyId: I.company } })).id,
    } as const;
    const parent = { EVENT: "eventId", AD_PRO_OTHER: "otherRequestId", CONGRESS_INTERNATIONAL: "congressInternationalId", PROMO_MATERIAL: "promoMaterialParentId" } as const;
    for (const [kind, id] of Object.entries(tetes) as [keyof typeof tetes, string][]) {
      const od = await prisma.expenseOrder.create({ data: { reference: `${RUN}OD-${kind}`, label: kind, amount: 1_000, status: "PAID", centralStatus: "APPROVED", sourceType: kind, sourceId: id, companyId: I.company } });
      const poste = await prisma.adProItem.create({ data: { [parent[kind]]: id, label: `Poste ${kind}`, expenseOrderId: od.id } as never });
      const ap = await apercuSuppressionDefinitiveAdPro(fd({ kind, id }));
      expect(ap.ok, `${kind} ${JSON.stringify(ap)}`).toBe(true);
      if (!ap.ok) continue;
      expect(ap.apercu.ordres.payes, kind).toBe(1);
      const r = await supprimerDefinitivementDemandeAdPro(fd({ kind, id, reference: ap.reference }));
      expect(r.ok, `${kind} ${JSON.stringify(r)}`).toBe(true);
      expect(await prisma.adProItem.count({ where: { id: poste.id } }), kind).toBe(0);
      expect(await prisma.expenseOrder.count({ where: { id: od.id } }), kind).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityId: id, action: "DELETE" } }), kind).toBe(1);
    }
    expect(await prisma.event.count({ where: { id: tetes.EVENT } }) + await prisma.adProOtherRequest.count({ where: { id: tetes.AD_PRO_OTHER } })
      + await prisma.congressInternational.count({ where: { id: tetes.CONGRESS_INTERNATIONAL } }) + await prisma.promoMaterial.count({ where: { id: tetes.PROMO_MATERIAL } })).toBe(0);
    // La voisine, toujours intacte.
    expect(await prisma.sponsoringRequest.count({ where: { id: I.voisin } })).toBe(1);
  });

  it("6. l'audit survit — UNE ligne par destruction, qui dit qui, quoi, et le résumé chiffré", async () => {
    const traces = await prisma.auditLog.findMany({ where: { entityId: { in: [I.pec, I.sp] }, action: "DELETE" }, orderBy: { createdAt: "asc" } });
    // AUCUNE autre trace : pas d'entrée de corbeille (rien à restaurer).
    expect(await prisma.deletedRecord.count({ where: { sourceId: { in: [I.pec, I.sp] } } })).toBe(0);
    expect(traces).toHaveLength(2);
    expect(traces.every((t) => t.actorId === u.sa && t.module === "Ad & Pro")).toBe(true);
    expect(traces[0]!.summary).toMatch(/Suppression DÉFINITIVE \(Super Admin\) — Prise en charge nationale/);
    expect(traces[0]!.summary).toMatch(/1 payé : 120[\s  ]000 DZD/);
    expect(traces[1]!.summary).toMatch(/Devis commun/);
  });
});
