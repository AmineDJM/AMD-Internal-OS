import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import {
  createLegalDocument, updateLegalDocument, cancelLegalDocument, deleteLegalDocument,
  sendLegalInvoiceToSettlement, adresserBCAuCentre,
} from "@/lib/actions/legal-actions";
import { rattacherLegalAFiche } from "@/modules/ad-pro/actions-rattacher-legal";
import { decideValidation } from "@/lib/actions/validation-actions";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
import { demandesAuCentreAdPro } from "@/modules/ad-pro/api";
import { porteDuBC, aiguillerBC, OBJET_BC } from "./aiguillage";
import { reserveSansPorte } from "./regle";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bcpartout__";

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
 * TOUT BON DE COMMANDE PASSE PAR UN CENTRE — par les VRAIS points d'entrée (§118.14, §118.148).
 *
 * « Concernant les BC, ils doivent tous passer soit par le centre de validation Ad&Pro si la
 * demande est depuis Ad&Pro, soit par le centre de validation normal. »
 *
 * La règle pure (`regle.test.ts`) dit ce qu'elle CALCULE. Ce banc dit ce qui compte : quelqu'un
 * qui enregistre un BC dans Legal le voit-il arriver au BON centre, et la facture qui en découle
 * attend-elle sa validation ? Chaque cas passe par l'action de l'écran, jamais par une porte
 * injectée à la main — sauf le BC « d'avant la règle », dont l'absence de porte EST le décor.
 *
 * L'acteur qui ENREGISTRE est une assistante de direction (Legal en écriture, aucun siège) : un
 * Super Admin rendrait vraies les gardes de siège quoi qu'il arrive (§118.104). La prémisse est
 * assertée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Tout BC passe par un centre de validation — le flux réel", () => {
  let legalId = "", saId = "", gmId = "", dirId = "", delegueId = "", contactId = "", eventId = "";
  const docs: string[] = [];

  const creerBC = async (suffix: string, extra: Record<string, string> = {}) => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: "100000", ...extra,
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    return r;
  };
  const validationsDe = (docId: string, status?: string) => prisma.validationRequest.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_BC, ...(status ? { status: status as never } : {}) },
    include: { steps: { include: { validator: { select: { role: true } } } } },
  });
  const approuverValidation = async (docId: string) => {
    const [v] = await validationsDe(docId, "PENDING");
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await decideValidation(form({ stepId: v.steps[0].id, decision: "APPROVED" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
  };

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    legalId = (await mk("legal", "DIRECTION_ASSISTANT")).id;
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    gmId = (await mk("gm", "GENERAL_MANAGER")).id;
    dirId = (await mk("dir", "DIRECTION")).id;
    delegueId = (await mk("delegue", "MEDICAL_DELEGATE")).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
    eventId = (await prisma.event.create({
      data: { name: `${TAG} Journée`, requesterId: delegueId, startDate: new Date("2026-11-02") },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: docs } }, select: { id: true } });
    const oIds = ordres.map((o) => o.id);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: oIds } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: oIds } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: oIds } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { userId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSE : l'acteur écrit dans Legal et ne siège à AUCUN centre", async () => {
    const a = await actorFor(legalId, "DIRECTION_ASSISTANT");
    expect(userCan(a, "LEGAL", "CREATE")).toBe(true);
    expect(["SUPER_ADMIN", "GENERAL_MANAGER"]).not.toContain(a.role);
  });

  it("un BC SANS origine va au CENTRE DE VALIDATIONS — une demande adressée à un siège, rien au centre Ad & Pro", async () => {
    const r = await creerBC("NORMAL");
    expect(r.message).toMatch(/centre de validations/);
    const v = await validationsDe(r.id!, "PENDING");
    expect(v).toHaveLength(1);
    expect(["GENERAL_MANAGER", "SUPER_ADMIN"]).toContain(v[0].steps[0].validator.role);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } })).toBe(0);
    expect(await porteDuBC(r.id!)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
  });

  /**
   * LE VALIDATEUR EST LE SIÈGE STABLE, JAMAIS UN COMPTE DE BANC (§118.148). Ce banc crée lui-même un
   * Directeur Général (`gmId`) ; douze autres fichiers aussi. Sans le siège posé par
   * `vitest.global-setup.ts` — plus ancien que tout compte —, c'est l'un d'eux que la règle
   * (« le plus ancien DG actif ») désignait pour les BC de TOUS les bancs, et son banc ne pouvait
   * plus le supprimer. La seconde assertion garde la déclaration elle-même : la ligne du siège
   * survit d'un run à l'autre, donc seule la configuration dit s'il sera encore posé demain.
   */
  it("le validateur d'un BC est le siège stable du banc — pas le DG que ce banc vient de créer", async () => {
    const siege = await prisma.user.findUniqueOrThrow({ where: { email: "siege-dg@banc-de-tests.local" }, select: { id: true, role: true } });
    expect(siege.role).toBe("GENERAL_MANAGER");
    const [v] = await validationsDe(docs[0], "PENDING");
    expect(v.steps[0].validatorId).toBe(siege.id);
    expect(v.steps[0].validatorId).not.toBe(gmId);
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*"\.\/vitest\.global-setup\.ts"\s*\]/);
  });

  it("un BC né d'une fiche Ad & Pro va au CENTRE AD & PRO — un visa SANS seuil, et la lentille le montre", async () => {
    const r = await creerBC("ADPRO", { sourceType: "EVENT", sourceId: eventId });
    expect(r.message).toMatch(/centre de validation Ad & Pro/);
    const visa = await prisma.adProGateVisa.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } } });
    expect(visa.status).toBe("PENDING");
    expect(visa.threshold, "un BC passe au centre QUEL QUE SOIT son montant").toBeNull();
    expect(await validationsDe(r.id!)).toHaveLength(0);
    const lignes = await demandesAuCentreAdPro();
    expect(lignes.find((l) => l.entityId === r.id)?.forme).toBe("BC_LEGAL");
  });

  it("réaiguiller ne pose JAMAIS une seconde porte — l'aiguillage est idempotent", async () => {
    const [normal, adpro] = docs;
    await aiguillerBC(normal, { acteurId: legalId });
    await aiguillerBC(adpro, { acteurId: legalId });
    expect(await validationsDe(normal, "PENDING")).toHaveLength(1);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: adpro } })).toBe(1);
  });

  it("le centre Ad & Pro : la Direction (sans siège) est REFUSÉE, le Directeur Général VALIDE", async () => {
    const adpro = docs[1];
    ACTOR = await actorFor(dirId, "DIRECTION");
    const refus = await deciderVisaCentreAdPro(form({ entityType: "LEGAL_DOCUMENT", entityId: adpro, approve: "1" }));
    expect(refus.ok).toBe(false);
    ACTOR = await actorFor(gmId, "GENERAL_MANAGER");
    expect((await deciderVisaCentreAdPro(form({ entityType: "LEGAL_DOCUMENT", entityId: adpro, approve: "1" }))).ok).toBe(true);
    expect(await porteDuBC(adpro)).toMatchObject({ centre: "AD_PRO", etat: "VALIDE" });
  });

  it("RATTACHÉ après coup à une fiche Ad & Pro : la porte en attente est TRANSFÉRÉE, pas doublée", async () => {
    const r = await creerBC("TRANSFERT");
    expect(await porteDuBC(r.id!)).toMatchObject({ centre: "VALIDATION" });
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const lien = await rattacherLegalAFiche(undefined, form({ legalId: r.id!, entityType: "EVENT", entityId: eventId }));
    expect(lien.ok, lien.ok === false ? lien.error : "").toBe(true);
    expect(await validationsDe(r.id!, "PENDING"), "la demande au mauvais centre est retirée").toHaveLength(0);
    expect(await porteDuBC(r.id!)).toMatchObject({ centre: "AD_PRO", etat: "EN_ATTENTE" });
  });

  it("VALIDÉ puis BAISSÉ : rien ne rouvre ; VALIDÉ puis RELEVÉ : le BC retourne au centre", async () => {
    const r = await creerBC("RELEVE");
    await approuverValidation(r.id!);
    expect(await porteDuBC(r.id!)).toMatchObject({ etat: "VALIDE" });

    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const base = { id: r.id!, title: `${TAG} RELEVE`, kind: "PURCHASE_ORDER", counterpartyIds: contactId };
    expect((await updateLegalDocument(form({ ...base, amount: "80000" }))).ok).toBe(true);
    expect(await porteDuBC(r.id!), "un geste qui RÉDUIT ne rouvre rien").toMatchObject({ etat: "VALIDE" });

    const hausse = await updateLegalDocument(form({ ...base, amount: "150000" }));
    expect(hausse.ok).toBe(true);
    expect(hausse.message).toMatch(/renvoyé au/);
    expect(await porteDuBC(r.id!)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
  });

  it("la FACTURE qui découle d'un BC en attente ne part pas au règlement ; BC validé, elle part — au centre de paiement", async () => {
    const bc = await creerBC("CHAINE");
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const f = await createLegalDocument(undefined, form({
      title: `${TAG} Facture imprimeur`, kind: "INVOICE", counterpartyIds: contactId, amount: "100000", chainFromId: bc.id!,
    }));
    expect(f.ok, f.ok === false ? f.error : "").toBe(true);
    docs.push(f.id!);

    const bloque = await sendLegalInvoiceToSettlement(form({ id: f.id! }));
    expect(bloque.ok).toBe(false);
    expect(bloque.ok === false ? bloque.error : "").toContain(`${TAG}CHAINE`);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: f.id! } }), "rien n'est parti").toBe(0);

    await approuverValidation(bc.id!);
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const part = await sendLegalInvoiceToSettlement(form({ id: f.id! }));
    expect(part.ok, part.ok === false ? part.error : "").toBe(true);
    const ordre = await prisma.expenseOrder.findFirstOrThrow({ where: { sourceType: "LEGAL_DOCUMENT", sourceId: f.id! } });
    expect(ordre.centralStatus, "et le paiement passe par le centre de paiement").toBe("AWAITING");
  });

  it("ANNULER un BC retire sa validation en attente — il n'a plus rien à faire valider", async () => {
    const r = await creerBC("ANNULE");
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    expect((await cancelLegalDocument(form({ id: r.id!, reason: "Doublon" }))).ok).toBe(true);
    expect(await validationsDe(r.id!, "PENDING")).toHaveLength(0);
    expect(await porteDuBC(r.id!)).toBeNull();
  });

  it("SUPPRIMER un BC retire sa porte Ad & Pro en attente — pas d'arbitrage à rendre sur rien", async () => {
    const r = await creerBC("SUPPRIME", { sourceType: "EVENT", sourceId: eventId });
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    expect((await deleteLegalDocument(form({ id: r.id! }))).ok).toBe(true);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } })).toBe(0);
  });

  it("un BC d'AVANT la règle : « Adresser au centre » le rattrape, et un second clic ne renvoie rien", async () => {
    // Le décor EST l'absence de porte : une pièce écrite hors de tout écrivain d'aujourd'hui.
    const ancien = await prisma.legalDocument.create({
      data: { title: `${TAG} ancien BC`, reference: `${TAG}ANCIEN`, kind: "PURCHASE_ORDER", amount: 50000, createdById: legalId },
      select: { id: true },
    });
    docs.push(ancien.id);
    expect(await porteDuBC(ancien.id)).toBeNull();

    ACTOR = await actorFor(delegueId, "MEDICAL_DELEGATE");
    expect((await adresserBCAuCentre(form({ id: ancien.id }))).ok, "sans droit d'écriture Legal : refusé").toBe(false);

    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r1 = await adresserBCAuCentre(form({ id: ancien.id }));
    expect(r1.ok, r1.ok === false ? r1.error : "").toBe(true);
    expect(await porteDuBC(ancien.id)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
    const r2 = await adresserBCAuCentre(form({ id: ancien.id }));
    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/déjà au/);
    expect(await validationsDe(ancien.id, "PENDING")).toHaveLength(1);
  });

  /**
   * UN AIGUILLAGE QUI ÉCHOUE SE DIT (§118.148). Le décor est une panne RÉELLE, pas un espion : le
   * compte qui agit n'existe plus, la demande de validation ne peut pas le porter comme demandeur,
   * et Postgres refuse la clé étrangère. Avant, `aiguillerBC` rendait alors `porte: null, geste:
   * null` — exactement ce qu'il rend pour « ce n'est pas un BC » — et la phrase de l'appelant se
   * taisait : la pièce avait l'air en règle. Le cas qui ferait tomber ce test est celui-là.
   */
  it("un aiguillage qui ÉCHOUE rend `enEchec` et une phrase qui le dit — jamais le silence de « pas un BC »", async () => {
    const orphelin = await prisma.legalDocument.create({
      data: { title: `${TAG} BC sans auteur`, reference: `${TAG}ORPHELIN`, kind: "PURCHASE_ORDER", amount: 42000, createdById: null },
      select: { id: true },
    });
    docs.push(orphelin.id);
    const r = await aiguillerBC(orphelin.id, { acteurId: `${TAG}compte-disparu` });
    expect(r.enEchec).toBe(true);
    expect(r.porte).toBeNull();
    expect(reserveSansPorte(r)).toMatch(/erreur technique/);
    expect(reserveSansPorte(r)).toMatch(/Adresser au centre/);
    // Rien de posé à moitié : ni demande, ni visa.
    expect(await validationsDe(orphelin.id)).toHaveLength(0);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: orphelin.id } })).toBe(0);

    // Et le rattrapage que la phrase promet MARCHE dès que la cause disparaît.
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r2 = await adresserBCAuCentre(form({ id: orphelin.id }));
    expect(r2.ok, r2.ok === false ? r2.error : "").toBe(true);
    expect(await validationsDe(orphelin.id, "PENDING")).toHaveLength(1);
  });

  it("un CONTRAT n'est pas un BC : aucune porte, et le geste le dit", async () => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const c = await createLegalDocument(undefined, form({ title: `${TAG} Contrat`, kind: "CONTRACT", counterpartyIds: contactId }));
    expect(c.ok).toBe(true);
    docs.push(c.id!);
    expect(await porteDuBC(c.id!)).toBeNull();
    expect(await validationsDe(c.id!)).toHaveLength(0);
    const r = await adresserBCAuCentre(form({ id: c.id! }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toMatch(/Seul un bon de commande/);
  });

  it("la partie donnée par son NOM (chemin d'Adam) est résolue contre l'annuaire, jamais écrite telle quelle", async () => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const ok = await createLegalDocument(undefined, form({ title: `${TAG} BC par nom`, kind: "PURCHASE_ORDER", counterpartyName: `${TAG} Imprimerie`, amount: "1000" }));
    expect(ok.ok, ok.ok === false ? ok.error : "").toBe(true);
    docs.push(ok.id!);
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ok.id! }, select: { counterpartyIds: true } });
    expect(d.counterpartyIds).toEqual([contactId]);

    const inconnu = await createLegalDocument(undefined, form({ title: `${TAG} BC inconnu`, kind: "PURCHASE_ORDER", counterpartyName: `${TAG} Fournisseur imaginaire`, amount: "1000" }));
    expect(inconnu.ok).toBe(false);
    expect(inconnu.ok === false ? inconnu.error : "").toMatch(/annuaire/);
  });
});
