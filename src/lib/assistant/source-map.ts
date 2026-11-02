/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `source_map` — Adam répond « OÙ pourrait vivre cette information, et c'est frais jusqu'à
 * quand ? » sans fouiller, parce que la carte existe (fabric F3).
 *
 * ── LES DEUX QUESTIONS QUE CET OUTIL FERME ──────────────────────────────────────────────
 *
 *   1. « Où chercher X ? » — avant cet outil, la réponse vivait dans la tête du modèle, donc
 *      nulle part : chaque conversation redécouvrait les sources par essais. La carte dit ce
 *      que chaque famille CONTIENT, par quels MODES elle se cherche, et qui fait AUTORITÉ.
 *   2. « Tes données datent de quand ? » — pour les sources DÉRIVÉES (l'index de contenu du
 *      Drive), la sonde MESURE l'instant du dernier élément indexé : « synchronisé jusqu'à
 *      14:32 » devient une phrase vraie, pas une formule.
 *
 * ── LA DISTINCTION QUI PROTÈGE LE JUGE (§36 : pas de faux omniscient) ───────────────────
 *
 * `preuveNegative` dit, source par source, si une absence y est DÉMONTRABLE. L'index de
 * contenu répond NON : « pas dans l'index » n'est pas « pas dans le Drive » — l'ingestion est
 * incrémentale. Publier ce booléen évite qu'une recherche vide dans une source partielle soit
 * citée comme preuve qu'une chose n'existe pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { SOURCES, fraicheurDe } from "@/lib/fabric/registry";

// Le type de `allowed` vient du contrat PowerTool lui-même : pas d'import de session ici —
// un franchissement de frontière de moins pour un fichier qui n'a pas besoin d'en savoir plus.
const EXEC: PowerTool["allowed"] = (u) => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

export const SOURCE_MAP_TOOLS: PowerTool[] = [
  {
    def: {
      name: "source_map",
      description:
        "LA CARTE DES SOURCES d'information de l'entreprise : ce que chaque famille contient, par quels modes elle se " +
        "cherche (exact/texte intégral/fuzzy/sémantique), qui fait AUTORITÉ sur quoi, si une ABSENCE y est démontrable, " +
        "et jusqu'à QUAND les sources dérivées sont synchronisées. À consulter AVANT une recherche multi-sources " +
        "(« où pourrait vivre X ? ») ou pour répondre « tes données datent de quand ? ».",
      input_schema: {
        type: "object",
        properties: {
          famille: { type: "string", description: "Limiter à une famille précise (omettre pour la carte entière)." },
        },
      },
    },
    allowed: EXEC,
    label: "Carte des sources consultée",
    run: async (input) => {
      const filtre = typeof input.famille === "string" && input.famille.trim() !== ""
        ? input.famille.trim().toUpperCase()
        : null;
      const retenues = filtre ? SOURCES.filter((s) => s.famille === filtre) : SOURCES;
      if (retenues.length === 0) {
        return JSON.stringify({
          items: [], count: 0,
          message: `Aucune famille « ${filtre} ». Familles connues : ${SOURCES.map((s) => s.famille).join(", ")}.`,
        });
      }

      // LES SONDES EN PARALLÈLE : dix familles = une salve, pas une file.
      const fraicheurs = await Promise.all(retenues.map((s) => fraicheurDe(s.famille)));
      const items = retenues.map((s, i) => ({
        famille: s.famille,
        contenu: s.contenu,
        entites: s.entites,
        modes: s.modes,
        autorite: s.autorite,
        // La phrase est explicite parce que c'est elle qui sera restituée : un booléen nu
        // finirait paraphrasé, et la paraphrase est là où « non démontrable » devient « non ».
        preuveNegative: s.preuveNegative
          ? "OUI — un compte exhaustif y est possible"
          : "NON — couverture partielle : une recherche vide n'y démontre PAS une absence",
        capacites: s.capacites,
        fraicheur: {
          nature: fraicheurs[i].nature,
          ...(fraicheurs[i].nature === "INDEXEE"
            ? {
              synchroniseeJusqua: fraicheurs[i].synchroniseeJusqua?.toISOString() ?? null,
              note: fraicheurs[i].synchroniseeJusqua
                ? undefined
                : "aucun élément indexé pour l'instant (ou fraîcheur non mesurable)",
            }
            : {}),
          elementsEstimes: fraicheurs[i].elementsEstimes,
          ...(fraicheurs[i].elementsEstimes !== null
            ? { noteEstimation: "estimation du planificateur Postgres, pas un compte" }
            : {}),
        },
      }));
      return JSON.stringify({ items, count: items.length });
    },
  },
];
