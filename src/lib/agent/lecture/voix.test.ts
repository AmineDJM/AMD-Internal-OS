import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";
import { deposerMessage, ETAT, lireFil, reglerReponseVocale, traiterFil } from "@/lib/agent/fil/service";
import { transcrireMedia } from "./pieces";
import { auNomDe } from "@/lib/agent/consommation";
import type { AudioDuTour, VocalDuTour } from "./regles";
import { deposerAudio, NOM_DOSSIER_VOCAUX, remplacerFetchVoixPourTests } from "./voix";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VOCAUX DE L'ASSISTANT IA « COMME WHATSAPP » — bancs de COMPORTEMENT.
 *
 * Le moteur de parole est un `fetch` INJECTÉ (aucun réseau) : il rend une transcription pour
 * `/audio/transcriptions` et des octets MP3 pour `/audio/speech`, et il GARDE ce qu'on lui a envoyé.
 * Le modèle est le faux modèle. On vérifie : le vocal part comme un message, il est transcrit, la
 * transcription est gardée (affichée sous le lecteur) et c'est elle que le modèle reçoit ; la
 * réponse vocale est un fichier du Drive de la personne, jamais du base64 dans le fil ; les appels
 * sont journalisés ; un vocal intranscriptible le DIT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iavoix_${Date.now().toString(36)}_`;
let moi: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const envois: { url: string; corps: unknown }[] = [];

function moteur(transcription: string | null) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    envois.push({ url: u, corps: init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `fichier:${(v as File).name}`])) : init?.body });
    if (u.endsWith("/audio/transcriptions")) {
      if (transcription === null) return new Response("format illisible", { status: 400 });
      return Response.json({ text: transcription, language: "french", duration: 4.2, segments: [{ start: 0, end: 4.2, text: transcription }] });
    }
    if (u.endsWith("/audio/speech")) return new Response(new Uint8Array(32_000).fill(7), { status: 200, headers: { "content-type": "audio/mpeg" } });
    return new Response("inconnu", { status: 404 });
  }) as typeof fetch;
}

const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

suite("Assistant IA — messages vocaux et réponse vocale", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    const u = await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    moi = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  });
  afterEach(() => { remplacerModelesPourTests(null); remplacerFetchVoixPourTests(null); envois.length = 0; });
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    await effacerJournalDe([moi?.id]);
    await prisma.assistantIaFil.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: moi?.id, parentId: { not: null } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: moi?.id } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un vocal part comme un MESSAGE : transcrit, la transcription gardée, et c'est à elle que l'assistant répond — puis il répond aussi À VOIX HAUTE", async () => {
    remplacerFetchVoixPourTests(moteur("Rappelle-moi les échéances de la semaine pour le dossier Cardiozen."));
    const faux = modeleFactice([reponse("Pour Cardiozen, deux échéances cette semaine : mardi et jeudi.")]);
    remplacerModelesPourTests([faux.modele as never]);
    await reglerReponseVocale(moi.id, true);

    const audio = await deposerAudio(moi, Buffer.from("1a45dfa3-faux-webm-opus"), "Vocal banc.webm", "audio/webm");
    expect("id" in audio).toBe(true);
    const id = (audio as { id: string }).id;
    const d = await deposerMessage(moi.id, "", [], { id, dureeS: 4 });
    expect(d.ok).toBe(true);
    await traiterFil(moi.id);

    const { tours, reponseVocale } = await lireFil(moi.id);
    expect(reponseVocale).toBe(true);
    const [question, reponseTour] = tours;
    const vocal = question.vocal as unknown as VocalDuTour;
    expect(vocal).toMatchObject({ id, etat: "TRANSCRIT", dureeS: 4 });
    expect(vocal.transcription).toContain("échéances de la semaine");
    expect(question.etat).toBe(ETAT.TRAITE);

    // Le moteur a reçu le fichier, en détection de langue ; le modèle a reçu la TRANSCRIPTION, marquée « vocal ».
    const stt = envois.find((e) => e.url.endsWith("/audio/transcriptions"));
    expect(stt?.corps).toMatchObject({ file: "fichier:Vocal banc.webm" });
    const prompt = JSON.stringify(faux.promptsRecus[0]);
    expect(prompt).toContain("Rappelle-moi les échéances");
    expect(prompt).toContain("Message vocal");

    // La réponse texte, puis l'audio : un FICHIER du Drive de la personne, dans son dossier des vocaux.
    expect(reponseTour.contenu).toContain("deux échéances");
    const rep = reponseTour.audio as unknown as AudioDuTour;
    expect(rep.id).toMatch(/^c/);
    const noeud = await prisma.driveNode.findUnique({ where: { id: rep.id }, select: { ownerId: true, mimeType: true, parent: { select: { name: true, ownerId: true } } } });
    expect(noeud).toMatchObject({ ownerId: moi.id, mimeType: "audio/mpeg", parent: { name: NOM_DOSSIER_VOCAUX, ownerId: moi.id } });
    expect(await prisma.driveShare.count({ where: { nodeId: rep.id } })).toBe(0);
    // Jamais de base64 dans le fil.
    expect(JSON.stringify(tours).length).toBeLessThan(20_000);
    const tts = envois.find((e) => e.url.endsWith("/audio/speech"));
    expect(String(tts?.corps)).toContain("deux échéances");

    // Chaque appel de média est journalisé au nom de la personne.
    const roles = (await prisma.modelCallLog.findMany({ where: { userId: moi.id, feature: "assistant_ia" }, select: { role: true, provider: true } }));
    expect(roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "transcription", provider: "openai-audio" }),
      expect.objectContaining({ role: "synthese", provider: "openai-audio" }),
    ]));
    await reglerReponseVocale(moi.id, false);
  });

  it("un vocal que le moteur ne sait pas lire : la réponse le DIT, rien n'est envoyé au modèle", async () => {
    remplacerFetchVoixPourTests(moteur(null));
    const faux = modeleFactice([reponse("ne devrait pas être appelé")]);
    remplacerModelesPourTests([faux.modele as never]);
    const audio = (await deposerAudio(moi, Buffer.from("illisible"), "Vocal illisible.webm", "audio/webm")) as { id: string };
    await deposerMessage(moi.id, "", [], { id: audio.id, dureeS: 2 });
    await traiterFil(moi.id);
    const { tours } = await lireFil(moi.id);
    const dernier = tours[tours.length - 1];
    expect(dernier.etat).toBe(ETAT.ECHEC);
    expect(dernier.contenu).toMatch(/Le vocal n'a pas pu être transcrit : Erreur de transcription \(HTTP 400\)/);
    expect(faux.promptsRecus).toHaveLength(0);
    expect((tours[tours.length - 2].vocal as unknown as VocalDuTour).etat).toBe("ECHEC");
  });

  it("l'interrupteur général coupé : la transcription ne part pas, et la phrase du refus est rendue", async () => {
    remplacerFetchVoixPourTests(moteur("ne doit pas partir"));
    remplacerLecteurInterrupteurIaPourTests(async () => true);
    const r = await auNomDe(moi.id, () => transcrireMedia(Buffer.from("x"), "a.webm"));
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    expect(r.ok).toBe(false);
    expect(envois).toHaveLength(0);
  });
});
