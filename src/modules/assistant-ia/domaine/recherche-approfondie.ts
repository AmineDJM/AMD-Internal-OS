/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RECHERCHE APPROFONDIE — les RÈGLES (K3, décision 0033 § 7). Pur.
 *
 * Direction : « des recherches web aussi puissantes que ChatGPT ». Une demande de veille, d'étude de marché ou de
 * réglementation devient UNE mission dont les étapes sont plusieurs SOUS-RECHERCHES web (`web_research`, une par
 * angle, en parallèle sous la concurrence du moteur), puis un RAPPORT complet — sommaire, sections, chiffres datés,
 * toutes les sources numérotées —, déposé au Drive en Word ET en PDF, affiché en entier dans la conversation à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NOM_OUTIL_RECHERCHE = "recherche_approfondie";
/** L'origine posée sur la mission (`Mission.context`) : la synthèse affiche alors le rapport EN ENTIER. */
export const ORIGINE_RECHERCHE = "assistant-ia:recherche-approfondie";
export const ANGLES_MIN = 2;
export const ANGLES_MAX = 6;

export const CONSIGNE_RAPPORT = [
  "Rédige un RAPPORT DE RECHERCHE complet, en français, en Markdown, à partir des sorties des sous-recherches web fournies (et d'elles seules).",
  "Structure : `# Titre` ; une ligne « Recherche du AAAA-MM-JJ » ; `## Sommaire` (la liste des sections) ; `## Synthèse` (l'essentiel en 5 à 8 puces) ; une section `##` par angle, détaillée (chiffres, dates, acteurs, tableaux quand ils aident) ; `## Limites et points à vérifier` ; `## Sources`.",
  "Chaque chiffre est DATÉ (« au 30/06/2026 », « en 2025 ») et suivi de l'appel de sa source entre crochets, [1], [2]… Les sources sont NUMÉROTÉES une seule fois dans `## Sources` : « [n] Titre — URL ». N'en invente aucune : seulement les URL présentes dans les sorties.",
  "Si les sources se contredisent ou sont anciennes, dis-le. Ce qui n'a pas été trouvé se dit comme tel. Aucun préambule, aucun JSON.",
].join("\n");

export interface DemandeRecherche {
  sujet: string;
  angles: string[];
  contexte?: string;
  titre?: string;
}

const txt = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Relit l'entrée du modèle : un sujet, 2 à 6 angles distincts (sinon trois angles par défaut, dits). */
export function lireDemandeRecherche(brut: unknown): { ok: true; demande: DemandeRecherche } | { ok: false; fautes: string[] } {
  const o = brut && typeof brut === "object" ? (brut as Record<string, unknown>) : {};
  const sujet = txt(o.sujet, 300);
  if (sujet.length < 4) return { ok: false, fautes: ["`sujet` : la question de recherche, en une phrase."] };
  const vus = new Set<string>();
  let angles = (Array.isArray(o.angles) ? o.angles : []).map((a) => txt(a, 200)).filter((a) => a && !vus.has(a.toLowerCase()) && vus.add(a.toLowerCase()));
  if (angles.length < ANGLES_MIN) angles = ["état des lieux et chiffres clés récents", "acteurs, produits et concurrence", "réglementation, tendances et perspectives"];
  return { ok: true, demande: { sujet, angles: angles.slice(0, ANGLES_MAX), contexte: txt(o.contexte, 600) || undefined, titre: txt(o.titre, 120) || undefined } };
}

/** LE PLAN : une LECTURE `web_research` par angle (sans dépendance : elles partent ensemble), puis le rapport en PDF (+ Word). */
export function planRecherche(d: DemandeRecherche): Record<string, unknown> {
  const recherches = d.angles.map((angle, i) => ({
    cle: `recherche-${i + 1}`, titre: `Recherche — ${angle}`.slice(0, 160), type: "LECTURE", outil: "web_research",
    entree: { query: `${d.sujet} — ${angle}`, ...(d.contexte ? { contexte: d.contexte } : {}) },
  }));
  return {
    titre: (d.titre ?? `Recherche approfondie — ${d.sujet}`).slice(0, 160),
    objectif: `Recherche approfondie sur le web : ${d.sujet}. Rapport complet, sourcé, en Word et en PDF.`,
    etapes: [
      ...recherches,
      { cle: "rapport", titre: "Rapport de recherche", type: "LIVRABLE", format: "pdf", apres: recherches.map((r) => r.cle), consigne: CONSIGNE_RAPPORT },
    ],
  };
}
