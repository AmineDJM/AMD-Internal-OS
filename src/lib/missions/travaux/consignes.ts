/**
 * LES CONSIGNES DES ÉTAPES DE MODÈLE D'UN TRAVAIL (J2) — pures : ce que l'analyse et le livrable
 * demandent au modèle, et la lecture tolérante de ce qu'il rend. Le modèle reçoit le CARNET (borné),
 * jamais l'historique entier.
 */

export const consigneAnalyse = (persona: string): string => [
  `Tu es ${persona}, et tu mènes un TRAVAIL LONG pour une personne de l'entreprise, étape par étape, en arrière-plan.`,
  "Tu reçois le carnet du travail (objectif, plan, trouvailles et notes déjà écrites), la consigne de CETTE étape, ses entrées et les sorties des étapes dont elle dépend.",
  "Fais SEULEMENT cette étape. N'invente aucun chiffre, nom ni date : appuie-toi sur les entrées et les sorties fournies ; ce qui manque se dit.",
  "Réponds UNIQUEMENT en JSON : {\"resultat\": \"ce que l'étape conclut, en quelques phrases\", \"trouvailles\": [\"un fait utile pour la suite, avec sa source\"], \"notes\": [\"ce qu'une étape suivante doit savoir\"]}.",
].join("\n");

export const consigneLivrable = (persona: string): string => [
  `Tu es ${persona}, et tu rédiges le LIVRABLE d'un travail long mené pour une personne de l'entreprise.`,
  "Appuie-toi UNIQUEMENT sur le carnet (trouvailles, notes) et les sorties des étapes fournies. N'invente rien ; ce qui n'a pas pu être établi se dit comme tel.",
  "Rends le document en Markdown (titres, listes, tableaux au besoin), en français, prêt à être lu par la personne — sans préambule ni JSON.",
].join("\n");

/** Une sortie amont rendue lisible et BORNÉE — un éventail de cinquante lots ne fait pas exploser l'appel. */
export function sortieLisible(v: unknown, max = 6_000): string {
  const t = typeof v === "string" ? v : JSON.stringify(v ?? null, null, 0);
  return t.length > max ? `${t.slice(0, max)}… [tronqué, ${t.length} caractères]` : t;
}

export function texteEtape(p: {
  carnet: string;
  titre: string;
  consigne: string;
  entrees: Record<string, unknown>;
  amont: { cle: string; titre: string; sortie: unknown }[];
  maxAmont?: number;
}): string {
  const budgetAmont = p.maxAmont ?? 24_000;
  const parAmont = Math.max(1_500, Math.floor(budgetAmont / Math.max(1, p.amont.length)));
  const lignes = [
    "── CARNET DU TRAVAIL ──", p.carnet,
    "", `── ÉTAPE : ${p.titre} ──`, `CONSIGNE : ${p.consigne || "(aucune)"}`,
  ];
  if (Object.keys(p.entrees).length) lignes.push(`ENTRÉES : ${sortieLisible(p.entrees, 12_000)}`);
  for (const a of p.amont) lignes.push(`SORTIE DE « ${a.titre} » (${a.cle}) : ${sortieLisible(a.sortie, parAmont)}`);
  return lignes.join("\n");
}

/** Lit la réponse d'une analyse : le JSON demandé, ou — à défaut — le texte entier comme résultat. */
export function lireAnalyse(texte: string): { resultat: string; trouvailles: string[]; notes: string[] } {
  const brut = texte.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const debut = brut.indexOf("{");
  const fin = brut.lastIndexOf("}");
  if (debut >= 0 && fin > debut) {
    try {
      const o = JSON.parse(brut.slice(debut, fin + 1)) as Record<string, unknown>;
      const liste = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 30) : []);
      const resultat = typeof o.resultat === "string" ? o.resultat : "";
      if (resultat || liste(o.trouvailles).length || liste(o.notes).length) {
        return { resultat, trouvailles: liste(o.trouvailles), notes: liste(o.notes) };
      }
    } catch { /* la réponse n'était pas du JSON : le texte entier fait foi, ci-dessous */ }
  }
  return { resultat: texte.trim(), trouvailles: [], notes: [] };
}
