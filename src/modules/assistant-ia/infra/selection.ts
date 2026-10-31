import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import {
  classer, indexer, OUTIL_TROUVER, ordonnerActifs, preselectionner, TROUVES_MAX, type FicheOutil,
} from "../domaine/selection-outils";
import { reglesAjoutees } from "./contexte";
import { motsDesCapacites } from "./capacites";
import { autoriseParLaConfig } from "../domaine/capacites";

/**
 * LA SÉLECTION D'OUTILS D'UN TOUR (J4, décision 0018) — la règle est pure (`domaine/selection-outils.ts`) ; ici, on
 * l'applique aux outils RÉELS de la personne et on fabrique `trouver_outil`.
 *
 * Les fiches sont les outils que l'adaptateur offrira (`allowed`, configuration du rôle) : la sélection ne peut
 * qu'en retirer de la vue du modèle, jamais en ajouter un hors droits. Les outils restent TOUS enregistrés auprès de
 * l'agent ; seuls les ACTIFS de l'étape partent au modèle (`prepareStep` → `activeTools`). Un appel à un outil
 * enregistré mais non actif passe par la même garde que les autres.
 */
export interface SelectionDuTour {
  /** L'outil `trouver_outil`, à ajouter aux outils du tour. */
  outil: PowerTool;
  /** Les outils actifs, dans un ordre stable — relus avant CHAQUE étape. */
  actifs: () => string[];
  /** Ceux offerts au début du tour (la consigne y choisit ses règles). */
  initiaux: string[];
  /** Ceux que `trouver_outil` a ajoutés pendant le tour (journal, banc). */
  trouves: () => string[];
}

/** Les fiches des outils qu'une personne se verra offrir — même filtre que l'adaptateur (`outilsPour`). */
export function fichesOffertes(outils: readonly PowerTool[], user: CurrentUser, config?: { allowedTools?: string[] } | null): FicheOutil[] {
  const autorises = config?.allowedTools?.length ? new Set(config.allowedTools) : null;
  const mots = motsDesCapacites();
  return outils
    .filter((o) => o.def.name !== OUTIL_TROUVER && o.allowed(user) && autoriseParLaConfig(o.def.name, autorises))
    .map((o) => ({ nom: o.def.name, libelle: o.label, description: o.def.description, ...mots.get(o.def.name) }));
}

/** Le poids d'un outil envoyé au modèle, en jetons (÷ 3,2 : la calibration du banc J4) — calculé une fois par définition. */
const JETONS = new WeakMap<PowerTool["def"], number>();
const jetonsDe = (d: PowerTool["def"]): number => {
  let j = JETONS.get(d);
  if (j === undefined) { j = Math.ceil(JSON.stringify(d).length / 3.2); JETONS.set(d, j); }
  return j;
};

export function selectionDuTour(
  outils: readonly PowerTool[], user: CurrentUser, demande: string, config?: { allowedTools?: string[] } | null, precedente = "",
  prioritaires: readonly string[] = [],
): SelectionDuTour {
  const fiches = fichesOffertes(outils, user, config);
  const disponibles = new Set([OUTIL_TROUVER, ...fiches.map((f) => f.nom)]);
  const index = indexer(fiches);
  const parNom = new Map(fiches.map((f) => [f.nom, f]));
  const defs = new Map(outils.map((o) => [o.def.name, o.def]));
  const poids = (nom: string) => { const d = defs.get(nom); return d ? jetonsDe(d) : 0; };
  const initiaux = preselectionner(demande, fiches, undefined, precedente, poids, prioritaires).filter((n) => disponibles.has(n));
  const actifs = new Set<string>([OUTIL_TROUVER, ...initiaux]);
  const trouves: string[] = [];

  const outil: PowerTool = {
    def: {
      name: OUTIL_TROUVER,
      description:
        "TROUVE l'outil qui convient quand aucun outil visible ne couvre la demande : décris l'intention en quelques mots. "
        + "Les outils trouvés (dans les droits de la personne) deviennent disponibles à l'étape suivante.",
      input_schema: {
        type: "object",
        properties: { intention: { type: "string", description: "Ce que tu veux faire, en quelques mots (« lire les congés d'une personne »)." } },
        required: ["intention"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Outils recherchés",
    run: async (entree) => {
      const intention = typeof entree.intention === "string" ? entree.intention.slice(0, 300) : "";
      const classes = classer(intention, index, TROUVES_MAX);
      if (!classes.length) {
        return JSON.stringify({
          trouves: [],
          consigne: "Aucun outil de cette personne ne couvre cette intention : ses droits ne l'ouvrent pas. Dis-le en nommant le droit (son rôle, une famille fermée par la Direction), jamais « je n'ai pas l'outil ».",
        });
      }
      const avant = [...actifs];
      for (const c of classes) {
        if (!actifs.has(c.nom)) trouves.push(c.nom);
        actifs.add(c.nom);
      }
      const regles = reglesAjoutees(avant, classes.map((c) => c.nom));
      return JSON.stringify({
        trouves: classes.map((c) => ({ outil: c.nom, quoi: (parNom.get(c.nom)?.description ?? "").slice(0, 160) })),
        consigne: "Ces outils sont disponibles maintenant : appelle celui qui convient.",
        ...(regles.length ? { regles } : {}),
      });
    },
  };

  return {
    outil,
    actifs: () => ordonnerActifs(actifs, disponibles),
    initiaux: ordonnerActifs(actifs, disponibles),
    trouves: () => [...trouves],
  };
}
