/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VALIDATION FINALE ET LA CLÔTURE D'UN SPONSORING (§118.151).
 *
 * « Une fois l'événement complété, la Direction Marketing peut tout valider et mettre chaque poste
 * dans un budget, et valider et clôturer » (Direction, 09/2026).
 *
 * Le circuit d'un sponsoring s'arrête désormais à la PRÉ-VALIDATION de sa tenue
 * (`workflow/issue-sponsoring.ts`) : l'événement aura lieu, mais aucun argent n'est encore
 * accordé. L'argent se décide poste par poste — devis, BC, facture — et la clôture est le moment
 * où il se FIGE : chaque poste décidé, chaque poste accordé rangé dans un budget, et le total des
 * postes accordés devient le montant accordé de la demande.
 *
 * ── CE QUE CE MODULE DÉCIDE ────────────────────────────────────────────────────────────────
 *
 *   · L'ÉTAT DES POSTES d'un sponsoring, lu par le serveur (actions sur les postes) ET par l'écran
 *     (panneau des postes) : décidé (ses postes engagent), tardif (un poste ajouté dépasse une
 *     enveloppe déjà fixée), clos (ses postes sont arrêtés). Deux copies de ces listes — la page en
 *     portait une, écrite à la main — finiraient par diverger, et le symptôme serait un bouton
 *     « Émettre l'ordre » que l'écran cache pendant que l'action l'accepterait (§118.5).
 *   · LE BILAN DE CLÔTURE : clôturable ou non, et TOUT ce qui manque, dit en une fois — un refus
 *     par manque ferait un aller-retour par poste sur une demande qui en porte dix (§118.18).
 *   · QUI CLÔTURE : celui qui tenait l'étape qui a pré-validé la tenue.
 *
 * Module PUR (il n'importe que la règle pure du matériel réservé, `promo/reservations`) : l'écran,
 * l'action serveur et l'op d'Adam le lisent, et les bancs l'éprouvent sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { manqueMaterielReserve, NATURE_MATERIEL_STOCK } from "@/lib/promo/reservations";

// ─────────────────────────── L'état des postes d'un sponsoring ───────────────────────────

/**
 * Les statuts où l'opération est DÉCIDÉE — ses postes peuvent engager une dépense.
 *
 * `PRE_VALIDATED` en est : la tenue est décidée, et c'est précisément à ce moment que les postes
 * passent par devis, BC et facture, chacun accordé à part.
 */
export const SPONSORING_DECIDE: readonly string[] = ["APPROVED", "ACCEPTED", "PAID", "CLOSED", "PRE_VALIDATED"];

/**
 * Les statuts où l'ARGENT est déjà décidé : un poste ajouté ensuite dépasse une enveloppe fixée,
 * il est TARDIF et le dit. Un sponsoring PRÉ-VALIDÉ n'a pas encore d'enveloppe — ajouter ses postes
 * est l'étape même que la procédure ouvre, pas un dépassement.
 */
export const SPONSORING_ARGENT_DECIDE: readonly string[] = ["APPROVED", "ACCEPTED", "PAID"];

/**
 * LES STATUTS QU'UN RÈGLEMENT SOLDE — et ceux-là seulement.
 *
 * Régler un ordre de dépense dont la source est un sponsoring le passait `PAID`, sans condition.
 * Or l'ordre d'un POSTE porte lui aussi le sponsoring comme source : sous la règle de la tenue
 * (§118.151), le premier poste réglé faisait donc « payer » la demande entière — elle sautait sa
 * clôture, quittait les listes du travail en cours et s'affichait terminée avec un seul poste
 * payé ; réglé APRÈS la clôture, il la faisait repasser de « clôturée » à « payée ». Seul un
 * accord à montant GLOBAL (l'ancien circuit) se solde par un règlement : c'est la seule forme où
 * un ordre porte toute la demande.
 */
export const STATUTS_SOLDES_PAR_UN_REGLEMENT: readonly string[] = ["APPROVED", "ACCEPTED"];

export interface EtatPostesSponsoring {
  decide: boolean;
  tardif: boolean;
  /** Clôturé : postes, montants et budgets arrêtés. */
  clos: boolean;
  /** Clos PAR SA CLÔTURE (et non par un transfert vers un autre module) : il se rouvre. */
  closParLaCloture: boolean;
}

/**
 * `CLOSED` a DEUX sens dans ce schéma, et il faut les distinguer : un transfert vers un autre
 * module écrit `CLOSED` sans date de clôture ; la validation finale l'écrit AVEC. Le premier vit
 * désormais ailleurs, le second se rouvre.
 */
export function etatPostesSponsoring(statut: string, closedAt: Date | string | null | undefined): EtatPostesSponsoring {
  const clos = statut === "CLOSED";
  return {
    decide: SPONSORING_DECIDE.includes(statut),
    tardif: SPONSORING_ARGENT_DECIDE.includes(statut),
    clos,
    closParLaCloture: clos && closedAt != null,
  };
}

// ─────────────────────────────── Le bilan de clôture ───────────────────────────────

export type StatutPoste = "DRAFT" | "PENDING" | "REVISION" | "APPROVED" | "REJECTED";

export interface PostePourCloture {
  label: string;
  status: StatutPoste | string;
  amountGranted: number | null;
  budgetCategoryId: string | null;
  /**
   * La NATURE du poste : un poste « Matériel du stock » n'engage pas d'argent (§118.167) — ni
   * budget ni montant ne s'y exigent. Obligatoire, et c'est voulu : un appelant qui l'oublierait
   * ferait exiger un budget à du matériel sorti du magasin, et la clôture serait impossible.
   */
  kind: string;
  /**
   * Ses lignes de matériel du stock, avec leur statut. Obligatoire aussi : un appelant qui les
   * oublierait laisserait clôturer une demande dont le matériel réservé est encore dehors.
   */
  lignesStock: readonly { libelle: string; statut: string }[];
}

export interface BilanCloture {
  cloturable: boolean;
  /** Tout ce qui empêche de clôturer — vide quand la clôture est possible. */
  manques: string[];
  /** Le montant que la clôture écrira : la somme des postes ACCORDÉS. */
  total: number;
  accordes: number;
  refuses: number;
  aDecider: number;
}

const A_DECIDER = new Set(["DRAFT", "PENDING", "REVISION"]);

/** « « A », « B » et 3 autres » — une liste qu'on peut lire dans une phrase de refus. */
function nommer(labels: readonly string[], max = 4): string {
  const vus = labels.slice(0, max).map((l) => `« ${l} »`);
  const reste = labels.length - vus.length;
  return reste > 0 ? `${vus.join(", ")} et ${reste} autre${reste > 1 ? "s" : ""}` : vus.join(", ");
}

/**
 * PEUT-ON CLÔTURER, ET SINON POURQUOI — tout ce qui manque, en une fois.
 *
 * Quatre conditions, chacune avec le cas qui l'impose :
 *
 *   · la tenue est PRÉ-VALIDÉE — clôturer une demande encore dans son circuit court-circuiterait
 *     les validations qui restent ; en clôturer une déjà close écrirait une seconde fois le total ;
 *   · il y a AU MOINS UN POSTE — une clôture à vide écrirait un sponsoring « accordé 0 DZD » sans
 *     que personne ait rien décidé. Chaque demande née sous la règle porte le sien depuis sa
 *     création ; une demande plus ancienne en reçoit un avant d'être close ;
 *   · AUCUN POSTE N'EST ENCORE À DÉCIDER — « tout valider » : un poste en suspens au moment où le
 *     total se fige serait une dépense ni accordée ni refusée, qui ne pèserait sur aucun budget ;
 *   · CHAQUE POSTE ACCORDÉ A SON BUDGET ET SON MONTANT — « mettre chaque poste dans un budget ».
 *     Sans budget, la dépense tombe dans « à imputer » ; sans montant, le total ment. Un poste
 *     « Matériel du stock » en est EXEMPT : il n'engage pas d'argent, son matériel sort du magasin ;
 *   · AUCUN MATÉRIEL RÉSERVÉ N'ATTEND SA CONFIRMATION (§118.167) — tant qu'une ligne est
 *     réservée, une partie du magasin est dehors sans que personne sache si elle revient.
 *
 * Tous les postes REFUSÉS ne bloquent pas : la clôture écrit alors 0 DZD, ce qui est vrai — la
 * tenue a été pré-validée, rien n'a été financé. Exiger un poste accordé ferait de cette demande
 * une impasse sans geste pour en sortir (§118.63).
 */
export function bilanCloture(statut: string, postes: readonly PostePourCloture[]): BilanCloture {
  const manques: string[] = [];
  if (statut === "CLOSED") manques.push("la demande est déjà clôturée");
  else if (statut !== "PRE_VALIDATED") {
    manques.push("la tenue de l'événement doit d'abord être pré-validée (fin du circuit de validation)");
  }

  const aDecider = postes.filter((p) => A_DECIDER.has(p.status));
  const accordes = postes.filter((p) => p.status === "APPROVED");
  const refuses = postes.filter((p) => p.status === "REJECTED");

  if (postes.length === 0) manques.push("aucun poste : ajoutez au moins le poste du sponsoring lui-même");
  if (aDecider.length > 0) {
    manques.push(`${aDecider.length} poste${aDecider.length > 1 ? "s" : ""} encore à décider (accorder ou refuser) : ${nommer(aDecider.map((p) => p.label))}`);
  }
  // L'ARGENT ne se juge que sur les postes qui en engagent : un poste « Matériel du stock » n'a ni
  // budget ni montant, et les lui exiger rendrait toute demande qui en porte un impossible à clore.
  const accordesArgent = accordes.filter((p) => p.kind !== NATURE_MATERIEL_STOCK);
  const sansBudget = accordesArgent.filter((p) => !p.budgetCategoryId);
  if (sansBudget.length > 0) {
    manques.push(`${sansBudget.length} poste${sansBudget.length > 1 ? "s" : ""} accordé${sansBudget.length > 1 ? "s" : ""} sans budget — rangez chacun dans un budget : ${nommer(sansBudget.map((p) => p.label))}`);
  }
  const sansMontant = accordesArgent.filter((p) => !(typeof p.amountGranted === "number" && Number.isFinite(p.amountGranted) && p.amountGranted > 0));
  if (sansMontant.length > 0) {
    manques.push(`${sansMontant.length} poste${sansMontant.length > 1 ? "s" : ""} accordé${sansMontant.length > 1 ? "s" : ""} sans montant : ${nommer(sansMontant.map((p) => p.label))}`);
  }

  const materiel = manqueMaterielReserve(postes.flatMap((p) => p.lignesStock));
  if (materiel) manques.push(materiel);

  const total = Math.round(accordesArgent.reduce((t, p) => t + (typeof p.amountGranted === "number" && Number.isFinite(p.amountGranted) ? p.amountGranted : 0), 0) * 100) / 100;
  return {
    cloturable: manques.length === 0,
    manques,
    total,
    accordes: accordes.length,
    refuses: refuses.length,
    aDecider: aDecider.length,
  };
}

// ─────────────────────────────── Qui clôture ───────────────────────────────

/**
 * QUI CLÔTURE : CELUI QUI A PRÉ-VALIDÉ LA TENUE.
 *
 * La Direction Marketing, en règle générale. Sauf quand la demande vient d'elle : on ne fait
 * jamais arbitrer à quelqu'un sa propre demande, et c'est alors la Direction des opérations qui
 * a tranché (la chaîne s'arrête à son étape, `final`, §118.142). La question se lit sur le
 * PARCOURS GELÉ de l'instance — la borne `finalSlug` — et non sur le rôle du demandeur
 * aujourd'hui : un parcours est un fait de la DEMANDE, pas du poste qu'occupe son auteur (§118.107).
 */
export type QuiCloture = "DIRECTION_MARKETING" | "DIRECTION";

export function quiCloture(borneDuParcours: string | null | undefined): QuiCloture {
  // `final` est le slug de l'étape de la Direction des opérations (`workflow/parcours.ts`,
  // SLUG_DIRECTION). Écrit ici en littéral pour que ce module reste pur ; un test exige qu'ils
  // restent égaux.
  return borneDuParcours === "final" ? "DIRECTION" : "DIRECTION_MARKETING";
}

export const LIBELLE_QUI_CLOTURE: Record<QuiCloture, string> = {
  DIRECTION_MARKETING: "la Direction Marketing",
  DIRECTION: "la Direction (la demande vient de la Direction Marketing elle-même)",
};

export interface FaitsCloturant {
  estSuperAdmin: boolean;
  /** Porte le rôle qui tranche (Direction Marketing), principal ou secondaire. */
  porteLeRoleQuiTranche: boolean;
  /** Vue globale (Direction, DG…) — l'autorité de l'étape `final`. */
  aLaVueGlobale: boolean;
  /** Est l'auteur de la demande. */
  estLeDemandeur: boolean;
}

/**
 * Le Super Admin toujours ; sinon celui qui tient l'autorité de l'étape qui a tranché — et jamais
 * sur sa propre demande : clôturer, c'est fixer le montant accordé, et l'on ne s'accorde pas un
 * budget à soi-même.
 */
export function peutCloturer(faits: FaitsCloturant, qui: QuiCloture): boolean {
  if (faits.estSuperAdmin) return true;
  if (faits.estLeDemandeur) return false;
  return qui === "DIRECTION" ? faits.aLaVueGlobale : faits.porteLeRoleQuiTranche;
}

export function refusCloture(qui: QuiCloture): string {
  return `La validation finale et la clôture de ce sponsoring reviennent à ${LIBELLE_QUI_CLOTURE[qui]} `
    + "(ou au Super Admin) — jamais à l'auteur de la demande.";
}
