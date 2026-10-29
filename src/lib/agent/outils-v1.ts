import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { DIRECTORY_TOOLS } from "@/lib/assistant/directory-tools";
import { REGULATORY_READ_TOOLS } from "@/lib/assistant/regulatory-read";
import { assistantToolsFor, buildProposal, executeReadTool } from "@/lib/assistant";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { persistActionIntents } from "@/lib/assistant/action-intents";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { SLUG_DG } from "@/lib/workflow/parcours";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, type MemoireProposee } from "@/lib/agent/memoire-ui";
import { outilsOperations, REFUS_SECONDE_CARTE, type PropositionCarte } from "@/lib/agent/operations";
import { lecturesDocuments } from "@/lib/agent/operations/documents-lus";
import { lectureFormulaire } from "@/lib/agent/operations/formulaire-pdf";
import { lectureRoutines } from "@/lib/agent/operations/routines";
import { rechercheWeb } from "@/lib/agent/recherche-web";
import { sortiePourModele } from "@/lib/agent/contenu-non-fiable";
import { lecturesQuotidien, lecturesRh } from "@/lib/agent/lectures";
import { censurerTexte, jetonnerSortie, jetonOuMasque, type CoffretDuTour } from "@/lib/agent/filtre-confidentialite";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { formatMontant } from "@/lib/utils";

/**
 * LES OUTILS DE L'ASSISTANT IA — tous EXISTANTS au moteur ou à l'Assistant IA, aucun réécrit (Q7, Q20).
 *
 * LES DROITS SONT CEUX DE LA PERSONNE, RIEN DE PLUS, RIEN DE MOINS (décision 0012, Direction 28/10/2026 :
 * en Super Admin, « le salaire d'Assia », « son contrat », « crée un dossier pour daclatasvir » étaient
 * refusés faute d'outil). Lecture : annuaire, Regulatory, tâches, produits, demandes (`executeReadTool`),
 * lectures ouvertes par droit (situation RH, recherche fédérée, agenda, Drive — `executePowerTool` rejuge),
 * fiche / paie / documents RH (`lectures.ts` — `lecturesRh`). Écriture : les gestes métier préparés par `buildProposal`
 * (outils et ops de domaine : la règle de l'écran) et enregistrés comme intentions : RIEN ne s'écrit avant
 * la confirmation, qui passe par `confirmerIntentionAssistantIA` → `performAction` (droit revérifié, audit).
 *
 * Tout ce qui revient au modèle passe le filtre : une rémunération, une coordonnée bancaire, un n° de pièce
 * d'identité y deviennent des REPÈRES (`filtre-confidentialite.ts` — repères) que le serveur ne remplace, à l'affichage, que pour qui
 * a le droit de les voir (`fil/tour.ts` — `Revelateur`). Le modèle n'en reçoit jamais la valeur.
 */
const LECTURES_POWER = new Set(["directory_lookup", "directory_list", "regulatory_portfolio", "regulatory_workload", "regulatory_knowledge"]);
const LECTURES_MOTEUR = new Set(["list_my_tasks", "search_products", "read_workflow", "list_my_requests", "my_overview"]);
/**
 * LES LECTURES DU MOTEUR OUVERTES PAR DROIT (décision 0012) — des outils de pouvoir d'Adam, chacun avec
 * SON droit (`allowed`, la permission qui ouvre l'écran), revérifié à l'exécution par `executePowerTool`.
 * `read_employee` et `read_payroll` n'en sont PAS : leur garde (lecture du module RH, sans société) est
 * plus large que l'écran ; l'Assistant IA lit la fiche et la paie par `lectures.ts` — `lecturesRh`.
 */
const LECTURES_DROIT = new Set(["read_hr_overview", "search_everything", "read_calendar", "search_drive"]);
/**
 * LES ÉCRITURES MÉTIER (décision 0012) — préparées par `buildProposal` (qui juge le droit et résout les
 * noms), enregistrées en intention, exécutées seulement à la confirmation (`performAction` rejuge tout).
 * Pas `create_dossier` (un PROJET, que le modèle confondait avec un dossier réglementaire), pas
 * `create_calendar_event` (l'Assistant IA a `preparer_rendez_vous`), ni les outils d'administration.
 */
const ECRITURES = new Set([
  "create_task", "update_task", "send_message", "create_hr_request", "create_admin_request",
  "update_regulatory_product", "assign_regulatory_responsible", "set_regulatory_step", "request_regulatory_status_update",
]);
/**
 * LES OUTILS DE DOMAINE (une op = un geste d'écran), offerts si la personne passe la porte d'AU MOINS
 * une de leurs ops (`meta.gate`, la règle de l'écran) ; chaque op la rejuge à la proposition. Les
 * créations Ad & Pro restent aux opérations de l'Assistant IA (`operations/`), le rattrapage générique
 * (`capability_operation`) reste à Adam.
 */
const DOMAINES = ["regulatory_operation", "hr_operation", "task_operation", "drive_operation", "request_operation"] as const;
/** TOUT ce qui prépare une écriture du moteur — une routine (lecture seule) n'en reçoit aucun (`routines/passage.ts`). */
export const ECRITURES_DU_MOTEUR: ReadonlySet<string> = new Set([...ECRITURES, ...DOMAINES]);
/** Ce que l'utilisateur lit sous la réponse (« sources consultées ») — jamais un nom d'outil. */
const LIBELLES: Record<string, string> = {
  list_my_tasks: "Tâches consultées",
  read_workflow: "Circuit consulté",
  search_products: "Catalogue consulté",
  list_my_requests: "Demandes consultées",
  read_hr_overview: "Situation RH consultée",
  search_everything: "Recherche effectuée",
  read_calendar: "Agenda consulté",
  search_drive: "Drive fouillé",
  my_overview: "Vue d'ensemble consultée",
  create_task: "Tâche préparée",
  update_task: "Tâche préparée",
  send_message: "Message préparé",
  create_hr_request: "Demande RH préparée",
  create_admin_request: "Demande préparée",
  update_regulatory_product: "Dossier réglementaire préparé",
  assign_regulatory_responsible: "Dossier réglementaire préparé",
  set_regulatory_step: "Dossier réglementaire préparé",
  request_regulatory_status_update: "Relance réglementaire préparée",
  regulatory_operation: "Dossier réglementaire préparé",
  hr_operation: "Geste RH préparé",
  task_operation: "Tâche préparée",
  drive_operation: "Geste Drive préparé",
  request_operation: "Demande préparée",
};
/** Le dossier RÉGLEMENTAIRE se crée ici — le modèle disait « je n'ai pas d'outil pour créer un dossier réglementaire ». */
const PREAMBULE_DOMAINE: Partial<Record<(typeof DOMAINES)[number], string>> = {
  regulatory_operation: "DOSSIERS RÉGLEMENTAIRES (module Regulatory). « Crée un (nouveau) dossier pour <DCI> », « ouvre un dossier réglementaire » = op create_product "
    + "(DCI obligatoire ; entité obligatoire — demande-la si elle manque, ex. Adventum ou Pharmagène). ",
};

/**
 * LA SORTIE D'UN OUTIL, AVANT LE MODÈLE : jetonnée (confidentialité), CONSIGNÉE (le garde-fou de l'UI
 * générative n'accepte un chiffre d'un composant que s'il figure dans ces sorties), puis ENCADRÉE si elle porte un
 * contenu écrit par un tiers (`contenu-non-fiable.ts` — un document ne donne pas d'ordres). Le journal
 * du tour garde la sortie censurée SANS cadre : c'est elle que l'UI générative confronte aux faits.
 */
const filtre = (outil: PowerTool, journal?: string[], coffret?: CoffretDuTour | null): PowerTool => ({
  ...outil,
  run: async (entree, user) => {
    // Avec un coffret (la conversation) : les valeurs sensibles deviennent des REPÈRES (décision 0012) ;
    // sans (une routine) : censurées comme avant.
    const sortie = jetonnerSortie(await outil.run(entree, user), coffret);
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
      if (censurerTexte(contenu).censure || /⟦S\d+⟧/.test(contenu)) return JSON.stringify({ statut: "REFUS", raison: "Donnée sensible : elle ne se retient pas." });
      memoires?.push({ contenu, sorte: estSorteMemoire(entree.sorte) ? entree.sorte : "USER_PREFERENCE" });
      return JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", consigne: "Une carte « Retenir » est affichée : rien n'est retenu avant le geste de l'utilisateur." });
    },
  };
}

/**
 * LA MASSE SALARIALE de la situation RH : un REPÈRE pour qui gère les RH, rien pour qui n'a que la lecture
 * du module — l'écran ne la lui montre pas non plus (`voitLesSalaires`, §118.184).
 */
export function situationRhSansMasse(sortie: string, user: CurrentUser, coffret?: CoffretDuTour | null): string {
  let o: unknown;
  try { o = JSON.parse(sortie); } catch { return sortie; }
  const voit = voitLesSalaires(user);
  const visiter = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visiter);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!/masse/i.test(k)) { out[k] = visiter(x); continue; }
      if (!voit) continue;
      out[k] = typeof x === "number" ? jetonOuMasque(coffret, { valeur: `${formatMontant(x)} DZD`, nature: "SALAIRE", titulaireUserId: null }) : visiter(x);
    }
    return out;
  };
  return JSON.stringify(visiter(o));
}

export function outilsV1(user: CurrentUser, propositions: PropositionPreparee[], journal?: string[], memoires?: MemoireProposee[], coffret?: CoffretDuTour | null): PowerTool[] {
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

  // LES LECTURES PAR DROIT : offertes si `assistantToolsFor` les donne (le droit de l'outil), rejugées à l'exécution.
  const lecturesDroit: PowerTool[] = [...LECTURES_DROIT].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    return [{
      def,
      allowed: (u) => u.id === user.id,
      label: LIBELLES[nom] ?? def.name,
      run: async (entree, u) => {
        const sortie = (await executePowerTool(nom, entree, u)) ?? "Cette lecture n'est pas disponible.";
        return nom === "read_hr_overview" ? situationRhSansMasse(sortie, u, coffret) : sortie;
      },
    }];
  });

  // LES OUTILS DE DOMAINE : offerts à qui passe la porte d'au moins une op ; `buildProposal` rejuge l'op.
  const domaines: PowerTool[] = DOMAINES.flatMap((nom) => {
    const spec = DOMAIN_TOOLS[nom];
    if (!spec || !Object.values(spec.ops).some((o) => o.meta.gate(user))) return [];
    const preambule = PREAMBULE_DOMAINE[nom];
    return [{ ...spec.def, ...(preambule ? { description: preambule + spec.def.description } : {}) }];
  }).map((def) => carte(def.name, def));

  function carte(nom: string, def: PowerTool["def"]): PowerTool {
    return {
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
    };
  }

  const ecritures: PowerTool[] = [...ECRITURES].flatMap((nom) => {
    const def = defParNom.get(nom);
    return def ? [carte(nom, def)] : [];
  });

  return [
    ...lecturesPower, ...lecturesMoteur, ...lecturesDroit, ...lecturesRh(user, coffret), ...lecturesQuotidien(user, propositions), ...lecturesDocuments(user),
    lectureFormulaire(user), lectureRoutines(user), ...rechercheWeb(), ...ecritures, ...domaines, ...outilsOperations(user, propositions), outilMemoire(user, memoires),
  ].map((o) => filtre(o, journal, coffret));
}
