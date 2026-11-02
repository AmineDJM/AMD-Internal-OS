/**
 * L'ANNUAIRE — les COLONNES de la feuille (tronc commun et sur mesure), la valeur affichée et la
 * valeur brute d'une cellule, et les groupes d'options d'un menu de lien.
 */
import { ANNUAIRE_COLUMNS, annuaireCell, estARattacher, type AnnuaireRow, type AnnuaireField, type CustomColumnVue, type CibleReference } from "@/lib/medical/directory-grid";
import { cleDEtablissement } from "@/lib/annuaires/rattachement";
import type { EtablissementOption } from "@/lib/annuaires/types";

export const SPECIALTY_LIST_ID = "annuaire-specialties";

/** Une colonne telle que la feuille la rend — tronc commun ou sur mesure, même contrat. */
export interface ColonneVue {
  cle: string;
  header: string;
  editor: "text" | "select" | "number" | "date" | "reference";
  options?: { value: string; label: string }[];
  suggest?: boolean;
  width: number;
  custom: boolean;
  /** Le champ du tronc commun, quand c'en est un (pour l'affichage traduit et l'écriture). */
  field?: AnnuaireField;
  /** Pour une colonne `reference` : l'annuaire qu'elle désigne (§118.172). */
  reference?: CibleReference;
}

/** Un groupe d'options d'un menu de lien (« Proche du texte saisi », « Tous les établissements »). */
export interface GroupeOptions {
  label: string | null;
  options: { value: string; label: string }[];
}

export function colonnesDeLaFeuille(custom: CustomColumnVue[], masquees: readonly AnnuaireField[] = []): ColonneVue[] {
  const std: ColonneVue[] = ANNUAIRE_COLUMNS.filter((c) => !masquees.includes(c.field)).map((c) => ({
    cle: c.field, header: c.header, editor: c.editor, options: c.options, suggest: c.suggest,
    width: c.width ?? 12, custom: false, field: c.field, reference: c.reference,
  }));
  const cus: ColonneVue[] = custom.map((c) => ({
    cle: c.key, header: c.label, width: 12, custom: true,
    editor: c.kind === "CHOICE" ? "select" : c.kind === "NUMBER" ? "number" : c.kind === "DATE" ? "date" : "text",
    options: c.kind === "CHOICE" ? c.options.map((o) => ({ value: o, label: o })) : undefined,
  }));
  return [...std, ...cus];
}

/** La valeur AFFICHÉE d'une cellule — la même pour l'écran, la copie et la recherche. */
export function valeurAffichee(row: AnnuaireRow, col: ColonneVue): string {
  if (col.field) return annuaireCell(row, col.field);
  const v = row.custom?.[col.cle];
  if (v === null || v === undefined) return "";
  return typeof v === "number" ? String(v).replace(".", ",") : String(v);
}

/** La valeur BRUTE d'une cellule (code d'énuméré, texte, IDENTIFIANT d'un lien) — ce que l'éditeur reçoit. */
export function valeurBrute(row: AnnuaireRow, col: ColonneVue): string {
  // Un lien s'édite par son identifiant : le nom affiché n'est qu'un libellé de l'annuaire.
  if (col.reference === "etablissement") return row.institutionId ?? "";
  if (col.reference === "service") return row.serviceId ?? "";
  if (col.field) return ((row[col.field] as string | null) ?? "");
  const v = row.custom?.[col.cle];
  return v === null || v === undefined ? "" : String(v);
}

export const libelleEtab = (e: EtablissementOption) => (e.wilaya ? `${e.name} · ${e.wilaya}` : e.name);

/**
 * LES CHOIX D'UNE CELLULE DE LIEN, pour CETTE ligne (§118.172).
 *
 * Établissement : les établissements ACTIFS de l'annuaire — et, en tête, ceux dont le nom est
 * PROCHE du texte qu'une fiche d'avant portait (« chu mustapha » → « CHU Mustapha »), pour que
 * rattacher se fasse en un choix. L'établissement DÉJÀ rattaché reste proposé même désactivé :
 * ouvrir la cellule ne doit pas faire croire qu'il a disparu. Proposer n'est pas choisir — c'est
 * la personne qui choisit, et l'action revérifie.
 *
 * Service : seulement ceux de l'établissement de la ligne. Rien d'autre n'a de sens.
 */
export function groupesDeLaCellule(col: ColonneVue, row: AnnuaireRow, etablissements: readonly EtablissementOption[]): GroupeOptions[] {
  if (col.reference === "service") {
    const etab = etablissements.find((e) => e.id === row.institutionId);
    return [{ label: null, options: [{ value: "", label: "— Aucun service —" }, ...(etab?.services ?? []).map((s) => ({ value: s.id, label: s.name }))] }];
  }
  const actifs = etablissements.filter((e) => e.isActive || e.id === row.institutionId);
  const groupes: GroupeOptions[] = [{ label: null, options: [{ value: "", label: "— Aucun établissement —" }] }];
  // À TRANCHER (Direction, 06/10) : les hôpitaux que la wilaya (et la spécialité) désignent, en tête.
  if (!row.institutionId && row.deduction?.statut === "a_trancher") {
    const candidats = actifs.filter((e) => row.deduction!.candidats.includes(e.id));
    if (candidats.length > 0) groupes.push({ label: `À trancher — ${row.deduction.raison}`, options: candidats.map((e) => ({ value: e.id, label: libelleEtab(e) })) });
  }
  if (estARattacher(row)) {
    const cle = cleDEtablissement(row.institution ?? "");
    const mots = cle.split(" ").filter((m) => m.length >= 3);
    const proches = actifs.filter((e) => {
      const n = cleDEtablissement(e.name);
      return n === cle || n.includes(cle) || cle.includes(n) || (mots.length > 0 && mots.every((m) => n.includes(m)));
    }).slice(0, 8);
    if (proches.length > 0) {
      groupes.push({ label: `Proche du texte saisi « ${row.institution} »`, options: proches.map((e) => ({ value: e.id, label: libelleEtab(e) })) });
    }
  }
  groupes.push({
    label: "Tous les établissements",
    options: actifs.map((e) => ({ value: e.id, label: e.isActive ? libelleEtab(e) : `${libelleEtab(e)} (désactivé)` })),
  });
  return groupes;
}

export interface Edition {
  r: number;
  c: number;
  initial?: string;
}
