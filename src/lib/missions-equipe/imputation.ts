/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IMPUTATION DES FRAIS DE L'ÉQUIPE ADVENTUM — AU BUDGET OPERATIONS & SALES (Direction, 10/2026).
 *
 * « Ici le budget à imputer, ce n'est pas Ad & Pro, c'est Operations & Sales. » Sur une opération Ad & Pro (congrès,
 * événement, sponsoring), Ad & Pro porte les INVITÉS EXTERNES (professionnels de santé, prises en charge). Les frais des
 * collaborateurs d'Adventum qui y participent — transport, hébergement, ordre de mission, frais de mission — relèvent
 * du budget du pôle Operations & Sales : l'enveloppe de l'année (ouverte d'office si absente), dans une catégorie du
 * pôle (par défaut « Frais de déplacement terrain »), jamais la masse salariale.
 *
 * Ce qui avait été imputé à Ad & Pro avant reste lisible tel quel (on ne réécrit pas l'histoire) ; l'écran dit où va
 * désormais l'imputation, et rien de nouveau ne part plus vers Ad & Pro.
 *
 * Module PUR, sans aucun import : lu par les écrans clients comme par le serveur (client-bundle-guard).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le pôle qui porte désormais les frais de l'équipe. */
export const POLE_EQUIPE = "Operations & Sales";

/** La catégorie proposée par défaut — une des catégories d'office du pôle (`CATEGORIES_OPERATIONS`). */
export const CATEGORIE_EQUIPE_PAR_DEFAUT = "Frais de déplacement terrain";

/** La clé de la masse salariale (= `CLE_MASSE_SALARIALE`, vérifié par le test) : les frais de mission n'y vont jamais. */
const CLE_MASSE_SALARIALE = "MASSE_SALARIALE_FDV";

/** Une catégorie candidate d'une enveloppe Operations & Sales. */
export interface CategorieCandidate {
  id: string;
  name: string;
  parentId: string | null;
  cle: string | null;
  envelopeName: string;
}

export interface OptionImputation { id: string; label: string }

/** Les catégories où l'équipe s'impute : toutes, sauf la masse salariale et ses sous-catégories par BU. */
export function categoriesImputables(cats: readonly CategorieCandidate[]): CategorieCandidate[] {
  const ms = new Set(cats.filter((c) => c.cle === CLE_MASSE_SALARIALE).map((c) => c.id));
  return cats.filter((c) => !ms.has(c.id) && !(c.parentId && ms.has(c.parentId)));
}

/** La catégorie par défaut parmi les imputables : « Frais de déplacement terrain », à défaut la première de 1er niveau. */
export function categorieParDefaut(cats: readonly CategorieCandidate[]): CategorieCandidate | null {
  const ok = categoriesImputables(cats);
  const norme = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return ok.find((c) => c.parentId === null && norme(c.name) === norme(CATEGORIE_EQUIPE_PAR_DEFAUT))
    ?? ok.find((c) => c.parentId === null)
    ?? ok[0]
    ?? null;
}

/** Les options du sélecteur « Imputation » : la catégorie par défaut d'abord, puis les autres (« Enveloppe › Catégorie »). */
export function optionsImputation(cats: readonly CategorieCandidate[]): OptionImputation[] {
  const ok = categoriesImputables(cats);
  const defaut = categorieParDefaut(cats);
  const nom = new Map(cats.map((c) => [c.id, c.name]));
  const libelle = (c: CategorieCandidate) => [c.envelopeName, c.parentId ? nom.get(c.parentId) : null, c.name].filter(Boolean).join(" › ");
  const tries = defaut ? [defaut, ...ok.filter((c) => c.id !== defaut.id)] : ok;
  return tries.map((c) => ({ id: c.id, label: libelle(c) }));
}

/** Où pointe une imputation : le pôle Operations & Sales (la règle), Ad & Pro (l'historique) ou une autre enveloppe. */
export type PoleImputation = "OPERATIONS" | "AD_PRO" | "AUTRE";

/** Les modules d'une enveloppe Ad & Pro (ceux que proposait l'ancien sélecteur). */
const MODULES_AD_PRO = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS", "PROMO_MATERIAL"];

export function poleDeLImputation(env: { domaine?: string | null; module?: string | null; modules?: readonly string[] | null }): PoleImputation {
  if (env.domaine === "OPERATIONS") return "OPERATIONS";
  if (env.domaine === "MARKETING") return "AD_PRO";
  const mods = [...(env.modules ?? []), ...(env.module ? [env.module] : [])];
  return mods.some((m) => MODULES_AD_PRO.includes(m)) ? "AD_PRO" : "AUTRE";
}

/** L'imputation d'un membre, telle que l'écran la lit. */
export interface ImputationEquipe {
  categoryId: string;
  libelle: string;
  pole: PoleImputation;
  /** Posée d'office (catégorie par défaut), pas choisie par quelqu'un. */
  parDefaut: boolean;
}

/** La phrase de la colonne « Imputation » quand on ne peut pas choisir. */
export function texteImputation(i: ImputationEquipe | null, defaut: string | null): string {
  if (!i) return defaut ? `${defaut} (par défaut)` : `${POLE_EQUIPE} — catégorie à choisir`;
  if (i.pole === "OPERATIONS") return i.parDefaut ? `${i.libelle} (par défaut)` : i.libelle;
  return `${i.libelle} — ancienne imputation ${i.pole === "AD_PRO" ? "Ad & Pro" : "hors Operations & Sales"}`;
}

/** Une ancienne imputation (Ad & Pro ou autre) : lisible, mais les nouveaux frais iront à Operations & Sales. */
export function imputationHistorique(i: ImputationEquipe | null): boolean {
  return i !== null && i.pole !== "OPERATIONS";
}

/**
 * LA NOTE DE FRAIS D'UNE MISSION, VUE DU BUDGET — validée par les RH : consommée ; en route (N+1, RH) : engagée ;
 * refusée ou retirée : rien.
 */
export function etatBudgetaireNoteFrais(status: string, managerGate: string | null): "CONSOMME" | "ENGAGE" | null {
  if (["READY", "DELIVERED", "APPROVED"].includes(status)) return "CONSOMME";
  if (["PENDING", "IN_PROGRESS"].includes(status)) return managerGate === "REJECTED" ? null : "ENGAGE";
  return null;
}
