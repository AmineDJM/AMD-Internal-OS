import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA SUR « + PIÈCE JOINTE » DES DÉTAILS D'UNE DEMANDE — de bout en bout, par les VRAIS points
 * d'entrée : la route de téléversement rend l'identifiant du `Document` créé, et ce fichier,
 * déposé dans les DÉTAILS, se fait conseiller par `conseillerPiece` (emplacement DETAILS).
 *
 * Avant : le bouton discret ne branchait pas Luna, parce que le téléversement ne rendait pas
 * l'identifiant du fichier. Le monde extérieur est simulé, et lui seul (le fournisseur,
 * l'interrupteur et la bascule — lignes globales qu'un banc ne pose jamais, §118.132 —, la clé, le
 * lecteur de fichier, le miroir Drive). La session, la base, la porte et le stockage sont les vrais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUserPourEcrire: async () => ACTEUR }));
vi.mock("@/lib/drive/document-mirror", () => ({ mirrorDocumentsToDrive: async () => {} }));
vi.mock("@/lib/regulatory-drive-mirror", () => ({ mirrorRegulatoryUpload: async () => {} }));

const APPELS: { prompt: string }[] = [];
let DONNEES: unknown = null;
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async (role: string, prompt: string) => {
    APPELS.push({ prompt });
    return {
      data: DONNEES,
      reply: { ok: true, configured: true, stop: "end", blocks: [], usage: { role, model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1 } },
    };
  },
}));

let COUPEE = false;
let ACTIVE = true;
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  interrupteurIaCoupe: async () => COUPEE,
  aiFeatureEnabled: async () => ACTIVE,
  logAiUsage: async () => {},
}));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => true }));
vi.mock("@/lib/pieces-lues/lecture-fichier", async (orig) => ({
  ...(await orig<typeof import("@/lib/pieces-lues/lecture-fichier")>()),
  lireFichierUneFois: async (a: { octets: Buffer }) => ({
    ok: true, lecture: { id: "l", empreinte: "e", etat: "LUE", texte: a.octets.toString("utf8"), methode: "texte", confiance: null, caracteres: a.octets.length },
  }),
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { POST } from "@/app/api/documents/upload/route";
import { conseillerPiece } from "./actions-conseil";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__conseilDetails__";
const FACTURE = "FACTURE N° 7/2026 — Imprimerie El Djazair — 500 programmes du congrès — total 80 000 DA";

describe("le point d'appel — l'écran passe l'identifiant à Luna", () => {
  const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  it("la carte des détails écoute le dépôt et monte <ConseilLuna> en emplacement DETAILS", () => {
    const carte = code("src/modules/ad-pro/ecrans/pieces-jointes-demande.tsx");
    expect(carte).toMatch(/onUploaded=\{nature \? surDepot : undefined\}/);
    expect(carte).toMatch(/<ConseilLuna[^>]*emplacement=\{\{ type: "DETAILS" \}\}/);
  });
  it("le téléverseur et le gestionnaire d'envois remontent ce que le serveur a créé", () => {
    expect(code("src/components/documents/document-upload.tsx")).toMatch(/onFileDone: onUploaded/);
    expect(code("src/components/layout/background-upload.tsx")).toMatch(/spec\.onFileDone\?\.\(file, r\.body\)/);
  });
});

suite("Luna conseille la pièce déposée par « + Pièce jointe » (route de téléversement → conseillerPiece)", () => {
  let acteur: CurrentUser;
  let spoId = "";
  const cles: string[] = [];

  const deposer = async () => {
    const form = new FormData();
    form.set("entityType", "SPONSORING");
    form.set("entityId", spoId);
    form.set("category", "OTHER");
    form.set("confidentiality", "INTERNAL");
    form.append("files", new File([FACTURE], `${TAG}facture-imprimerie.pdf`, { type: "application/pdf" }));
    const res = await POST(new NextRequest("http://banc/api/documents/upload", { method: "POST", body: form }));
    return { status: res.status, body: await res.json() as { ok: boolean; ids?: string[]; created: number } };
  };

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}dm`, email: `${TAG}dm@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } });
    acteur = { id: u.id, name: u.name, email: u.email, role: "PRODUCT_MANAGER", access: await getAccess(u.id, "PRODUCT_MANAGER"), mustChangePassword: false } as CurrentUser;
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO-${Date.now()}`, institution: `${TAG} CHU`, type: "Congrès", requesterId: u.id, createdById: u.id },
    });
    spoId = spo.id;
    await prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "OTHER", label: `${TAG} Imprimerie des programmes` } });
  });

  afterAll(async () => {
    const docs = await prisma.document.findMany({ where: { entityType: "SPONSORING", entityId: spoId }, select: { id: true, fileKey: true } });
    for (const d of docs) if (d.fileKey) cles.push(d.fileKey);
    await prisma.document.deleteMany({ where: { entityType: "SPONSORING", entityId: spoId } }).catch(() => {});
    for (const k of cles) await deleteFileByKey(k).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  beforeEach(() => {
    APPELS.length = 0; COUPEE = false; ACTIVE = true; ACTEUR = acteur;
    DONNEES = {
      verdict: "A_DEPLACER", natureLue: "facture d'imprimerie", resume: "Facture de 500 programmes.", confiance: 0.9,
      conseils: [{ geste: "DEPLACER_POSTE", posteId: "", case: "FACTURE", natureSuggeree: "", raison: "c'est la facture du poste Imprimerie" }],
    };
  });

  it("le dépôt rend l'identifiant du fichier créé, et Luna le lit depuis les DÉTAILS — sans rien déplacer", async () => {
    expect(hasGlobalView(acteur.role), "prémisse : la Direction Marketing n'a pas la vue globale").toBe(false);
    expect(userCan(acteur, "SPONSORING", "UPLOAD")).toBe(true);
    const d = await deposer();
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.ids, "la route rend ce qu'elle a créé").toHaveLength(1);
    const id = d.body.ids![0]!;
    const doc = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect([doc.entityType, doc.entityId]).toEqual(["SPONSORING", spoId]);

    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spoId } });
    DONNEES = { ...(DONNEES as object), conseils: [{ geste: "DEPLACER_POSTE", posteId: poste.id, case: "FACTURE", natureSuggeree: "", raison: "facture de l'imprimerie" }] };
    const f = new FormData();
    f.set("entityType", "SPONSORING"); f.set("entityId", spoId); f.set("fichierId", id); f.set("emplacement", JSON.stringify({ type: "DETAILS" }));
    const r = await conseillerPiece(f);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.conseil.verdict).toBe("A_DEPLACER");
    expect(r.conseil.conseils[0]).toMatchObject({ geste: "DEPLACER_POSTE", posteId: poste.id });
    expect(APPELS).toHaveLength(1);
    expect(APPELS[0]!.prompt).toContain("Imprimerie El Djazair");
    // Luna conseille, il ne range rien : le fichier est toujours sur la demande.
    const apres = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect([apres.entityType, apres.entityId]).toEqual(["SPONSORING", spoId]);
  });

  it("l'interrupteur de l'IA coupé : Luna le DIT, rien n'est envoyé", async () => {
    const d = await deposer();
    COUPEE = true;
    const f = new FormData();
    f.set("entityType", "SPONSORING"); f.set("entityId", spoId); f.set("fichierId", d.body.ids![0]!); f.set("emplacement", JSON.stringify({ type: "DETAILS" }));
    const r = await conseillerPiece(f);
    expect(r).toMatchObject({ ok: false, raison: "IA_COUPEE" });
    expect(APPELS).toHaveLength(0);
  });

  it("la bascule du conseil coupée : Luna le DIT, rien n'est envoyé", async () => {
    const d = await deposer();
    ACTIVE = false;
    const f = new FormData();
    f.set("entityType", "SPONSORING"); f.set("entityId", spoId); f.set("fichierId", d.body.ids![0]!); f.set("emplacement", JSON.stringify({ type: "DETAILS" }));
    const r = await conseillerPiece(f);
    expect(r).toMatchObject({ ok: false, raison: "DESACTIVEE" });
    expect(APPELS).toHaveLength(0);
  });
});
