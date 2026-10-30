import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { executerOperationIA } from "../operations";
import { capterPhoto, capterVocal, lireCaptations, remplacerFetchTerrainPourTests } from "./captation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VOCAL DE TERRAIN DEVIENT UN COMPTE RENDU PRÊT (lot J13, décision 0025) — banc de COMPORTEMENT, vraie base.
 *
 * Le moteur de parole rejoue les transcriptions RÉELLES du banc STT (`data/bancs/terrain-voix/resultats.json`,
 * `gpt-transcribe` + indice) ; le modèle est le faux modèle. On vérifie : la transcription part avec l'indice et sans
 * langue forcée ; le médecin est résolu dans l'annuaire DU délégué ; trois cartes (compte rendu, échantillons, tournée)
 * et RIEN d'écrit avant le clic ; un renvoi de la même clé ne refait rien ; la confirmation passe par l'action de
 * l'écran (brouillon de rapport pré-rempli) ; le tout sous la cible de 30 s ; la photo devient faits + carte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__terrain_${Date.now().toString(36)}_`;
let delegue: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const envois: Record<string, unknown>[] = [];
const banc = JSON.parse(fs.readFileSync("data/bancs/terrain-voix/resultats.json", "utf8")) as { lignes: { moteur: string; indice: boolean; clip: string; texte?: string }[] };
const transcriptionReelle = (clip: string) => banc.lignes.find((l) => l.moteur === "gpt-transcribe" && l.indice && l.clip === clip)!.texte!;

function moteur(texte: string) {
  return (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/audio/transcriptions") && init?.body instanceof FormData) {
      envois.push(Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "fichier"])));
      return Response.json({ text: texte });
    }
    return new Response("inconnu", { status: 404 });
  }) as typeof fetch;
}

const cr = (o: Record<string, unknown>) => ({ texte: JSON.stringify({
  medecin: null, etablissement: null, specialite: null, produits: [], interet: null, objections: null, demandes: [], revoirDemain: false, aConfirmer: [], ...o,
}) });

suite("Terrain — vocal → compte rendu prêt, photo → faits", () => {
  let medecinId = "";
  let articleId = "";
  let catId = "";
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    const u = await prisma.user.create({ data: { name: `${TAG}kam`, email: `${TAG}kam@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
    const access = await getAccess(u.id, u.role);
    delegue = { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
    ACTEUR = delegue;
    medecinId = (await prisma.medicalDoctor.create({ data: { name: `BEN ALI ${TAG}Karim`, institution: "CHU Oran", delegateId: u.id }, select: { id: true } })).id;
    await prisma.medicalDoctor.create({ data: { name: `BENALLAL ${TAG}Sofiane`, institution: "EHU Oran", delegateId: u.id } });
    catId = (await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}CAT`, nom: "Échantillon", famille: "CONSOMMABLE" }, select: { id: true } })).id;
    articleId = (await prisma.promoStockItem.create({ data: { name: `Cardiovex ${TAG}échantillon`, catalogueId: catId }, select: { id: true } })).id;
  });
  afterEach(() => { remplacerModelesPourTests(null); remplacerFetchTerrainPourTests(null); envois.length = 0; });
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    await effacerJournalDe([delegue?.id]);
    await prisma.assistantIaTerrainCapture.deleteMany({ where: { userId: delegue?.id } });
    await prisma.assistantActionIntent.deleteMany({ where: { userId: delegue?.id } });
    await prisma.fieldReport.deleteMany({ where: { delegateId: delegue?.id } });
    await prisma.promoStockItem.deleteMany({ where: { id: articleId } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { id: catId } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { contains: TAG } } });
  });

  it("darija mêlée de français : transcription avec indice, médecin résolu, trois cartes, rien d'écrit, sous 30 s", async () => {
    remplacerFetchTerrainPourTests(moteur(transcriptionReelle("darja-melange")));
    remplacerModelesPourTests([modeleFactice([cr({
      medecin: "Benali", etablissement: "CHU Oran", produits: ["Cardiovex"], revoirDemain: true,
      demandes: [{ nature: "ECHANTILLONS", produit: "Cardiovex", quantite: 10, detail: "dix boîtes d'échantillons" }],
      synthese: "Le Dr Benali (CHU Oran) est très intéressé par la gamme Cardiovex et demande dix boîtes d'échantillons. À revoir demain matin.",
    })]).modele as never]);
    const r = await capterVocal(delegue, { cle: `${TAG}vocal1`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("faux-webm"), nom: "vocal.webm", mime: "audio/webm", dureeS: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.captation;
    expect(c.etat).toBe("PRET");
    // Le moteur écrit les mots français EN LETTRES ARABES (« أنتريسي », « ديزيشانطيو ») : la transcription réelle est arabe.
    expect(c.langue).toBe("ar");
    expect(envois[0].model).toBe("gpt-transcribe");
    expect(envois[0].language).toBeUndefined();
    expect(String(envois[0].prompt)).toContain("BEN ALI");
    expect(c.notes).toEqual([]);
    expect(c.cartes.map((x) => x.op)).toEqual(["terrain_compte_rendu", "terrain_demande_materiel", "terrain_tournee_demain"]);
    expect(c.cartes[0].fields.find((f) => f.label === "Médecin")?.value).toContain("(annuaire)");
    expect(c.msTotal).toBeLessThan(30_000);
    // RIEN D'ÉCRIT avant le clic.
    expect(await prisma.fieldReport.count({ where: { delegateId: delegue.id } })).toBe(0);
    expect(await prisma.promoStockRequest.count({ where: { demandeurId: delegue.id } })).toBe(0);

    // La même clé renvoyée par la file : la même captation, aucun nouvel appel.
    const bis = await capterVocal(delegue, { cle: `${TAG}vocal1`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("faux-webm"), nom: "vocal.webm", mime: "audio/webm" });
    expect(bis.ok && bis.deja && bis.captation.id === c.id).toBe(true);
    expect(envois.length).toBe(1);

    // Le clic : l'action de l'écran crée le brouillon pré-rempli.
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: c.cartes[0].intentId }, select: { payload: true } });
    const x = await executerOperationIA(delegue, intent!.payload);
    expect(x.ok).toBe(true);
    const rapport = await prisma.fieldReport.findFirst({ where: { delegateId: delegue.id }, select: { status: true, doctorIds: true, summary: true, institution: true } });
    expect(rapport).toMatchObject({ status: "DRAFT", doctorIds: [medecinId], institution: "CHU Oran" });
    expect(rapport!.summary).toContain("Cardiovex");
  });

  it("un vocal sans parole le dit ; une structuration hors forme garde la transcription comme synthèse", async () => {
    remplacerFetchTerrainPourTests(moteur("  "));
    const vide = await capterVocal(delegue, { cle: `${TAG}vide`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("x"), nom: "v.webm", mime: "audio/webm" });
    expect(vide.ok && vide.captation.etat).toBe("ECHEC");
    remplacerFetchTerrainPourTests(moteur(transcriptionReelle("fr-simple")));
    remplacerModelesPourTests([modeleFactice([{ texte: "désolé, je ne peux pas" }]).modele as never]);
    const r = await capterVocal(delegue, { cle: `${TAG}horsforme`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("y"), nom: "v.webm", mime: "audio/webm" });
    expect(r.ok && r.captation.etat).toBe("PRET");
    if (r.ok) {
      expect(r.captation.compteRendu?.synthese).toContain("Benali");
      expect(r.captation.cartes[0].warnings.join(" ")).toContain("structuration illisible");
    }
  });

  it("une clé invalide ou un nom de pièce protégée est refusé définitivement (la file le garde, en erreur)", async () => {
    expect(await capterVocal(delegue, { cle: "x", octets: Buffer.from("a"), nom: "v.webm", mime: "audio/webm" })).toMatchObject({ ok: false, definitif: true });
    const p = await capterPhoto(delegue, { cle: `${TAG}rib`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("png"), nom: "RIB société.png", mime: "image/png" });
    expect(p).toMatchObject({ ok: false, definitif: true });
  });

  it("photo d'ordonnance : faits proposés sans le patient, carte de rattachement au compte rendu", async () => {
    remplacerModelesPourTests([modeleFactice([{ texte: JSON.stringify({
      sorte: "ORDONNANCE", resume: "Ordonnance de cardiologie",
      faits: [{ cle: "Nom du patient", valeur: "X Y" }, { cle: "Prescription", valeur: "Cardiovex 5 mg, 1 cp/j, 3 mois" }],
    }) }]).modele as never]);
    const r = await capterPhoto(delegue, { cle: `${TAG}ordo`.replace(/[^A-Za-z0-9_-]/g, ""), octets: Buffer.from("\x89PNG-faux"), nom: "ordonnance.png", mime: "image/png", sorte: "ORDONNANCE" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.captation.photo?.faits).toEqual([{ cle: "Prescription", valeur: "Cardiovex 5 mg, 1 cp/j, 3 mois" }]);
    expect(r.captation.cartes.map((c) => c.op)).toEqual(["terrain_piece_visite"]);
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: r.captation.cartes[0].intentId }, select: { payload: true } });
    expect((await executerOperationIA(delegue, intent!.payload)).ok).toBe(true);
    expect(await prisma.fieldReportAttachment.count({ where: { report: { delegateId: delegue.id } } })).toBe(1);
    expect((await lireCaptations(delegue)).length).toBeGreaterThanOrEqual(3);
  });
});
