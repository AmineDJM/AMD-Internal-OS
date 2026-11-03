import type { PowerTool } from "@/platform/ia/outil";
import { estOutilAdam, FACTEUR_ADAM, FICHE_ADAM_CARACTERES } from "./adam/outils-adam";
import type { CurrentUser } from "@/lib/session";
import {
  classer, indexer, OUTIL_TROUVER, ordonnerActifs, preselectionner, TROUVES_MAX, type FicheOutil,
} from "../domaine/selection-outils";
import { reglesAjoutees } from "./contexte";
import { motsDesCapacites } from "./capacites";
import { MOTS_EXPORTS } from "./exports";
import { NAVIGATION } from "@/lib/labels";
import { CATALOGUE_EXPORTS } from "@/platform/ia/exports";
import { autoriseParLaConfig } from "../domaine/capacites";
import { QUI_OUVRE_UN_GESTE, type GesteFerme } from "./refus-nomme";

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
    .map((o) => (estOutilAdam(o.def.name)
      // A2 (décision 0055) : une fonction d'Adam (Super Admin) — sa fiche est sa première phrase, et son rang est réduit.
      ? { nom: o.def.name, libelle: o.label, description: o.def.description.slice(0, FICHE_ADAM_CARACTERES), facteur: FACTEUR_ADAM }
      : { nom: o.def.name, libelle: o.label, description: o.def.description, ...(mots.get(o.def.name) ?? MOTS_EXPORTS.get(o.def.name)) }));
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
  /**
   * Lot I2 (décision 0064) : les gestes qui EXISTENT pour la personne mais que son rôle n'ouvre pas — lus à la demande, au
   * premier `trouver_outil` qui en a besoin. Ils ne sont jamais offerts ni récités : `trouver_outil` les NOMME en refus.
   */
  fermes?: () => readonly GesteFerme[],
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
  // Le refus nommé (I2) : un index commun aux outils offerts ET aux gestes fermés, pour savoir si la demande vise d'abord un
  // geste fermé. Construit au premier besoin seulement ; l'index des outils offerts (la sélection, J6) n'en est pas changé.
  let refus: { index: ReturnType<typeof indexer>; parNom: Map<string, GesteFerme> } | null = null;
  const fermesVises = (intention: string): GesteFerme[] => {
    if (!fermes) return [];
    if (!refus) {
      const liste = fermes().filter((f) => !disponibles.has(f.nom));
      refus = { index: indexer([...fiches, ...liste]), parNom: new Map(liste.map((f) => [f.nom, f])) };
    }
    const r = refus;
    const vises: GesteFerme[] = [];
    // Seuls les gestes fermés classés AVANT le premier outil offert : la demande les vise d'abord.
    for (const c of classer(intention, r.index, 3)) {
      const f = r.parNom.get(c.nom);
      if (!f) break;
      vises.push(f);
    }
    return vises;
  };
  const nommer = (f: GesteFerme) => ({ geste: f.libelle, droit: f.droit, quiOuvre: QUI_OUVRE_UN_GESTE });

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
      const vises = fermesVises(intention);
      if (vises.length && !classes.length) {
        const ecrans = ecransPour(intention);
        return JSON.stringify({
          trouves: [],
          fermes: vises.map(nommer),
          ...(ecrans.length ? { ecrans } : {}),
          consigne: "Ce geste existe dans l'ERP mais n'est pas ouvert à cette personne : dis-le en nommant le geste, le droit qui manque et qui l'ouvre (`fermes`) "
            + "— jamais « je ne peux pas » ni « je n'ai pas l'outil » sans cela.",
        });
      }
      if (!classes.length) {
        const ecrans = ecransPour(intention);
        return JSON.stringify({
          trouves: [],
          ...(ecrans.length ? { ecrans } : {}),
          consigne: "Aucun outil de cette personne ne couvre cette intention : ses droits ne l'ouvrent pas, ou le geste se fait seulement à l'écran. "
            + "Dis-le en nommant le droit (son rôle, une famille fermée par la Direction) et, si un écran ci-dessus le fait, donne son lien direct en Markdown — jamais « je ne peux pas » ni « je n'ai pas l'outil » sans cela.",
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
        consigne: vises.length
          ? "Ces outils sont disponibles maintenant. Si la demande vise un geste de `fermes`, il n'est pas ouvert à cette personne : dis-le en le nommant, avec le droit et qui l'ouvre ; sinon appelle l'outil qui convient."
          : "Ces outils sont disponibles maintenant : appelle celui qui convient.",
        ...(vises.length ? { fermes: vises.map(nommer) } : {}),
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

/**
 * LES ÉCRANS QUI FONT CE QUE L'ASSISTANT NE FAIT PAS (lot K7, décision 0037) — quand `trouver_outil` ne trouve rien, le
 * refus nomme l'ÉCRAN qui porte le geste, avec son lien direct : le menu de l'ERP (entrées et onglets) et les écrans
 * des exports. Un lien, pas un droit : la page juge elle-même qui l'ouvre.
 */
const FICHES_ECRANS: FicheOutil[] = [
  ...NAVIGATION.flatMap((n) => [
    { nom: n.href, libelle: n.label, description: "" },
    ...(n.tabs ?? []).map((t) => ({ nom: t.href, libelle: `${n.label} ${t.label}`, description: "" })),
  ]),
  ...CATALOGUE_EXPORTS.map((f) => ({ nom: f.ecran, libelle: f.libelle, description: f.mots })),
];
const INDEX_ECRANS = indexer(FICHES_ECRANS);
const LIBELLE_ECRAN = new Map(FICHES_ECRANS.map((f) => [f.nom, f.libelle]));

export function ecransPour(intention: string): { ecran: string; lien: string }[] {
  return classer(intention, INDEX_ECRANS, 3).map((c) => ({ ecran: LIBELLE_ECRAN.get(c.nom) ?? c.nom, lien: c.nom }));
}
