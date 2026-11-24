/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MA JOURNÉE » DU DÉLÉGUÉ — UNE liste, UN prochain geste (Super Admin, 11/2026).
 *
 * L'écran avait SIX portes pour noter une visite : « Faire un rapport terrain », la ligne de l'emploi du
 * temps, « À voir en priorité » (qui appelait `logVisit` et CRÉAIT une visite au lieu de clore celle
 * prévue — double comptage, et la ligne planifiée passait « délai dépassé »), « Visite chez un autre
 * praticien », la grille du plan, le terrain vocal. Il en reste une règle :
 *
 *   • toucher un médecin PLANIFIÉ aujourd'hui ouvre le rapport de CETTE visite (`rapporterVisite`) ;
 *   • tout autre médecin est une visite HORS PLAN (`ajouterVisiteImprevue`).
 *
 * La liste « Aujourd'hui » fusionne l'emploi du temps du jour — précédé des visites des jours
 * d'avant dont la fenêtre de 48 h court encore — et, dessous, « À rattraper » : les suggestions de
 * fréquence (`buildTournee`), sans les médecins déjà prévus aujourd'hui.
 *
 * Module PUR — aucune importation de valeur : l'écran (navigateur) et les tests le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { AvancementTournee, EtatVisite } from "@/lib/sfe/tournee";

/** Ce qu'une carte peut offrir : commencer le rapport, le corriger dans sa fenêtre, ou rien. */
export type GesteCarte = "COMMENCER" | "CORRIGER" | "AUCUN";

/** Le minimum qu'une visite planifiée doit porter pour être rangée. */
export interface VisiteRangeable {
  id: string;
  /** ISO. */
  date: string;
  doctorId?: string | null;
  etat: EtatVisite;
  heuresRestantes: number;
}

/** Le minimum d'une suggestion « à rattraper ». */
export interface RattrapageRangeable {
  doctorId: string;
}

export type CarteVisite<V> = V & { geste: GesteCarte; jourPasse: boolean };

/** Le geste d'une visite : commencer tant qu'elle est à faire, corriger un rapport fait dans sa fenêtre. */
export function gesteDeVisite(etat: EtatVisite, heuresRestantes: number): GesteCarte {
  if (etat === "A_FAIRE" && heuresRestantes > 0) return "COMMENCER";
  if (etat === "FAITE" && heuresRestantes > 0) return "CORRIGER";
  return "AUCUN";
}

/** `AAAA-MM-JJ` d'un instant, en heure LOCALE — les visites sont posées au jour local. */
export function jourLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const RANG_ETAT: Record<EtatVisite, number> = { A_FAIRE: 0, FAITE: 1, REPORTEE: 2, ANNULEE: 2, PERDUE: 3 };

/**
 * LA LISTE DU JOUR.
 *
 *  1. Une visite d'un jour PRÉCÉDENT ne figure que si elle est encore À FAIRE dans sa fenêtre : c'est un
 *     rapport qu'on peut encore sauver, et c'est le plus pressé — elle passe en tête, la plus proche de sa
 *     limite d'abord. Faite, perdue ou dite non tenue, elle appartient à l'onglet « Semaine ».
 *  2. Les visites du jour suivent : à faire d'abord (dans l'ordre du plan), puis faites, puis non tenues.
 *  3. « À rattraper » : les suggestions, moins les médecins déjà présents dans la liste du jour — on ne
 *     propose pas d'aller voir quelqu'un qu'on voit déjà.
 */
export function fusionnerJournee<V extends VisiteRangeable, R extends RattrapageRangeable>(input: {
  visites: readonly V[];
  rattrapages: readonly R[];
  /** `AAAA-MM-JJ` du jour. */
  aujourdhui: string;
}): { aujourdhui: CarteVisite<V>[]; aRattraper: R[] } {
  const avecGeste = (v: V, jourPasse: boolean): CarteVisite<V> => ({ ...v, geste: gesteDeVisite(v.etat, v.heuresRestantes), jourPasse });
  const jourDe = (v: V) => jourLocal(new Date(v.date));
  const passees = input.visites
    .filter((v) => jourDe(v) < input.aujourdhui && v.etat === "A_FAIRE" && v.heuresRestantes > 0)
    .map((v) => avecGeste(v, true))
    .sort((a, b) => a.heuresRestantes - b.heuresRestantes);
  const duJour = input.visites
    .filter((v) => jourDe(v) === input.aujourdhui)
    .map((v, i) => ({ c: avecGeste(v, false), i }))
    .sort((a, b) => RANG_ETAT[a.c.etat] - RANG_ETAT[b.c.etat] || a.i - b.i)
    .map((x) => x.c);
  const liste = [...passees, ...duJour];
  const presents = new Set(liste.map((v) => v.doctorId).filter((x): x is string => Boolean(x)));
  return { aujourdhui: liste, aRattraper: input.rattrapages.filter((r) => !presents.has(r.doctorId)) };
}

/** La cible d'un geste « commencer » : le rapport d'une visite planifiée, ou une visite hors plan. */
export type CibleVisite =
  | { sorte: "PLANIFIEE"; visitId: string }
  | { sorte: "HORS_PLAN"; doctorId: string };

/**
 * LA PROCHAINE VISITE — celle qui porte le bouton plein « Commencer la visite ».
 *
 * La première carte du jour qu'on peut commencer ; à défaut, la première suggestion à rattraper (une
 * visite hors plan). `sauf` écarte ce qu'on vient d'enregistrer : la liste affichée n'est pas encore
 * rafraîchie quand « Enregistré. Prochaine : … » se lit.
 */
export function prochaineVisite<V extends VisiteRangeable, R extends RattrapageRangeable>(
  journee: { aujourdhui: readonly CarteVisite<V>[]; aRattraper: readonly R[] },
  sauf: { visitId?: string | null; doctorId?: string | null } = {},
): CibleVisite | null {
  const v = journee.aujourdhui.find((c) => c.geste === "COMMENCER" && c.id !== sauf.visitId && (!sauf.doctorId || c.doctorId !== sauf.doctorId));
  if (v) return { sorte: "PLANIFIEE", visitId: v.id };
  const r = journee.aRattraper.find((x) => x.doctorId !== sauf.doctorId);
  return r ? { sorte: "HORS_PLAN", doctorId: r.doctorId } : null;
}

/**
 * QUEL RAPPORT OUVRE UN MÉDECIN CHOISI — « Voir un médecin hors plan » cherche dans tout le panel ; si le
 * médecin choisi est PRÉVU aujourd'hui et encore à faire, c'est le rapport de CETTE visite qui s'ouvre.
 * Sinon, une visite hors plan à côté créerait le doublon que la saisie rapide fabriquait.
 */
export function cibleDuPraticien<V extends VisiteRangeable>(doctorId: string, aujourdhui: readonly CarteVisite<V>[]): CibleVisite {
  const prevue = aujourdhui.find((c) => c.doctorId === doctorId && c.geste === "COMMENCER");
  return prevue ? { sorte: "PLANIFIEE", visitId: prevue.id } : { sorte: "HORS_PLAN", doctorId };
}

// ─────────────────────────── La ligne de chiffres ───────────────────────────

/** Ce que la ligne de chiffres lit du panel (`MonthProgress`). */
export interface CouverturePanel {
  covered: number;
  panelSize: number;
  coveragePct: number;
}

export interface LigneDeChiffres {
  fait: number;
  /** Le dénominateur ; null quand aucun plan n'a planifié de visite ce mois. */
  sur: number | null;
  libelle: string;
  /** Pour la barre : visitées / planifiées. */
  pct: number;
  sousTexte: string[];
}

/**
 * UN SEUL COMPTEUR « CE MOIS » — celui du PLAN DE TOURNÉE VALIDÉ.
 *
 * L'écran en montrait deux qui se contredisaient : « 12 / 40 » (le requis de la segmentation) en haut,
 * « 8 / 31 visitées » (le plan) au-dessus du tableau. On garde le PLAN : c'est l'engagement que le
 * superviseur a validé, et c'est `avancementTournee` — le même calcul que le pilotage de l'équipe et le
 * cockpit. Le délégué lit donc le chiffre sur lequel on le suit. Le reste se dit en sous-texte, en mots :
 * les visites hors plan (elles comptent au réalisé, jamais au plan), les rapports hors délai, la part du
 * panel déjà vue.
 */
export function ligneDeChiffres(a: AvancementTournee, panel: CouverturePanel | null): LigneDeChiffres {
  const sousTexte: string[] = [];
  // Sans plan, le chiffre principal EST déjà celui des visites hors plan : le redire serait le compter deux fois.
  if (a.imprevues > 0 && a.planifiees > 0) sousTexte.push(`+ ${a.imprevues} hors plan`);
  if (a.perdues > 0) sousTexte.push(`${a.perdues} hors délai`);
  if (a.ecartees > 0) sousTexte.push(`${a.ecartees} reportée${a.ecartees > 1 ? "s" : ""} ou annulée${a.ecartees > 1 ? "s" : ""}`);
  if (panel && panel.panelSize > 0) sousTexte.push(`${panel.coveragePct} % du panel vu (${panel.covered}/${panel.panelSize})`);
  if (a.planifiees > 0) {
    return { fait: a.visitees, sur: a.planifiees, libelle: "visites du plan ce mois", pct: a.tauxRealisation, sousTexte };
  }
  return { fait: a.visitesTotales, sur: null, libelle: a.visitesTotales > 1 ? "visites ce mois" : "visite ce mois", pct: 0, sousTexte };
}

// ─────────────────────────── Les états vides, avec leur remède ───────────────────────────

/** Le plan qui couvre aujourd'hui, tel que l'écran le lit (`queries/journee-delegue.ts`). */
export interface PlanDuJourVue {
  id: string;
  status: string;
  /** Qui doit trancher maintenant. */
  chez: string | null;
  /** ISO — depuis quand il attend. */
  depuis: string | null;
}

export interface EtatDuPlan {
  ton: "info" | "warning";
  texte: string;
  geste: { libelle: string; href: string } | null;
}

const JOUR_MS = 86_400_000;

/**
 * CE QUE « MA JOURNÉE » DIT DU PLAN quand il n'est pas validé — toujours avec le remède, jamais un vide qui laisse
 * croire à une panne :
 *  · pas de plan pour aujourd'hui → « Préparer mon plan » ;
 *  · soumis ou escaladé → « En attente de validation par X depuis n j » (le délégué sait chez qui relancer) ;
 *  · brouillon, rejeté, en révision → le geste qui le fait avancer.
 * Un plan VALIDÉ ne dit rien : la liste parle pour lui. `avecVisitesPrevues` tait « pas de plan » quand des visites
 * (commandées par la Direction, par exemple) remplissent déjà la journée.
 */
export function etatDuPlanPourJournee(plan: PlanDuJourVue | null, maintenant: Date, avecVisitesPrevues: boolean): EtatDuPlan | null {
  const liste = "/medical/plan-de-tournee";
  if (!plan) {
    return avecVisitesPrevues ? null : {
      ton: "info", texte: "Aucun plan de tournée ne couvre aujourd'hui.", geste: { libelle: "Préparer mon plan", href: liste },
    };
  }
  const ouvrir = `${liste}?plan=${encodeURIComponent(plan.id)}`;
  if (plan.status === "APPROVED") return null;
  if (plan.status === "SUBMITTED" || plan.status === "ESCALATED") {
    const jours = plan.depuis ? Math.max(0, Math.floor((maintenant.getTime() - new Date(plan.depuis).getTime()) / JOUR_MS)) : null;
    const depuis = jours === null ? "" : jours === 0 ? " depuis aujourd'hui" : ` depuis ${jours} j`;
    return { ton: "info", texte: `Plan en attente de validation${plan.chez ? ` par ${plan.chez}` : ""}${depuis}.`, geste: { libelle: "Voir mon plan", href: ouvrir } };
  }
  if (plan.status === "REJECTED") return { ton: "warning", texte: "Plan rejeté — à corriger et resoumettre.", geste: { libelle: "Corriger mon plan", href: ouvrir } };
  if (plan.status === "REVISION") return { ton: "warning", texte: "Plan rouvert en révision — à resoumettre.", geste: { libelle: "Ouvrir mon plan", href: ouvrir } };
  return { ton: "warning", texte: "Plan en brouillon — pas encore soumis à validation.", geste: { libelle: "Terminer mon plan", href: ouvrir } };
}
