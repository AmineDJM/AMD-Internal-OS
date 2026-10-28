import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// Luna ne sort pas d'un banc : la lecture d'une pièce rend ce que le test décide (le montant lu, le fournisseur).
let LU: { ttc: number | null; fournisseur: string | null } = { ttc: null, fournisseur: null };
vi.mock("@/lib/factures/connues", async (orig) => {
  const vrai = await orig<typeof import("@/lib/factures/connues")>();
  const { IDENTITE_FACTURE_VIDE } = await import("@/lib/factures/identite");
  return {
    ...vrai,
    chargerFacturesConnues: async () => [],
    lireIdentiteDuDepot: async () => ({ ...IDENTITE_FACTURE_VIDE, ttc: LU.ttc, fournisseur: { ...IDENTITE_FACTURE_VIDE.fournisseur, nom: LU.fournisseur } }),
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBudgetOverview, getEnvelopesGrandTotal } from "@/lib/queries/budget";
import { rapportMarketing } from "@/lib/queries/budget-marketing-rapport";
import { depensesPostesMarketing } from "@/lib/queries/budget-marketing-depenses";
import { demandesAdProDeLEnveloppe } from "@/lib/queries/budget-marketing";
import { cellulesSynthetiques } from "./integration-fixture";
import { TOTAL_ATTENDU_CENTIMES } from "./integration-2026";
import { apercuIntegration, blocHistoriqueDe, lireFichierIntegration, vueDuLot, type ChoixDemande } from "./integration-serveur";
import { appliquerDecisionsLocales } from "./integration-absentes";
import {
  annulerIntegrationAdPro, deciderAbsenteIntegration, joindrePiecesIntegration, rattacherPieceIntegration, relierEcritureIntegration, validerIntegrationAdPro,
} from "@/lib/actions/integration-adpro-actions";
import { submitAdProItem, requestAdProItemOrder } from "@/modules/ad-pro/actions-postes";
import { addCareBeneficiary } from "@/modules/ad-pro/actions-prise-en-charge";
import { imputerDepensePoste } from "@/lib/actions/budget-depense-poste-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__integ${Date.now().toString(36)}__`;
const arrondi = (n: number) => Math.round(n * 100) / 100;

const classeur = (): Uint8Array => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cellulesSynthetiques()), "Feuil1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
};
const fichier = () => new File([classeur() as BlobPart], `${TAG}depenses.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const pdf = (nom: string, octet: number) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, octet, octet + 1])], nom, { type: "application/pdf" });
const form = (champs: Record<string, string | File | File[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) {
    if (Array.isArray(v)) for (const f of v) fd.append(k, f); else fd.set(k, v);
  }
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉGRATION AD & PRO 2026 PAR LES VRAIS POINTS D'ENTRÉE, SUR LA BASE LOCALE — fixture SYNTHÉTIQUE du format.
 *
 * Avant → après (total au centime, sous-catégories), pas de double compte (le paiement du webinaire est remplacé par la
 * ligne du fichier), la liste « absentes du fichier » et le choix garder / sortir, ce qui naît après compte, les pièces
 * manquantes NON bloquantes puis ajoutées, une pièce de la plateforme rattachée, les fiches voyageurs ajoutables,
 * aucun circuit sur un poste historique, l'annulation qui rend l'état d'avant AU CENTIME — et le livre de trésorerie
 * comme les ordres de dépense strictement inchangés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Intégration des dépenses réelles Ad & Pro 2026 — de bout en bout", () => {
  let actor: CurrentUser;
  let envId = "";
  const cat: Record<string, string> = {};
  let spoId = "", posteWebinaire = "", ordreId = "", txId = "", ligneAbsente = "", docPoste = "", txManuelle = "";
  let lotId = "";
  let avant: { consomme: number; engage: number; parCat: Map<string, { consomme: number; engage: number }> };
  let ledgerAvant: Map<string, string>;
  let ordresAvant: Map<string, string>;
  /** L'instant où les fixtures sont posées : tout ce qui existe avant est la référence du livre et des ordres. */
  let T0 = new Date();

  const ov = async () => (await getBudgetOverview(actor as SessionUser, envId, null, null, { portee: "MARKETING" }))!;
  const consommeDe = (o: Awaited<ReturnType<typeof ov>>, id: string) => o.categories.find((x) => x.id === id)?.consumed ?? 0;
  const empreinteLedger = async () => new Map((await prisma.financeTransaction.findMany({ where: { createdAt: { lt: T0 } }, select: { id: true, amount: true, status: true, budgetCategoryId: true, date: true, updatedAt: true } }))
    .map((t) => [t.id, `${t.amount}|${t.status}|${t.budgetCategoryId}|${t.date.toISOString()}|${t.updatedAt.toISOString()}`]));
  const empreinteOrdres = async () => new Map((await prisma.expenseOrder.findMany({ where: { createdAt: { lt: T0 } }, select: { id: true, amount: true, status: true, budgetCategoryId: true, transactionId: true, updatedAt: true } }))
    .map((o) => [o.id, `${o.amount}|${o.status}|${o.budgetCategoryId}|${o.transactionId}|${o.updatedAt.toISOString()}`]));
  /** Chaque écriture et chaque ordre qui existaient avant le test, et existent encore, sont restés identiques. */
  const ledgerInchange = async () => {
    const [l, o] = await Promise.all([empreinteLedger(), empreinteOrdres()]);
    for (const [id, v] of ledgerAvant) if (l.has(id)) expect(l.get(id), `écriture ${id}`).toBe(v);
    for (const [id, v] of ordresAvant) if (o.has(id)) expect(o.get(id), `ordre ${id}`).toBe(v);
    // Et rien de NEUF dans le livre ni dans les ordres qui touche notre enveloppe.
    const ids = Object.values(cat);
    expect(await prisma.financeTransaction.count({ where: { createdAt: { gte: T0 }, budgetCategoryId: { in: ids } } })).toBe(0);
    expect(await prisma.expenseOrder.count({ where: { createdAt: { gte: T0 }, OR: [{ budgetCategoryId: { in: ids } }, { label: { contains: "Historique 2026" } }] } })).toBe(0);
    // Les fixtures du livre sont là, telles quelles.
    expect((await prisma.financeTransaction.findUnique({ where: { id: txId }, select: { amount: true, status: true } }))).toMatchObject({ status: "SETTLED" });
    expect(Number((await prisma.financeTransaction.findUnique({ where: { id: txId } }))!.amount)).toBe(53_350);
  };

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}dirmkt`, email: `${TAG}dirmkt@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    actor = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false };
    ACTOR = actor;
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Ad & Pro 2026`, domaine: "MARKETING", modules: [], isActive: false, periodStart: new Date(Date.UTC(2026, 0, 1)), periodEnd: new Date(Date.UTC(2026, 11, 31, 23, 59, 59)), totalAmount: 38_696_105 },
    });
    envId = env.id;
    const mk = async (cle: string, name: string, allocated: number, parentId: string | null = null) => {
      cat[cle] = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name, allocated, parentId } })).id;
    };
    await mk("spo", "Sponsoring", 8_100_000);
    await mk("evt", "Événements", 6_422_485);
    await mk("sym", "Symposium", 2_433_267, cat.evt);
    await mk("promo", "Matériel promotionnel", 5_000_000);
    await mk("pecI", "Congrès internationaux", 14_373_620); // reconnue sous son alias

    // LE WEBINAIRE SAI DÉJÀ DANS LA PLATEFORME — accordé et payé 53 350 (le fichier retient 53 550).
    spoId = (await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO-W`, institution: "Société Algérienne d'Infectiologie — webinaire", type: "Sponsoring webinaire", requestDate: new Date("2026-07-06T00:00:00Z"), amountGranted: 53_350, status: "CLOSED" },
    })).id;
    posteWebinaire = (await prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "ASSOCIATION_SUPPORT", label: "Appui au webinaire", amountGranted: 53_350, status: "APPROVED", budgetCategoryId: cat.spo } })).id;
    txId = (await prisma.financeTransaction.create({
      data: { reference: `${TAG}FIN`, direction: "OUT", category: "EVENEMENT", label: "Webinaire SAI", amount: 53_350, status: "SETTLED", date: new Date("2026-09-21T10:00:00Z"), budgetCategoryId: cat.spo },
    })).id;
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD`, label: "Webinaire SAI", amount: 53_350, status: "PAID", sourceType: "AD_PRO_ITEM", sourceId: posteWebinaire, budgetCategoryId: cat.spo, transactionId: txId },
    })).id;
    await prisma.adProItem.update({ where: { id: posteWebinaire }, data: { expenseOrderId: ordreId } });
    // Une pièce déjà sur le poste (la facture de la SAI) — rattachable, jamais redéposée.
    docPoste = (await prisma.document.create({ data: { name: `${TAG}facture-SAI.pdf`, entityType: "AD_PRO_ITEM", entityId: posteWebinaire, category: "OTHER" } })).id;
    // CE QUI COMPTAIT ET N'EST DANS AUCUNE LIGNE : une ligne budgétaire saisie à la main.
    // Une écriture saisie à la main, sans ordre : absente du fichier… jusqu'à ce qu'on la RELIE à sa demande.
    txManuelle = (await prisma.financeTransaction.create({
      data: { reference: `${TAG}FIN-M`, direction: "OUT", category: "EVENEMENT", label: "Billet orateur symposium SAI", amount: 20_000, status: "SETTLED", date: new Date("2026-10-30T10:00:00Z"), budgetCategoryId: cat.spo },
    })).id;
    ligneAbsente = (await prisma.budgetExpenseLine.create({ data: { categoryId: cat.promo, reference: `${TAG}Kakémonos hors fichier`, amount: 100_000, date: new Date("2026-03-15T00:00:00Z"), createdAt: new Date("2026-03-15T00:00:00Z") } })).id;

    const o = await ov();
    avant = { consomme: o.totals.consumed, engage: o.totals.committed, parCat: new Map(o.categories.map((x) => [x.id, { consomme: x.consumed, engage: x.committed }])) };
    T0 = new Date(Date.now() + 1);
    ledgerAvant = await empreinteLedger();
    ordresAvant = await empreinteOrdres();
  });

  afterAll(async () => {
    if (!dbOk) return;
    const lots = await prisma.adProIntegrationLot.findMany({ where: { envelopeId: envId }, include: { demandes: true } });
    for (const l of lots) for (const d of l.demandes.filter((x) => x.mode === "CREEE")) {
      const where = { where: { id: d.demandeId } };
      await prisma.document.deleteMany({ where: { entityId: d.demandeId } });
      if (d.demandeType === "SPONSORING") await prisma.sponsoringRequest.deleteMany(where);
      if (d.demandeType === "CONGRESS_NATIONAL") await prisma.congressNational.deleteMany(where);
      if (d.demandeType === "CONGRESS_INTERNATIONAL") await prisma.congressInternational.deleteMany(where);
      if (d.demandeType === "EVENT") await prisma.event.deleteMany(where);
      if (d.demandeType === "TRAINING") await prisma.training.deleteMany(where);
      if (d.demandeType === "PROMO_MATERIAL") await prisma.promoMaterial.deleteMany(where);
      if (d.demandeType === "MEDICAL_INFO_DECLARATION") await prisma.medicalInfoDeclaration.deleteMany(where);
    }
    await prisma.adProIntegrationLot.deleteMany({ where: { envelopeId: envId } });
    await prisma.document.deleteMany({ where: { OR: [{ entityId: { in: [envId, posteWebinaire, spoId] } }, { name: { startsWith: TAG } }] } });
    await prisma.expenseOrder.deleteMany({ where: { id: ordreId } });
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } });
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } });
    await prisma.financeTransaction.deleteMany({ where: { id: { in: [txId, txManuelle] } } });
    await prisma.budgetExpenseLine.deleteMany({ where: { category: { envelopeId: envId } } });
    await prisma.adProItem.updateMany({ where: { budgetCategory: { envelopeId: envId } }, data: { budgetCategoryId: null } });
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId, parentId: { not: null } } });
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } });
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } });
    await prisma.careBeneficiary.deleteMany({ where: { lastName: { startsWith: TAG } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.user.deleteMany({ where: { id: actor.id } });
  });

  const choix = (): ChoixDemande[] => [
    ...["D-L5", "D-L7", "D-L9", "D-L32", "D-L10", "D-L25", "D-L21", "D-L28", "D-L11", "D-L23", "D-L30", "D-L14", "D-L13", "D-L18", "D-L37", "D-L39", "D-L38", "D-L15", "D-L16", "D-L20", "D-L40", "D-L17", "D-L12", "D-L49", "D-L48", "D-L45", "D-L44", "D-L42", "D-L43"]
      .map((cle) => ({ cle, mode: "CREEE" as const })),
    { cle: "D-L19", mode: "COMPLETEE", type: "SPONSORING", demandeId: spoId },
  ];
  const champs = (extra: Record<string, string> = {}) => ({
    fichier: fichier(), envelopeId: envId, choix: JSON.stringify(choix()), decisions: "[]", dossierPromoDuVisa: "lot:D-L37", ...extra,
  });

  it("l'aperçu : avant → après au centime, le paiement du webinaire remplacé, la ligne hors fichier « absente »", async () => {
    const lu = lireFichierIntegration(classeur());
    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    const ap = await apercuIntegration(actor as SessionUser, lu.plan, { envelopeId: envId, choix: choix(), decisions: [] });
    if ("erreur" in ap) throw new Error(ap.erreur);
    expect(ap.historiqueCentimes).toBe(TOTAL_ATTENDU_CENTIMES);
    expect(arrondi(ap.totalApres.consomme)).toBe(arrondi(avant.consomme - 53_350 + 33_558_715.94));
    expect(ap.remplacees.map((r) => r.cle)).toContain(`TX:${txId}`);
    expect(ap.absentes.map((a) => a.cle)).toContain(`LIGNE:${ligneAbsente}`);
    const sym = ap.lignes.find((l) => l.id === cat.sym)!;
    expect(arrondi(sym.apres.consomme)).toBe(410_950);
    expect(ap.lignes.filter((l) => l.creee).map((l) => l.nom).sort()).toEqual(["Consulting", "Formation", "Prise en charge nationale", "Réunions", "Staff post-event", "Tables rondes"].sort());
  });

  it("la validation exige la double confirmation, puis écrit le lot d'un bloc : 30 demandes, 33 558 715,94 DZD", async () => {
    const sans = await validerIntegrationAdPro(form(champs({ verifie: "on", confirmation: "oui" })));
    expect(sans.ok).toBe(false);
    expect(await prisma.adProIntegrationLot.count({ where: { envelopeId: envId } })).toBe(0);
    const r = await validerIntegrationAdPro(form(champs({ verifie: "on", confirmation: "INTÉGRER" })));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    lotId = r.id!;
    const lot = await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId }, include: { demandes: true } });
    expect(lot.demandes).toHaveLength(30);
    expect(lot.demandes.filter((d) => d.mode === "CREEE")).toHaveLength(29);
    expect(Number(lot.total)).toBe(33_558_715.94);
    // Un second lot sur la même enveloppe est refusé (un seul lot actif).
    const bis = await validerIntegrationAdPro(form(champs({ verifie: "on", confirmation: "INTÉGRER" })));
    expect(bis.ok).toBe(false);
  });

  it("le budget après : total au centime, catégories et sous-catégories, jamais deux fois le webinaire", async () => {
    const o = await ov();
    expect(arrondi(o.totals.consumed)).toBe(arrondi(avant.consomme - 53_350 + 33_558_715.94));
    // Sponsoring : 8 043 208,50 du fichier (dont 53 550 du webinaire) — le paiement de 53 350 ne s'y ajoute pas.
    // (+ l'écriture saisie à la main, absente du fichier, comptée tant qu'on n'a rien décidé.)
    expect(arrondi(consommeDe(o, cat.spo))).toBe(8_063_208.5);
    expect(arrondi(consommeDe(o, cat.sym))).toBe(410_950);
    const parNom = (n: string) => o.categories.find((x) => x.name === n)!;
    expect(arrondi(parNom("Staff post-event").consumed)).toBe(1_140_400.44);
    expect(arrondi(parNom("Réunions").consumed)).toBe(1_643_792);
    expect(arrondi(parNom("Prise en charge nationale").consumed)).toBe(124_750);
    expect(arrondi(parNom("Formation").consumed)).toBe(350_000);
    expect(arrondi(consommeDe(o, cat.pecI))).toBe(18_789_940);
    // Matériel promotionnel : 3 055 675 du fichier (dont le visa 240 000) + la ligne hors fichier, encore « à décider ».
    expect(arrondi(consommeDe(o, cat.promo))).toBe(3_155_675);
    expect(o.integration).toMatchObject({ lotId, aDecider: 2 });
    // Les montants ALLOUÉS n'ont pas bougé ; les catégories créées le sont à 0.
    expect(o.categories.find((x) => x.id === cat.spo)!.allocated).toBe(8_100_000);
    expect(parNom("Formation").allocated).toBe(0);
    // Le total des enveloppes, le rapport (faits) et les onglets lisent la même règle.
    const gt = await getEnvelopesGrandTotal(actor as SessionUser, { portee: "MARKETING" });
    expect(arrondi(gt.items.find((i) => i.id === envId)!.consumed)).toBe(arrondi(o.totals.consumed));
    const { rapport } = await rapportMarketing(actor as SessionUser, o, { n1: false });
    expect(arrondi(rapport.faits.reduce((s, f) => s + (f.cat ? f.montant : 0), 0))).toBe(arrondi(o.totals.consumed));
    const lignes = await demandesAdProDeLEnveloppe(o.categories.map((x) => ({ id: x.id, name: x.name })));
    expect(lignes.find((l) => l.id === posteWebinaire)).toMatchObject({ regle: 53_550, historique: { ligne: 19 } });
    const { donnees } = await depensesPostesMarketing(actor as SessionUser, o);
    expect(donnees.lignes.find((l) => l.id === posteWebinaire)).toMatchObject({ etat: "PAYEE", paye: 53_550 });
    await ledgerInchange();
  });

  it("« absentes du fichier » : la sortir retire ses 100 000, la garder les rend — rien n'est effacé", async () => {
    const vue = (await vueDuLot(actor as SessionUser, envId))!;
    expect(vue.absentes.map((a) => a.cle).sort()).toEqual([`LIGNE:${ligneAbsente}`, `TX:${txManuelle}`].sort());
    expect(vue.remplacees.map((r) => r.cle)).toContain(`TX:${txId}`);
    const avantChoix = consommeDe(await ov(), cat.promo);
    const r = await deciderAbsenteIntegration(form({ lotId, cleSource: `LIGNE:${ligneAbsente}`, decision: "SORTIR", libelle: "Kakémonos", montant: "100000" }));
    expect(r.ok).toBe(true);
    expect(arrondi(consommeDe(await ov(), cat.promo))).toBe(arrondi(avantChoix - 100_000));
    expect(await prisma.budgetExpenseLine.count({ where: { id: ligneAbsente } })).toBe(1);
    await deciderAbsenteIntegration(form({ lotId, cleSource: `LIGNE:${ligneAbsente}`, decision: "GARDER" }));
    expect(arrondi(consommeDe(await ov(), cat.promo))).toBe(arrondi(avantChoix));
    expect((await ov()).integration?.aDecider).toBe(1);
    // RELIER l'écriture manuelle à la demande SAI (lecture seule) : elle EST cette dépense — remplacée, plus absente.
    const lot = await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId }, include: { demandes: true } });
    const sai = lot.demandes.find((d) => d.ligne === 21)!;
    const r2 = await relierEcritureIntegration(form({ demandeRowId: sai.id, reference: `${TAG}FIN-M` }));
    expect(r2.ok).toBe(true);
    const o2 = await ov();
    expect(arrondi(consommeDe(o2, cat.spo))).toBe(8_043_208.5);
    expect(o2.integration?.aDecider).toBe(0);
    expect((await vueDuLot(actor as SessionUser, envId))!.remplacees.map((x) => x.cle)).toContain(`TX:${txManuelle}`);
    const bloc = (await blocHistoriqueDe(actor as SessionUser, "SPONSORING", sai.demandeId))!;
    expect(bloc.ecriture).toMatchObject({ montant: 20_000, ecart: 1_695_475 });
  });

  it("ce qui naît après l'intégration compte, comme d'habitude", async () => {
    const l = await prisma.budgetExpenseLine.create({ data: { categoryId: cat.spo, reference: `${TAG}après`, amount: 1_000, date: new Date("2026-10-20T00:00:00Z") } });
    expect(arrondi(consommeDe(await ov(), cat.spo))).toBe(8_044_208.5); // 8 043 208,50 + 1 000
    await prisma.budgetExpenseLine.delete({ where: { id: l.id } });
  });

  it("une demande historique : badge, « Direction Marketing », postes payés, pièces manquantes NON bloquantes puis jointes", async () => {
    const lot = await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId }, include: { demandes: true } });
    const sai = lot.demandes.find((d) => d.ligne === 21)!;
    const bloc = (await blocHistoriqueDe(actor as SessionUser, "SPONSORING", sai.demandeId))!;
    expect(bloc).toMatchObject({ badge: true, demandeurAffiche: "Direction Marketing", montant: 1_715_475 });
    expect(bloc.postes.map((p) => [p.libelle, p.montant, p.imputation])).toEqual([
      ["Sponsoring", 1_500_000, "Sponsoring"],
      ["Symposium : honoraires orateur", 195_475, "Événements › Symposium"],
      ["Symposium : billetterie", 8_000, "Événements › Symposium"],
      ["Symposium : hébergement", 12_000, "Événements › Symposium"],
    ]);
    expect(bloc.manquantes).toBe(6);
    // Aucun circuit : ni demande de validation, ni ordre — la demande est close, ses postes accordés et payés.
    expect(await prisma.workflowInstance.count({ where: { entityId: sai.demandeId } })).toBe(0);
    LU = { ttc: 1_500_000, fournisseur: "SAI" };
    const r = await joindrePiecesIntegration(form({ demandeRowId: sai.id, cle: "convention", fichiers: [pdf(`${TAG}convention.pdf`, 1), pdf(`${TAG}annexe.pdf`, 7)] }));
    expect(r.ok).toBe(true);
    LU = { ttc: 1_400_000, fournisseur: null };
    const ecart = await joindrePiecesIntegration(form({ demandeRowId: sai.id, cle: "facture", fichiers: [pdf(`${TAG}facture.pdf`, 3)] }));
    expect(ecart.ok).toBe(true);
    expect(ecart.message).toMatch(/l'écart reste affiché/);
    const apres = (await blocHistoriqueDe(actor as SessionUser, "SPONSORING", sai.demandeId))!;
    expect(apres.manquantes).toBe(4);
    expect(apres.pieces.find((p) => p.cle === "convention")!.fichiers).toHaveLength(2);
  });

  it("une demande complétée : écart affiché, pièce de la plateforme rattachée (pas redéposée), poste rendu historique", async () => {
    const bloc = (await blocHistoriqueDe(actor as SessionUser, "SPONSORING", spoId))!;
    expect(bloc).toMatchObject({ badge: false, mode: "COMPLETEE", montant: 53_550 });
    expect(bloc.postes).toEqual([expect.objectContaining({ id: posteWebinaire, montant: 53_550, repris: true })]);
    expect(bloc.rattachables.map((x) => x.documentId)).toContain(docPoste);
    const r = await rattacherPieceIntegration(form({ demandeRowId: bloc.demandeRowId, cle: "facture", documentId: docPoste }));
    expect(r.ok).toBe(true);
    const apres = (await blocHistoriqueDe(actor as SessionUser, "SPONSORING", spoId))!;
    expect(apres.pieces.find((p) => p.cle === "facture")!.fichiers[0]).toMatchObject({ id: docPoste, rattachee: true });
    expect(await prisma.document.count({ where: { entityType: "SPONSORING", entityId: spoId } })).toBe(0);
  });

  it("aucun circuit sur un poste historique ; les fiches voyageurs s'ajoutent à tout moment", async () => {
    const lot = await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId }, include: { demandes: true } });
    const sai = lot.demandes.find((d) => d.ligne === 21)!;
    const poste = (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: sai.demandeId } })).id;
    for (const geste of [submitAdProItem, requestAdProItemOrder]) {
      const r = await geste(undefined, form({ id: poste }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Historique 2026/);
    }
    expect((await imputerDepensePoste(form({ id: poste, categorieId: cat.spo }))).error).toMatch(/Historique 2026/);
    const aids = lot.demandes.find((d) => d.ligne === 5)!;
    expect(aids.demandeType).toBe("CONGRESS_INTERNATIONAL");
    const f = await addCareBeneficiary(undefined, form({ scope: "INTERNATIONAL", requestId: aids.demandeId, lastName: `${TAG}Voyageur`, firstName: "Amina" }));
    expect(f.ok).toBe(true);
    expect(await prisma.careBeneficiary.count({ where: { congressInternationalId: aids.demandeId } })).toBe(1);
    // Le visa : une déclaration DIM « visa publicitaire » validée, son bon PAYÉ, rattachée au dossier promo couvert.
    const visa = lot.demandes.find((d) => d.ligne === 40)!;
    const dim = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: visa.demandeId }, include: { slips: true } });
    const campagne = lot.demandes.find((d) => d.ligne === 37)!;
    expect(dim).toMatchObject({ declarationKind: "AD_VISA", status: "VALIDATED", sourceType: "PROMO_MATERIAL", sourceId: campagne.demandeId });
    expect(dim.reference).toMatch(/^DIM-2026-/);
    expect(dim.slips).toHaveLength(1);
    expect(Number(dim.slips[0].amount)).toBe(240_000);
    expect(dim.slips[0].deliveredAt).not.toBeNull();
  });

  it("l'annulation d'un bloc rend l'état d'avant AU CENTIME, sans toucher au livre ni aux ordres", async () => {
    const refus = await annulerIntegrationAdPro(form({ lotId, motif: "", confirmation: "ANNULER" }));
    expect(refus.ok).toBe(false);
    const lot = await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId }, include: { demandes: true } });
    const creees = lot.demandes.filter((d) => d.mode === "CREEE");
    const r = await annulerIntegrationAdPro(form({ lotId, motif: "Test : rejouer l'intégration", confirmation: "ANNULER" }));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const o = await ov();
    expect(arrondi(o.totals.consumed)).toBe(arrondi(avant.consomme));
    expect(arrondi(o.totals.committed)).toBe(arrondi(avant.engage));
    for (const [id, v] of avant.parCat) {
      const x = o.categories.find((k) => k.id === id)!;
      expect(arrondi(x.consumed), id).toBe(arrondi(v.consomme));
      expect(arrondi(x.committed), id).toBe(arrondi(v.engage));
    }
    // Les catégories créées par le lot sont retirées ; les demandes historiques aussi ; le webinaire est rendu.
    expect(o.categories.map((x) => x.id).sort()).toEqual(Object.values(cat).sort());
    expect(o.integration ?? null).toBeNull();
    expect(await prisma.sponsoringRequest.count({ where: { id: { in: creees.filter((d) => d.demandeType === "SPONSORING").map((d) => d.demandeId) } } })).toBe(0);
    expect(await prisma.medicalInfoDeclaration.count({ where: { id: { in: creees.filter((d) => d.demandeType === "MEDICAL_INFO_DECLARATION").map((d) => d.demandeId) } } })).toBe(0);
    const w = await prisma.adProItem.findUniqueOrThrow({ where: { id: posteWebinaire } });
    expect(w).toMatchObject({ montantPayeHistorique: null, historiqueLotId: null, budgetCategoryId: cat.spo, historiqueAvant: null });
    expect(await prisma.sponsoringRequest.count({ where: { id: spoId } })).toBe(1);
    await ledgerInchange();
    // Le lot reste, annulé, motif au journal ; une nouvelle intégration redevient possible.
    expect((await prisma.adProIntegrationLot.findUniqueOrThrow({ where: { id: lotId } })).annuleLe).not.toBeNull();
  });

  it("« garder / sortir » choisis À L'ÉTAPE 4 : l'aperçu recalculé à l'écran est celui du serveur, et les choix s'écrivent avec le lot", async () => {
    // UN fichier, lu une fois : son empreinte accompagne l'aperçu et la validation.
    const octets = classeur();
    const lu = lireFichierIntegration(octets);
    if (!lu.ok) throw new Error(lu.erreurs.join(" "));
    const leFichier = () => new File([octets as BlobPart], `${TAG}depenses.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const kakemonos = `LIGNE:${ligneAbsente}`, billet = `TX:${txManuelle}`;

    // L'écran recalcule sans redemander le fichier — et tombe sur le calcul du serveur, ligne par ligne.
    const base = await apercuIntegration(actor as SessionUser, lu.plan, { envelopeId: envId, choix: choix(), decisions: [] });
    if ("erreur" in base) throw new Error(base.erreur);
    expect(base.absentes.map((a) => a.cle).sort()).toEqual([kakemonos, billet].sort());
    expect(base.absentes.find((a) => a.cle === kakemonos)).toMatchObject({ categoryId: cat.promo, effet: "CONSOMME" });
    const local = appliquerDecisionsLocales(base, { [kakemonos]: "SORTIR", [billet]: "GARDER" });
    const serveur = await apercuIntegration(actor as SessionUser, lu.plan, { envelopeId: envId, choix: choix(), decisions: [{ cleSource: kakemonos, decision: "SORTIR" }, { cleSource: billet, decision: "GARDER" }] });
    if ("erreur" in serveur) throw new Error(serveur.erreur);
    expect(arrondi(local.totalApres.consomme)).toBe(arrondi(serveur.totalApres.consomme));
    for (const l of serveur.lignes) expect(local.lignes.find((x) => x.id === l.id)!.apres, l.nom).toEqual({ consomme: arrondi(l.apres.consomme), engage: arrondi(l.apres.engage) });

    const decisions = JSON.stringify([
      { cleSource: kakemonos, decision: "SORTIR", libelle: "Kakémonos hors fichier", montant: 100_000 },
      { cleSource: billet, decision: "GARDER", libelle: "Billet orateur symposium SAI", montant: 20_000 },
      { cleSource: "INCONNU:x", decision: "SORTIR" }, // écartée : pas une source de la règle
    ]);
    // Un fichier REMPLACÉ depuis la lecture (autre empreinte) est refusé : rien n'est écrit.
    const change = await validerIntegrationAdPro(form({ ...champs({ verifie: "on", confirmation: "INTÉGRER", decisions, sha256: "0".repeat(64) }), fichier: leFichier() }));
    expect(change.ok).toBe(false);
    expect(change.error).toMatch(/a changé depuis sa lecture/);
    expect(await prisma.adProIntegrationLot.count({ where: { envelopeId: envId, annuleLe: null } })).toBe(0);

    const r = await validerIntegrationAdPro(form({ ...champs({ verifie: "on", confirmation: "INTÉGRER", decisions, sha256: lu.sha256 }), fichier: leFichier() }));
    expect(r.error).toBeUndefined();
    const lot2 = r.id!;
    // Les choix sont nés AVEC le lot, libellé et montant au journal.
    const rangs = await prisma.adProIntegrationDecision.findMany({ where: { lotId: lot2 }, orderBy: { cleSource: "asc" } });
    expect(rangs.map((d) => [d.cleSource, d.decision]).sort()).toEqual([[billet, "GARDER"], [kakemonos, "SORTIR"]].sort());
    expect(rangs.find((d) => d.cleSource === kakemonos)).toMatchObject({ libelle: "Kakémonos hors fichier" });
    expect(Number(rangs.find((d) => d.cleSource === kakemonos)!.montant)).toBe(100_000);
    // Le consommé APRÈS : les kakémonos sortis (le fichier seul en matériel promotionnel), le billet gardé.
    const o = await ov();
    expect(arrondi(consommeDe(o, cat.promo))).toBe(3_055_675);
    expect(arrondi(consommeDe(o, cat.spo))).toBe(8_063_208.5);
    expect(arrondi(o.totals.consumed)).toBe(arrondi(serveur.totalApres.consomme));
    expect(o.integration).toMatchObject({ lotId: lot2, aDecider: 0 });
    expect(await prisma.budgetExpenseLine.count({ where: { id: ligneAbsente } })).toBe(1); // rien n'est effacé
    await ledgerInchange();
    // Remis comme avant (le banc rend la base telle qu'il l'a trouvée).
    const a = await annulerIntegrationAdPro(form({ lotId: lot2, motif: "Test : fin du banc", confirmation: "ANNULER" }));
    expect(a.ok).toBe(true);
  });
});
