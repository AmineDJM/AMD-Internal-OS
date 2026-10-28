import { afterAll, describe, expect, it, vi } from "vitest";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { repondreAvecSecours } from "@/lib/agent/repondre";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";

const user = { id: "u-test", role: "SUPER_ADMIN" } as unknown as CurrentUser;
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function outil(nom: string, run: PowerTool["run"]): PowerTool {
  return {
    def: { name: nom, description: "Outil de test.", input_schema: { type: "object", properties: {} } } as PowerTool["def"],
    allowed: () => true,
    label: "Outil de test",
    run,
  };
}

/** Un modèle qui ne répond jamais avant d'être interrompu — pour le délai. */
function modeleMuet() {
  const attendre = (signal?: AbortSignal) =>
    new Promise<never>((_, rejeter) => signal?.addEventListener("abort", () => rejeter(new Error("interrompu"))));
  return {
    specificationVersion: "v2" as const, provider: "muet", modelId: "muet", supportedUrls: {},
    doGenerate: (o: { abortSignal?: AbortSignal }) => attendre(o.abortSignal),
    doStream: (o: { abortSignal?: AbortSignal }) => attendre(o.abortSignal),
  };
}

/** Un modèle qui appelle l'outil, puis tombe en panne UNE FOIS l'outil exécuté. */
function modeleQuiEchoueApresOutil(nomOutil: string, outilExecute: () => boolean) {
  const flux = () => {
    if (outilExecute()) throw new Error("panne du fournisseur");
    const parts = [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: nomOutil, input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ];
    return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
  };
  return {
    specificationVersion: "v2" as const, provider: "fragile", modelId: "fragile", supportedUrls: {},
    doGenerate: async () => {
      if (outilExecute()) throw new Error("panne du fournisseur");
      return {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: nomOutil, input: "{}" }],
        finishReason: "tool-calls" as const, usage: USAGE, warnings: [],
      };
    },
    doStream: async () => flux(),
  };
}

const base = { user, historique: [], instructions: "Test.", delaiMs: 5_000 };


// Le journal de consommation que les tours du banc ont écrit (lot V3-D).
afterAll(() => effacerJournalDe(["u-test"]));
describe("repondreAvecSecours", () => {
  it("rend le texte et les outils appelés", async () => {
    const lire = outil("lire", vi.fn(async () => "{\"ok\":true}"));
    const { modele } = modeleFactice([{ appel: { outil: "lire", entree: {} } }, { texte: "Voici." }]);
    const r = await repondreAvecSecours({ ...base, message: "?", outils: [lire], modeles: [modele], propositionsFaites: () => 0 });
    expect(r).toMatchObject({ texte: "Voici.", outilsAppeles: ["lire"], modele: "factice/modele-factice", echecs: [] });
  });

  it("abandonne un modèle qui dépasse le délai, et le dit", async () => {
    await expect(
      repondreAvecSecours({ ...base, delaiMs: 300, message: "?", outils: [], modeles: [modeleMuet()], propositionsFaites: () => 0 }),
    ).rejects.toThrow(/Aucun modèle n'a répondu/);
  });

  it("ne rejoue pas un tour qui a déjà préparé une écriture : pas de seconde proposition", async () => {
    let propositions = 0;
    const ecrire = outil("ecrire", vi.fn(async () => { propositions += 1; return "{\"statut\":\"EN_ATTENTE_DE_CONFIRMATION\"}"; }));
    const { modele: second } = modeleFactice([{ appel: { outil: "ecrire", entree: {} } }, { texte: "Refait." }]);
    const r = await repondreAvecSecours({
      ...base, message: "écris", outils: [ecrire], modeles: [modeleQuiEchoueApresOutil("ecrire", () => propositions > 0), second],
      propositionsFaites: () => propositions,
    });
    expect(propositions).toBe(1);
    expect(r.texte).toMatch(/carte de confirmation/);
    expect(r.echecs).toHaveLength(1);
  });

  it("échoue clairement sans aucun modèle configuré", async () => {
    await expect(repondreAvecSecours({ ...base, message: "?", outils: [], modeles: [], propositionsFaites: () => 0 }))
      .rejects.toThrow(/aucun modèle configuré/);
  });
});
