import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { processusExclusPar, recettePour } from "@/modules/recettes/api";

/**
 * L'OUTIL `recette_pour` (J10, décision 0028) — « comment on fait ça chez nous ? » : la recette VALIDÉE d'un processus
 * (jamais une proposition), le plan de travail qui en est tiré, la phrase « selon la recette validée par X le … » et les
 * écarts de la demande (seuil franchi, délai court) ou d'un plan déjà préparé. Les droits : la recette d'un circuit dont
 * la personne ne voit pas l'écran n'existe pas pour elle ; une famille FERMÉE de la console retire ses processus.
 */
export function outilRecettePour(user: CurrentUser, famillesFermees: readonly string[]): PowerTool {
  const exclus = processusExclusPar(famillesFermees);
  return {
    def: {
      name: "recette_pour",
      description:
        "LES RECETTES DE LA MAISON : comment on fait chez nous un processus (prise en charge nationale ou internationale, sponsoring, "
        + "événement, validation réglementaire / RH / Finances, recrutement…) — étapes, qui valide, pièces habituelles, seuils (« la DG signe "
        + "au-delà de… »), durée médiane, pièges — tiré des dossiers réels et VALIDÉ par le responsable du processus. Rend aussi un PLAN "
        + "de travail prêt pour lancer_un_travail. Passe `plan` pour comparer un plan que tu as préparé à la recette (écarts).",
      input_schema: {
        type: "object",
        properties: {
          intention: { type: "string", description: "La demande, en une phrase, avec le montant et le délai s'ils sont donnés." },
          plan: { type: "object", description: "Facultatif : un plan { titre, objectif, etapes } à comparer à la recette." },
        },
        required: ["intention"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Recettes de la maison",
    run: async (entree, u) => {
      const intention = typeof entree.intention === "string" ? entree.intention.trim().slice(0, 1000) : "";
      if (intention.length < 3) return JSON.stringify({ statut: "REFUS", raison: "Donne l'intention : ce que la personne veut faire." });
      const plan = entree.plan && typeof entree.plan === "object" ? entree.plan : undefined;
      return JSON.stringify(await recettePour(u, intention, { exclus, plan }));
    },
  };
}
