import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/** Les seuils sont des réglages GLOBAUX que d'autres bancs font bouger : celui-ci injecte les siens (porte du DG haute). */
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 500_000, adProDgThreshold: 1_000_000 }) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { choisirAgencePoste, retenirLignesDesAgences } from "../actions-postes-agence";
import { valeurDeLigne } from "../domaine/choix-agences";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHOIX DES AGENCES LIGNE À LIGNE (Direction, 23/11/2026) — par le VRAI geste de la Direction Marketing.
 *
 *   • un devis, quelques lignes cochées → UN poste, accordé au total des seules lignes cochées, un brouillon de BC ;
 *   • deux devis cochés → le poste est SCINDÉ : chaque agence a son poste, son devis, ses lignes, son montant, son BC ;
 *     le devis sans ligne cochée n'est pas retenu ;
 *   • rien de coché → refusé, rien ne bouge ;
 *   • « Retenir cette agence » (un devis entier) passe par le même chemin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__choixlg${Date.now().toString(36)}__`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

interface LigneDeBanc { ref: string; q: number; p: number }

suite("Ad & Pro — la Direction Marketing retient des LIGNES de plusieurs devis (base réelle)", () => {
  const u = { kam: "", dm: "", ast: "" };
  let congres = "", catId = "", envId = "";
  const docs: string[] = [];

  /** Un poste « par une agence » dont les devis sont transmis : il attend le choix de la Direction Marketing. */
  async function posteATrancher(label: string): Promise<string> {
    const maintenant = new Date();
    const id = (await prisma.adProItem.create({
      data: {
        congressNationalId: congres, kind: "PRINTING", label: `${TAG}${label}`, voie: "AGENCE", conformiteRequise: true,
        status: "PENDING", submittedAt: maintenant, opsDecidedAt: maintenant, opsDecidedById: u.dm, createdById: u.kam,
      },
      select: { id: true },
    })).id;
    await prisma.adProExecutionPoste.create({
      data: {
        itemId: id, prospectionDemandeeAt: maintenant, prospectionDemandeeParId: u.dm, cahierDesCharges: `${TAG}2 000 brochures`,
        assistanteId: u.ast, devisTransmisAt: maintenant, devisTransmisParId: u.ast,
      },
    });
    return id;
  }
  /** Un devis d'agence déposé par l'assistante, ses lignes saisies (TVA 19 %) ; rend la pièce et ses lignes dans l'ordre. */
  async function devis(itemId: string, agence: string, lignes: LigneDeBanc[]): Promise<{ pieceId: string; lignes: string[] }> {
    const doc = await prisma.legalDocument.create({
      data: { title: `${TAG}Devis ${agence}`, kind: "QUOTE", counterparty: agence, sourceType: "CONGRESS_NATIONAL", sourceId: congres, createdById: u.ast },
      select: { id: true },
    });
    docs.push(doc.id);
    await prisma.adProItemPiece.create({ data: { itemId, legalDocumentId: doc.id, nature: "DEVIS", createdById: u.ast } });
    await prisma.adProDevis.create({
      data: {
        legalDocumentId: doc.id, tvaRate: 19, createdById: u.ast,
        lignes: { create: lignes.map((l, i) => ({ position: i, reference: `${TAG}${l.ref}`, quantity: l.q, unitPrice: l.p })) },
      },
    });
    const ids = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: doc.id } }, orderBy: { position: "asc" }, select: { id: true } });
    return { pieceId: doc.id, lignes: ids.map((l) => l.id) };
  }
  const formulaire = (id: string, cochees: [string, string][], extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("id", id);
    f.set("budgetCategoryId", catId);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    for (const [pieceId, ligneId] of cochees) f.append("ligne", valeurDeLigne(pieceId, ligneId));
    return f;
  };
  const validees = (pieceId: string) => prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: pieceId }, validatedItemId: { not: null } }, select: { id: true, validatedItemId: true } });
  const brouillonDe = async (pieceId: string) => ((await prisma.adProDevis.findUniqueOrThrow({ where: { legalDocumentId: pieceId } })).bcBrouillon as { itemId?: string } | null);
  const postesDuCongres = () => prisma.adProItem.findMany({ where: { congressNationalId: congres }, select: { id: true } });

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    u.kam = await mk("kam", "MEDICAL_DELEGATE");
    u.dm = await mk("dm", "PRODUCT_MANAGER");
    u.ast = await mk("ast", "DIRECTION_ASSISTANT");
    congres = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès d'Oran`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Imprimerie`, allocated: 50_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const postes = (await postesDuCongres().catch(() => [])).map((p) => p.id);
    const ids = Object.values(u).filter(Boolean);
    await prisma.bcBrouillonVersion.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: congres } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [congres, ...postes, ...docs] } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: congres } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { id: catId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("RIEN DE COCHÉ : refusé, la phrase dit quoi faire — le poste attend toujours le choix", async () => {
    const id = await posteATrancher("Rien");
    await devis(id, `${TAG}Alpha`, [{ ref: "Brochure", q: 100, p: 50 }]);
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const r = await retenirLignesDesAgences(formulaire(id, []));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Cochez au moins une ligne");
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id }, include: { execution: true } });
    expect(p.status).toBe("PENDING");
    expect(p.execution?.agenceRetenueAt).toBeNull();
  });

  it("SEULE LA DIRECTION MARKETING CHOISIT : l'assistante est refusée", async () => {
    const id = await posteATrancher("Assistante");
    const a = await devis(id, `${TAG}Alpha`, [{ ref: "Brochure", q: 100, p: 50 }]);
    ACTOR = await acteur(u.ast, "DIRECTION_ASSISTANT");
    const r = await retenirLignesDesAgences(formulaire(id, [[a.pieceId, a.lignes[0]!]]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Direction Marketing");
  });

  it("UN DEVIS, QUELQUES LIGNES : un seul poste, accordé au total des lignes cochées ; l'autre devis n'est pas retenu", async () => {
    const id = await posteATrancher("Stand");
    const alpha = await devis(id, `${TAG}Alpha`, [{ ref: "Comptoir", q: 1, p: 100_000 }, { ref: "Kakémono", q: 4, p: 10_000 }, { ref: "Moquette", q: 9, p: 5_000 }]);
    const beta = await devis(id, `${TAG}Beta`, [{ ref: "Stand complet", q: 1, p: 200_000 }]);
    const avant = (await postesDuCongres()).length;
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const r = await retenirLignesDesAgences(formulaire(id, [[alpha.pieceId, alpha.lignes[0]!], [alpha.pieceId, alpha.lignes[1]!]]));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toContain("Agence retenue");

    expect((await postesDuCongres()).length, "aucun poste ne naît pour une seule agence").toBe(avant);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id }, include: { execution: true } });
    expect(p.status).toBe("APPROVED");
    expect(Number(p.amountGranted), "140 000 HT des deux lignes cochées, TTC 19 %").toBe(166_600);
    expect(p.budgetCategoryId).toBe(catId);
    expect(p.supplier).toBe(`${TAG}Alpha`);
    expect(p.execution?.agenceDevisId).toBe(alpha.pieceId);
    expect(p.execution?.agenceRetenueAt).not.toBeNull();
    expect((await validees(alpha.pieceId)).map((l) => l.id).sort()).toEqual([alpha.lignes[0], alpha.lignes[1]].sort());
    expect(await validees(beta.pieceId)).toEqual([]);
    const lienBeta = await prisma.adProItemPiece.findUniqueOrThrow({ where: { itemId_legalDocumentId: { itemId: id, legalDocumentId: beta.pieceId } } });
    expect(lienBeta.nonRetenuAt, "le devis sans ligne cochée n'est pas retenu").not.toBeNull();
    expect((await brouillonDe(alpha.pieceId))?.itemId, "le BC de l'agence naît en brouillon").toBe(id);
    expect(await brouillonDe(beta.pieceId)).toBeNull();
  });

  it("DEUX DEVIS COCHÉS : le poste est scindé — chaque agence a son poste, son devis, ses lignes, son montant et son BC", async () => {
    const id = await posteATrancher("Impression");
    const alpha = await devis(id, `${TAG}Alpha`, [{ ref: "Affiches", q: 10, p: 1_000 }, { ref: "Flyers", q: 1_000, p: 10 }]);
    const beta = await devis(id, `${TAG}Beta`, [{ ref: "Brochures", q: 2_000, p: 100 }, { ref: "Pochettes", q: 500, p: 40 }]);
    const gamma = await devis(id, `${TAG}Gamma`, [{ ref: "Tout compris", q: 1, p: 300_000 }]);
    const avant = (await postesDuCongres()).length;
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const r = await retenirLignesDesAgences(formulaire(id, [
      [alpha.pieceId, alpha.lignes[0]!],
      [beta.pieceId, beta.lignes[0]!], [beta.pieceId, beta.lignes[1]!],
    ]));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toContain("Poste scindé en 2 postes");

    const postes = await postesDuCongres();
    expect(postes.length, "un poste de plus : celui de la seconde agence").toBe(avant + 1);
    // L'ORIGINE GARDE L'AGENCE AU PLUS GROS TOTAL (Beta : 220 000 HT).
    const origine = await prisma.adProItem.findUniqueOrThrow({ where: { id }, include: { execution: true } });
    expect(origine.status).toBe("APPROVED");
    expect(Number(origine.amountGranted)).toBe(261_800);
    expect(origine.execution?.agenceDevisId).toBe(beta.pieceId);
    expect((await validees(beta.pieceId)).every((l) => l.validatedItemId === id)).toBe(true);
    expect((await validees(beta.pieceId)).length).toBe(2);
    expect((await brouillonDe(beta.pieceId))?.itemId).toBe(id);
    // LE DEVIS SANS LIGNE COCHÉE reste sur l'origine, « non retenu », sans ligne validée.
    const lienGamma = await prisma.adProItemPiece.findUniqueOrThrow({ where: { itemId_legalDocumentId: { itemId: id, legalDocumentId: gamma.pieceId } } });
    expect(lienGamma.nonRetenuAt).not.toBeNull();
    expect(await validees(gamma.pieceId)).toEqual([]);

    // LE POSTE NÉ : « <libellé> — Alpha », avec le devis d'Alpha, sa seule ligne cochée, son montant et son exécution recopiée.
    const lienAlpha = await prisma.adProItemPiece.findFirstOrThrow({ where: { legalDocumentId: alpha.pieceId, nature: "DEVIS" } });
    expect(lienAlpha.itemId).not.toBe(id);
    expect(lienAlpha.createdById, "le déposant du devis reste celui qui vérifie le BC").toBe(u.ast);
    const ne = await prisma.adProItem.findUniqueOrThrow({ where: { id: lienAlpha.itemId }, include: { execution: true } });
    expect(ne.label).toBe(`${TAG}Impression — ${TAG}Alpha`);
    expect(ne.congressNationalId).toBe(congres);
    expect(ne).toMatchObject({ kind: "PRINTING", voie: "AGENCE", conformiteRequise: true, status: "APPROVED", budgetCategoryId: catId, supplier: `${TAG}Alpha` });
    expect(Number(ne.amountGranted), "10 000 HT de la seule ligne cochée, TTC").toBe(11_900);
    expect(ne.execution).toMatchObject({ assistanteId: u.ast, cahierDesCharges: `${TAG}2 000 brochures`, agenceDevisId: alpha.pieceId });
    expect(ne.execution?.devisTransmisAt).not.toBeNull();
    expect(ne.execution?.agenceRetenueAt).not.toBeNull();
    expect((await validees(alpha.pieceId)).map((l) => [l.id, l.validatedItemId])).toEqual([[alpha.lignes[0], ne.id]]);
    expect((await brouillonDe(alpha.pieceId))?.itemId, "un BC par agence").toBe(ne.id);
    expect(await prisma.adProItemPiece.count({ where: { itemId: ne.id, nature: "DEVIS" } }), "le poste né ne porte que le devis de son agence").toBe(1);

    expect(await prisma.auditLog.count({ where: { entityId: congres, summary: { contains: "scindé par agence" } } })).toBe(1);
  });

  it("« RETENIR CETTE AGENCE » (un devis entier) passe par le même chemin : toutes ses lignes, un seul poste", async () => {
    const id = await posteATrancher("Traiteur");
    const alpha = await devis(id, `${TAG}Alpha`, [{ ref: "Pause café", q: 100, p: 500 }, { ref: "Déjeuner", q: 100, p: 1_500 }]);
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const f = new FormData();
    f.set("id", id); f.set("pieceId", alpha.pieceId); f.set("budgetCategoryId", catId);
    const r = await choisirAgencePoste(f);
    expect(r.ok, r.error).toBe(true);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id } });
    expect(Number(p.amountGranted)).toBe(238_000);
    expect((await validees(alpha.pieceId)).length).toBe(2);
  });
});
