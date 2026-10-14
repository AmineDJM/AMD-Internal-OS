import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { cancelLegalDocument, restoreLegalDocument, renewLegalDocument } from "./legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__legalfin__";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BOUTONS LEGAL DES FINANCES SONT DES GESTES ACCEPTÉS (audit 360°, R16, lot C4a).
 *
 * Les Finances écrivent les factures et les bons de commande (§118.135) ; la liste Legal leur
 * offrait « Renouveler », « Annuler » et « Rétablir », et chaque action refusait sur le seul droit
 * Legal — un bouton offert puis retiré, la panne qu'on cherche pour rien. La règle est désormais
 * celle de l'écriture d'une pièce, par NATURE : les Finances sur leur chaîne d'achat, jamais sur un
 * contrat. Renouveler, c'est CRÉER la suite : la porte est celle de la création — un compte qui peut
 * modifier Legal sans pouvoir y créer ne renouvelle pas.
 *
 * Aucun acteur n'a la vue globale (§118.104) : un compte des Finances, et un compte dont le seul
 * accès est « Legal : lire et modifier, pas créer ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Legal — les Finances annulent, rétablissent et renouvellent leurs pièces (flux réel)", () => {
  let finId = "", editeurId = "";
  let facture = "", contrat = "", bcFin = "", bcEditeur = "";

  const piece = (suffix: string, kind: "INVOICE" | "CONTRACT" | "PURCHASE_ORDER") =>
    prisma.legalDocument.create({
      data: {
        title: `${TAG} ${suffix}`, kind, status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
      },
      select: { id: true },
    }).then((d) => d.id);
  const statut = async (id: string) => (await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    finId = (await mk("fin", "FINANCE_BUDGET_MANAGER")).id;
    editeurId = (await mk("editeur", "VIEWER")).id;
    // Legal : LIRE et MODIFIER, pas CRÉER — une configuration que la console permet (§118.147).
    await prisma.userAccess.create({ data: { userId: editeurId, module: "LEGAL", canView: true, canUpdate: true, scope: "ALL" } });
    [facture, contrat, bcFin, bcEditeur] = await Promise.all([
      piece("facture", "INVOICE"), piece("contrat", "CONTRACT"), piece("bc-fin", "PURCHASE_ORDER"), piece("bc-editeur", "PURCHASE_ORDER"),
    ]);
  });

  afterAll(async () => {
    const ids = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    // Les renouvellements pointent vers leur original : les suites d'abord.
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids }, renewedFromId: { not: null } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("PRÉMISSES : les Finances écrivent par le module Finances, pas par Legal ; l'éditeur modifie Legal sans y créer", async () => {
    const fin = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    const ed = await actorFor(editeurId, "VIEWER");
    expect([userCan(fin, "LEGAL", "UPDATE"), userCan(fin, "LEGAL", "CREATE")], "sans quoi la règle par nature ne serait pas exercée").toEqual([false, false]);
    expect([userCan(fin, "FINANCES", "UPDATE"), userCan(fin, "FINANCES", "CREATE")]).toEqual([true, true]);
    expect([userCan(ed, "LEGAL", "UPDATE"), userCan(ed, "LEGAL", "CREATE"), userCan(ed, "FINANCES", "CREATE")]).toEqual([true, false, false]);
  });

  it("LES FINANCES ANNULENT une facture (avec son motif) et la RÉTABLISSENT — le bouton offert est un geste accepté", async () => {
    ACTOR = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    const a = await cancelLegalDocument(form({ id: facture, reason: "Doublon de la facture 0412." }));
    expect(a.ok, a.error).toBe(true);
    expect(await statut(facture)).toBe("CANCELLED");
    // L'état d'abord : une pièce déjà annulée ne demande pas pourquoi l'annuler (§118.18).
    expect((await cancelLegalDocument(form({ id: facture }))).error).toBe("Ce document ne peut plus être annulé.");
    const r = await restoreLegalDocument(form({ id: facture }));
    expect(r.ok, r.error).toBe(true);
    expect(await statut(facture)).not.toBe("CANCELLED");
    // Et sur une pièce qui S'ANNULE, le motif reste exigé — rien n'est écrit sans lui.
    expect((await cancelLegalDocument(form({ id: facture }))).error).toBe("Le motif de l'annulation est obligatoire.");
    expect(await statut(facture)).not.toBe("CANCELLED");
  });

  it("…mais un CONTRAT leur reste fermé : introuvable, la même phrase que son absence", async () => {
    ACTOR = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    expect((await cancelLegalDocument(form({ id: contrat, reason: "Essai." }))).error).toBe("Document introuvable.");
    expect((await renewLegalDocument(form({ id: contrat }))).error).toBe("Document introuvable.");
    expect(await statut(contrat)).toBe("ACTIVE");
  });

  it("RENOUVELER, c'est CRÉER la suite : les Finances renouvellent un bon de commande ; qui modifie Legal sans pouvoir y créer, non", async () => {
    ACTOR = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    const r = await renewLegalDocument(form({ id: bcFin }));
    expect(r.ok, r.error).toBe(true);
    expect(await statut(bcFin)).toBe("RENEWED");
    const suite = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! }, select: { kind: true, renewedFromId: true } });
    expect(suite).toEqual({ kind: "PURCHASE_ORDER", renewedFromId: bcFin });

    const ed = await actorFor(editeurId, "VIEWER");
    expect(await canAccessEntity(ed, "LEGAL_DOCUMENT", bcEditeur, "UPDATE"), "PRÉMISSE : la porte de la fiche le laisse passer — seul le droit de CRÉER doit l'arrêter").toBe(true);
    ACTOR = ed;
    expect((await renewLegalDocument(form({ id: bcEditeur }))).error).toBe("Non autorisé.");
    expect(await statut(bcEditeur)).toBe("ACTIVE");
  });
});
