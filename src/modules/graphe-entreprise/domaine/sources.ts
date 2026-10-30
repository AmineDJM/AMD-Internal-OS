/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CHAQUE CHIFFRE PORTE SA SOURCE (J9, décision 0021) — règle PURE, zéro import.
 *
 * Ce que les outils du graphe rendent au modèle est une liste d'objets DONNÉES ; chaque objet qui porte une valeur
 * chiffrée (un capital, une date, un NIF, un identifiant) porte aussi sa `source`. `chiffresSansSource` le vérifie :
 * c'est le banc qui le tient (100 % des chiffres servis avec leur source), pas la bonne volonté.
 *
 * Le sous-arbre `meta` (profondeur demandée, bornes, compte de résultats) décrit la réponse elle-même : il n'est pas
 * une donnée de l'entreprise et n'est pas compté.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CHIFFRE = /\d/;
const HORS_DONNEES = new Set(["meta", "source", "sources", "question", "note", "consigne"]);

const aSource = (o: Record<string, unknown>): boolean => {
  const s = o.source;
  return (typeof s === "string" && s.trim().length > 0) || (!!s && typeof s === "object");
};

/**
 * Les chemins des valeurs chiffrées qui n'ont AUCUNE source dans les objets qui les contiennent (la racine exceptée :
 * une source posée tout en haut ne vaudrait pour rien de précis).
 */
export function chiffresSansSource(sortie: unknown): string[] {
  const fautes: string[] = [];
  const visiter = (v: unknown, chemin: string, sourcee: boolean, profondeur: number) => {
    if (v === null || v === undefined) return;
    if (typeof v === "number" || (typeof v === "string" && CHIFFRE.test(v))) {
      if (!sourcee) fautes.push(chemin);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visiter(x, `${chemin}[${i}]`, sourcee, profondeur + 1)); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const ici = sourcee || (profondeur > 0 && aSource(o));
      for (const [k, x] of Object.entries(o)) {
        if (HORS_DONNEES.has(k)) continue;
        visiter(x, chemin ? `${chemin}.${k}` : k, ici, profondeur + 1);
      }
    }
  };
  visiter(sortie, "", false, 0);
  return fautes;
}

/** Le compte d'un banc : combien de valeurs chiffrées, combien sourcées. */
export function compterChiffres(sortie: unknown): { total: number; sourcees: number } {
  let total = 0;
  const compter = (v: unknown, cle: string | null) => {
    if (cle && HORS_DONNEES.has(cle)) return;
    if (typeof v === "number" || (typeof v === "string" && CHIFFRE.test(v))) { total++; return; }
    if (Array.isArray(v)) v.forEach((x) => compter(x, null));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) compter(x, k);
  };
  compter(sortie, null);
  return { total, sourcees: total - chiffresSansSource(sortie).length };
}
