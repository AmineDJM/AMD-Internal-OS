import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités » de la personne.
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { compositionDesPieces } from "@/lib/queries/composition-pieces";
import { AMONT_HORS_PERIMETRE, piecesAmontProposees } from "@/lib/queries/legal-chain";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { centreVouluDuBC, origineDuBC } from "@/lib/bons-de-commande/aiguillage";
import { avalActif } from "@/lib/legal/aval";
import { PIECE_AMONT_INTROUVABLE, phrasePieceAmontNonRattachee } from "@/lib/legal/piece-emise";
import { emettreAvoir, emettrePieceCommerciale, previsualiserPieceCommerciale } from "./fabrique-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE COMPOSÉE SUIT SA PIÈCE AMONT — par les VRAIS points d'entrée (audit 360°, lot D1c — F1).
 *
 * Mesuré : le compositeur n'envoyait jamais `chainFromId`. Un bon de commande composé depuis un devis
 * né d'un sponsoring partait au centre de validations NORMAL (son origine se lit sur le devis), et le
 * devis restait révisable sous lui. La fabrique, de son côté, ne vérifiait de la pièce amont que son
 * existence et sa société : un BC pouvait « suivre » une facture, un devis annulé, ou — par un
 * identifiant forgé — un devis que la personne ne lit pas.
 *
 * Joué par le Directeur Général (Legal en gestion, HORS de la vue globale — §118.104) et par les
 * Finances, qui ne lisent pas les devis : le chargeur de l'écran, l'aperçu, l'émission, l'avoir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__cpamont__";
const ANNEE = new Date().getUTCFullYear();
const T0 = new Date();
let sa: CurrentUser;
let dg: CurrentUser;
let fin: CurrentUser;
let C1 = "", C2 = "";
const p: Record<string, string> = {};

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
}

/** Le formulaire du compositeur (`construireFormData`), tel que l'écran l'envoie. */
function formulaire(type: "BON_DE_COMMANDE" | "FACTURE" | "DEVIS", tiers: string, chainFromId?: string): FormData {
  const fd = new FormData();
  fd.set("type", type);
  fd.set("societe", C1);
  fd.set("tiersNom", `${TAG} ${tiers}`);
  fd.set("tiersAdresse", "Alger");
  fd.set("tiersNif", "000016098765432");
  fd.set("date", `${ANNEE}-09-05`);
  if (type === "FACTURE") fd.set("echeance", `${ANNEE}-10-05`);
  fd.set("modePaiement", "VIREMENT");
  fd.set("tvaDefaut", "19");
  for (const [designation, quantite, prix] of [["Fiches posologiques — impression quadri", "100", "250"], ["Kakémonos 80 × 200", "2", "9000"]]) {
    fd.append("ligneDesignation", designation);
    fd.append("ligneDetails", "");
    fd.append("ligneQuantite", quantite);
    fd.append("lignePrix", prix);
    fd.append("ligneRemise", "");
    fd.append("ligneTva", "");
    fd.append("ligneSection", "0");
  }
  if (chainFromId) fd.set("chainFromId", chainFromId);
  return fd;
}

const sequence = async (kind: "PURCHASE_ORDER" | "INVOICE") =>
  (await prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId: C1, kind, year: ANNEE } }, select: { last: true } }))?.last ?? 0;
const bcsDe = (tiers: string) => prisma.legalDocument.count({ where: { companyId: C1, kind: "PURCHASE_ORDER", counterparty: `${TAG} ${tiers}` } });

suite("Legal — une pièce composée suit sa pièce amont : proposée par la porte de la liste, jugée par la fabrique", () => {
  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG} ${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [s1, d1, f1] = await Promise.all([mk("pdg", "SUPER_ADMIN"), mk("dg", "GENERAL_MANAGER"), mk("fin", "FINANCE_BUDGET_MANAGER")]);
    [C1, C2] = (await Promise.all(["Pharma", "Distrib"].map((n) => prisma.company.create({ data: { name: `${TAG} ${n}`, color: "#1B7F79" } })))).map((c) => c.id);
    await Promise.all([
      prisma.companyLegalIdentity.create({
        data: {
          companyId: C1, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Gérance", managerTitle: "Gérant",
        },
      }),
      // Le DG engage C1 et LIT C2 ; les Finances engagent C1.
      prisma.userCompanyAccess.create({ data: { userId: d1.id, companyId: C1, canEdit: true } }),
      prisma.userCompanyAccess.create({ data: { userId: d1.id, companyId: C2, canEdit: false } }),
      prisma.userCompanyAccess.create({ data: { userId: f1.id, companyId: C1, canEdit: true } }),
    ]);
    [sa, dg, fin] = await Promise.all([acteur(s1.id, "SUPER_ADMIN"), acteur(d1.id, "GENERAL_MANAGER"), acteur(f1.id, "FINANCE_BUDGET_MANAGER")]);
    const piece = (k: string, data: Record<string, unknown>) =>
      prisma.legalDocument.create({ data: { title: `${TAG} ${k}`, reference: `${TAG}-${k}`, companyId: C1, ...data } as never, select: { id: true } });
    const crees = await Promise.all([
      // Un devis NÉ D'UN SPONSORING : c'est par lui que le BC qui le suit retrouve sa demande.
      piece("DV-ADPRO", { kind: "QUOTE", status: "ACTIVE", sourceType: "SPONSORING", sourceId: `${TAG}sponsoring`, counterparty: "Imprimerie A" }),
      piece("DV-ANNULE", { kind: "QUOTE", status: "CANCELLED" }),
      // Restreint à ses lecteurs désignés — le DG n'en est pas.
      piece("DV-RESTREINT", { kind: "QUOTE", status: "ACTIVE", createdById: s1.id, readers: { create: { userId: s1.id } } }),
      piece("DV-C2", { kind: "QUOTE", status: "ACTIVE", companyId: C2 }),
      piece("FA-C1", { kind: "INVOICE", status: "ACTIVE" }),
    ]);
    ["devisAdPro", "devisAnnule", "devisRestreint", "devisC2", "facture"].forEach((k, i) => { p[k] = crees[i].id; });
  }, 60_000);

  afterAll(async () => {
    const pieces = await prisma.legalDocument.findMany({ where: { companyId: { in: [C1, C2] } }, select: { id: true } }).catch(() => []);
    const ids = pieces.map((x) => x.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } } }).catch(() => {});
    // Bornées par la date : un filtre sur le seul lien parcourrait toute la table (§118.175).
    for (const id of ids) await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, link: { contains: id } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: { in: [C1, C2] } } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId: { in: [C1, C2] } } }).catch(() => {});
    const comptes = [sa?.id, dg?.id, fin?.id].filter(Boolean) as string[];
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: comptes } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId: { in: [C1, C2] } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: [C1, C2] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [C1, C2] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  it("PRÉMISSE : le DG compose les pièces de Legal sans vue globale ; les Finances composent factures et BC sans lire les devis", () => {
    expect(userCan(dg, "LEGAL", "CREATE")).toBe(true);
    expect(hasGlobalView(dg.role)).toBe(false);
    expect(userCan(fin, "FINANCES", "CREATE")).toBe(true);
    expect(userCan(fin, "LEGAL", "VIEW")).toBe(false);
  });

  it("LE COMPOSITEUR PROPOSE le devis lisible — ni l'annulé, ni le restreint — et NOMME aux Finances la nature qui leur est fermée", async () => {
    const pourDg = await compositionDesPieces(dg);
    const ids = new Set(pourDg!.amont.options.map((o) => o.value));
    expect(ids.has(p.devisAdPro)).toBe(true);
    expect(ids.has(p.devisC2), "une société que le DG lit : proposée, et le menu la filtre par la société émettrice").toBe(true);
    expect(ids.has(p.devisAnnule), "annulé").toBe(false);
    expect(ids.has(p.devisRestreint), "restreint à d'autres lecteurs").toBe(false);
    expect(ids.has(p.facture), "une facture ne précède pas une pièce composable").toBe(false);
    const opt = pourDg!.amont.options.find((o) => o.value === p.devisAdPro)!;
    expect(opt).toMatchObject({ kind: "QUOTE", companyId: C1 });
    expect(opt.label).toContain(`${TAG}-DV-ADPRO`);
    expect(pourDg!.amont.fermees).toEqual([]);

    const pourFin = await compositionDesPieces(fin);
    expect(pourFin!.amont.options.some((o) => o.kind === "QUOTE")).toBe(false);
    expect(pourFin!.amont.fermees).toEqual(["QUOTE"]);
  });

  it("LE BC CHAÎNÉ À SON DEVIS SUIT SA DEMANDE — centre Ad & Pro, devis figé ; le témoin non chaîné part au centre de validations", async () => {
    ACTOR = dg;
    const r = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie A", p.devisAdPro));
    expect(r.ok, r.error).toBe(true);
    const bc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.legalDocumentId! }, select: { chainFromId: true, sourceType: true, sourceId: true } });
    expect(bc.chainFromId).toBe(p.devisAdPro);
    expect(await centreVouluDuBC(await origineDuBC(bc))).toBe("AD_PRO");
    expect(await avalActif(p.devisAdPro, "DEVIS"), "le devis dont découle un BC ne se révise plus").not.toBeNull();

    const temoin = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie B"));
    expect(temoin.ok, temoin.error).toBe(true);
    const bcT = await prisma.legalDocument.findUniqueOrThrow({ where: { id: temoin.legalDocumentId! }, select: { chainFromId: true, sourceType: true, sourceId: true } });
    expect(bcT.chainFromId).toBeNull();
    expect(await centreVouluDuBC(await origineDuBC(bcT))).toBe("VALIDATION");
  }, 180_000);

  it("L'APERÇU REFUSE une pièce d'une autre nature, avant qu'un numéro existe — et l'émission aussi, sans consommer de numéro", async () => {
    ACTOR = dg;
    const avant = await sequence("PURCHASE_ORDER");
    const apercu = await previsualiserPieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie N", p.facture));
    expect(apercu.ok).toBe(true);
    if (!apercu.ok) return;
    expect(apercu.peutEmettre).toBe(false);
    expect(apercu.bloquants.join(" ")).toContain("Un bon de commande fait suite à un devis");
    const r = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie N", p.facture));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`la pièce « ${TAG}-FA-C1 » est une facture`);
    expect(await sequence("PURCHASE_ORDER")).toBe(avant);
    expect(await bcsDe("Imprimerie N")).toBe(0);
  }, 120_000);

  it("UNE PIÈCE ANNULÉE ne se suit pas", async () => {
    ACTOR = dg;
    const r = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie X", p.devisAnnule));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`La pièce « ${TAG}-DV-ANNULE » est annulée`);
    expect(await bcsDe("Imprimerie X")).toBe(0);
  }, 120_000);

  it("UN DEVIS RESTREINT n'est pas accepté — refusé avec la MÊME phrase qu'un identifiant qui n'existe pas", async () => {
    ACTOR = dg;
    const restreint = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie R", p.devisRestreint));
    const absent = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie R", `${TAG}inexistant`));
    expect(restreint).toEqual({ ok: false, error: PIECE_AMONT_INTROUVABLE });
    expect(absent).toEqual({ ok: false, error: PIECE_AMONT_INTROUVABLE });
    expect(await bcsDe("Imprimerie R")).toBe(0);
  }, 120_000);

  it("LA SOCIÉTÉ : la pièce amont d'une autre société, même lisible, est refusée", async () => {
    ACTOR = dg;
    const r = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie S", p.devisC2));
    expect(r).toEqual({ ok: false, error: "La pièce amont appartient à une autre société." });
  }, 120_000);

  it("LES FINANCES : un identifiant de devis forgé est refusé comme absent — elles ne lisent pas les devis", async () => {
    ACTOR = fin;
    const r = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie F", p.devisAdPro));
    expect(r).toEqual({ ok: false, error: PIECE_AMONT_INTROUVABLE });
    expect(await bcsDe("Imprimerie F")).toBe(0);
  }, 120_000);

  it("LA PIÈCE IDENTIQUE RENDUE dit la pièce amont qu'elle ne porte pas, avec le geste qui la rattache", async () => {
    ACTOR = dg;
    const premier = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie C"));
    expect(premier.ok, premier.error).toBe(true);
    const second = await emettrePieceCommerciale(undefined, formulaire("BON_DE_COMMANDE", "Imprimerie C", p.devisAdPro));
    expect(second.ok, second.error).toBe(true);
    expect(second.dejaEmis).toBe(true);
    expect(second.legalDocumentId).toBe(premier.legalDocumentId);
    expect(second.avertissements).toContain(phrasePieceAmontNonRattachee(premier.reference!, null, p.devisAdPro));
  }, 180_000);

  it("L'AVOIR sur une facture qu'on ne lit pas est refusé comme absent — la facture lisible reçoit le sien (témoin)", async () => {
    // Deux factures ÉMISES par la plateforme, par quelqu'un d'autre ; l'une est restreinte à ses lecteurs désignés.
    ACTOR = sa;
    const [restreinte, lisible] = [
      await emettrePieceCommerciale(undefined, formulaire("FACTURE", "Client R")),
      await emettrePieceCommerciale(undefined, formulaire("FACTURE", "Client L")),
    ];
    expect(restreinte.ok && lisible.ok, restreinte.error ?? lisible.error).toBe(true);
    await prisma.legalDocumentReader.create({ data: { documentId: restreinte.legalDocumentId!, userId: sa.id } });
    ACTOR = dg;
    const fd = (factureId: string) => {
      const f = new FormData();
      f.set("factureId", factureId);
      f.set("motif", "Retour de marchandise");
      f.append("ligneDesignation", "Fiches posologiques"); f.append("ligneDetails", ""); f.append("ligneQuantite", "1");
      f.append("lignePrix", "100"); f.append("ligneRemise", ""); f.append("ligneTva", ""); f.append("ligneSection", "0");
      return f;
    };
    const nAvoirs = () => prisma.legalDocument.count({ where: { companyId: C1, kind: "CREDIT_NOTE" } });
    const avant = await nAvoirs();
    expect(await emettreAvoir(undefined, fd(restreinte.legalDocumentId!))).toEqual({ ok: false, error: "La facture à créditer n'existe plus." });
    expect(await nAvoirs()).toBe(avant);
    const temoin = await emettreAvoir(undefined, fd(lisible.legalDocumentId!));
    expect(temoin.ok, temoin.error).toBe(true);
    expect(await nAvoirs()).toBe(avant + 1);
  }, 180_000);

  it("LA FICHE LEGAL : par la porte de la liste, le menu « Fait suite à » ne montre pas aux Finances le titre d'un devis — la pièce actuelle garde son libellé neutre", async () => {
    const menu = async (u: CurrentUser) => {
      const perimetre = await perimetreLegal(u);
      return piecesAmontProposees({ userId: u.id, readerScope: perimetre.where ?? { id: { in: [] } }, actuelId: p.devisAdPro });
    };
    const pourFin = await menu(fin);
    expect(pourFin.some((o) => o.label.includes(`${TAG} DV-`))).toBe(false);
    expect(pourFin.find((o) => o.value === p.devisAdPro)?.label).toBe(AMONT_HORS_PERIMETRE);
    const pourDg = await menu(dg);
    expect(pourDg.find((o) => o.value === p.devisAdPro)?.label).toContain(`${TAG} DV-ADPRO`);
  });
});
