import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { LuDePiece } from "./rapprochement";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// LUNA NE SORT JAMAIS D'UN BANC : la lecture rend ce que le test décide, et chaque appel est compté (le cache le prouve).
const APPELS: string[] = [];
const LUS: Record<string, LuDePiece> = {};
vi.mock("@/lib/budget-marketing/rapprochement-luna", async (orig) => {
  const vrai = await orig<typeof import("./rapprochement-luna")>();
  return {
    ...vrai,
    lirePieceParLuna: async (_u: string, _o: Buffer, nom: string) => {
      APPELS.push(nom);
      const lu = LUS[nom];
      return lu ? { ok: true as const, lu, lectureId: null } : { ok: false as const, raison: "rien de lisible (banc)" };
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { saveFile, deleteFileByKey } from "@/lib/storage";
import { getBudgetOverview } from "@/lib/queries/budget";
import { depensesPostesMarketing } from "@/lib/queries/budget-marketing-depenses";
import { blocHistoriqueDe } from "./integration-serveur";
import { piecesRattacheesDe } from "./integration-vue";
import { horsPostesAdPro } from "./depenses-autres";
import { ecrituresRapprochees, lireTranche, rapprochementDesAImputer, vueRapprochement } from "./rapprochement-serveur";
import {
  accepterRapprochementsCertains, annulerDecisionRapprochement, deciderRapprochement, lireTranchePiecesRapprochement,
} from "@/lib/actions/rapprochement-adpro-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `rapp${Date.now().toString(36)}`;
const N = 900_000 + Math.floor(Math.random() * 99_999);
const SPO_REF = `SPO-2026-${N}`;
const FOURNISSEUR = `Lotus Media ${TAG}`;
const form = (champs: Record<string, string | null | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) if (v) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AD & PRO PAR SES VRAIS POINTS D'ENTRÉE, SUR LA BASE LOCALE — fixtures SYNTHÉTIQUES.
 *
 * Les gardes (seul le gestionnaire de l'enveloppe), la lecture des pièces par tranches et son cache (une pièce n'est lue
 * qu'une fois), les propositions (dépense → demande « certaine », pièce → pièce attendue, « pas Ad & Pro », doublon),
 * « Accepter toutes les propositions certaines », le choix d'une autre demande, le refus, l'annulation — et le budget :
 * une écriture rattachée NE COMPTE PLUS DEUX FOIS, l'annulation la fait revenir, le livre de trésorerie ne bouge pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Rapprochement Ad & Pro — de bout en bout", () => {
  let actor: CurrentUser;
  let autre: CurrentUser;
  let envId = "";
  const cat: Record<string, string> = {};
  let spo1 = "", spo2 = "", poste1 = "", poste2 = "", lotId = "", row1 = "", row2 = "";
  let tx1 = "", tx2 = "", tx3 = "", tx4 = "", ligne = "", legal = "", docFacture = "", docVirement = "", docNotes = "";
  const cles = [`${TAG}/facture.pdf`, `${TAG}/virement.pdf`, `${TAG}/notes.txt`];
  const empreinteLivre = async () => (await prisma.financeTransaction.findMany({ where: { id: { in: [tx1, tx2, tx3, tx4] } }, orderBy: { id: "asc" } }))
    .map((t) => `${t.id}|${t.amount}|${t.status}|${t.budgetCategoryId}|${t.updatedAt.toISOString()}`).join("\n");
  let livreAvant = "";

  const ov = async () => (await getBudgetOverview(actor as SessionUser, envId, null, null, { portee: "MARKETING" }))!;
  const vue = async () => (await vueRapprochement(actor as SessionUser, envId))!;

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}dirmkt`, email: `${TAG}dirmkt@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    actor = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false };
    const v = await prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lecteur@t.dz`, role: "VIEWER", passwordHash: "x" } });
    autre = { id: v.id, name: v.name, email: v.email, role: "VIEWER", access: await getAccess(v.id, "VIEWER"), mustChangePassword: false };
    ACTOR = actor;

    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Ad & Pro 2026`, domaine: "MARKETING", modules: [], isActive: false, periodStart: new Date(Date.UTC(2026, 0, 1)), periodEnd: new Date(Date.UTC(2026, 11, 31, 23, 59, 59)), totalAmount: 10_000_000 },
    })).id;
    for (const [k, name] of [["spo", "Sponsoring"], ["promo", "Matériel promotionnel"]] as const) {
      cat[k] = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name, allocated: 3_000_000 } })).id;
    }
    // Deux demandes « Historique 2026 » et leur poste payé.
    spo1 = (await prisma.sponsoringRequest.create({ data: { reference: SPO_REF, institution: `Webinaire infectiologie ${TAG}`, type: "Sponsoring webinaire", requestDate: new Date("2026-07-31T12:00:00Z"), amountGranted: 53_550, status: "CLOSED" } })).id;
    spo2 = (await prisma.sponsoringRequest.create({ data: { reference: `SPO-2026-${N + 1}`, institution: `Journées de pneumologie ${TAG}`, type: "Sponsoring congrès", requestDate: new Date("2026-03-31T12:00:00Z"), amountGranted: 501_000, status: "CLOSED" } })).id;
    lotId = (await prisma.adProIntegrationLot.create({
      data: { envelopeId: envId, configVersion: "banc", fichierNom: `${TAG}.xlsx`, fichierSha256: TAG, total: 554_550, integreLe: new Date(Date.now() + 10 * 60_000), instantaneAvant: {}, lignes: [], creeParId: actor.id },
    })).id;
    poste1 = (await prisma.adProItem.create({ data: { sponsoringId: spo1, kind: "ASSOCIATION_SUPPORT", label: "Appui au webinaire", amountGranted: 53_550, status: "APPROVED", budgetCategoryId: cat.spo, supplier: FOURNISSEUR, historiqueLotId: lotId, historiqueLigne: 23, montantPayeHistorique: 53_550, historiquePayeLe: new Date("2026-07-31T12:00:00Z") } })).id;
    poste2 = (await prisma.adProItem.create({ data: { sponsoringId: spo2, kind: "CATERING", label: "Restauration", amountGranted: 501_000, status: "APPROVED", budgetCategoryId: cat.spo, supplier: `Traiteur Atlas ${TAG}`, historiqueLotId: lotId, historiqueLigne: 30, montantPayeHistorique: 501_000, historiquePayeLe: new Date("2026-03-31T12:00:00Z") } })).id;
    const attendues = [{ cle: "convention", libelle: "Convention ou lettre de sponsoring" }, { cle: "facture", libelle: "Facture" }, { cle: "virement", libelle: "Preuve de virement" }];
    row1 = (await prisma.adProIntegrationDemande.create({ data: { lotId, ligne: 23, lignes: [23], libelle: `Webinaire infectiologie ${TAG}`, demandeType: "SPONSORING", demandeId: spo1, mode: "CREEE", montant: 53_550, piecesAttendues: attendues } })).id;
    row2 = (await prisma.adProIntegrationDemande.create({ data: { lotId, ligne: 30, lignes: [30], libelle: `Journées de pneumologie ${TAG}`, demandeType: "SPONSORING", demandeId: spo2, mode: "CREEE", montant: 501_000, piecesAttendues: attendues } })).id;

    // LES DÉPENSES : une écriture imputée hors poste qui EST le webinaire (référence, fournisseur, montant) ; une impression
    // et une ligne budgétaire à 2 DZD près (doublon probable) ; deux écritures « à imputer » (une location de voiture, un traiteur).
    tx1 = (await prisma.financeTransaction.create({ data: { reference: `${TAG}-FIN-1`, direction: "OUT", category: "EVENEMENT", label: `Règlement ${SPO_REF} webinaire`, counterparty: FOURNISSEUR, amount: 53_550, status: "SETTLED", date: new Date("2026-07-20T10:00:00Z"), budgetCategoryId: cat.spo } })).id;
    tx2 = (await prisma.financeTransaction.create({ data: { reference: `${TAG}-FIN-2`, direction: "OUT", category: "FOURNISSEUR", label: "EPRINT impression", counterparty: `EPRINT ${TAG}`, amount: 35_817, status: "SETTLED", date: new Date("2026-05-12T10:00:00Z"), budgetCategoryId: cat.promo } })).id;
    ligne = (await prisma.budgetExpenseLine.create({ data: { categoryId: cat.promo, reference: `MP Goodies RIO ${TAG}`, amount: 35_819, date: new Date("2026-05-15T00:00:00Z") } })).id;
    tx3 = (await prisma.financeTransaction.create({ data: { reference: `${TAG}-FIN-3`, direction: "OUT", category: "VOYAGE", label: `Location voiture ${TAG}`, amount: 375_000, status: "SETTLED", date: new Date("2026-12-30T10:00:00Z") } })).id;
    tx4 = (await prisma.financeTransaction.create({ data: { reference: `${TAG}-FIN-4`, direction: "OUT", category: "EVENEMENT", label: "Restauration congrès", counterparty: `Traiteur Atlas ${TAG}`, amount: 501_000, status: "SETTLED", date: new Date("2026-12-29T10:00:00Z") } })).id;

    // LES PIÈCES : la facture au registre Legal (lue par Luna), une preuve de virement posée sur le poste (illisible), un
    // fichier que le lecteur ne lit pas (.txt).
    legal = (await prisma.legalDocument.create({ data: { title: `Facture Lotus ${TAG}`, kind: "INVOICE", status: "ACTIVE", counterparty: FOURNISSEUR, amount: 53_550, reference: `FA-${N}` } })).id;
    await saveFile(cles[0], Buffer.from(`%PDF-1.4 facture ${TAG}`));
    await saveFile(cles[1], Buffer.from(`%PDF-1.4 virement ${TAG}`));
    await saveFile(cles[2], Buffer.from(`notes ${TAG}`));
    docFacture = (await prisma.document.create({ data: { name: `${TAG}-facture-lotus.pdf`, entityType: "LEGAL_DOCUMENT", entityId: legal, fileKey: cles[0], category: "INVOICE" } })).id;
    docVirement = (await prisma.document.create({ data: { name: `${TAG}-virement-juillet.pdf`, entityType: "AD_PRO_ITEM", entityId: poste1, fileKey: cles[1], category: "OTHER" } })).id;
    docNotes = (await prisma.document.create({ data: { name: `${TAG}-notes.txt`, entityType: "AD_PRO_ITEM", entityId: poste1, fileKey: cles[2], category: "OTHER" } })).id;
    LUS[`${TAG}-facture-lotus.pdf`] = { fournisseur: `LOTUS MEDIA ${TAG} SARL`, montant: 53_550, date: "2026-07-08", numero: `FA-${N}`, nature: "FACTURE", references: [`SPO-2026-${N}`], motsCles: ["webinaire", "infectiologie"] };
    livreAvant = await empreinteLivre();
  });

  afterAll(async () => {
    if (!dbOk) return;
    const blobs = await prisma.storedFile.findMany({ where: { key: { in: cles } }, select: { blobId: true } });
    const shas = (await prisma.fileBlob.findMany({ where: { id: { in: blobs.map((b) => b.blobId) } }, select: { sha256: true } })).map((b) => b.sha256);
    await prisma.adProRapprochementLecture.deleteMany({ where: { empreinte: { in: shas } } });
    await prisma.adProIntegrationLot.deleteMany({ where: { envelopeId: envId } });
    await prisma.document.deleteMany({ where: { id: { in: [docFacture, docVirement, docNotes].filter(Boolean) } } });
    for (const k of cles) await deleteFileByKey(k).catch(() => undefined);
    await prisma.legalDocument.deleteMany({ where: { id: legal } });
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: [spo1, spo2] } } });
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: [spo1, spo2] } } });
    await prisma.financeTransaction.deleteMany({ where: { id: { in: [tx1, tx2, tx3, tx4] } } });
    await prisma.budgetExpenseLine.deleteMany({ where: { id: ligne } });
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } });
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [actor.id, autre.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [actor.id, autre.id] } } });
  });

  it("1. gardes : qui ne gère pas l'enveloppe ne voit rien et ne décide rien", async () => {
    expect(await vueRapprochement(autre as SessionUser, envId)).toBeNull();
    ACTOR = autre;
    try {
      expect((await lireTranchePiecesRapprochement(form({ envelopeId: envId }))).ok).toBe(false);
      const r = await deciderRapprochement(form({ envelopeId: envId, sens: "DEPENSE", source: `TX:${tx1}`, decision: "ACCEPTEE", demandeRowId: row1 }));
      expect(r.ok).toBe(false);
      expect((await accepterRapprochementsCertains(form({ envelopeId: envId, confirme: "on" }))).ok).toBe(false);
    } finally {
      ACTOR = actor;
    }
    expect(await prisma.adProRapprochement.count({ where: { lotId } })).toBe(0);
  });

  it("2. Luna lit par tranches, UNE fois par empreinte ; un format non lu n'est jamais envoyé", async () => {
    const nos = (c: { nom: string }) => c.nom.startsWith(TAG);
    const r1 = await lireTranche(actor as SessionUser, { filtre: nos });
    expect(r1.luesCetteFois).toBe(3);
    expect(r1.restantes).toBe(0);
    expect(APPELS.sort()).toEqual([`${TAG}-facture-lotus.pdf`, `${TAG}-virement-juillet.pdf`].sort());
    const r2 = await lireTranche(actor as SessionUser, { filtre: nos });
    expect(r2.luesCetteFois).toBe(0);
    expect(APPELS.length).toBe(2);
    const lignes = await prisma.adProRapprochementLecture.findMany({ where: { luParId: actor.id }, orderBy: { etat: "asc" } });
    expect(lignes.map((l) => l.etat).sort()).toEqual(["LUE", "NON_LUE", "NON_LUE"]);
    expect(lignes.find((l) => l.etat === "LUE")?.fournisseur).toMatch(/LOTUS/);
    expect(lignes.some((l) => l.raison?.includes("format .txt"))).toBe(true);
  });

  it("3. les propositions : certaine, pièce → pièce attendue, « pas Ad & Pro », doublon — triées par certitude", async () => {
    const v = await vue();
    const d1 = v.depenses.find((d) => d.source === `TX:${tx1}`);
    expect(d1?.propositions[0]).toMatchObject({ demandeRowId: row1, posteId: poste1, certitude: "CERTAINE" });
    expect(d1?.propositions[0].justification).toMatch(/même montant 53 550 DZD/);
    const d4 = v.depenses.find((d) => d.source === `TX:${tx4}`);
    expect(d4?.propositions[0]).toMatchObject({ demandeRowId: row2, posteId: poste2 });
    expect(v.depenses.find((d) => d.source === `TX:${tx3}`)?.horsAdPro?.enveloppe).toBe("Operations & Sales");
    const p1 = v.pieces.find((p) => p.rowId === row1);
    expect(p1?.historique).toBe(true);
    const facture = p1?.propositions.find((p) => p.source === `DOC:${docFacture}`);
    expect(facture).toMatchObject({ certitude: "CERTAINE", pieceCle: "facture" });
    expect(facture?.piece.resume).toMatch(/53 550 DZD/);
    expect(p1?.propositions.find((p) => p.source === `DOC:${docVirement}`)).toMatchObject({ pieceCle: "virement" });
    expect(v.doublons.some((x) => x.elements.some((e) => e.cle === `LIGNE:${ligne}`) && x.elements.some((e) => e.cle === `TX:${tx2}`))).toBe(true);
    expect(v.certaines).toBeGreaterThanOrEqual(2);
  });

  it("4. « Accepter toutes les propositions certaines » : l'écriture ne compte plus deux fois, la facture est rattachée", async () => {
    const avant = await ov();
    expect((await accepterRapprochementsCertains(form({ envelopeId: envId }))).ok).toBe(false); // la confirmation est exigée
    const r = await accepterRapprochementsCertains(form({ envelopeId: envId, confirme: "on" }));
    expect(r.ok).toBe(true);
    const apres = await ov();
    // 53 550 du webinaire : porté par le poste historique, l'écriture rattachée ne s'y ajoute plus.
    expect(Math.round((avant.totals.consumed - apres.totals.consumed) * 100)).toBe(5_355_000);
    const row = await prisma.adProIntegrationDemande.findUniqueOrThrow({ where: { id: row1 } });
    expect(piecesRattacheesDe(row.piecesRattachees)).toEqual(expect.arrayContaining([expect.objectContaining({ cle: "facture", documentId: docFacture, ref: `DOC:${docFacture}` })]));
    const bloc = await blocHistoriqueDe(actor as SessionUser, "SPONSORING", spo1);
    expect(bloc?.pieces.find((p) => p.cle === "facture")?.fournie).toBe(true);
    expect((await ecrituresRapprochees(row1)).map((e) => e.reference)).toEqual([`${TAG}-FIN-1`]);
    // La décision est au journal, avec sa certitude et sa justification.
    const decisions = await prisma.adProRapprochement.findMany({ where: { lotId, decision: "ACCEPTEE", annuleLe: null } });
    expect(decisions.find((d) => d.source === `TX:${tx1}`)).toMatchObject({ certitude: "CERTAINE", posteId: poste1 });
    expect(await prisma.auditLog.count({ where: { actorId: actor.id, module: "Budget Marketing — rapprochement Ad & Pro" } })).toBeGreaterThanOrEqual(2);
    // Plus proposée, et pas une seconde fois.
    expect((await vue()).depenses.some((d) => d.source === `TX:${tx1}`)).toBe(false);
    expect((await deciderRapprochement(form({ envelopeId: envId, sens: "DEPENSE", source: `TX:${tx1}`, decision: "ACCEPTEE", demandeRowId: row2 }))).ok).toBe(false);
  });

  it("5. refuser, « pas Ad & Pro », rattacher une écriture à imputer — l'onglet Dépenses le dit, rien n'est imputé", async () => {
    expect((await deciderRapprochement(form({ envelopeId: envId, sens: "PIECE", source: `DOC:${docVirement}`, decision: "REFUSEE", demandeRowId: row1 }))).ok).toBe(true);
    expect((await vue()).pieces.find((p) => p.rowId === row1)?.propositions.some((p) => p.source === `DOC:${docVirement}`)).toBe(false);

    expect((await deciderRapprochement(form({ envelopeId: envId, sens: "DEPENSE", source: `TX:${tx3}`, decision: "PAS_ADPRO", enveloppe: "Operations & Sales" }))).ok).toBe(true);
    expect((await deciderRapprochement(form({ envelopeId: envId, sens: "DEPENSE", source: `TX:${tx4}`, decision: "ACCEPTEE", demandeRowId: row2, posteId: poste2 }))).ok).toBe(true);
    const env = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: envId } });
    const rapp = await rapprochementDesAImputer(envId, env.periodStart, env.periodEnd, env.companyId);
    expect(rapp.pasAdPro[tx3]).toMatch(/Operations & Sales/);
    expect(rapp.rattachees.has(tx4)).toBe(true);
    expect(rapp.total).toBeGreaterThanOrEqual(501_000);
    const tx = await prisma.financeTransaction.findMany({ where: { id: { in: [tx3, tx4] } }, select: { budgetCategoryId: true } });
    expect(tx.every((t) => t.budgetCategoryId === null)).toBe(true);
  });

  it("6. choisir une autre demande, puis annuler : l'effet est défait, la proposition revient", async () => {
    const avant = await ov();
    const r = await deciderRapprochement(form({ envelopeId: envId, sens: "DEPENSE", source: `TX:${tx2}`, decision: "ACCEPTEE", demandeRowId: row2 }));
    expect(r.ok).toBe(true);
    const d = await prisma.adProRapprochement.findFirstOrThrow({ where: { lotId, source: `TX:${tx2}`, annuleLe: null } });
    expect(d.justification).toMatch(/Choix manuel/);
    expect(d.posteId).toBe(poste2);
    expect(Math.round(((await ov()).totals.consumed - avant.totals.consumed) * 100)).toBe(-3_581_700);
    expect((await annulerDecisionRapprochement(form({ id: d.id }))).ok).toBe(true);
    expect(Math.round(((await ov()).totals.consumed - avant.totals.consumed) * 100)).toBe(0);

    const f = await prisma.adProRapprochement.findFirstOrThrow({ where: { lotId, source: `DOC:${docFacture}`, annuleLe: null } });
    expect((await annulerDecisionRapprochement(form({ id: f.id }))).ok).toBe(true);
    const row = await prisma.adProIntegrationDemande.findUniqueOrThrow({ where: { id: row1 } });
    expect(piecesRattacheesDe(row.piecesRattachees).some((p) => p.documentId === docFacture)).toBe(false);
    expect((await vue()).pieces.find((p) => p.rowId === row1)?.propositions.some((p) => p.source === `DOC:${docFacture}`)).toBe(true);
    // Annuler deux fois ne fait rien de plus.
    expect((await annulerDecisionRapprochement(form({ id: f.id }))).message).toMatch(/Déjà/);
  });

  it("7. l'onglet Dépenses : « Déjà imputé » hors postes ; chaque dinar consommé apparaît une fois (tableau OU hors postes)", async () => {
    const o = await ov();
    const { donnees, ecritures } = await depensesPostesMarketing(actor as SessionUser, o);
    const horsPostes = horsPostesAdPro(o.attributed.transactions, ecritures);
    expect(horsPostes.some((x) => x.kind === "HISTORIQUE")).toBe(false);
    expect(o.attributed.transactions.filter((x) => x.kind === "HISTORIQUE").length).toBe(2);
    // L'écriture rattachée au webinaire n'est plus « déjà imputée » : le poste historique la porte.
    expect(horsPostes.some((x) => x.id === tx1)).toBe(false);
    const tableau = donnees.lignes.reduce((s, l) => s + l.paye, 0);
    const hors = horsPostes.reduce((s, x) => s + x.amount, 0);
    expect(Math.round((tableau + hors) * 100)).toBe(Math.round(o.totals.consumed * 100));
    expect(Math.round(tableau * 100)).toBe(Math.round((53_550 + 501_000) * 100));
  });

  it("8. le livre de trésorerie n'a pas bougé (montant, statut, imputation, date de mise à jour)", async () => {
    expect(await empreinteLivre()).toBe(livreAvant);
  });
});
