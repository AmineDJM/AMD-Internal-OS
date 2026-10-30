import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { DIRECTORY_TOOLS } from "@/platform/ia/lectures/directory-tools";
import { REGULATORY_READ_TOOLS } from "@/platform/ia/lectures/regulatory-read";
import { readWorkflowState, resolveWorkflowCategory } from "@/platform/ia/lectures/workflow-admin";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { SLUG_DG } from "@/lib/workflow/parcours";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, SORTES_MEMOIRE, type MemoireProposee } from "../domaine/memoire-ui";
import { OPERATIONS_IA, outilsOperations, type PropositionCarte } from "./operations";
import { lecturesDocuments } from "./operations/documents-lus";
import { lectureBudget } from "./operations/budget";
import { OUTILS_ATELIER, outilsAtelier } from "./atelier/outils";
import { lectureFormulaire } from "./operations/formulaire-pdf";
import { lectureRoutines } from "./operations/routines";
import { rechercheWeb } from "./recherche-web";
import { outilsConnaissance } from "@/platform/ia/lectures/connaissance";
import { sortiePourModele } from "../domaine/contenu-non-fiable";
import { lecturesMetier, lecturesQuotidien, lecturesRh, lecturesSituation, situationRhSansMasse } from "./lectures";
import { lecturesErp } from "./lectures-erp";
import { outilsCapacites } from "./capacites";
import { censurerTexte, jetonnerSortie, type CoffretDuTour } from "../domaine/filtre-confidentialite";
import { familleOuverte, refusFamille, resoudreAccesIa, type AccesIa, type FamilleIa } from "../domaine/acces-regles";
import { ajouterReperesAIntention, droitsApplicatifsIa, substituerReperes, tracerSubstitutions, vueDeLAssistant } from "./role-config";

/**
 * LES OUTILS DE L'ASSISTANT IA — les siens, et les CAPACITÉS de l'ERP (lot J6, décision 0020).
 *
 * LES DROITS SONT CEUX DE LA PERSONNE, RIEN DE PLUS, RIEN DE MOINS (décision 0012). Lecture : annuaire, Regulatory
 * (socle IA), tâches, demandes, aperçu, recherche fédérée, agenda, file des décisions (`lectures-erp.ts`), budget
 * (`operations/budget.ts`), situation RH et agrégats financiers, fiche / paie / documents RH (`lectures.ts`).
 * Écriture : les opérations de l'Assistant IA (`operations/`) et, depuis J6, toute action serveur de l'ERP par son
 * CONTRAT (`capacites.ts`, registre `platform/ia/capacites/`) — préparée en carte, exécutée à la confirmation par
 * l'action elle-même (`lib/actions/executer.ts`), sous la session de la personne. L'Assistant IA n'emprunte plus rien
 * au catalogue d'Adam : `RESIDUS` de `platform/ia/frontieres.test.ts` est vide.
 *
 * Tout ce qui revient au modèle passe le filtre : une rémunération, une coordonnée bancaire, un n° de pièce
 * d'identité y deviennent des REPÈRES (`filtre-confidentialite.ts` — repères) que le serveur ne remplace, à l'affichage, que pour qui
 * a le droit de les voir (`fil/tour.ts` — `Revelateur`). Le modèle n'en reçoit jamais la valeur.
 */
const LECTURES_POWER = new Set(["directory_lookup", "directory_list", "regulatory_portfolio", "regulatory_workload", "regulatory_knowledge"]);
/**
 * LES FAMILLES RÉGLÉES PAR LA DIRECTION (décision 0012, console `/admin/ai/acces`) — chaque outil, la ou les
 * familles qu'il exige. Fermée : l'outil reste offert, mais refuse en disant quelle famille et qui l'ouvre.
 * Les lectures RH (`lire_paie`, `documents_rh`, `lire_fiche_rh`) jugent elles-mêmes (la personne garde l'accès
 * à SON dossier) ; toute opération de l'Assistant IA hors routines exige les écritures.
 */
const FAMILLES_DES_OUTILS: Record<string, FamilleIa[]> = {
  read_hr_overview: ["FICHES"],
  search_everything: ["DRIVE"],
  // J4 : la Bibliothèque — « Drive & documents » ; ses propres droits (l'écran qui sert chaque pièce) jugent en plus.
  chercher_documents: ["DRIVE"], ouvrir_documents: ["DRIVE"],
  read_budget: ["BUDGETS"], finance_totals: ["BUDGETS"],
  demandes_adpro: ["AD_PRO"], etat_dossier_reglementaire: ["REGLEMENTAIRE"],
  regulatory_portfolio: ["REGLEMENTAIRE"], regulatory_workload: ["REGLEMENTAIRE"], regulatory_knowledge: ["REGLEMENTAIRE"],
  read_workflow: ["AD_PRO"],
  preparer_sponsoring: ["AD_PRO", "ECRITURES"], preparer_prise_en_charge: ["AD_PRO", "ECRITURES"], preparer_evenement: ["AD_PRO", "ECRITURES"],
  preparer_materiel_promo: ["AD_PRO", "ECRITURES"], preparer_demande_autre: ["AD_PRO", "ECRITURES"], preparer_poste: ["AD_PRO", "ECRITURES"],
  preparer_bon_de_commande: ["AD_PRO", "ECRITURES"], preparer_bc_depuis_devis: ["AD_PRO", "ECRITURES"], preparer_voyageur_passeport: ["AD_PRO", "ECRITURES"],
  // J3 — l'Atelier : ouvrir, modifier en place (rien n'est enregistré sans la personne), convertir.
  ouvrir_dans_l_atelier: ["DRIVE"], modifier_document: ["DRIVE"], convertir_document: ["DRIVE"], enregistrer_document: ["DRIVE", "ECRITURES"],
};
const SANS_FAMILLE_ECRITURE = new Set(["programmer_routine", "gerer_routine", "proposer_memoire"]);

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

/** TOUT ce qui prépare une écriture du moteur hors des opérations — une routine (lecture seule) n'en reçoit aucun (`routines/passage.ts`). */
// L'Atelier (J3) n'a rien à faire dans une routine ou un travail : il ouvre des onglets sous les yeux de la personne.
// Les CAPACITÉS (J6) ne sont pas même construites hors de la conversation (`outilsV1(…, { capacites: true })`).
export const ECRITURES_DU_MOTEUR: ReadonlySet<string> = new Set([...OUTILS_ATELIER]);

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
    const avant = coffret?.taille ?? 0;
    const sortie = jetonnerSortie(await outil.run(entree, user), coffret);
    coffret?.nommer(avant, outil.def.name);
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

/** Le circuit d'une catégorie Ad & Pro, lu par la lecture d'administration du socle (`workflow-admin.ts`) et rendu lisible. */
function lectureCircuit(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "read_workflow",
      description: "Lit le CIRCUIT DE VALIDATION d'une catégorie Ad & Pro (SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS) : étapes dans l'ordre et qui agit. À appeler AVANT d'expliquer un circuit — n'en décris jamais un de mémoire.",
      input_schema: { type: "object", properties: { category: { type: "string", description: "La catégorie (SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS)." } }, required: ["category"] },
    },
    allowed: (u) => u.id === user.id,
    label: "Circuit consulté",
    run: async (entree) => {
      const cat = resolveWorkflowCategory(typeof entree.category === "string" ? entree.category : "");
      if (!cat) return `Catégorie inconnue. Circuits configurables : ${WORKFLOW_CATEGORIES.join(", ")}. Les autres circuits de l'ERP sont codés en dur.`;
      const etat = await readWorkflowState(cat);
      return circuitLisible(JSON.stringify({ categorie: etat.category, libelle: etat.categoryLabel, actif: etat.isActive, etapes: etat.steps ?? "Circuit PAR DÉFAUT" }));
    },
  };
}

/** Les options d'un catalogue : la conversation reçoit en plus les CAPACITÉS de l'ERP (J6) — ni les routines ni les travaux. */
export interface OptionsCatalogue {
  capacites?: boolean;
}

export function outilsV1(
  user: CurrentUser, propositions: PropositionPreparee[], journal?: string[], memoires?: MemoireProposee[], coffret?: CoffretDuTour | null, accesDuTour?: AccesIa,
  options: OptionsCatalogue = {},
): PowerTool[] {
  const acces = accesDuTour ?? accesParDefaut(user);
  // LA VUE : la personne, plus en lecture les modules des familles que la Direction lui a ouvertes explicitement.
  const vue = vueDeLAssistant(user, acces);
  const sousVue = (o: PowerTool): PowerTool => ({ ...o, allowed: (u) => u.id === user.id && o.allowed(vue), run: (entree, u) => o.run(entree, u.id === user.id ? vue : u) });
  const lecturesPower = [...DIRECTORY_TOOLS, ...REGULATORY_READ_TOOLS].filter((o) => LECTURES_POWER.has(o.def.name)).map(sousVue);
  // LES LECTURES PROPRES AU MODULE (J6) : sous la vue, comme les lectures du moteur qu'elles remplacent.
  const situation = lecturesSituation(user).map((o) => (o.def.name === "read_hr_overview"
    ? { ...o, run: async (entree: Record<string, unknown>, u: CurrentUser) => situationRhSansMasse(await o.run(entree, u), u, coffret, acces) }
    : o));
  const propres = [...lecturesErp(user), lectureCircuit(user), lectureBudget(user), ...situation].map(sousVue);

  const lectures = [
    ...lecturesPower, ...propres, ...lecturesRh(user, coffret, acces), ...lecturesMetier(user, vue), ...lecturesQuotidien(user, propositions), ...lecturesDocuments(user),
    lectureFormulaire(user), lectureRoutines(user), ...rechercheWeb(), ...outilsConnaissance(user), ...outilsAtelier(user),
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
    // LES CAPACITÉS (J6) : leur famille se juge DANS l'outil (celle de la fiche du registre), leur porte dans `allowed`.
    ...(options.capacites ? outilsCapacites(user, propositions, acces).map(avecReperes) : []),
    ...outilsOperations(user, propositions).map((o) => garde(avecReperes(o), famillesDe(o.def.name, !SANS_FAMILLE_ECRITURE.has(o.def.name)), acces)),
  ];
  // Chaque outil porte les accès de CETTE personne : appelé sous une autre (jamais en production — `allowed` le
  // refuse déjà au modèle), il refuse au lieu de prêter ces accès.
  const aSoi = (o: PowerTool): PowerTool => ({
    ...o,
    run: (entree, u) => (u.id === user.id ? o.run(entree, u) : Promise.resolve(JSON.stringify({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." }))),
  });
  return [...lectures, ...gestes, outilMemoire(user, memoires)].map((o) => filtre(aSoi(o), journal, coffret));
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
