import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { DIRECTORY_TOOLS } from "@/lib/assistant/directory-tools";
import { REGULATORY_READ_TOOLS } from "@/lib/assistant/regulatory-read";
import { assistantToolsFor, buildProposal, executeReadTool } from "@/lib/assistant";
import { persistActionIntents } from "@/lib/assistant/action-intents";
import { censurerObjet, censurerTexte } from "@/lib/agent/filtre-confidentialite";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { SLUG_DG } from "@/lib/workflow/parcours";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, type MemoireProposee } from "@/lib/agent/memoire-ui";
import { outilsOperations, REFUS_SECONDE_CARTE, type PropositionCarte } from "@/lib/agent/operations";
import { lecturesQuotidien } from "@/lib/agent/lectures";
import { lecturesDocuments } from "@/lib/agent/operations/documents-lus";
import { lectureFormulaire } from "@/lib/agent/operations/formulaire-pdf";
import { lectureRoutines } from "@/lib/agent/operations/routines";
import { rechercheWeb } from "@/lib/agent/recherche-web";
import { sortiePourModele } from "@/lib/agent/contenu-non-fiable";

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
const LECTURES_MOTEUR = new Set(["list_my_tasks", "search_products", "read_workflow"]);
const ECRITURES = new Set(["create_task", "send_message"]);
/** Ce que l'utilisateur lit sous la réponse (« sources consultées ») — jamais un nom d'outil. */
const LIBELLES: Record<string, string> = {
  list_my_tasks: "Tâches consultées",
  read_workflow: "Circuit consulté",
  search_products: "Catalogue consulté",
  create_task: "Tâche préparée",
  send_message: "Message préparé",
};

/** Le résultat d'un outil, censuré avant de partir au modèle. JSON gardé JSON quand il l'était. */
export function censurerSortie(sortie: string): string {
  try {
    const { resultat } = censurerObjet(JSON.parse(sortie));
    return JSON.stringify(resultat);
  } catch {
    return censurerTexte(sortie).texte;
  }
}

/**
 * Censure, et CONSIGNE ce que le modèle a lu : le garde-fou de l'UI générative (`ui/composants.ts`)
 * n'accepte un chiffre ou une ligne d'un composant que s'il figure dans ces sorties.
 */
/**
 * LA SORTIE D'UN OUTIL, AVANT LE MODÈLE : censurée (confidentialité), puis ENCADRÉE si elle porte un
 * contenu écrit par un tiers (`contenu-non-fiable.ts` — un document ne donne pas d'ordres). Le journal
 * du tour garde la sortie censurée SANS cadre : c'est elle que l'UI générative confronte aux faits.
 */
const filtre = (outil: PowerTool, journal?: string[]): PowerTool => ({
  ...outil,
  run: async (entree, user) => {
    const sortie = censurerSortie(await outil.run(entree, user));
    journal?.push(sortie);
    return sortiePourModele(outil.def.name, sortie);
  },
});

/**
 * LE CIRCUIT, LISIBLE. `read_workflow` (la même lecture qu'Adam, les mêmes droits) rend un circuit
 * PERSONNALISÉ étape par étape — mais, quand rien n'est personnalisé, seulement la phrase « circuit
 * par défaut ». Mesuré : sans étapes, le modèle a INVENTÉ un circuit (« analyse réglementaire,
 * validation budgétaire, comité… »). On complète donc par la définition par défaut CANONIQUE
 * (`defaultDefinition`, celle que le moteur sème), et on ne garde que ce qu'une explication lit :
 * l'ordre, le titre, qui agit, ce que l'étape fait.
 *
 * L'ÉTAPE DU DG N'EST PAS RÉCITÉE COMME UNE ÉTAPE (27/10/2026). Elle reste dans la définition pour les
 * demandes nées avant la règle, mais aucune demande nouvelle ne la traverse : le DG valide le TOTAL des
 * postes, à la fin, au-dessus du seuil (`ad-pro/porte-dg.ts`). Mesuré en production : la lire telle
 * quelle faisait annoncer « 2. Validation du Directeur Général » — un circuit que plus personne ne suit.
 * On la retire de la colonne et on dit, à la place, ce qui vient APRÈS la prévalidation.
 */
export const APRES_LA_PREVALIDATION =
  "Après la prévalidation de la Direction Marketing : les postes (devis, bons de commande, factures) sont ajoutés par les "
  + "parties prenantes et acceptés par la Direction Marketing ; le Directeur Général valide le TOTAL de la demande, à la fin, "
  + "seulement s'il dépasse le seuil réglé en Administration › Réglages (aucun bon de commande ni paiement avant) ; "
  + "puis la Direction Marketing range chaque poste dans un budget et clôture la demande.";

export function circuitLisible(sortie: string): string {
  let o: Record<string, unknown>;
  try { o = JSON.parse(sortie) as Record<string, unknown>; } catch { return sortie; }
  const cat = String(o.categorie ?? "") as WorkflowCategory;
  const etapes = Array.isArray(o.etapes)
    ? (o.etapes as Record<string, unknown>[]).filter((e) => e.slug !== SLUG_DG).map((e) => ({
      titre: e.title, qui: e.actorRoles, facultative: e.optional === true || undefined,
      franchieSousSeuilDZD: e.autoSkipMaxAmount ?? undefined,
    }))
    : (WORKFLOW_CATEGORIES as readonly string[]).includes(cat)
      ? defaultDefinition(cat).steps.filter((e) => e.slug !== SLUG_DG).map((e) => ({
        titre: e.title,
        qui: e.actorRoles.map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r),
        role: e.description ?? undefined,
        facultative: e.optional === true || undefined,
      }))
      : [];
  return JSON.stringify({
    circuit: o.libelle ?? o.categorie,
    personnalise: Array.isArray(o.etapes),
    actif: o.actif,
    etapes,
    ensuite: APRES_LA_PREVALIDATION,
    // Les branches de `parcoursAdPro` (workflow/parcours.ts), dites en clair.
    note: "Chaque demande suit cette colonne selon le rang du demandeur : un délégué médical (KAM) passe par son National Sales, puis le "
      + "Directeur des opérations, puis la Direction Marketing ; tout autre demandeur commence au Directeur des opérations ; la Direction, "
      + "le DG et le Directeur des opérations vont directement à la Direction Marketing, dont la propre demande est prévalidée d'office. "
      + "Le Directeur Général n'est PAS une étape de cette colonne.",
  });
}

export type { MemoireProposee } from "@/lib/agent/memoire-ui";

/** Une carte de confirmation préparée pendant le tour (écriture V1 ou opération de l'Assistant IA). */
export type PropositionPreparee = PropositionCarte;

/**
 * Les outils de CET utilisateur, pour CE tour. `propositions` recueille les intentions créées
 * pendant le tour : la réponse les rend à l'interface pour afficher la carte de confirmation.
 */
/**
 * RETENIR — l'outil ne retient RIEN : il PROPOSE. La personne confirme d'un geste (carte « Retenir »),
 * et c'est son action serveur qui écrit, dans SA mémoire (`assistant-ia-actions.ts`).
 */
function outilMemoire(user: CurrentUser, memoires?: MemoireProposee[]): PowerTool {
  return {
    def: {
      name: "proposer_memoire",
      description:
        "PROPOSE de retenir durablement un fait sur l'utilisateur lui-même (sa société, ses produits, son service, une préférence, une habitude, un raccourci). "
        + "À appeler seulement quand il le demande (« retiens que… ») ou quand c'est manifestement durable. Rien n'est retenu avant SA confirmation : "
        + "ne dis jamais « c'est retenu ». Jamais de rémunération, de coordonnée bancaire ni de numéro de pièce d'identité.",
      input_schema: {
        type: "object",
        properties: {
          contenu: { type: "string", description: "Le fait, en une phrase à la première personne de l'utilisateur (« Ma société est Pharmagène »)." },
          sorte: { type: "string", enum: [...SORTES_MEMOIRE] },
        },
        required: ["contenu"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Mémoire proposée",
    run: async (entree) => {
      const contenu = typeof entree.contenu === "string" ? entree.contenu.replace(/\s+/g, " ").trim().slice(0, MEMOIRE_MAX_CARACTERES) : "";
      if (!contenu) return JSON.stringify({ statut: "REFUS", raison: "Rien à retenir." });
      if (censurerTexte(contenu).censure) return JSON.stringify({ statut: "REFUS", raison: "Donnée sensible : elle ne se retient pas." });
      memoires?.push({ contenu, sorte: estSorteMemoire(entree.sorte) ? entree.sorte : "USER_PREFERENCE" });
      return JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", consigne: "Une carte « Retenir » est affichée : rien n'est retenu avant le geste de l'utilisateur." });
    },
  };
}

export function outilsV1(user: CurrentUser, propositions: PropositionPreparee[], journal?: string[], memoires?: MemoireProposee[]): PowerTool[] {
  // `assistantToolsFor` applique déjà les conditions d'accès de l'assistant de production.
  const defs = assistantToolsFor(user);
  const defParNom = new Map(defs.map((d) => [d.name, d]));

  const lecturesPower = [...DIRECTORY_TOOLS, ...REGULATORY_READ_TOOLS].filter((o) => LECTURES_POWER.has(o.def.name));

  const lecturesMoteur: PowerTool[] = [...LECTURES_MOTEUR].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    if (nom === "read_workflow") {
      return [{
        def: { ...def, description: "Lit le CIRCUIT DE VALIDATION d'une catégorie Ad & Pro (SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS) : étapes dans l'ordre et qui agit. À appeler AVANT d'expliquer un circuit — n'en décris jamais un de mémoire." },
        allowed: (u) => u.id === user.id,
        label: LIBELLES[nom] ?? def.name,
        run: async (entree, u) => circuitLisible(await executeReadTool(nom, entree, u)),
      }];
    }
    return [{ def, allowed: (u) => u.id === user.id, label: LIBELLES[nom] ?? def.name, run: (entree, u) => executeReadTool(nom, entree, u) }];
  });

  const ecritures: PowerTool[] = [...ECRITURES].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    return [{
      def,
      allowed: (u) => u.id === user.id,
      label: LIBELLES[nom] ?? def.name,
      run: async (entree, u) => {
        if (propositions.length > 0) return REFUS_SECONDE_CARTE;
        const p = await buildProposal(nom, entree, u);
        if ("error" in p) return JSON.stringify({ statut: "REFUS", raison: p.error });
        const [intentId] = await persistActionIntents(u.id, [p], "text");
        if (!intentId) return JSON.stringify({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
        propositions.push({ intentId, proposition: p });
        return JSON.stringify({
          statut: "EN_ATTENTE_DE_CONFIRMATION",
          titre: p.title,
          champs: p.fields,
          consigne: "Rien n'est exécuté : une carte de confirmation est affichée. Ne dis pas que c'est fait.",
        });
      },
    }];
  });

  return [...lecturesPower, ...lecturesMoteur, ...lecturesQuotidien(user, propositions), ...lecturesDocuments(user), lectureFormulaire(user), lectureRoutines(user), ...rechercheWeb(), ...ecritures, ...outilsOperations(user, propositions), outilMemoire(user, memoires)]
    .map((o) => filtre(o, journal));
}
