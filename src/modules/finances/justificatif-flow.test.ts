import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { persistUploadedDocument } from "@/lib/documents";
import { lignesJustificatifsAJoindre } from "@/lib/queries/action-center-justificatifs";
import { natureDe } from "@/lib/espace/aujourdhui";
import { createExpenseOrder, EXPENSE_SOURCE_TYPES } from "./infra/expense-orders";
import { chargerCentre, chargerOrdresDesFinances, ENTITE_SANS, justificatifsDesOrdres } from "./api";
import { addPaymentPiece } from "./actions-demandes";
import { settleExpenseOrder } from "./actions-depenses";
import {
  JUSTIFICATIF_DE_SOURCE, KINDS_JUSTIFIANTS, ORIGINES_JUSTIFIEES, REFUS_REGLEMENT_SANS_JUSTIFICATIF, type OrigineOrdre,
} from "./domaine/justificatif";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__justif__${Date.now().toString(36)}`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fichier = (nom = "piece.pdf") => new File([`%PDF ${TAG} ${nom} ${Math.random()}`], nom, { type: "application/pdf" });
const statut = async (id: string) => (await prisma.expenseOrder.findUniqueOrThrow({ where: { id }, select: { centralStatus: true } })).centralStatus;

describe("la table JUSTIFICATIF_DE_SOURCE couvre chaque origine lue par l'émetteur", () => {
  it("chaque origine dont l'émetteur lit l'entité (COMPANY_OF_SOURCE) a sa ligne", () => {
    const manquantes = EXPENSE_SOURCE_TYPES.filter((t) => !ORIGINES_JUSTIFIEES.includes(t as never));
    expect(manquantes, `origines sans justificatif : ${manquantes.join(", ")}`).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JUSTIFICATIF OBLIGATOIRE, TENU PAR LES VRAIES ACTIONS (Super Admin, 24/11/2026).
 *
 * Pour CHAQUE origine de la table : sans pièce, l'ordre n'est ni au centre ni aux Finances, et le service qui l'a émis a
 * sa ligne « Joindre le justificatif » ; la pièce jointe au dossier le fait entrer au centre, seul ; jointe dès la
 * naissance, il y entre d'emblée. Puis les justificatifs qui ne sont pas un fichier (la facture source, la demande signée,
 * la pièce validée, le bon de versement), le règlement, la régularisation d'un paiement soldé, et les ordres d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Justificatif obligatoire — pas de pièce, pas de centre", () => {
  let demandeurId = "", saId = "", financeId = "", salarieId = "";
  let demandeur: CurrentUser;

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [d, sa, f, sal] = await Promise.all([mk("dem", "DIRECTION"), mk("sa", "SUPER_ADMIN"), mk("fin", "FINANCE_BUDGET_MANAGER"), mk("sal", "SALES_USER")]);
    demandeurId = d.id; saId = sa.id; financeId = f.id; salarieId = sal.id;
    demandeur = await actorFor(demandeurId, "DIRECTION");
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } });
    const ids = ordres.map((o) => o.id);
    await prisma.paymentPiece.deleteMany({ where: { request: { OR: [{ expenseOrderId: { in: ids } }, { title: { startsWith: TAG } }] } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { OR: [{ expenseOrderId: { in: ids } }, { title: { startsWith: TAG } }] } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ids } }, { title: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { OR: [{ user: { email: { startsWith: TAG } } }, { body: { contains: TAG } }, { title: { contains: TAG } }] } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** L'ordre d'une origine, sur une fiche qui ne porte aucune pièce. */
  // Une fiche par ordre : certaines origines n'admettent qu'un ordre vivant par fiche (index unique).
  let n = 0;
  const emettre = (o: OrigineOrdre, extra: Partial<Parameters<typeof createExpenseOrder>[0]> = {}) => createExpenseOrder({
    label: `${TAG} ${o}`, amount: 12_345, category: "AUTRE",
    ...(o === "SANS_SOURCE" ? {} : { sourceType: o, sourceId: `${TAG}src${o}${(n += 1)}` }),
    requestedById: demandeurId, ...extra,
  });
  /** La nature de pièce que la table accepte pour l'origine — celle que le service joindrait. */
  // Pas la facture : sa garde anti-doublon lit le PDF, ce que ce banc ne teste pas.
  const kindAccepte = (o: OrigineOrdre) => JUSTIFICATIF_DE_SOURCE[o].natures.find((n) => KINDS_JUSTIFIANTS.includes(n) && n !== "INVOICE") as string;
  const dossierDe = async (ordreId: string) => (await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordreId } })).id;
  const joindre = async (requestId: string, kind: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("requestId", requestId); fd.set("kind", kind);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set("file", fichier());
    return addPaymentPiece(fd);
  };

  // ── 1. CHAQUE ORIGINE ─────────────────────────────────────────────────────────────────────
  for (const o of ORIGINES_JUSTIFIEES.filter((x) => x !== "PAYMENT_REQUEST")) {
    it(`${o} — sans pièce : ni au centre ni aux Finances, ligne « Joindre le justificatif » ; pièce jointe : entre au centre`, async () => {
      const ordre = await emettre(o);
      expect(ordre.centralStatus).toBe("AWAITING_PROOF");
      expect(ordre.justificatifExige).toBe(true);

      // La tâche au service émetteur : la notification, et la ligne « Aujourd'hui ».
      const note = await prisma.notification.findFirst({ where: { userId: demandeurId, title: { contains: ordre.reference } } });
      expect(note?.title).toMatch(/^Joindre le justificatif/);
      const lignes = await lignesJustificatifsAJoindre(demandeur);
      const ligne = lignes.find((l) => l.key === `justif-${ordre.id}`);
      expect(ligne?.title).toContain("Joindre le justificatif");
      expect(ligne && natureDe(ligne)).toBe("justificatif");

      // Invisible au centre (même pour le Super Admin) et aux Finances ; le centre n'est pas sollicité.
      const sa = await actorFor(saId, "SUPER_ADMIN");
      expect((await chargerCentre(sa, { entite: ENTITE_SANS })).idsEntite).not.toContain(ordre.id);
      expect((await chargerOrdresDesFinances({})).map((x) => x.id)).not.toContain(ordre.id);
      expect(await prisma.notification.count({ where: { userId: saId, body: { contains: ordre.reference } } })).toBe(0);

      // La pièce jointe au dossier de paiement : l'ordre entre seul au centre, qui est prévenu.
      ACTOR = demandeur;
      const r = await joindre(await dossierDe(ordre.id), kindAccepte(o));
      expect(r.ok, r.error).toBe(true);
      expect(await statut(ordre.id)).toBe("AWAITING");
      expect(await prisma.notification.count({ where: { userId: saId, body: { contains: ordre.reference } } })).toBe(1);
      expect((await chargerCentre(sa, { entite: ENTITE_SANS })).idsEntite).toContain(ordre.id);
      expect((await lignesJustificatifsAJoindre(demandeur)).some((l) => l.key === `justif-${ordre.id}`)).toBe(false);
    });

    it(`${o} — pièce jointe dès la création : directement au centre, et rangée au dossier sous sa nature`, async () => {
      const kind = kindAccepte(o);
      const ordre = await emettre(o, { justificatif: { fichier: fichier(), nature: kind as never } });
      expect(ordre.centralStatus).toBe("AWAITING");
      const piece = await prisma.paymentPiece.findFirst({ where: { request: { expenseOrderId: ordre.id } }, select: { kind: true } });
      expect(piece?.kind).toBe(kind);
      expect((await justificatifsDesOrdres([ordre.id])).get(ordre.id)?.present).toBe(true);
    });
  }

  // ── 2. LES JUSTIFICATIFS QUI SONT LA SOURCE ELLE-MÊME ─────────────────────────────────────
  it("PAYMENT_REQUEST — la facture de la demande la justifie ; sans elle, la pièce ajoutée à la demande la fait entrer", async () => {
    const mkDemande = (titre: string, entityType: "MEDICAL_INFO_DECLARATION" | null = null) => prisma.paymentRequest.create({
      data: { reference: `PAY-${TAG}-${titre}`, title: `${TAG} ${titre}`, payee: "Fournisseur", amount: 5000, requesterId: demandeurId, status: "SUBMITTED", entityType, entityId: entityType ? `${TAG}decl` : null },
    });
    const avec = await mkDemande("avec");
    const doc = await prisma.document.create({ data: { name: `${TAG}f.pdf`, entityType: "PAYMENT_REQUEST", entityId: avec.id, category: "OTHER", confidentiality: "INTERNAL", uploadedById: demandeurId } });
    await prisma.paymentPiece.create({ data: { requestId: avec.id, documentId: doc.id, kind: "INVOICE", createdById: demandeurId } });
    expect((await emettre("PAYMENT_REQUEST", { sourceId: avec.id })).centralStatus).toBe("AWAITING");

    // Le BON DE VERSEMENT (information médicale) : exempté de pièce, il est son propre justificatif.
    const bv = await mkDemande("bv", "MEDICAL_INFO_DECLARATION");
    expect((await emettre("PAYMENT_REQUEST", { sourceId: bv.id })).centralStatus).toBe("AWAITING");

    const sans = await mkDemande("sans");
    const ordre = await emettre("PAYMENT_REQUEST", { sourceId: sans.id });
    expect(ordre.centralStatus).toBe("AWAITING_PROOF");
    ACTOR = demandeur;
    expect((await joindre(sans.id, "PROFORMA")).ok).toBe(true);
    expect(await statut(ordre.id)).toBe("AWAITING");
  });

  it("LEGAL_DOCUMENT — la facture envoyée au règlement EST le justificatif", async () => {
    const facture = await prisma.legalDocument.create({ data: { title: `${TAG} facture`, kind: "INVOICE", createdById: demandeurId } });
    expect((await emettre("LEGAL_DOCUMENT", { sourceId: facture.id })).centralStatus).toBe("AWAITING");
  });

  it("SPONSORING — la proforma du registre (avec son fichier) rattachée à la fiche la justifie", async () => {
    const fiche = `${TAG}spo-registre`;
    const proforma = await prisma.legalDocument.create({ data: { title: `${TAG} proforma`, kind: "QUOTE", sourceType: "SPONSORING", sourceId: fiche, createdById: demandeurId } });
    await prisma.document.create({ data: { name: `${TAG}p.pdf`, entityType: "LEGAL_DOCUMENT", entityId: proforma.id, category: "QUOTE", confidentiality: "INTERNAL", uploadedById: demandeurId } });
    expect((await emettre("SPONSORING", { sourceId: fiche })).centralStatus).toBe("AWAITING");
  });

  it("CONGRESS_NATIONAL — un fichier « proforma » déposé APRÈS sur la fiche fait entrer l'ordre au centre (dépôt ordinaire)", async () => {
    const fiche = `${TAG}cn-depot`;
    const ordre = await emettre("CONGRESS_NATIONAL", { sourceId: fiche });
    expect(ordre.centralStatus).toBe("AWAITING_PROOF");
    // Une photo ne justifie rien…
    await persistUploadedDocument(demandeurId, { entityType: "CONGRESS_NATIONAL", entityId: fiche, category: "PHOTO", confidentiality: "INTERNAL", stepKey: null, file: fichier("photo.pdf") });
    expect(await statut(ordre.id)).toBe("AWAITING_PROOF");
    // … la proforma, si.
    const r = await persistUploadedDocument(demandeurId, { entityType: "CONGRESS_NATIONAL", entityId: fiche, category: "PROFORMA", confidentiality: "INTERNAL", stepKey: null, file: fichier("proforma.pdf") });
    expect(r.ok, r.error).toBe(true);
    expect(await statut(ordre.id)).toBe("AWAITING");
  });

  it("SALARY_ADVANCE — demandée par le salarié lui-même : justifiée ; saisie par les RH pour lui : la demande signée est à joindre", async () => {
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} salarié`, userId: salarieId, email: `${TAG}emp@t.dz` } });
    const parLui = await prisma.salaryAdvance.create({ data: { employeeId: emp.id, amount: 1000, createdById: salarieId } });
    expect((await emettre("SALARY_ADVANCE", { sourceId: parLui.id })).centralStatus).toBe("AWAITING");
    const parLesRh = await prisma.salaryAdvance.create({ data: { employeeId: emp.id, amount: 1000, createdById: demandeurId } });
    expect((await emettre("SALARY_ADVANCE", { sourceId: parLesRh.id })).centralStatus).toBe("AWAITING_PROOF");
  });

  it("ADMIN_REQUEST — la pièce validée au centre de validations est réutilisée comme justificatif", async () => {
    const demande = `${TAG}achat`;
    const doc = await prisma.document.create({ data: { name: `${TAG}v.pdf`, entityType: "ADMIN_REQUEST", entityId: demande, category: "OTHER", confidentiality: "INTERNAL", uploadedById: demandeurId } });
    await prisma.validationRequest.create({
      data: { reference: `VAL-${TAG}`, module: "Secrétariat", title: `${TAG} pièce`, entityType: "ADMIN_REQUEST", entityId: demande, documentId: doc.id, requesterId: demandeurId, status: "APPROVED" },
    });
    expect((await emettre("ADMIN_REQUEST", { sourceId: demande })).centralStatus).toBe("AWAITING");
  });

  it("une prise en charge : le PDF du devis retenu, passé en indice, justifie le paiement", async () => {
    const doc = await prisma.document.create({ data: { name: `${TAG}devis.pdf`, entityType: "CONGRESS_NATIONAL", entityId: `${TAG}autre`, category: "OTHER", confidentiality: "INTERNAL", uploadedById: demandeurId } });
    expect((await emettre("CONGRESS_NATIONAL", { justificatif: { documentId: doc.id } })).centralStatus).toBe("AWAITING");
    expect((await emettre("CONGRESS_NATIONAL", { justificatif: { documentId: null } })).centralStatus).toBe("AWAITING_PROOF");
  });

  // ── 3. LE RÈGLEMENT, LES ORDRES D'AVANT, LA RÉGULARISATION ─────────────────────────────────
  it("au règlement : un justificatif refusé depuis bloque l'ordre né sous la règle ; un ordre d'avant la règle n'est pas bloqué", async () => {
    // Une origine dont le règlement n'exige pas de FACTURE (`requiresInvoice` faux) : c'est la garde du justificatif qui parle.
    const ordre = await emettre("CONSULTING_CONTRACT", { justificatif: { fichier: fichier(), nature: "PROFORMA" } });
    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { centralStatus: "APPROVED", centralDecidedById: saId } });
    await prisma.paymentPiece.updateMany({ where: { request: { expenseOrderId: ordre.id } }, data: { status: "REJECTED" } });
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: ordre.id } });
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const fd = new FormData(); fd.set("id", ordre.id);
    expect((await settleExpenseOrder(fd)).error).toBe(REFUS_REGLEMENT_SANS_JUSTIFICATIF);

    // L'ordre d'AVANT la bascule : déjà au centre sans justificatif — il continue, mais le centre le sait.
    const ancien = await emettre("CONSULTING_CONTRACT", { sourceId: `${TAG}ancien` });
    await prisma.expenseOrder.update({ where: { id: ancien.id }, data: { justificatifExige: false, centralStatus: "AWAITING" } });
    const lu = (await justificatifsDesOrdres([ancien.id])).get(ancien.id);
    expect(lu).toMatchObject({ present: false, exige: false, enAttente: false, libelle: "sans justificatif" });
    await prisma.expenseOrder.update({ where: { id: ancien.id }, data: { centralStatus: "APPROVED", centralDecidedById: saId } });
    const fd2 = new FormData(); fd2.set("id", ancien.id);
    expect((await settleExpenseOrder(fd2)).error ?? "").not.toBe(REFUS_REGLEMENT_SANS_JUSTIFICATIF);
  });

  it("un paiement SOLDÉ se régularise : une pièce s'ajoute à son dossier compagnon, aucune ne se remplace", async () => {
    const ordre = await emettre("EVENT", { justificatif: { fichier: fichier(), nature: "PROFORMA" } });
    const dossierId = await dossierDe(ordre.id);
    await prisma.paymentRequest.update({ where: { id: dossierId }, data: { status: "APPROVED" } });
    ACTOR = demandeur;
    const r = await joindre(dossierId, "PROOF");
    expect(r.ok, r.error).toBe(true);
    const ev = await prisma.paymentRequestEvent.findFirst({ where: { requestId: dossierId, kind: "PIECE_ADDED" }, orderBy: { at: "desc" } });
    expect(ev?.message).toMatch(/régulariser/);
    const premiere = await prisma.paymentPiece.findFirstOrThrow({ where: { requestId: dossierId }, orderBy: { createdAt: "asc" } });
    const remplace = await joindre(dossierId, "PROOF", { replacesId: premiere.id });
    expect(remplace.ok).toBe(false);
    expect(remplace.error).toMatch(/jamais en remplacer/);
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: dossierId } })).status).toBe("APPROVED");
  });
});
