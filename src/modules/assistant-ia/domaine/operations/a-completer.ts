/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE « À COMPLÉTER » (lot P1 bis, décision 0047 — banc d'audit Q1 AP-01, 02, 03, 05) — règles PURES, zéro import.
 *
 * Constat : « Quelle est l'institution bénéficiaire ? » posée, la personne répond autre chose (produit, BU, stand), et
 * l'assistant finit par « aucune carte ». Désormais, une question légitime posée UNE fois et restée sans réponse donne
 * QUAND MÊME la carte : ce qui est connu y est, le champ manquant y est un champ à remplir ; à la signature, la saisie
 * rejoint la demande et le geste REVÉRIFIE tout (sa proposition est rejouée) avant d'exécuter.
 *
 * Les opérations disent ce qui manque en FRANÇAIS (« l'institution ou l'association bénéficiaire ») : le champ du schéma
 * se retrouve par les mots (nom et description du champ). Pas de correspondance sûre : pas de carte à compléter — on le
 * dit, sans deviner.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ChampACompleter { nom: string; libelle: string; type: "texte" | "date" | "nombre"; valeurs: string[] | null }

const plier = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const VIDES = new Set(["quel", "quelle", "quels", "quelles", "pour", "avec", "dans", "les", "des", "une", "est", "sont", "faut", "nom", "the", "votre", "cette", "demande"]);
const mots = (t: string) => plier(t).split(/[^a-z0-9]+/).filter((m) => m.length >= 4 && !VIDES.has(m)).map((m) => m.slice(0, 7));

/** Le champ du schéma que désigne une phrase de `manque` — le plus de mots communs (nom, description) ; `null` si aucun. */
export function champDuManque(schema: unknown, phrase: string): ChampACompleter | null {
  const props = (schema && typeof schema === "object" ? (schema as { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }> }).properties : null) ?? {};
  const q = new Set(mots(phrase));
  const brut = new Set(plier(phrase).split(/[^a-z0-9]+/).filter(Boolean));
  let meilleur: { nom: string; score: number } | null = null;
  for (const [nom, p] of Object.entries(props)) {
    if (p?.type && !["string", "number"].includes(p.type)) continue;
    const ms = new Set([...mots(nom.replace(/([a-z])([A-Z])/g, "$1 $2")), ...mots(p?.description ?? "")]);
    // Un nom de champ court (« fin », « nom ») écrit tel quel dans la phrase vaut plus qu'un mot de description.
    const exact = brut.has(plier(nom)) ? 2 : 0;
    const score = [...q].filter((m) => ms.has(m)).length + exact;
    if (score > 0 && (!meilleur || score > meilleur.score)) meilleur = { nom, score };
  }
  if (!meilleur) return null;
  const p = props[meilleur.nom]!;
  const date = /\bdate\b|aaaa-mm-jj|jour/.test(plier(`${meilleur.nom} ${p.description ?? ""}`));
  return {
    nom: meilleur.nom, libelle: phrase.charAt(0).toUpperCase() + phrase.slice(1),
    type: p.type === "number" ? "nombre" : date ? "date" : "texte",
    valeurs: Array.isArray(p.enum) ? p.enum.map(String) : null,
  };
}

/** Tous les champs manquants retrouvés — ou `null` dès qu'un seul ne l'est pas (on ne montre pas une carte à moitié juste). */
export function champsACompleter(schema: unknown, manque: readonly string[]): ChampACompleter[] | null {
  const out: ChampACompleter[] = [];
  for (const m of manque) {
    const c = champDuManque(schema, m);
    if (!c) return null;
    if (!out.some((x) => x.nom === c.nom)) out.push(c);
  }
  return out.length ? out : null;
}
