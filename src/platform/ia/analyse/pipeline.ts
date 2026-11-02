/**
 * LE PIPELINE D'ANALYSE — la spec d'un modèle, compilée en opérations FERMÉES (§25).
 *
 * Le modèle écrit des ÉTAPES (« regrouper par société, somme du montant », « série mensuelle »,
 * « anomalies sur le montant ») ; ce module les relit champ par champ, applique celles qui sont
 * valides dans l'ordre, et DIT celles qu'il a refusées — une opération inconnue, une colonne
 * absente, un agrégat inexistant. Une étape refusée n'arrête pas le lot (Live Office §6) : ce
 * qui peut tourner tourne, et le reste est nommé. Pur : ni base, ni droits, ni réseau.
 */

import {
  anomalies, cohortes, croiser, croissance, cumul, decrire, filtrer, moyenneMobile, rang, regrouper, scenario, serie, tendance, trier, versNombre,
  type Agregat, type Filtre, type Ignore, type Ligne, type Mesure, type Operateur, type Pas,
} from "@/platform/ia/analyse/analyse";

export const AGREGATS: readonly Agregat[] = ["count", "sum", "avg", "min", "max", "median", "p90", "distinct"];
export const OPERATEURS: readonly Operateur[] = ["=", "!=", ">", ">=", "<", "<=", "contient", "vide", "non_vide", "dans"];
export const PAS_TEMPS: readonly Pas[] = ["jour", "semaine", "mois", "trimestre", "annee"];
export const OPS_PIPELINE = [
  "filtrer", "colonnes", "regrouper", "croiser", "trier", "limiter", "serie", "moyenne_mobile", "croissance", "cumul", "tendance", "rang", "anomalies", "cohortes", "scenario", "decrire",
] as const;
export type OpPipeline = (typeof OPS_PIPELINE)[number];
export const ETAPES_MAX = 20;

/** Ce que le modèle reçoit comme mode d'emploi — une ligne par opération, avec ses champs. */
export const MODE_EMPLOI_PIPELINE =
  "filtrer{filtres:[{colonne,op(= != > >= < <= contient vide non_vide dans),valeur}]} · colonnes{garder:[…]} · "
  + "regrouper{par:[…],mesures:[{colonne,agregat(count sum avg min max median p90 distinct),alias?}]} · croiser{ligne,colonne,mesure} · "
  + "trier{colonne,sens(asc|desc)} · limiter{n} · serie{colonneDate,mesure,pas(jour|semaine|mois|trimestre|annee)} → lignes {periode,valeur,n} · "
  + "moyenne_mobile{colonne,fenetre,alias?} · croissance{colonne,alias?} · cumul{colonne,alias?} · tendance{colonne} → resultats · rang{colonne,alias?} · "
  + "anomalies{colonne,seuil?} (z robuste, n ≥ 8) · cohortes{colonneEntite,colonneDate,pas} · scenario{variations:[{colonne,pourcent}],mesure} → resultats · decrire → resultats.profil";

export interface JournalEtape { op: string; avant: number; apres: number; note?: string }
export interface ResultatPipeline {
  lignes: Ligne[];
  journal: JournalEtape[];
  /** Les sorties qui ne sont pas des lignes : tendance, scénario, profil, paramètres d'anomalies. */
  resultats: Record<string, unknown>;
  ignores: Ignore[];
  /** Les étapes REFUSÉES, avec la raison — jamais avalées. */
  erreurs: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const strs = (v: unknown): string[] => arr(v).map(s).filter(Boolean);

export function mesureDe(v: unknown, premiereColonne?: string): Mesure | null {
  if (typeof v === "string" && v.trim()) return { colonne: v.trim(), agregat: "sum" };
  if (!isObj(v)) return null;
  const colonne = s(v.colonne) || s(v.column);
  const agregat = (s(v.agregat) || s(v.agg) || s(v.fonction) || "sum").toLowerCase();
  if (!AGREGATS.includes(agregat as Agregat)) return null;
  if (!colonne && agregat !== "count") return null;
  const alias = s(v.alias);
  return { colonne: colonne || premiereColonne || "*", agregat: agregat as Agregat, ...(alias ? { alias } : {}) };
}

export function filtreDe(v: unknown): Filtre | null {
  if (!isObj(v)) return null;
  const colonne = s(v.colonne) || s(v.column);
  const op = (s(v.op) || s(v.operateur) || "=") as Operateur;
  if (!colonne || !OPERATEURS.includes(op)) return null;
  return { colonne, op, valeur: v.valeur ?? v.value };
}

function colonneAbsente(lignes: readonly Ligne[], colonne: string): boolean {
  return lignes.length > 0 && !lignes.some((l) => colonne in l);
}

/** APPLIQUER les étapes, dans l'ordre. Ce qui est refusé est dit ; ce qui passe tourne. */
export function appliquerEtapes(entree: readonly Ligne[], etapes: readonly unknown[]): ResultatPipeline {
  let lignes: Ligne[] = [...entree];
  const journal: JournalEtape[] = [];
  const resultats: Record<string, unknown> = {};
  const ignores: Ignore[] = [];
  const erreurs: string[] = [];
  if (etapes.length > ETAPES_MAX) erreurs.push(`${etapes.length} étapes : seules les ${ETAPES_MAX} premières sont appliquées`);

  etapes.slice(0, ETAPES_MAX).forEach((raw, i) => {
    const num = i + 1;
    if (!isObj(raw)) { erreurs.push(`étape ${num} : forme invalide (objet attendu avec « op »)`); return; }
    const op = (s(raw.op) || s(raw.operation)).toLowerCase();
    const avant = lignes.length;
    let note: string | undefined;
    const refuser = (motif: string) => { erreurs.push(`étape ${num} (${op || "?"}) : ${motif}`); };
    const exige = (colonne: string, quoi = "colonne"): boolean => {
      if (!colonne) { refuser(`${quoi} manquante`); return false; }
      if (colonneAbsente(lignes, colonne)) { refuser(`${quoi} « ${colonne} » absente des lignes (${Object.keys(lignes[0] ?? {}).slice(0, 12).join(", ")})`); return false; }
      return true;
    };

    switch (op as OpPipeline) {
      case "filtrer": {
        const filtres = arr(raw.filtres ?? raw.filtre).map(filtreDe).filter((f): f is Filtre => f !== null);
        if (!filtres.length) return refuser("aucun filtre valide");
        lignes = filtrer(lignes, filtres);
        break;
      }
      case "colonnes": {
        const garder = strs(raw.garder ?? raw.colonnes);
        if (!garder.length) return refuser("aucune colonne à garder");
        lignes = lignes.map((l) => Object.fromEntries(garder.filter((k) => k in l).map((k) => [k, l[k]])));
        break;
      }
      case "regrouper": {
        const par = strs(raw.par);
        const mesures = arr(raw.mesures ?? raw.mesure).map((m) => mesureDe(m, par[0])).filter((m): m is Mesure => m !== null);
        if (!par.length && !mesures.length) return refuser("ni « par » ni « mesures »");
        for (const c of par) if (!exige(c, "clé de regroupement")) return;
        const r = regrouper(lignes, par, mesures.length ? mesures : [{ colonne: par[0], agregat: "count", alias: "n" }]);
        lignes = r.lignes; ignores.push(...r.ignores);
        break;
      }
      case "croiser": {
        const ligne = s(raw.ligne); const colonne = s(raw.colonne); const mesure = mesureDe(raw.mesure, ligne);
        if (!exige(ligne, "ligne") || !exige(colonne, "colonne") || !mesure) { if (!mesure) refuser("mesure manquante"); return; }
        const r = croiser(lignes, ligne, colonne, mesure);
        lignes = r.lignes; note = `colonnes : ${r.colonnes.slice(0, 12).join(", ")}${r.colonnes.length > 12 ? "…" : ""}`;
        break;
      }
      case "trier": {
        const colonne = s(raw.colonne) || s(raw.par);
        if (!exige(colonne)) return;
        lignes = trier(lignes, colonne, s(raw.sens).toLowerCase() === "asc" ? "asc" : "desc");
        break;
      }
      case "limiter": {
        const k = n(raw.n) ?? n(raw.limite) ?? 20;
        lignes = lignes.slice(0, Math.max(1, Math.round(k)));
        break;
      }
      case "serie": {
        const colonneDate = s(raw.colonneDate) || s(raw.date);
        const mesure = mesureDe(raw.mesure, colonneDate);
        const pas = (PAS_TEMPS as readonly string[]).includes(s(raw.pas)) ? (s(raw.pas) as Pas) : "mois";
        if (!exige(colonneDate, "colonne de date") || !mesure) { if (!mesure) refuser("mesure manquante"); return; }
        const r = serie(lignes, colonneDate, mesure, pas);
        lignes = r.points.map((p) => ({ periode: p.periode, valeur: p.valeur, n: p.n }));
        ignores.push(...r.ignores); note = `pas : ${pas}, mesure : ${mesure.agregat}(${mesure.colonne})`;
        break;
      }
      case "moyenne_mobile": case "croissance": case "cumul": {
        const colonne = s(raw.colonne) || "valeur";
        if (!exige(colonne)) return;
        const alias = s(raw.alias) || `${op}_${colonne}`;
        const vals = lignes.map((l) => versNombre(l[colonne]));
        const out = op === "cumul" ? cumul(vals) : op === "croissance" ? croissance(vals) : moyenneMobile(vals, Math.max(2, Math.round(n(raw.fenetre) ?? 3)));
        lignes = lignes.map((l, k) => ({ ...l, [alias]: out[k] }));
        note = `nouvelle colonne « ${alias} »`;
        break;
      }
      case "tendance": {
        const colonne = s(raw.colonne) || "valeur";
        if (!exige(colonne)) return;
        resultats[`tendance_${colonne}`] = tendance(lignes.map((l) => versNombre(l[colonne]))) ?? "moins de trois points : pas de tendance";
        note = `résultat dans resultats.tendance_${colonne}`;
        break;
      }
      case "rang": {
        const colonne = s(raw.colonne);
        if (!exige(colonne)) return;
        lignes = rang(lignes, colonne, s(raw.alias) || "rang");
        break;
      }
      case "anomalies": {
        const colonne = s(raw.colonne);
        if (!exige(colonne)) return;
        const seuil = n(raw.seuil) ?? 3.5;
        const r = anomalies(lignes, colonne, seuil);
        resultats[`anomalies_${colonne}`] = { mediane: r.mediane, mad: r.mad, seuil, n: r.lignes.length, ...(avant < 8 ? { note: "moins de huit valeurs : aucune anomalie ne peut être jugée" } : {}) };
        lignes = r.lignes;
        break;
      }
      case "cohortes": {
        const colonneEntite = s(raw.colonneEntite) || s(raw.entite);
        const colonneDate = s(raw.colonneDate) || s(raw.date);
        const pas = (PAS_TEMPS as readonly string[]).includes(s(raw.pas)) ? (s(raw.pas) as Pas) : "mois";
        if (!exige(colonneEntite, "colonne d'entité") || !exige(colonneDate, "colonne de date")) return;
        const r = cohortes(lignes, colonneEntite, colonneDate, pas);
        resultats.cohortes = { periodes: r.periodes, pas };
        lignes = r.cohortes.map((c) => ({ cohorte: c.cohorte, taille: c.taille, ...Object.fromEntries(c.retention.map((v, k) => [`p+${k}`, v])) }));
        note = "rétention en % par période depuis la cohorte (p+0 = 100)";
        break;
      }
      case "scenario": {
        const variations = arr(raw.variations).map((v) => (isObj(v) && s(v.colonne) && n(v.pourcent) !== null ? { colonne: s(v.colonne), pourcent: n(v.pourcent) as number } : null)).filter((v): v is { colonne: string; pourcent: number } => v !== null);
        const mesure = mesureDe(raw.mesure);
        if (!variations.length) return refuser("aucune variation valide ({colonne, pourcent})");
        if (!mesure) return refuser("mesure manquante");
        resultats.scenario = scenario(lignes, variations, mesure);
        note = "résultat dans resultats.scenario — hypothèses, jamais appliquées à la base";
        break;
      }
      case "decrire": {
        resultats.profil = decrire(lignes);
        note = "profil dans resultats.profil";
        break;
      }
      default:
        return refuser(`opération inconnue — disponibles : ${OPS_PIPELINE.join(", ")}`);
    }
    journal.push({ op, avant, apres: lignes.length, ...(note ? { note } : {}) });
  });

  return { lignes, journal, resultats, ignores, erreurs };
}
