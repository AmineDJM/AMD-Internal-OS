import { algiersYmd } from "@/lib/calendar-tz";

/**
 * ═════════════════════════════════════════════════════════════════
 * LES ABSENCES D'UNE ÉQUIPE, AU JOUR (§118.196, lot E3 — audit 360°, M19 et M21). Module PUR.
 *
 * ── UN CONGÉ EST FAIT DE JOURS, PAS D'INSTANTS (M21) ────────────────────────────────────────
 *
 * La saisie d'un congé (`<input type="date">` → `fdDate`) enregistre « 2026-10-04 » à MINUIT UTC.
 * Mon Équipe comparait cet instant à « maintenant » : à 08:00 à Alger (07:00 UTC), la fin d'un
 * congé posée au 4 était déjà « passée », et la personne redevenait présente le matin de son
 * dernier jour d'absence. Le dernier jour se vit EN ENTIER. On compare donc des JOURS : celui du
 * congé se lit en UTC — c'est ainsi qu'il a été écrit —, et « aujourd'hui » se lit à ALGER, là où
 * l'équipe travaille (entre 23:00 et minuit UTC, il y est déjà demain).
 *
 * ── DEUX ABSENCES NE SE CHEVAUCHENT QUE DANS UNE MÊME ÉQUIPE (M19) ──────────────────────────
 *
 * Le groupe est le N+1 dans l'arbre de l'encadrant : deux personnes qui dépendent du même chef.
 * Deux absences dans deux équipes différentes ne privent aucune équipe de deux personnes à la
 * fois ; les signaler ferait du bruit, et une alerte permanente n'alerte plus (§118.32). Une
 * personne ne se chevauche jamais elle-même — un congé accordé et sa prolongation en attente
 * comptent une fois. Le TYPE d'absence n'entre pas ici : un encadrant a besoin de savoir qui
 * manque, pas pourquoi (§118.184).
 * ═════════════════════════════════════════════════════════════════
 */

/** « AAAA-MM-JJ » d'une date de congé — lue en UTC, comme elle a été écrite (minuit UTC). */
export function jourDuConge(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Aujourd'hui à Alger, « AAAA-MM-JJ ». */
export function aujourdhuiAlger(maintenant: Date): string {
  return algiersYmd(maintenant);
}

/** Minuit UTC du jour `jour` — la borne de requête qui correspond à `jourDuConge`. */
export function minuitUtc(jour: string): Date {
  const [a, m, j] = jour.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j));
}

/** Le jour `n` jours après `jour`. */
export function plusJours(jour: string, n: number): string {
  const d = minuitUtc(jour);
  d.setUTCDate(d.getUTCDate() + n);
  return jourDuConge(d);
}

export interface PeriodeAbsence {
  /** Premier jour d'absence, inclus. */
  debut: string;
  /** Dernier jour d'absence, INCLUS — il se vit en entier. */
  fin: string;
}

/** La période couvre-t-elle ce jour ? Les deux bornes sont des jours d'absence. */
export function couvreLeJour(p: PeriodeAbsence, jour: string): boolean {
  return p.debut <= jour && jour <= p.fin;
}

/** Deux périodes ont-elles au moins un jour commun ? */
export function seChevauchent(a: PeriodeAbsence, b: PeriodeAbsence): boolean {
  return a.debut <= b.fin && b.debut <= a.fin;
}

export interface AbsenceDEquipe extends PeriodeAbsence {
  leaveId: string;
  employeeId: string;
  nom: string;
  /** Encore en instruction — elle compte : c'est souvent elle qu'on s'apprête à trancher. */
  enAttente: boolean;
  /** Le N+1 dans l'arbre de l'encadrant ; `null` : c'est l'encadrant lui-même (ses N-1). */
  groupe: string | null;
}

/** Les absences d'AUTRES personnes du MÊME groupe qui partagent au moins un jour avec `cible`. */
export function chevauchementsDe(cible: AbsenceDEquipe, toutes: readonly AbsenceDEquipe[]): AbsenceDEquipe[] {
  return toutes
    .filter((a) => a.employeeId !== cible.employeeId && a.groupe === cible.groupe && seChevauchent(a, cible))
    .sort((x, y) => x.debut.localeCompare(y.debut) || x.nom.localeCompare(y.nom));
}

export interface AbsentDuJour {
  employeeId: string;
  nom: string;
  /** Vrai seulement si AUCUNE de ses absences de ce jour n'est accordée. */
  enAttente: boolean;
}

export interface PeriodeCommune extends PeriodeAbsence {
  groupe: string | null;
  personnes: AbsentDuJour[];
}

/**
 * Les jours de `[du, du + jours[` où DEUX personnes au moins d'un même groupe sont absentes,
 * regroupés en périodes : une période s'arrête dès que la liste des absents — ou le statut de
 * l'un d'eux — change. Une personne compte une fois par jour, même quand deux de ses demandes
 * se recouvrent.
 */
export function periodesCommunes(toutes: readonly AbsenceDEquipe[], du: string, jours: number): PeriodeCommune[] {
  const parGroupe = new Map<string, AbsenceDEquipe[]>();
  for (const a of toutes) {
    const cle = a.groupe ?? "";
    const liste = parGroupe.get(cle);
    if (liste) liste.push(a);
    else parGroupe.set(cle, [a]);
  }
  const out: PeriodeCommune[] = [];
  for (const liste of parGroupe.values()) {
    let courante: PeriodeCommune | null = null;
    let signatureCourante = "";
    for (let i = 0; i < jours; i++) {
      const jour = plusJours(du, i);
      const absents = new Map<string, AbsentDuJour>();
      for (const a of liste) {
        if (!couvreLeJour(a, jour)) continue;
        const deja = absents.get(a.employeeId);
        absents.set(a.employeeId, {
          employeeId: a.employeeId,
          nom: a.nom,
          enAttente: deja ? deja.enAttente && a.enAttente : a.enAttente,
        });
      }
      const personnes = [...absents.values()]
        .sort((x, y) => x.nom.localeCompare(y.nom) || x.employeeId.localeCompare(y.employeeId));
      const signature = personnes.length >= 2
        ? personnes.map((p) => `${p.employeeId}:${p.enAttente ? "1" : "0"}`).join("|")
        : "";
      if (courante && signature === signatureCourante) {
        courante.fin = jour;
        continue;
      }
      if (courante) out.push(courante);
      courante = signature ? { groupe: liste[0].groupe, debut: jour, fin: jour, personnes } : null;
      signatureCourante = signature;
    }
    if (courante) out.push(courante);
  }
  return out.sort((a, b) => a.debut.localeCompare(b.debut) || (a.groupe ?? "").localeCompare(b.groupe ?? ""));
}
