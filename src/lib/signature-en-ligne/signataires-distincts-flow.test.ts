import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { retirerComptesPerimes } from "@/lib/actions/internes/bancs-concurrents";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { signerBonDeCommande, signerBonDeCommandeEnLigne } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { OBJET_BC } from "@/lib/bons-de-commande/aiguillage";
import { etatMarketingDesBC, refusSecondeSignature, sousVerrouDesSignataires } from "./signer-bc";
import { refusDejaSigneAutreQualite } from "./signataires-distincts";
import type { Qualite } from "./placement";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__sigdist__";
const TAG = `${PREFIXE}${Date.now().toString(36)}_`;

type Compte = { id: string; role: SessionUser["role"] };

async function actorFor(c: Compte): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
  const access = await getAccess(c.id, u.role);
  return { id: c.id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEUX SIGNATURES, DEUX PERSONNES — par la base et les vrais points d'entrée (Super Admin, 24/11/2026).
 *
 * Un BC porte la signature de la Direction Marketing puis celle des Finances : la même personne ne
 * signe pas les deux, sauf le Super Admin (suppléance). La place de la Direction Marketing est posée
 * par la MÊME écriture gardée que `apposerSignatureEnLigne` (`sousVerrouDesSignataires`) — l'incrustation
 * du PDF, éprouvée ailleurs, n'a rien à dire ici. La place des Finances passe par les actions réelles :
 * la copie signée sur papier (`signerBonDeCommande`) et la signature en ligne (`signerBonDeCommandeEnLigne`).
 * Le signataire qui cumule est une Direction Marketing avec, en « autre rôle », le droit de signer les BC :
 * une garde éprouvée avec un Super Admin ne pourrait pas tomber.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Bon de commande — deux signatures, deux personnes (flux réel)", () => {
  let legal: Compte, fin: Compte, cumul: Compte, sa: Compte, saSecondaire: Compte;
  let contactId = "";
  let base = 0;
  const docs: string[] = [];

  /** Un BC qui arrive « à signer » par le chemin normal : enregistré, validé par son centre. */
  const bcASigner = async (suffix: string) => {
    ACTOR = await actorFor(legal);
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: String(base),
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    const demandes = await prisma.validationRequest.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: r.id!, objectType: OBJET_BC, status: "PENDING" }, include: { steps: true },
    });
    ACTOR = await actorFor(sa);
    for (const e of demandes.flatMap((v) => v.steps.filter((s) => s.status === "PENDING"))) {
      const d = await decideValidation(form({ stepId: e.id, decision: "APPROVED" }));
      expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    }
    expect((await etatDuBC(r.id!))?.etape, "PRÉMISSE : le BC arrive à la signature par le chemin normal").toBe("A_SIGNER");
    return r.id!;
  };

  /** Une place signée en ligne, par l'écriture gardée de l'apposition. Rend le refus, ou `null`. */
  const signerEnLigne = async (bcId: string, qualite: Qualite, c: Compte): Promise<string | null> => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: c.id }, select: { name: true, role: true, secondaryRole: true } });
    const r = await sousVerrouDesSignataires(bcId, qualite, { id: c.id, role: u.role, secondaryRole: u.secondaryRole }, (tx) =>
      tx.signatureBC.create({
        data: { legalDocumentId: bcId, qualite, userId: c.id, signataireNom: u.name, methode: "EN_LIGNE", jeton: randomBytes(18).toString("base64url") },
        select: { id: true },
      }));
    return "refus" in r ? r.refus : null;
  };
  const copiePapier = async (bcId: string, c: Compte) => {
    ACTOR = await actorFor(c);
    return signerBonDeCommande(avecCopieSignee(form({ id: bcId })));
  };
  const signePar = async (bcId: string) => (await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { signedById: true } })).signedById;

  beforeAll(async () => {
    const seuil = (await getAppSettings()).bcValidationThreshold;
    base = Math.max(0, Number(seuil) || 0) + 100_000;
    const mk = async (n: string, role: SessionUser["role"], secondaryRole: SessionUser["role"] | null = null): Promise<Compte> => {
      const u = await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, secondaryRole, passwordHash: "x" } });
      return { id: u.id, role };
    };
    legal = await mk("legal", "DIRECTION_ASSISTANT");
    fin = await mk("finance", "FINANCE_BUDGET_MANAGER");
    cumul = await mk("cumul", "PRODUCT_MANAGER", "FINANCE_BUDGET_MANAGER");
    sa = await mk("sa", "SUPER_ADMIN");
    saSecondaire = await mk("sa2", "PRODUCT_MANAGER", "SUPER_ADMIN");
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Agence`, companyId: null } })).id;
  });

  afterAll(async () => {
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: docs } } }).catch(() => {});
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
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    await retirerComptesPerimes(PREFIXE);
  });

  it("PRÉMISSE : la personne qui cumule a bien le droit de signer les BC, sans être Super Admin", async () => {
    const a = await actorFor(cumul);
    expect(a.role).toBe("PRODUCT_MANAGER");
    expect(a.secondaryRole).toBe("FINANCE_BUDGET_MANAGER");
    expect(userCan(a, "PURCHASE_ORDERS", "UPDATE")).toBe(true);
  });

  it("VOIE PAPIER : la Direction Marketing a signé, elle n'enregistre pas la copie des Finances ; une autre personne si", async () => {
    const bc = await bcASigner("papier");
    expect(await signerEnLigne(bc, "DIRECTION_MARKETING", cumul)).toBeNull();
    const refus = await copiePapier(bc, cumul);
    expect(refus.ok).toBe(false);
    expect(refus.error).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(await signePar(bc), "rien n'est écrit").toBeNull();
    const ok = await copiePapier(bc, fin);
    expect(ok.ok, ok.error).toBe(true);
    expect(await signePar(bc)).toBe(fin.id);
  });

  it("EN LIGNE : refusé avant le code ; et l'écriture gardée refuse la même personne, accepte une autre", async () => {
    const bc = await bcASigner("enligne");
    expect(await signerEnLigne(bc, "DIRECTION_MARKETING", cumul)).toBeNull();
    ACTOR = await actorFor(cumul);
    // Ni mot de passe ni code : la règle répond avant le contrôle renforcé — aucun code à usage unique n'est consommé.
    const r = await signerBonDeCommandeEnLigne(form({ id: bc, lu: "oui" }));
    expect(r.error).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(await signerEnLigne(bc, "FINANCES", cumul)).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc, qualite: "FINANCES" } }), "rien n'est posé").toBe(0);
    expect(await signerEnLigne(bc, "FINANCES", fin)).toBeNull();
    expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc } })).toBe(2);
  });

  it("L'ÉCRAN : la file dit le refus à la personne qui a signé pour la Direction Marketing, à elle seule", async () => {
    const bc = await bcASigner("ecran");
    expect(await signerEnLigne(bc, "DIRECTION_MARKETING", cumul)).toBeNull();
    const pour = async (c: Compte) => {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: c.id }, select: { role: true, secondaryRole: true } });
      return { id: c.id, role: u.role, secondaryRole: u.secondaryRole };
    };
    expect((await etatMarketingDesBC([bc], await pour(cumul)))[bc]?.refus).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect((await etatMarketingDesBC([bc], await pour(fin)))[bc]?.refus).toBeNull();
    expect(await refusSecondeSignature(bc, "FINANCES", await pour(cumul))).toBe(refusDejaSigneAutreQualite("FINANCES"));
    expect(await refusSecondeSignature(bc, "FINANCES", await pour(fin))).toBeNull();
  });

  it("DANS L'AUTRE SENS : qui a enregistré la copie signée des Finances ne signe pas pour la Direction Marketing", async () => {
    const bc = await bcASigner("inverse");
    const p = await copiePapier(bc, cumul);
    expect(p.ok, p.error).toBe(true);
    expect(await signerEnLigne(bc, "DIRECTION_MARKETING", cumul)).toBe(refusDejaSigneAutreQualite("DIRECTION_MARKETING"));
    expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc } })).toBe(0);
  });

  it("LE SUPER ADMIN tient les deux places — rôle principal (papier) comme « autre rôle » (en ligne)", async () => {
    const bc1 = await bcASigner("sa-papier");
    expect(await signerEnLigne(bc1, "DIRECTION_MARKETING", sa)).toBeNull();
    const p = await copiePapier(bc1, sa);
    expect(p.ok, p.error).toBe(true);
    expect(await signePar(bc1)).toBe(sa.id);

    const bc2 = await bcASigner("sa-enligne");
    expect(await signerEnLigne(bc2, "DIRECTION_MARKETING", saSecondaire)).toBeNull();
    expect(await signerEnLigne(bc2, "FINANCES", saSecondaire)).toBeNull();
    expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc2, userId: saSecondaire.id } })).toBe(2);
  });

  it("LA COURSE : la même personne signe les deux places au même instant — une seule passe", async () => {
    const bc = await bcASigner("course");
    for (let i = 0; i < 3; i++) {
      await prisma.signatureBC.deleteMany({ where: { legalDocumentId: bc } });
      const [a, b] = await Promise.all([signerEnLigne(bc, "DIRECTION_MARKETING", cumul), signerEnLigne(bc, "FINANCES", cumul)]);
      expect([a, b].filter((x) => x === null), "exactement une signature posée").toHaveLength(1);
      expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc } })).toBe(1);
    }
  });
});
