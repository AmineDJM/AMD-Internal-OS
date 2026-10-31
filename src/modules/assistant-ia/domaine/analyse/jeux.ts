import type { Ligne } from "@/platform/ia/analyse/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES JEUX DE DONNÉES DU TOUR (lot K1, décision 0031) — ce qu'une analyse a le droit de prendre pour source.
 *
 * Une analyse ne calcule que sur ce qui a été LU dans ce tour, sous les droits de la personne : la sortie d'une
 * lecture (après le filtre de confidentialité — une rémunération y est déjà un repère), un tableur joint ou du
 * Drive (feuille par feuille), le résultat d'une requête SQL de direction. Le modèle désigne un jeu par son NOM
 * (« read_budget », « Ventes.xlsx#Janvier ») ; il ne recopie jamais les lignes — c'est ce qui rend le chiffre exact.
 *
 * Pur : un registre en mémoire, le temps d'un tour.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface JeuDeDonnees {
  id: string;
  /** D'où viennent les lignes, en une ligne lisible (« lecture read_budget · detail »). */
  origine: string;
  lignes: Ligne[];
  /** Les colonnes masquées à la lecture (confidentielles). */
  masquees: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9#.]+/g, "");
const LIGNES_JEU_MAX = 50_000;
const JEUX_MAX = 24;

/** Les tableaux d'objets d'une sortie JSON (trois niveaux au plus) — chacun avec son chemin. */
export function tableauxDe(sortie: string): { chemin: string; lignes: Ligne[] }[] {
  let data: unknown;
  try { data = JSON.parse(sortie); } catch { return []; }
  const out: { chemin: string; lignes: Ligne[] }[] = [];
  const visiter = (v: unknown, chemin: string, prof: number) => {
    if (prof > 3 || !v) return;
    if (Array.isArray(v)) {
      const objets = v.filter(isObj);
      if (objets.length >= 1 && objets.length >= v.length * 0.8) out.push({ chemin, lignes: objets.slice(0, LIGNES_JEU_MAX) });
      return;
    }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) visiter(x, chemin ? `${chemin}.${k}` : k, prof + 1);
  };
  visiter(data, "", 0);
  return out.sort((a, b) => b.lignes.length - a.lignes.length);
}

export class JeuxDuTour {
  private readonly jeux = new Map<string, JeuDeDonnees>();

  /** Inscrire un jeu ; un id déjà pris est remplacé (la lecture la plus récente fait foi). */
  inscrire(j: JeuDeDonnees): string {
    if (!this.jeux.has(j.id) && this.jeux.size >= JEUX_MAX) {
      const premier = this.jeux.keys().next().value;
      if (premier !== undefined) this.jeux.delete(premier);
    }
    this.jeux.set(j.id, { ...j, lignes: j.lignes.slice(0, LIGNES_JEU_MAX) });
    return j.id;
  }

  /** NOTER la sortie d'une lecture : son plus grand tableau sous le nom de l'outil, chaque tableau sous `outil.chemin`. */
  noter(outil: string, sortie: string): void {
    const tableaux = tableauxDe(sortie);
    tableaux.forEach((t, i) => {
      const id = t.chemin ? `${outil}.${t.chemin}` : outil;
      this.inscrire({ id, origine: `lecture ${outil}${t.chemin ? ` · ${t.chemin}` : ""}`, lignes: t.lignes, masquees: [] });
      if (i === 0 && t.chemin) this.inscrire({ id: outil, origine: `lecture ${outil} · ${t.chemin}`, lignes: t.lignes, masquees: [] });
    });
  }

  /** TROUVER un jeu par son nom : exact, puis plié (accents, casse, ponctuation), puis par le début (« Ventes.xlsx » → sa 1re feuille). */
  trouver(nom: string): JeuDeDonnees | null {
    const n = (nom ?? "").trim();
    if (!n) return null;
    const exact = this.jeux.get(n);
    if (exact) return exact;
    const p = plier(n);
    const tous = [...this.jeux.values()];
    return tous.find((j) => plier(j.id) === p) ?? tous.find((j) => plier(j.id).startsWith(`${p}#`)) ?? null;
  }

  /** Ce qu'on peut analyser — dit au modèle quand il se trompe de nom. */
  lister(): { id: string; lignes: number; colonnes: string[] }[] {
    return [...this.jeux.values()].map((j) => ({ id: j.id, lignes: j.lignes.length, colonnes: Object.keys(j.lignes[0] ?? {}).slice(0, 16) }));
  }

  get taille(): number { return this.jeux.size; }
}
