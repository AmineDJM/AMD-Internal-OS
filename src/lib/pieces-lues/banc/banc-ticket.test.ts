import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelReply } from "@/lib/models/contract";

/**
 * BANC — LE TICKET DE CAISSE SCANNÉ (Moyens généraux, 09/11/2026 : « l'IA ne lit pas bien les bons »).
 *
 * Le fichier réel : un ticket de 15 articles scanné sur une page A4, avec la couche texte du SCANNER (décimales perdues,
 * colonnes collées). Il ressortait en 6 lignes aux montants centuplés : la couche texte était lue, et la vision — qui ne
 * passait qu'en second — recopiait la quantité comme numéro de ligne. Ce banc tient les trois corrections :
 *   • un PDF qu'une image couvre est un SCAN : la vision passe la PREMIÈRE, le modèle de texte n'est pas appelé ;
 *   • une quantité recopiée comme numéro ne fait pas de « doublons » : les 15 articles ressortent ;
 *   • le total d'un scan se prend sur l'image : la réconciliation est juste.
 */

const modele = vi.hoisted(() => ({ appels: 0, reponse: null as unknown }));
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async () => {
    modele.appels++;
    const reply = { ok: true, configured: true, stop: "end", blocks: [], usage: { role: "worker", model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1, reasoningTokens: 0 } } as unknown as ModelReply;
    return { data: modele.reponse, reply };
  },
}));
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  aiFeatureEnabled: async () => true,
  interrupteurIaCoupe: async () => false,
  logAiUsage: async () => {},
}));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => true, cleModeleRequise: () => "OPENAI_API_KEY" }));
vi.mock("@/lib/openai-luna", async (orig) => ({ ...(await orig<typeof import("@/lib/openai-luna")>()), lunaConfigured: () => false }));
const vision = vi.hoisted(() => ({ appels: 0, reponse: null as unknown }));
vi.mock("@/lib/pieces-lues/vision-lignes", async (orig) => {
  const reel = await orig<typeof import("@/lib/pieces-lues/vision-lignes")>();
  return { ...reel, lireTableauParVision: async () => { vision.appels++; return vision.reponse ? reel.lignesDeLaVision(vision.reponse as never, "vision-du-banc") : null; } };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { proposerLecture, type ContexteLecture } from "../service";
import { ARTICLES_TICKET, TOTAL_TICKET, VISION_DU_TICKET, ticketScanne } from "./ticket-fabrique";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bancticket${Date.now().toString(36)}__`;
let USER = { id: "" };
const CONTEXTE: ContexteLecture = { cible: "DEPARTMENT_EXPENSE", sortieCloudPermise: true, annuaireVisible: [] };

/** Ce que le modèle de TEXTE aurait rendu en lisant la couche du scanner : 6 lignes, montants centuplés. */
const LECTURE_DE_LA_COUCHE_TEXTE = {
  type: "FACTURE", numero: "", date: "", devise: "DA", modePaiement: "",
  fournisseur: { nom: "LIBELLE", nif: "", rc: "", nis: "", ai: "", adresse: "" },
  tvaDefaut: "", remiseGlobale: "", taxes: [],
  lignes: ARTICLES_TICKET.slice(0, 6).map((a) => ({
    designation: a.designation, reference: "", unite: "", quantite: String(a.qte),
    prixUnitaire: String(a.pu * 100), remise: "", tva: "", montantHt: String(a.qte * a.pu * 100),
  })),
  totaux: { ht: "", tva: "", taxes: "", timbre: "", ttc: "" },
};

suite("Banc — le ticket de caisse scanné se lit sur son image", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { id: `${TAG}mg`, name: `${TAG} mg`, email: `${TAG}mg@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    USER = { id: u.id };
  });
  afterAll(async () => {
    await prisma.lecturePiece.deleteMany({ where: { creeParId: USER.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });
  beforeEach(() => { vision.appels = 0; vision.reponse = null; modele.appels = 0; modele.reponse = LECTURE_DE_LA_COUCHE_TEXTE; });

  it("la vision d'abord : 15 articles aux bons montants, le total juste, le modèle de texte pas appelé", async () => {
    vision.reponse = VISION_DU_TICKET;
    const r = await proposerLecture({ user: USER, octets: await ticketScanne(`${TAG}a`), nomFichier: "Dépense du 04.11.26.pdf", contexte: CONTEXTE });
    if (!r.ok) throw new Error(r.error);
    const p = r.proposition;
    expect(p.methodeLignes).toBe("vision");
    expect(vision.appels).toBe(1);
    expect(modele.appels, "un scan ne paie pas la lecture de sa couche texte").toBe(0);
    const lignes = p.piece!.lignes.filter((x) => !x.section);
    expect(lignes.map((x) => [x.designation, x.quantite, x.prixUnitaire, x.montantHt]))
      .toEqual(ARTICLES_TICKET.map((a) => [a.designation, a.qte, a.pu, a.qte * a.pu]));
    expect(p.reconciliation?.sommeLignes).toBe(TOTAL_TICKET);
    expect(p.reconciliation?.juste, JSON.stringify(p.reconciliation)).toBe(true);
    expect(p.piece!.fournisseur.nom).toBe("DROGUERIE DU BANC");
  }, 60_000);

  it("relu (mêmes octets) : les lignes de la vision sont gardées — pas de second appel", async () => {
    vision.reponse = VISION_DU_TICKET;
    const octets = await ticketScanne(`${TAG}b`);
    await proposerLecture({ user: USER, octets, nomFichier: "ticket.pdf", contexte: CONTEXTE });
    const r = await proposerLecture({ user: USER, octets, nomFichier: "ticket.pdf", contexte: CONTEXTE });
    if (!r.ok) throw new Error(r.error);
    expect(r.proposition.methodeLignes).toBe("vision");
    expect(r.proposition.piece!.lignes.filter((x) => !x.section)).toHaveLength(15);
    expect(vision.appels).toBe(1);
  }, 60_000);

  it("la vision indisponible : la couche texte du SCANNER n'est pas lue — aucune ligne, et la phrase le dit", async () => {
    vision.reponse = null;
    const r = await proposerLecture({ user: USER, octets: await ticketScanne(`${TAG}c`), nomFichier: "ticket.pdf", contexte: CONTEXTE });
    if (!r.ok) throw new Error(r.error);
    expect(vision.appels).toBe(1);
    expect(modele.appels, "des montants centuplés coûtent plus qu'aucune ligne").toBe(0);
    expect(r.proposition.piece).toBeNull();
    expect(r.proposition.sansLignes).toMatch(/scann.*pas fiable/);
  }, 60_000);
});
