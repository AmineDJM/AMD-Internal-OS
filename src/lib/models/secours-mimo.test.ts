import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  interrupteurIaCoupe: async () => false,
}));

import { askModelJson, askModelJsonAvecImages, callModel, chaineDeSecours, jsonDuTexte } from "./gateway";
import { phraseDuSecours } from "@/lib/ia-credit";
import { buildAnthropicBody, schemaPourClaude } from "./anthropic";
import { bindingFor } from "./registry";
import { estCreditEpuise, isRetryableStatus } from "./errors";
import { messagesMimo } from "./mimo";
import { callLuna } from "@/lib/openai-luna";

/**
 * LE SECOURS MiMo (Direction, 09/11/2026 : « quand il y a ce problème, utilise le modèle suivant » — « l'autre IA de la
 * plateforme »). Le crédit OpenAI à zéro avait arrêté toute l'IA une journée : les trois modèles en service sont chez
 * OpenAI, sur un seul compte. Ce banc tient la règle : un CRÉDIT ÉPUISÉ — et lui seul — fait repartir la même demande
 * chez MiMo (clé \`mimo\`, déjà posée sur Render).
 */

const CREDIT_OPENAI = JSON.stringify({ error: { message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.", code: "insufficient_quota" } });
const SCHEMA = { name: "piece", schema: { type: "object", additionalProperties: false, required: ["total"], properties: { total: { type: "number" } } } };
const MIMO_BASE = "https://mimo.test/v1";

interface Appel { url: string; corps: Record<string, unknown> }
let appels: Appel[] = [];
let reponseOpenAi: () => Response;
let reponseMimo: () => Response;

const mimoRepond = (texte: string) => () => new Response(JSON.stringify({
  choices: [{ message: { content: texte }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 40 },
}), { status: 200 });

const ENV0 = { ...process.env };
beforeEach(() => {
  appels = [];
  process.env.OPENAI_API_KEY = "sk-test-openai";
  process.env.mimo = "tp-test-mimo-0000000000";
  process.env.MIMO_BASE_URL = MIMO_BASE;
  delete process.env.ADAM_SECOURS;
  delete process.env.ADAM_SECOURS_ORDRE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.ADAM_MODEL_PROVIDER;
  reponseOpenAi = () => new Response(CREDIT_OPENAI, { status: 429 });
  reponseMimo = mimoRepond("```json\n{\"total\": 7650}\n```");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    appels.push({ url: u, corps: init?.body ? JSON.parse(String(init.body)) : {} });
    return u.startsWith(MIMO_BASE) ? reponseMimo() : reponseOpenAi();
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ENV0 };
});

const versMimo = () => appels.filter((a) => a.url.startsWith(MIMO_BASE));
const versOpenAi = () => appels.filter((a) => !a.url.startsWith(MIMO_BASE));

describe("le crédit épuisé, reconnu — et lui seul", () => {
  it("le message d'OpenAI est reconnu ; une limite de débit ordinaire non", () => {
    expect(estCreditEpuise("Erreur IA (HTTP 429) : You have no credits remaining. Add credits to continue")).toBe(true);
    expect(estCreditEpuise("insufficient_quota")).toBe(true);
    expect(estCreditEpuise("Rate limit reached for requests")).toBe(false);
    expect(estCreditEpuise(null)).toBe(false);
  });

  it("un crédit épuisé ne se réessaie pas chez le même fournisseur ; une limite de débit, si", () => {
    expect(isRetryableStatus(429, CREDIT_OPENAI)).toBe(false);
    expect(isRetryableStatus(429, "Rate limit reached")).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });
});

describe("la passerelle passe au secours MiMo", () => {
  it("OpenAI sans crédit → la même demande part chez MiMo, une fois, et son JSON (même encadré) est lu", async () => {
    const r = await askModelJson<{ total: number }>("worker", "Lis cette pièce.", SCHEMA, { system: "Tu lis des pièces.", maxOutputTokens: 4000 });
    expect(r.data).toEqual({ total: 7650 });
    expect(r.reply.ok).toBe(true);
    expect(r.reply.usage.provider).toBe("mimo");
    expect(versOpenAi()).toHaveLength(1); // pas de réessai sur un crédit épuisé
    expect(versMimo()).toHaveLength(1);
    const corps = versMimo()[0].corps as { messages: { role: string; content: unknown }[]; max_tokens: number };
    expect(versMimo()[0].url).toBe(`${MIMO_BASE}/chat/completions`);
    expect(corps.messages[0].role).toBe("system");
    expect(String(corps.messages[0].content)).toMatch(/Tu lis des pièces[\s\S]*UNIQUEMENT par un objet JSON[\s\S]*"total"/);
    expect(corps.max_tokens).toBe(4000);
  });

  it("une PANNE OpenAI (500), elle aussi, déclenche le secours depuis le 19/11/2026 — pas seulement le crédit", async () => {
    reponseOpenAi = () => new Response(JSON.stringify({ error: { message: "upstream failed" } }), { status: 500 });
    const r = await callModel("worker", [{ role: "user", content: "x" }], { maxOutputTokens: 100 });
    expect(r.ok, r.error).toBe(true);
    expect(versMimo()).toHaveLength(1);
  }, 30_000);

  it("sans clé MiMo, ou secours coupé : l'échec OpenAI est rendu tel quel", async () => {
    delete process.env.mimo;
    const r = await callModel("worker", [{ role: "user", content: "x" }], {});
    expect(r.ok).toBe(false);
    expect(estCreditEpuise(r.error)).toBe(true);
    process.env.mimo = "tp-test-mimo-0000000000";
    process.env.ADAM_SECOURS = "0";
    await callModel("worker", [{ role: "user", content: "x" }], {});
    expect(versMimo()).toHaveLength(0);
  });

  it("un tour à OUTILS n'a pas de secours : l'échec se dit", async () => {
    const r = await callModel("worker", [{ role: "user", content: "x" }], {
      tools: [{ name: "lire", description: "lit", parameters: { type: "object", properties: {} } }],
    });
    expect(r.ok).toBe(false);
    expect(versMimo()).toHaveLength(0);
  });
});

describe("le chemin Luna (vision, briefing) passe aussi au secours", () => {
  it("une lecture d'IMAGE sans crédit OpenAI repart chez MiMo, image comprise", async () => {
    const r = await callLuna<{ total: number }>({
      system: "Recopie le tableau.", user: "Pièce d'une page.",
      images: [{ buffer: Buffer.from("png"), mime: "image/png" }],
      jsonSchema: SCHEMA, maxOutputTokens: 12_000,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ total: 7650 });
    const messages = versMimo()[0].corps.messages as { role: string; content: { type: string; image_url?: { url: string } }[] }[];
    expect(messages[1].content.find((b) => b.type === "image_url")?.image_url?.url).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
  });

  it("le secours qui échoue lui aussi : l'erreur garde la cause d'origine (le crédit OpenAI)", async () => {
    reponseMimo = () => new Response(JSON.stringify({ error: { message: "model does not support image input" } }), { status: 400 });
    const r = await callLuna({ user: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no credits remaining/);
    expect(r.error).toMatch(/secours : MiMo/);
  });
});

describe("les formes", () => {
  it("un JSON encadré ou précédé d'une phrase se lit", () => {
    expect(jsonDuTexte("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
    expect(jsonDuTexte("Voici : {\"a\":1}")).toBe("{\"a\":1}");
    expect(jsonDuTexte("{\"a\":1}")).toBe("{\"a\":1}");
  });

  it("les tours partent au format OpenAI ; les outils non", () => {
    const m = messagesMimo([{ role: "user", content: [{ type: "text", text: "lis" }, { type: "image", mime: "image/jpeg", data: "QUJD" }] }], { system: "S" });
    expect(m).toEqual([{ role: "system", content: "S" }, { role: "user", content: [{ type: "text", text: "lis" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }] }]);
  });

  it("le corps Claude (repli ADAM_MODEL_PROVIDER=anthropic) suit les modèles récents ; un ancien garde sa température", () => {
    const recent = buildAnthropicBody({ ...bindingFor("worker"), provider: "anthropic", model: "claude-opus-5-5" }, [{ role: "user", content: "x" }], { jsonSchema: SCHEMA });
    expect(recent).not.toHaveProperty("temperature");
    expect(recent.max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(recent.output_config).toEqual({ format: { type: "json_schema", schema: SCHEMA.schema } });
    const ancien = buildAnthropicBody({ ...bindingFor("worker"), provider: "anthropic", model: "claude-sonnet-4-6" }, [{ role: "user", content: "x" }], {});
    expect(ancien.temperature).toBe(0.2);
    expect(schemaPourClaude({ type: "array", minItems: 1, items: { type: "string", maxLength: 3 } })).toEqual({ type: "array", items: { type: "string" } });
  });
});

describe("le secours qui échoue garde la cause d'origine (passerelle, 16/11/2026)", () => {
  it("l'erreur rendue dit le crédit épuisé, puis la raison du secours", async () => {
    const { avecEchecDuSecours } = await import("./gateway");
    const usage = { role: "worker", model: "m", provider: "openai", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, ms: 0, attempts: 1 } as never;
    const origine = { ok: false, configured: true, stop: "error", blocks: [], error: "Erreur IA (HTTP 429) : You have no credits remaining.", usage } as never;
    const secours = { ok: false, configured: true, stop: "error", blocks: [], error: "MiMo HTTP 401", usage } as never;
    const r = avecEchecDuSecours(origine, secours) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no credits remaining");
    expect(r.error).toContain("MiMo HTTP 401");
  });
});

/**
 * LA CHAÎNE DE SECOURS (Direction, 19/11/2026 : « si le premier modèle n'a plus de crédit ou échoue, un second s'active »).
 * Claude d'abord (s'il a sa clé), puis MiMo. Chaque échec de secours est dit ; un appel annulé ne bascule pas.
 */
describe("la chaîne de secours : Claude, puis MiMo", () => {
  const ANTHROPIC = "https://claude.test";
  let reponseClaude: () => Response;
  const claudeRepond = (texte: string) => () => new Response(JSON.stringify({
    content: [{ type: "text", text: texte }], stop_reason: "end_turn", usage: { input_tokens: 90, output_tokens: 30 },
  }), { status: 200 });
  const versClaude = () => appels.filter((a) => a.url.startsWith(ANTHROPIC));
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_BASE_URL = ANTHROPIC;
    reponseClaude = claudeRepond("{\"total\": 7650}");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      appels.push({ url: u, corps: init?.body ? JSON.parse(String(init.body)) : {} });
      if (u.startsWith(ANTHROPIC)) return reponseClaude();
      return u.startsWith(MIMO_BASE) ? reponseMimo() : reponseOpenAi();
    }));
  });

  it("l'ordre : Claude d'abord quand sa clé est posée ; MiMo ensuite ; réglable, et coupable", () => {
    expect(chaineDeSecours("openai")).toEqual(["anthropic", "mimo"]);
    expect(chaineDeSecours("openai", { ...process.env, ADAM_SECOURS_ORDRE: "mimo,anthropic" })).toEqual(["mimo", "anthropic"]);
    expect(chaineDeSecours("openai", { ...process.env, ANTHROPIC_API_KEY: "" })).toEqual(["mimo"]);
    expect(chaineDeSecours("openai", { ...process.env, ADAM_SECOURS: "0" })).toEqual([]);
    expect(chaineDeSecours("anthropic"), "le fournisseur en service n'est pas son propre secours").toEqual(["mimo"]);
  });

  it("OpenAI sans crédit : Claude répond, MiMo n'est pas appelé — le JSON imposé est rendu", async () => {
    const { data, reply } = await askModelJson<{ total: number }>("bulk", "lis ce devis", SCHEMA);
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.usage.provider).toBe("anthropic");
    expect(data).toEqual({ total: 7650 });
    expect(versClaude()).toHaveLength(1);
    expect(versMimo()).toHaveLength(0);
  });

  it("Claude échoue aussi : MiMo prend le relais", async () => {
    reponseClaude = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
    const r = await callModel("worker", [{ role: "user", content: "x" }], { maxOutputTokens: 100 });
    expect(r.ok, r.error).toBe(true);
    expect(r.usage.provider).toBe("mimo");
  }, 60_000);

  it("tous en échec : l'erreur garde la cause d'origine ET la raison de chaque secours", async () => {
    reponseClaude = () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
    reponseMimo = () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    const r = await callModel("worker", [{ role: "user", content: "x" }], { maxOutputTokens: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no credits remaining/);
    expect(r.error).toMatch(/secours : Claude : .*; MiMo : MiMo HTTP 404/);
    expect(phraseDuSecours(r.error)).toMatch(/Les IA de secours n'ont pas répondu non plus \(Claude : /);
  }, 60_000);

  it("un appel ANNULÉ par l'appelant ne bascule pas", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await callModel("worker", [{ role: "user", content: "x" }], { signal: ctrl.signal }).catch(() => null);
    expect(versClaude()).toHaveLength(0);
    expect(versMimo()).toHaveLength(0);
  });
});

/**
 * MISTRAL EN SECOURS (Direction, 21/11/2026 : « prends un modèle déjà utilisé ») — la clé de l'OCR réglementaire sert aussi
 * la conversation de Mistral : texte, images, JSON imposé. Placé AVANT MiMo.
 */
describe("Mistral dans la chaîne de secours", () => {
  const MISTRAL = "https://mistral.test/v1";
  let reponseMistral: () => Response;
  const versMistral = () => appels.filter((a) => a.url.startsWith(MISTRAL));
  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "mistral-test-cle";
    process.env.MISTRAL_BASE_URL = MISTRAL;
    reponseMistral = () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"total\": 7650}" }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 20 },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      appels.push({ url: u, corps: init?.body ? JSON.parse(String(init.body)) : {} });
      if (u.startsWith(MISTRAL)) return reponseMistral();
      return u.startsWith(MIMO_BASE) ? reponseMimo() : reponseOpenAi();
    }));
  });

  it("l'ordre par défaut : Claude (sans clé ici), Mistral, puis MiMo", () => {
    expect(chaineDeSecours("openai")).toEqual(["mistral", "mimo"]);
    expect(chaineDeSecours("openai", { ...process.env, ANTHROPIC_API_KEY: "k" })).toEqual(["anthropic", "mistral", "mimo"]);
  });

  it("OpenAI sans crédit : Mistral lit le devis (images et JSON imposé partent) ; MiMo n'est pas appelé", async () => {
    const { data, reply } = await askModelJsonAvecImages<{ total: number }>("bulk", "lis ce devis", [{ mime: "image/png", data: "QUJD" }], SCHEMA);
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.usage.provider).toBe("mistral");
    expect(data).toEqual({ total: 7650 });
    expect(versMimo()).toHaveLength(0);
    const corps = versMistral()[0].corps as { response_format?: { type?: string }; messages?: { content?: unknown }[] };
    expect(corps.response_format?.type).toBe("json_schema");
    expect(JSON.stringify(corps.messages)).toContain("data:image/png;base64,QUJD");
  });

  it("Mistral en échec : MiMo prend le relais, et la raison de Mistral est gardée si tout échoue", async () => {
    reponseMistral = () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    const ok = await callModel("worker", [{ role: "user", content: "x" }], { maxOutputTokens: 100 });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.usage.provider).toBe("mimo");
    reponseMimo = () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
    const ko = await callModel("worker", [{ role: "user", content: "x" }], { maxOutputTokens: 100 });
    expect(ko.ok).toBe(false);
    expect(ko.error).toMatch(/secours : Mistral : Mistral HTTP 401 : Unauthorized ; MiMo : MiMo HTTP 503/);
  }, 60_000);
});
