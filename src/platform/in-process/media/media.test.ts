import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { consignerMesure } from "@/lib/evals/registre";
import { chargerMupdf } from "@/lib/artifact/adapters/pdf/adapter";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { extractAttachmentText } from "@/platform/ia/media/assistant-files";
import type { ResultatStt } from "@/lib/media/stt";
import { lireDocumentParPaliers } from "./lecture";
import { chercherDansMediaDrive, regarderVideoDrive, transcrireMediaDrive } from "./transcription";
import { __forcerFfmpeg } from "@/platform/ia/media/ffmpeg";

/**
 * MÉDIAS ET DOCUMENTS (§38), depuis les VRAIS points d'entrée : un PDF du Drive lu par paliers, un
 * enregistrement transcrit (moteur de parole injecté — le contrat, pas le réseau), persisté, indexé,
 * cherché à la seconde ; une vidéo dont les images ne peuvent pas être regardées sans ffmpeg — et qui
 * le DIT. Sans clé de modèle : la diarisation et l'extraction sont dites non faites, jamais inventées.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__med${Date.now().toString(36)}`;
let user: CurrentUser;
let pdfId = ""; let pdfMixteId = ""; let audioId = ""; let videoId = "";
let cleSauvee: string | undefined;

const SEGMENTS = [
  { debut: 0, fin: 4, texte: "Bonjour à tous, on commence par le point réglementaire.", locuteur: null },
  { debut: 4, fin: 11, texte: "Le dossier Trastuzex est complet, il part à l'agence lundi.", locuteur: null },
  { debut: 24, fin: 31, texte: "Passons au budget. Le budget marketing 2027 doit baisser de dix pour cent.", locuteur: null },
  { debut: 31, fin: 38, texte: "Je propose de couper le congrès de Marseille et de garder Alger.", locuteur: null },
  { debut: 52, fin: 58, texte: "Dernier point, le recrutement du délégué de Constantine.", locuteur: null },
  { debut: 58, fin: 66, texte: "Yassine, tu envoies la fiche de poste à la DRH avant vendredi.", locuteur: null },
];
const sttFactice = async (): Promise<ResultatStt> => ({ ok: true, texte: SEGMENTS.map((s) => s.texte).join(" "), langue: "french", dureeS: 66, segments: SEGMENTS.map((s) => ({ ...s })), modele: "whisper-test", ms: 5, horodate: true });

/** Des pages avec une vraie couche texte (≥ 40 caractères chacune) : c'est ce que le palier NATIF reconnaît comme lu. */
async function pdfTexte(n: number): Promise<Buffer> {
  const mupdf = await chargerMupdf();
  const doc = new mupdf.PDFDocument();
  const police = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 1; i <= n; i += 1) {
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: police } }, `BT /F1 18 Tf 60 700 Td (Page ${i} du rapport annuel : chiffre d'affaires, marge et effectifs de la periode.) Tj ET`));
  }
  return Buffer.from(doc.saveToBuffer("").asUint8Array());
}

async function pdfMixte(): Promise<Buffer> {
  // Page 1 avec du texte, page 2 BLANCHE (un scan sans couche texte) : c'est elle qui appelle le repli.
  const mupdf = await chargerMupdf();
  const doc = new mupdf.PDFDocument();
  const police = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: police } }, "BT /F1 24 Tf 60 700 Td (Contrat de distribution Kwality, article 1 : objet du contrat et territoire.) Tj ET"));
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ""));
  const octets = doc.saveToBuffer("").asUint8Array();
  return Buffer.from(octets);
}

suite("médias et documents (§38) — paliers sur un PDF réel, transcription persistée et cherchée, vidéo sans ffmpeg", () => {
  beforeAll(async () => {
    cleSauvee = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; // aucun appel de modèle dans ce banc
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    user = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    pdfId = (await portsArtefact.documents.creerFichier(user.id, { nom: `${TAG} Rapport annuel.pdf`, octets: await pdfTexte(6), mime: "application/pdf" })).nodeId;
    pdfMixteId = (await portsArtefact.documents.creerFichier(user.id, { nom: `${TAG} Contrat scanné.pdf`, octets: await pdfMixte(), mime: "application/pdf" })).nodeId;
    audioId = (await portsArtefact.documents.creerFichier(user.id, { nom: `${TAG} Réunion budget.m4a`, octets: Buffer.from("faux-audio"), mime: "audio/mp4" })).nodeId;
    videoId = (await portsArtefact.documents.creerFichier(user.id, { nom: `${TAG} Démo produit.mp4`, octets: Buffer.from("fausse-video"), mime: "video/mp4" })).nodeId;
  }, 90_000);

  afterAll(async () => {
    if (cleSauvee !== undefined) process.env.OPENAI_API_KEY = cleSauvee;
    __forcerFfmpeg(null);
    await prisma.mediaTranscript.deleteMany({ where: { nodeId: { in: [audioId, videoId] } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }, 60_000);

  it("un PDF natif se lit au premier palier, quelle que soit l'exigence : VÉRIFIÉ, aucun repli, coût nul", async () => {
    const r = await lireDocumentParPaliers(user, { nodeId: pdfId }, { pages: "1-3", exigence: "precis" });
    expect(r.ok, r.ok ? "" : r.motif).toBe(true);
    if (!r.ok) return;
    expect(r.pages.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(r.pages.every((p) => p.methode === "NATIF" && p.confiance === "VERIFIE")).toBe(true);
    expect(r.pages[0]!.texte).toContain("Page 1");
    expect(r.faits).toEqual([]);
    expect(r.coutUsd).toBe(0);
    expect(r.parMethode.NATIF).toBe(3);
    expect(r.document.pages).toBe(6);
  }, 60_000);

  it("une page blanche appelle l'OCR ; sans budget elle reste HORS BUDGET — dite, jamais devinée ; `ocr: false` ne replie rien", async () => {
    const sans = await lireDocumentParPaliers(user, { nodeId: pdfMixteId }, { exigence: "auto", budget: { ocr: 0, visionRapide: 0, visionSuperieure: 0 } });
    expect(sans.ok, sans.ok ? "" : sans.motif).toBe(true);
    if (!sans.ok) return;
    expect(sans.pages[0]).toMatchObject({ n: 1, methode: "NATIF", confiance: "VERIFIE" });
    expect(sans.pages[0]!.texte).toContain("Kwality");
    expect(sans.pages[1]).toMatchObject({ n: 2, methode: "SANS", confiance: "ABSENT", texte: "" });
    expect(sans.horsBudget).toEqual([{ n: 2, palier: "OCR", raison: "aucun texte natif" }]);
    expect(sans.bilan.join(" | ")).toMatch(/hors budget OCR \(2\)/);
    const brut = await lireDocumentParPaliers(user, { nodeId: pdfMixteId }, { ocr: false });
    expect(brut.ok && brut.exigence).toBe("sans-repli");
    if (brut.ok) { expect(brut.horsBudget).toEqual([]); expect(brut.parMethode.SANS).toBe(1); }
    // La question marque la page visée : « Kwality » est page 1.
    const visee = await lireDocumentParPaliers(user, { nodeId: pdfMixteId }, { question: "Kwality", ocr: false });
    if (visee.ok) expect(visee.pages.find((p) => p.n === 1)?.visee).toBe(true);
  }, 60_000);

  it("un enregistrement se transcrit UNE fois (moteur injecté), se persiste, s'indexe, se cherche à la seconde ; sans modèle, les locuteurs et l'extraction sont dits non faits", async () => {
    const t = await transcrireMediaDrive(user, { nom: `${TAG} Réunion budget` }, { transcrire: sttFactice, participants: ["Yassine", "Raihana"] });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.vue.segments).toHaveLength(6);
    expect(t.vue.chapitres.length).toBeGreaterThanOrEqual(2);
    expect(t.vue.stats).toMatchObject({ dureeS: 66, segments: 6, locuteurs: 0 });
    expect(t.vue.extraction).toBeNull();
    expect(t.vue.limites.join(" | ")).toMatch(/locuteurs non attribués/);
    expect(t.vue.limites.join(" | ")).toMatch(/extraction non faite/);
    expect(t.vue.depuisCache).toBe(false);
    const row = await prisma.mediaTranscript.findUnique({ where: { nodeId_version: { nodeId: audioId, version: t.vue.version } } });
    expect(row).not.toBeNull();
    expect(row!.texte).toContain("[00:24] Passons au budget.");
    expect(row!.modele).toBe("whisper-test");

    // OÙ EXACTEMENT : l'instant du segment, pas un résumé — et la seconde lecture vient du cache (aucun moteur appelé).
    const c = await chercherDansMediaDrive(user, { nom: `${TAG} Réunion budget` }, "budget marketing");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.depuisCache).toBe(true);
    expect(c.occurrences).toHaveLength(1);
    expect(c.occurrences[0]).toMatchObject({ debut: 24, horodatage: "00:24", score: 1 });
    expect(c.occurrences[0]!.extrait).toContain("budget marketing 2027");
    const rien = await chercherDansMediaDrive(user, { nodeId: audioId }, "budget", { locuteur: "Yassine" });
    if (rien.ok) expect(rien.occurrences).toEqual([]); // aucun locuteur attribué : le filtre ne trouve personne, il n'invente pas
    consignerMesure("media_instant_exact", { n: 1, ok: c.occurrences[0]?.debut === 24 ? 1 : 0 }, "platform/in-process/media/media.test.ts", "« budget marketing » situé à 00:24 depuis le Drive");
  }, 60_000);

  it("l'outil `media_transcript` : chercher rend l'instant ; structure rend chapitres et limites ; un fichier qui n'est pas un média est refusé", async () => {
    const cherche = JSON.parse((await executePowerTool("media_transcript", { action: "chercher", nom: `${TAG} Réunion budget`, requete: "Marseille" }, user)) ?? "{}") as { fait: boolean; occurrences: { horodatage: string }[] };
    expect(cherche.fait).toBe(true);
    expect(cherche.occurrences.map((o) => o.horodatage)).toEqual(["00:31"]);
    const structure = JSON.parse((await executePowerTool("media_transcript", { action: "structure", nodeId: audioId }, user)) ?? "{}") as { fait: boolean; chapitres: unknown[]; limites: string[]; depuisCache: boolean };
    expect(structure.fait).toBe(true);
    expect(structure.chapitres.length).toBeGreaterThanOrEqual(2);
    expect(structure.depuisCache).toBe(true);
    const pasUnMedia = JSON.parse((await executePowerTool("media_transcript", { action: "transcrire", nodeId: pdfId }, user)) ?? "{}") as { fait: boolean; message: string };
    expect(pasUnMedia.fait).toBe(false);
    expect(pasUnMedia.message).toMatch(/ni un audio ni une vidéo/);
  }, 60_000);

  it("une vidéo : la piste audio est transcrite ; sans ffmpeg, les images ne sont pas regardées et la limite est DITE ; un audio n'a rien à regarder", async () => {
    const t = await transcrireMediaDrive(user, { nodeId: videoId }, { transcrire: sttFactice });
    expect(t.ok).toBe(true);
    __forcerFfmpeg(false);
    const r = await regarderVideoDrive(user, { nodeId: videoId }, { requete: "budget" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images).toEqual([]);
    expect(r.instants).toEqual([28]);
    expect(r.limites.join(" | ")).toMatch(/ffmpeg/);
    const audio = await regarderVideoDrive(user, { nodeId: audioId }, {});
    expect(audio.ok).toBe(false);
    if (!audio.ok) expect(audio.motif).toMatch(/rien à regarder/);
  }, 60_000);

  it("une pièce jointe audio sans moteur configuré est dite non transcrite — jamais un texte inventé", async () => {
    const r = await extractAttachmentText("note vocale.m4a", Buffer.from("faux"));
    expect(r.text).toBe("");
    expect(r.note).toMatch(/non transcrit/);
  });
});
