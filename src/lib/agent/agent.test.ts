import { describe, expect, it, vi } from "vitest";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { Agent } from "@mastra/core/agent";
import { adapterOutil, outilsPour } from "@/lib/agent/outils";
import { zodDepuisSchemaJson } from "@/lib/agent/schema";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";

/**
 * L'AGENT DU BANC — construit comme dans la porte de production (`repondreAvecSecours`) : outils filtrés
 * par le droit de l'utilisateur (`outilsPour`), boucle de Mastra pour de bon. L'ancien `agent.ts`
 * (`creerAgent`, `repondre`) n'avait que ce banc pour appelant (IA-ASSISTANT-08) : il est supprimé, et
 * ce qu'il servait à éprouver — l'adaptateur et le RBAC dans la vraie boucle — l'est ici.
 */
function creerAgent({ user, modele, outils }: { user: CurrentUser; modele: unknown; outils: PowerTool[] }) {
  return new Agent({ id: "banc", name: "Banc", instructions: "Banc.", model: modele as never, tools: outilsPour(outils, user) });
}

async function repondre(agent: Agent, message: string): Promise<{ texte: string; outilsAppeles: string[] }> {
  const r = await agent.generate(message, { maxSteps: 5 });
  const appels = (r.steps ?? []).flatMap((e) => (e.toolCalls ?? []).map((c) => (c as { payload?: { toolName?: string } }).payload?.toolName ?? ""));
  return { texte: r.text, outilsAppeles: appels.filter(Boolean) };
}

const utilisateur = (role: string) => ({ id: `u-${role}`, role }) as unknown as CurrentUser;

function outilAnnuaire(opts: { ouvertA: string[] }) {
  const run = vi.fn(async (entree: Record<string, unknown>) => JSON.stringify({ items: [{ nom: String(entree.name) }], count: 1 }));
  const outil: PowerTool = {
    def: {
      name: "directory_lookup",
      description: "Retrouve une personne.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    } as PowerTool["def"],
    allowed: (u) => opts.ouvertA.includes(u.role as string),
    refus: "L'annuaire ne vous est pas ouvert.",
    label: "Annuaire consulté",
    run,
  };
  return { outil, run };
}

describe("zodDepuisSchemaJson", () => {
  it("exige les champs requis et laisse les autres facultatifs", () => {
    const s = zodDepuisSchemaJson({ type: "object", properties: { name: { type: "string" }, limite: { type: "integer" } }, required: ["name"] });
    expect(s.safeParse({ name: "Raihana" }).success).toBe(true);
    expect(s.safeParse({ limite: 3 }).success).toBe(false);
    expect(s.safeParse({ name: "R", limite: 1.5 }).success).toBe(false);
  });

  it("borne une énumération et retombe sur z.any() pour ce qu'il ne connaît pas", () => {
    const e = zodDepuisSchemaJson({ enum: ["a", "b"] });
    expect(e.safeParse("a").success).toBe(true);
    expect(e.safeParse("c").success).toBe(false);
    expect(zodDepuisSchemaJson({ type: "null" }).safeParse(42).success).toBe(true);
  });
});

describe("adaptateur d'outil — le RBAC est le plafond", () => {
  it("n'exécute JAMAIS un outil dont le droit manque, et rend le refus de l'outil", async () => {
    const { outil, run } = outilAnnuaire({ ouvertA: ["DG"] });
    const adapte = adapterOutil(outil, utilisateur("STAGIAIRE"));
    const retour = await (adapte as unknown as { execute: (e: unknown) => Promise<string> }).execute({ name: "Raihana" });
    expect(retour).toBe("L'annuaire ne vous est pas ouvert.");
    expect(run).not.toHaveBeenCalled();
  });

  it("ne montre au modèle que les outils ouverts à l'utilisateur", () => {
    const { outil } = outilAnnuaire({ ouvertA: ["DG"] });
    expect(Object.keys(outilsPour([outil], utilisateur("DG")))).toEqual(["directory_lookup"]);
    expect(Object.keys(outilsPour([outil], utilisateur("STAGIAIRE")))).toEqual([]);
  });
});

describe("agent avec faux modèle", () => {
  it("appelle l'outil avec l'utilisateur courant puis répond à partir du résultat", async () => {
    const { outil, run } = outilAnnuaire({ ouvertA: ["DG"] });
    const user = utilisateur("DG");
    const { modele, toursJoues } = modeleFactice([
      { appel: { outil: "directory_lookup", entree: { name: "Raihana" } } },
      { texte: "Raihana figure dans l'annuaire." },
    ]);
    const agent = creerAgent({ user, modele: modele as never, outils: [outil] });

    const r = await repondre(agent, "Retrouve Raihana");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ name: "Raihana" }, user);
    expect(r.texte).toBe("Raihana figure dans l'annuaire.");
    expect(r.outilsAppeles).toEqual(["directory_lookup"]);
    expect(toursJoues()).toBe(2);
  });

  it("répond sans outil quand le modèle n'en demande pas", async () => {
    const { outil, run } = outilAnnuaire({ ouvertA: ["DG"] });
    const { modele } = modeleFactice([{ texte: "Bonjour." }]);
    const r = await repondre(creerAgent({ user: utilisateur("DG"), modele: modele as never, outils: [outil] }), "Salut");
    expect(r).toEqual({ texte: "Bonjour.", outilsAppeles: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("n'exécute pas un outil que le modèle réclame alors qu'il ne figure pas dans les droits de l'utilisateur", async () => {
    const { outil, run } = outilAnnuaire({ ouvertA: ["DG"] });
    const { modele } = modeleFactice([
      { appel: { outil: "directory_lookup", entree: { name: "Raihana" } } },
      { texte: "Je n'ai pas accès à l'annuaire." },
    ]);
    const r = await repondre(creerAgent({ user: utilisateur("STAGIAIRE"), modele: modele as never, outils: [outil] }), "Retrouve Raihana");
    expect(run).not.toHaveBeenCalled();
    expect(r.texte).toBe("Je n'ai pas accès à l'annuaire.");
  });
});
