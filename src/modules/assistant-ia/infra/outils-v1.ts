import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { DIRECTORY_TOOLS } from "@/platform/ia/lectures/directory-tools";
import { REGULATORY_READ_TOOLS } from "@/platform/ia/lectures/regulatory-read";
import { assistantToolsFor, buildProposal, executeReadTool } from "@/lib/assistant";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { SLUG_DG } from "@/lib/workflow/parcours";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, type MemoireProposee } from "../domaine/memoire-ui";
import { OPERATIONS_IA, outilsOperations, REFUS_SECONDE_CARTE, type PropositionCarte } from "./operations";
import { lecturesDocuments } from "./operations/documents-lus";
import { OUTILS_ATELIER, outilsAtelier } from "./atelier/outils";
import { OUTILS_NOTES_ECRITURE, outilsNotes } from "./notes/outils";
import { lectureFormulaire } from "./operations/formulaire-pdf";
import { lectureRoutines } from "./operations/routines";
import { rechercheWeb } from "./recherche-web";
import { outilsConnaissance } from "@/platform/ia/lectures/connaissance";
import { outilsGraphe } from "@/platform/ia/lectures/graphe";
import { sortiePourModele } from "../domaine/contenu-non-fiable";
import { avecProvenance, type ProvenanceDuTour } from "./provenance";
import { lecturesMetier, lecturesQuotidien, lecturesRh } from "./lectures";
import { censurerTexte, jetonnerSortie, jetonOuMasque, type CoffretDuTour } from "../domaine/filtre-confidentialite";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { formatMontant } from "@/lib/utils";
import { FAMILLES_IA, familleExplicite, familleOuverte, refusFamille, resoudreAccesIa, type AccesIa, type FamilleIa } from "../domaine/acces-regles";
import { ajouterReperesAIntention, droitsApplicatifsIa, substituerReperes, tracerSubstitutions, vueDeLAssistant } from "./role-config";

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
const LECTURES_DROIT = new Set(["read_hr_overview", "search_everything", "read_calendar", "search_drive", "read_budget", "finance_totals", "list_pending_decisions"]);
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
/**
 * LES FAMILLES RÉGLÉES PAR LA DIRECTION (décision 0012, console `/admin/ai/acces`) — chaque outil, la ou les
 * familles qu'il exige. Fermée : l'outil reste offert, mais refuse en disant quelle famille et qui l'ouvre.
 * Les lectures RH (`lire_paie`, `documents_rh`, `lire_fiche_rh`) jugent elles-mêmes (la personne garde l'accès
 * à SON dossier) ; toute opération de l'Assistant IA hors routines exige les écritures.
 */
const FAMILLES_DES_OUTILS: Record<string, FamilleIa[]> = {
  read_hr_overview: ["FICHES"],
  search_drive: ["DRIVE"], search_everything: ["DRIVE"], drive_operation: ["DRIVE", "ECRITURES"],
  // J4 : la Bibliothèque — « Drive & documents » ; ses propres droits (l'écran qui sert chaque pièce) jugent en plus.
  chercher_documents: ["DRIVE"], ouvrir_documents: ["DRIVE"],
  read_budget: ["BUDGETS"], finance_totals: ["BUDGETS"],
  demandes_adpro: ["AD_PRO"], etat_dossier_reglementaire: ["REGLEMENTAIRE"],
  regulatory_portfolio: ["REGLEMENTAIRE"], regulatory_workload: ["REGLEMENTAIRE"], regulatory_knowledge: ["REGLEMENTAIRE"],
  regulatory_operation: ["REGLEMENTAIRE", "ECRITURES"], update_regulatory_product: ["REGLEMENTAIRE", "ECRITURES"],
  assign_regulatory_responsible: ["REGLEMENTAIRE", "ECRITURES"], set_regulatory_step: ["REGLEMENTAIRE", "ECRITURES"],
  request_regulatory_status_update: ["REGLEMENTAIRE", "ECRITURES"],
  read_workflow: ["AD_PRO"],
  preparer_sponsoring: ["AD_PRO", "ECRITURES"], preparer_prise_en_charge: ["AD_PRO", "ECRITURES"], preparer_evenement: ["AD_PRO", "ECRITURES"],
  preparer_materiel_promo: ["AD_PRO", "ECRITURES"], preparer_demande_autre: ["AD_PRO", "ECRITURES"], preparer_poste: ["AD_PRO", "ECRITURES"],
  preparer_bon_de_commande: ["AD_PRO", "ECRITURES"], preparer_bc_depuis_devis: ["AD_PRO", "ECRITURES"], preparer_voyageur_passeport: ["AD_PRO", "ECRITURES"],
  hr_operation: ["FICHES", "ECRITURES"],
  // J3 — l'Atelier : ouvrir, modifier en place (rien n'est enregistré sans la personne), convertir.
  ouvrir_dans_l_atelier: ["DRIVE"], modifier_document: ["DRIVE"], convertir_document: ["DRIVE"], enregistrer_document: ["DRIVE", "ECRITURES"],
};
// « Mes notes » (décision 0026) : le bloc-notes de la personne, chaque geste proposé puis accepté par elle — comme la mémoire.
const SANS_FAMILLE_ECRITURE = new Set(["programmer_routine", "gerer_routine", "proposer_memoire", ...OUTILS_NOTES_ECRITURE]);

/** Les familles qu'un GESTE exige (J2 : un travail rejuge chaque geste contre la console avant d'agir). */
export const famillesDuGeste = (nom: string): FamilleIa[] => famillesDe(nom, !SANS_FAMILLE_ECRITURE.has(nom));
/** Les familles qu'une LECTURE exige (J2 : le plan d'un travail n'offre que les lectures ouvertes à la personne). */
export const famillesDeLaLecture = (nom: string): FamilleIa[] => famillesDe(nom, false);

/** L'accès par défaut (sans réglage lu) : droits applicatifs, familles sensibles fermées. Un tour passe toujours le réglage relu. */
export const accesParDefaut = (user: CurrentUser): AccesIa =>
  resoudreAccesIa({ superAdmin: user.role === "SUPER_ADMIN", droits: droitsApplicatifsIa(user) });

/** Les familles qu'un outil exige — celles de la table, et les écritures pour tout geste préparé. */
function famillesDe(nom: string, ecriture: boolean): FamilleIa[] {
  const f = FAMILLES_DES_OUTILS[nom] ?? [];
  return ecriture && !f.includes("ECRITURES") ? [...f, "ECRITURES"] : f;
}

const garde = (outil: PowerTool, familles: FamilleIa[], acces: AccesIa): PowerTool => (familles.length === 0 ? outil : {
  ...outil,
  run: async (entree, u) => {
    const fermee = familles.find((f) => !familleOuverte(acces, f));
    return fermee ? JSON.stringify({ statut: "REFUS", raison: refusFamille(fermee) }) : outil.run(entree, u);
  },
});

/** TOUT ce qui prépare une écriture du moteur — une routine (lecture seule) n'en reçoit aucun (`routines/passage.ts`). */
// L'Atelier (J3) n'a rien à faire dans une routine ou un travail : il ouvre des onglets sous les yeux de la personne.
// Les notes (décision 0026) non plus : une proposition attend le geste de la personne, qui n'est pas là.
export const ECRITURES_DU_MOTEUR: ReadonlySet<string> = new Set([...ECRITURES, ...DOMAINES, ...OUTILS_ATELIER, ...OUTILS_NOTES_ECRITURE]);
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
  read_budget: "Budget consulté",
  finance_totals: "Finances consultées",
  list_pending_decisions: "Validations en attente consultées",
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
const filtre = (outil: PowerTool, journal?: string[], coffret?: CoffretDuTour | null, provenance?: ProvenanceDuTour): PowerTool => ({
  ...outil,
  run: async (entree, user) => {
    // Avec un coffret (la conversation) : les valeurs sensibles deviennent des REPÈRES (décision 0012) ;
    // sans (une routine) : censurées comme avant.
    const avant = coffret?.taille ?? 0;
    const sortie = jetonnerSortie(await outil.run(entree, user), coffret);
    coffret?.nommer(avant, outil.def.name);
    journal?.push(sortie);
    const pourModele = sortiePourModele(outil.def.name, sortie);
    // J14 : ce que le tour a lu d'un tiers (encadré) ou de l'ERP — la carte dira ce qui vient d'un tiers.
    provenance?.noter(pourModele);
    return pourModele;
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

export type { MemoireProposee } from "../domaine/memoire-ui";

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
export function situationRhSansMasse(sortie: string, user: CurrentUser, coffret: CoffretDuTour | null | undefined, acces: AccesIa): string {
  let o: unknown;
  try { o = JSON.parse(sortie); } catch { return sortie; }
  const voit = familleOuverte(acces, "SALAIRES") && (voitLesSalaires(user) || familleExplicite(acces, "SALAIRES"));
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

export function outilsV1(
  user: CurrentUser, propositions: PropositionPreparee[], journal?: string[], memoires?: MemoireProposee[], coffret?: CoffretDuTour | null, accesDuTour?: AccesIa,
  provenance?: ProvenanceDuTour,
  notesProposees?: string[],
): PowerTool[] {
  const acces = accesDuTour ?? accesParDefaut(user);
  // `assistantToolsFor` applique déjà les conditions d'accès de l'assistant de production.
  // LA VUE : la personne, plus en lecture les modules des familles que la Direction lui a ouvertes explicitement.
  const vue = vueDeLAssistant(user, acces);
  const sousVue = (o: PowerTool): PowerTool => ({ ...o, allowed: (u) => u.id === user.id && o.allowed(vue), run: (entree, u) => o.run(entree, u.id === user.id ? vue : u) });
  const defs = assistantToolsFor(vue);
  const defParNom = new Map(defs.map((d) => [d.name, d]));

  const lecturesPower = [...DIRECTORY_TOOLS, ...REGULATORY_READ_TOOLS].filter((o) => LECTURES_POWER.has(o.def.name)).map(sousVue);

  const lecturesMoteur: PowerTool[] = [...LECTURES_MOTEUR].flatMap((nom) => {
    const def = defParNom.get(nom);
    if (!def) return [];
    if (nom === "read_workflow") {
      return [{
        def: { ...def, description: "Lit le CIRCUIT DE VALIDATION d'une catégorie Ad & Pro (SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS) : étapes dans l'ordre et qui agit. À appeler AVANT d'expliquer un circuit — n'en décris jamais un de mémoire." },
        allowed: (u) => u.id === user.id,
        label: LIBELLES[nom] ?? def.name,
        run: async (entree, u) => circuitLisible(await executeReadTool(nom, entree, u.id === user.id ? vue : u)),
      }];
    }
    return [{ def, allowed: (u) => u.id === user.id, label: LIBELLES[nom] ?? def.name, run: (entree, u) => executeReadTool(nom, entree, u.id === user.id ? vue : u) }];
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
        const sortie = (await executePowerTool(nom, entree, u.id === user.id ? vue : u)) ?? "Cette lecture n'est pas disponible.";
        return nom === "read_hr_overview" ? situationRhSansMasse(sortie, u, coffret, acces) : sortie;
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
    if (!def) return [];
    // `search_people` n'est pas au catalogue de l'Assistant IA (banc V4-H) : la résolution se fait par l'annuaire.
    return [carte(nom, { ...def, description: def.description.replace(/search_people/g, "directory_lookup") })];
  });

  const lectures = [
    ...lecturesPower, ...lecturesMoteur, ...lecturesDroit, ...lecturesRh(user, coffret, acces), ...lecturesMetier(user, vue), ...lecturesQuotidien(user, propositions), ...lecturesDocuments(user),
    lectureFormulaire(user), lectureRoutines(user), ...rechercheWeb(), ...outilsConnaissance(user), ...outilsAtelier(user),
    // J9 — le graphe : une famille FERMÉE retire ses types du parcours (dossiers, demandes, documents), sans fermer l'outil.
    ...outilsGraphe(user, FAMILLES_IA.filter((f) => !familleOuverte(acces, f))),
  ].map((o) => garde(o, famillesDe(o.def.name, false), acces));
  /**
   * UN REPÈRE DANS L'ENTRÉE D'UN GESTE (décision 0012) : remplacé par la vraie valeur AVANT la carte, si la personne a
   * le droit de la voir (sinon refus) ; la carte garde la liste des valeurs substituées, rejugées à l'exécution ; la
   * substitution est tracée ; la sortie rendue au modèle remet chaque valeur en repère.
   */
  const avecReperes = (o: PowerTool): PowerTool => ({
    ...o,
    run: async (entree, u) => {
      const s = await substituerReperes(entree ?? {}, coffret, u, acces, o.def.name);
      if ("refus" in s) return JSON.stringify({ statut: "REFUS", raison: s.refus });
      const avant = propositions.length;
      let sortie = await o.run(s.entree, u);
      if (!s.substitues.length) return sortie;
      const p = propositions.length > avant ? propositions[propositions.length - 1] : null;
      if (p) {
        await ajouterReperesAIntention(p.intentId, s.substitues.map((x) => x.e));
        await tracerSubstitutions(u, s.substitues, { titre: p.proposition.title, champs: p.proposition.fields }, "carte");
      }
      for (const { n, e } of s.substitues) sortie = sortie.split(e.valeur).join(`⟦S${n}⟧`);
      return sortie;
    },
  });
  const gestes = [
    ...[...ecritures, ...domaines].map((o) => garde(avecProvenance(avecReperes(o), propositions, provenance), famillesDe(o.def.name, true), acces)),
    ...outilsOperations(user, propositions).map((o) => garde(avecProvenance(avecReperes(o), propositions, provenance), famillesDe(o.def.name, !SANS_FAMILLE_ECRITURE.has(o.def.name)), acces)),
  ];
  // Chaque outil porte les accès de CETTE personne : appelé sous une autre (jamais en production — `allowed` le
  // refuse déjà au modèle), il refuse au lieu de prêter ces accès.
  const aSoi = (o: PowerTool): PowerTool => ({
    ...o,
    run: (entree, u) => (u.id === user.id ? o.run(entree, u) : Promise.resolve(JSON.stringify({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." }))),
  });
  // « Mes notes » (décision 0026) : lire SES notes, et PROPOSER des modifications qu'elle accepte ou refuse.
  const notes = outilsNotes(user, { coffret, acces, proposees: notesProposees });
  return [...lectures, ...gestes, outilMemoire(user, memoires), ...notes].map((o) => filtre(aSoi(o), journal, coffret, provenance));
}

/**
 * LES GESTES QUE L'APPLICATION NE LUI OUVRE PAS (banc V4-H : « je ne peux pas… avec les outils disponibles ») — une
 * opération de l'Assistant IA dont la personne n'a pas le droit d'écran n'est pas offerte ; le contexte le dit, pour que
 * le refus nomme le DROIT et non « les outils ».
 */
export function consigneGestesFermes(user: CurrentUser): string | null {
  const fermes = OPERATIONS_IA.filter((o) => !o.ouverte(user)).map((o) => `« ${o.libelle.replace(/ préparée?$/, "")} »`);
  if (!fermes.length) return null;
  return `GESTES NON OUVERTS À SON RÔLE dans l'application (droit de l'écran, réglé en Administration › Accès) : ${fermes.join(", ")}. `
    + "Une demande de ce genre : dis que son rôle n'a pas ce droit dans l'application — jamais « je n'ai pas l'outil ».";
}
