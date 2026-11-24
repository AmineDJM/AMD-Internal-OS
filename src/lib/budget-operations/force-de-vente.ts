/**
 * BUDGET OPERATIONS & SALES — LA MASSE SALARIALE DE LA FORCE DE VENTE (Direction, 08/10).
 *
 * « Il y gère la masse salariale de sa force de vente et ses dépenses hors Ad&Pro bien sûr. »
 *
 * ── QUI EST LA FORCE DE VENTE ───────────────────────────────────────────────────────────────
 *
 * Un salarié en fait partie, et sa BU se lit, dans cet ordre :
 *   1. son compte a un PROFIL KAM actif (`SalesRepProfile`) → la BU du profil ;
 *   2. il SUPERVISE une BU (`BusinessUnit.supervisorId`) → cette BU ;
 *   3. son DÉPARTEMENT est (ou descend de) le sous-département d'une BU → cette BU ;
 *   4. son département est (ou descend de) la Direction commerciale → « hors BU ».
 *   5. son département est (ou descend de) la Direction des opérations, ou son compte est Directeur des opérations →
 *      « Direction des opérations » (Direction, 10/2026 : la masse salariale d'Operations & Sales l'inclut, avec les BU).
 * Personne d'autre : un salarié des Finances n'entre pas dans la masse salariale commerciale.
 *
 * ── CE QUI SORT D'ICI ────────────────────────────────────────────────────────────────────────
 *
 * Des TOTAUX (par mois, par BU) et des effectifs — jamais le salaire d'une personne, sauf à qui voit les salaires
 * (`voitLesSalaires`, `lib/hr/confidentialite.ts`). Une équipe d'UNE personne serait un salaire nommé : sans ce droit,
 * elle est regroupée avec les autres petites équipes, et ce regroupement lui-même n'est montré qu'à partir de deux
 * personnes (sinon il ne compte que dans le total).
 *
 * Le coût d'une ligne de paie est celui de `lib/hr/payroll-cost.ts` (coût employeur, à défaut brut + primes −
 * retenues) — l'appelant le calcule ; ce module ne lit pas la base. Module PUR, testé.
 */

export const CLE_MASSE_SALARIALE = "MASSE_SALARIALE_FDV" as const;

/** Les catégories créées d'office pour une enveloppe Operations & Sales — la masse salariale, puis le hors Ad & Pro. */
export const CATEGORIES_OPERATIONS: readonly { nom: string; cle: typeof CLE_MASSE_SALARIALE | null }[] = [
  { nom: "Masse salariale de la force de vente", cle: CLE_MASSE_SALARIALE },
  { nom: "Véhicules & carburant", cle: null },
  { nom: "Frais de déplacement terrain", cle: null },
  { nom: "Téléphonie", cle: null },
  { nom: "Logistique", cle: null },
  { nom: "Formations commerciales", cle: null },
];

/** La « BU » des commerciaux rattachés à la Direction commerciale sans BU. */
export const HORS_BU = "__HORS_BU__";
export const LIBELLE_HORS_BU = "Direction commerciale (hors BU)";
/** En dessous de ce nombre de personnes, une équipe ne se montre pas seule à qui ne voit pas les salaires. */
export const EFFECTIF_MINIMUM = 2;
export const LIBELLE_PETITES_EQUIPES = "Autres équipes (effectifs réduits)";

/** Le « groupe » des salariés de la Direction des opérations (son département et ses sous-départements, son directeur). */
export const DIRECTION_OPERATIONS = "__DIRECTION_OPERATIONS__";
export const LIBELLE_DIRECTION_OPERATIONS = "Direction des opérations";

/** Ce département est-il la Direction des opérations ? — la règle de l'organigramme, lue au module RH (une définition). */
export { estDirectionDesOperations } from "@/modules/rh/partage";

/** `directeurOperations` : le compte du salarié a le rôle de Directeur des opérations — il en fait partie, où que soit son département. */
export interface EmployeFdv { id: string; userId: string | null; departmentId: string | null; directeurOperations?: boolean }
export interface ProfilKam { repId: string; businessUnitId: string | null; isActive: boolean }
export interface BuFdv { id: string; supervisorId: string | null; departmentId: string | null }
export interface DepartementFdv { id: string; parentId: string | null; commercial: boolean; operations?: boolean }

/** LE RATTACHEMENT de chaque salarié de la force de vente : id salarié → id de BU (ou `HORS_BU`). Les autres n'y sont pas. */
export function rattacherForceDeVente(input: {
  employes: readonly EmployeFdv[];
  profils: readonly ProfilKam[];
  bus: readonly BuFdv[];
  departements: readonly DepartementFdv[];
}): Map<string, string> {
  const profilDe = new Map(input.profils.filter((p) => p.isActive).map((p) => [p.repId, p]));
  const superviseDe = new Map<string, string>();
  for (const b of input.bus) if (b.supervisorId && !superviseDe.has(b.supervisorId)) superviseDe.set(b.supervisorId, b.id);
  const buDuDepartement = new Map<string, string>();
  for (const b of input.bus) if (b.departmentId) buDuDepartement.set(b.departmentId, b.id);
  const dep = new Map(input.departements.map((d) => [d.id, d]));

  const parDepartement = (departmentId: string | null): string | null => {
    let cur = departmentId;
    for (let i = 0; cur && i < 25; i += 1) {
      const bu = buDuDepartement.get(cur);
      if (bu) return bu;
      const d = dep.get(cur);
      if (!d) return null;
      if (d.commercial) return HORS_BU;
      if (d.operations) return DIRECTION_OPERATIONS;
      cur = d.parentId;
    }
    return null;
  };

  const out = new Map<string, string>();
  for (const e of input.employes) {
    const profil = e.userId ? profilDe.get(e.userId) : undefined;
    const supervise = e.userId ? superviseDe.get(e.userId) : undefined;
    const viaDepartement = parDepartement(e.departmentId);
    const bu = profil?.businessUnitId ?? supervise ?? viaDepartement ?? (profil ? HORS_BU : null) ?? (e.directeurOperations ? DIRECTION_OPERATIONS : null);
    if (bu) out.set(e.id, bu);
  }
  return out;
}

/** Une ligne de paie, réduite à son coût. `companyId` = la société du salarié (une enveloppe d'une société ne compte que les siens). */
export interface LignePaie { employeeId: string; year: number; month: number; cost: number; companyId?: string | null }

const cleMois = (annee: number, mois: number) => `${annee}-${String(mois).padStart(2, "0")}`;
const MOIS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Les mois d'une période (au plus 24), du premier au dernier. */
export function moisDeLaPeriode(debut: Date, fin: Date): { cle: string; annee: number; mois: number; libelle: string }[] {
  const out: { cle: string; annee: number; mois: number; libelle: string }[] = [];
  let a = debut.getUTCFullYear();
  let m = debut.getUTCMonth() + 1;
  const fa = fin.getUTCFullYear();
  const fm = fin.getUTCMonth() + 1;
  while ((a < fa || (a === fa && m <= fm)) && out.length < 24) {
    out.push({ cle: cleMois(a, m), annee: a, mois: m, libelle: MOIS_FR[m - 1] });
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return out;
}

/** Une catégorie de masse salariale d'une enveloppe (la catégorie mère, ou la sous-catégorie d'une BU). */
export interface CategorieMs { id: string; envelopeId: string; businessUnitId: string | null; debut: Date; fin: Date; companyId?: string | null }

/**
 * LA PAIE DANS LES ENVELOPPES — ce que la masse salariale consomme, catégorie par catégorie et mois par mois.
 *
 * Chaque ligne de paie d'un salarié de la force de vente va dans la sous-catégorie de SA BU si l'enveloppe en a une,
 * sinon dans la catégorie mère — jamais dans les deux. Une enveloppe ne compte que les mois de SA période (et, pour
 * une vue, ceux de la période affichée). Les lignes rendues sont des TOTAUX par catégorie et par mois.
 */
export function imputerPaie(
  lignes: readonly LignePaie[],
  rattachement: ReadonlyMap<string, string>,
  categories: readonly CategorieMs[],
  bornes: { from?: Date | null; to?: Date | null } = {},
): { parCategorie: Map<string, number>; parMois: { categoryId: string; date: Date; montant: number; effectif: number }[] } {
  const parEnveloppe = new Map<string, { mere: CategorieMs | null; parBu: Map<string, CategorieMs> }>();
  for (const c of categories) {
    const e = parEnveloppe.get(c.envelopeId) ?? { mere: null, parBu: new Map<string, CategorieMs>() };
    if (c.businessUnitId) { if (!e.parBu.has(c.businessUnitId)) e.parBu.set(c.businessUnitId, c); } else if (!e.mere) e.mere = c;
    parEnveloppe.set(c.envelopeId, e);
  }
  const parCategorie = new Map<string, number>();
  const cumul = new Map<string, { categoryId: string; date: Date; montant: number; personnes: Set<string> }>();
  for (const l of lignes) {
    const bu = rattachement.get(l.employeeId);
    if (!bu) continue;
    const date = new Date(Date.UTC(l.year, l.month - 1, 1));
    if (bornes.from && date < new Date(Date.UTC(bornes.from.getUTCFullYear(), bornes.from.getUTCMonth(), 1))) continue;
    if (bornes.to && date > bornes.to) continue;
    for (const e of parEnveloppe.values()) {
      const cible = e.parBu.get(bu) ?? e.mere;
      if (!cible) continue;
      if (cible.companyId && l.companyId && cible.companyId !== l.companyId) continue;
      if (date < new Date(Date.UTC(cible.debut.getUTCFullYear(), cible.debut.getUTCMonth(), 1)) || date > cible.fin) continue;
      parCategorie.set(cible.id, (parCategorie.get(cible.id) ?? 0) + l.cost);
      const k = `${cible.id}|${cleMois(l.year, l.month)}`;
      const c = cumul.get(k) ?? { categoryId: cible.id, date, montant: 0, personnes: new Set<string>() };
      c.montant += l.cost;
      c.personnes.add(l.employeeId);
      cumul.set(k, c);
    }
  }
  const parMois = [...cumul.values()].map((c) => ({ categoryId: c.categoryId, date: c.date, montant: c.montant, effectif: c.personnes.size }));
  return { parCategorie, parMois };
}

export interface GroupeMs {
  cle: string;
  libelle: string;
  /** Le budget de l'année (sous-catégorie de la BU), `null` quand la BU n'en a pas. */
  budget: number | null;
  parMois: number[];
  total: number;
  effectif: number;
}

export interface DetailPersonne { employeeId: string; nom: string; groupe: string; parMois: number[]; total: number }

export interface VueMasseSalariale {
  mois: { cle: string; libelle: string }[];
  groupes: GroupeMs[];
  total: { budget: number; parMois: number[]; total: number; effectif: number };
  /** Le budget de la catégorie mère non réparti entre les BU. */
  budgetNonReparti: number;
  /** Combien de personnes ne sont comptées que dans le total (petite équipe, sans le droit de voir les salaires). */
  personnesDansLeTotalSeulement: number;
  /** Le détail par personne — PRÉSENT SEULEMENT pour qui voit les salaires. */
  parPersonne?: DetailPersonne[];
}

/**
 * LA VUE « MASSE SALARIALE » — budget et réalisé, par BU et par mois. `voitLesSalaires` décide seul du détail par
 * personne : sans lui, le champ `parPersonne` n'existe pas (il n'est donc jamais sérialisé), et aucune ligne ne
 * correspond à une seule personne.
 */
export function agregerMasseSalariale(input: {
  lignes: readonly LignePaie[];
  rattachement: ReadonlyMap<string, string>;
  nomsBu: ReadonlyMap<string, string>;
  mois: readonly { cle: string; annee: number; mois: number; libelle: string }[];
  budgetMere: number;
  budgetParBu: ReadonlyMap<string, number>;
  voitLesSalaires: boolean;
  nomsPersonnes?: ReadonlyMap<string, string>;
}): VueMasseSalariale {
  const index = new Map(input.mois.map((m, i) => [m.cle, i]));
  const n = input.mois.length;
  const brut = new Map<string, { parMois: number[]; personnes: Set<string> }>();
  const personnes = new Map<string, { groupe: string; parMois: number[] }>();
  for (const l of input.lignes) {
    const bu = input.rattachement.get(l.employeeId);
    const i = index.get(cleMois(l.year, l.month));
    if (!bu || i === undefined) continue;
    const g = brut.get(bu) ?? { parMois: new Array<number>(n).fill(0), personnes: new Set<string>() };
    g.parMois[i] += l.cost;
    g.personnes.add(l.employeeId);
    brut.set(bu, g);
    if (input.voitLesSalaires) {
      const p = personnes.get(l.employeeId) ?? { groupe: bu, parMois: new Array<number>(n).fill(0) };
      p.parMois[i] += l.cost;
      personnes.set(l.employeeId, p);
    }
  }
  // Les BU budgétées sans paie apparaissent aussi (réalisé à zéro) : un budget sans réalisé se lit.
  for (const bu of input.budgetParBu.keys()) if (!brut.has(bu)) brut.set(bu, { parMois: new Array<number>(n).fill(0), personnes: new Set<string>() });

  const libelle = (bu: string) => (bu === HORS_BU ? LIBELLE_HORS_BU : bu === DIRECTION_OPERATIONS ? LIBELLE_DIRECTION_OPERATIONS : input.nomsBu.get(bu) ?? "BU retirée");
  const somme = (v: number[]) => v.reduce((a, x) => a + x, 0);
  let groupes: GroupeMs[] = [...brut.entries()].map(([bu, g]) => ({
    cle: bu, libelle: libelle(bu), budget: input.budgetParBu.get(bu) ?? null,
    parMois: g.parMois, total: somme(g.parMois), effectif: g.personnes.size,
  }));

  const totalParMois = new Array<number>(n).fill(0);
  for (const g of groupes) g.parMois.forEach((v, i) => { totalParMois[i] += v; });
  const effectifTotal = new Set([...brut.values()].flatMap((g) => [...g.personnes])).size;

  let dansLeTotalSeulement = 0;
  if (!input.voitLesSalaires) {
    // Une ligne d'UNE personne serait un salaire nommé : les petites équipes (qui ont de la paie) sont regroupées.
    const petites = groupes.filter((g) => g.effectif > 0 && g.effectif < EFFECTIF_MINIMUM);
    if (petites.length > 0) {
      groupes = groupes.filter((g) => !petites.includes(g));
      const parMois = new Array<number>(n).fill(0);
      for (const g of petites) g.parMois.forEach((v, i) => { parMois[i] += v; });
      const effectif = petites.reduce((a, g) => a + g.effectif, 0);
      const budgets = petites.map((g) => g.budget).filter((b): b is number => b !== null);
      if (effectif >= EFFECTIF_MINIMUM) {
        groupes.push({ cle: "__PETITES__", libelle: LIBELLE_PETITES_EQUIPES, budget: budgets.length ? budgets.reduce((a, b) => a + b, 0) : null, parMois, total: somme(parMois), effectif });
      } else {
        dansLeTotalSeulement = effectif;
      }
    }
  }
  // La Direction des opérations d'abord, puis les BU par masse décroissante, la Direction commerciale hors BU en dernier.
  const rang = (cle: string) => (cle === DIRECTION_OPERATIONS ? -1 : cle === HORS_BU ? 1 : 0);
  groupes.sort((a, b) => rang(a.cle) - rang(b.cle) || b.total - a.total || a.libelle.localeCompare(b.libelle, "fr"));

  const sommeBudgetsBu = [...input.budgetParBu.values()].reduce((a, b) => a + b, 0);
  const vue: VueMasseSalariale = {
    mois: input.mois.map((m) => ({ cle: m.cle, libelle: m.libelle })),
    groupes,
    total: { budget: Math.max(input.budgetMere, sommeBudgetsBu), parMois: totalParMois, total: somme(totalParMois), effectif: effectifTotal },
    budgetNonReparti: Math.max(0, input.budgetMere - sommeBudgetsBu),
    personnesDansLeTotalSeulement: dansLeTotalSeulement,
  };
  if (input.voitLesSalaires) {
    vue.parPersonne = [...personnes.entries()]
      .map(([id, p]) => ({ employeeId: id, nom: input.nomsPersonnes?.get(id) ?? "—", groupe: libelle(p.groupe), parMois: p.parMois, total: somme(p.parMois) }))
      .sort((a, b) => a.groupe.localeCompare(b.groupe, "fr") || a.nom.localeCompare(b.nom, "fr"));
  }
  return vue;
}
