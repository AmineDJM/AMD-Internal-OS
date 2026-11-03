import { genes, type PlanProgramme, type TacheProgramme } from "@/lib/missions/equipe/programme";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORDONNANCEUR D'UN PROGRAMME (lot O2, décision 0059 § 4) — PUR, DÉTERMINISTE, aucun modèle.
 *
 * À chaque réveil (fin d'un chantier, intégration, webhook, battement), il dit quelles tâches PARTENT maintenant :
 *   • toutes leurs dépendances sont INTÉGRÉES dans la cible (pas seulement « finies » : la suite part de leur code) ;
 *   • aucune gêne (périmètre, ressource nommée, migration) avec une tâche VIVANTE non intégrée — lancée, en file
 *     d'intégration, en retour chez son travailleur : on sérialise AVANT le conflit, on ne le répare pas après ;
 *   • dans la limite de concurrence (sessions qui travaillent) et du budget (lancements, dollars).
 * Et il dit pourquoi les autres attendent (le tableau l'affiche), et si le programme est fini ou bloqué.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETATS_TACHE = ["ATTENTE", "LANCEE", "EN_FILE", "EN_INTEGRATION", "RETOUR", "INTEGREE", "ECHEC", "ANNULEE"] as const;
export type EtatTache = (typeof ETATS_TACHE)[number];

/** Une session de travailleur occupée : comptée dans la concurrence. */
const TRAVAILLE = new Set<EtatTache>(["LANCEE", "RETOUR"]);
/** Vivante et non intégrée : son périmètre et ses ressources restent à elle. */
const TIENT = new Set<EtatTache>(["LANCEE", "EN_FILE", "EN_INTEGRATION", "RETOUR"]);
const MORTE = new Set<EtatTache>(["ECHEC", "ANNULEE"]);

export interface Decision {
  lancer: string[];
  attentes: Record<string, string>;
  /** Tâches qui ne partiront jamais telles quelles (dépendance morte) : replanification. */
  orphelines: string[];
  fin: "COMPLETED" | "BLOQUE" | null;
}

export function ordonnancer(
  plan: Pick<PlanProgramme, "taches" | "concurrence">,
  etats: Readonly<Record<string, EtatTache>>,
  budget: { lancementsRestants: number; usdRestant: number },
): Decision {
  const etat = (cle: string): EtatTache => etats[cle] ?? "ATTENTE";
  const d: Decision = { lancer: [], attentes: {}, orphelines: [], fin: null };
  const vivantes: TacheProgramme[] = plan.taches.filter((t) => TIENT.has(etat(t.cle)));
  let occupees = plan.taches.filter((t) => TRAVAILLE.has(etat(t.cle))).length;
  let lancements = budget.lancementsRestants;
  let usd = budget.usdRestant;
  for (const t of plan.taches) {
    if (etat(t.cle) !== "ATTENTE") continue;
    const morte = t.dependances.find((x) => MORTE.has(etat(x)));
    if (morte) { d.orphelines.push(t.cle); d.attentes[t.cle] = `dépend de « ${morte} », qui a échoué : replanification`; continue; }
    const avant = t.dependances.find((x) => etat(x) !== "INTEGREE");
    if (avant) { d.attentes[t.cle] = `attend l'intégration de « ${avant} »`; continue; }
    const gene = vivantes.map((v) => ({ v, m: genes(t, v) })).find((x) => x.m);
    if (gene) { d.attentes[t.cle] = `sérialisée après « ${gene.v.cle} » (${gene.m})`; continue; }
    if (occupees >= plan.concurrence) { d.attentes[t.cle] = `${plan.concurrence} travailleur(s) déjà en cours`; continue; }
    if (lancements < 1) { d.attentes[t.cle] = "plafond de lancements atteint"; continue; }
    if ((t.coutEstimeUsd ?? 0) > usd) { d.attentes[t.cle] = `budget restant (${usd.toFixed(2)} $) sous l'estimation (${(t.coutEstimeUsd ?? 0).toFixed(2)} $)`; continue; }
    d.lancer.push(t.cle);
    vivantes.push(t);
    occupees += 1;
    lancements -= 1;
    usd -= t.coutEstimeUsd ?? 0;
  }
  const tous = plan.taches.map((t) => etat(t.cle));
  if (tous.every((e) => e === "INTEGREE")) d.fin = "COMPLETED";
  else if (!d.lancer.length && !tous.some((e) => TIENT.has(e)) && tous.some((e) => MORTE.has(e) || e === "ATTENTE")) {
    // Plus rien ne tourne et rien ne peut partir : bloqué (dépendance morte, budget) — la Direction est prévenue.
    d.fin = "BLOQUE";
  }
  return d;
}
