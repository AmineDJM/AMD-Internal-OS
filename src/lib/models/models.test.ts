import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { costOf, emptyUsage, textOf, toolCallsOf } from "./contract";
import { bindingFor, activeProvider, DEFAULT_MODELS, DEFAULT_REASONING } from "./registry";
import { parseToolArgs, stopOf, toOpenAiMessages, toBlocks, buildBody, StreamAssembler } from "./openai";
import { toAnthropicMessages, fromAnthropicBlocks, stopOfAnthropic, buildAnthropicBody } from "./anthropic";
import { withTurn, recordModelCall, markPreview, markFinal, markComplexity, summarize, currentTurn } from "./telemetry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PASSERELLE MODÈLE — ce que ces tests protègent.
 *
 * Trois familles, et chacune existe pour une raison précise :
 *
 *   • la PORTABILITÉ — `src/lib/models/` prétend être la partie d'Adam qu'il emporte. Un test
 *     le vérifie, sinon c'est juste une phrase dans un commentaire.
 *   • la TRADUCTION — c'est là que se logent les bugs coûteux : un `tool_result` présenté comme
 *     une phrase d'utilisateur casse le chaînage et fait rappeler l'outil qu'on vient d'appeler.
 *   • l'HONNÊTETÉ DU COÛT — un tarif inconnu doit rendre `null`, jamais zéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENV_KEYS = [
  "ADAM_MODEL_PROVIDER",
  "ADAM_MODEL_ORCHESTRATOR",
  "ADAM_MODEL_WORKER",
  "ADAM_MODEL_BULK",
  "ADAM_MODEL_REALTIME",
  "ADAM_REASONING_ORCHESTRATOR",
  "ADAM_REASONING_WORKER",
  "ADAM_PRICE_ORCHESTRATOR_IN",
  "ADAM_PRICE_ORCHESTRATOR_OUT",
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─────────────────────────── Portabilité ───────────────────────────

describe("portabilité — `src/lib/models/` est ce qu'Adam emporte avec lui", () => {
  const files = fs
    .readdirSync("src/lib/models")
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => path.join("src/lib/models", f));

  it("le périmètre est bien couvert (le test ne lit pas un dossier vide)", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * LA SEULE EXCEPTION AUTORISÉE. `@/lib/ai-text` est un assainisseur de trois expressions
   * régulières, sans état ni règle métier — il figure d'ailleurs comme NEUTRE dans le scanner de
   * frontière. Toute autre dépendance `@/` ferait de cette couche un morceau d'ERP déguisé.
   */
  // `journal` (lot V3-E) : zéro import, aucune règle métier — le `catch` nommé et la ligne JSON,
  // que la passerelle emporte avec elle comme `ai-text` (même critère que NEUTRAL, boundary-scan.ts).
  const ALLOWED = new Set(["@/lib/ai-text", "@/lib/journal"]);

  it("aucun module de la passerelle n'importe le produit", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const specs = [
        ...[...src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
      ];
      for (const spec of specs) {
        if (spec.startsWith("./") || spec.startsWith("node:")) continue;
        if (ALLOWED.has(spec)) continue;
        offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders, "la passerelle modèle doit rester sans dépendance métier").toEqual([]);
  });

  it("le CONTRAT lui-même n'importe rien — c'est ce qui le rend portable", () => {
    const src = fs.readFileSync("src/lib/models/contract.ts", "utf8");
    expect([...src.matchAll(/(?:^|\n)\s*import\s/g)].length).toBe(0);
  });

  it("aucun nom de modèle n'est écrit ailleurs que dans le registre ou le registre des capacités", () => {
    // Un identifiant de modèle en dur au milieu d'une boucle d'agent est exactement ce qui rend
    // un changement de modèle impossible sans relire tout le produit.
    //
    // DEUX FICHIERS ONT LE DROIT DE NOMMER UN MODÈLE, et ils répondent à deux questions
    // différentes :
    //
    //   • `registry.ts`     — QUI TRAVAILLE POUR QUI (rôle → modèle, effort, tarif). Se change
    //                         en exploitation, par variable d'environnement.
    //   • `capabilities.ts` — CE QUE CHAQUE MODÈLE ACCEPTE. Une fiche de capacités est par
    //                         nature INDEXÉE PAR MODÈLE : la clé EST le nom. L'en écarter
    //                         reviendrait à ne plus pouvoir dire « Terra refuse temperature ».
    //
    // Cette seconde entrée a été ouverte le jour où un HTTP 400 (`temperature` non supporté) a
    // montré qu'on n'avait NULLE PART où écrire cette connaissance. Le cliquet garde tous les
    // autres fichiers : c'est une exception nommée, pas un assouplissement.
    const AUTORISES = ["registry.ts", "capabilities.ts"];
    const offenders = files
      .filter((f) => !AUTORISES.some((a) => f.endsWith(a)))
      .filter((f) => /["'](gpt-|claude-)[a-z0-9.\-]+["']/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────── Registre des rôles ───────────────────────────

describe("registre — un rôle, pas un nom de modèle", () => {
  it("la stack cible est branchée par défaut", () => {
    expect(bindingFor("orchestrator").model).toBe("gpt-5.6-terra");
    expect(bindingFor("orchestrator").reasoning).toBe("medium");
    expect(bindingFor("worker").model).toBe("gpt-5.6-terra");
    expect(bindingFor("worker").reasoning).toBe("none");
    expect(bindingFor("bulk").model).toBe("gpt-5.6-luna");
    expect(bindingFor("realtime").model).toBe("gpt-realtime-2.1");
  });

  it("l'orchestrateur raisonne, les workers non — c'est là toute la différence de coût", () => {
    expect(DEFAULT_REASONING.orchestrator).toBe("medium");
    expect(DEFAULT_REASONING.worker).toBe("none");
    expect(DEFAULT_REASONING.bulk).toBe("none");
  });

  it("un modèle se remplace par variable d'environnement, sans toucher au code", () => {
    process.env.ADAM_MODEL_ORCHESTRATOR = "gpt-5.7-terra";
    expect(bindingFor("orchestrator").model).toBe("gpt-5.7-terra");
    expect(DEFAULT_MODELS.orchestrator).toBe("gpt-5.6-terra"); // le défaut n'a pas bougé
  });

  it("la marche arrière rebascule les rôles TEXTUELS sur l'ancien cerveau", () => {
    process.env.ADAM_MODEL_PROVIDER = "anthropic";
    expect(activeProvider()).toBe("anthropic");
    expect(bindingFor("orchestrator").provider).toBe("anthropic");
    expect(bindingFor("orchestrator").model).toBe("claude-sonnet-4-6");
    expect(bindingFor("bulk").model).toBe("claude-haiku-4-5");
  });

  it("le temps réel ne bascule JAMAIS — il n'a pas d'équivalent ailleurs", () => {
    process.env.ADAM_MODEL_PROVIDER = "anthropic";
    expect(bindingFor("realtime").provider).toBe("openai");
    expect(bindingFor("realtime").model).toBe("gpt-realtime-2.1");
  });

  it("un effort de raisonnement invalide retombe sur le défaut plutôt que de partir tel quel", () => {
    process.env.ADAM_REASONING_ORCHESTRATOR = "enorme";
    expect(bindingFor("orchestrator").reasoning).toBe("medium");
    process.env.ADAM_REASONING_ORCHESTRATOR = "high";
    expect(bindingFor("orchestrator").reasoning).toBe("high");
  });
});

// ─────────────────────────── Honnêteté du coût ───────────────────────────

describe("coût — un tarif inconnu vaut `null`, jamais zéro", () => {
  it("Luna a un tarif connu et vérifié", () => {
    const b = bindingFor("bulk");
    expect(b.priceInPerM).toBe(0.2);
    expect(b.priceOutPerM).toBe(1.2);
    expect(costOf(b, 1_000_000, 1_000_000)).toBeCloseTo(1.4, 6);
  });

  /**
   * Terra et Sol sont tarifés depuis la grille publique du 2026-08-21 (relevée le 2026-09-05) ;
   * la lecture de cache y vaut 10 % de l'entrée. Un modèle HORS grille reste INCONNU : inventer
   * un chiffre plausible serait pire que ne rien dire — un tableau de bord de coût sert à
   * décider, et il déciderait alors sur du faux.
   */
  it("Terra est tarifé (2 / 12, cache 0,20) et la remise de cache s'applique à la seule part en cache", () => {
    const b = bindingFor("orchestrator");
    expect(b.priceInPerM).toBe(2);
    expect(b.priceOutPerM).toBe(12);
    expect(b.priceCachedInPerM).toBe(0.2);
    expect(costOf(b, 1_000_000, 500_000)).toBeCloseTo(8, 6);
    expect(costOf(b, 1_000_000, 0, 600_000)).toBeCloseTo(0.4 * 2 + 0.6 * 0.2, 6);
  });

  it("un suffixe de date garde le tarif ; un modèle hors grille reste INCONNU, pas gratuit", () => {
    process.env.ADAM_MODEL_ORCHESTRATOR = "gpt-5.6-terra-2026-03-01";
    expect(bindingFor("orchestrator").priceInPerM).toBe(2);
    process.env.ADAM_MODEL_ORCHESTRATOR = "modele-inconnu-x";
    const b = bindingFor("orchestrator");
    expect(b.priceInPerM).toBeNull();
    expect(costOf(b, 1_000_000, 500_000)).toBeNull();
  });

  it("le tarif se renseigne sans redéploiement le jour où il est connu", () => {
    process.env.ADAM_PRICE_ORCHESTRATOR_IN = "1.25";
    process.env.ADAM_PRICE_ORCHESTRATOR_OUT = "10";
    const b = bindingFor("orchestrator");
    expect(costOf(b, 1_000_000, 1_000_000)).toBeCloseTo(11.25, 6);
  });

  it("un usage vide ne prétend pas coûter zéro", () => {
    expect(emptyUsage("worker", "m", "openai").costUsd).toBeNull();
  });

  /**
   * LES JETONS EN CACHE (§62). Sans tarif réduit renseigné, ils restent au tarif PLEIN — une
   * surestimation assumée, jamais une remise devinée. Renseigné, la remise s'applique à la part
   * en cache et à elle seule.
   */
  it("les jetons en cache restent au tarif plein quand le tarif d'entrée est surchargé sans tarif de cache", () => {
    process.env.ADAM_PRICE_BULK_IN = "0.2";
    try {
      const b = bindingFor("bulk");
      expect(b.priceCachedInPerM).toBeNull();
      expect(costOf(b, 1_000_000, 0, 600_000)).toBeCloseTo(0.2, 6); // tout au tarif plein
    } finally {
      delete process.env.ADAM_PRICE_BULK_IN;
    }
  });

  it("Luna porte son tarif de cache public (0,02) : la part en cache est remisée, elle seule", () => {
    const b = bindingFor("bulk");
    expect(b.priceCachedInPerM).toBe(0.02);
    expect(costOf(b, 1_000_000, 0, 600_000)).toBeCloseTo(0.4 * 0.2 + 0.6 * 0.02, 6);
  });

  it("le tarif réduit du cache se renseigne par variable, et la remise ne touche que la part en cache", () => {
    process.env.ADAM_PRICE_BULK_CACHED_IN = "0.02";
    try {
      const b = bindingFor("bulk");
      expect(b.priceCachedInPerM).toBe(0.02);
      // 400 000 pleins à 0,20 + 600 000 en cache à 0,02.
      expect(costOf(b, 1_000_000, 0, 600_000)).toBeCloseTo(0.4 * 0.2 + 0.6 * 0.02, 6);
      // La part en cache ne dépasse jamais l'entrée — une donnée aberrante ne crée pas un coût négatif.
      expect(costOf(b, 100, 0, 1_000)).toBeCloseTo((100 / 1_000_000) * 0.02, 9);
    } finally {
      delete process.env.ADAM_PRICE_BULK_CACHED_IN;
    }
  });
});

// ─────────────────────────── Traduction OpenAI ───────────────────────────

describe("traduction OpenAI — là où se logent les bugs coûteux", () => {
  it("les arguments d'outil arrivent en CHAÎNE et repartent en OBJET", () => {
    expect(parseToolArgs('{"reference":"REG-2026-041"}')).toEqual({ reference: "REG-2026-041" });
  });

  it("des arguments vides ou illisibles donnent un objet vide, jamais `null`", () => {
    // Un outil sans argument est légitime ; un `null` plante trois couches plus loin.
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs('{"tronq')).toEqual({});
    expect(parseToolArgs("[1,2]")).toEqual({});
  });

  /**
   * LE PIÈGE PRINCIPAL. Un résultat d'outil doit devenir un message `role: "tool"` PORTANT SON
   * `tool_call_id`. Présenté comme une phrase d'utilisateur, le chaînage est rompu et le modèle
   * rappelle l'outil qu'il vient d'appeler — une boucle qu'on paie deux fois.
   */
  it("un résultat d'outil devient un message `tool` rattaché à son appel", () => {
    const msgs = toOpenAiMessages([
      { role: "user", content: "Combien de dossiers en retard ?" },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read_reg", args: { x: 1 } }] },
      { role: "user", content: [{ type: "tool_result", callId: "c1", content: "3 dossiers" }] },
    ]);
    expect(msgs[1]).toMatchObject({ role: "assistant", content: null });
    expect((msgs[1] as { tool_calls: { id: string }[] }).tool_calls[0].id).toBe("c1");
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "3 dossiers" });
  });

  it("deux résultats d'outils donnent DEUX messages, pas un seul concaténé", () => {
    const msgs = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "a", content: "A" },
          { type: "tool_result", callId: "b", content: "B" },
        ],
      },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  it("un échec d'outil se distingue d'une réponse négative", () => {
    const msgs = toOpenAiMessages([
      { role: "user", content: [{ type: "tool_result", callId: "c", content: "accès refusé", isError: true }] },
    ]);
    expect(msgs[0].content).toContain("ERREUR");
  });

  it("le système est envoyé à part, en tête", () => {
    const msgs = toOpenAiMessages([{ role: "user", content: "salut" }], "Tu es Adam.");
    expect(msgs[0]).toEqual({ role: "system", content: "Tu es Adam." });
  });

  it("des appels d'outils dans la réponse font foi, même si le motif d'arrêt dit « stop »", () => {
    expect(stopOf("stop", true)).toBe("tools");
    expect(stopOf("tool_calls", false)).toBe("tools");
    expect(stopOf("length", false)).toBe("length");
    expect(stopOf("content_filter", false)).toBe("refusal");
    expect(stopOf("stop", false)).toBe("end");
  });

  it("un appel d'outil sans identifiant reçoit un identifiant fabriqué plutôt que d'être perdu", () => {
    const blocks = toBlocks({ role: "assistant", tool_calls: [{ function: { name: "f", arguments: "{}" } }] });
    expect(toolCallsOf(blocks)).toHaveLength(1);
    expect(toolCallsOf(blocks)[0].id).toBeTruthy();
  });

  it("le corps porte l'effort de raisonnement du rôle et le budget de sortie", () => {
    const body = buildBody(bindingFor("orchestrator"), [{ role: "user", content: "x" }], {});
    expect(body.reasoning_effort).toBe("medium");
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.model).toBe("gpt-5.6-terra");
  });

  it("les outils partent au format `function` attendu par le fournisseur", () => {
    const body = buildBody(bindingFor("worker"), [{ role: "user", content: "x" }], {
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(body.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]);
  });
});

describe("flux OpenAI — reconstituer ce qui arrive en morceaux", () => {
  it("le texte se recolle et remonte au fil de l'eau", () => {
    const asm = new StreamAssembler();
    expect(asm.push({ content: "Bon" })).toBe("Bon");
    asm.push({ content: "jour" });
    expect(textOf(asm.blocks())).toBe("Bonjour");
  });

  /**
   * Les appels d'outils sont identifiés par leur INDEX, pas par leur identifiant — qui n'arrive
   * qu'une seule fois. Reconstituer par index est la seule façon de ne pas perdre un appel sur
   * une réponse qui en émet plusieurs.
   */
  it("deux appels d'outils entrelacés sont reconstitués séparément", () => {
    const asm = new StreamAssembler();
    asm.push({ tool_calls: [{ index: 0, id: "c0", function: { name: "un", arguments: '{"a"' } }] });
    asm.push({ tool_calls: [{ index: 1, id: "c1", function: { name: "deux", arguments: '{"b"' } }] });
    asm.push({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] });
    asm.push({ tool_calls: [{ index: 1, function: { arguments: ":2}" } }] });

    const calls = toolCallsOf(asm.blocks());
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "c0", name: "un", args: { a: 1 } });
    expect(calls[1]).toMatchObject({ id: "c1", name: "deux", args: { b: 2 } });
  });

  it("un flux qui n'a produit que des appels d'outils s'arrête sur « tools »", () => {
    const asm = new StreamAssembler();
    asm.push({ tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] }, "stop");
    expect(asm.hasCalls()).toBe(true);
    expect(stopOf(asm.finish, asm.hasCalls())).toBe("tools");
  });
});

// ─────────────────────────── Traduction Anthropic ───────────────────────────

describe("traduction Anthropic — la marche arrière doit rester correcte", () => {
  it("un aller-retour préserve appels et résultats d'outils", () => {
    const msgs = toAnthropicMessages([
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "f", args: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", callId: "c1", content: "ok" }] },
    ]);
    const assistant = msgs[0].content as { type: string; id?: string; input?: unknown }[];
    expect(assistant[0]).toMatchObject({ type: "tool_use", id: "c1", input: { a: 1 } });
    const user = msgs[1].content as { type: string; tool_use_id?: string }[];
    expect(user[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });

  it("les blocs de sortie reviennent en forme neutre", () => {
    const blocks = fromAnthropicBlocks([
      { type: "text", text: "voilà" },
      { type: "tool_use", id: "x", name: "g", input: { k: "v" } },
    ]);
    expect(textOf(blocks)).toBe("voilà");
    expect(toolCallsOf(blocks)[0]).toMatchObject({ id: "x", name: "g", args: { k: "v" } });
  });

  it("les motifs d'arrêt sont normalisés comme chez l'autre fournisseur", () => {
    expect(stopOfAnthropic("tool_use", false)).toBe("tools");
    expect(stopOfAnthropic("max_tokens", false)).toBe("length");
    expect(stopOfAnthropic("end_turn", false)).toBe("end");
  });

  /**
   * Le point de cache couvre AUSSI les outils (ordre de rendu outils → système → messages). Sans
   * lui, une boucle d'agent re-traite le même préfixe à chaque tour : de la latence pure.
   */
  it("le préfixe stable porte un point de cache", () => {
    process.env.ADAM_MODEL_PROVIDER = "anthropic";
    const body = buildAnthropicBody(bindingFor("orchestrator"), [{ role: "user", content: "x" }], {
      system: "Tu es Adam.",
    });
    const system = body.system as { cache_control?: unknown }[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

// ─────────────────────────── Télémétrie ───────────────────────────

describe("télémétrie — « Adam est lent » n'est pas un diagnostic", () => {
  const usage = (role: "orchestrator" | "worker" | "bulk" | "realtime", cost: number | null) => ({
    role,
    model: "m",
    provider: "openai" as const,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    costUsd: cost,
    ms: 10,
    attempts: 1,
  });

  it("les appels se ventilent PAR RÔLE — c'est ce qui prouve qu'A/B n'appelle pas l'orchestrateur", async () => {
    const s = await withTurn("voice-direct", async (trace) => {
      markComplexity("A");
      recordModelCall(usage("realtime", 0.001));
      recordModelCall(usage("bulk", 0.002));
      return summarize(trace);
    });
    expect(s.callsByRole.orchestrator).toBe(0);
    expect(s.callsByRole.realtime).toBe(1);
    expect(s.callsByRole.bulk).toBe(1);
    expect(s.complexity).toBe("A");
    expect(s.llmCalls).toBe(2);
  });

  it("un seul tarif inconnu rend le TOTAL inconnu — pas une somme partielle", async () => {
    const s = await withTurn("text", async (trace) => {
      recordModelCall(usage("orchestrator", null));
      recordModelCall(usage("bulk", 0.002));
      return summarize(trace);
    });
    expect(s.costUsd).toBeNull();
  });

  it("quand tous les tarifs sont connus, le total l'est aussi", async () => {
    const s = await withTurn("text", async (trace) => {
      recordModelCall(usage("bulk", 0.002));
      recordModelCall(usage("bulk", 0.003));
      return summarize(trace);
    });
    expect(s.costUsd).toBeCloseTo(0.005, 6);
  });

  it("seul le PREMIER signe de vie compte — après, l'utilisateur regarde déjà", async () => {
    const s = await withTurn("text", async (trace) => {
      markPreview();
      const first = trace.firstPreviewMs;
      await new Promise((r) => setTimeout(r, 5));
      markPreview();
      expect(trace.firstPreviewMs).toBe(first);
      markFinal();
      return summarize(trace);
    });
    expect(s.firstPreviewMs).not.toBeNull();
    expect(s.finalMs).not.toBeNull();
  });

  it("la mesure traverse la PARALLÉLISATION — c'est justement ce qu'on veut mesurer", async () => {
    const s = await withTurn("text", async (trace) => {
      await Promise.all([
        (async () => { await new Promise((r) => setTimeout(r, 1)); recordModelCall(usage("worker", null)); })(),
        (async () => { await new Promise((r) => setTimeout(r, 1)); recordModelCall(usage("worker", null)); })(),
      ]);
      return summarize(trace);
    });
    expect(s.callsByRole.worker).toBe(2);
  });

  it("hors d'un tour, mesurer est silencieux — jamais une exception à cause du compteur", () => {
    expect(currentTurn()).toBeUndefined();
    expect(() => {
      recordModelCall(usage("worker", null));
      markPreview();
      markFinal();
      markComplexity("C");
    }).not.toThrow();
  });
});
