import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  corrigerImpotRefuse, enregistrerBrouillonImpot, enregistrerCalendrierFiscal, envoyerImpotAuCentre, envoyerPaiementPonctuel,
  joindreQuittanceImpot, retirerImpotDuCentre,
} from "./actions-impots";
import { decidePayment } from "./actions-centre";
import { assurerLignesDuCalendrier, chargerImpotsCotisations, rappelerEcheancesFiscales } from "./infra/impots";
import { periodeCourante } from "./domaine/impots";
import { CODE_ENVELOPPE_IMPOTS, LIGNES_BUDGET_IMPOTS, SOUS_NATURES_AUTRES_TAXES } from "./partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IMPÔTS & COTISATIONS, SUR LA BASE (maquette validée, 24/11/2026) — par les vrais points d'entrée :
 * le calendrier fait naître les lignes ; l'IRG et la CNAS sont proposés par les fiches ; sans justificatif rien ne part ;
 * l'envoi crée l'ordre PAR `createExpenseOrder` (source TAX_PAYMENT, bénéficiaire l'organisme), pièce sur l'ordre ;
 * retrait, refus du centre et reprise, autorisation, quittance ; le cloisonnement par société ; la clé FINANCES_IMPOTS.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__impots__";
const fd = (o: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const pdf = (nom: string) => new File(["%PDF-1.4 banc impots"], nom, { type: "application/pdf" });
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("Impôts & cotisations — du calendrier à la quittance", () => {
  const u: Record<string, string> = {};
  let fbm: SessionUser, sa: SessionUser, viewer: SessionUser;
  let socA = "", socB = "";
  const maintenant = new Date();
  const periode = periodeCourante("MENSUELLE", maintenant)!;

  beforeAll(async () => {
    await nettoyer();
    const mkU = async (k: string, role: string) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } })).id;
    };
    await mkU("fbm", "FINANCE_BUDGET_MANAGER");
    await mkU("sa", "SUPER_ADMIN");
    await mkU("viewer", "VIEWER");
    socA = (await prisma.company.create({ data: { name: `${TAG}Société A`, shortName: `${TAG}A` } })).id;
    socB = (await prisma.company.create({ data: { name: `${TAG}Société B`, shortName: `${TAG}B` } })).id;
    // LE CLOISONNEMENT : la personne des Finances n'a que la société A.
    await prisma.userCompanyAccess.create({ data: { userId: u.fbm!, companyId: socA, canEdit: true } });
    // Les fiches de la société A : retenues FIXES inscrites par les RH (une sans IRG).
    await prisma.employee.createMany({
      data: [
        { fullName: `${TAG}Salarié 1`, companyId: socA, retIrg: 17460, retSS9: 11520, retSS35: 44800 },
        { fullName: `${TAG}Salarié 2`, companyId: socA, retIrg: 38900, retSS9: 19260, retSS35: 74900 },
        { fullName: `${TAG}Salarié 3`, companyId: socA, retIrg: null, retSS9: 5580, retSS35: 21700 },
        { fullName: `${TAG}Ancien`, companyId: socA, isActive: false, retIrg: 99999 },
      ],
    });
    fbm = await session(u.fbm!, "FINANCE_BUDGET_MANAGER");
    sa = await session(u.sa!, "SUPER_ADMIN");
    viewer = await session(u.viewer!, "VIEWER");
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const societes = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const lignes = await prisma.echeanceFiscale.findMany({ where: { companyId: { in: societes } }, select: { id: true } });
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ companyId: { in: societes } }, { sourceId: { in: lignes.map((l) => l.id) } }] }, select: { id: true } })).map((o) => o.id);
    const cles = (await prisma.document.findMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ordres } }, select: { fileKey: true } })).map((d) => d.fileKey).filter((k): k is string => Boolean(k));
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ordres } } }).catch(() => {});
    // Les fichiers des ordres — ceux qu'une annulation a détachés de leur fiche compris — et leur blob s'il ne sert plus.
    const fichiers = await prisma.storedFile.findMany({ where: { OR: [{ key: { in: cles } }, ...ordres.map((o) => ({ key: { startsWith: `EXPENSE_ORDER/${o}/` } }))] }, select: { key: true, blobId: true } });
    await prisma.storedFile.deleteMany({ where: { key: { in: fichiers.map((f) => f.key) } } }).catch(() => undefined);
    for (const blobId of new Set(fichiers.map((f) => f.blobId))) {
      if ((await prisma.storedFile.count({ where: { blobId } })) === 0) await prisma.fileBlob.deleteMany({ where: { id: blobId } }).catch(() => undefined);
    }
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.echeanceFiscale.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.obligationFiscale.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "TAX_PAYMENT", entityId: { in: lignes.map((l) => l.id) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(() => {});
  }

  const ligneDe = (nature: string) => prisma.echeanceFiscale.findFirstOrThrow({ where: { companyId: socA, nature } });

  it("le CALENDRIER fait naître les lignes de la période — et se refuse hors des droits ou de la société", async () => {
    const calendrier = JSON.stringify([
      { companyId: socA, organisme: "Recette des impôts", nature: "G50 — TVA, IRG salaires, TAP", composition: "G50", periodicite: "MENSUELLE", jour: "20", rappel: true, confirme: true },
      { companyId: socA, organisme: "CNAS", nature: "Cotisations sociales", composition: "CNAS", periodicite: "MENSUELLE", jour: "30", rappel: true, confirme: false },
    ]);
    ACTEUR = viewer;
    expect((await enregistrerCalendrierFiscal(fd({ lignes: calendrier, retirees: "[]" }))).error).toMatch(/« Modifier » sur Impôts & cotisations/);
    ACTEUR = fbm;
    const autre = JSON.stringify([{ companyId: socB, organisme: "CNAS", nature: "X", composition: "CNAS", periodicite: "MENSUELLE", jour: "30" }]);
    expect((await enregistrerCalendrierFiscal(fd({ lignes: autre, retirees: "[]" }))).error).toMatch(/périmètre/);

    const r = await enregistrerCalendrierFiscal(fd({ lignes: calendrier, retirees: "[]" }));
    expect(r.ok, r.error).toBe(true);
    const lignes = await prisma.echeanceFiscale.findMany({ where: { companyId: socA }, orderBy: { nature: "asc" } });
    expect(lignes.map((l) => [l.nature, l.periode, l.periodeLibelle])).toEqual([
      ["Cotisations sociales", periode.cle, periode.libelle], ["G50 — TVA, IRG salaires, TAP", periode.cle, periode.libelle],
    ]);
    expect(lignes.find((l) => l.composition === "G50")!.echeance!.getUTCDate()).toBe(20);
    // Rejouer ne crée rien (clé obligation × période).
    expect(await assurerLignesDuCalendrier(maintenant, [socA])).toBe(0);
  });

  it("l'IRG et la CNAS sont PROPOSÉS par la somme des retenues des fiches actives — rien n'est calculé", async () => {
    const d = await chargerImpotsCotisations(fbm.id);
    expect(d.societes.map((s) => s.id)).toContain(socA);
    expect(d.societes.map((s) => s.id)).not.toContain(socB);
    const paie = d.paies[`${socA}|${periode.cle}`]!;
    expect(paie.propositions).toEqual({ irg: 17460 + 38900, sal: 11520 + 19260 + 5580, pat: (44800 - 11520) + (74900 - 19260) + (21700 - 5580), tva: null, fiches: 3 });
    expect(paie.base).toBe("FICHES_ACTIVES");
    expect(d.lignes.filter((l) => l.companyId === socA).every((l) => l.etat === "A_PREPARER")).toBe(true);
  });

  it("sans justificatif, l'envoi est REFUSÉ et aucun ordre ne naît ; le brouillon garde les saisies", async () => {
    ACTEUR = fbm;
    const g50 = await ligneDe("G50 — TVA, IRG salaires, TAP");
    const saisies = JSON.stringify({ irg: "56 000", tvaC: "3 412 000", tvaD: "2 251 500", tap: "127 400" });
    expect((await enregistrerBrouillonImpot(fd({ id: g50.id, saisies }))).ok).toBe(true);
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } })).saisies).toMatchObject({ irg: "56 000" });
    const r = await envoyerImpotAuCentre(fd({ id: g50.id, saisies }));
    expect(r.error).toBe(`Le justificatif est obligatoire : joignez la déclaration G50 de ${periode.libelle}, signée.`);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "TAX_PAYMENT", sourceId: g50.id } })).toBe(0);
  });

  it("ENVOYER crée les ordres par createExpenseOrder — un par ligne du budget, organisme bénéficiaire, pièce sur chaque ordre, écart tracé", async () => {
    ACTEUR = fbm;
    const g50 = await ligneDe("G50 — TVA, IRG salaires, TAP");
    const saisies = JSON.stringify({ irg: "56 000", tvaC: "3 412 000", tvaD: "2 251 500", tap: "127 400" });
    const r = await envoyerImpotAuCentre(fd({ id: g50.id, saisies, justificatif: pdf("G50-signee.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const ligne = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(Number(ligne.montant)).toBe(56000 + 1160500 + 127400);
    const ordres = await prisma.expenseOrder.findMany({ where: { id: { in: ligne.ordresIds } } });
    expect(ordres).toHaveLength(3);
    for (const o of ordres) {
      expect(o).toMatchObject({
        sourceType: "TAX_PAYMENT", sourceId: g50.id, beneficiary: "Recette des impôts", category: "IMPOT", companyId: socA,
        centralStatus: "AWAITING", status: "PENDING", requestedById: fbm.id, reference: expect.stringMatching(/^OD-/),
      });
      // Le dossier compagnon que l'unique écrivain ouvre à tout ordre — la preuve que l'ordre vient de lui.
      expect(await prisma.paymentRequest.count({ where: { expenseOrderId: o.id, origin: "EXPENSE_ORDER", entityType: "TAX_PAYMENT" } })).toBe(1);
      // La pièce sur CHAQUE ordre (le centre l'ouvre depuis l'ordre qu'il décide).
      expect(await prisma.document.count({ where: { entityType: "EXPENSE_ORDER", entityId: o.id, name: "G50-signee.pdf" } })).toBe(1);
    }
    // LE BUDGET : l'enveloppe « Impôts & taxes » de la société, ouverte d'office (montants à 0), et une ligne par nature.
    const enveloppe = await prisma.budgetEnvelope.findFirstOrThrow({ where: { companyId: socA, module: CODE_ENVELOPPE_IMPOTS }, include: { categories: true } });
    expect(Number(enveloppe.totalAmount)).toBe(0);
    expect(enveloppe.categories.filter((c) => !c.parentId).map((c) => c.cle).sort()).toEqual(Object.values(LIGNES_BUDGET_IMPOTS).sort());
    const autres = enveloppe.categories.find((c) => c.cle === "AUTRES_TAXES")!;
    expect(enveloppe.categories.filter((c) => c.parentId === autres.id).map((c) => c.cle).sort()).toEqual(Object.values(SOUS_NATURES_AUTRES_TAXES).sort());
    const cleDe = new Map(enveloppe.categories.map((c) => [c.id, c.cle]));
    expect(ordres.map((o) => [cleDe.get(o.budgetCategoryId!), Number(o.amount)]).sort()).toEqual([
      ["AUTRES_TAXES", 127400], ["IRG_SALAIRES", 56000], ["TVA_NETTE", 1160500],
    ]);
    // Le principal (pièce, quittance) est la plus grosse part.
    expect(ligne.expenseOrderId).toBe(ordres.find((o) => cleDe.get(o.budgetCategoryId!) === "TVA_NETTE")!.id);
    const ecart = await prisma.auditLog.findFirst({ where: { entityType: "TAX_PAYMENT", entityId: g50.id, field: "IRG retenu sur les salaires" } });
    expect(ecart).toMatchObject({ oldValue: String(17460 + 38900), newValue: "56000", actorId: fbm.id });
    // Partie : la ligne ne se renvoie pas, ne se brouillonne plus.
    expect((await envoyerImpotAuCentre(fd({ id: g50.id, saisies, justificatif: pdf("x.pdf") }))).error).toMatch(/déjà partie/);
  });

  it("RETIRER tant que non décidé : l'ordre est annulé, la ligne revient « À préparer » ; le renvoi garde la pièce", async () => {
    ACTEUR = fbm;
    const g50 = await ligneDe("G50 — TVA, IRG salaires, TAP");
    const ancien = g50.expenseOrderId!;
    expect((await retirerImpotDuCentre(fd({ id: g50.id }))).ok).toBe(true);
    expect((await prisma.expenseOrder.findMany({ where: { id: { in: g50.ordresIds } } })).map((o) => o.status)).toEqual(["CANCELLED", "CANCELLED", "CANCELLED"]);
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: { in: g50.ordresIds }, status: "CANCELLED" } })).toBe(3);
    const apres = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(apres.expenseOrderId).toBeNull();
    // Renvoi SANS nouveau fichier : la pièce suit le nouvel ordre (une pièce, jamais deux copies).
    const r = await envoyerImpotAuCentre(fd({ id: g50.id, saisies: JSON.stringify({ tvaC: "0", tvaD: "0", tap: "0" }) }));
    expect(r.ok, r.error).toBe(true);
    const renvoye = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(renvoye.expenseOrderId).not.toBe(ancien);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: renvoye.justificatifId! } })).entityId).toBe(renvoye.expenseOrderId);
    expect(Number(renvoye.montant)).toBe(17460 + 38900); // l'IRG proposé, non modifié cette fois
  });

  it("REFUS du centre : l'état et le motif se lisent ; « Corriger et renvoyer » ramène la ligne avec le motif", async () => {
    const g50 = await ligneDe("G50 — TVA, IRG salaires, TAP");
    ACTEUR = sa;
    const d = await decidePayment(fd({ id: g50.expenseOrderId!, decision: "REFUSE", body: "Joindre la G50 signée et cachetée." }));
    expect(d.ok, d.error).toBe(true);
    ACTEUR = fbm;
    const vue = (await chargerImpotsCotisations(fbm.id)).lignes.find((l) => l.id === g50.id)!;
    expect(vue.etat).toBe("REFUSE");
    expect(vue.motifRefus).toBe("Joindre la G50 signée et cachetée.");
    expect((await retirerImpotDuCentre(fd({ id: g50.id }))).error).toMatch(/déjà décidé/);
    expect((await corrigerImpotRefuse(fd({ id: g50.id }))).ok).toBe(true);
    const repris = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(repris).toMatchObject({ expenseOrderId: null, motifRefusPrecedent: "Joindre la G50 signée et cachetée." });
  });

  it("AUTORISÉ puis PAYÉ (écrit par la banque) : la quittance se joint, sur l'ordre", async () => {
    ACTEUR = fbm;
    const g50 = await ligneDe("G50 — TVA, IRG salaires, TAP");
    expect((await envoyerImpotAuCentre(fd({ id: g50.id, saisies: JSON.stringify({ tvaC: "0", tvaD: "0", tap: "0" }), justificatif: pdf("G50-cachetee.pdf") }))).ok).toBe(true);
    const ordreId = (await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } })).expenseOrderId!;
    expect((await joindreQuittanceImpot(fd({ id: g50.id, quittance: pdf("Q.pdf") }))).error).toMatch(/une fois la ligne payée/);
    ACTEUR = sa;
    expect((await decidePayment(fd({ id: ordreId, decision: "APPROVE" }))).ok).toBe(true);
    ACTEUR = fbm;
    expect((await chargerImpotsCotisations(fbm.id)).lignes.find((l) => l.id === g50.id)!.etat).toBe("AUTORISE");
    // Le règlement appartient à Banque & paiements (`settleExpenseOrder`) ; le banc pose son résultat.
    await prisma.expenseOrder.update({ where: { id: ordreId }, data: { status: "PAID", paidDate: new Date() } });
    const q = await joindreQuittanceImpot(fd({ id: g50.id, quittance: pdf("Quittance.pdf"), numero: "Q-2026-11-0412" }));
    expect(q.ok, q.error).toBe(true);
    const ligne = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(ligne.quittanceNumero).toBe("Q-2026-11-0412");
    expect(await prisma.document.findUniqueOrThrow({ where: { id: ligne.quittanceId! } })).toMatchObject({ entityType: "EXPENSE_ORDER", entityId: ordreId, category: "PAYMENT_RECEIPT" });
    expect((await chargerImpotsCotisations(fbm.id)).lignes.find((l) => l.id === g50.id)!.etat).toBe("PAYE");
  });

  it("CLOISONNEMENT : une ligne d'une autre société ne s'ouvre ni ne se modifie", async () => {
    const ligneB = await prisma.echeanceFiscale.create({ data: { companyId: socB, organisme: "CNAS", nature: `${TAG}B`, composition: "MONTANT", periodeLibelle: "—", saisies: { montant: "10" } } });
    ACTEUR = fbm;
    expect((await envoyerImpotAuCentre(fd({ id: ligneB.id, saisies: JSON.stringify({ montant: "10" }), justificatif: pdf("b.pdf") }))).error).toMatch(/périmètre/);
    expect((await chargerImpotsCotisations(fbm.id)).lignes.some((l) => l.id === ligneB.id)).toBe(false);
    ACTEUR = sa;
    expect((await chargerImpotsCotisations(sa.id)).lignes.some((l) => l.id === ligneB.id)).toBe(true);
  });

  it("PAIEMENT PONCTUEL : justificatif obligatoire, puis l'ordre naît comme les autres", async () => {
    ACTEUR = fbm;
    const champs = { organisme: "Recette des impôts", companyId: socA, nature: "Taxe foncière — entrepôt", periode: "année 2026", montant: "184 000" };
    expect((await envoyerPaiementPonctuel(fd(champs))).error).toMatch(/justificatif est obligatoire/);
    expect((await envoyerPaiementPonctuel(fd({ ...champs, companyId: socB, justificatif: pdf("avis.pdf") }))).error).toMatch(/périmètre/);
    ACTEUR = viewer;
    expect((await envoyerPaiementPonctuel(fd({ ...champs, justificatif: pdf("avis.pdf") }))).error).toMatch(/« Créer » sur Impôts & cotisations/);
    ACTEUR = fbm;
    const r = await envoyerPaiementPonctuel(fd({ ...champs, justificatif: pdf("Avis-imposition-2026.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const ligne = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: r.id! } });
    expect(ligne).toMatchObject({ obligationId: null, composition: "MONTANT", periodeLibelle: "année 2026" });
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ligne.expenseOrderId! } });
    expect(ordre).toMatchObject({ sourceType: "TAX_PAYMENT", beneficiary: "Recette des impôts", companyId: socA });
    expect(Number(ordre.amount)).toBe(184000);
    // Une taxe ponctuelle va aux « autres impôts et taxes » du budget, à SA sous-nature (taxe foncière).
    expect((await prisma.budgetCategoryLine.findUniqueOrThrow({ where: { id: ordre.budgetCategoryId! } })).cle).toBe("TAXE_FONCIERE");
  });

  it("le RAPPEL J-7 part une fois, aux gestionnaires de la société de la ligne", async () => {
    const cnas = await ligneDe("Cotisations sociales");
    const dans5Jours = new Date(Date.now() + 5 * 86_400_000);
    await prisma.echeanceFiscale.update({ where: { id: cnas.id }, data: { echeance: dans5Jours, rappelEnvoyeLe: null } });
    expect(await rappelerEcheancesFiscales(new Date())).toBeGreaterThanOrEqual(1);
    const notes = await prisma.notification.count({ where: { userId: fbm.id, link: { contains: cnas.id } } });
    expect(notes).toBe(1);
    await rappelerEcheancesFiscales(new Date());
    expect(await prisma.notification.count({ where: { userId: fbm.id, link: { contains: cnas.id } } })).toBe(1);
  });
});
