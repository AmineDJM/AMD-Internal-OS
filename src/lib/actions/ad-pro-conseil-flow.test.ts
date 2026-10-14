import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA CONSEILLE OÙ RANGER UNE PIÈCE — par la VRAIE action (`conseillerPiece`).
 *
 * Le monde extérieur est simulé, et lui seul : le fournisseur (`askModelJson`), l'interrupteur et
 * la bascule du Centre de contrôle IA (lignes GLOBALES qu'un banc ne pose jamais pour de vrai,
 * §118.132), la présence d'une clé, et le lecteur de fichier (aucun OCR dans un banc). La base, la
 * session des acteurs, `canAccessEntity`, le stockage et le lien pièce ↔ demande sont les vrais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR , requireUserAuNomDeLaVue: async () => ACTEUR}));

const APPELS: { prompt: string; system?: string }[] = [];
let DONNEES: unknown = null;
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async (role: string, prompt: string, _schema: unknown, opts: { system?: string }) => {
    APPELS.push({ prompt, system: opts.system });
    return {
      data: DONNEES,
      reply: { ok: true, configured: true, stop: "end", blocks: [], usage: { role, model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1 } },
    };
  },
}));

let COUPEE = false;
let ACTIVE = true;
const JOURNAL: { feature: string; ok: boolean }[] = [];
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  interrupteurIaCoupe: async () => COUPEE,
  aiFeatureEnabled: async () => ACTIVE,
  logAiUsage: async (u: { feature: string; ok: boolean }) => { JOURNAL.push(u); },
}));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => true }));

const LUS: string[] = [];
vi.mock("@/lib/pieces-lues/lecture-fichier", async (orig) => ({
  ...(await orig<typeof import("@/lib/pieces-lues/lecture-fichier")>()),
  lireFichierUneFois: async (a: { octets: Buffer }) => {
    LUS.push(a.octets.toString("utf8"));
    return { ok: true, lecture: { id: "l", empreinte: "e", etat: "LUE", texte: a.octets.toString("utf8"), methode: "texte", confiance: null, caracteres: a.octets.length } };
  },
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { saveFile, deleteFileByKey } from "@/lib/storage";
import { conseillerPiece } from "./ad-pro-conseil-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__conseilLuna__";
const FACTURE_HOTEL = "FACTURE N° 12/2026 — Hôtel Sheraton Oran — 3 nuits, chambre double, orateur Dr Benali — total 120 000 DA";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  return { id, name: role, email: `${id}@banc.dz`, role, access: await getAccess(id, role), mustChangePassword: false };
}

function fd(champs: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
}

suite("Luna — conseiller une pièce déposée (vraie action)", () => {
  let direction: CurrentUser, rh: CurrentUser;
  let spoId = "", autreSpoId = "", posteHotel = "", posteBillet = "", docBillet = "", docAutre = "", docConfidentiel = "";
  // LES PIÈCES DU REGISTRE RATTACHÉES À UN POSTE (§118.204) : leur fichier vit sur la pièce Legal.
  let docPiece = "", docPieceAutre = "";
  const legaux: string[] = [];
  const cles: string[] = [];

  beforeAll(async () => {
    const [dir, hr, dem] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, role: "VIEWER", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}dem`, email: `${TAG}dem@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
    ]);
    direction = await acteur(dir.id, "DIRECTION");
    rh = await acteur(hr.id, "VIEWER");
    const ref = () => `SPO-2031-${Math.floor(Math.random() * 900000 + 100000)}`;
    const [spo, autre] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: ref(), institution: `${TAG} CHU Oran`, type: "Congrès", requesterId: dem.id } }),
      prisma.sponsoringRequest.create({ data: { reference: ref(), institution: `${TAG} CHU Annaba`, type: "Congrès", requesterId: dem.id } }),
    ]);
    spoId = spo.id; autreSpoId = autre.id;
    const [h, b, x] = await Promise.all([
      prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "ACCOMMODATION", label: `${TAG} Hôtel des orateurs`, amountEstimated: 120000 } }),
      prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "TICKETING", label: `${TAG} Billets` } }),
      prisma.adProItem.create({ data: { sponsoringId: autreSpoId, kind: "ACCOMMODATION", label: `${TAG} Hôtel autre` } }),
    ]);
    posteHotel = h.id; posteBillet = b.id;
    const fichier = async (entityType: "AD_PRO_ITEM" | "LEGAL_DOCUMENT", entityId: string, contenu: string, confidentiality: "INTERNAL" | "CONFIDENTIAL" = "INTERNAL") => {
      const key = `${TAG}/${Math.random().toString(36).slice(2)}.pdf`;
      await saveFile(key, Buffer.from(contenu, "utf8"));
      cles.push(key);
      return (await prisma.document.create({ data: { name: "facture-sheraton.pdf", entityType, entityId, fileKey: key, confidentiality } })).id;
    };
    docBillet = await fichier("AD_PRO_ITEM", posteBillet, FACTURE_HOTEL);
    docAutre = await fichier("AD_PRO_ITEM", x.id, FACTURE_HOTEL);
    docConfidentiel = await fichier("AD_PRO_ITEM", posteBillet, "CONVENTION CONFIDENTIELLE — honoraires du Dr X : 500 000 DA", "CONFIDENTIAL");
    // Un devis au registre, rattaché au poste « Billets » de CETTE demande ; un autre, rattaché au poste
    // d'une AUTRE demande. Le lien est `AdProItemPiece` — le seul qui dise à quel poste sert la pièce.
    const piece = async (itemId: string) => {
      const l = await prisma.legalDocument.create({ data: { title: `${TAG} Devis`, kind: "QUOTE" }, select: { id: true } });
      legaux.push(l.id);
      await prisma.adProItemPiece.create({ data: { itemId, legalDocumentId: l.id, nature: "DEVIS" } });
      return l.id;
    };
    docPiece = await fichier("LEGAL_DOCUMENT", await piece(posteBillet), FACTURE_HOTEL);
    docPieceAutre = await fichier("LEGAL_DOCUMENT", await piece(x.id), FACTURE_HOTEL);
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: { in: [docBillet, docAutre, docConfidentiel, docPiece, docPieceAutre] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    for (const k of cles) await deleteFileByKey(k).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: [spoId, autreSpoId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  beforeEach(() => {
    APPELS.length = 0; JOURNAL.length = 0; LUS.length = 0; COUPEE = false; ACTIVE = true; ACTEUR = direction;
    DONNEES = {
      verdict: "A_DEPLACER", natureLue: "facture d'hôtel", resume: "Facture du Sheraton pour 3 nuits.", confiance: 0.92,
      conseils: [{ geste: "DEPLACER_POSTE", posteId: posteHotel, case: "FACTURE", natureSuggeree: "", raison: "facture du Sheraton, 3 nuits" }],
    };
  });

  const demande = (over: Record<string, string> = {}) => fd({
    entityType: "SPONSORING", entityId: spoId, fichierId: docBillet,
    emplacement: JSON.stringify({ type: "POSTE", posteId: posteBillet, case: "FACTURE" }), ...over,
  });

  it("une facture d'hôtel déposée sous la billetterie : Luna conseille le poste Hôtellerie, et n'écrit rien", async () => {
    const avant = await prisma.document.findUniqueOrThrow({ where: { id: docBillet } });
    const r = await conseillerPiece(demande());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.conseil.verdict).toBe("A_DEPLACER");
    expect(r.conseil.conseils[0]).toMatchObject({ geste: "DEPLACER_POSTE", posteId: posteHotel, case: "FACTURE" });
    expect(r.conseil.conseils[0].texte).toContain("Hôtel des orateurs");
    // Le texte du document est enclos (une DONNÉE), le contexte vient de la base.
    expect(APPELS).toHaveLength(1);
    expect(APPELS[0].prompt).toContain("CONTENU EXTERNE");
    expect(APPELS[0].prompt).toContain(`posteId=${posteHotel}`);
    expect(APPELS[0].system).toMatch(/liste FERMÉE/);
    expect(JOURNAL).toEqual([expect.objectContaining({ feature: "conseil_pieces", ok: true })]);
    const apres = await prisma.document.findUniqueOrThrow({ where: { id: docBillet } });
    expect(apres).toEqual(avant);
  });

  it("une demande NON VISIBLE est refusée — avant toute lecture et tout appel", async () => {
    expect(await canAccessEntity(rh as SessionUser, "SPONSORING", spoId, "VIEW")).toBe(false); // prémisse
    ACTEUR = rh;
    const r = await conseillerPiece(demande());
    expect(r).toEqual({ ok: false, raison: "LECTURE", error: "Demande introuvable." });
    expect(LUS).toHaveLength(0);
    expect(APPELS).toHaveLength(0);
  });

  it("le fichier d'une AUTRE demande est refusé — même si la personne voit les deux", async () => {
    expect(await canAccessEntity(direction as SessionUser, "SPONSORING", autreSpoId, "VIEW")).toBe(true); // prémisse
    const r = await conseillerPiece(demande({ fichierId: docAutre }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'appartient pas à cette demande/);
    expect(LUS).toHaveLength(0);
    expect(APPELS).toHaveLength(0);
  });

  it("le fichier d'une PIÈCE DU REGISTRE rattachée à un poste de la demande est accepté (§118.204)", async () => {
    const r = await conseillerPiece(demande({ fichierId: docPiece }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(LUS, "le fichier de la pièce est bien celui qui est lu").toEqual([FACTURE_HOTEL]);
    expect(APPELS).toHaveLength(1);
  });

  it("le fichier d'une pièce rattachée au poste d'une AUTRE demande est refusé — avant toute lecture", async () => {
    // Ce qui le ferait tomber : ouvrir la garde à « toute pièce rattachée à un poste » au lieu des
    // postes de CETTE demande — Luna lirait le devis d'une demande voisine.
    expect(await canAccessEntity(direction as SessionUser, "SPONSORING", autreSpoId, "VIEW")).toBe(true); // prémisse
    const r = await conseillerPiece(demande({ fichierId: docPieceAutre }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'appartient pas à cette demande/);
    expect(LUS).toHaveLength(0);
    expect(APPELS).toHaveLength(0);
  });

  it("un poste visé qui n'est pas de la demande est refusé", async () => {
    const r = await conseillerPiece(demande({ emplacement: JSON.stringify({ type: "POSTE", posteId: "poste-forge", case: "FACTURE" }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'appartient pas à cette demande/);
    expect(APPELS).toHaveLength(0);
  });

  it("interrupteur IA coupé : ok:false qui le DIT, rien n'est lu ni envoyé — jamais « bien placé »", async () => {
    COUPEE = true;
    const r = await conseillerPiece(demande());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.raison).toBe("IA_COUPEE"); expect(r.error).toMatch(/coupée/i); }
    expect(LUS).toHaveLength(0);
    expect(APPELS).toHaveLength(0);
    expect(JOURNAL).toHaveLength(0);
  });

  it("bascule du conseil coupée : ok:false qui le dit", async () => {
    ACTIVE = false;
    const r = await conseillerPiece(demande());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toBe("DESACTIVEE");
    expect(APPELS).toHaveLength(0);
  });

  it("une pièce CONFIDENTIELLE ne sort pas : ni lue, ni envoyée", async () => {
    const r = await conseillerPiece(demande({ fichierId: docConfidentiel }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toBe("CONFIDENTIELLE");
    expect(LUS).toHaveLength(0);
    expect(APPELS).toHaveLength(0);
  });

  it("le modèle désigne un poste INCONNU (celui d'une autre demande) : conseil retiré, verdict INCERTAIN", async () => {
    const autrePoste = (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: autreSpoId } })).id;
    DONNEES = {
      verdict: "A_DEPLACER", natureLue: "facture d'hôtel", resume: "", confiance: 0.9,
      conseils: [{ geste: "DEPLACER_POSTE", posteId: autrePoste, case: "FACTURE", natureSuggeree: "", raison: "x" }],
    };
    const r = await conseillerPiece(demande());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conseil.conseils).toHaveLength(0);
    expect(r.conseil.verdict).toBe("INCERTAIN");
  });

  it("une réponse illisible est un ÉCHEC journalisé, et jamais « bien placé »", async () => {
    DONNEES = { verdict: "BON_ENDROIT", natureLue: "x", confiance: 7, conseils: [] };
    const r = await conseillerPiece(demande());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toBe("INEXPLOITABLE");
    expect(JOURNAL).toEqual([expect.objectContaining({ feature: "conseil_pieces", ok: false })]);
  });
});
