/**
 * LES ALERTES DE SUPERVISION — ce qui doit REMONTER au superviseur sans qu'il aille le chercher.
 *
 * ── POURQUOI DES ALERTES PLUTÔT QU'UN TABLEAU ───────────────────────────────────────────────
 *
 * Le cockpit existe et il est juste. Mais un tableau ne prévient personne : il faut penser à
 * l'ouvrir, et on l'ouvre après coup — quand le mois est perdu. Un superviseur national qui
 * porte trois équipes n'a pas le temps de scruter quinze lignes chaque matin ; il a besoin
 * qu'on lui dise les DEUX qui vont mal, pendant qu'on peut encore agir.
 *
 * ── LES QUATRE RÈGLES, ET LEUR MOMENT ───────────────────────────────────────────────────────
 *
 *  1. **SILENCE** — aucune visite saisie depuis N jours ouvrés alors que le KAM a un panel.
 *     C'est la seule alerte QUOTIDIENNE : elle ne dit pas « il ne travaille pas », elle dit
 *     « on ne sait pas ce qu'il fait », ce qui est un problème d'outil autant que d'homme.
 *  2. **RETARD À MI-MOIS** — réalisation sous un seuil au 15. Le 15 est le dernier moment où
 *     l'on peut encore rattraper ; au 28, l'alerte n'est plus qu'un constat.
 *  3. **COUVERTURE** — en fin de mois, une part du panel jamais vue. Un KAM peut faire son
 *     compte de visites en tournant sur dix praticiens : le volume est bon, le panel est mort.
 *  4. **NON ARMÉ** — un KAM sans panel, ou dont la segmentation ne demande aucune visite (requis
 *     nul), ne PEUT pas travailler. Celle-là ne vise pas le KAM : elle vise celui qui configure.
 *
 * LA RÉFÉRENCE EST UNE (Direction) : le REQUIS de la segmentation (lettre × fréquence du secteur,
 * `segmentation/lettre-requise.ts`). Les visites planifiées par les affectations ne jugent plus
 * personne : elles s'affichent en information à côté du requis.
 *
 * ── CE QUE CES RÈGLES NE FONT PAS ───────────────────────────────────────────────────────────
 *
 * Elles ne notent personne et ne déclenchent aucune sanction : elles ouvrent une conversation.
 * Une alerte de silence sur un homme en congé est un faux positif normal — c'est pourquoi la
 * phrase dit le FAIT observé (« aucune visite saisie depuis 6 jours »), jamais l'interprétation
 * (« KAM inactif »). Un outil qui accuse se fait contourner ; un outil qui informe se consulte.
 *
 * Module PUR : ni base, ni notification. Testé.
 */

export type FieldAlertKind = "SILENCE" | "RETARD" | "COUVERTURE" | "NON_ARME";
export type FieldAlertSeverity = "info" | "warning" | "danger";

export interface FieldAlert {
  kind: FieldAlertKind;
  repId: string;
  repName: string;
  severity: FieldAlertSeverity;
  /** Le titre de la notification — court, il passe en écran verrouillé. */
  title: string;
  /** Le FAIT observé, chiffré. Jamais une interprétation. */
  body: string;
  /** Clé d'anti-spam : la même alerte ne repart pas dans le même cycle (`type:AAAA-MM`). */
  key: string;
  /** À qui elle s'adresse : le superviseur du KAM, ou celui qui configure. */
  audience: "supervisor" | "configurator";
}

/** L'état d'un KAM tel que le cockpit le calcule — l'entrée unique de ces règles. */
export interface RepSnapshot {
  repId: string;
  repName: string;
  panelSize: number;
  /** Visites planifiées par les affectations du cycle — INFORMATION SECONDAIRE, jamais le critère. */
  plannedVisits: number;
  /** LE REQUIS de la segmentation (une seule référence : lettre × fréquence du secteur) — le critère de toute alerte. */
  requiredVisits: number;
  realVisits: number;
  coveredDoctors: number;
  /** Dernière visite SAISIE (toute date de visite confondue) — la trace d'activité. */
  lastVisitLoggedAt: Date | null;
}

export interface AlertThresholds {
  /** Jours sans saisie au-delà desquels le silence se signale. */
  silenceDays: number;
  /** Jour du mois à partir duquel le retard se juge. */
  midMonthDay: number;
  /** Réalisation (%) sous laquelle on alerte à mi-mois. */
  midMonthPct: number;
  /** Jour du mois à partir duquel la couverture se juge. */
  lateMonthDay: number;
  /** Couverture (%) sous laquelle on alerte en fin de mois. */
  coveragePct: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  silenceDays: 5,
  midMonthDay: 15,
  midMonthPct: 40,
  lateMonthDay: 25,
  coveragePct: 50,
};

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);

/** Clé de cycle d'une alerte : une par type et par mois. */
export function alertKey(kind: FieldAlertKind, today: Date): string {
  return `${kind}:${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * LE VERROU ANTI-SPAM D'UN KAM — TOUTES les alertes déjà parties ce mois, pas la dernière seule (recette, 21/11/2026).
 *
 * Le verrou (`SalesRepProfile.lastAlertKey`) ne gardait qu'UNE clé. Un KAM sous deux alertes à la fois (silence ET retard
 * à mi-mois) les voyait s'effacer l'une l'autre : chaque passage trouvait la clé de l'AUTRE, renvoyait les deux et
 * réécrivait le verrou. Le balayage tournant chaque minute, son superviseur en recevait six par minute — 165 987
 * notifications depuis le 6 octobre. Le verrou porte désormais les clés du mois, séparées par « | » ; celles d'un mois
 * passé tombent au premier envoi du nouveau mois.
 */
export function alerteDejaEnvoyee(verrou: string | null | undefined, cle: string): boolean {
  return (verrou ?? "").split("|").includes(cle);
}

/** Le verrou après l'envoi de `cle` : les clés du même mois restent, celles d'avant tombent. */
export function verrouApresEnvoi(verrou: string | null | undefined, cle: string): string {
  const mois = cle.slice(cle.indexOf(":") + 1);
  const gardees = (verrou ?? "").split("|").filter((k) => k && k !== cle && k.slice(k.indexOf(":") + 1) === mois);
  return [...gardees, cle].join("|");
}

/**
 * Les alertes d'UN KAM à une date donnée. Au plus une par type : deux alertes qui disent la
 * même chose sous deux angles font couper les notifications, et c'est la troisième — la vraie
 * — qu'on rate ensuite.
 */
export function alertsForRep(
  rep: RepSnapshot,
  today: Date,
  th: AlertThresholds = DEFAULT_THRESHOLDS,
): FieldAlert[] {
  const out: FieldAlert[] = [];
  const day = today.getDate();

  // 4. NON ARMÉ — la configuration d'abord : tant qu'elle manque, les autres alertes
  //    accuseraient un homme d'un défaut d'outil. Le critère est LE REQUIS de la segmentation (Direction : une seule
  //    référence) ; les visites planifiées par les affectations n'en sont qu'une information.
  if (rep.panelSize === 0 || rep.requiredVisits === 0) {
    const quoi = rep.panelSize === 0 && rep.requiredVisits === 0 ? "ni panel ni requis de segmentation"
      : rep.panelSize === 0 ? "aucun praticien dans son panel"
        : "aucune visite requise par la segmentation pour son panel (lettres ou fréquence du secteur à renseigner)";
    return [{
      kind: "NON_ARME", repId: rep.repId, repName: rep.repName, severity: "warning",
      title: `${rep.repName} n'est pas armé pour ce cycle`,
      body: `${rep.repName} a ${quoi}. Sans cela, ni sa tournée ni son suivi ne peuvent fonctionner.`,
      key: alertKey("NON_ARME", today), audience: "configurator",
    }];
  }

  // 1. SILENCE — la seule quotidienne. « On ne sait pas », pas « il ne fait rien ».
  const since = rep.lastVisitLoggedAt
    ? Math.floor((today.getTime() - rep.lastVisitLoggedAt.getTime()) / 86_400_000)
    : null;
  if (since === null || since >= th.silenceDays) {
    out.push({
      kind: "SILENCE", repId: rep.repId, repName: rep.repName,
      severity: since !== null && since >= th.silenceDays * 2 ? "danger" : "warning",
      title: `${rep.repName} — aucune visite saisie`,
      body: since === null
        ? `Aucune visite n'a jamais été saisie par ${rep.repName}. Son activité n'est donc pas mesurable.`
        : `Dernière visite saisie il y a ${since} jours par ${rep.repName}.`,
      key: alertKey("SILENCE", today), audience: "supervisor",
    });
  }

  // 2. RETARD À MI-MOIS — pendant qu'on peut encore rattraper.
  //    La cible est LE REQUIS (segmentation) ; le planifié ne s'ajoute qu'en information.
  const cible = rep.requiredVisits;
  const realPct = pct(rep.realVisits, cible);
  if (day >= th.midMonthDay && day < th.lateMonthDay && cible > 0 && realPct < th.midMonthPct) {
    out.push({
      kind: "RETARD", repId: rep.repId, repName: rep.repName, severity: "warning",
      title: `${rep.repName} — ${realPct} % du requis à mi-mois`,
      body: `${rep.realVisits} visites sur ${cible} requises par la segmentation, au ${day} du mois.`
        + (rep.plannedVisits > 0 ? ` (${rep.plannedVisits} planifiées par les affectations.)` : ""),
      key: alertKey("RETARD", today), audience: "supervisor",
    });
  }

  // 3. COUVERTURE — le volume peut être bon alors que le panel est mort.
  const covPct = pct(rep.coveredDoctors, rep.panelSize);
  if (day >= th.lateMonthDay && covPct < th.coveragePct) {
    out.push({
      kind: "COUVERTURE", repId: rep.repId, repName: rep.repName, severity: "warning",
      title: `${rep.repName} — panel couvert à ${covPct} %`,
      body: `${rep.coveredDoctors} praticiens vus sur ${rep.panelSize} au panel (${rep.realVisits} visites au total).`,
      key: alertKey("COUVERTURE", today), audience: "supervisor",
    });
  }

  return out;
}

/** Les alertes de tout un périmètre, les plus graves d'abord. */
export function fieldAlerts(
  reps: readonly RepSnapshot[],
  today: Date,
  th: AlertThresholds = DEFAULT_THRESHOLDS,
): FieldAlert[] {
  const rang: Record<FieldAlertSeverity, number> = { danger: 0, warning: 1, info: 2 };
  return reps
    .flatMap((r) => alertsForRep(r, today, th))
    .sort((a, b) => rang[a.severity] - rang[b.severity] || a.repName.localeCompare(b.repName, "fr"));
}

/**
 * LA REVUE MENSUELLE, en une phrase par équipe — ce qui part au superviseur le 1er.
 *
 * Une revue qui demande d'ouvrir un tableau n'est pas une revue : le chiffre doit tenir dans
 * la notification elle-même, le lien ne servant qu'à creuser.
 */
export function monthlyReviewLine(reps: readonly RepSnapshot[]): string {
  if (reps.length === 0) return "Aucun KAM dans votre périmètre.";
  const visites = reps.reduce((s, r) => s + r.realVisits, 0);
  const cible = reps.reduce((s, r) => s + r.requiredVisits, 0);
  const panel = reps.reduce((s, r) => s + r.panelSize, 0);
  const couverts = reps.reduce((s, r) => s + r.coveredDoctors, 0);
  const faibles = reps.filter((r) => pct(r.realVisits, r.requiredVisits) < 60).length;
  return `${visites} visites réalisées sur ${cible} requises (${pct(visites, cible)} %) · panel couvert à ${pct(couverts, panel)} %`
    + (faibles > 0 ? ` · ${faibles} KAM sous 60 %` : " · aucun KAM sous 60 %");
}
