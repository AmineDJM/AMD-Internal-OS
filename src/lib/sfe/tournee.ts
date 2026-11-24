import { estJourOuvre } from "@/lib/sfe-day";

/**
 * QUELS JOURS UNE TOURNÉE PEUT EMPLOYER — réexporté depuis `sfe-day`, jamais réécrit.
 *
 * Le fait (« la semaine ouvrée algérienne va du dimanche au jeudi ») appartient à `sfe-day`, qui
 * s'en sert pour le rythme du mois. Ce module en a besoin pour placer une échéance et pour
 * refuser une visite posée un vendredi ; l'énoncer une seconde fois ferait deux calendriers qui
 * divergent au premier jour férié ajouté (§118.5). Le réexport donne aux appelants du plan de
 * tournée UN point d'entrée sans dupliquer la règle.
 */
export { estJourOuvre as estJourOuvrePourTournee };

/**
 * LE PLAN DE TOURNÉE — la période, l'échéance, la validation, et l'état de chaque visite.
 *
 * ── CE MODULE EST PUR, ET C'EST LA MOITIÉ QUI COMPTE ────────────────────────────────────────
 *
 * Tout ce qui décide — quelle période on planifie, quand la soumission est due, si un rapport
 * terrain est encore ouvert, si une visite est à faire / faite / perdue, où en est l'avancement —
 * vit ICI, sans base, sans import lourd, testé sur ses seules entrées. Le CODE décide COMMENT ;
 * l'écran et les actions ne font que l'appeler.
 *
 * ── LE DÉNOMINATEUR EST CALCULÉ UNE FOIS ────────────────────────────────────────────────────
 *
 * « visitées / planifiées » se lit sur l'emploi du temps du KAM ET sur le tableau de bord de la
 * Direction. Deux écrans qui comptent séparément divergent, toujours (§118.51) — d'où
 * `avancementTournee`, appelée par les deux, et un test qui les compare.
 *
 * ── UNE VISITE PERDUE N'EST PAS UNE VISITE EN ATTENTE ───────────────────────────────────────
 *
 * La demande dit « gris tant que le rapport n'est pas fait, vert après ». Mais le rapport se
 * ferme 48 h après la visite : une visite du 3 sans rapport le 10 n'est plus « en attente », elle
 * est PERDUE — et la laisser grise pour toujours ferait lire un retard rattrapable là où il n'y a
 * plus rien à rattraper. Trois états, donc, pas deux.
 */

// ─────────────────────────── La période planifiée ───────────────────────────

/**
 * LA MAILLE DE PLANIFICATION. Mensuelle par défaut — le Super Admin peut choisir hebdomadaire,
 * trimestrielle ou semestrielle. La liste est FERMÉE : une maille de plus est une décision de
 * revue de code, pas une chaîne libre en base.
 */
export const GRANULARITES = ["WEEK", "MONTH", "QUARTER", "HALF_YEAR"] as const;
export type Granularite = (typeof GRANULARITES)[number];

export const GRANULARITE_LABELS: Record<Granularite, string> = {
  WEEK: "Hebdomadaire",
  MONTH: "Mensuelle",
  QUARTER: "Trimestrielle",
  HALF_YEAR: "Semestrielle",
};

export const GRANULARITE_DEFAUT: Granularite = "MONTH";

export function estGranularite(v: string): v is Granularite {
  return (GRANULARITES as readonly string[]).includes(v);
}

/** Minuit LOCAL du jour donné — les périodes se comparent en JOURS, jamais en instants. */
export function jour(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Le dernier instant du jour donné (23:59:59.999) : une période INCLUT son dernier jour. */
export function finDeJour(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * LA SEMAINE COMMENCE LE DIMANCHE. Ce n'est pas une préférence : la semaine ouvrée algérienne va
 * du dimanche au jeudi (`estJourOuvre`), donc une semaine qui commencerait le lundi couperait la
 * semaine de travail en deux et un plan hebdomadaire porterait sur deux semaines de terrain.
 */
export function debutDeSemaine(d: Date): Date {
  const j = jour(d);
  return new Date(j.getFullYear(), j.getMonth(), j.getDate() - j.getDay());
}

/** La période qui CONTIENT cette date, à cette maille — début inclus, fin incluse. */
export function periodeDe(granularite: Granularite, dans: Date): { debut: Date; fin: Date } {
  const j = jour(dans);
  if (granularite === "WEEK") {
    const debut = debutDeSemaine(j);
    return { debut, fin: finDeJour(new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + 6)) };
  }
  if (granularite === "MONTH") {
    const debut = new Date(j.getFullYear(), j.getMonth(), 1);
    return { debut, fin: finDeJour(new Date(j.getFullYear(), j.getMonth() + 1, 0)) };
  }
  const mois = granularite === "QUARTER" ? 3 : 6;
  const premier = Math.floor(j.getMonth() / mois) * mois;
  const debut = new Date(j.getFullYear(), premier, 1);
  return { debut, fin: finDeJour(new Date(j.getFullYear(), premier + mois, 0)) };
}

/** La période SUIVANTE — celle qu'on planifie quand on est encore dans la précédente. */
export function periodeSuivante(granularite: Granularite, depuis: Date): { debut: Date; fin: Date } {
  const courante = periodeDe(granularite, depuis);
  const lendemain = new Date(courante.fin.getFullYear(), courante.fin.getMonth(), courante.fin.getDate() + 1);
  return periodeDe(granularite, lendemain);
}

// ─────────────────────────── L'échéance de soumission ───────────────────────────

/**
 * COMBIEN DE JOURS AVANT LA FIN DU MOIS QUI PRÉCÈDE LA PÉRIODE. La demande dit « la
 * planification doit se faire 15 j avant la fin du mois à venir ».
 *
 * ⚠ LECTURE ASSUMÉE, et elle est écrite ici parce qu'elle change le comportement : « le mois à
 * venir » désigne ce qu'on PLANIFIE, et « 15 j avant la fin du mois » désigne QUAND. L'échéance
 * tombe donc 15 jours avant la fin du mois qui PRÉCÈDE la période — c'est-à-dire AVANT que la
 * période commence. L'autre lecture (15 jours avant la fin du mois planifié) placerait
 * l'échéance au milieu de la période, et le KAM planifierait des journées déjà passées : un
 * plan de tournée soumis le 16 février pour février ne sert plus à rien.
 */
export const JOURS_AVANT_ECHEANCE = 15;

/**
 * LE PLAFOND DU DÉLAI. Au-delà de 90 jours, l'échéance d'un plan mensuel tomberait avant même
 * que la période PRÉCÉDENTE ait commencé — une valeur de ce genre est une faute de frappe, pas
 * une politique. L'action la REFUSE en nommant la borne (§118.30) ; le lecteur ci-dessous, lui,
 * retombe sur le défaut, parce qu'une valeur stockée hors borne ne peut venir que d'une écriture
 * à la main et qu'un écran qui plante sur un réglage ne répare rien.
 */
export const JOURS_AVANT_ECHEANCE_MAX = 90;

/**
 * LE RÉGLAGE DE LA PLANIFICATION — ce que le Super Admin a choisi, ou les défauts.
 *
 * Il vivait sous forme de JSON brut (`SfeSettings.tourPlanning`) lu à TROIS endroits, chacun
 * avec sa propre lecture des défauts, et ÉCRIT NULLE PART : la maille était « configurable »
 * dans la doctrine, dans la fiche de l'op et à l'écran du KAM (« réglée par le Super Admin »),
 * et aucun écran ne permettait de la régler — une promesse d'écran (§118.45), lue par tout le
 * monde et tenue par personne. La lecture vit désormais ICI, une fois, pure ; l'écriture a son
 * action et son formulaire.
 */
export interface ReglageTournee {
  granularite: Granularite;
  /** Combien de jours avant la fin du mois qui précède la période l'échéance tombe. */
  joursAvant: number;
}

export const REGLAGE_TOURNEE_DEFAUT: ReglageTournee = { granularite: GRANULARITE_DEFAUT, joursAvant: JOURS_AVANT_ECHEANCE };

/**
 * LIRE LE RÉGLAGE depuis ce que la base porte — sans jamais lever : un JSON absent, d'une autre
 * forme, ou hors borne rend le DÉFAUT champ par champ. On ne comble pas un champ inconnu par
 * une valeur plausible : on retombe sur celle que la demande nomme (« mensuel par défaut »).
 */
export function reglageDepuisJson(raw: unknown): ReglageTournee {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const g = typeof o.granularity === "string" && estGranularite(o.granularity) ? o.granularity : GRANULARITE_DEFAUT;
  const j = typeof o.submissionLeadDays === "number" && Number.isFinite(o.submissionLeadDays)
    ? Math.round(o.submissionLeadDays)
    : JOURS_AVANT_ECHEANCE;
  const joursAvant = j >= 0 && j <= JOURS_AVANT_ECHEANCE_MAX ? j : JOURS_AVANT_ECHEANCE;
  return { granularite: g, joursAvant };
}

/**
 * L'ÉCHÉANCE DE SOUMISSION d'un plan qui couvre `periodeDebut`.
 *
 * On part de la fin du mois PRÉCÉDANT la période et l'on recule de `joursAvant`. Le résultat est
 * ramené au dernier jour OUVRÉ si l'on tombe un vendredi ou un samedi : une échéance posée un
 * jour de week-end se lit comme un jour de grâce et se rate (§118.5 — c'est `estJourOuvre` qui
 * dit le week-end, pas une seconde règle écrite ici).
 */
export function echeanceDeSoumission(periodeDebut: Date, joursAvant: number = JOURS_AVANT_ECHEANCE): Date {
  const finMoisPrecedent = new Date(periodeDebut.getFullYear(), periodeDebut.getMonth(), 0);
  const brut = new Date(finMoisPrecedent.getFullYear(), finMoisPrecedent.getMonth(), finMoisPrecedent.getDate() - joursAvant);
  let d = jour(brut);
  while (!estJourOuvre(d)) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  return finDeJour(d);
}

// ─────────────────────────── Les délais de 48 h ───────────────────────────

/**
 * LA FENÊTRE DU RAPPORT TERRAIN — 48 h après la visite, et pas une minute de plus.
 *
 * Ce n'est pas un confort : un compte rendu écrit une semaine après est un souvenir, pas un
 * fait. La borne est DURE côté serveur ; l'écran ne fait que l'afficher.
 */
export const HEURES_RAPPORT = 48;
/** LE MÊME DÉLAI pour resoumettre un plan rejeté — la Direction attend le plan corrigé. */
export const HEURES_RESOUMISSION = 48;

const MS_H = 3_600_000;

export function limiteRapport(dateVisite: Date): Date {
  return new Date(dateVisite.getTime() + HEURES_RAPPORT * MS_H);
}

export function limiteResoumission(rejeteLe: Date): Date {
  return new Date(rejeteLe.getTime() + HEURES_RESOUMISSION * MS_H);
}

/**
 * LE RAPPORT EST-IL ENCORE OUVERT ? Et COMBIEN D'HEURES reste-t-il.
 *
 * Les heures restantes voyagent avec la réponse : un refus qui dit seulement « trop tard » fait
 * découvrir la borne au moment où l'on ne peut plus rien (§118.30), et un écran qui affiche
 * « 6 h restantes » fait rentrer le rapport le soir même.
 */
export function fenetreRapport(dateVisite: Date, maintenant: Date): {
  ouvert: boolean;
  limite: Date;
  heuresRestantes: number;
} {
  const limite = limiteRapport(dateVisite);
  const restant = limite.getTime() - maintenant.getTime();
  return {
    ouvert: restant > 0,
    limite,
    heuresRestantes: Math.max(0, Math.ceil(restant / MS_H)),
  };
}

/**
 * LE REFUS D'UNE VISITE « FAITE » HORS DÉLAI, à la CRÉATION — une seule rédaction pour les deux
 * portes qui créent une visite déjà faite (la visite imprévue et la saisie rapide de « Ma
 * journée »). La même borne de 48 h que le rapport d'une visite planifiée : sans elle, créer une
 * visite datée d'il y a trois semaines serait le moyen de contourner le verrou (§118.71).
 */
export function refusVisiteHorsDelai(dateVisite: Date): string {
  return `Une visite s'enregistre dans les ${HEURES_RAPPORT} h : celle du ${dateVisite.toLocaleDateString("fr-FR")} est hors délai. `
    + "C'est la même borne que pour une visite planifiée — sans elle, enregistrer une visite après coup serait le moyen de la contourner.";
}

// ─────────────────────────── L'état d'une visite ───────────────────────────

/**
 * TROIS ÉTATS, PAS DEUX.
 *
 *  · `A_FAIRE` — grise : la visite est prévue, le rapport est encore possible.
 *  · `FAITE` — verte : le rapport est là.
 *  · `PERDUE` — la fenêtre de 48 h s'est fermée sans rapport. Ni grise (rien à rattraper) ni
 *    verte (rien n'a été rapporté) : c'est le seul état qui dise la vérité, et le taire ferait
 *    lire un retard rattrapable là où le mois est déjà entamé.
 *  · `ANNULEE` / `REPORTEE` — la visite n'a pas eu lieu et quelqu'un l'a DIT ; elle ne compte
 *    donc pas comme perdue.
 */
export type EtatVisite = "A_FAIRE" | "FAITE" | "PERDUE" | "ANNULEE" | "REPORTEE";

export const ETAT_VISITE_LABELS: Record<EtatVisite, string> = {
  A_FAIRE: "À faire",
  FAITE: "Rapport fait",
  PERDUE: "Rapport non fait — délai dépassé",
  ANNULEE: "Annulée",
  REPORTEE: "Reportée",
};

/**
 * L'état d'une visite planifiée. `statut` est celui de `MedicalVisit` (`VisitStatus`) : le
 * moteur ne redéfinit pas les statuts de l'ERP, il les LIT (§118.5).
 */
export function etatVisite(input: {
  statut: string;
  date: Date;
  /** Un rapport existe-t-il ? Écrit (`report`) ou vocal (un `FieldReport` rattaché). */
  rapportFait: boolean;
  maintenant: Date;
}): EtatVisite {
  if (input.statut === "CANCELLED") return "ANNULEE";
  if (input.statut === "POSTPONED") return "REPORTEE";
  if (input.rapportFait || input.statut === "COMPLETED") return "FAITE";
  return fenetreRapport(input.date, input.maintenant).ouvert ? "A_FAIRE" : "PERDUE";
}

/**
 * SUPPRIMER LE COMPTE RENDU D'UNE VISITE NE CHANGE PAS SILENCIEUSEMENT SON ÉTAT (§118.212).
 *
 * Un compte rendu vocal (`FieldReport`) rattaché à une visite fait passer la ligne de l'emploi du
 * temps au vert (`rapportFait`, `tour-schedule.ts`). Le retirer rend la visite à son état d'avant :
 * « à faire » ou — fenêtre de 48 h fermée — « rapport non fait », une visite PERDUE. Le retirer en
 * silence corrigerait l'état d'une visite après coup, par la porte d'à côté (§118.193a). La règle ne
 * refuse pas « tout compte rendu rattaché » (un refus à tort, §118.27 : si la visite est rapportée
 * par ailleurs, rien ne change) : elle compare l'état AVEC et SANS ce compte rendu, par `etatVisite`
 * — la MÊME fonction que l'écran, jamais une seconde copie de la règle (§118.5).
 *
 * Mesuré, et nommé plutôt que réparé ici : `avancementDuMois` ne lit que le rapport ÉCRIT
 * (`report`), pas le compte rendu vocal — pour le taux du mois, une visite rapportée seulement à la
 * voix compte déjà comme non rapportée. Ce défaut précède cette règle ; la règle ne l'aggrave pas.
 *
 * Rend la phrase du refus, ou `null` quand l'état ne bouge pas.
 */
export function refusSuppressionRapportDeVisite(input: {
  statut: string;
  date: Date;
  /** La visite porte-t-elle son propre rapport écrit ? */
  rapportEcrit: boolean;
  /** Les AUTRES comptes rendus vocaux rattachés à la même visite (hors celui qu'on retire). */
  autresRapports: number;
  maintenant: Date;
  /** Le praticien, pour dire de quelle visite il s'agit. */
  praticien?: string | null;
}): string | null {
  const avec = etatVisite({ statut: input.statut, date: input.date, rapportFait: true, maintenant: input.maintenant });
  const sans = etatVisite({ statut: input.statut, date: input.date, rapportFait: input.rapportEcrit || input.autresRapports > 0, maintenant: input.maintenant });
  if (avec === sans) return null;
  const visite = `${input.praticien ? `la visite chez ${input.praticien}` : "la visite"} du ${input.date.toLocaleDateString("fr-FR")}`;
  return `Ce compte rendu est le seul rapport de ${visite} (emploi du temps) : sans lui elle repasserait de « ${ETAT_VISITE_LABELS[avec]} » à « ${ETAT_VISITE_LABELS[sans]} » dans « Ma journée », sans que personne l'ait décidé. `
    + "Il ne se supprime pas d'ici : corrigez-le (« Corriger / renvoyer »), ou, si la visite n'a pas eu lieu, dites-le dans Visite médicale › Ma journée (« N'a pas eu lieu », dans les 48 h).";
}

// ─────────────────────────── L'avancement — UN seul calcul ───────────────────────────

export interface VisiteComptable {
  etat: EtatVisite;
  /** Une visite IMPRÉVUE ne descend d'aucun plan : elle compte au réalisé, jamais au prévu. */
  imprevue: boolean;
}

export interface AvancementTournee {
  /** Les visites PRÉVUES par un plan — le dénominateur de « visitées / planifiées ». */
  planifiees: number;
  /** Celles dont le rapport est fait, parmi les planifiées. */
  visitees: number;
  /** Prévues, non rapportées, fenêtre fermée. */
  perdues: number;
  /** Prévues, encore ouvertes. */
  aFaire: number;
  /** Annulées ou reportées — sorties du dénominateur, et le compte le DIT. */
  ecartees: number;
  /** Les visites IMPRÉVUES rapportées : elles gonflent « le nombre de visites », pas le taux. */
  imprevues: number;
  /** LE NOMBRE DE VISITES au sens de la Direction : tout ce qui a été réellement fait. */
  visitesTotales: number;
  /** visitées / planifiées, en pourcentage entier. 0 planifiée ⇒ 0 (jamais 100). */
  tauxRealisation: number;
}

/**
 * L'AVANCEMENT, CALCULÉ UNE FOIS POUR LES DEUX ÉCRANS.
 *
 * Quatre façons de mentir par le dénominateur ont déjà été payées ici (§118.51) ; celles qui
 * menacent ce compte-ci sont nommées :
 *  · compter une visite IMPRÉVUE au prévu ferait un taux qui dépasse 100 % et rendrait la
 *    planification illisible — elle compte au RÉALISÉ, séparément ;
 *  · garder les ANNULÉES au dénominateur punirait un KAM pour une visite que son manager a
 *    décommandée ; les retirer SANS LE DIRE ferait disparaître le fait, d'où `ecartees` ;
 *  · zéro planifiée doit rendre 0 %, jamais 100 % : « rien à faire, donc tout est fait » est le
 *    faux succès de l'arithmétique.
 */
export function avancementTournee(visites: readonly VisiteComptable[]): AvancementTournee {
  let planifiees = 0, visitees = 0, perdues = 0, aFaire = 0, ecartees = 0, imprevues = 0;
  let faitesImprevues = 0;
  for (const v of visites) {
    if (v.imprevue) {
      imprevues += 1;
      if (v.etat === "FAITE") faitesImprevues += 1;
      continue;
    }
    if (v.etat === "ANNULEE" || v.etat === "REPORTEE") { ecartees += 1; continue; }
    planifiees += 1;
    if (v.etat === "FAITE") visitees += 1;
    else if (v.etat === "PERDUE") perdues += 1;
    else aFaire += 1;
  }
  return {
    planifiees, visitees, perdues, aFaire, ecartees, imprevues,
    visitesTotales: visitees + faitesImprevues,
    tauxRealisation: planifiees > 0 ? Math.round((visitees / planifiees) * 100) : 0,
  };
}

// ─────────────────────────── Les quatre vues de l'emploi du temps ───────────────────────────

export const VUES = ["AUJOURD_HUI", "DEMAIN", "SEMAINE", "MOIS"] as const;
export type VueTournee = (typeof VUES)[number];

export const VUE_LABELS: Record<VueTournee, string> = {
  AUJOURD_HUI: "Aujourd'hui",
  DEMAIN: "Demain",
  SEMAINE: "Cette semaine",
  MOIS: "Ce mois-ci",
};

export function estVue(v: string): v is VueTournee {
  return (VUES as readonly string[]).includes(v);
}

/** La fenêtre [debut, fin] d'une vue — bornes INCLUSES, en jours locaux. */
export function fenetreDeVue(vue: VueTournee, maintenant: Date): { debut: Date; fin: Date } {
  const j = jour(maintenant);
  if (vue === "AUJOURD_HUI") return { debut: j, fin: finDeJour(j) };
  if (vue === "DEMAIN") {
    const d = new Date(j.getFullYear(), j.getMonth(), j.getDate() + 1);
    return { debut: d, fin: finDeJour(d) };
  }
  if (vue === "SEMAINE") return periodeDe("WEEK", j);
  return periodeDe("MONTH", j);
}

// ─────────────────────────── Le circuit de validation ───────────────────────────

/**
 * LES ÉTATS D'UN PLAN. `ESCALATED` existe parce que la demande le dit : « le N+1 peut demander
 * encore à SON N+1 une validation ». Ce n'est pas un `SUBMITTED` de plus — c'est le N+2 qui
 * décide, et confondre les deux ferait attendre une décision de la personne qui vient de s'en
 * dessaisir.
 */
export const STATUTS_PLAN = ["DRAFT", "SUBMITTED", "ESCALATED", "APPROVED", "REJECTED", "REVISION"] as const;
export type StatutPlan = (typeof STATUTS_PLAN)[number];

export const STATUT_PLAN_LABELS: Record<StatutPlan, string> = {
  DRAFT: "Brouillon",
  SUBMITTED: "Soumis au N+1",
  ESCALATED: "Escaladé au N+2",
  APPROVED: "Validé",
  REJECTED: "Rejeté — à corriger",
  // UN PLAN VALIDÉ ROUVERT POUR RÉVISION (§118.193 — audit 360°, R13). Ni « Brouillon » (il a été validé, et
  // son échéance de soumission d'origine est passée : il serait « en retard » de trois semaines à la seconde
  // où on le rouvre), ni « Rejeté » (personne ne l'a refusé).
  REVISION: "En révision — à resoumettre",
};

/**
 * QUI PEUT FAIRE QUOI, à cet état. Le module dit la FORME du circuit ; les DROITS restent aux
 * actions serveur, qui seules connaissent l'acteur (§118.7 : une conversation n'est pas une
 * porte dérobée, et le module pur n'a pas à connaître de session).
 */
export function gestesPossibles(statut: StatutPlan): {
  modifiable: boolean;
  soumettable: boolean;
  decidable: boolean;
  escaladable: boolean;
  revisable: boolean;
} {
  const ouvert = statut === "DRAFT" || statut === "REJECTED" || statut === "REVISION";
  return {
    // UN PLAN VALIDÉ NE SE MODIFIE PAS EN DIRECT : les visites sont parties chez le KAM, et changer sa
    // tournée sous ses pieds est exactement ce qu'un plan doit empêcher. Il se RÉVISE (§118.193) : il repasse
    // en validation, motif à l'appui, et ce qui a déjà eu lieu reste.
    modifiable: ouvert,
    soumettable: ouvert,
    revisable: statut === "APPROVED",
    decidable: statut === "SUBMITTED" || statut === "ESCALATED",
    // ON N'ESCALADE QU'UNE FOIS : un plan déjà chez le N+2 ne remonte pas au N+3 — la demande
    // nomme deux étages, et une chaîne sans fin ferait un plan que personne ne tranche.
    escaladable: statut === "SUBMITTED",
  };
}

/**
 * CE QU'UNE RÉVISION NE RETIRE PAS (§118.193). Une révision rouvre l'AVENIR d'un plan validé, pas son passé :
 * une visite dont l'heure est passée a eu lieu (elle se rapporte) ou n'a pas eu lieu (elle se dit reportée ou
 * annulée, et sort alors du dénominateur EN LE DISANT). La retirer d'un plan validé effacerait une visite
 * perdue de « visitées / planifiées » — la révision deviendrait le moyen de corriger son taux après coup.
 * Un plan jamais validé n'est pas concerné : rien de ce qu'il porte n'a encore été accordé.
 */
export function retraitInterditApresRevision(
  visite: { date: Date; status: string },
  dejaValide: boolean,
  maintenant: Date,
): boolean {
  return dejaValide && visite.status === "PLANNED" && visite.date.getTime() <= maintenant.getTime();
}

/**
 * UN PLAN À RESOUMETTRE (§118.193) : rejeté, ou validé puis rouvert pour révision. L'un et l'autre ont 48 h et se
 * disent « à resoumettre » — jamais « à soumettre », qui se lirait comme un plan jamais envoyé. Une seule lecture
 * pour l'échéance, l'en-tête du plan et la liste des plans du KAM : les deux écrans comparaient le statut à la main,
 * et tous deux avaient oublié la révision (§118.61 — `Record<StatutPlan>` nomme les tables d'étiquettes, pas les
 * comparaisons).
 */
export function aResoumettre(statut: StatutPlan): boolean {
  return statut === "REJECTED" || statut === "REVISION";
}

/**
 * QUI VOIT UN PLAN, QUI LE TRANCHE, QUI L'ESCALADE (§118.184) — une règle, lue par l'écran ET par les
 * actions. Un plan porte le panel du KAM (potentiels compris) et le motif d'un rejet : il ne s'ouvre pas
 * à quiconque a le module et connaît son identifiant. On le voit si l'on en est le KAM, le validateur,
 * le N+2 à qui il est escaladé, un manager de la chaîne du KAM, ou une vue globale.
 *
 * Deux défauts que cette règle ferme, mesurés par l'audit : l'écran ne proposait la décision que sur un
 * plan SOUMIS — le N+2 d'un plan escaladé le voyait « à décider » sans un bouton, et le plan restait
 * bloqué pour toujours ; et il proposait Valider/Rejeter à tout non-KAM, que l'action refusait ensuite.
 * Écran et action disent maintenant la même chose, parce qu'ils lisent la même fonction (§118.5).
 */
export interface FaitsAccesPlan {
  userId: string;
  vueGlobale: boolean;
  repId: string;
  reviewerId: string | null;
  escalatedToId: string | null;
  statut: StatutPlan;
  /** Les managers du KAM à l'organigramme, du N+1 vers le haut. */
  chaineDuKam: readonly string[];
  /**
   * Les absents que la personne REMPLACE aujourd'hui (§118.185 — audit 360°, I18) : le réviseur et
   * le N+2 sont des personnes nommées, et c'est précisément ce que l'intérim remplace. Obligatoire,
   * jamais un défaut : un appelant qui l'oublierait referait, sans le savoir, le plan bloqué trois
   * semaines chez l'absent (§118.127b).
   */
  agitPour: readonly string[];
}

/**
 * LA FILE « À DÉCIDER » DES PLANS — `accesAuPlan.decider` projeté en requête (lot E2 — audit 360°, M09) : le
 * réviseur tant que le plan est soumis, le N+2 dès qu'il est escaladé, pour moi ET pour les absents que je
 * remplace — jamais mon propre plan. « Mon espace » et la page du plan la lisent toutes deux : deux copies de la
 * même file finiraient par ne plus lister la même chose (§118.5). La vue globale, qui tranche partout, ne fait
 * pas une file (§118.153a) : la page l'ajoute à part.
 */
export function clausePlansADecider(moi: string, agitPour: readonly string[]) {
  const signataires = [moi, ...agitPour];
  return {
    repId: { not: moi },
    OR: [
      { status: "SUBMITTED" as const, reviewerId: { in: signataires } },
      { status: "ESCALATED" as const, escalatedToId: { in: signataires } },
    ],
  };
}

export function accesAuPlan(f: FaitsAccesPlan): { voir: boolean; decider: boolean; escalader: boolean } {
  const gestes = gestesPossibles(f.statut);
  const estLeKam = f.userId === f.repId;
  const moi = (id: string | null): boolean => Boolean(id) && (id === f.userId || f.agitPour.includes(id as string));
  // Qui tranche : le validateur tant que le plan est chez lui, le N+2 dès qu'il est escaladé — jamais
  // les deux (la dernière écriture gagnerait en silence), et jamais le KAM sur son propre plan, même
  // quand il remplace son propre réviseur.
  const decideur = f.statut === "ESCALATED" ? f.escalatedToId : f.reviewerId;
  const decider = gestes.decidable && !estLeKam && (moi(decideur) || f.vueGlobale);
  const escalader = gestes.escaladable && !estLeKam && (moi(f.reviewerId) || f.vueGlobale);
  const voir = estLeKam || f.vueGlobale
    || moi(f.reviewerId) || moi(f.escalatedToId)
    || f.chaineDuKam.includes(f.userId);
  return { voir, decider, escalader };
}

const MS_JOUR = 86_400_000;

/** Ce qu'un écran dit d'un retard de soumission — l'échéance retenue, et les jours. */
export interface RetardDeSoumission {
  /** L'échéance qui compte : celle de la RESOUMISSION sur un plan rejeté, celle de la soumission sinon. */
  echeance: Date;
  /** Vrai quand le plan est ENCORE à soumettre et que son échéance est passée. */
  enRetard: boolean;
  /** Jours entiers de retard (une heure de retard compte pour un jour) — 0 quand il n'y en a pas. */
  jours: number;
}

/**
 * LE RETARD DE SOUMISSION — et ce qu'il ne compte JAMAIS.
 *
 * `enRetardDeSoumission` existait, testée, documentée, et n'avait AUCUN appelant de production
 * (§118.14, §118.49) : l'échéance était stockée, affichée « à soumettre avant le … » avant comme
 * après son passage, et ni le KAM, ni son N+1, ni la Direction ne voyaient un retard. Une
 * échéance que rien ne lit n'est pas une échéance, c'est une date décorative.
 *
 * Trois règles, et la seconde est la moitié qui compte :
 *  · Seul un plan OUVERT (brouillon ou rejeté) peut être en retard, jugé sur `maintenant`.
 *  · Un plan SOUMIS ne l'est jamais : le temps que met son manager à décider n'est pas un retard
 *    du KAM, et le juger sur la seule date punirait la lenteur de la décision (le test le nomme).
 *    Un plan resoumis après un rejet efface sa décision précédente — juger la soumission après
 *    coup contre l'échéance d'origine reprocherait au KAM un retard qu'il n'a pas commis.
 *  · Sur un plan REJETÉ, l'échéance qui compte est celle de la RESOUMISSION (48 h après le
 *    rejet) : la première est presque toujours passée au moment du rejet, et la retenir
 *    afficherait « en retard de 20 jours » à un KAM qui vient de recevoir ses corrections.
 *
 * Un plan qui N'EXISTE PAS se juge comme un brouillon : c'est ainsi que la Direction voit un KAM
 * qui n'a rien ouvert alors que l'échéance de la période est passée.
 */
export function retardDeSoumission(input: {
  statut: StatutPlan;
  echeance: Date;
  /** L'échéance de resoumission d'un plan rejeté — `null` tant qu'aucun rejet ne l'a posée. */
  resoumissionAvant?: Date | null;
  maintenant: Date;
}): RetardDeSoumission {
  // Un plan REJETÉ ou EN RÉVISION se juge sur sa RESOUMISSION : l'échéance d'origine est passée depuis
  // longtemps quand on rouvre un plan validé, et la retenir afficherait « en retard de 20 jours » à la
  // seconde même de la réouverture (§118.193).
  const resoumission = aResoumettre(input.statut);
  const echeance = resoumission && input.resoumissionAvant ? input.resoumissionAvant : input.echeance;
  const ouvert = input.statut === "DRAFT" || resoumission;
  const ecart = ouvert ? input.maintenant.getTime() - echeance.getTime() : 0;
  return { echeance, enRetard: ecart > 0, jours: ecart > 0 ? Math.ceil(ecart / MS_JOUR) : 0 };
}

/** Le plan est-il en retard sur son échéance de soumission ? (raccourci de `retardDeSoumission`) */
export function enRetardDeSoumission(input: {
  statut: StatutPlan;
  echeance: Date;
  resoumissionAvant?: Date | null;
  maintenant: Date;
}): boolean {
  return retardDeSoumission(input).enRetard;
}

/**
 * CE QUI MANQUE POUR SOUMETTRE — dit avant le clic, en une fois.
 *
 * Un refus par champ ferait ressaisir un plan de quarante visites autant de fois qu'il a de
 * défauts (§118.18). La liste vide vaut « soumettable ».
 */
export function bloquantsDeSoumission(input: {
  statut: StatutPlan;
  nbVisites: number;
  /** Des visites posées un jour de week-end : personne ne sort ce jour-là. */
  nbHorsJoursOuvres: number;
  /** Des visites posées hors de la période du plan. */
  nbHorsPeriode: number;
}): string[] {
  const out: string[] = [];
  if (!gestesPossibles(input.statut).soumettable) {
    out.push(`Un plan « ${STATUT_PLAN_LABELS[input.statut]} » ne se soumet pas.`);
  }
  if (input.nbVisites === 0) {
    out.push("Aucune visite planifiée : un plan vide ne dit pas où le KAM sera, et son N+1 n'aurait rien à valider.");
  }
  if (input.nbHorsJoursOuvres > 0) {
    out.push(`${input.nbHorsJoursOuvres} visite(s) tombent un vendredi ou un samedi — la semaine ouvrée va du dimanche au jeudi.`);
  }
  if (input.nbHorsPeriode > 0) {
    out.push(`${input.nbHorsPeriode} visite(s) sont hors de la période du plan.`);
  }
  return out;
}

// ─────────────────────────── Qui valide — la cascade, écrite UNE fois ───────────────────────────

/** D'où vient le validateur d'un plan. */
export type SourceReviseur = "BU_SUPERVISEUR" | "N_PLUS_UN_RH";

/**
 * QUI DOIT TRANCHER LE PLAN D'UN KAM.
 *
 * La demande dit « le N+1 valide » — et un KAM a DEUX hiérarchies dans cet ERP : le SUPERVISEUR
 * de sa BU (`BusinessUnit.supervisorId`, celui à qui remontent déjà ses alertes terrain et qui a
 * le droit d'éditer ses affectations) et son N+1 d'ORGANIGRAMME (`hr/reporting-line.ts`).
 *
 * L'ordre n'est pas arbitraire : un plan de tournée est un acte COMMERCIAL, et la personne qui
 * peut juger « ces quarante visites sont-elles les bonnes » est celle qui pilote le terrain de
 * cette gamme. L'organigramme prend le relais quand aucun superviseur n'est désigné — sans ce
 * repli, un plan resterait sans validateur et le KAM ne pourrait jamais sortir de brouillon,
 * sans qu'une ligne l'explique.
 *
 * ON NE SE VALIDE JAMAIS SOI-MÊME : un KAM qui serait le superviseur de sa propre BU tombe sur
 * le repli. Rendre `null` plutôt que lui-même est ce qui fait dire « personne ne peut valider »
 * au lieu de laisser une auto-approbation silencieuse.
 */
export function reviseurDuPlan(input: {
  repId: string;
  superviseurBuId: string | null;
  managerRhId: string | null;
}): { id: string; source: SourceReviseur } | null {
  if (input.superviseurBuId && input.superviseurBuId !== input.repId) {
    return { id: input.superviseurBuId, source: "BU_SUPERVISEUR" };
  }
  if (input.managerRhId && input.managerRhId !== input.repId) {
    return { id: input.managerRhId, source: "N_PLUS_UN_RH" };
  }
  return null;
}

/**
 * À QUI LE N+1 PEUT ESCALADER — son propre N+1, et personne d'autre.
 *
 * Deux exclusions, chacune pour une raison nommable : le KAM lui-même (il ne valide pas son plan
 * en remontant d'un étage), et le réviseur lui-même (une escalade vers soi n'est pas une
 * escalade, c'est un plan qui n'avance plus).
 */
export function escaladeDuPlan(input: {
  repId: string;
  reviseurId: string;
  managerDuReviseurId: string | null;
}): string | null {
  const m = input.managerDuReviseurId;
  if (!m || m === input.repId || m === input.reviseurId) return null;
  return m;
}

// ─────────────────────────── Qui écrit les messages pré-définis ───────────────────────────

/**
 * QUI PEUT ÉCRIRE LES MESSAGES DE LA DIRECTION MARKETING.
 *
 * PAS un droit de module, et c'est une décision mesurée : `PRODUCT_MANAGER` (Direction
 * Marketing) n'a que `MEDICAL: READ`, et lui donner l'écriture du module lui ouvrirait aussi les
 * praticiens et les visites — une empreinte réelle bien plus large que la demande (§118.16).
 * C'est donc une LISTE DE RÔLES que le Super Admin pose, comme le dépôt le fait déjà pour la
 * supervision Regulatory et l'onglet Overview des rapports terrain : la décision de permission
 * reste à qui elle appartient (§118.86).
 *
 * Le rôle SECONDAIRE compte : quelqu'un qui porte Direction Marketing en second doit pouvoir
 * écrire ces messages, sinon la personne réellement chargée du sujet se fait refuser.
 */
export function peutEcrireMessagesPromo(
  user: { role: string; secondaryRole?: string | null },
  rolesAutorises: readonly string[],
): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  return rolesAutorises.includes(user.role) || rolesAutorises.includes(user.secondaryRole ?? "");
}
