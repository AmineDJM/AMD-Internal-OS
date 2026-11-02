import { REG_STEPS, regStepStatus, presubUnlocked, type RegWorkflowState } from "@/lib/regulatory-workflow";

/**
 * LE NIVEAU DE PROCESS SE LIT, IL NE SE DÉCLARE PLUS.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────────────────
 *
 * Deux endroits disaient où en était un dossier : le menu déroulant « Niveau de process » en
 * tête de fiche, et les vingt-trois étapes du processus d'enregistrement, cochées au fur et à
 * mesure. Rien ne les reliait. On déposait à l'ANPP, on cochait l'étape — et le bandeau
 * continuait d'afficher « Pré-soumission » jusqu'à ce que quelqu'un pense à changer le menu.
 * Sur soixante-neuf dossiers, ce quelqu'un n'existe pas : le tableau de suivi, les relances et
 * les décisions d'affectation se prenaient sur un chiffre faux.
 *
 * Une valeur qu'on peut poser à la main À CÔTÉ du fait qui la produit finit toujours par en
 * diverger. On ne la pose donc plus : on la DÉDUIT du travail réellement coché.
 *
 * ── LES TROIS RÈGLES ─────────────────────────────────────────────────────────────────────
 *
 *  1. **Une étape bloquée bloque le dossier.** Le blocage est le seul jugement humain du lot :
 *     personne ne peut le calculer, quelqu'un l'a constaté. On le respecte tel quel.
 *  2. **Le verrou de présoumission tient.** Sans avis favorable de l'ANPP, le dossier n'est pas
 *     engagé — quoi qu'on ait coché plus loin, il en est à sa réception (même règle que
 *     `regProgress`, et pour la même raison : une avance qui n'existe pas fausse le pilotage).
 *  3. **On n'efface jamais un passé déjà écrit.** Le niveau retenu est le PLUS AVANCÉ entre ce
 *     que disent les étapes et ce que la fiche portait déjà. Les dossiers d'avant ce
 *     changement ont un niveau saisi à la main sans étapes cochées : le déduire seul les
 *     ferait tous « reculer » à Pré-soumission du jour au lendemain — une régression de
 *     données présentée comme une amélioration.
 *
 * `CLOSED` n'est jamais déduit : clôturer est une décision, pas un avancement.
 *
 * Module PUR (aucune requête), donc testable et utilisable partout — fiche, tableau, export,
 * Adam.
 */

/** Les statuts, du moins avancé au plus avancé. `BLOCKED` n'y est pas : c'est un état, pas un rang. */
export const STATUS_LADDER: string[] = [
  "PRE_SUBMISSION",
  "IN_PREPARATION",
  "AWAITING_BV_PAYMENT",
  "SUBMITTED",
  "AWAITING_ANPP",
  "RESPONDING_TO_QUERIES",
  "DECISION_OBTAINED",
  "CLOSED",
];

export const statusRank = (s: string): number => {
  const i = STATUS_LADDER.indexOf(s);
  return i < 0 ? -1 : i;
};

/**
 * LA CARTE ÉTAPE → NIVEAU, lue de la fin vers le début.
 *
 * Chaque entrée dit : « si CETTE étape est faite, le dossier est au moins à CE niveau ». La
 * première qui répond gagne — d'où l'ordre décroissant, du plus avancé au moins avancé.
 */
const MILESTONES: { step: string; status: string }[] = [
  { step: "decision", status: "DECISION_OBTAINED" },
  { step: "commission", status: "AWAITING_ANPP" },
  { step: "reponses_depot", status: "RESPONDING_TO_QUERIES" },
  // Les cinq clés suivantes ne sont PLUS des étapes du processus (le cycle des réserves vit
  // dans la frise du dossier) — mais les dossiers qui les avaient cochées les portent toujours
  // dans leur JSON. On continue de les LIRE : sans cela, retirer les étapes ferait « reculer »
  // ces dossiers de « Réponses aux réserves » à « Attente ANPP » du jour au lendemain.
  { step: "reponses_check", status: "RESPONDING_TO_QUERIES" },
  { step: "reponses_recv", status: "RESPONDING_TO_QUERIES" },
  { step: "reserves_transmit", status: "RESPONDING_TO_QUERIES" },
  { step: "reserves_analyse", status: "RESPONDING_TO_QUERIES" },
  { step: "reserves_recv", status: "RESPONDING_TO_QUERIES" },
  { step: "evaluation", status: "AWAITING_ANPP" },
  { step: "recevabilite", status: "AWAITING_ANPP" },
  { step: "depot", status: "SUBMITTED" },
  { step: "rdv", status: "IN_PREPARATION" },
  { step: "bv75_pay", status: "IN_PREPARATION" },
  { step: "docs_check", status: "IN_PREPARATION" },
  { step: "module1", status: "IN_PREPARATION" },
  { step: "modules345", status: "IN_PREPARATION" },
  { step: "presub_ans", status: "IN_PREPARATION" },
  { step: "presub_req", status: "PRE_SUBMISSION" },
  { step: "bv25_pay", status: "PRE_SUBMISSION" },
  { step: "sample", status: "PRE_SUBMISSION" },
  { step: "presub_checklist", status: "PRE_SUBMISSION" },
  { step: "ctd", status: "PRE_SUBMISSION" },
];

/**
 * UN BV DEMANDÉ MAIS PAS PAYÉ retient le dossier — et c'est exactement ce que le niveau
 * « Attente paiement BV » sert à dire. Il ne s'applique QUE si rien de plus avancé n'a été
 * atteint : un dossier déjà déposé n'attend plus son BV, il attend l'agence.
 */
const BV_PAIRS: { req: string; pay: string }[] = [
  { req: "bv75_req", pay: "bv75_pay" },
  { req: "bv25_req", pay: "bv25_pay" },
];

/** Une étape du processus est-elle marquée bloquée ? (Présoumission défavorable comprise.) */
export function hasBlockedStep(wf: RegWorkflowState | null | undefined): boolean {
  return REG_STEPS.some((s) => regStepStatus(wf, s.key) === "BLOCKED");
}

/** Le niveau que le PROCESSUS SEUL raconte, sans regarder ce que la fiche portait déjà. */
export function statusFromWorkflow(wf: RegWorkflowState | null | undefined): string {
  if (hasBlockedStep(wf)) return "BLOCKED";

  // Le verrou de présoumission : sans avis favorable, le dossier en est à sa réception.
  if (!presubUnlocked(wf)) return "PRE_SUBMISSION";

  const done = (key: string) => regStepStatus(wf, key) === "DONE";
  const milestone = MILESTONES.find((m) => done(m.step))?.status ?? "PRE_SUBMISSION";

  // « Attente paiement BV » ne se substitue à rien de plus avancé : il ne dit quelque chose
  // que quand c'est VRAIMENT ce qui retient le dossier.
  const bv = BV_PAIRS.find((p) => done(p.req) && !done(p.pay));
  if (bv && statusRank(milestone) <= statusRank("AWAITING_BV_PAYMENT")) return "AWAITING_BV_PAYMENT";

  return milestone;
}

export interface DerivedStatus {
  /** Le niveau qui fait foi et s'affiche. */
  status: string;
  /** Ce que le processus dit à lui seul — ce qui explique la valeur. */
  fromWorkflow: string;
  /** Le niveau a-t-il changé par rapport à celui enregistré ? (→ écrire + auditer) */
  changed: boolean;
  /** Le niveau vient-il du passé déjà écrit plutôt que des étapes cochées ? */
  kept: boolean;
}

/**
 * Le niveau de process d'un dossier : déduit des étapes, jamais en retrait de ce que la fiche
 * portait déjà. C'est CETTE fonction que l'écran et les actions appellent.
 */
export function deriveStatus(
  wf: RegWorkflowState | null | undefined,
  current: string,
): DerivedStatus {
  const fromWorkflow = statusFromWorkflow(wf);

  // Un dossier CLÔTURÉ le reste : la clôture est une décision, elle ne se recalcule pas.
  if (current === "CLOSED") return { status: "CLOSED", fromWorkflow, changed: false, kept: true };

  // Une étape bloquée l'emporte sur tout — y compris sur un passé plus avancé : c'est le seul
  // constat humain de la chaîne, et le taire serait pire que de faire « reculer » un dossier.
  if (fromWorkflow === "BLOCKED") {
    return { status: "BLOCKED", fromWorkflow, changed: current !== "BLOCKED", kept: false };
  }

  // Plus rien n'est bloqué mais la fiche disait « Bloqué » : le processus reprend la main.
  if (current === "BLOCKED") {
    return { status: fromWorkflow, fromWorkflow, changed: true, kept: false };
  }

  const keepPast = statusRank(current) > statusRank(fromWorkflow);
  const status = keepPast ? current : fromWorkflow;
  return { status, fromWorkflow, changed: status !== current, kept: keepPast };
}

/**
 * La phrase qui accompagne le niveau à l'écran. Un chiffre qu'on ne peut plus corriger doit au
 * moins dire d'où il vient, sinon on le croit cassé.
 */
export function explainStatus(d: DerivedStatus): string {
  if (d.status === "CLOSED") return "Dossier clôturé — décision prise, le niveau ne se recalcule plus.";
  if (d.status === "BLOCKED") return "Une étape du processus est marquée bloquée.";
  if (d.kept) return "Niveau enregistré avant le suivi par étapes — il remontera dès que le processus le dépassera.";
  return "Déduit des étapes cochées dans le processus d'enregistrement.";
}

/** L'avis de présoumission courant — réexporté pour les appelants du niveau (écran, actions). */
