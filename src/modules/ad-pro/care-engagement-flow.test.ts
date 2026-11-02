import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { ensureInstance } from "@/lib/workflow/engine";
import { createCareQuote, decideCareQuote } from "./actions-prise-en-charge";
import { demanderBCPriseEnCharge, retenirDevisPriseEnCharge } from "./actions-prise-en-charge-logistique";
import { envoyerFiche, joindreDevisAgence } from "@/lib/actions/reservation-fiche-actions";
import { estPrevalidee, refusPersonnesNonAccordees, REFUS_NON_PREVALIDEE } from "./infra/prise-en-charge/engagement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — DEVIS, BC, ORDRE ET MONTANTS (Direction, 27/10/2026), par les VRAIES actions.
 *
 *  #5  Aucun devis, BC ni ordre tant que la demande n'est pas PRÉVALIDÉE (son instance de circuit `APPROVED`)
 *      ET que chaque personne couverte n'est pas « Accordée ».
 *  #7  Accepter un devis exige une catégorie budgétaire ; l'ordre de dépense né du devis la porte.
 *  #15 Le devis d'agence joint par l'assistante : un montant en DZD reste en DZD ; en USD, converti une fois (×240).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pecengage__${Date.now().toString(36)}`;

async function actorFor(id: string, role: UserRole): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>, cellIds: string[] = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  for (const c of cellIds) fd.append("cellIds", c);
  return fd;
};
const pdf = (nom: string) => new File([new TextEncoder().encode("%PDF-1.4\n%devis\n")], nom, { type: "application/pdf" });

describe("care-engagement — les règles, sans base", () => {
  it("l'instance de circuit fait foi ; sans elle, le statut d'origine de la demande", () => {
    expect(estPrevalidee("APPROVED", "AWAITING_PRELIMINARY")).toBe(true);
    expect(estPrevalidee("IN_PROGRESS", "APPROVED")).toBe(false);
    expect(estPrevalidee("RETURNED", null)).toBe(false);
    expect(estPrevalidee(null, "APPROVED")).toBe(true);
    expect(estPrevalidee(null, "PRE_VALIDATED")).toBe(true);
    expect(estPrevalidee(null, "AWAITING_FINAL")).toBe(false);
    expect(estPrevalidee(null, null)).toBe(false);
  });
  it("une personne « Proposée » bloque, et le refus la nomme", () => {
    expect(refusPersonnesNonAccordees([{ nom: "A", status: "APPROVED" }])).toBeNull();
    const r = refusPersonnesNonAccordees([{ nom: "A", status: "APPROVED" }, { nom: "Dr B", status: "PROPOSED" }]);
    expect(r).toMatch(/Accordée/);
    expect(r).toContain("Dr B (proposée)");
  });
});

suite("Prise en charge — rien ne s'engage avant la prévalidation et l'accord ; catégorie ; devise du devis d'agence", () => {
  let dirId = "", demId = "", daId = "";
  let DIR: CurrentUser, DEM: CurrentUser, DA: CurrentUser;
  let natId = "", intId = "", envId = "", catId = "";
  let accordee = "", proposee = "";
  let cellAccordee = "", cellProposee = "", hotelInt = "";
  let instanceId = "";
  const ordres: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [dir, dem, da] = await Promise.all([mk("dir", "DIRECTION"), mk("dem", "PRODUCT_MANAGER"), mk("da", "DIRECTION_ASSISTANT")]);
    dirId = dir.id; demId = dem.id; daId = da.id;
    DIR = await actorFor(dirId, "DIRECTION");
    DEM = await actorFor(demId, "PRODUCT_MANAGER");
    DA = await actorFor(daId, "DIRECTION_ASSISTANT");

    // Une demande nationale EN CIRCUIT : son instance naît « en cours » (création paresseuse du moteur).
    // Posée par l'assistante (demandeur ordinaire → Directeur des opérations) : celle de la Direction
    // Marketing serait prévalidée d'office à la naissance de l'instance (27/10/2026).
    natId = (await prisma.congressNational.create({ data: { name: `${TAG}Nat`, requestStatus: "AWAITING_PRELIMINARY", requesterId: daId }, select: { id: true } })).id;
    const inst = await ensureInstance("CONGRESS_NATIONAL", natId);
    expect(inst, "le moteur ouvre l'instance du circuit").toBeTruthy();
    instanceId = (await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_NATIONAL", entityId: natId } }, select: { id: true } })).id;

    accordee = (await prisma.careBeneficiary.create({ data: { congressNationalId: natId, firstName: "Amel", lastName: `${TAG}Accordée`, status: "APPROVED" } })).id;
    proposee = (await prisma.careBeneficiary.create({ data: { congressNationalId: natId, firstName: "Karim", lastName: `${TAG}Proposé`, status: "PROPOSED" } })).id;
    cellAccordee = (await prisma.careCell.create({ data: { beneficiaryId: accordee, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Oran" } })).id;
    cellProposee = (await prisma.careCell.create({ data: { beneficiaryId: proposee, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Oran" } })).id;

    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_NATIONAL"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000 },
    });
    envId = env.id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Congrès`, module: "CONGRESS_NATIONAL", allocated: 5_000_000 } })).id;

    // Une demande internationale PRÉVALIDÉE (statut d'origine, sans instance) : un hôtel, poste en dollars.
    intId = (await prisma.congressInternational.create({ data: { name: `${TAG}Int`, requestStatus: "APPROVED", requesterId: demId, usdDzdRate: 240 }, select: { id: true } })).id;
    const pInt = (await prisma.careBeneficiary.create({ data: { congressInternationalId: intId, firstName: "Nora", lastName: `${TAG}Voyageuse`, status: "APPROVED" } })).id;
    hotelInt = (await prisma.careCell.create({
      data: {
        beneficiaryId: pInt, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: "Paris", currency: "USD",
        dateStart: new Date("2026-11-20"), dateEnd: new Date("2026-11-23"),
      },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ids = [natId, intId].filter(Boolean);
    const sujets = [
      ...(await prisma.congressNational.findMany({ where: { id: { in: ids } }, select: { careReservationDossierId: true } }).catch(() => [])),
      ...(await prisma.congressInternational.findMany({ where: { id: { in: ids } }, select: { careReservationDossierId: true } }).catch(() => [])),
    ].map((s) => s.careReservationDossierId).filter((v): v is string => Boolean(v));
    const docs = await prisma.document.findMany({ where: { entityId: { in: ids } }, select: { fileKey: true } }).catch(() => []);
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.demandeReservation.deleteMany({ where: { operationId: { in: ids } } }).catch(() => {});
    await prisma.careQuote.deleteMany({ where: { OR: [{ congressNationalId: { in: ids } }, { congressInternationalId: { in: ids } }] } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { OR: [{ congressNationalId: { in: ids } }, { congressInternationalId: { in: ids } }] } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: sujets } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [dirId, demId, daId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [dirId, demId, daId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("PRÉMISSE : la Direction a la vue globale (seule la garde d'engagement peut la refuser)", () => {
    expect(hasGlobalView(DIR)).toBe(true);
  });

  it("#5 — devis sur une PEC NON prévalidée (circuit en cours) → refusé, même pour une personne accordée", async () => {
    ACTOR = DIR;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Hôtel`, amount: "50000" }, [cellAccordee]));
    expect(r.ok === false && r.error).toBe(REFUS_NON_PREVALIDEE);
    expect(await prisma.careQuote.count({ where: { congressNationalId: natId } })).toBe(0);
  });

  it("#5 — l'instance fait foi : un statut d'origine « APPROVED » ne contourne pas un circuit en cours", async () => {
    await prisma.congressNational.update({ where: { id: natId }, data: { requestStatus: "APPROVED" } });
    ACTOR = DIR;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Hôtel`, amount: "50000" }, [cellAccordee]));
    expect(r.ok === false && r.error).toBe(REFUS_NON_PREVALIDEE);
    // Le circuit s'achève à l'étape Direction Marketing : la demande est prévalidée.
    await prisma.workflowInstance.update({ where: { id: instanceId }, data: { status: "APPROVED", currentSlug: null } });
  });

  it("#5 — devis sur une personne « Proposée » → refusé, et le refus la nomme", async () => {
    ACTOR = DIR;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Hôtel`, amount: "90000" }, [cellAccordee, cellProposee]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Accordée/);
    expect(r.ok === false && r.error).toContain(`Karim ${TAG}Proposé (proposée)`);
    expect(await prisma.careQuote.count({ where: { congressNationalId: natId } })).toBe(0);
  });

  it("#5 / #7 — prévalidée et personne accordée : le devis s'enregistre ; BC et ordre refusés si le circuit est rouvert", async () => {
    ACTOR = DIR;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Hôtel`, amount: "50000" }, [cellAccordee]));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const quoteId = r.id!;
    expect((await retenirDevisPriseEnCharge(undefined, fdOf({ id: quoteId }))).ok).toBe(true);

    await prisma.workflowInstance.update({ where: { id: instanceId }, data: { status: "IN_PROGRESS" } });
    const bc = await demanderBCPriseEnCharge(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(bc.ok === false && bc.error).toBe(REFUS_NON_PREVALIDEE);
    const ordre = await decideCareQuote(undefined, fdOf({ id: quoteId, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(ordre.ok === false && ordre.error).toBe(REFUS_NON_PREVALIDEE);
    expect((await prisma.careQuote.findUniqueOrThrow({ where: { id: quoteId } })).expenseOrderId).toBeNull();

    // La personne repasse « proposée » : ni BC ni ordre, même prévalidée.
    await prisma.workflowInstance.update({ where: { id: instanceId }, data: { status: "APPROVED" } });
    await prisma.careBeneficiary.update({ where: { id: accordee }, data: { status: "PROPOSED" } });
    const bc2 = await demanderBCPriseEnCharge(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(bc2.ok === false && bc2.error).toMatch(/Accordée/);
    const ordre2 = await decideCareQuote(undefined, fdOf({ id: quoteId, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(ordre2.ok === false && ordre2.error).toMatch(/Accordée/);
    await prisma.careBeneficiary.update({ where: { id: accordee }, data: { status: "APPROVED" } });
  });

  it("#7 — accepter SANS catégorie budgétaire → refusé ; catégorie inconnue → refusé", async () => {
    ACTOR = DIR;
    const q = await prisma.careQuote.findFirstOrThrow({ where: { congressNationalId: natId }, select: { id: true } });
    const sans = await decideCareQuote(undefined, fdOf({ id: q.id, decision: "ACCEPTED" }));
    expect(sans.ok === false && sans.error).toMatch(/catégorie budgétaire/);
    const inconnue = await decideCareQuote(undefined, fdOf({ id: q.id, decision: "ACCEPTED", budgetCategoryId: "inexistante" }));
    expect(inconnue.ok === false && inconnue.error).toMatch(/introuvable/);
    expect((await prisma.careQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("PENDING");
  });

  it("#7 — accepter AVEC catégorie : l'ordre de dépense né du devis la porte", async () => {
    ACTOR = DIR;
    const q = await prisma.careQuote.findFirstOrThrow({ where: { congressNationalId: natId }, select: { id: true } });
    const r = await decideCareQuote(undefined, fdOf({ id: q.id, decision: "ACCEPTED", budgetCategoryId: catId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const quote = await prisma.careQuote.findUniqueOrThrow({ where: { id: q.id }, select: { status: true, expenseOrderId: true } });
    expect(quote.status).toBe("ACCEPTED");
    ordres.push(quote.expenseOrderId!);
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: quote.expenseOrderId! }, select: { budgetCategoryId: true, amount: true } });
    expect(ordre.budgetCategoryId).toBe(catId);
    expect(Number(ordre.amount)).toBe(50_000);
  });

  it("#15 — devis d'agence joint par l'assistante : 180 000 DZD restent 180 000 DZD ; 750 USD deviennent 180 000 DZD", async () => {
    ACTOR = DEM;
    const envoi = await envoyerFiche(fdOf({ source: "CARE_CELL", id: hotelInt }));
    expect(envoi.ok, envoi.ok ? "" : envoi.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { careCellId: hotelInt }, select: { id: true } });

    ACTOR = DA;
    const enDzd = fdOf({ id: d.id, fournisseur: `${TAG}Agence DZD`, montant: "180000", devise: "DZD" });
    enDzd.append("attachment", pdf(`${TAG}devis-dzd.pdf`));
    const r1 = await joindreDevisAgence(enDzd);
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    const q1 = await prisma.careQuote.findFirstOrThrow({ where: { congressInternationalId: intId, supplier: `${TAG}Agence DZD` } });
    expect(Number(q1.amountDzd)).toBe(180_000);
    expect(q1.currency).toBe("DZD");
    expect(Number(q1.amount)).toBe(180_000);

    // Sans devise dite, le montant est en dinars (le défaut de l'écran) : il n'est plus relu en dollars.
    const parDefaut = fdOf({ id: d.id, fournisseur: `${TAG}Agence défaut`, montant: "180000" });
    parDefaut.append("attachment", pdf(`${TAG}devis-defaut.pdf`));
    expect((await joindreDevisAgence(parDefaut)).ok).toBe(true);
    const q0 = await prisma.careQuote.findFirstOrThrow({ where: { congressInternationalId: intId, supplier: `${TAG}Agence défaut` } });
    expect(Number(q0.amountDzd)).toBe(180_000);

    const enUsd = fdOf({ id: d.id, fournisseur: `${TAG}Agence USD`, montant: "750", devise: "USD" });
    enUsd.append("attachment", pdf(`${TAG}devis-usd.pdf`));
    const r2 = await joindreDevisAgence(enUsd);
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    const q2 = await prisma.careQuote.findFirstOrThrow({ where: { congressInternationalId: intId, supplier: `${TAG}Agence USD` } });
    expect(Number(q2.amountDzd)).toBe(180_000);
    expect(q2.currency).toBe("USD");
    expect(Number(q2.amount)).toBe(750);
  });
});
