import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { contexteDecisionDesOrdres, type ContexteDecision } from "@/modules/finances/api";
import { BRIQUES_DU_CENTRE, contexteDuCentre } from "./centre-contexte";
import { canAccessEntity } from "@/lib/entity-access";
import { readFileSync } from "node:fs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE DÉCISION DU CENTRE DE PAIEMENT, PAR SON VRAI CHARGEUR ET SES VRAIES BRIQUES.
 *
 * Une famille de paiement par ordre, comme sur la maquette du 24/11/2026 : un poste Ad & Pro par
 * agence dont le BC est signé (DM puis Finances), une demande de paiement marquée « doublon
 * possible » vers un bénéficiaire nouveau, la paie, une avance, une remise de caisse, une prise
 * en charge dont la facture dépasse le BC, une demande du secrétariat, un ordre sans origine, et
 * un ordre demandé par le siège lui-même. Puis le budget avant/après, et une brique EN PANNE : la
 * fiche le dit et ne tombe pas.
 *
 * Le siège n'a pas la vue globale (§118.104) : il siège nommément et voit UNE société.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ctx__${Date.now().toString(36)}`;
const JOUR = 86_400_000;

suite("la fiche de décision du centre : une famille par ordre, en lot", () => {
  let aId = "";
  let siege: SessionUser;
  const u: Record<string, string> = {};
  const o: Record<string, string> = {};
  let catId = "";
  let prId = "";
  let fiches: Map<string, ContexteDecision>;
  let seq = 0;

  async function nettoyer() {
    const socs = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((s) => s.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.careCell.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.signatureBC.deleteMany({ where: { jeton: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { request: { reference: { startsWith: TAG } } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.payrollEntry.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.payrollWire.deleteMany({ where: { companyId: { in: socs } } }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { department: { code: { startsWith: TAG } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelope: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentCentreSeat.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId: { in: socs } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: socs } } }).catch(() => {});
  }

  async function ordre(cle: string, d: { amount: number; sourceType?: string | null; sourceId?: string | null; beneficiary?: string | null; requestedById?: string; budgetCategoryId?: string | null; custom?: object; status?: string; paidDate?: Date; label?: string }) {
    const r = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OD-${++seq}`, label: d.label ?? `${TAG}${cle}`, amount: d.amount, category: "AUTRE", companyId: aId,
        sourceType: (d.sourceType ?? null) as never, sourceId: d.sourceId ?? null, beneficiary: d.beneficiary ?? null,
        centralStatus: d.status === "PAID" ? "APPROVED" : "AWAITING", status: (d.status ?? "PENDING") as never, paidDate: d.paidDate ?? null,
        requestedById: d.requestedById ?? u.demandeur, budgetCategoryId: d.budgetCategoryId ?? null, custom: d.custom as never,
      },
      select: { id: true },
    });
    o[cle] = r.id;
    return r.id;
  }

  beforeAll(async () => {
    await nettoyer();
    aId = (await prisma.company.create({ data: { name: `${TAG}A`, shortName: `${TAG}Alpha`, sortOrder: 9101 }, select: { id: true } })).id;
    for (const [k, role] of [["siege", "GENERAL_MANAGER"], ["demandeur", "DIRECTION_ASSISTANT"], ["rh", "VIEWER"], ["fin", "FINANCE_BUDGET_MANAGER"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } })).id;
    }
    await prisma.userCompanyAccess.create({ data: { userId: u.siege, companyId: aId } });
    // Le siège : le Directeur Général — le centre est réservé à la Direction générale (24/11/2026).
    siege = { id: u.siege, name: `${TAG}siege`, email: `${TAG}siege@t.dz`, role: "GENERAL_MANAGER", secondaryRole: null, access: await getAccess(u.siege, "GENERAL_MANAGER" as never), mustChangePassword: false } as unknown as SessionUser;

    // ── Le budget : une ligne de 1 000 000 DZD, sur laquelle le poste agence s'impute.
    const env = await prisma.budgetEnvelope.create({ data: { name: `${TAG}Marketing`, periodStart: new Date(Date.now() - 200 * JOUR), periodEnd: new Date(Date.now() + 200 * JOUR), totalAmount: 1_000_000, companyId: aId }, select: { id: true } });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: "Événements", allocated: 1_000_000 }, select: { id: true } })).id;

    // ── 1. AD & PRO, POSTE AGENCE : accordé, BC signé DM puis Finances, facture déposée.
    const spo = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-041`, institution: "CHU de Blida", type: "INDIRECT", companyId: aId }, select: { id: true } });
    await ordre("poste", { amount: 450_000, sourceType: "SPONSORING", sourceId: spo.id, beneficiary: "Agence Atlas Events", budgetCategoryId: catId });
    const item = await prisma.adProItem.create({
      data: { label: `${TAG}Stand`, sponsoringId: spo.id, voie: "AGENCE", status: "APPROVED", amountGranted: 450_000, decidedAt: new Date(Date.now() - 5 * JOUR), decidedById: u.demandeur, expenseOrderId: o.poste },
      select: { id: true },
    });
    const bc = await prisma.legalDocument.create({ data: { title: `${TAG}BC poste`, kind: "PURCHASE_ORDER", reference: `${TAG}BC-118`, amount: 450_000, signedAt: new Date(Date.now() - 3 * JOUR), companyId: aId }, select: { id: true } });
    const fac = await prisma.legalDocument.create({ data: { title: `${TAG}Facture poste`, kind: "INVOICE", reference: `${TAG}F-0912`, amount: 450_000, companyId: aId }, select: { id: true } });
    await prisma.adProItemPiece.createMany({ data: [{ itemId: item.id, legalDocumentId: bc.id, nature: "BON_DE_COMMANDE" }, { itemId: item.id, legalDocumentId: fac.id, nature: "FACTURE" }] });
    await prisma.signatureBC.create({ data: { legalDocumentId: bc.id, qualite: "DIRECTION_MARKETING", signataireNom: "Sara L.", methode: "TOTP", jeton: `${TAG}jeton-dm`, signedAt: new Date(Date.now() - 4 * JOUR) } });
    await prisma.document.create({ data: { name: `${TAG}F-0912.pdf`, entityType: "LEGAL_DOCUMENT", entityId: fac.id } });
    // Le même bénéficiaire, déjà payé il y a deux mois (casse et accents différents).
    await ordre("atlas-passe", { amount: 120_000, beneficiary: "AGENCE ATLAS ÉVENTS", status: "PAID", paidDate: new Date(Date.now() - 60 * JOUR) });

    // ── 2. DEMANDE DE PAIEMENT : bon à payer des Finances, facture jointe, marquée « doublon possible ».
    const pr = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY-207`, title: "Maintenance climatisation", amount: 186_000, payee: "Froid Service SARL", requesterId: u.demandeur, decidedById: u.fin, decidedAt: new Date(Date.now() - JOUR), status: "APPROVED", companyId: aId, submittedAt: new Date(Date.now() - 3 * JOUR) },
      select: { id: true },
    });
    prId = pr.id;
    await ordre("demande", {
      amount: 186_000, sourceType: "PAYMENT_REQUEST", sourceId: pr.id, beneficiary: "Froid Service SARL",
      custom: { doublonPossible: { autre: "OD-2026-377", module: "Finances", raison: "même numéro de facture F-118", le: new Date().toISOString() } },
    });
    await prisma.paymentRequest.update({ where: { id: pr.id }, data: { expenseOrderId: o.demande } });
    const docPr = await prisma.document.create({ data: { name: `${TAG}F-118.pdf`, entityType: "PAYMENT_REQUEST", entityId: pr.id }, select: { id: true } });
    await prisma.paymentPiece.create({ data: { requestId: pr.id, documentId: docPr.id, kind: "INVOICE" } });

    // ── 3. PAIE : deux salaires, la somme des nets égale au virement ; le mois d'avant connu.
    const [e1, e2] = await Promise.all([1, 2].map((i) => prisma.employee.create({ data: { fullName: `${TAG}salarié ${i}`, companyId: aId }, select: { id: true } })));
    const wire = await prisma.payrollWire.create({ data: { companyId: aId, year: 2026, month: 11, amount: 300_000, createdById: u.rh }, select: { id: true } });
    await prisma.payrollWire.create({ data: { companyId: aId, year: 2026, month: 10, amount: 290_000 } });
    await ordre("paie", { amount: 300_000, sourceType: "PAYROLL", sourceId: wire.id, beneficiary: "2 salariés", requestedById: u.rh });
    await prisma.payrollWire.update({ where: { id: wire.id }, data: { expenseOrderId: o.paie } });
    await prisma.payrollEntry.createMany({ data: [e1, e2].map((e) => ({ employeeId: e.id, year: 2026, month: 11, net: 150_000, payrollWireId: wire.id })) });

    // ── 4. AVANCE : accordée par les RH ; une autre avance il y a trois mois.
    const sal = await prisma.employee.create({ data: { fullName: `${TAG}Karim B.`, companyId: aId }, select: { id: true } });
    const adv = await prisma.salaryAdvance.create({ data: { employeeId: sal.id, amount: 50_000, status: "APPROVED", decidedById: u.rh, decidedAt: new Date(Date.now() - JOUR) }, select: { id: true } });
    await prisma.salaryAdvance.create({ data: { employeeId: sal.id, amount: 20_000, status: "PAID", createdAt: new Date(Date.now() - 90 * JOUR) } });
    await ordre("avance", { amount: 50_000, sourceType: "SALARY_ADVANCE", sourceId: adv.id, beneficiary: `${TAG}Karim B.`, requestedById: u.rh });

    // ── 5. CAISSE D'AVANCE : une remise inscrite par les RH.
    const dep = await prisma.department.create({ data: { name: `${TAG}Moyens généraux`, code: `${TAG}MG` }, select: { id: true } });
    await ordre("caisse", { amount: 24_000, beneficiary: "Caisse Moyens généraux", requestedById: u.rh });
    await prisma.pettyCashAllotment.create({ data: { departmentId: dep.id, period: "2026-11", amount: 24_000, holderId: u.demandeur, createdById: u.rh, expenseOrderId: o.caisse } });

    // ── 6. PRISE EN CHARGE : la case d'un congrès, un BC signé à 210 500, la facture à 232 000 (> marge de 10 %).
    const cg = await prisma.congressNational.create({ data: { name: `${TAG}Congrès diabétologie`, companyId: aId }, select: { id: true } });
    const ben = await prisma.careBeneficiary.create({ data: { congressNationalId: cg.id, lastName: "Dr Test" }, select: { id: true } });
    await ordre("pec", { amount: 232_000, sourceType: "CONGRESS_NATIONAL", sourceId: cg.id, beneficiary: "Agence Voyages Sahel" });
    await prisma.careCell.create({ data: { beneficiaryId: ben.id, kind: "SERVICE", serviceKind: "TICKET", label: "Billets", expenseOrderId: o.pec } });
    await prisma.legalDocument.create({ data: { title: `${TAG}BC PEC`, kind: "PURCHASE_ORDER", reference: `${TAG}BC-1`, amount: 210_500, signedAt: new Date(), expenseOrderId: o.pec, companyId: aId } });

    // ── 7. SECRÉTARIAT : une demande d'achat accordée par le N+1 à 80 000.
    const req = await prisma.administrativeRequest.create({ data: { reference: `${TAG}REQ-12`, title: "Fournitures", type: "PURCHASE", requesterId: u.demandeur, companyId: aId }, select: { id: true } });
    await prisma.adminApproval.create({ data: { requestId: req.id, status: "APPROVED", amount: 80_000, decidedAt: new Date(), decidedById: u.fin } });
    await ordre("secretariat", { amount: 80_000, sourceType: "ADMIN_REQUEST", sourceId: req.id, beneficiary: "Papeterie du Centre" });

    // ── 8. SANS ORIGINE, et DEMANDÉ PAR LE SIÈGE LUI-MÊME.
    await ordre("nu", { amount: 1_000 });
    await ordre("du-siege", { amount: 7_000, requestedById: u.siege, beneficiary: "Fournisseur X" });

    const ids = ["poste", "demande", "paie", "avance", "caisse", "pec", "secretariat", "nu", "du-siege"].map((k) => o[k]);
    fiches = new Map((await contexteDuCentre(ids, siege, aId)).map((f) => [f.id, f]));
  }, 180_000);

  afterAll(async () => { await nettoyer(); }, 120_000);

  const fiche = (cle: string) => fiches.get(o[cle])!;
  const titres = (cle: string) => fiche(cle).alertes.map((a) => a.titre);
  const etape = (cle: string, debut: string) => fiche(cle).chaine.find((c) => c.etape.startsWith(debut));

  it("une fiche par ordre demandé, dans l'ordre reçu — aucune brique n'a manqué", () => {
    expect(fiches.size).toBe(9);
    for (const f of fiches.values()) expect(f.alertes.map((a) => a.titre), f.objet).not.toContain("Contexte incomplet");
  });

  it("POSTE AGENCE : l'accord, le BC signé DM puis Finances, la facture ouvrable, les montants concordants, l'historique du bénéficiaire", () => {
    const f = fiche("poste");
    expect(f.origine).toBe("Ad & Pro · poste agence");
    expect(f.reference).toContain(`${TAG}SPO-041`);
    expect(etape("poste", "Poste accordé")?.etat).toBe("OK");
    const bc = etape("poste", "BC n°");
    expect(bc?.etat).toBe("OK");
    expect(bc?.detail).toMatch(/signé DM le/);
    expect(bc?.detail).toMatch(/signé Finances le/);
    const facture = f.pieces.find((p) => p.nom.startsWith("Facture"));
    expect(facture?.present).toBe(true);
    expect(facture?.fichier).toBe(`${TAG}F-0912.pdf`);
    expect(f.montants.map((m) => m.libelle)).toEqual(["Accordé", "BC", "Facture", "À payer"]);
    expect(f.montants.some((m) => m.ecart)).toBe(false);
    expect(f.historique).toMatch(/^1 paiement en 12 mois/);
    expect(titres("poste")).not.toContain("Bénéficiaire nouveau");
  });

  it("BUDGET : la ligne imputée, disponible AVANT = après + montant, APRÈS = alloué − consommé − engagé", () => {
    const b = fiche("poste").budget;
    expect(b.etat).toBe("IMPUTE");
    if (b.etat !== "IMPUTE") return;
    expect(b.ligne).toBe(`${TAG}Marketing › Événements`);
    expect(b.apres).toBe(550_000);
    expect(b.avant).toBe(1_000_000);
  });

  it("DEMANDE DE PAIEMENT : le doublon et le bénéficiaire nouveau en rouge, le bon à payer des Finances, la facture jointe, le vrai demandeur", () => {
    const f = fiche("demande");
    expect(f.origine).toBe("Demande de paiement");
    expect(f.reference).toContain(`${TAG}PAY-207`);
    expect(titres("demande")[0]).toBe("Doublon possible");
    expect(f.alertes[0].detail).toMatch(/OD-2026-377.*même numéro de facture F-118/);
    expect(titres("demande")).toContain("Bénéficiaire nouveau");
    expect(f.historique).toBe("1er paiement à ce bénéficiaire");
    expect(etape("demande", "Bon à payer des Finances")?.etat).toBe("OK");
    expect(etape("demande", "Bon de commande")?.detail).toMatch(/aucun/);
    expect(f.pieces.find((p) => p.fichier === `${TAG}F-118.pdf`)?.nom).toBe("Facture");
    expect(f.demandeur).toBe(`${TAG}demandeur`);
    expect(f.dossierHref).toMatch(/^\/validations\/paiements\//);
  });

  it("PAIE : hors enveloppe, les salaires comptés, la somme égale aux nets, le mois précédent en jalon", () => {
    const f = fiche("paie");
    expect(f.origine).toBe("Paie");
    expect(f.budget.etat).toBe("HORS_ENVELOPPE");
    expect(etape("paie", "Paie calculée")?.detail).toMatch(/2 salaires/);
    expect(etape("paie", "Somme déclarée")?.etat).toBe("OK");
    expect(f.montants.map((m) => [m.libelle, m.valeur])).toEqual([["Mois précédent", 290_000], ["À payer", 300_000]]);
    expect(titres("paie")).not.toContain("Bénéficiaire nouveau");
    expect(f.demandeur).toBe(`${TAG}rh`);
  });

  it("AVANCE : le salarié est le demandeur, l'accord des RH, ses avances des 12 derniers mois", () => {
    const f = fiche("avance");
    expect(f.origine).toBe("Avance sur salaire");
    expect(f.demandeur).toBe(`${TAG}Karim B.`);
    expect(etape("avance", "Avance accordée")?.etat).toBe("OK");
    expect(f.historique?.replace(/\s/g, " ")).toBe("1 autre avance en 12 mois, 20 000 DZD");
  });

  it("CAISSE : la remise inscrite, hors budget, sans alerte de bénéficiaire", () => {
    const f = fiche("caisse");
    expect(f.origine).toBe("Caisse d'avance");
    expect(f.budget.etat).toBe("HORS_ENVELOPPE");
    expect(etape("caisse", "Remise inscrite")?.detail).toMatch(/détentrice/);
    expect(titres("caisse")).not.toContain("Bénéficiaire nouveau");
  });

  it("PRISE EN CHARGE : l'origine dite, le BC de l'ordre dans la chaîne, la facture au-delà de la marge en rouge", () => {
    const f = fiche("pec");
    expect(f.origine).toBe("Prise en charge");
    expect(etape("pec", "BC n°")?.etat).toBe("OK");
    expect(titres("pec")).toContain("Montant au-dessus du BC");
    expect(f.montants.find((m) => m.libelle === "À payer")?.ecart).toBe(true);
  });

  it("SECRÉTARIAT : la référence de la demande, l'accord du N+1, le montant validé en jalon", () => {
    const f = fiche("secretariat");
    expect(f.origine).toBe("Secrétariat");
    expect(f.reference).toContain(`${TAG}REQ-12`);
    expect(etape("secretariat", "Accord du N+1")?.etat).toBe("OK");
    expect(f.montants.find((m) => m.libelle === "Validé")?.valeur).toBe(80_000);
    expect(titres("secretariat")).not.toContain("Montant au-dessus de l'accordé");
  });

  it("SANS ORIGINE : le minimum, sans rien inventer", () => {
    const f = fiche("nu");
    expect(f.objet).toBe(`${TAG}nu`);
    expect(f.montant).toBe(1_000);
    expect(f.chaine).toEqual([]);
    expect(f.montants).toEqual([]);
    expect(f.demandeur).toBe(`${TAG}demandeur`);
    expect(f.dejaPaye).toMatch(/^Rien d'autre/);
  });

  it("SÉPARATION DES TÂCHES dite AVANT le clic : le siège qui a demandé ne peut pas autoriser, et la fiche le dit", () => {
    expect(fiche("du-siege").refusAutoriser).toMatch(/Vous avez demandé ce paiement/);
    expect(titres("du-siege")).toContain("Demandeur = décideur");
    expect(fiche("poste").refusAutoriser).toBeNull();
  });

  it("UNE BRIQUE EN PANNE n'emporte pas l'écran : chaque fiche le dit, et le reste est là", async () => {
    const enPanne = {
      ...BRIQUES_DU_CENTRE,
      apports: [{ nom: "Ad & Pro", lire: async () => { throw new Error("panne simulée"); } }, ...(BRIQUES_DU_CENTRE.apports ?? []).slice(1)],
      budget: async () => { throw new Error("budget illisible"); },
    };
    const lus = await contexteDecisionDesOrdres([o.poste, o.paie], siege, { briques: enPanne });
    expect(lus).toHaveLength(2);
    const poste = lus.find((f) => f.id === o.poste)!;
    const partiel = poste.alertes.find((a) => a.titre === "Contexte incomplet");
    expect(partiel?.detail).toMatch(/Ad & Pro/);
    expect(partiel?.detail).toMatch(/budget/);
    expect(poste.budget.etat).toBe("INCONNU");
    expect(poste.montant).toBe(450_000);
    // La paie ne dépend d'aucune des briques tombées : ses faits sont là.
    expect(lus.find((f) => f.id === o.paie)!.chaine.some((c) => c.etape.startsWith("Paie calculée"))).toBe(true);
  });

  it("LE DOSSIER DE LA DEMANDE s'ouvre en LECTURE au siège sans droit Finances, et son « Refuser » s'appelle « Annuler la demande »", async () => {
    // Un Directeur Général dont la console a fermé le module Finances : il siège, il lit, il n'écrit pas.
    const sansFinances = { ...siege, access: { ...siege.access, modules: new Map([...siege.access.modules].filter(([m]) => m !== "FINANCES")) } } as SessionUser;
    expect(await canAccessEntity(sansFinances, "PAYMENT_REQUEST", prId, "VIEW")).toBe(true);
    expect(await canAccessEntity(sansFinances, "PAYMENT_REQUEST", prId, "UPDATE"), "lecture seule").toBe(false);
    const page = readFileSync("src/app/(app)/validations/paiements/[id]/page.tsx", "utf8");
    expect(page).toMatch(/!siegeDuCentre\) redirect\(/);
    const dossier = readFileSync("src/app/(app)/validations/paiements/[id]/dossier.tsx", "utf8");
    expect(dossier).toMatch(/\} Annuler la demande\n/);
    expect(dossier, "le geste qui ANNULE l'ordre ne se nomme plus comme le refus du centre").not.toMatch(/<X className="h-4 w-4" \/>\} Refuser/);
  });
});
