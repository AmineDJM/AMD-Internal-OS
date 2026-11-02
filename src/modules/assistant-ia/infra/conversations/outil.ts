import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { chercherPourModele } from "./service";

/**
 * « COMME ON AVAIT DIT POUR LE CONGRÈS D'ORAN » — la mémoire des conversations passées (décision 0027, point 3).
 *
 * L'outil cherche dans les conversations de LA PERSONNE seulement, jamais dans une conversation privée ni dans celle
 * en cours ; les extraits passent le filtre de confidentialité (`chercherPourModele`) et sont encadrés comme contenu
 * tiers (`contenu-non-fiable.ts`). Une conversation privée n'a PAS cet outil : elle ne lit pas la mémoire.
 */
export const OUTIL_CONVERSATIONS = "chercher_conversations";

export function outilConversationsPassees(user: CurrentUser, conversationEnCours: string | null): PowerTool {
  return {
    def: {
      name: OUTIL_CONVERSATIONS,
      description:
        "Cherche dans les conversations PASSÉES de l'utilisateur avec toi (titres et messages), quand il fait référence à un échange antérieur "
        + "(« comme on avait dit… », « la dernière fois… »). Rend des extraits datés avec le titre de la conversation. Ne sert pas à chercher dans l'ERP.",
      input_schema: {
        type: "object",
        properties: { recherche: { type: "string", description: "Deux à cinq mots du sujet (« congrès Oran budget »)." } },
        required: ["recherche"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Conversations passées consultées",
    run: async (entree) => {
      const recherche = typeof entree.recherche === "string" ? entree.recherche : "";
      // Plusieurs mots : chacun est cherché, les extraits sont réunis (la recherche en base est par sous-chaîne).
      const mots = recherche.split(/\s+/).filter((m) => m.length >= 3).slice(0, 4);
      const vus = new Set<string>();
      const trouves = [];
      for (const m of mots.length ? mots : [recherche]) {
        for (const e of await chercherPourModele(user.id, m, conversationEnCours)) {
          const cle = `${e.date}|${e.extrait}`;
          if (vus.has(cle)) continue;
          vus.add(cle);
          trouves.push(e);
        }
      }
      if (!trouves.length) return JSON.stringify({ statut: "AUCUN_RESULTAT", consigne: "Dis-le simplement : aucune conversation passée n'en parle." });
      return JSON.stringify({ statut: "OK", extraits: trouves.slice(0, 8) });
    },
  };
}
