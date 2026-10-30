import { afterAll, describe, expect, it, vi } from "vitest";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { repondreAvecSecours } from "./repondre";
import { modeleFactice } from "./testing/modele-factice";
import { effacerJournalDe } from "./testing/journal";

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

describe("outils choisis à la demande (J4) — seuls les ACTIFS partent au modèle", () => {
  it("une étape n'envoie que les actifs ; un outil trouvé en cours de tour part à l'étape suivante", async () => {
    const actifs = new Set(["socle_a"]);
    const outils = [
      outil("socle_a", async () => "a"),
      outil("trouver_outil", async () => { actifs.add("rare_b"); return JSON.stringify({ trouves: [{ outil: "rare_b" }] }); }),
      outil("rare_b", async () => "b"),
      outil("jamais_c", async () => "c"),
    ];
    actifs.add("trouver_outil");
    const { modele, outilsRecus } = modeleFactice([
      { appel: { outil: "trouver_outil", entree: {} } },
      { appel: { outil: "rare_b", entree: {} } },
      { texte: "Fait." },
    ]);
    const r = await repondreAvecSecours({
      ...base, message: "?", outils, modeles: [modele], propositionsFaites: () => 0, actifs: () => [...actifs].sort(),
    });
    expect(r.texte).toBe("Fait.");
    // L'ordre envoyé est celui de l'enregistrement des outils (le catalogue) : stable d'un tour à l'autre.
    expect(outilsRecus[0]).toEqual(["socle_a", "trouver_outil"]);
    expect(outilsRecus[1]).toEqual(["socle_a", "trouver_outil", "rare_b"]);
    expect(outilsRecus.flat()).not.toContain("jamais_c");
  });

  it("sans sélection (routines, anciens appelants), tous les outils offerts partent", async () => {
    const { modele, outilsRecus } = modeleFactice([{ texte: "Ok." }]);
    await repondreAvecSecours({ ...base, message: "?", outils: [outil("x", async () => "x"), outil("y", async () => "y")], modeles: [modele], propositionsFaites: () => 0 });
    expect(outilsRecus[0].sort()).toEqual(["x", "y"]);
  });
});
