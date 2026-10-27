import type { StepInput, WorkflowCategory } from "./types";
import { CATEGORY_LABELS } from "./types";
import {
  ROLE_DIRECTION_MARKETING,
  SLUG_DG, SLUG_DIRECTION, SLUG_MARKETING, SLUG_PRELIMINAIRE,
} from "./parcours";

/**
 * Définitions **par défaut** du circuit Ad & Pro : préliminaire National Sales → porte du
 * Directeur Général (au-delà du seuil) → validation de la Direction → **décision et budget de
 * Direction Marketing**, qui TRANCHE. Semées à la volée (lazy) si aucune définition n'existe
 * pour la catégorie ; le Super Admin peut ensuite tout modifier depuis Administration.
 *
 * ── CE QUE CETTE GRAINE NE FAIT PAS, ET C'EST ESSENTIEL ─────────────────────────────────
 *
 * Elle ne s'applique QUE là où rien n'existe. Les définitions déjà en base ne sont pas
 * réécrites — c'est ce qui protège les circuits que le Super Admin a remodelés. La bascule de
 * l'existant vers le nouvel ordre est donc une MIGRATION
 * (`20260921120000_adpro_ordre_marketing_final`), pas un changement de graine : changer la
 * graine seule aurait laissé la production sur l'ancien circuit, en silence (§118.107).
 *
 * ── LES PARCOURS, ET POURQUOI QUATRE ÉTAPES SUFFISENT ───────────────────────────────────
 *
 * Chaque demande traverse CETTE colonne vertébrale, filtrée par son parcours (`parcours.ts`) :
 * une BORNE — où la chaîne s'arrête — et un TAMIS — les étapes qu'elle ne traverse pas —, figés à
 * la naissance de l'instance (`finalSlug`, `skippedSlugs`, §118.142). Ce n'est plus une tranche
 * contiguë : un KAM traverse le préliminaire sans la Direction des opérations, un National Sales
 * l'inverse. La définition, elle, reste UNIQUE : deux définitions auraient divergé au premier
 * réglage (§118.5).
 */

/**
 * LA PORTE DU DG N'EST PLUS UNE ÉTAPE DU CIRCUIT (27/10/2026) : le DG valide le TOTAL des postes, à la
 * fin, au-dessus du seuil (`ad-pro/porte-dg.ts`). L'étape reste dans la définition — des demandes
 * nées avant la règle peuvent y être posées et doivent pouvoir en sortir —, mais aucune demande
 * nouvelle ne la traverse (`parcoursAdPro` la met toujours dans le tamis).
 */
export const DESCRIPTION_DG_HORS_CIRCUIT =
  "Hors circuit depuis le 27/10/2026 : le Directeur Général ne valide plus la demande ici, mais le total de ses "
  + "postes, à la fin, quand il dépasse le seuil réglé en Administration › Réglages. Seules des demandes nées "
  + "avant cette règle peuvent encore attendre à cette étape.";

/** L'étape du Directeur des opérations — le N+1 de tout demandeur hors délégué, le second filtre du délégué. */
export const ETAPE_DIRECTEUR_OPERATIONS: StepInput = {
  slug: SLUG_DIRECTION,
  title: "Validation (Directeur des opérations)",
  description:
    "Le Directeur des opérations valide la demande : il est le N+1 de tout demandeur hors délégué médical, et le "
    + "second filtre après le National Sales pour un délégué. Il ne fixe aucun montant — la Direction Marketing "
    + "prévalide ensuite, puis l'argent se décide poste par poste.",
  actorScope: "ROLE",
  actorRoles: ["OPERATIONS_DIRECTOR"],
  powers: ["APPROVE", "REJECT", "COMMENT"],
  notifyRoles: ["OPERATIONS_DIRECTOR", "SUPER_ADMIN"],
  legacyStatus: "PRELIMINARY_APPROVED",
};

/** Les quatre étapes « colonne vertébrale » communes aux 4 catégories. */
function defaultSpine(): StepInput[] {
  return [
    {
      slug: SLUG_PRELIMINAIRE,
      title: "Approbation préliminaire (National Sales)",
      description:
        "Le National Sales approuve ou refuse la demande de son KAM avant qu'elle n'entre dans la chaîne de validation.",
      actorScope: "ROLE",
      actorRoles: ["NATIONAL_SALES"],
      // PLUS DE DÉSIGNATION : l'étape suivante est portée par un RÔLE et non par une personne
      // désignée. Garder le pouvoir ASSIGN ferait refuser toute approbation tant que personne
      // n'est désigné, pour remplir un champ que plus rien ne lit.
      powers: ["APPROVE", "REJECT", "COMMENT"],
      notifyRoles: ["NATIONAL_SALES", "SUPER_ADMIN"],
      legacyStatus: "AWAITING_PRELIMINARY",
    },
    {
      slug: SLUG_DG,
      title: "Validation du Directeur Général",
      description: DESCRIPTION_DG_HORS_CIRCUIT,
      actorScope: "ROLE",
      actorRoles: ["GENERAL_MANAGER"],
      powers: ["APPROVE", "REJECT", "COMMENT"],
      // PAS de seuil écrit ici : le seuil GLOBAL des réglages gouverne cette étape (voir
      // `seuilFranchissement`). L'y recopier en ferait une seconde vérité, figée au jour du
      // semis, que personne ne penserait à remettre à jour (§118.5).
      autoSkipMaxAmount: null,
      notifyRoles: ["GENERAL_MANAGER", "SUPER_ADMIN"],
      legacyStatus: "PRELIMINARY_APPROVED",
    },
    // SUR LA ROUTE DU RANG 2 (Direction Marketing, Manager Promotion médicale), cette étape CONCLUT :
    // elle hérite alors, à l'EXÉCUTION, le montant et la sous-catégorie de l'étape qu'elle remplace
    // (`pouvoirs-argent.ts`). La définition ne change pas ; la description, elle, dit les DEUX routes.
    // Elle disait « le montant ne se décide PAS ici » — faux sur la route coupée depuis §118.197g, et
    // c'est la phrase que lit le Super Admin qui règle le circuit. Le même texte est posé en base par
    // `20270104091000_description_etape_final`, là où l'ancien est resté mot pour mot (un test exige
    // que les deux restent identiques : deux sources de la même étape feraient deux circuits).
    // LE DIRECTEUR DES OPÉRATIONS — le rôle `OPERATIONS_DIRECTOR`, et lui (Direction, 27/10/2026 : « il
    // faut que ce soit lui, l'Operations Director »). Il était tenu jusqu'ici par le rôle `DIRECTION`.
    // Les mêmes valeurs sont écrites en base par `20270131130000_adpro_circuit_prevalidation`.
    ETAPE_DIRECTEUR_OPERATIONS,
    // LA PRÉVALIDATION DE LA DIRECTION MARKETING — la dernière étape, celle qui conclut (27/10/2026).
    ETAPE_PREVALIDATION,
  ];
}

/**
 * LE SPONSORING NE TRANCHE PAS L'ARGENT À CETTE ÉTAPE — il tranche la TENUE (§118.151).
 *
 * « Une fois validé par le National Sales et le Directeur des opérations, la Direction Marketing
 * pré-valide ou refuse la tenue de l'événement. Si elle pré-valide, on passe aux postes — devis,
 * BC, factures — puis, l'événement complété, elle valide tout, met chaque poste dans un budget,
 * et clôture » (Direction, 09/2026).
 *
 * L'étape garde son SLUG (`marketing`) : le parcours, les bornes, le caviardage, la prévention
 * des référents et les instances déjà posées dessus la désignent par lui (§118.107, §118.144).
 * Ce qui change est ce qu'elle DÉCIDE : plus de montant ni de catégorie budgétaire — l'argent se
 * décide poste par poste, puis à la clôture (`ad-pro/cloture-sponsoring.ts`) — et plus d'ordre de
 * dépense global : ce sont les postes qui portent la dépense, et un ordre global en plus la ferait
 * payer deux fois. La déclaration d'information médicale part toujours ici : c'est l'ÉVÉNEMENT
 * qui se déclare, et il est décidé ici — la clôture vient APRÈS l'événement, trop tard pour le
 * déclarer.
 *
 * Les quatre catégories partagent le reste de la colonne vertébrale ; seul le sponsoring suit
 * cette règle, parce que seule la Direction l'a énoncée pour lui. Les mêmes valeurs sont écrites
 * par la migration `20261129090000_sponsoring_pre_validation_postes_cloture` sur l'étape déjà en
 * base : un test exige qu'elles restent identiques, sinon la graine (bases neuves) et la
 * migration (production) feraient deux circuits sous le même nom (§118.5).
 */
export const ETAPE_PRE_VALIDATION_SPONSORING: StepInput = {
  slug: SLUG_MARKETING,
  title: "Pré-validation de la tenue (Direction Marketing)",
  description:
    "La Direction Marketing pré-valide ou refuse la TENUE de l'événement. Pré-validée, la demande passe aux postes "
    + "(devis, BC, factures), puis à la validation finale qui range chaque poste dans un budget et clôture la demande.",
  actorScope: "ROLE",
  actorRoles: [ROLE_DIRECTION_MARKETING],
  powers: ["APPROVE", "REJECT", "COMMENT"],
  requireAmount: false,
  requireCategory: false,
  notifyRoles: [ROLE_DIRECTION_MARKETING, "SUPER_ADMIN"],
  confidential: false,
  emitDeclaration: true,
  emitExpenseOrder: false,
  legacyStatus: "AWAITING_FINAL",
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT DU 27/10/2026 — PRÉVALIDATION, POSTES, PUIS LE DG SUR LE TOTAL, pour toutes les natures.
 *
 * « Tant qu'on n'a pas la prévalidation de la Direction Marketing, aucun budget ne peut être ouvert.
 * Ce qui est prévalidé, c'est le fond — une journée nationale, une prise en charge — et le montant.
 * Ensuite les postes sont ajoutés par les parties prenantes ; le DG valide le TOTAL, à la fin, et
 * seulement au-dessus du seuil, qui vaut pour toute la demande » (Direction, 27/10/2026).
 *
 * La règle du sponsoring (§118.151) devient donc celle des quatre natures : l'étape de la Direction
 * Marketing ne fixe plus ni montant ni catégorie, n'émet plus d'ordre global — les postes portent la
 * dépense —, mais la déclaration d'information médicale part toujours ici (l'événement se déclare
 * avant d'avoir lieu). Le sponsoring garde son titre et sa description (« la tenue ») : ils sont
 * écrits en base par `20261129090000_sponsoring_pre_validation_postes_cloture`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const ETAPE_PREVALIDATION: StepInput = {
  slug: SLUG_MARKETING,
  title: "Prévalidation (Direction Marketing)",
  description:
    "La Direction Marketing prévalide le fond de la demande et le montant demandé — aucun budget n'est ouvert avant. "
    + "Prévalidée, la demande passe aux postes, ajoutés par les parties prenantes et acceptés par la Direction Marketing "
    + "(montant et budget) ; le Directeur Général valide le total à la fin s'il dépasse le seuil.",
  actorScope: "ROLE",
  actorRoles: [ROLE_DIRECTION_MARKETING],
  powers: ["APPROVE", "REJECT", "COMMENT"],
  requireAmount: false,
  requireCategory: false,
  notifyRoles: [ROLE_DIRECTION_MARKETING, "SUPER_ADMIN"],
  confidential: false,
  emitDeclaration: true,
  emitExpenseOrder: false,
  legacyStatus: "AWAITING_FINAL",
};

export function defaultDefinition(category: WorkflowCategory): { name: string; description: string; steps: StepInput[] } {
  const colonne = defaultSpine();
  return {
    name: `Circuit ${CATEGORY_LABELS[category]}`,
    description:
      "Circuit de prise en charge Ad & Pro. Modifiable de bout en bout par le Super Admin (rôles, pouvoirs, étapes).",
    steps: category === "SPONSORING"
      ? colonne.map((e) => (e.slug === SLUG_MARKETING ? ETAPE_PRE_VALIDATION_SPONSORING : e))
      : colonne,
  };
}
