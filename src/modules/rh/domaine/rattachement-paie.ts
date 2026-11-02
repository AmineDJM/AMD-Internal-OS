/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RATTACHER À UNE ENTITÉ LES SALARIÉS QUI N'EN ONT PAS — et ce que cela fait à leur paie.
 *
 * « Ceux sans entité, me dire QUI et en un clic je les rattache » — la Direction, 04/10/2026.
 *
 * ── CE QUE « RATTACHER » ÉCRIT ──────────────────────────────────────────────────────────────
 *
 * La société de la FICHE SALARIÉ (`Employee.companyId`), et rien d'autre. Une ligne de paie ne
 * porte AUCUNE entité à elle : l'écran de la paie, la carte d'envoi et l'envoi au centre la lisent
 * sur le salarié (`employee.companyId`). Écrire l'entité sur les lignes de paie en ferait une
 * seconde vérité qui divergerait de la fiche au premier changement (§118.5) ; la fiche fait foi,
 * et toutes les lignes du salarié la suivent.
 *
 * ── CE QUI NE CHANGE PAS D'ENTITÉ EN SILENCE ────────────────────────────────────────────────
 *
 * Puisque les lignes suivent la fiche, rattacher DÉPLACE leur attribution — y compris celle d'un
 * salaire déjà parti. Trois cas, chacun avec sa conduite :
 *
 *   • parti par un VIREMENT d'une autre entité (envoyé au centre, ou viré) — ou versé par une
 *     écriture de l'ancien circuit stampée d'une autre entité : REFUS, en le nommant. Le compter
 *     chez la cible ferait dire à sa carte « envoyé » d'un salaire que c'est une autre société qui
 *     a déclaré et payé. Le remède est de rattacher le salarié à l'entité qui l'a payé ;
 *   • parti par l'entité CIBLE elle-même : rien ne bouge en réalité, on rattache ;
 *   • versé par l'ANCIEN circuit sans aucune entité connue (marqué payé avant la bascule, ou
 *     transféré au budget sans écriture d'entité) : on rattache, et la phrase le DIT — ce salaire
 *     entre désormais dans la masse de la cible ; aucune écriture n'est modifiée.
 *
 * Tout ou rien : un lot dont un salarié serait refusé n'en rattache aucun. Un « tout rattacher »
 * qui laisserait partir « le reste » laisserait la personne deviner lesquels ont bougé.
 *
 * Module PUR — testé, sans base de données.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un salaire déjà PARTI (envoyé au centre ou viré) d'un salarié qu'on rattache. */
export interface SalaireParti {
  year: number;
  /** 1 = janvier. */
  month: number;
  /** L'entité au nom de laquelle il est parti — `null` : aucune entité connue (ancien circuit). */
  companyId: string | null;
  /** La référence qui le désigne (ordre de dépense, écriture) — pour que le refus la nomme. */
  reference: string | null;
}

export interface SalarieARattacher {
  id: string;
  nom: string;
  salairesPartis: SalaireParti[];
}

export type DecisionRattachement =
  | { ok: true; ancienCircuit: number }
  | { ok: false; refus: string };

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const moisLu = (y: number, m: number) => `${MOIS[m - 1] ?? `mois ${m}`} ${y}`;

/**
 * LA DÉCISION — sur ce que la base dit des salaires déjà partis. `nomEntite` rend le libellé d'une
 * entité (celle qui a payé peut ne pas être ouverte à la personne : on la nomme quand même, c'est
 * l'explication du refus — la masquer ferait chercher une panne).
 */
export function decisionRattachement(
  salaries: readonly SalarieARattacher[],
  cible: { id: string; nom: string },
  nomEntite: (companyId: string) => string,
): DecisionRattachement {
  const conflits: string[] = [];
  let ancienCircuit = 0;
  for (const s of salaries) {
    for (const p of s.salairesPartis) {
      if (p.companyId === null) { ancienCircuit++; continue; }
      if (p.companyId === cible.id) continue;
      conflits.push(
        `${s.nom} — paie de ${moisLu(p.year, p.month)} partie au nom de ${nomEntite(p.companyId)}${p.reference ? ` (${p.reference})` : ""}`,
      );
    }
  }
  if (conflits.length > 0) {
    const montres = conflits.slice(0, 6);
    const reste = conflits.length - montres.length;
    return {
      ok: false,
      refus:
        `Rien n'est rattaché : ${conflits.length > 1 ? "des salaires déjà partis le sont" : "un salaire déjà parti l'est"} au nom d'une autre entité que ${cible.nom}. `
        + `Les compter chez ${cible.nom} changerait en silence l'entité d'une paie déjà déclarée. `
        + `${montres.join(" ; ")}${reste > 0 ? ` ; et ${reste} autre${reste > 1 ? "s" : ""}` : ""}. `
        + "Rattachez ces salariés à l'entité qui les a payés.",
    };
  }
  return { ok: true, ancienCircuit };
}

/** La phrase du succès — qui a bougé, et ce que cela fait à leur paie. */
export function phraseRattachement(input: {
  noms: readonly string[];
  cible: string;
  saisis: number;
  ancienCircuit: number;
  dejaRattaches: readonly string[];
}): string {
  const n = input.noms.length;
  const qui = n <= 5 ? input.noms.join(", ") : `${input.noms.slice(0, 5).join(", ")} et ${n - 5} autre${n - 5 > 1 ? "s" : ""}`;
  const parts = [
    `${n} salarié${n > 1 ? "s" : ""} rattaché${n > 1 ? "s" : ""} à ${input.cible} : ${qui}. Leur paie compte désormais dans la masse de ${input.cible}.`,
  ];
  if (input.saisis > 0) {
    parts.push(`${input.saisis} salaire${input.saisis > 1 ? "s" : ""} saisi${input.saisis > 1 ? "s" : ""} pourr${input.saisis > 1 ? "ont" : "a"} partir au centre depuis la carte de ${input.cible}.`);
  }
  if (input.ancienCircuit > 0) {
    parts.push(
      `${input.ancienCircuit} salaire${input.ancienCircuit > 1 ? "s" : ""} déjà versé${input.ancienCircuit > 1 ? "s" : ""} par l'ancien circuit, sans entité connue, `
      + `entre${input.ancienCircuit > 1 ? "nt" : ""} aussi dans cette masse — aucune écriture de trésorerie n'est modifiée.`,
    );
  }
  if (input.dejaRattaches.length > 0) {
    parts.push(`Déjà rattaché${input.dejaRattaches.length > 1 ? "s" : ""} entre-temps, non modifié${input.dejaRattaches.length > 1 ? "s" : ""} : ${input.dejaRattaches.join(", ")}.`);
  }
  return parts.join(" ");
}
