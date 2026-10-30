import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { BORNE_REVELEE } from "../../domaine/filtre-confidentialite";
import { DIT_A_L_ECRAN } from "../../domaine/terrain/voix";
import { deleguerALaVoix, journaliserVoix, ouvrirVoixAssistant, reponsePourVoix } from "./temps-reel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX GPT-LIVE SOUS LES MÊMES DROITS QUE LE TEXTE (lot J13, décision 0025) — vraie base, fournisseur simulé.
 *
 * On tient : la session ne s'ouvre qu'avec l'Assistant IA, sur `gpt-live-1` (ou le modèle réglé), délégation « client »,
 * sans outil donné à la voix ; une délégation passe par LE FIL (le même assistant, au faux modèle) ; une écriture rend
 * une CARTE pour l'écran, la voix n'entend que « carte à l'écran » et rien n'est créé ; une valeur révélée ne repart
 * jamais à la voix ; la durée est comptée au nom de la personne et la transcription s'écrit dans le fil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iavoixlive_${Date.now().toString(36)}_`;
let kam: CurrentUser;
let sansAssistant: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

async function compte(nom: string, assistant: boolean): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
  if (assistant) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

describe("ce que la voix peut dire d'une réponse écrite", () => {
  it("une valeur révélée à l'écran ne repart jamais à la voix ; ni Markdown ni adresse", () => {
    const v = reponsePourVoix(`**Salaire de base** : ${BORNE_REVELEE}185 000 DZD${BORNE_REVELEE}, voir [la fiche](/rh/1) https://x.dz`);
    expect(v).not.toContain("185");
    expect(v).toContain(DIT_A_L_ECRAN);
    expect(v).not.toMatch(/\*\*|https?:/);
  });
});

suite("Assistant IA — voix GPT-Live", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    kam = await compte("kam", true);
    sansAssistant = await compte("sans", false);
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    await effacerJournalDe([kam?.id, sansAssistant?.id]);
    await prisma.assistantActionIntent.deleteMany({ where: { userId: kam?.id } });
    await prisma.assistantIaFil.deleteMany({ where: { userId: kam?.id } });
  });

  it("la session : gpt-live-1, délégation client, aucun outil donné à la voix, SDP échangé côté serveur ; refusée sans l'Assistant IA", async () => {
    let corps: { session: Record<string, unknown> & { delegation: { type: string } }; transport: { type: string; sdp: string } } | null = null;
    let url = "";
    const f = (async (u: string | URL, init?: RequestInit) => {
      url = String(u);
      corps = JSON.parse(String(init?.body));
      return Response.json({ session: { id: "live_banc" }, transport: { type: "webrtc", sdp: "v=0 réponse" } }, { status: 201 });
    }) as typeof fetch;
    const s = await ouvrirVoixAssistant(kam, "v=0 offre", { fetchImpl: f });
    expect(s).toMatchObject({ ok: true, id: "live_banc", sdp: "v=0 réponse", modele: "gpt-live-1" });
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(corps!.session.model).toBe("gpt-live-1");
    expect(corps!.session.delegation.type).toBe("client");
    expect(corps!.session.tools).toBeUndefined();
    expect(corps!.transport).toEqual({ type: "webrtc", sdp: "v=0 offre" });
    expect(String(corps!.session.instructions)).toContain("Une valeur confidentielle n'est JAMAIS prononcée");
    expect(await ouvrirVoixAssistant(sansAssistant, "v=0", { fetchImpl: f })).toMatchObject({ ok: false, statut: 403 });
    // Pas de modèle de secours : le fournisseur refuse, l'écran le dit.
    const refus = await ouvrirVoixAssistant(kam, "v=0", { fetchImpl: (async () => new Response("non", { status: 404 })) as typeof fetch });
    expect(refus).toMatchObject({ ok: false, statut: 502 });
    expect(!refus.ok && refus.erreur).toContain("gpt-live-1 ne répond pas");
  });

  it("une délégation passe par le fil : le même assistant répond, la demande dite y est écrite", async () => {
    remplacerModelesPourTests([modeleFactice([reponse("Vous avez trois visites prévues demain.")]).modele as never]);
    const r = await deleguerALaVoix(kam, "qu'est-ce que j'ai demain ?");
    expect(r.pourVoix).toBe("Vous avez trois visites prévues demain.");
    expect(r.carte).toBeUndefined();
    const tours = await prisma.assistantIaTour.findMany({ where: { userId: kam.id }, orderBy: { createdAt: "asc" }, select: { role: true, contenu: true } });
    expect(tours[0]).toMatchObject({ role: "user", contenu: "[Conversation vocale] qu'est-ce que j'ai demain ?" });
    expect(tours.at(-1)?.role).toBe("assistant");
  });

  it("une écriture : une CARTE pour l'écran, la voix n'entend que « carte à l'écran », rien n'est créé", async () => {
    remplacerModelesPourTests([modeleFactice([
      { appel: { outil: "terrain_compte_rendu", entree: { medecin: "Dr Inconnu", synthese: "Visite du Dr Inconnu : intéressé par Cardiovex." } } },
      reponse("J'ai préparé le compte rendu : la carte est affichée."),
    ]).modele as never]);
    const r = await deleguerALaVoix(kam, "prépare le compte rendu de ma visite chez le docteur Inconnu, intéressé par Cardiovex");
    expect(r.carte?.intentId).toBeTruthy();
    expect(r.pourVoix).toContain("seule la personne la confirme");
    expect(await prisma.fieldReport.count({ where: { delegateId: kam.id } })).toBe(0);
  });

  it("la fin : durée comptée au nom de la personne, transcription écrite dans le fil", async () => {
    await journaliserVoix(kam, { secondes: 42, latences: [900, 1100], confirme: true, lignes: [{ qui: "personne", texte: "Bonjour" }, { qui: "assistant", texte: "Bonjour Karim." }] });
    const l = await prisma.modelCallLog.findFirst({ where: { userId: kam.id, provider: "openai-live" }, select: { model: true, inputTokens: true } });
    expect(l).toMatchObject({ model: "gpt-live-1", inputTokens: 420 });
    const t = await prisma.assistantIaTour.findFirst({ where: { userId: kam.id, contenu: { startsWith: "[Conversation vocale — transcription]" } }, select: { etat: true } });
    expect(t?.etat).toBe("TRAITE");
  });
});
