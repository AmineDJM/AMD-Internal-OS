/**
 * QUELQUES INDICATEURS, SELON LE MÉTIER — ce qu'un encadrant peut légitimement voir de quelqu'un.
 *
 * ── POURQUOI « SELON LE MÉTIER » ────────────────────────────────────────────────────────────
 *
 * Un jeu d'indicateurs unique pour tout le monde produit trois zéros et une colonne vide : le
 * nombre de visites médicales d'un comptable, le nombre de dossiers réglementaires d'un coursier.
 * Des zéros qui ne veulent rien dire abîment ceux qui veulent dire quelque chose — on cesse de
 * les lire. Chaque métier a donc SES compteurs, et un métier sans compteur propre le DIT au lieu
 * d'afficher du vide.
 *
 * ── ET POURQUOI CERTAINS SONT COMMUNS ───────────────────────────────────────────────────────
 *
 * Trois questions se posent pour n'importe qui, quel que soit le poste : qu'a-t-il en cours, que
 * doit-il à quelqu'un, et est-il là. Elles ne dépendent pas du métier parce qu'elles ne parlent
 * pas du métier — elles parlent de la charge et de la disponibilité, qui sont l'affaire de
 * l'encadrant par définition.
 *
 * ── CE QUE CE MODULE N'OUVRE PAS ────────────────────────────────────────────────────────────
 *
 * Ni salaire, ni évaluation, ni dossier. « Mon Équipe » n'est pas un mini-module RH et ne le
 * devient pas parce qu'on y ajoute des chiffres : ce sont des compteurs d'ACTIVITÉ, lisibles
 * dans les écrans métier par quiconque a le module. On ne fait que les rassembler par personne.
 *
 * Module PUR : la CARTE des métiers et la mise en forme. Les comptes viennent de la base, par
 * `src/lib/queries/team-kpis.ts`.
 */

export type TeamKpiTone = "default" | "info" | "warning" | "danger" | "success";

/**
 * LA CLÉ D'UN CHIFFRE — un lien s'y accroche, jamais au libellé : le libellé est une phrase
 * d'écran, qu'on reformule sans prévenir personne (§118.196, lot E3).
 */
export type CleKpi =
  | "openTasks" | "openRequests" | "leaveDaysThisYear"
  | "visitsDone30" | "visitsPlanned" | "doctors" | "visitsWithoutReport"
  | "dossiers" | "overdue" | "stepsInProgress"
  | "awaiting" | "docsRequested" | "validated30"
  | "runsDone30" | "runsLate30" | "runsOpen";

export interface TeamKpi {
  cle: CleKpi;
  label: string;
  /** Déjà mis en forme : « 12 », « 8 j », « 3 / 14 ». La page n'a rien à calculer. */
  value: string;
  hint?: string;
  tone?: TeamKpiTone;
  /**
   * L'ÉCRAN QUI MONTRE CE QUE CE CHIFFRE COMPTE, pour CETTE personne (audit 360°, M12) — posé par
   * le serveur, et seulement si la garde de cet écran laisse entrer celui qui regarde. Absent :
   * aucun écran ne le détaille pour lui, et le chiffre ne promet pas de geste qu'il n'a pas.
   */
  href?: string;
}

/** Les liens d'une carte, par clé — calculés côté serveur (`queries/team-kpis.ts`). */
export type LiensKpi = Partial<Record<CleKpi, string>>;

/** Accroche à chaque chiffre l'écran qui le détaille, quand il en existe un ouvert à ce lecteur. */
export function avecLiens(kpis: readonly TeamKpi[], liens: LiensKpi): TeamKpi[] {
  return kpis.map((k) => {
    const href = liens[k.cle];
    return href ? { ...k, href } : k;
  });
}

/**
 * LE MÉTIER RETENU pour les indicateurs — le RÔLE APPLICATIF, pas l'intitulé de poste.
 *
 * « Chargé de la promotion Ouest » ne dit rien à un programme ; `MEDICAL_DELEGATE` dit exactement
 * quelles données existent pour cette personne. Router sur l'intitulé obligerait à deviner, et
 * une faute de frappe dans une fiche RH ferait disparaître les indicateurs sans un mot.
 */
export type TeamJob = "FIELD" | "REGULATORY" | "MEDICAL_INFO" | "COORDINATION" | "GENERIC";

export function jobOf(role: string | null | undefined): TeamJob {
  switch (role) {
    case "MEDICAL_DELEGATE":
    case "NATIONAL_SALES":
    case "MEDICAL_PROMOTION_MANAGER":
      return "FIELD";
    case "HEAD_OF_REGULATORY":
    case "REGULATORY_ASSISTANT":
      return "REGULATORY";
    case "MEDICAL_INFO_PHARMACIST":
      return "MEDICAL_INFO";
    case "COORDINATOR":
      return "COORDINATION";
    default:
      return "GENERIC";
  }
}

export const JOB_LABEL: Record<TeamJob, string> = {
  FIELD: "Terrain — promotion médicale",
  REGULATORY: "Affaires réglementaires",
  MEDICAL_INFO: "Information médicale",
  COORDINATION: "Coordination — courses et livraisons",
  GENERIC: "Charge de travail",
};

/**
 * Ce qu'on affiche quand le métier n'a pas de compteur propre — dit, pas laissé en blanc.
 *
 * La phrase disait « ce métier n'a pas d'indicateur d'activité propre DANS L'OUTIL » : faux pour
 * les Finances (paiements, bons de commande), le Marketing (Ad & Pro), l'Assistante de direction
 * (secrétariat) — l'outil les porte ; c'est CET ÉCRAN qui ne les suit pas encore (audit 360°,
 * M11). Une phrase fausse se corrige, même quand le chiffre qu'elle excuse reste à écrire.
 */
export const NO_JOB_KPI_NOTE =
  "Cet écran ne suit pas encore d'indicateur propre à ce métier : seules la charge de travail et la disponibilité y figurent.";

// ─────────────────────────────── Les comptes bruts, par métier ───────────────────────────────

/** Ce que TOUT LE MONDE porte, quel que soit le poste. */
export interface CommonCounts {
  openTasks: number;
  overdueTasks: number;
  /** Jours de congé APPROUVÉS sur l'année civile en cours. */
  leaveDaysThisYear: number;
  /** Ses demandes en cours d'instruction (congé, achat, formation), toutes marches confondues. */
  openRequests: number;
}

export interface FieldCounts {
  /** Visites réalisées sur les 30 derniers jours. */
  visitsDone30: number;
  /** Visites planifiées encore à venir. */
  visitsPlanned: number;
  /** Médecins de son portefeuille. */
  doctors: number;
  /** Visites réalisées SANS compte rendu — le travail fait dont il ne reste rien. */
  visitsWithoutReport: number;
}

export interface RegulatoryCounts {
  /** Dossiers dont il est responsable ou assistant. */
  dossiers: number;
  /** Dossiers dont la date cible est dépassée. */
  overdue: number;
  /** Étapes en cours sur ses dossiers. */
  stepsInProgress: number;
}

export interface MedicalInfoCounts {
  /** Déclarations qui lui sont assignées et qu'il n'a pas encore validées. */
  awaiting: number;
  /** Parmi elles, celles en attente de pièces. */
  docsRequested: number;
  /** Déclarations validées par lui sur les 30 derniers jours. */
  validated30: number;
}

export interface CoordinationCounts {
  /** Courses terminées sur les 30 derniers jours. */
  runsDone30: number;
  /** Parmi elles, celles qui ont dépassé la durée annoncée. */
  runsLate30: number;
  /** Courses encore à faire. */
  runsOpen: number;
}

export type JobCounts =
  | { job: "FIELD"; counts: FieldCounts }
  | { job: "REGULATORY"; counts: RegulatoryCounts }
  | { job: "MEDICAL_INFO"; counts: MedicalInfoCounts }
  | { job: "COORDINATION"; counts: CoordinationCounts }
  | { job: "GENERIC" };

// ─────────────────────────────────── La mise en forme ────────────────────────────────────────

const jours = (n: number) => `${n} j`;

export function commonKpis(c: CommonCounts): TeamKpi[] {
  return [
    {
      cle: "openTasks",
      label: "Tâches ouvertes",
      value: String(c.openTasks),
      // LE RETARD SE DIT AVEC LE NOMBRE, pas à côté : « 12 tâches » rassure, « 12 dont 5 en
      // retard » appelle une conversation. C'est cette conversation-là qu'on veut provoquer.
      hint: c.overdueTasks > 0 ? `dont ${c.overdueTasks} en retard` : undefined,
      tone: c.overdueTasks > 0 ? "warning" : "default",
    },
    {
      cle: "openRequests",
      label: "Demandes en cours",
      value: String(c.openRequests),
      hint: c.openRequests > 0 ? "congé, achat ou formation en instruction" : undefined,
      tone: c.openRequests > 0 ? "info" : "default",
    },
    { cle: "leaveDaysThisYear", label: "Congés pris cette année", value: jours(c.leaveDaysThisYear) },
  ];
}

export function jobKpis(j: JobCounts): TeamKpi[] {
  switch (j.job) {
    case "FIELD": {
      const c = j.counts;
      return [
        { cle: "visitsDone30", label: "Visites réalisées", value: String(c.visitsDone30), hint: "30 derniers jours", tone: c.visitsDone30 > 0 ? "success" : "default" },
        { cle: "visitsPlanned", label: "Visites planifiées", value: String(c.visitsPlanned), hint: "à venir" },
        { cle: "doctors", label: "Médecins au portefeuille", value: String(c.doctors) },
        {
          cle: "visitsWithoutReport",
          label: "Comptes rendus manquants",
          value: String(c.visitsWithoutReport),
          // Une visite sans compte rendu, c'est une visite qui n'a pas eu lieu pour tous ceux
          // qui liront le dossier ensuite. C'est le seul de ces quatre chiffres qui appelle
          // une action, d'où le ton.
          hint: c.visitsWithoutReport > 0 ? "visites faites, rien d'écrit" : undefined,
          tone: c.visitsWithoutReport > 0 ? "warning" : "success",
        },
      ];
    }
    case "REGULATORY": {
      const c = j.counts;
      return [
        { cle: "dossiers", label: "Dossiers portés", value: String(c.dossiers), hint: "responsable ou assistant·e" },
        { cle: "overdue", label: "Dossiers en retard", value: String(c.overdue), hint: c.overdue > 0 ? "date cible dépassée" : undefined, tone: c.overdue > 0 ? "danger" : "success" },
        { cle: "stepsInProgress", label: "Étapes en cours", value: String(c.stepsInProgress) },
      ];
    }
    case "MEDICAL_INFO": {
      const c = j.counts;
      return [
        { cle: "awaiting", label: "Dossiers à instruire", value: String(c.awaiting), tone: c.awaiting > 0 ? "warning" : "success" },
        { cle: "docsRequested", label: "En attente de pièces", value: String(c.docsRequested), hint: c.docsRequested > 0 ? "la balle est chez le demandeur" : undefined, tone: c.docsRequested > 0 ? "info" : "default" },
        { cle: "validated30", label: "Validés", value: String(c.validated30), hint: "30 derniers jours", tone: c.validated30 > 0 ? "success" : "default" },
      ];
    }
    case "COORDINATION": {
      const c = j.counts;
      return [
        { cle: "runsDone30", label: "Courses terminées", value: String(c.runsDone30), hint: "30 derniers jours", tone: c.runsDone30 > 0 ? "success" : "default" },
        {
          cle: "runsLate30",
          label: "Hors délai",
          // UN TAUX SANS SON DÉNOMINATEUR MENT : « 33 % de retard » sur trois courses n'est pas
          // « 33 % » sur trente. On affiche donc la fraction telle qu'elle est.
          value: `${c.runsLate30} / ${c.runsDone30}`,
          hint: c.runsDone30 === 0 ? "aucune course sur la période" : "durée dépassée",
          tone: c.runsLate30 > 0 ? "warning" : "success",
        },
        { cle: "runsOpen", label: "Courses à faire", value: String(c.runsOpen), tone: c.runsOpen > 0 ? "info" : "default" },
      ];
    }
    case "GENERIC":
      return [];
  }
}
