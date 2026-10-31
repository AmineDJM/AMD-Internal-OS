import type { PowerTool } from "@/platform/ia/outil";
import { callModel } from "@/lib/models/gateway";
// Le puits d'usage : branché par qui appelle un modèle (voir son en-tête) — l'Assistant IA lit le web sans charger Adam.
import "@/platform/ia/telemetry/usage-sink";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RECHERCHE WEB — la seule fenêtre d'Adam sur l'EXTÉRIEUR de l'entreprise.
 *
 * ── CE QUE C'EST, ET CE QUE CE N'EST PAS ─────────────────────────────────────────────────
 *
 * Tout le reste du produit lit l'ERP : des faits INTERNES, à jour par construction, sous RBAC.
 * Cet outil lit le WEB : des faits EXTERNES, d'une fraîcheur incertaine, écrits par n'importe
 * qui. Les deux ne doivent JAMAIS se confondre — c'est pourquoi chaque réponse d'ici porte sa
 * provenance (« WEB (EXTERNE) ») et ses sources datées, et pourquoi la description de l'outil
 * interdit de s'en servir pour une question interne : « combien de dossiers en cours ? » se lit
 * dans l'ERP, pas sur Google.
 *
 * ── LE MÉCANISME ─────────────────────────────────────────────────────────────────────────
 *
 * L'outil `web_search` NATIF de l'API Responses, par la passerelle (`callModel`, rôle worker,
 * `webSearch: true`). Pas de scraping maison, pas de clé de moteur de recherche supplémentaire :
 * le fournisseur cherche, lit, synthétise, et rend ses CITATIONS (`reply.webSources`) et le
 * NOMBRE de recherches (`usage.webSearchCalls`, facturées à l'unité — voir `registry.ts`).
 *
 * ── L'HONNÊTETÉ SUR LA PROVENANCE ────────────────────────────────────────────────────────
 *
 * Le modèle peut répondre SANS avoir cherché (zéro `web_search_call`) : sa réponse vient alors
 * de sa mémoire d'entraînement, datée et non sourcée. On ne la déguise pas en résultat web —
 * `provenance: "MODELE_SANS_RECHERCHE"` le dit, et l'appelant (humain ou mission) en fait ce
 * qu'il veut. Une réponse web sans source n'existe pas ; une réponse de mémoire sans étiquette
 * non plus.
 *
 * ── LES RECHERCHES PROFONDES SE COMPOSENT ────────────────────────────────────────────────
 *
 * Une veille concurrentielle complète n'est pas « un gros appel » : c'est une MISSION dont
 * plusieurs étapes appellent cette capacité (batchable, idempotente), puis une synthèse. Le
 * DAG, la reprise, le coût par étape : tout existe déjà dans le runtime — on ne le recode pas
 * dans un outil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

/** La date du jour en toutes lettres (Alger) — le modèle doit savoir QUAND il cherche. */
function dateAlger(): string {
  const alg = new Date(Date.now() + 3_600_000);
  return alg.toISOString().slice(0, 10);
}

export const WEB_RESEARCH_TOOLS: PowerTool[] = [
  {
    def: {
      name: "web_research",
      description:
        "Cherche sur le WEB (extérieur de l'entreprise) et rend une synthèse SOURCÉE : prix publics, "
        + "réglementation étrangère, actualité d'un laboratoire, congrès, publications. À utiliser UNIQUEMENT "
        + "pour une information externe — jamais pour une donnée de l'ERP (dossiers, budgets, salariés, stocks : "
        + "les autres outils font foi). Le résultat est une source EXTERNE, d'une fraîcheur incertaine : le dire "
        + "en le citant, avec ses URL. `query` : la question, précise et datée si possible. "
        + "`contexte` (optionnel) : ce qu'on sait déjà, pour orienter la recherche.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "La question à instruire sur le web, formulée précisément." },
          contexte: { type: "string", description: "Contexte connu (produit, pays, période) pour orienter la recherche." },
        },
        required: ["query"],
      },
    },
    // Le web n'est pas une donnée cloisonnée de l'ERP : l'outil est ouvert à quiconque parle à
    // l'assistant. Le COÛT, lui, est compté (usage.webSearchCalls) et plafonnable par mission.
    allowed: () => true,
    label: "Recherche web effectuée",
    run: async (input) => {
      const query = str(input, "query");
      if (!query) return "Indiquez la question à chercher (« query »).";
      const contexte = str(input, "contexte");

      const prompt =
        `Nous sommes le ${dateAlger()}. Cherche sur le web et réponds en français, de façon factuelle et datée.\n`
        + `QUESTION : ${query}\n`
        + (contexte ? `CONTEXTE CONNU : ${contexte}\n` : "")
        + "Règles : fais autant de recherches qu'il faut et croise les sources ; appuie chaque affirmation importante sur une "
        + "source ; si les sources se contredisent, dis-le ; si l'information est introuvable ou trop ancienne pour être "
        + "fiable, dis-le plutôt que d'extrapoler. Rends une réponse COMPLÈTE et UTILE : l'essentiel d'abord, puis le détail "
        + "(chiffres, dates, acteurs), et ce qu'il faut en retenir.";

      // 31/10/2026 (Direction : « des recherches aussi bonnes que ChatGPT ») : réflexion MOYENNE (plusieurs recherches,
      // sources croisées) et une synthèse COMPLÈTE — l'ancien plafond de 1 400 jetons rendait une page courte.
      const reply = await callModel("worker", [{ role: "user", content: prompt }], {
        webSearch: true,
        reasoning: "medium",
        verbosity: "high",
        maxOutputTokens: 4_500,
        timeoutMs: 180_000,
      });

      if (!reply.configured) return "La recherche web est indisponible : clé du fournisseur non configurée.";
      if (!reply.ok) return `La recherche web a échoué : ${reply.error ?? "cause inconnue"}. Réessayer, ou reformuler la question.`;

      const texte = reply.blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!texte) return "La recherche n'a rien rendu d'exploitable. Reformuler la question, plus précisément.";

      const recherches = reply.usage.webSearchCalls ?? 0;
      const sources = reply.webSources ?? [];

      return JSON.stringify({
        reponse: texte,
        // LA PROVENANCE EST DITE, TOUJOURS : une réponse sans recherche vient de la mémoire du
        // modèle — datée, non vérifiée — et ne doit pas se faire passer pour un fait du jour.
        provenance: recherches > 0 ? "WEB (EXTERNE)" : "MODELE_SANS_RECHERCHE",
        recherchesExecutees: recherches,
        sources: sources.map((s) => ({ url: s.url, titre: s.title })),
        recupereLe: new Date().toISOString(),
        avertissement:
          "Information EXTERNE (web) — à distinguer des données de l'ERP. Vérifier la date de chaque source avant d'en faire un fait.",
      });
    },
  },
];
