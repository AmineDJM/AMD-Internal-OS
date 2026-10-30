/**
 * LE FAUX MODÈLE — celui qui rend les tests de l'agent déterministes (Q16, niveau 1).
 *
 * Il rejoue un SCÉNARIO écrit d'avance : à chaque appel du modèle, il rend le tour suivant, soit
 * un appel d'outil, soit un texte. Aucun réseau, aucune clé, aucun coût, et le même résultat à
 * chaque exécution. Il garde aussi les prompts reçus : un test peut vérifier ce que l'agent a
 * réellement envoyé au modèle (le contexte compilé, les consignes du rôle).
 *
 * Ce n'est PAS un mock de Mastra : c'est un modèle au format AI SDK v2, celui que Mastra consomme
 * pour un vrai fournisseur. La boucle d'agent, la validation des entrées d'outil et la reprise
 * après appel d'outil tournent donc pour de bon.
 */
export type TourScenario =
  | { texte: string }
  | { appel: { outil: string; entree: Record<string, unknown> } };

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
const USAGE: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** `usage` : les jetons rendus à CHAQUE appel — un banc de plafond en pose de plus lourds. */
export function modeleFactice(scenario: TourScenario[], usage: { inputTokens: number; outputTokens: number } = USAGE) {
  const u: Usage = { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
  let tour = 0;
  const promptsRecus: unknown[] = [];
  /** J4 : les noms des outils envoyés au modèle, appel par appel — ce que `activeTools` a laissé passer. */
  const outilsRecus: string[][] = [];
  const noter = (options: { tools?: { name?: string }[] }) => outilsRecus.push((options.tools ?? []).map((t) => t.name ?? "").filter(Boolean));
  let compteurAppels = 0;

  const prochain = (): TourScenario => {
    const t = scenario[Math.min(tour, scenario.length - 1)];
    tour += 1;
    return t;
  };

  const contenu = (t: TourScenario) =>
    "texte" in t
      ? [{ type: "text" as const, text: t.texte }]
      : [{ type: "tool-call" as const, toolCallId: `appel-${++compteurAppels}`, toolName: t.appel.outil, input: JSON.stringify(t.appel.entree) }];
  const fin = (t: TourScenario) => ("texte" in t ? ("stop" as const) : ("tool-calls" as const));

  const modele = {
    specificationVersion: "v2" as const,
    provider: "factice",
    modelId: "modele-factice",
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown; tools?: { name?: string }[] }) {
      promptsRecus.push(options.prompt);
      noter(options);
      const t = prochain();
      return { content: contenu(t), finishReason: fin(t), usage: u, warnings: [] };
    },
    async doStream(options: { prompt: unknown; tools?: { name?: string }[] }) {
      promptsRecus.push(options.prompt);
      noter(options);
      const t = prochain();
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("texte" in t) {
        parts.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: t.texte }, { type: "text-end", id: "t1" });
      } else {
        const [appel] = contenu(t);
        parts.push(appel);
      }
      parts.push({ type: "finish", finishReason: fin(t), usage: u });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };

  return { modele, promptsRecus, outilsRecus, toursJoues: () => tour };
}
