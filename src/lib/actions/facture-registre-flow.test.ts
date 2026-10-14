import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser, type EffectiveAccess } from "@/lib/rbac";
import { createLegalDocument, updateLegalDocument, sendLegalInvoiceToSettlement } from "./legal-actions";
import { createInvoice, setInvoicePaid } from "./invoice-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__factureRegistre__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * LA COMPTABLE — droits FINANCES, aucun droit LEGAL.
 *
 * Construit À LA MAIN plutôt que déduit d'un rôle : ce qu'on vérifie n'est pas la matrice des
 * rôles (elle a ses propres tests), c'est que la PORTE tient — que celle qui n'a que les
 * Finances peut tenir les factures, et rien d'autre du registre. Un rôle réel qui gagnerait
 * demain le droit Legal rendrait ce test muet sans qu'on le sache.
 */
function comptable(id: string, name: string): CurrentUser {
  const access: EffectiveAccess = {
    modules: new Map([["FINANCES", { actions: new Set(["VIEW", "CREATE", "UPDATE", "DELETE"] as const), scope: "ALL" }]]),
    rowGrants: new Map(),
  } as unknown as EffectiveAccess;
  return { id, name, email: `${id}@t.dz`, role: "FINANCE_BUDGET_MANAGER", access, mustChangePassword: false } as CurrentUser;
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

/**
 * UNE FACTURE EST UN DOCUMENT LÉGAL — vérifié depuis LES VRAIS POINTS D'ENTRÉE (§118-14).
 *
 * Les modules purs disent ce que les règles DÉCIDENT ; ce fichier vérifie ce qu'elles FONT, en
 * partant du formulaire ordinaire de Legal et des actions du vocabulaire « facture » — pas d'un
 * état injecté à la main, qui ne répondrait pas à la question.
 *
 * Ce qui est en jeu, dans l'ordre où ça casse quand on se trompe :
 *   • une facture enregistrée DEPUIS LE FORMULAIRE ORDINAIRE entre bien dans le registre, avec
 *     sa nature — c'est tout le lot, en une ligne ;
 *   • marquer une facture réglée ÉCRIT au livre, et la dé-marquer RETIRE l'écriture. Sans cela
 *     l'argent bougerait sans trace, et l'écran qu'on consulterait pour s'en apercevoir serait
 *     précisément celui qui mentirait ;
 *   • LE MÊME DINAR NE SORT PAS DEUX FOIS. Une facture a deux chemins vers l'argent (le circuit
 *     du centre de paiement, la saisie directe) : les laisser tourner ensemble sur la même pièce
 *     gonflerait le mois sans que rien ne le signale. Les deux bouts se refusent l'un l'autre ;
 *   • LA COMPTABILITÉ NE PERD PAS LES FACTURES en centralisant — et ne gagne pas les baux. Le
 *     refus vient du SERVEUR, pas d'un bouton masqué (§118-7).
 */
suite("Une facture est un document légal de nature « facture »", () => {
  let adminId = "";
  let compta: CurrentUser | null = null;
  /**
   * LA PARTIE VIENT DE L'ANNUAIRE — le formulaire ne la tape plus.
   *
   * Le test crée donc un vrai contact et passe son identifiant, exactement comme le sélecteur.
   * L'écrire en texte ici ne prouverait plus rien : le serveur le refuserait, et c'est le but.
   */
  let partieId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
      select: { id: true },
    });
    adminId = u.id;
    const c = await prisma.user.create({
      data: { name: `${TAG}compta`, email: `${TAG}compta@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" },
      select: { id: true },
    });
    compta = comptable(c.id, `${TAG}compta`);
    const contact = await prisma.companyContact.create({
      data: { name: `${TAG} Froid Industriel SPA`, kind: "Prestataire", createdById: adminId },
      select: { id: true },
    });
    partieId = contact.id;
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
  }, 60_000);

  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, settlementTxId: true } });
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({
      where: { id: { in: docs.map((d) => d.settlementTxId).filter((x): x is string => Boolean(x)) } },
    }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { label: { contains: TAG } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { label: { contains: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("LE FORMULAIRE ORDINAIRE DE LEGAL enregistre une facture — pas un écran à part", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await createLegalDocument(undefined, fd({
      title: `${TAG} Maintenance climatisation`, kind: "INVOICE", reference: "F-2026-501",
      counterpartyIds: partieId, amount: "180000", direction: "OUT",
      startDate: "2026-03-01", endDate: "2026-04-15",
    }));
    expect(r.ok, r.error).toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(doc.kind).toBe("INVOICE");
    expect(doc.reference).toBe("F-2026-501");
    expect(doc.direction).toBe("OUT");
    // Non réglée : aucune écriture, et c'est le bon défaut.
    expect(doc.paidDate).toBeNull();
    expect(doc.settlementTxId).toBeNull();
  });

  it("MARQUER RÉGLÉE ÉCRIT AU LIVRE — et dé-marquer RETIRE l'écriture", async () => {
    const r = await createLegalDocument(undefined, fd({
      title: `${TAG} Fournitures`, kind: "INVOICE", amount: "45000", direction: "OUT", counterpartyIds: partieId,
    }));
    expect(r.ok, r.error).toBe(true);

    const paye = await setInvoicePaid({ id: r.id!, paidDate: "2026-05-04" });
    expect(paye.ok, paye.error).toBe(true);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(apres.settlementTxId).not.toBeNull();
    const tx = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: apres.settlementTxId! } });
    expect(tx.direction).toBe("OUT");
    expect(Number(tx.amount)).toBe(45_000);
    // Le nom écrit au livre est celui de la PARTIE CHOISIE dans l'annuaire — plus une chaîne
    // saisie à la main, qui pouvait s'écrire de trois façons sur trois factures du même
    // fournisseur.
    expect(tx.counterparty).toBe(`${TAG} Froid Industriel SPA`);

    // Re-marquer ne DOUBLE pas l'écriture : l'état est déjà cohérent.
    await setInvoicePaid({ id: r.id!, paidDate: "2026-05-04" });
    expect(await prisma.financeTransaction.count({ where: { id: tx.id } })).toBe(1);

    const annule = await setInvoicePaid({ id: r.id!, paidDate: null });
    expect(annule.ok, annule.error).toBe(true);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).settlementTxId).toBeNull();
    expect(await prisma.financeTransaction.count({ where: { id: tx.id } })).toBe(0);
  });

  it("UNE FACTURE DÉJÀ RÉGLÉE NE PART PAS AU RÈGLEMENT — elle décaisserait une seconde fois", async () => {
    const r = await createLegalDocument(undefined, fd({
      title: `${TAG} Déjà payée`, kind: "INVOICE", amount: "90000", direction: "OUT",
      counterpartyIds: partieId, paidDate: "2026-04-01",
    }));
    expect(r.ok, r.error).toBe(true);
    // La saisie a posteriori a inscrit son mouvement dès la création.
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).settlementTxId).not.toBeNull();

    const envoi = await sendLegalInvoiceToSettlement(fd({ id: r.id! }));
    expect(envoi.ok).toBe(false);
    expect(envoi.error).toMatch(/seconde fois/);
  });

  it("ET RÉCIPROQUEMENT : une facture PARTIE au règlement refuse la date posée à la main", async () => {
    const r = await createLegalDocument(undefined, fd({
      title: `${TAG} Au circuit`, kind: "INVOICE", amount: "120000", direction: "OUT", counterpartyIds: partieId,
    }));
    expect(r.ok, r.error).toBe(true);

    const envoi = await sendLegalInvoiceToSettlement(fd({ id: r.id! }));
    expect(envoi.ok, envoi.error).toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(doc.expenseOrderId).not.toBeNull();

    // Depuis la ligne du tableau…
    const ligne = await setInvoicePaid({ id: r.id!, paidDate: "2026-06-01" });
    expect(ligne.ok).toBe(false);
    expect(ligne.error).toMatch(/centre de paiement/);

    // …et depuis le formulaire ORDINAIRE, qui est l'autre porte vers le même champ.
    const form = await updateLegalDocument(fd({
      id: r.id!, title: `${TAG} Au circuit`, kind: "INVOICE", amount: "120000",
      direction: "OUT", counterpartyIds: partieId, paidDate: "2026-06-01",
    }));
    expect(form.ok).toBe(false);
    expect(form.error).toMatch(/centre de paiement/);

    // Aucune écriture directe n'a été posée : le circuit reste seul maître du règlement.
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).settlementTxId).toBeNull();
  });

  it("le vocabulaire « facture » d'Adam et des fiches écrit dans le MÊME registre", async () => {
    const r = await createInvoice(undefined, fd({
      title: `${TAG} Prestation réglementaire`, number: "AV-2026-77", amount: "500000",
      direction: "IN", counterpartyIds: partieId, issueDate: "2026-02-10", dueDate: "2026-03-10",
    }));
    expect(r.ok, r.error).toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(doc.kind).toBe("INVOICE");
    expect(doc.reference).toBe("AV-2026-77");
    expect(doc.startDate?.toISOString().slice(0, 10)).toBe("2026-02-10");
    expect(doc.endDate?.toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(doc.direction).toBe("IN");
  });

  it("LA COMPTABILITÉ TIENT LES FACTURES — et le SERVEUR lui refuse le reste du registre", async () => {
    ACTOR = compta;
    const facture = await createLegalDocument(undefined, fd({
      title: `${TAG} Facture de la comptable`, kind: "INVOICE", amount: "20000", direction: "OUT",
      counterpartyIds: partieId,
    }));
    expect(facture.ok, facture.error).toBe(true);

    // Un bail n'est pas une facture : le refus est SERVEUR, pas un bouton masqué (§118-7).
    const bail = await createLegalDocument(undefined, fd({ title: `${TAG} Bail interdit`, kind: "LEASE" }));
    expect(bail.ok).toBe(false);
    expect(bail.error).toMatch(/autorisé/i);
    expect(await prisma.legalDocument.count({ where: { title: `${TAG} Bail interdit` } })).toBe(0);
  });

  it("ET ELLE NE REBAPTISE PAS UN BAIL EN FACTURE POUR S'OUVRIR LA PORTE", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const bail = await createLegalDocument(undefined, fd({ title: `${TAG} Bail Alger`, kind: "LEASE", counterpartyIds: partieId }));
    expect(bail.ok, bail.error).toBe(true);

    ACTOR = compta;
    const detourne = await updateLegalDocument(fd({ id: bail.id!, title: `${TAG} Bail Alger`, kind: "INVOICE" }));
    expect(detourne.ok).toBe(false);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bail.id! } })).kind).toBe("LEASE");
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
  });
});
