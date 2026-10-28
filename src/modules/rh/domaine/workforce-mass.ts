/**
 * LA MASSE SALARIALE D'UN EFFECTIF — un salarié, un coût, personne d'oublié.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * « Quand je compte les coûts employeurs des personnes liées à une entité, je ne trouve pas le
 * compte exact : la masse salariale est sous-estimée. » Elle l'était, et par TROIS chemins qui
 * s'additionnaient :
 *
 *   1. **on ne comptait que les lignes marquées PAYÉES.** Un mois saisi mais pas encore pointé
 *      comptait pour zéro. La masse salariale d'une société dont on avait pointé quatre bulletins
 *      sur trente valait quatre salaires ;
 *   2. **le mois de référence était celui de la PLATEFORME.** La paie de septembre saisie chez
 *      Adventum faisait de septembre le mois de tout le monde — et Pharmagène, encore à août,
 *      n'avait aucune ligne pour ce mois-là : zéro ;
 *   3. **le repli tombait sur les SALAIRES DE BASE.** Le salaire de base n'est ni le brut ni le
 *      coût employeur : c'est le plancher du bulletin. Retomber dessus, c'est retirer les primes
 *      ET les charges patronales d'un seul coup.
 *
 * Aucun de ces trois chemins ne produisait un chiffre FAUX au sens strict — chacun répondait
 * simplement à une question que personne n'avait posée. C'est le piège que ce dossier documente
 * déjà ailleurs : un agrégat sans sa portée se dit avec aplomb.
 *
 * ── LA RÈGLE : UN COÛT, PAS UN DÉCAISSEMENT ─────────────────────────────────────────────────
 *
 * La masse salariale est ce que l'effectif COÛTE, et non ce qui est SORTI de la banque. Ce sont
 * deux questions, et les confondre est l'erreur d'origine :
 *
 *   • **le coût** compte chaque salarié une fois, quel que soit l'état du pointage. Un bulletin
 *     en brouillon coûte déjà : le salaire est dû ;
 *   • **le décaissement** ne compte que ce qui est payé, et c'est l'affaire de la trésorerie, qui
 *     a son propre indicateur.
 *
 * Le filtre « payées seulement » protégeait contre un vrai risque — un paiement annulé qui
 * continuerait de peser — mais il protégeait la mauvaise grandeur : un paiement annulé ne retire
 * rien au COÛT du mois, il retire une sortie de banque.
 *
 * ── D'OÙ VIENT LE COÛT DE CHAQUE SALARIÉ ────────────────────────────────────────────────────
 *
 * Sa LIGNE DE PAIE du mois de référence si elle existe — c'est le chiffre réel, arrêté. Sinon le
 * coût employeur DE RÉFÉRENCE de sa fiche (`defaultEmployerCost` : coût employeur, à défaut brut,
 * à défaut salaire de base). Sinon RIEN, et on le DIT : `uncovered` compte ces salariés-là, pour
 * qu'ils se voient à l'écran au lieu de manquer en silence.
 *
 * Ce qui n'est PAS fait ici, volontairement : appliquer un taux de charges moyen à un brut pour
 * fabriquer un coût employeur absent. Cela remplirait les colonnes vides de chiffres plausibles
 * et faux, dans un module qui sert à décider.
 *
 * Module PUR : ni base, ni session. Testé.
 */

import { defaultEmployerCost, entryCost, entryBasis, type PayrollCostInput, type CostBasis } from "./payroll-cost";

export interface WorkforceEmployee {
  id: string;
  companyId: string | null;
  isActive: boolean;
  employerCost?: number | null;
  grossSalary?: number | null;
  baseSalary?: number | null;
}

export interface WorkforcePayrollLine extends PayrollCostInput {
  employeeId: string;
}

/** D'où vient le coût retenu pour un salarié. */
export type CostSource = "PAYROLL" | "RECORD" | "NONE";

export interface EmployeeCost {
  employeeId: string;
  companyId: string | null;
  cost: number;
  source: CostSource;
  /** La base du chiffre quand il vient d'une ligne de paie (coût employeur, ou brut). */
  basis: CostBasis;
}

/**
 * LE COÛT DE CHAQUE SALARIÉ ACTIF, dans l'ordre : sa ligne du mois, puis sa fiche.
 *
 * Seuls les salariés ACTIFS entrent. Un salarié parti garde ses lignes de paie passées — les
 * compter ferait porter à la masse du mois des salaires que la société ne verse plus.
 *
 * La table des lignes est indexée par salarié : `PayrollEntry` est unique par (salarié, année,
 * mois), il ne peut donc pas y en avoir deux, et l'on n'a pas à choisir laquelle croire.
 */
export function employeeCosts(
  employees: readonly WorkforceEmployee[],
  lines: readonly WorkforcePayrollLine[],
): EmployeeCost[] {
  const byEmployee = new Map<string, WorkforcePayrollLine>();
  for (const l of lines) byEmployee.set(l.employeeId, l);

  return employees
    .filter((e) => e.isActive)
    .map((e) => {
      const ligne = byEmployee.get(e.id);
      if (ligne) {
        return { employeeId: e.id, companyId: e.companyId, cost: entryCost(ligne), source: "PAYROLL" as const, basis: entryBasis(ligne) };
      }
      const fiche = defaultEmployerCost(e);
      if (fiche != null) {
        // La fiche porte un coût employeur, à défaut un brut, à défaut un salaire de base :
        // `defaultEmployerCost` tranche, et la base annoncée reste honnête.
        const basis: CostBasis = e.employerCost != null ? "EMPLOYER_COST" : e.grossSalary != null ? "GROSS" : "BASE_SALARY";
        return { employeeId: e.id, companyId: e.companyId, cost: fiche, source: "RECORD" as const, basis };
      }
      return { employeeId: e.id, companyId: e.companyId, cost: 0, source: "NONE" as const, basis: "NONE" as const };
    });
}

export interface WorkforceMass {
  total: number;
  /** Combien de salariés sont couverts par une vraie ligne de paie. */
  fromPayroll: number;
  /** Combien reposent sur le coût de référence de leur fiche. */
  fromRecord: number;
  /** Combien n'ont RIEN — ni ligne, ni montant sur leur fiche. Ceux-là manquent au total. */
  uncovered: number;
  /** La base du total : « coût employeur » seulement si TOUT le monde en porte un. */
  basis: CostBasis;
}

/**
 * LA MASSE DE L'EFFECTIF, et ce sur quoi elle repose.
 *
 * La base est celle du LOT : dès qu'un seul salarié retombe sur un brut ou sur sa fiche, annoncer
 * « coût employeur » serait faux. On le dit plutôt que de le lisser — un indicateur dont on ignore
 * la base est un indicateur qu'on finit par ne plus croire.
 */
export function workforceMass(rows: readonly EmployeeCost[]): WorkforceMass {
  let total = 0;
  let fromPayroll = 0;
  let fromRecord = 0;
  let uncovered = 0;
  let toutCoutEmployeur = rows.length > 0;

  for (const r of rows) {
    total += r.cost;
    if (r.source === "PAYROLL") fromPayroll += 1;
    else if (r.source === "RECORD") fromRecord += 1;
    else uncovered += 1;
    if (r.basis !== "EMPLOYER_COST") toutCoutEmployeur = false;
  }

  const basis: CostBasis = rows.length === 0 ? "NONE" : toutCoutEmployeur ? "EMPLOYER_COST" : "GROSS";
  return { total, fromPayroll, fromRecord, uncovered, basis };
}

/** La masse par ENTITÉ — le chiffre que chaque société doit reconnaître comme le sien. */
export function massByCompany(rows: readonly EmployeeCost[]): Map<string | null, WorkforceMass> {
  const groupes = new Map<string | null, EmployeeCost[]>();
  for (const r of rows) {
    const bucket = groupes.get(r.companyId);
    if (bucket) bucket.push(r); else groupes.set(r.companyId, [r]);
  }
  const out = new Map<string | null, WorkforceMass>();
  for (const [companyId, list] of groupes) out.set(companyId, workforceMass(list));
  return out;
}

/**
 * CE QUE L'ÉCRAN ÉCRIT SOUS LE CHIFFRE — d'où il vient, et ce qui lui manque.
 *
 * Trois salariés estimés d'après leur fiche et deux sans aucun montant, ce n'est pas la même
 * chose qu'un mois complet : le total se lit autrement. La phrase le dit en clair plutôt que de
 * laisser deviner.
 */
export function massProvenance(m: WorkforceMass): string | null {
  if (m.fromPayroll + m.fromRecord + m.uncovered === 0) return null;
  const morceaux: string[] = [];
  if (m.fromPayroll > 0) morceaux.push(`${m.fromPayroll} d'après la paie du mois`);
  if (m.fromRecord > 0) morceaux.push(`${m.fromRecord} d'après la fiche salarié`);
  if (m.uncovered > 0) morceaux.push(`${m.uncovered} sans montant connu — non compté${m.uncovered > 1 ? "s" : ""}`);
  return morceaux.join(" · ");
}

/** Y a-t-il de quoi alerter ? Un salarié sans aucun montant AMPUTE le total, et cela se signale. */
export function massIsIncomplete(m: WorkforceMass): boolean {
  return m.uncovered > 0;
}
