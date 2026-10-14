import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import sharp from "sharp";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ».
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

// LE MODÈLE, SCRIPTÉ : il rend les lignes qu'on lui dit — ou un texte brut — et garde ce qu'on lui a envoyé.
const IA = { lignes: [] as unknown[], brut: null as string | null, prompts: [] as string[], appels: 0 };
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  aiConfigured: () => true,
  askClaude: async (prompt: string) => {
    IA.appels++;
    IA.prompts.push(prompt);
    return { ok: true, configured: true, text: IA.brut ?? JSON.stringify({ lines: IA.lignes }) };
  },
}));
// L'OCR, SCRIPTÉ : `canOcr` reste le vrai ; le moteur rend les pages qu'on lui dit, sur un document de N pages.
const OCR = { appels: 0, pages: [] as string[], total: 0, echoue: false };
vi.mock("@/lib/regulatory/intelligence/ocr/ocr-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/regulatory/intelligence/ocr/ocr-engine")>()),
  ocrDocument: async () => {
    OCR.appels++;
    if (OCR.echoue) throw new Error("moteur indisponible");
    return {
      engine: "tesseract.js (banc)", langs: "fra+eng", method: "ocr",
      pages: OCR.pages.map((text, i) => ({ page: i + 1, text, confidence: 78, chars: text.length, lowConfidence: false })),
      text: OCR.pages.join("\n"), meanConfidence: 78, pageCount: OCR.total, lowConfidencePages: 0,
      needsReview: OCR.pages.length < OCR.total, truncated: OCR.pages.length < OCR.total,
    };
  },
}));
// Le miroir Drive part en arrière-plan : il n'a rien à faire dans ce banc.
vi.mock("@/lib/drive/document-mirror", () => ({ mirrorDocumentsToDrive: async () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { deleteFileByKey } from "@/lib/storage";
import {
  addTenderLine, analyzeTenderDocument, analyzeTenderText, setTenderLineBusinessUnits, updateTenderLine,
} from "@/lib/actions/pch-tender-line-actions";
import { deleteTender } from "@/lib/actions/pch-actions";
import { restaurerLotDeLaCorbeille } from "@/lib/suppression/coeur";
import { lecturesDuMarche, LECTURES_AFFICHEES } from "@/lib/queries/pch";
import { REPONSE_INEXPLOITABLE, phraseCoupe, empreinteLigneExtraite } from "@/lib/pch/extraction";
import { makeScannedPdf, makeTextPdf } from "../../../scripts/bench/corpus-lib";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LE DOCUMENT D'UN APPEL D'OFFRES — par les VRAIS points d'entrée (audit 360°, lot D1c — F2).
 *
 * Mesuré : la lecture d'avant océrisait un PDF qui porte son texte (Mistral le facture page par page),
 * coupait le texte à 24 000 caractères sans le dire, jetait le fichier lu, et une seconde lecture
 * AJOUTAIT ses lignes — chaque relecture doublait le tableau, et rien ne distinguait une ligne lue
 * d'une ligne corrigée à la main.
 *
 * Joué par le gestionnaire logistique, qui GÈRE les marchés PCH, rattaché à UNE société et sans vue
 * globale (§118.104) ; le modèle et l'OCR sont scriptés (aucun appel ne part), le lecteur de texte natif
 * et l'écriture en base sont les vrais. Les courses sont FORCÉES (§118.164e) : la transaction du banc
 * tient un verrou, attend que les gestes soient bloqués dessus, écrit ce qu'il faut, puis relâche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__pchlec__";
const T0 = new Date();
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const lot = (nom: string, q = 1000) => ({ designation: `${TAG} ${nom}`, dci: "", dosage: "500 mg", form: "comprimé", quantityUnits: q, unitsPerBox: 0, unitLabel: "comprimé" });
const texteDe = (noms: string[]) => noms.map((n) => `${TAG} ${n} — 500 mg comprimé — 1000 unités`).join("\n");

function lireTexte(tenderId: string, texte: string, opts: { complementaire?: boolean } = {}) {
  return analyzeTenderText(fd({ tenderId, text: texte, ...(opts.complementaire ? { complementaire: "on" } : {}) }));
}
function lireFichier(tenderId: string, file: File, opts: { complementaire?: boolean; forcerOcr?: boolean } = {}) {
  const f = new FormData();
  f.set("tenderId", tenderId);
  f.set("file", file);
  if (opts.complementaire) f.set("complementaire", "on");
  if (opts.forcerOcr) f.set("forcerOcr", "on");
  return analyzeTenderDocument(f);
}
/** Un PDF qui PORTE son texte — plus de 300 caractères, le seuil du lecteur canonique. */
const pdfNatif = (nom: string, lignes: string[]) => new File([makeTextPdf([lignes])], nom, { type: "application/pdf" });

const lignesDe = (tenderId: string) => prisma.pchTenderLine.findMany({
  where: { tenderId }, orderBy: { sortOrder: "asc" },
  select: { id: true, designation: true, quantityUnits: true, extractionId: true, empreinteExtraction: true, modifieeLe: true, note: true, updatedAt: true },
});

/** Le formulaire qu'envoie l'écran à chaque sortie de champ (`tender-lines.tsx`, `save`). */
async function formulaireEcran(id: string, patch: Record<string, string> = {}): Promise<FormData> {
  const l = await prisma.pchTenderLine.findUniqueOrThrow({ where: { id } });
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const f = fd({
    id, tenderId: l.tenderId, designation: l.designation, dci: s(l.dci), dosage: s(l.dosage), form: s(l.form),
    quantityUnits: l.quantityUnits ? String(l.quantityUnits) : "", unitsPerBox: s(l.unitsPerBox), unitLabel: s(l.unitLabel),
    unitPriceDzd: s(l.unitPriceDzd), status: l.status, awardedUnitPriceDzd: s(l.awardedUnitPriceDzd), boxPriceDzd: s(l.boxPriceDzd),
    boxCostDzd: s(l.boxCostDzd), awardedQuantityUnits: s(l.awardedQuantityUnits), submittedQuantityUnits: s(l.submittedQuantityUnits),
    suppliersInfo: s(l.suppliersInfo), note: s(l.note), ...patch,
  });
  if (l.haveProduct) f.set("haveProduct", "on");
  return f;
}

/** LA BARRIÈRE (§118.164e) : combien de sessions attendent un verrou sur ces tables, l'instantané rafraîchi à chaque tour. */
async function attendreBloques(tx: Prisma.TransactionClient, motif: string, n: number, delai: number, exiger: boolean): Promise<void> {
  const debut = Date.now();
  for (;;) {
    await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
    const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
      SELECT count(*)::int AS k FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE ${motif}`;
    if (k >= n) return;
    if (Date.now() - debut > delai) {
      if (exiger) throw new Error(`barrière : ${n} session(s) bloquée(s) attendue(s) sur ${motif}, ${k} vue(s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

suite("PCH — lire le document d'un appel d'offres : le texte d'abord, la coupe dite, ce que personne n'a touché remplacé", () => {
  let A = "", B = "", bu = "";
  const t: Record<string, string> = {};
  const acteurs: Record<string, CurrentUser> = {};

  async function nettoyer() {
    const tenders = (await prisma.pchTender.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } }).catch(() => [])).map((x) => x.id);
    const docs = await prisma.document.findMany({ where: { entityType: "PCH_TENDER", entityId: { in: tenders } }, select: { id: true, fileKey: true } }).catch(() => []);
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: tenders } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: tenders } } }).catch(() => {});
    await prisma.pchOrder.deleteMany({ where: { tenderId: { in: tenders } } }).catch(() => {});
    await prisma.pchTenderLine.deleteMany({ where: { tenderId: { in: tenders } } }).catch(() => {});
    await prisma.pchTenderExtraction.deleteMany({ where: { tenderId: { in: tenders } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: tenders } } }).catch(() => {});
    const bus = (await prisma.businessUnit.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }).catch(() => [])).map((x) => x.id);
    await prisma.promoProduct.deleteMany({ where: { businessUnitId: { in: bus } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { id: { in: bus } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } }).catch(() => [])).map((x) => x.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes }, createdAt: { gte: new Date(T0.getTime() - 86_400_000) } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
  }

  beforeAll(async () => {
    await nettoyer();
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = (k: string) => prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: "LOGISTICS_MANAGER", passwordHash: "x" } });
    const [gest, sansUpload] = await Promise.all([mk("gest"), mk("sansupload")]);
    await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG}gest`, companyId: A, userId: gest.id } }),
      prisma.employee.create({ data: { fullName: `${TAG}sansupload`, companyId: A, userId: sansUpload.id } }),
      // Un accès PERSONNALISÉ : modifier les marchés, sans le droit d'y téléverser un document.
      prisma.userAccess.create({ data: { userId: sansUpload.id, module: "PCH", canView: true, canCreate: true, canUpdate: true, canUpload: false, scope: "ALL" } }),
    ]);
    [acteurs.gest, acteurs.sansUpload] = await Promise.all([acteur(gest.id, "LOGISTICS_MANAGER"), acteur(sansUpload.id, "LOGISTICS_MANAGER")]);
    bu = (await prisma.businessUnit.create({ data: { name: `${TAG}Onco`, isActive: true } })).id;
    const noms = ["N", "S", "R", "I", "C", "D", "M", "BU", "L", "X"];
    const crees = await Promise.all(noms.map((k) => prisma.pchTender.create({
      data: { reference: `${TAG}AO-${k}`, title: `${TAG} marché ${k}`, companyId: k === "X" ? B : A },
    })));
    noms.forEach((k, i) => { t[k] = crees[i].id; });
  }, 120_000);

  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    await nettoyer();
  }, 120_000);

  it("PRÉMISSE : le gestionnaire gère les marchés et y téléverse, sans vue globale ; l'autre modifie sans téléverser", () => {
    expect(userCan(acteurs.gest, "PCH", "UPDATE")).toBe(true);
    expect(userCan(acteurs.gest, "PCH", "UPLOAD")).toBe(true);
    expect(hasGlobalView(acteurs.gest.role)).toBe(false);
    expect(userCan(acteurs.sansUpload, "PCH", "UPDATE")).toBe(true);
    expect(userCan(acteurs.sansUpload, "PCH", "UPLOAD")).toBe(false);
  });

  it("LE MARCHÉ D'ABORD : celui d'une autre société est refusé comme absent — avant tout appel au modèle", async () => {
    ACTEUR = acteurs.gest;
    const avant = IA.appels;
    IA.lignes = [lot("Pirate")];
    expect(await lireTexte(t.X, texteDe(["Pirate"]))).toEqual({ ok: false, error: "Appel d'offres introuvable." });
    expect(IA.appels).toBe(avant);
    expect(await prisma.pchTenderLine.count({ where: { tenderId: t.X } })).toBe(0);
  });

  it("UN PDF NATIF n'est pas océrisé, et le fichier lu est gardé sur le marché — la phrase le dit", async () => {
    ACTEUR = acteurs.gest;
    const ocrAvant = OCR.appels;
    IA.brut = null;
    IA.lignes = [lot("Zorblex"), lot("Quintar")];
    const lignesPdf = Array.from({ length: 16 }, (_, i) => `Lot ${i + 1} — ${TAG} produit de l'appel d'offres, dosage et quantite`);
    const r = await lireFichier(t.N, pdfNatif("AO-natif.pdf", lignesPdf));
    expect(r.ok, r.error).toBe(true);
    expect(OCR.appels, "un PDF qui porte son texte ne part pas à l'OCR").toBe(ocrAvant);
    expect(r.message).toContain("Lecture de « AO-natif.pdf » : 2 produits lus.");
    expect(r.message).toContain("Texte natif du fichier : aucun OCR.");
    expect(r.message).toContain("Le fichier est gardé dans les documents du marché.");
    // Le modèle a reçu le TEXTE du PDF.
    expect(IA.prompts.at(-1)).toContain("Lot 16");
    const ex = await prisma.pchTenderExtraction.findFirstOrThrow({ where: { tenderId: t.N }, orderBy: { createdAt: "desc" } });
    expect(ex).toMatchObject({ source: "document", nomFichier: "AO-natif.pdf", methode: "texte", produits: 2, createdById: acteurs.gest.id });
    expect(ex.documentId).not.toBeNull();
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: ex.documentId! } });
    expect(doc).toMatchObject({ entityType: "PCH_TENDER", entityId: t.N, name: "AO-natif.pdf" });
    const ls = await lignesDe(t.N);
    expect(ls.map((l) => l.designation)).toEqual([`${TAG} Zorblex`, `${TAG} Quintar`]);
    expect(ls.every((l) => l.extractionId === ex.id && l.empreinteExtraction === empreinteLigneExtraite(lot(l.designation.slice(TAG.length + 1))))).toBe(true);
    // L'historique du MARCHÉ montre sa lecture (la lecture d'avant s'auditait sans objet).
    expect(await prisma.auditLog.count({ where: { entityType: "PCH_TENDER", entityId: t.N, summary: { startsWith: "Lecture IA de l'appel d'offres" } } })).toBe(1);
  }, 120_000);

  it("SANS LE DROIT DE TÉLÉVERSER : la lecture se fait, le fichier n'est pas gardé — et la phrase le dit", async () => {
    ACTEUR = acteurs.sansUpload;
    const docsAvant = await prisma.document.count({ where: { entityType: "PCH_TENDER", entityId: t.N } });
    IA.lignes = [lot("Zorblex")];
    const lignesPdf = Array.from({ length: 16 }, (_, i) => `Lot ${i + 1} — ${TAG} annexe de l'appel d'offres, dosage et quantite`);
    const r = await lireFichier(t.N, pdfNatif("AO-annexe.pdf", lignesPdf), { complementaire: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toContain("Le fichier n'a pas été gardé : déposer un document sur le marché demande le droit d'y téléverser.");
    // La case « complète les lectures précédentes » est LUE par le geste du fichier : rien n'est remplacé, rien n'est recréé.
    expect(r.message).toContain("Aucun produit ajouté et 1 déjà au tableau (non recréé) ; rien n'a été remplacé (document complémentaire).");
    expect(await lignesDe(t.N)).toHaveLength(2);
    expect(await prisma.document.count({ where: { entityType: "PCH_TENDER", entityId: t.N } })).toBe(docsAvant);
    const ex = await prisma.pchTenderExtraction.findFirstOrThrow({ where: { tenderId: t.N }, orderBy: { createdAt: "desc" } });
    expect(ex.documentId).toBeNull();
  }, 120_000);

  it("« OCÉRISER » COCHÉ : l'OCR est lancé même sur un PDF qui porte du texte — et la phrase dit ce qu'il a rendu", async () => {
    ACTEUR = acteurs.gest;
    const ocrAvant = OCR.appels;
    OCR.echoue = false;
    OCR.pages = ["court"];
    OCR.total = 1;
    IA.lignes = [lot("Zorblex")];
    const lignesPdf = Array.from({ length: 16 }, (_, i) => `Lot ${i + 1} — ${TAG} tableau en partie scanne, dosage et quantite`);
    const r = await lireFichier(t.N, pdfNatif("AO-mixte.pdf", lignesPdf), { forcerOcr: true, complementaire: true });
    expect(r.ok, r.error).toBe(true);
    expect(OCR.appels).toBe(ocrAvant + 1);
    expect(r.message).toContain("L'OCR n'a pas rendu plus de texte que le fichier : le texte natif a été gardé.");
  }, 120_000);

  it("UN SCAN est océrisé — 40 pages sur 63, et la phrase le dit : les pages au-delà n'ont pas été lues", async () => {
    ACTEUR = acteurs.gest;
    const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const scan = new File([makeScannedPdf(jpeg, 24, 24)], "AO-scan.pdf", { type: "application/pdf" });
    OCR.pages = Array.from({ length: 40 }, (_, i) => `Page ${i + 1} — ${TAG} lot scanné`);
    OCR.total = 63;
    IA.lignes = [lot("Scannex")];
    const r = await lireFichier(t.S, scan);
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toContain("Lu par OCR : 40 pages sur 63, confiance 78 % — des pages sont à relire.");
    expect(r.message).toContain("Les pages au-delà n'ont pas été lues : leur absence ici ne prouve rien.");
    const ex = await prisma.pchTenderExtraction.findFirstOrThrow({ where: { tenderId: t.S } });
    expect(ex).toMatchObject({ methode: "ocr", pagesLues: 40, pagesTotal: 63, confiance: 78, aRelire: true });
  }, 120_000);

  it("IA COUPÉE : refus avant toute lecture — ni OCR, ni modèle", async () => {
    ACTEUR = acteurs.gest;
    remplacerLecteurInterrupteurIaPourTests(async () => true);
    try {
      const [ocrAvant, iaAvant] = [OCR.appels, IA.appels];
      const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
      expect(await lireFichier(t.S, new File([makeScannedPdf(jpeg, 8, 8)], "x.pdf", { type: "application/pdf" }))).toEqual({ ok: false, error: REFUS_IA_COUPEE });
      expect(await lireTexte(t.S, texteDe(["Coupé"]))).toEqual({ ok: false, error: REFUS_IA_COUPEE });
      expect([OCR.appels, IA.appels]).toEqual([ocrAvant, iaAvant]);
    } finally {
      remplacerLecteurInterrupteurIaPourTests(async () => false);
    }
  });

  it("UN TEXTE PLUS LONG QUE LE BUDGET : la coupe est dite, chiffrée, et le modèle ne reçoit que l'extrait annoncé", async () => {
    ACTEUR = acteurs.gest;
    const corpsTexte = Array.from({ length: 900 }, (_, i) => `Lot ${i + 1} — ${TAG} produit long, dosage 500 mg, quantité 1000`).join("\n");
    const texte = `${corpsTexte}\nQUEUE-NON-LUE-${TAG}`;
    expect(texte.length).toBeGreaterThan(24_000);
    IA.lignes = [lot("Longex")];
    const r = await lireTexte(t.C, texte);
    expect(r.ok, r.error).toBe(true);
    const prompt = IA.prompts.at(-1)!;
    expect(prompt).toContain("EXTRAIT du document d'appel d'offres");
    expect(prompt).not.toContain("QUEUE-NON-LUE");
    const ex = await prisma.pchTenderExtraction.findFirstOrThrow({ where: { tenderId: t.C } });
    expect(ex.caracteres).toBe(texte.length);
    expect(ex.caracteresLus).toBeLessThan(ex.caracteres);
    expect(r.message).toContain(phraseCoupe(ex.caracteres, ex.caracteresLus)!);
  }, 120_000);

  describe("une seconde lecture remplace ce que personne n'a touché — et garde le reste, raison par raison", () => {
    const NOMS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const id: Record<string, string> = {};

    it("la première lecture crée les lignes ; REPASSER sur une ligne sans rien changer ne la marque pas — la corriger, si", async () => {
      ACTEUR = acteurs.gest;
      IA.lignes = NOMS.map((n) => lot(n));
      expect((await lireTexte(t.R, texteDe(NOMS))).ok).toBe(true);
      for (const l of await lignesDe(t.R)) id[l.designation.slice(TAG.length + 1)] = l.id;
      expect(Object.keys(id).sort()).toEqual(NOMS);

      // A : l'écran enregistre à la sortie du champ, sans rien changer.
      expect((await updateTenderLine(await formulaireEcran(id.A))).ok).toBe(true);
      expect((await prisma.pchTenderLine.findUniqueOrThrow({ where: { id: id.A } })).modifieeLe).toBeNull();
      // B : une personne corrige la quantité lue.
      expect((await updateTenderLine(await formulaireEcran(id.B, { quantityUnits: "1200" }))).ok).toBe(true);
      expect((await prisma.pchTenderLine.findUniqueOrThrow({ where: { id: id.B } })).modifieeLe).not.toBeNull();
    }, 120_000);

    it("chaque raison, SEULE, garde sa ligne ; une ligne saisie à la main n'est jamais remplacée ; le produit corrigé n'est pas recréé", async () => {
      ACTEUR = acteurs.gest;
      await Promise.all([
        prisma.pchTenderLine.update({ where: { id: id.C }, data: { unitPriceDzd: 100 } }),
        prisma.pchTenderLine.update({ where: { id: id.D }, data: { status: "WON" } }),
        prisma.pchTenderLine.update({ where: { id: id.E }, data: { note: "à revoir avec le fournisseur" } }),
        prisma.pchTenderLine.update({ where: { id: id.F }, data: { submissionSnapshot: { prixUnitaire: 120 } } }),
        prisma.pchTenderLineBusinessUnit.create({ data: { tenderLineId: id.G, businessUnitId: bu } }),
        prisma.pchOrder.create({ data: { tenderId: t.R, lineId: id.H, reference: `${TAG}BC-hérité` } }),
      ]);
      const manuelle = await addTenderLine(fd({ tenderId: t.R, designation: `${TAG} saisie à la main` }));
      expect(manuelle.ok).toBe(true);

      IA.lignes = [...NOMS.map((n) => lot(n)), lot("J")];
      const r = await lireTexte(t.R, texteDe([...NOMS, "J"]));
      expect(r.ok, r.error).toBe(true);
      const apres = await lignesDe(t.R);
      const ids = new Set(apres.map((l) => l.id));
      // Gardées, chacune pour SA raison — et la saisie à la main.
      for (const k of ["B", "C", "D", "E", "F", "G", "H"]) expect(ids.has(id[k]), `${k} doit rester`).toBe(true);
      expect(ids.has(manuelle.id!)).toBe(true);
      // Remplacées : A (repassée sans changement) et I.
      expect(ids.has(id.A)).toBe(false);
      expect(ids.has(id.I)).toBe(false);
      // Le produit corrigé n'est pas recréé à côté de sa correction ; rien n'est doublé.
      const parNom = (n: string) => apres.filter((l) => l.designation === `${TAG} ${n}`).length;
      for (const n of [...NOMS, "J"]) expect(parNom(n), n).toBe(1);
      expect(apres).toHaveLength(11);
      expect(r.message).toContain("3 ajoutés, 2 lignes de lectures précédentes remplacées et 7 déjà au tableau (non recréés).");
      expect(r.message).toContain("7 lignes de lectures précédentes conservées : 1 modifiée à la main, 1 figée par une soumission, 1 chiffrée, 1 au statut tranché, 1 annotée et 2 rattachées (BU, contrat, bon, vente).");
      expect(r.message).toContain("1 ligne saisie à la main ou d'avant le suivi des lectures reste telle quelle");
    }, 120_000);

    it("UN DOCUMENT COMPLÉMENTAIRE ne remplace rien et ne recrée pas ce qui est déjà là", async () => {
      ACTEUR = acteurs.gest;
      const avant = await lignesDe(t.R);
      IA.lignes = [lot("A"), lot("K")];
      const r = await lireTexte(t.R, texteDe(["A", "K"]), { complementaire: true });
      expect(r.ok, r.error).toBe(true);
      const apres = await lignesDe(t.R);
      expect(apres).toHaveLength(avant.length + 1);
      for (const l of avant) expect(apres.some((x) => x.id === l.id)).toBe(true);
      expect(r.message).toContain("1 ajouté et 1 déjà au tableau (non recréé) ; rien n'a été remplacé (document complémentaire).");
    }, 120_000);

    it("UNE RÉPONSE SANS LISTE n'écrit rien, et le dit", async () => {
      ACTEUR = acteurs.gest;
      const [lignes, lectures] = await Promise.all([prisma.pchTenderLine.count({ where: { tenderId: t.R } }), prisma.pchTenderExtraction.count({ where: { tenderId: t.R } })]);
      IA.brut = JSON.stringify({ lines: "Zorblex 500 mg" });
      try {
        expect(await lireTexte(t.R, texteDe(["A"]))).toEqual({ ok: false, error: REPONSE_INEXPLOITABLE });
      } finally { IA.brut = null; }
      expect(await prisma.pchTenderLine.count({ where: { tenderId: t.R } })).toBe(lignes);
      expect(await prisma.pchTenderExtraction.count({ where: { tenderId: t.R } })).toBe(lectures);
    });
  });

  it("LES LIGNES ILLISIBLES : écartées et comptées, quantité laissée à 0 et dite", async () => {
    ACTEUR = acteurs.gest;
    IA.lignes = [
      { designation: `${TAG} Lisible`, quantityUnits: "1 200" },
      { designation: "", quantityUnits: 5 },
      { designation: { nom: "objet" } },
      { designation: `${TAG} Douteux`, quantityUnits: "1.200" },
      { designation: `${TAG} Géant`, quantityUnits: 9_000_000_000 },
    ];
    const r = await lireTexte(t.I, texteDe(["Lisible", "Douteux", "Géant"]));
    expect(r.ok, r.error).toBe(true);
    const ls = await prisma.pchTenderLine.findMany({ where: { tenderId: t.I }, select: { designation: true, quantityUnits: true }, orderBy: { sortOrder: "asc" } });
    expect(ls).toEqual([
      { designation: `${TAG} Lisible`, quantityUnits: 1200 },
      { designation: `${TAG} Douteux`, quantityUnits: 0 },
      { designation: `${TAG} Géant`, quantityUnits: 0 },
    ]);
    expect(r.message).toContain("2 lignes rendues sans désignation lisible ont été écartées.");
    expect(r.message).toContain("2 produits sans quantité lisible : la quantité est restée à 0, à compléter.");
  }, 120_000);

  it("DEUX LECTURES SIMULTANÉES du même marché : une seule série reste — le marché est verrouillé le temps d'une lecture", async () => {
    ACTEUR = acteurs.gest;
    IA.lignes = [lot("P1"), lot("P2"), lot("P3")];
    expect((await lireTexte(t.D, texteDe(["P1", "P2", "P3"]))).ok).toBe(true);
    let ga!: ReturnType<typeof lireTexte>, gb!: ReturnType<typeof lireTexte>;
    await prisma.$transaction(async (tx) => {
      // Aucune lecture ne peut inscrire la sienne tant que le banc tient la table : les deux gestes sont en vol ensemble.
      await tx.$executeRawUnsafe(`LOCK TABLE "PchTenderExtraction" IN SHARE MODE`);
      ga = lireTexte(t.D, texteDe(["P1", "P2", "P3"]));
      gb = lireTexte(t.D, texteDe(["P1", "P2", "P3"]));
      ga.catch(() => undefined); gb.catch(() => undefined);
      await attendreBloques(tx, `%"PchTender%`, 2, 30_000, true);
    }, { timeout: 60_000 });
    const [ra, rb] = await Promise.all([ga, gb]);
    expect(ra.ok, ra.error).toBe(true);
    expect(rb.ok, rb.error).toBe(true);
    const ls = await lignesDe(t.D);
    expect(ls, "une seule série de trois lignes, pas deux").toHaveLength(3);
    for (const p of ["P1", "P2", "P3"]) expect(ls.filter((l) => l.designation === `${TAG} ${p}`), p).toHaveLength(1);
    expect(await prisma.pchTenderExtraction.count({ where: { tenderId: t.D } })).toBe(3);
  }, 120_000);

  it("UNE LIGNE MODIFIÉE PENDANT LA LECTURE reste — et son produit n'est pas recréé à côté d'elle", async () => {
    ACTEUR = acteurs.gest;
    IA.lignes = [lot("Q1"), lot("Q2")];
    expect((await lireTexte(t.M, texteDe(["Q1", "Q2"]))).ok).toBe(true);
    const q1 = (await lignesDe(t.M)).find((l) => l.designation === `${TAG} Q1`)!;
    let geste!: ReturnType<typeof lireTexte>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "PchTenderLine" WHERE id = $1 FOR UPDATE`, q1.id);
      geste = lireTexte(t.M, texteDe(["Q1", "Q2"]));
      geste.catch(() => undefined);
      await attendreBloques(tx, `%"PchTenderLine"%`, 1, 30_000, true);
      // Une personne corrige la ligne pendant que la lecture attend : `updatedAt` bouge.
      await tx.$executeRawUnsafe(`UPDATE "PchTenderLine" SET note = 'corrigée pendant la lecture', "modifieeLe" = now(), "updatedAt" = now() WHERE id = $1`, q1.id);
    }, { timeout: 60_000 });
    const r = await geste;
    expect(r.ok, r.error).toBe(true);
    const ls = await lignesDe(t.M);
    const restee = ls.find((l) => l.id === q1.id);
    expect(restee?.note, "la ligne corrigée n'a pas été effacée").toBe("corrigée pendant la lecture");
    expect(ls.filter((l) => l.designation === `${TAG} Q1`), "et son produit n'est pas recréé").toHaveLength(1);
    expect(ls.filter((l) => l.designation === `${TAG} Q2`)).toHaveLength(1);
    expect(r.message).toContain("1 ligne modifiée pendant la lecture est restée.");
  }, 120_000);

  it("UNE AFFECTATION À UNE BU posée pendant la lecture n'est jamais perdue en silence", async () => {
    ACTEUR = acteurs.gest;
    IA.lignes = [lot("R1")];
    expect((await lireTexte(t.BU, texteDe(["R1"]))).ok).toBe(true);
    const r1 = (await lignesDe(t.BU))[0];
    let lecture!: ReturnType<typeof lireTexte>;
    let affectation!: ReturnType<typeof setTenderLineBusinessUnits>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "PchTenderLine" WHERE id = $1 FOR NO KEY UPDATE`, r1.id);
      lecture = lireTexte(t.BU, texteDe(["R1"]));
      lecture.catch(() => undefined);
      await attendreBloques(tx, `%"PchTenderLine"%`, 1, 30_000, true);
      const f = fd({ id: r1.id, tenderId: t.BU });
      f.append("businessUnitId", bu);
      affectation = setTenderLineBusinessUnits(f);
      affectation.catch(() => undefined);
      // L'affectation TOUCHE la ligne avant d'écrire le lien : elle attend donc ici, elle aussi.
      await attendreBloques(tx, `%"PchTenderLine"%`, 2, 6_000, false);
    }, { timeout: 60_000 });
    const [rl, ra] = await Promise.all([lecture, affectation]);
    expect(rl.ok, rl.error).toBe(true);
    const lien = await prisma.pchTenderLineBusinessUnit.findFirst({ where: { tenderLineId: r1.id, businessUnitId: bu } });
    // Deux issues honnêtes, jamais une troisième : l'affectation a tenu (la ligne et son lien restent), ou elle DIT
    // que la ligne n'existe plus — jamais « ok » sur un lien que la lecture a emporté en cascade.
    if (ra.ok) {
      expect(lien, "affectation annoncée : le lien doit exister").not.toBeNull();
      expect(await prisma.pchTenderLine.count({ where: { id: r1.id } })).toBe(1);
    } else {
      expect(ra.error).toBe("Ligne introuvable.");
      expect(lien).toBeNull();
    }
  }, 120_000);

  it("LE CHARGEUR DES LECTURES : les cinq plus récentes, ce qu'il en reste au tableau, et le compte des autres", async () => {
    ACTEUR = acteurs.gest;
    for (let i = 1; i <= LECTURES_AFFICHEES + 1; i++) {
      IA.lignes = [lot(`L${i}`)];
      expect((await lireTexte(t.L, texteDe([`L${i}`]), { complementaire: true })).ok).toBe(true);
    }
    const r = await lecturesDuMarche(t.L);
    expect(r.total).toBe(LECTURES_AFFICHEES + 1);
    expect(r.liste).toHaveLength(LECTURES_AFFICHEES);
    expect(r.liste[0].resume).toContain("texte collé");
    expect(r.liste[0].resume).toContain("1 produit lu, 1 encore au tableau");
    expect(r.liste[0].resume).toContain(`${TAG}gest`);
    expect(r.liste[0].resume).toContain("complément");
    // Ce qu'il en reste au tableau se COMPTE, lecture par lecture — ce n'est pas ce qu'elle a lu : sur le marché R, la
    // deuxième lecture a lu 10 produits et en a créé 3, la première en a lu 9 et 2 de ses lignes ont été remplacées.
    const r2 = await lecturesDuMarche(t.R);
    expect(r2.liste.map((l) => l.resume.match(/(\d+) produits? lus?, (\d+) encore/)?.slice(1).join("/"))).toEqual(["2/1", "10/3", "9/7"]);
    // Le fichier gardé du marché N se dit gardé ; retiré des documents, il ne l'est plus — l'autre, toujours là, l'est encore.
    const n = await lecturesDuMarche(t.N);
    expect(n.liste.some((l) => l.resume.includes("fichier « AO-natif.pdf » (gardé dans les documents)"))).toBe(true);
    const exNatif = await prisma.pchTenderExtraction.findFirstOrThrow({ where: { tenderId: t.N, nomFichier: "AO-natif.pdf" } });
    const docNatif = await prisma.document.findUniqueOrThrow({ where: { id: exNatif.documentId! } });
    if (docNatif.fileKey) await deleteFileByKey(docNatif.fileKey).catch(() => {});
    await prisma.document.delete({ where: { id: docNatif.id } });
    const n2 = await lecturesDuMarche(t.N);
    const natif = n2.liste.find((l) => l.id === exNatif.id)!;
    expect(natif.resume).toContain("fichier « AO-natif.pdf »");
    expect(natif.resume).not.toContain("(gardé dans les documents)");
    expect(n2.liste.some((l) => l.resume.includes("fichier « AO-mixte.pdf » (gardé dans les documents)"))).toBe(true);
  }, 120_000);

  it("LA CORBEILLE emporte les lectures avec le marché, et les rend — les lignes retrouvent leur lecture", async () => {
    ACTEUR = acteurs.gest;
    const [lectures, lignes] = await Promise.all([
      prisma.pchTenderExtraction.count({ where: { tenderId: t.L } }),
      prisma.pchTenderLine.findMany({ where: { tenderId: t.L }, select: { id: true, extractionId: true } }),
    ]);
    expect(lectures).toBeGreaterThan(0);
    const r = await deleteTender(fd({ id: t.L }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.pchTenderExtraction.count({ where: { tenderId: t.L } })).toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: t.L, kind: "PCH_TENDER" } });
    const restaure = await restaurerLotDeLaCorbeille(rec, "PCH_TENDER");
    expect(restaure?.ok, restaure?.error).toBe(true);
    expect(await prisma.pchTenderExtraction.count({ where: { tenderId: t.L } })).toBe(lectures);
    const apres = await prisma.pchTenderLine.findMany({ where: { tenderId: t.L }, select: { id: true, extractionId: true } });
    expect(apres.sort((a, b) => a.id.localeCompare(b.id))).toEqual(lignes.sort((a, b) => a.id.localeCompare(b.id)));
  }, 120_000);
});
