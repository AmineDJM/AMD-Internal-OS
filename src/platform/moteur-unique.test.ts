import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { ancienMoteurActif, ancienneBoucle, DRAPEAU_ANCIEN_MOTEUR, reponseAncienMoteurMasque } from "@/lib/assistant/ancien-moteur";
import { appendExchange, createThread, ensurePrimaryThread, FILS_GELES } from "@/lib/assistant-memory";
import { rememberExchange } from "@/lib/memoire-echange";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I6 — UN SEUL MOTEUR (décision 0070 ; audit AU3 §4, étape 4). LE TEST D'ARCHITECTURE, côté Adam (au socle : il
 * regarde les deux produits et le dépôt entier, comme les autres cliquets de `src/platform/`).
 *
 *   1. `runAssistant` / `runAssistantStream` (l'ancienne boucle) ne sont plus importés hors de `src/lib/assistant/` (la
 *      porte `src/lib/assistant.ts` et les tests de l'ancien moteur exceptés) : on ne les obtient que par
 *      `ancienneBoucle()`, qui rend `null` sans le drapeau ADAM_ANCIEN_MOTEUR=1.
 *   2. Chaque entrée d'avant (Bureau, appel vocal, dictée, Brain, relance) passe par le drapeau ; ses routes de voix et de
 *      dictée répondent 410 sans lui ; l'appel global est éteint sans lui.
 *   3. `AssistantThread` est GELÉ EN LECTURE sans le drapeau, et redevient écrit avec lui. Rien n'est supprimé.
 * Le côté moteur (entrées = `jouerTour`, clé de cache unique) : `src/modules/assistant-ia/i6-moteur-unique.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.resolve(__dirname, "../..");
const SRC = path.join(RACINE, "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) fichiers(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const rel = (p: string) => path.relative(RACINE, p).split(path.sep).join("/");
const SOURCES = fichiers(SRC).map((p) => ({ chemin: rel(p), texte: fs.readFileSync(p, "utf8") }));
/** Hors du périmètre de l'ancien moteur : ni `src/lib/assistant/**`, ni sa porte, ni un test. */
const horsAncienMoteur = (c: string) => !c.startsWith("src/lib/assistant/") && c !== "src/lib/assistant.ts" && !/\.test\.tsx?$/.test(c);
/** Le texte sans ses commentaires (les lignes d'avant gardées en commentaire ne sont pas des imports). */
const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("I6 — l'ancienne boucle n'est plus importée hors de lib/assistant (test d'architecture)", () => {
  it("aucun import statique de runAssistant / runAssistantStream hors de src/lib/assistant", () => {
    const fautifs: string[] = [];
    for (const f of SOURCES.filter((s) => horsAncienMoteur(s.chemin))) {
      const t = sansCommentaires(f.texte);
      for (const m of t.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
        const noms = m[1]!.split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
        if (noms.some((n) => n === "runAssistant" || n === "runAssistantStream")) fautifs.push(`${f.chemin} ← ${m[2]}`);
      }
    }
    expect(fautifs).toEqual([]);
  });

  it("aucun import (statique OU dynamique) de lib/assistant/boucle/* hors de src/lib/assistant", () => {
    const fautifs = SOURCES.filter((s) => horsAncienMoteur(s.chemin))
      .filter((s) => /(?:from\s*|import\s*\()\s*["'][^"']*lib\/assistant\/boucle(?:\/[^"']*)?["']/.test(sansCommentaires(s.texte)))
      .map((s) => s.chemin);
    expect(fautifs).toEqual([]);
  });

  it("qui appelle encore l'ancienne boucle hors de lib/assistant le fait DERRIÈRE le drapeau (`ancienneBoucle()`)", () => {
    const appelants = SOURCES.filter((s) => horsAncienMoteur(s.chemin) && /\brunAssistant(Stream)?\b/.test(sansCommentaires(s.texte)));
    expect(appelants.length).toBeGreaterThan(0);
    for (const a of appelants) expect(sansCommentaires(a.texte), a.chemin).toMatch(/\bancienneBoucle\(\)/);
  });

  it("le drapeau : défaut = moteur unique ; seule la valeur « 1 » remet l'ancien moteur", async () => {
    expect(DRAPEAU_ANCIEN_MOTEUR).toBe("ADAM_ANCIEN_MOTEUR");
    expect(ancienMoteurActif({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(ancienMoteurActif({ ADAM_ANCIEN_MOTEUR: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(ancienMoteurActif({ ADAM_ANCIEN_MOTEUR: "oui" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(ancienMoteurActif({ ADAM_ANCIEN_MOTEUR: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(await ancienneBoucle({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    // Rien n'est supprimé : sous le drapeau, l'ancienne boucle revient, entière.
    const b = await ancienneBoucle({ ADAM_ANCIEN_MOTEUR: "1" } as unknown as NodeJS.ProcessEnv);
    expect(typeof b?.runAssistant).toBe("function");
    expect(typeof b?.runAssistantStream).toBe("function");
  }, 60_000);
});

describe("I6 — chaque entrée d'avant passe par le drapeau ; les routes de l'ancienne voix répondent 410", () => {
  const ENTREES: Record<string, RegExp> = {
    "src/app/api/assistant/stream/route.ts": /const boucle = await ancienneBoucle\(\);\n\s*if \(!boucle\) \{[\s\S]{0,400}MESSAGE_ANCIEN_MOTEUR_MASQUE/,
    "src/lib/actions/assistant-actions.ts": /const boucle = await ancienneBoucle\(\);\n\s*if \(!boucle\) return \{ signature: digest\.signature, suggestion: null \};/,
    "src/lib/actions/adventum-actions.ts": /jouerTourDEntree\(user, "brain"/,
    "src/app/api/assistant/voice/tool/route.ts": /if \(!ancienMoteurActif\(\)\) return reponseAncienMoteurMasque\(\)/,
    "src/app/api/assistant/voice/session/route.ts": /if \(!ancienMoteurActif\(\)\) return reponseAncienMoteurMasque\(\)/,
    "src/app/api/assistant/voice/turn/route.ts": /ancienMoteurActif\(\) \? null : reponseAncienMoteurMasque\(\);\n\s*if \(masque\) return masque;/,
    "src/app/api/assistant/voice/log/route.ts": /if \(!ancienMoteurActif\(\)\) return reponseAncienMoteurMasque\(\)/,
    "src/app/api/assistant/transcribe/route.ts": /if \(!ancienMoteurActif\(\)\) return reponseAncienMoteurMasque\(\)/,
    "src/app/(app)/layout.tsx": /CallProvider enabled=\{ancienMoteurActif\(\) &&/,
    "src/app/(app)/adam/bureau/page.tsx": /if \(!ancienMoteurActif\(\)\)[\s\S]*HistoriqueGele/,
  };
  for (const [f, motif] of Object.entries(ENTREES)) {
    it(f, () => expect(fs.readFileSync(path.join(RACINE, f), "utf8")).toMatch(motif));
  }

  it("le chat du Bureau (`assistantChat`) ne joue plus l'ancienne boucle : il dit où parler à Adam (moteur unique)", () => {
    expect(fs.readFileSync(path.join(RACINE, "src/lib/actions/assistant-actions.ts"), "utf8")).toMatch(/if \(!boucle\) return tourMasque\(\);/);
  });

  it("la réponse d'une route masquée : 410, le motif, et où aller", async () => {
    const r = reponseAncienMoteurMasque();
    expect(r.status).toBe(410);
    const corps = (await r.json()) as { reasonCode: string; aller: string; error: string };
    expect(corps.reasonCode).toBe("ANCIEN_MOTEUR_MASQUE");
    expect(corps.aller).toBe("/assistant");
    expect(corps.error).toMatch(/un seul moteur/);
  });

  it("les routes de l'ancienne voix et de la dictée, appelées pour de vrai sans le drapeau : 410 avant toute session", async () => {
    const avant = process.env.ADAM_ANCIEN_MOTEUR;
    delete process.env.ADAM_ANCIEN_MOTEUR;
    try {
      const routes = await Promise.all([
        import("@/app/api/assistant/voice/session/route"), import("@/app/api/assistant/voice/tool/route"),
        import("@/app/api/assistant/voice/turn/route"), import("@/app/api/assistant/voice/log/route"),
        import("@/app/api/assistant/transcribe/route"),
      ]);
      for (const r of routes) {
        const rep = await (r.POST as (q: Request) => Promise<Response>)(new Request("http://local/x", { method: "POST", body: "{}" }));
        expect(rep.status).toBe(410);
      }
    } finally {
      if (avant === undefined) delete process.env.ADAM_ANCIEN_MOTEUR; else process.env.ADAM_ANCIEN_MOTEUR = avant;
    }
  }, 120_000);
});


let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
let userId = "";

suite("I6 — en base : les fils de l'ancien moteur sont gelés en lecture", () => {
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { email: `i6-gel-${Date.now().toString(36)}@banc.local`, name: "Banc I6", passwordHash: "x", role: "SUPER_ADMIN" } as never, select: { id: true } })).id;
  });
  afterAll(async () => {
    if (!userId) return;
    await prisma.assistantMessage.deleteMany({ where: { userId } });
    await prisma.assistantThread.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("sans le drapeau : aucun fil créé, aucun échange ajouté — avec lui : écrit comme avant", async () => {
    const u = userId;
    const avant = process.env.ADAM_ANCIEN_MOTEUR;
    try {
      // Un fil d'avant (écrit sous le drapeau) : il reste LISIBLE après le gel.
      process.env.ADAM_ANCIEN_MOTEUR = "1";
      const fil = await createThread(u, "Question d'avant");
      expect(await appendExchange(u, fil, "Bonjour", "Bonjour !")).toBe(true);
      delete process.env.ADAM_ANCIEN_MOTEUR;
      const n0 = await prisma.assistantMessage.count({ where: { userId: u } });
      await expect(createThread(u, "Nouveau")).rejects.toThrow(FILS_GELES);
      expect(await appendExchange(u, fil, "Encore", "Non écrit")).toBe(false);
      expect(await rememberExchange(u, fil, "Encore", "Non écrit")).toBe(fil);
      expect(await rememberExchange(u, null, "Encore", "Non écrit")).toBeNull();
      await expect(ensurePrimaryThread(u)).rejects.toThrow(FILS_GELES);
      expect(await prisma.assistantMessage.count({ where: { userId: u } })).toBe(n0);
      expect(await prisma.assistantThread.count({ where: { userId: u } })).toBe(1);
      // L'historique reste consultable.
      const { getThreadMessages } = await import("@/lib/assistant-memory");
      expect((await getThreadMessages(u, fil, 10))?.map((m) => m.content)).toEqual(["Bonjour", "Bonjour !"]);
    } finally {
      if (avant === undefined) delete process.env.ADAM_ANCIEN_MOTEUR; else process.env.ADAM_ANCIEN_MOTEUR = avant;
    }
  }, 60_000);

});
