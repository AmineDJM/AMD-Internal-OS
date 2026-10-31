import type { EtapeCalcul } from "@/platform/ia/workspace/analyse";
import type { JournalEtape } from "@/platform/ia/analyse/pipeline";

/**
 * « COMMENT C'EST CALCULÉ » — chaque étape du pipeline dite en clair, avec sa FORMULE (lot K1, décision 0031).
 *
 * Le moteur (`pipeline.ts`) journalise l'opération et le nombre de lignes ; ce module relit l'étape telle que le
 * modèle l'a écrite et la traduit en une phrase qu'une personne peut vérifier à la main : « par société :
 * somme(montant) → sum_montant ». Pur, zéro dépendance de valeur.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const AGREGAT_FR: Record<string, string> = {
  count: "nombre de lignes", sum: "somme", avg: "moyenne", min: "minimum", max: "maximum", median: "médiane", p90: "90e centile", distinct: "valeurs distinctes",
};
const OP_FR: Record<string, string> = {
  "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤", contient: "contient", vide: "est vide", non_vide: "n'est pas vide", dans: "parmi",
};
const PAS_FR: Record<string, string> = { jour: "quotidienne", semaine: "hebdomadaire", mois: "mensuelle", trimestre: "trimestrielle", annee: "annuelle" };

function mesure(v: unknown, defaut = "?"): string {
  if (typeof v === "string") return `somme(${v}) → sum_${v}`;
  if (!isObj(v)) return defaut;
  const agg = s(v.agregat) || s(v.agg) || s(v.fonction) || "sum";
  const col = s(v.colonne) || s(v.column);
  const alias = s(v.alias) || `${agg}_${col || "*"}`;
  return agg === "count" ? `${AGREGAT_FR.count} → ${alias}` : `${AGREGAT_FR[agg] ?? agg}(${col}) → ${alias}`;
}

const valeur = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => s(x)).join(", ")}]` : `« ${s(v)} »`);

/** La formule d'UNE étape telle que le modèle l'a écrite. */
export function formuleDe(raw: unknown): string {
  if (!isObj(raw)) return "étape illisible";
  const op = (s(raw.op) || s(raw.operation)).toLowerCase();
  switch (op) {
    case "filtrer":
      return `garder les lignes où ${arr(raw.filtres ?? raw.filtre).filter(isObj).map((f) => {
        const o = s(f.op) || s(f.operateur) || "=";
        return `${s(f.colonne) || s(f.column)} ${OP_FR[o] ?? o}${o === "vide" || o === "non_vide" ? "" : ` ${valeur(f.valeur ?? f.value)}`}`;
      }).join(" et ")}`;
    case "colonnes": return `garder les colonnes ${arr(raw.garder ?? raw.colonnes).map(s).join(", ")}`;
    case "regrouper": {
      const par = arr(raw.par).map(s).filter(Boolean);
      const m = arr(raw.mesures ?? raw.mesure).map((x) => mesure(x));
      return `${par.length ? `par ${par.join(" × ")} : ` : ""}${m.length ? m.join(" ; ") : `${AGREGAT_FR.count} → n`}`;
    }
    case "croiser": return `lignes = ${s(raw.ligne)}, colonnes = ${s(raw.colonne)}, cellule = ${mesure(raw.mesure).replace(/ → .*$/, "")}`;
    case "trier": return `tri ${s(raw.sens).toLowerCase() === "asc" ? "croissant" : "décroissant"} sur ${s(raw.colonne) || s(raw.par)}`;
    case "limiter": return `garder les ${s(raw.n) || s(raw.limite) || "20"} premières lignes`;
    case "serie": return `série ${PAS_FR[s(raw.pas)] ?? "mensuelle"} de ${mesure(raw.mesure).replace(/ → .*$/, "")} sur ${s(raw.colonneDate) || s(raw.date)} (périodes vides comblées) → periode, valeur, n`;
    case "moyenne_mobile": { const c = s(raw.colonne) || "valeur"; const f = s(raw.fenetre) || "3"; return `moyenne des ${f} dernières valeurs de ${c} → ${s(raw.alias) || `moyenne_mobile_${c}`}`; }
    case "croissance": { const c = s(raw.colonne) || "valeur"; return `(${c} − ${c} précédente) ÷ |${c} précédente| × 100, arrondi au dixième → ${s(raw.alias) || `croissance_${c}`} (en %)`; }
    case "cumul": { const c = s(raw.colonne) || "valeur"; return `somme cumulée de ${c} → ${s(raw.alias) || `cumul_${c}`}`; }
    case "tendance": return `régression linéaire (moindres carrés) de ${s(raw.colonne) || "valeur"} sur le rang de la période : pente, ordonnée, R²`;
    case "rang": return `rang décroissant sur ${s(raw.colonne)} → ${s(raw.alias) || "rang"}`;
    case "anomalies": return `z = 0,6745 × (x − médiane) ÷ MAD sur ${s(raw.colonne)} ; anomalie si |z| > ${s(raw.seuil) || "3,5"}`;
    case "cohortes": return `cohortes ${PAS_FR[s(raw.pas)] ?? "mensuelles"} de ${s(raw.colonneEntite) || s(raw.entite)} par première ${s(raw.colonneDate) || s(raw.date)} ; rétention = présents ÷ taille × 100`;
    case "scenario": return `${mesure(raw.mesure).replace(/ → .*$/, "")} recalculé avec ${arr(raw.variations).filter(isObj).map((v) => `${s(v.colonne)} ${Number(v.pourcent) >= 0 ? "+" : ""}${s(v.pourcent)} %`).join(", ")}`;
    case "decrire": return "profil des colonnes : type, remplissage, distincts, bornes";
    default: return `opération « ${op || "?"} »`;
  }
}

/**
 * LE JOURNAL LISIBLE : le journal du moteur (ce qui a TOURNÉ) apparié aux étapes écrites. Une étape refusée
 * n'est pas dans le journal du moteur — on avance dans les étapes écrites jusqu'à celle qui porte la même opération.
 */
export function etapesLisibles(etapes: readonly unknown[], journal: readonly JournalEtape[]): EtapeCalcul[] {
  const out: EtapeCalcul[] = [];
  let i = 0;
  for (const j of journal) {
    while (i < etapes.length && (isObj(etapes[i]) ? (s((etapes[i] as Record<string, unknown>).op) || s((etapes[i] as Record<string, unknown>).operation)).toLowerCase() : "") !== j.op) i++;
    out.push({ op: j.op, formule: i < etapes.length ? formuleDe(etapes[i]) : j.op, avant: j.avant, apres: j.apres, ...(j.note ? { note: j.note } : {}) });
    i++;
  }
  return out;
}
