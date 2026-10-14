import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { createLegalDocument, updateLegalDocument } from "@/lib/actions/legal-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { signerBonDeCommande, renvoyerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { fileBonsDeCommande, REFUS_SIGNATURE_BC } from "@/lib/queries/bons-de-commande";
import { etatDuBC } from "./etat";
import { OBJET_BC } from "./aiguillage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bcrenvoi__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RENVOYER UN BON DE COMMANDE À SON ÉMETTEUR — par les VRAIS points d'entrée (audit 360°, R09).
 *
 * Un signataire n'avait qu'un geste, signer : un BC erroné ne pouvait être ni refusé ni renvoyé.
 * Ce banc joue ce qu'une personne fait : le signataire RENVOIE le BC avec ce qu'il faut corriger ;
 * il quitte la file « à signer » sans disparaître ; son émetteur est prévenu ; il ne se signe plus ;
 * et sa MODIFICATION le rend à la signature — ou d'abord à son centre si son montant monte.
 *
 * LE SEUIL des bons de commande est un réglage GLOBAL, partagé par une suite parallèle (§118.115) :
 * on ne l'écrit pas, on le LIT et l'on choisit des montants au-dessus de lui — un BC qui passe par
 * un centre, quel que soit le réglage du moment. Le signataire est un gestionnaire budgétaire, pas
 * un Super Admin : une garde éprouvée avec un Super Admin ne peut pas tomber (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Bons de commande — renvoyer à l'émetteur au lieu de signer (flux réel)", () => {
  let legalId = "", financeId = "", saId = "", intrusId = "", contactId = "";
  let base = 0;
  const docs: string[] = [];

  const validationsEnAttente = (docId: string) => prisma.validationRequest.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_BC, status: "PENDING" },
    include: { steps: true },
  });
  const approuverSiBesoin = async (docId: string) => {
    for (const v of await validationsEnAttente(docId)) {
      ACTOR = await actorFor(saId, "SUPER_ADMIN");
      for (const e of v.steps.filter((s) => s.status === "PENDING")) {
        const r = await decideValidation(form({ stepId: e.id, decision: "APPROVED" }));
        expect(r.ok, r.ok === false ? r.error : "").toBe(true);
      }
    }
  };
  /** Un BC qui arrive « à signer » par le chemin normal : enregistré, validé par son centre. */
  const bcASigner = async (suffix: string, montant = base) => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: String(montant),
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    await approuverSiBesoin(r.id!);
    expect((await etatDuBC(r.id!))?.etape, "PRÉMISSE : le BC arrive à la signature par le chemin normal").toBe("A_SIGNER");
    return r.id!;
  };
  const renvoyer = async (actorId: string, role: SessionUser["role"], id: string, note: string) => {
    ACTOR = await actorFor(actorId, role);
    return renvoyerBonDeCommande(form({ id, note }));
  };

  async function attendreBloques(tx: Prisma.TransactionClient, motif: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${motif}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${motif}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const seuil = (await getAppSettings()).bcValidationThreshold;
    base = Math.max(0, Number(seuil) || 0) + 100_000;
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    legalId = (await mk("legal", "DIRECTION_ASSISTANT")).id;
    financeId = (await mk("finance", "FINANCE_BUDGET_MANAGER")).id;
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    intrusId = (await mk("intrus", "MEDICAL_DELEGATE")).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
  });

  afterAll(async () => {
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: docs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  });

  it("PRÉMISSES : le signataire signe sans être Super Admin ; l'émetteur et l'intrus ne signent pas", async () => {
    const f = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    expect(userCan(f, "PURCHASE_ORDERS", "UPDATE")).toBe(true);
    expect(f.role).not.toBe("SUPER_ADMIN");
    expect(userCan(await actorFor(legalId, "DIRECTION_ASSISTANT"), "PURCHASE_ORDERS", "UPDATE")).toBe(false);
    expect(userCan(await actorFor(intrusId, "MEDICAL_DELEGATE"), "PURCHASE_ORDERS", "UPDATE")).toBe(false);
  });

  it("RENVOYER est le geste d'un signataire, et le motif est exigé", async () => {
    const id = await bcASigner("garde");
    const intrus = await renvoyer(intrusId, "MEDICAL_DELEGATE", id, "Je ne suis pas d'accord.");
    expect(intrus.error).toBe(REFUS_SIGNATURE_BC);
    const emetteur = await renvoyer(legalId, "DIRECTION_ASSISTANT", id, "Je me le renvoie.");
    expect(emetteur.error, "l'émetteur ne se renvoie pas sa propre pièce : il la modifie").toBe(REFUS_SIGNATURE_BC);
    const sansMotif = await renvoyer(financeId, "FINANCE_BUDGET_MANAGER", id, "");
    expect(sansMotif.error).toMatch(/Dites ce qu'il faut corriger/);
    expect((await etatDuBC(id))?.etape, "trois refus, rien d'écrit").toBe("A_SIGNER");
  });

  it("un BC encore À VALIDER ne se renvoie pas d'ici : c'est son centre qui a la main", async () => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} avalider`, reference: `${TAG}avalider`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: String(base),
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    expect((await etatDuBC(r.id!))?.etape, "PRÉMISSE : au-dessus du seuil, il attend son centre").toBe("A_VALIDER");
    const tente = await renvoyer(financeId, "FINANCE_BUDGET_MANAGER", r.id!, "Trop cher.");
    expect(tente.ok).toBe(false);
    expect(tente.error).toMatch(/attend encore la validation/);
    expect((await etatDuBC(r.id!))?.renvoi, "rien n'est écrit").toBeNull();
  });

  it("RENVOYÉ : il quitte la file sans disparaître, son émetteur sait quoi corriger, et il ne se signe plus", async () => {
    const id = await bcASigner("renvoye");
    const r = await renvoyer(financeId, "FINANCE_BUDGET_MANAGER", id, "Le fournisseur n'est pas le bon.");
    expect(r.ok, r.error).toBe(true);
    const etat = await etatDuBC(id);
    expect(etat?.etape).toBe("A_CORRIGER");
    expect(etat?.renvoi?.note).toBe("Le fournisseur n'est pas le bon.");
    expect(etat?.renvoi?.par).toBe(`${TAG}finance`);

    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const file = await fileBonsDeCommande(ACTOR);
    expect(file?.aSigner.some((l) => l.id === id), "il n'est plus à signer").toBe(false);
    const ligne = file?.renvoyes.find((l) => l.id === id);
    expect(ligne, "mais les signataires le voient, avec ce qu'ils ont demandé").toBeTruthy();
    expect(ligne?.renvoi?.note).toBe("Le fournisseur n'est pas le bon.");

    const n = await prisma.notification.findFirst({ where: { userId: legalId, link: `/legal/${id}` }, orderBy: { createdAt: "desc" } });
    expect(n?.title).toMatch(/renvoyé pour correction/);
    expect(n?.body).toMatch(/Le fournisseur n'est pas le bon/);
    expect(n?.body, "le geste qui le rend à la signature est NOMMÉ").toMatch(/Modifiez-le dans Legal/);

    const signe = await signerBonDeCommande(avecCopieSignee(form({ id })));
    expect(signe.ok).toBe(false);
    expect(signe.error).toMatch(/renvoyé à son émetteur/);
    const encore = await renvoyerBonDeCommande(form({ id, note: "Bis." }));
    expect(encore.error).toMatch(/déjà renvoyé/);
    expect(await prisma.auditLog.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: id, summary: { contains: "renvoyé à son émetteur" } } })).toBe(1);
  });

  it("sa MODIFICATION le rend à la signature — les signataires en sont prévenus, et il se signe", async () => {
    const id = await bcASigner("corrige");
    expect((await renvoyer(financeId, "FINANCE_BUDGET_MANAGER", id, "Préciser l'adresse de livraison.")).ok).toBe(true);
    const avant = new Date();
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const modif = await updateLegalDocument(form({
      id, title: `${TAG} corrige`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: String(base), notes: "Livraison : entrepôt de Rouiba.",
    }));
    expect(modif.ok, modif.ok === false ? modif.error : "").toBe(true);
    const etat = await etatDuBC(id);
    expect(etat?.etape).toBe("A_SIGNER");
    expect(etat?.renvoi, "le renvoi s'efface de la ligne").toBeNull();
    const ligne = await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { signatureReturnedAt: true, signatureReturnedById: true, signatureReturnNote: true } });
    expect(ligne).toEqual({ signatureReturnedAt: null, signatureReturnedById: null, signatureReturnNote: null });
    const prevenu = await prisma.notification.count({ where: { userId: financeId, createdAt: { gte: avant }, title: { contains: "signer" } } });
    expect(prevenu, "il RE-ENTRE dans la file des signataires : ils le savent").toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: id, summary: { contains: "corrigé après son renvoi" } } })).toBe(1);

    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const s = await signerBonDeCommande(avecCopieSignee(form({ id })));
    expect(s.ok, s.error).toBe(true);
  });

  it("modifié avec un montant RELEVÉ : il retourne d'abord à son centre, puis à la signature", async () => {
    const id = await bcASigner("releve");
    expect((await renvoyer(financeId, "FINANCE_BUDGET_MANAGER", id, "Ajouter la TVA oubliée.")).ok).toBe(true);
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const modif = await updateLegalDocument(form({ id, title: `${TAG} releve`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: String(base + 100_000) }));
    expect(modif.ok, modif.ok === false ? modif.error : "").toBe(true);
    const etat = await etatDuBC(id);
    expect(etat?.etape, "un accord ne couvre pas plus que ce qu'il a vu").toBe("A_VALIDER");
    expect(etat?.renvoi).toBeNull();
    await approuverSiBesoin(id);
    expect((await etatDuBC(id))?.etape).toBe("A_SIGNER");
  });

  it("SIGNER et RENVOYER à la même seconde : une seule issue — jamais signé ET renvoyé", async () => {
    const id = await bcASigner("duel");
    const finance = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    let gestes: Promise<{ ok: boolean; error?: string }>[] = [];
    // Le verrou SHARE arrête toute écriture de pièce sans arrêter les lectures : les deux gestes
    // relisent la même pièce « à signer » avant que l'un n'écrive.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "LegalDocument" IN SHARE MODE`);
      ACTOR = finance;
      const a = signerBonDeCommande(avecCopieSignee(form({ id })));
      const b = renvoyerBonDeCommande(form({ id, note: "Montant à revoir." }));
      gestes = [a, b];
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, "signedAt", 2);
    }, { timeout: 20_000 });
    const [a, b] = await Promise.all(gestes);
    expect([a.ok, b.ok].filter(Boolean), "une issue, pas deux").toHaveLength(1);
    const ligne = await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { signedAt: true, signatureReturnedAt: true } });
    expect(ligne.signedAt !== null && ligne.signatureReturnedAt !== null, "jamais signé ET renvoyé").toBe(false);
    expect((await etatDuBC(id))?.etape).toBe(a.ok ? "SIGNE" : "A_CORRIGER");
  });
});
