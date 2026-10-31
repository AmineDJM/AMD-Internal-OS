import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { cibleDe, lireConsommation } from "./infra/consommation-detail";
import { coutJournal } from "@/platform/ia/telemetry/cout-journal";
import { sommeFacture, rapprocherOpenAI } from "./infra/consommation-rapprochement";
import { additionner, intervallesResumes, periodeChoisie, soustraire, totauxVides, usageDe, versCsv } from "./domaine/consommation-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOMMATION PRÉCISE (lot K8, décision 0035) — trois promesses, chacune tenue par un test :
 *
 *   1. LE RBAC : une personne ne lit QUE sa consommation ; « toute l'entreprise » est au Super Admin seul.
 *   2. L'EXHAUSTIVITÉ : tout fichier qui appelle un point payant d'un fournisseur d'IA écrit une ligne au
 *      journal (ou y est rangé, avec sa raison, dans `SANS_JOURNAL_ICI`).
 *   3. LE COÛT : calculé à la grille, en entiers, ventilé — et « inconnu » jamais présenté comme 0 $.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le périmètre — une garde, pas un filtre d'écran", () => {
  it("« moi » lit la personne connectée, quelle que soit la personne demandée", () => {
    expect(cibleDe({ perimetre: "moi", userId: "u1", estSuperAdmin: false, personne: "u2" })).toEqual({ userId: "u1" });
    expect(cibleDe({ perimetre: "moi", userId: "u1", estSuperAdmin: true, personne: "u2" })).toEqual({ userId: "u1" });
  });
  it("« entreprise » est refusé à qui n'est pas Super Admin", () => {
    expect(cibleDe({ perimetre: "entreprise", userId: "u1", estSuperAdmin: false })).toHaveProperty("refus");
  });
  it("le Super Admin lit tout, ou une personne", () => {
    expect(cibleDe({ perimetre: "entreprise", userId: "sa", estSuperAdmin: true })).toEqual({ userId: null });
    expect(cibleDe({ perimetre: "entreprise", userId: "sa", estSuperAdmin: true, personne: "u2" })).toEqual({ userId: "u2" });
  });
});

const TAG = `__k8_${Date.now().toString(36)}_`;
const base = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);

describe.skipIf(!base)("contre la vraie base : ma consommation, et celle de l'entreprise", () => {
  const a = `${TAG}a`, b = `${TAG}b`;
  // Une fenêtre FUTURE (2099) : les lignes des autres bancs n'y tombent pas.
  const now = new Date("2099-03-15T10:00:00Z");
  const at = new Date("2099-03-15T09:00:00Z");

  // Le jour 2099-03-15 appartient à ce banc : ce qu'un run interrompu y a laissé est effacé avant, et après.
  const nettoyer = () => prisma.modelCallLog.deleteMany({ where: { at: { gte: new Date("2099-03-14T00:00:00Z"), lt: new Date("2099-03-17T00:00:00Z") } } });
  beforeAll(nettoyer);
  afterAll(nettoyer);

  it("chaque personne ne voit que ses appels ; le Super Admin voit tout, par personne", async () => {
    const ligne = (userId: string | null, model: string, entree: number, sortie: number, costUsd: string | null, extra: Record<string, unknown> = {}) => ({
      at, userId, role: "conversation", provider: "openai", model, feature: "assistant_ia", inputTokens: entree, outputTokens: sortie, costUsd, ...extra,
    });
    await prisma.modelCallLog.createMany({
      data: [
        ligne(a, "gpt-6.1-terra", 10_000, 500, "0.004900", { cachedInputTokens: 8_000, threadId: `${TAG}fil` }),
        ligne(a, "gpt-realtime-2.1", 3_000, 1_500, "0.127480", { role: "realtime", feature: "voice_realtime", audioInputTokens: 2_000, cachedAudioInputTokens: 500, cachedInputTokens: 700, audioOutputTokens: 1_000 }),
        ligne(b, "gpt-6.1-terra", 1_000_000, 0, "1.000000"),
        ligne(b, `${TAG}inconnu`, 5, 5, null),
        ligne(null, "gpt-5.6-luna", 1_000_000, 1_000_000, "0.700000", { role: "bulk", feature: null, batch: true }),
      ],
    });
    const lireMoi = (userId: string) => lireConsommation({ perimetre: "moi", userId, estSuperAdmin: false, du: "2099-03-15", au: "2099-03-15", now });

    const va = await lireMoi(a);
    if ("refus" in va) throw new Error(va.refus);
    expect(va.totaux.appels).toBe(2);
    expect(va.totaux.coutUsd).toBe("0.132380");
    expect(va.totaux.audioEntree).toBe(2_000);
    expect(va.appels.map((x) => x.modele).sort()).toEqual(["gpt-6.1-terra", "gpt-realtime-2.1"]);
    expect(va.parPersonne).toEqual([]);
    expect(va.plafonds).toBeNull();
    expect(va.rapprochement).toBeNull();
    // Les postes à la grille retrouvent exactement le journal.
    expect(additionner(va.postes.map((p) => p.coutUsd))).toBe("0.132380");
    expect(va.parUsage.map((u) => u.libelle).sort()).toEqual(["Conversation", "Voix (temps réel)"]);
    expect(va.parConversation).toHaveLength(1);
    expect(va.resumes.find((r) => r.cle === "aujourdhui")?.totaux.appels).toBe(2);

    const vb = await lireMoi(b);
    if ("refus" in vb) throw new Error(vb.refus);
    expect(vb.totaux.appels).toBe(2);
    expect(vb.totaux.sansTarif).toBe(1);
    expect(vb.totaux.coutUsd).toBe("1.000000");
    expect(vb.appels.some((x) => x.coutUsd == null)).toBe(true);

    const refus = await lireConsommation({ perimetre: "entreprise", userId: a, estSuperAdmin: false, du: "2099-03-15", au: "2099-03-15", now });
    expect(refus).toHaveProperty("refus");

    const tout = await lireConsommation({ perimetre: "entreprise", userId: "admin", estSuperAdmin: true, du: "2099-03-15", au: "2099-03-15", now });
    if ("refus" in tout) throw new Error(tout.refus);
    expect(tout.totaux.appels).toBe(5);
    expect(tout.totaux.coutUsd).toBe("1.832380");
    expect(tout.parPersonne.map((p) => p.cle).sort()).toEqual([a, b, "systeme"].sort());
    expect(tout.plafonds).not.toBeNull();
    expect(tout.rapprochement?.configure).toBe(!!process.env.OPENAI_ADMIN_KEY);
    expect(tout.parModele.find((m) => m.cle.endsWith("/lot"))?.coutUsd).toBe("0.700000");
  });
});

describe("le coût d'une ligne du journal", () => {
  it("la grille calcule ; un tarif posé dans l'environnement prime ; hors grille sans tarif : inconnu", () => {
    const u = { model: "gpt-6.1-terra", inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 500, costUsd: 0.0123 };
    expect(coutJournal(u, { tarifPose: false })).toMatchObject({ costUsd: "0.004900", priceGrid: "2026-10-31" });
    expect(coutJournal(u, { tarifPose: true })).toMatchObject({ costUsd: "0.012300", priceGrid: "env" });
    expect(coutJournal({ ...u, model: "gpt-x" }, { tarifPose: false })).toMatchObject({ costUsd: null, priceGrid: null });
  });
  it("GPT-Live : les équivalents nourrissent le plafond, la durée seule se facture, la ligne est marquée estimée", () => {
    const r = coutJournal({ model: "gpt-live-1", inputTokens: 600, outputTokens: 0, cachedInputTokens: 0, costUsd: null, durationMs: 60_000, equivalents: true }, { tarifPose: false });
    expect(r.costUsd).toBe("0.050000");
    expect(r.colonnes).toMatchObject({ durationMs: 60_000, estimated: true });
  });
});

describe("le rapprochement", () => {
  it("sans clé administrateur : le dit, n'invente rien", async () => {
    const r = await rapprocherOpenAI(new Date(), new Date(), totauxVides(), { env: {} as NodeJS.ProcessEnv });
    expect(r.configure).toBe(false);
    expect(r.message).toMatch(/non configuré/);
    expect(r.factureUsd).toBeUndefined();
  });
  it("la facture se somme au micro-dollar (dollars seulement)", () => {
    expect(sommeFacture([{ data: [{ results: [{ amount: { value: 0.1234567, currency: "usd" } }, { amount: { value: 2, currency: "usd" } }, { amount: { value: 5, currency: "eur" } }] }] }])).toBe("2.123457");
    expect(soustraire("2.000000", "2.500001")).toBe("-0.500001");
  });
});

describe("l'écran — périodes, usages, export", () => {
  it("les périodes sont des jours d'Alger, le mois précédent finit où commence le mois en cours", () => {
    const i = intervallesResumes(new Date("2026-10-31T23:30:00Z")); // 00 h 30 le 1er novembre à Alger
    expect(i.aujourdhui.debut.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(i.mois.debut.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(i.moisPrecedent.debut.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(i.moisPrecedent.fin).toEqual(i.mois.debut);
    const p = periodeChoisie("2026-10-01", "2026-10-31", new Date());
    expect(p.debut.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(p.fin.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
  it("chaque usage a un nom ; un usage inconnu reste visible sous son nom brut", () => {
    expect(usageDe("voice_realtime", "realtime", "voice-direct").cle).toBe("voix");
    expect(usageDe("assistant_ia", "image", "image").libelle).toBe("Images");
    expect(usageDe(null, "bulk", null).cle).toBe("fond");
    expect(usageDe("truc", "machin", null).libelle).toBe("truc / machin");
  });
  it("le CSV s'ouvre dans Excel en français (BOM, « ; », guillemets)", () => {
    expect(versCsv([["a;b", 1], ['dit "oui"', "0.000001"]])).toBe('﻿"a;b";1\r\n"dit ""oui""";0.000001\r\n');
  });
});

// ─────────────────────────────── L'EXHAUSTIVITÉ ───────────────────────────────

/**
 * LES POINTS PAYANTS — l'URL d'un fournisseur d'IA qui se facture. Tout fichier de `src/` qui en appelle un doit
 * contenir une écriture du journal (`recordModelCall`, `recordProviderCall`, `journaliser*`, l'inscription du budget
 * de l'Assistant IA) — ou figurer ci-dessous, avec la raison pour laquelle le journal est écrit AILLEURS.
 */
const POINTS_PAYANTS = [
  /\/audio\/transcriptions/, /\/audio\/speech/, /["'`]\/embeddings/, /\/images\/(generations|edits)/, /["'`]\/videos["'`]/,
  /\/chat\/completions/, /urlOpenAI\(["'`]\/responses/, /generativelanguage\.googleapis\.com/, /\/v1\/messages/, /ocrUrl\(\)/,
  /\/realtime\/(client_secrets|calls)/, /\/live\/sessions/,
];
const JOURNAL = /recordModelCall|recordProviderCall|journaliserVisuel|journaliserSessionVocale|inscrire\(|enregistrer\(|journaliser[A-Z]\w*\(/;
const SANS_JOURNAL_ICI: Record<string, string> = {
  "src/modules/assistant-ia/infra/visuels/fournisseurs.ts": "les images et vidéos sont journalisées par `visuels/service.ts` (`journaliserVisuel`), avec l'usage rendu",
  "src/modules/assistant-ia/infra/lecture/voix.ts": "la synthèse s'inscrit au budget par `appelVoix` (`inscrire`) — fichier vérifié par le motif",
  "src/lib/assistant/voice-realtime.ts": "la clé éphémère est gratuite ; la session vocale est journalisée à sa fin (`/api/assistant/voice/log` → `journaliserSessionVocale`, usage de `response.done`)",
  "src/components/chief/realtime-voice/fournisseur.ts": "WebRTC côté navigateur : l'usage de `response.done` est cumulé et remis au serveur à la fin de session",
  "src/platform/ia/voix/session-temps-reel.ts": "l'ouverture GPT-Live est gratuite ; la durée est journalisée à la fin (`infra/voix/temps-reel.ts`, `appelVoix`)",
  "src/lib/models/openai-responses/flux.ts": "le flux rend son usage à la passerelle (`gateway.ts` → `recordModelCall`)",
  "src/lib/models/openai.ts": "rend son usage à la passerelle (`gateway.ts` → `recordModelCall`)",
  "src/lib/models/protocol.ts": "nomme les points dans ses messages d'erreur ; n'appelle rien",
  "src/lib/models/anthropic.ts": "rend son usage à la passerelle (`gateway.ts` → `recordModelCall`)",
};

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "testing") fichiers(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe("l'exhaustivité du journal", () => {
  const racine = join(process.cwd(), "src");
  const appelants = fichiers(racine)
    // Les commentaires ne paient rien : seul le CODE est lu.
    .map((p) => ({ p: p.slice(process.cwd().length + 1), s: readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") }))
    .filter(({ s }) => POINTS_PAYANTS.some((r) => r.test(s)) && /fetch\(|f\(|fetchImpl/.test(s));

  it("on trouve bien les appelants (le motif n'est pas devenu aveugle)", () => {
    expect(appelants.length).toBeGreaterThanOrEqual(10);
  });

  it("chaque fichier qui appelle un point payant écrit au journal, ou dit où il est écrit", () => {
    const trous = appelants.filter(({ p, s }) => !JOURNAL.test(s) && !SANS_JOURNAL_ICI[p]).map(({ p }) => p);
    expect(trous, `Appels payants sans ligne ModelCallLog : ${trous.join(", ")}`).toEqual([]);
  });

  it("la liste des exceptions ne vieillit pas : chaque entrée existe encore", () => {
    const fantomes = Object.keys(SANS_JOURNAL_ICI).filter((p) => { try { return !statSync(join(process.cwd(), p)).isFile(); } catch { return true; } });
    expect(fantomes).toEqual([]);
  });

  it("les trous bouchés au lot K8 le restent", () => {
    const lire = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(lire("src/lib/openai-luna.ts")).toMatch(/journaliserLuna\(String\(body\.model\)/);
    expect(lire("src/lib/openai-luna.ts")).toMatch(/recordProviderCall\(\{\s*role: "bulk", provider: "openai", model: lunaEmbedModel\(\)/);
    expect(lire("src/lib/media/stt.ts")).toMatch(/recordProviderCall/);
    expect(lire("src/lib/ai.ts")).toMatch(/recordProviderCall\(\{ role: "stt"/);
    expect(lire("src/lib/regulatory/intelligence/ocr/mistral-ocr.ts")).toMatch(/provider: "mistral"/);
    expect(lire("src/lib/regulatory/intelligence/cost/batch-runner.ts")).toMatch(/batch: true \}\)/);
    expect(lire("src/instrumentation.ts")).toMatch(/usage-sink/);
  });
});
