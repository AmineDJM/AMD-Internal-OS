import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { DIRECTORY_TOOLS } from "@/lib/assistant/directory-tools";
import { REGULATORY_READ_TOOLS } from "@/lib/assistant/regulatory-read";
import { assistantToolsFor, buildProposal, executeReadTool, type ProposedAction } from "@/lib/assistant";
import { persistActionIntents } from "@/lib/assistant/action-intents";
import { censurerObjet, censurerTexte } from "@/lib/agent/filtre-confidentialite";

/**
 * LES OUTILS DE LA V1 — tous EXISTANTS, aucun réécrit (Q7, Q20).
 *
 * Lecture : annuaire (2), Regulatory (3), tâches et produits (lus par `executeReadTool`, avec le
 * contrôle d'accès qu'ils portent déjà). Écriture : `create_task` et `send_message`, préparés par
 * `buildProposal` (destinataire désigné PAR SON NOM, refus explicite s'il est introuvable ou
 * ambigu) et enregistrés comme intentions : RIEN ne s'écrit avant la confirmation, qui passe par
 * `executeAssistantAction` (droit revérifié, `envoyerMessageDirect`, notification, audit).
 *
 * Tout ce qui revient au modèle passe le filtre de confidentialité (Q12) : MiMo ne reçoit jamais
 * une rémunération, une coordonnée bancaire ni une pièce d'identité.
 */
const LECTURES_POWER = new Set(["directory_lookup", "directory_list", "regulatory_portfolio", "regulatory_workload", "regulatory_knowledge"]);
const LECTURES_MOTEUR = new Set(["list_my_tasks", "search_products"]);
const ECRITURES = new Set(["create_task", "send_message"]);

/** Le résultat d'un outil, censuré avant de partir au modèle. JSON gardé JSON quand il l'était. */
export function censurerSortie(sortie: string): string {
  try {
    const { resultat } = censurerObjet(JSON.parse(sortie));
    return JSON.stringify(resultat);
  } catch {
    return censurerTexte(sortie).texte;
  }
}

const filtre = (outil: PowerTool): PowerTool => ({
  ...outil,
  run: async (entree, user) => censurerSortie(await outil.run(entree, user)),
});

export interface PropositionPreparee {
  intentId: string;
  proposition: ProposedAction;
}

/**
 * Les outils de CET utilisateur, pour CE tour. `propositions` recueille les intentions créées
 * pendant le tour : la réponse les rend à l'interface pour afficher la carte de confirmation.
 */
export function outilsV1(user: CurrentUser, propositions: PropositionPreparee[]): PowerTool[] {
  // `assistantToolsFor` applique déjà les conditions d'accès de l'assistant de production.
  const defs = assistantToolsFor(user);
  const defParNom = new Map(defs.map((d) => [d.name, d]));

  const lecturesPower = [...DIRECTORY_TOOLS, ...REGULATORY_READ_TOOLS].filter((o) => LECTURES_POWER.has(o.def.name));

  const lecturesMoteur: PowerTool[] = [...LECTURES_MOTEUR].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    return [{ def, allowed: (u) => u.id === user.id, label: def.name, run: (entree, u) => executeReadTool(nom, entree, u) }];
  });

  const ecritures: PowerTool[] = [...ECRITURES].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    return [{
      def,
      allowed: (u) => u.id === user.id,
      label: def.name,
      run: async (entree, u) => {
        const p = await buildProposal(nom, entree, u);
        if ("error" in p) return JSON.stringify({ statut: "REFUS", raison: p.error });
        const [intentId] = await persistActionIntents(u.id, [p], "text");
        if (!intentId) return JSON.stringify({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
        propositions.push({ intentId, proposition: { ...p, intentId } });
        return JSON.stringify({
          statut: "EN_ATTENTE_DE_CONFIRMATION",
          titre: p.title,
          champs: p.fields,
          consigne: "Rien n'est exécuté : une carte de confirmation est affichée. Ne dis pas que c'est fait.",
        });
      },
    }];
  });

  return [...lecturesPower, ...lecturesMoteur, ...ecritures].map(filtre);
}
