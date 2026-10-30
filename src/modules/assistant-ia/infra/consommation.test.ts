import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOMMATION DE L'ASSISTANT IA — COMPTÉE ET BORNÉE (lot V3-D, audit 27/10, IA-ASSISTANT-03).
 *
 * Au faux modèle (aucun appel payant, aucun réseau) et contre la vraie base :
 *   • chaque appel du modèle devient une ligne `ModelCallLog` (personne, conversation, modèle, jetons,
 *     durée, coût), chaque tour une ligne `AiUsageLog` ;
 *   • le plafond d'un TOUR arrête la boucle — l'appel suivant ne part pas — et le dit ;
 *   • le plafond du JOUR refuse avant tout appel, et le Super Admin est prévenu UNE fois ;
 *   • une rédaction lancée pendant un tour compte dans ce tour.
 *
 * Les réglages sont INJECTÉS (`remplacerReglagesPourTests`) : la ligne `AssistantIaReglage` est globale,
 * aucun banc ne l'écrit. Les avis sont interceptés (`notifyUser` simulé) : aucun Super Admin réel de la
 * base n'en reçoit un.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const avis = vi.hoisted(() => ({ envoyes: [] as { userId: string; title: string }[] }));
vi.mock("@/lib/notify", () => ({
  notifyUser: async (n: { userId: string; title: string }) => { avis.envoyes.push({ userId: n.userId, title: n.title }); },
}));

import { prisma } from "@/lib/prisma";
import { repondreAvecSecours } from "./repondre";
import { genererTexte, remplacerModelesPourTests } from "./generer";
import { modeleFactice } from "./testing/modele-factice";
import { effacerJournalDe } from "./testing/journal";
import { auNomDe, jetonsDuJour, PlafondIaAtteint, remplacerReglagesPourTests, tarifDe } from "./consommation";
import {
  borner, coutEstimeUsd, debutJourAlger, ECRAN_CONSOMMATION, jourAlger, normaliserReglages, refusPlafondJour, REGLAGES_PAR_DEFAUT,
} from "../domaine/consommation-regles";

const TAG = `__conso_${Date.now().toString(36)}_`;
const personne = (n: string) => ({ id: `${TAG}${n}`, role: "SUPER_ADMIN" }) as unknown as CurrentUser;
const LOURD = { inputTokens: 900, outputTokens: 100 }; // 1 000 jetons par appel

function outilLecture(): PowerTool {
  return {
    def: { name: "lire", description: "Lecture de test.", input_schema: { type: "object", properties: {} } } as PowerTool["def"],
    allowed: () => true, label: "Lecture", run: async () => "{\"ok\":true}",
  };
}

const tour = (user: CurrentUser, modele: unknown, conversation: string | null = null) => repondreAvecSecours({
  user, message: "Fais le point.", historique: [], instructions: "Banc.", outils: [outilLecture()],
  modeles: [modele as never], delaiMs: 5_000, propositionsFaites: () => 0, maxEtapes: 8, origine: "fil", conversation,
});

const lignes = (userId: string) => prisma.modelCallLog.findMany({ where: { userId, feature: "assistant_ia" }, orderBy: { at: "asc" } });

const comptes: string[] = [];
const compte = (n: string) => { const u = personne(n); comptes.push(u.id); return u; };

describe("règles pures", () => {
  it("le jour est celui d'Alger (UTC+1) : 23 h 30 UTC appartient déjà au lendemain", () => {
    expect(debutJourAlger(new Date("2026-10-28T23:30:00Z")).toISOString()).toBe("2026-10-28T23:00:00.000Z");
    expect(debutJourAlger(new Date("2026-10-28T10:00:00Z")).toISOString()).toBe("2026-10-27T23:00:00.000Z");
    expect(jourAlger(new Date("2026-10-28T23:30:00Z")).toISOString().slice(0, 10)).toBe("2026-10-29");
  });

  it("le coût est INCONNU sans tarif, jamais zéro ; estimé au million de jetons sinon", () => {
    expect(coutEstimeUsd(1_000, 500, null)).toBeNull();
    expect(coutEstimeUsd(1_000_000, 1_000_000, { entreeParM: 0.1, sortieParM: 0.4 })).toBeCloseTo(0.5);
    // Sans variable : la grille publique documentée de gpt-6.1-terra (banc V4-H) ; une variable posée prime.
    expect(tarifDe("openai", {} as NodeJS.ProcessEnv)).toEqual({ entreeParM: 2, sortieParM: 12, cacheParM: 0.2 });
    expect(tarifDe("openai", { ASSISTANT_IA_PRICE_IN: "1.5", ASSISTANT_IA_PRICE_OUT: "6" } as unknown as NodeJS.ProcessEnv)).toEqual({ entreeParM: 1.5, sortieParM: 6, cacheParM: 0.15 });
    expect(tarifDe("openai", { ASSISTANT_IA_PRICE_IN: "1.5", ASSISTANT_IA_PRICE_OUT: "6", ASSISTANT_IA_PRICE_CACHED: "0.3" } as unknown as NodeJS.ProcessEnv)?.cacheParM).toBe(0.3);
    // LE CACHE AU TARIF DU CACHE — mesuré par le banc : 1 002 357 jetons dont 878 619 en cache, 8 227 en sortie → ~0,52 $, pas 2,10 $.
    expect(coutEstimeUsd(1_002_357, 8_227, { entreeParM: 2, sortieParM: 12, cacheParM: 0.2 }, 878_619)).toBeCloseTo(0.5219, 3);
    expect(coutEstimeUsd(1_002_357, 8_227, { entreeParM: 2, sortieParM: 12 }, 878_619)).toBeCloseTo(2.1034, 3);
    expect(tarifDe("mimo", {} as NodeJS.ProcessEnv)).toBeNull();
    expect(tarifDe("mimo", { MIMO_PRICE_IN: "0.1", MIMO_PRICE_OUT: "0.4" } as unknown as NodeJS.ProcessEnv)).toEqual({ entreeParM: 0.1, sortieParM: 0.4 });
    expect(tarifDe("factice", { MIMO_PRICE_IN: "0.1", MIMO_PRICE_OUT: "0.4" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("un réglage hors bornes est ramené dedans ; une ligne absente rend les défauts", () => {
    expect(borner("etapesMaxTour", 99)).toBe(24);
    expect(borner("plafondJetonsJour", -5)).toBe(10_000);
    expect(normaliserReglages(null)).toEqual(REGLAGES_PAR_DEFAUT);
    expect(normaliserReglages({ censurerSaisie: false }).censurerSaisie).toBe(false);
  });

  it("le refus nomme son remède : où se règle le plafond, et quand il revient", () => {
    expect(refusPlafondJour(600_000)).toContain(ECRAN_CONSOMMATION);
    expect(refusPlafondJour(600_000)).toContain("minuit");
  });
});

describe("le journal et les plafonds, au faux modèle", () => {
  beforeEach(() => { avis.envoyes = []; });
  afterEach(() => { remplacerReglagesPourTests(null); remplacerModelesPourTests(null); });
  afterAll(() => effacerJournalDe(comptes));

  it("chaque appel du modèle est une ligne (personne, conversation, modèle, jetons, durée) ; le tour, une ligne agrégée", async () => {
    const u = compte("journal");
    const { modele } = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { texte: "Voici le point." }]);
    const r = await tour(u, modele, "fil-banc");
    expect(r.texte).toBe("Voici le point.");

    const appels = await lignes(u.id);
    expect(appels).toHaveLength(2);
    for (const a of appels) {
      expect(a).toMatchObject({ threadId: "fil-banc", provider: "factice", model: "modele-factice", role: "fil", inputTokens: 10, outputTokens: 5 });
      expect(a.costUsd).toBeNull(); // pas de tarif pour le faux modèle : inconnu, jamais zéro
      expect(a.ms).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(appels.map((a) => a.turnId)).size).toBe(1);
    const t = await prisma.aiUsageLog.findFirst({ where: { userId: u.id, feature: "assistant_ia" } });
    expect(t).toMatchObject({ ok: true, llmCalls: 2, inputTokens: 20, outputTokens: 10, provider: "factice", threadId: "fil-banc", turnId: appels[0]!.turnId });
    expect(await jetonsDuJour(u.id)).toBe(30);
  });

  it("le plafond d'un TOUR arrête la boucle : l'appel suivant ne part pas, et le refus le dit", async () => {
    const u = compte("tour");
    remplacerReglagesPourTests({ plafondJetonsTour: 1_500 });
    const f = modeleFactice([
      { appel: { outil: "lire", entree: {} } }, { appel: { outil: "lire", entree: {} } },
      { appel: { outil: "lire", entree: {} } }, { texte: "Fin." },
    ], LOURD);
    const e = await tour(u, f.modele).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlafondIaAtteint);
    expect((e as Error).message).toContain("plafond d'un tour");
    expect(f.toursJoues()).toBe(2); // 2 × 1 000 ≥ 1 500 : le troisième appel n'est jamais parti
    expect(await lignes(u.id)).toHaveLength(2);
    const t = await prisma.aiUsageLog.findFirst({ where: { userId: u.id, feature: "assistant_ia" } });
    expect(t?.ok).toBe(false);
  });

  it("une réponse déjà rédigée n'est pas jetée quand la borne tombe sur sa dernière étape", async () => {
    const u = compte("derniere");
    remplacerReglagesPourTests({ plafondJetonsTour: 1_500 });
    const f = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { texte: "Réponse complète." }], LOURD);
    expect((await tour(u, f.modele)).texte).toBe("Réponse complète.");
  });

  it("le plafond du JOUR refuse avant tout appel, et le Super Admin est prévenu une seule fois", async () => {
    const u = compte("jour");
    remplacerReglagesPourTests({ plafondJetonsJour: 1_000 });
    await prisma.modelCallLog.create({ data: { feature: "assistant_ia", userId: u.id, role: "fil", provider: "factice", model: "modele-factice", inputTokens: 900, outputTokens: 200 } });
    const f = modeleFactice([{ texte: "Ne doit pas partir." }]);
    for (let i = 0; i < 2; i++) {
      const e = await tour(u, f.modele).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PlafondIaAtteint);
      expect((e as Error).message).toBe(refusPlafondJour(1_000));
    }
    expect(f.toursJoues()).toBe(0);
    const superAdmins = await prisma.user.count({ where: { role: "SUPER_ADMIN", isActive: true } });
    expect(avis.envoyes).toHaveLength(superAdmins); // un avis par Super Admin, et pas un de plus au second refus
    expect(await prisma.assistantIaPlafondAtteint.count({ where: { userId: u.id } })).toBe(1);
  });

  it("franchir le plafond du jour PENDANT un tour : le tour finit dans ce qui reste, l'avis part", async () => {
    const u = compte("franchit");
    remplacerReglagesPourTests({ plafondJetonsJour: 1_500, plafondJetonsTour: 100_000 });
    await prisma.modelCallLog.create({ data: { feature: "assistant_ia", userId: u.id, role: "fil", provider: "factice", model: "modele-factice", inputTokens: 1_000, outputTokens: 0 } });
    const f = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { appel: { outil: "lire", entree: {} } }, { texte: "Fin." }], LOURD);
    const e = await tour(u, f.modele).catch((x: unknown) => x);
    expect((e as Error).message).toContain("plafond quotidien");
    expect(f.toursJoues()).toBe(1); // il restait 500 jetons : un appel de 1 000, puis arrêt
    expect(await prisma.assistantIaPlafondAtteint.count({ where: { userId: u.id } })).toBe(1);
  });

  it("une rédaction lancée pendant un tour compte dans CE tour ; hors tour, elle est imputée à la personne portée", async () => {
    const u = compte("redaction");
    remplacerModelesPourTests([modeleFactice([{ texte: "Résumé." }]).modele as never]);
    const r = await auNomDe(u.id, () => genererTexte("Résume.", "Un texte."));
    expect(r).toEqual({ ok: true, texte: "Résumé." });
    const [ligne] = await lignes(u.id);
    expect(ligne).toMatchObject({ role: "redaction", inputTokens: 10 });

    const v = compte("dans-le-tour");
    const outilQuiResume: PowerTool = {
      ...outilLecture(),
      run: async () => { const g = await genererTexte("Résume.", "Un texte."); return JSON.stringify(g); },
    };
    remplacerModelesPourTests([modeleFactice([{ texte: "Résumé." }]).modele as never]);
    const f = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { texte: "Fin." }]);
    await repondreAvecSecours({
      user: v, message: "?", historique: [], instructions: "Banc.", outils: [outilQuiResume],
      modeles: [f.modele as never], delaiMs: 5_000, propositionsFaites: () => 0,
    });
    const appels = await lignes(v.id);
    expect(appels).toHaveLength(3); // deux étapes du tour + la rédaction
    expect(new Set(appels.map((a) => a.turnId)).size).toBe(1);

    // EN FLUX (le fil) : la même imputation — le budget suit l'exécution à travers la lecture du flux.
    const w = compte("dans-le-flux");
    remplacerModelesPourTests([modeleFactice([{ texte: "Résumé." }]).modele as never]);
    const g = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { texte: "Fin." }]);
    await repondreAvecSecours({
      user: w, message: "?", historique: [], instructions: "Banc.", outils: [outilQuiResume],
      modeles: [g.modele as never], delaiMs: 5_000, propositionsFaites: () => 0, surTexte: () => {},
    });
    const enFlux = await lignes(w.id);
    expect(enFlux).toHaveLength(3); // deux étapes du flux + la rédaction, sous l'origine du tour
    expect(enFlux.every((a) => a.role === "conversation")).toBe(true);
    expect(new Set(enFlux.map((a) => a.turnId)).size).toBe(1);
  });
});

/** Les fichiers de production d'un dossier. */
function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p.split("\\").join("/"));
  }
  return out;
}

describe("cliquets", () => {
  it("toute porte de l'Assistant IA vers le modèle ouvre et ferme un budget — aucun appel non compté", () => {
    const portes = [...fichiers("src/modules/assistant-ia"), ...fichiers("src/app/(app)/assistant")]
      .filter((f) => /\bnew Agent\(/.test(readFileSync(f, "utf8")));
    expect(portes.sort()).toEqual(["src/modules/assistant-ia/infra/generer.ts", "src/modules/assistant-ia/infra/repondre.ts"]);
    for (const f of portes) {
      const s = readFileSync(f, "utf8");
      // `budgetDeLAppel` ouvre le budget (celui du tour, ou un neuf par `ouvrirBudget`) : c'est la même porte.
      expect(/\b(ouvrirBudget|budgetDeLAppel)\(/.test(s) && /\bfermerBudget\(/.test(s), `${f} appelle le modèle sans budget`).toBe(true);
    }
  });

  it("le remplaçant des réglages n'est appelé par AUCUN code de production", () => {
    const appelants = fichiers("src").filter((f) => f !== "src/modules/assistant-ia/infra/consommation.ts" && /remplacerReglagesPourTests\(/.test(readFileSync(f, "utf8")));
    expect(appelants).toEqual([]);
  });
});
