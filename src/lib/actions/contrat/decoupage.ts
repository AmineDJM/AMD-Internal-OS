/**
 * DÉCOUPAGE DE LA SOURCE — trouver les actions exportées d'un fichier et les fonctions locales,
 * avec leur signature et leur corps, par équilibrage des délimiteurs.
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import type { SourceAction } from "./types";

/** Le texte sans ses commentaires (blocs et lignes) — une prose ne doit rien déclencher. */
export const sansCommentaires = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const RE_ENTETE = /^export async function ([A-Za-z0-9_]+)\s*\(/gm;

/** Le contenu d'un couple de délimiteurs, par équilibrage. `null` si jamais refermé. */
function equilibrer(source: string, ouvre: number, o: string, f: string): { texte: string; fin: number } | null {
  if (source[ouvre] !== o) return null;
  let profondeur = 0;
  for (let i = ouvre; i < source.length; i++) {
    if (source[i] === o) profondeur++;
    else if (source[i] === f) {
      profondeur--;
      if (profondeur === 0) return { texte: source.slice(ouvre + 1, i), fin: i + 1 };
    }
  }
  return null;
}

/**
 * OÙ COMMENCE LE CORPS — la question a l'air triviale et ne l'est pas.
 *
 * Entre la parenthèse des paramètres et l'accolade du corps, il peut y avoir un type de retour,
 * et ce type peut CONTENIR une accolade : `Promise<{ ok: boolean; error?: string }>`. Prendre
 * « la prochaine accolade » découperait un corps qui commence au milieu du type de retour —
 * l'action rendrait alors moins de champs, ce qui ressemble à une action plus simple, jamais à
 * une erreur. On avance donc en suivant la profondeur des chevrons ET des accolades : le corps
 * s'ouvre à la première accolade rencontrée hors de tout type.
 *
 * ET UN TYPE OBJET PEUT ÊTRE NU — `): { ok: true; demande: X } | { ok: false; error: string } {`.
 * Là, aucun chevron ne l'enveloppe : la première version prenait l'accolade du type pour celle
 * du corps, et le « corps » de la fonction devenait `{ ok: true; demande: X }`. Mesuré sur le
 * parc : CINQ fonctions locales découpées ainsi, dont `lireDemande` — le délégué qui lit les
 * trente champs d'une pièce commerciale — et l'action sortait « aucune lecture de champ trouvée »
 * à trois lignes de ses lectures (§118.78, encore). La règle qui distingue les deux accolades
 * est syntaxique, pas devinée : une accolade ouvre un TYPE quand ce qui la précède attend un
 * opérande de type (`:`, `|`, `&`, `,`, `<`, `(`, `[`, `=>`) ; sinon, c'est le corps. Un type
 * objet reconnu est sauté EN BLOC, chevrons ou pas.
 */
const ATTEND_UN_TYPE = new Set([":", "|", "&", ",", "<", "(", "[", "=>"]);

function debutDuCorps(source: string, apresParams: number): number {
  let profondeur = 0; // chevrons, parenthèses et crochets du type de retour
  let precedent = ""; // le dernier caractère significatif lu (« => » compte pour un)
  for (let i = apresParams; i < source.length; i++) {
    const c = source[i]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    if (c === "<" || c === "(" || c === "[") profondeur++;
    else if (c === ">" || c === ")" || c === "]") {
      if (profondeur > 0) profondeur--;
      if (c === ">" && precedent === "=") { precedent = "=>"; continue; }
    } else if (c === "{") {
      if (profondeur === 0 && !ATTEND_UN_TYPE.has(precedent)) return i;
      const bloc = equilibrer(source, i, "{", "}");
      if (!bloc) return -1;
      i = bloc.fin - 1;
      precedent = "}";
      continue;
    } else if (c === ";" && profondeur === 0) return -1; // une surcharge sans corps
    precedent = c;
  }
  return -1;
}

/**
 * Les actions exportées d'un fichier, avec leur signature et leur corps.
 *
 * Le découpage se fait par ÉQUILIBRAGE, pas par expression régulière : une première version
 * exigeait `)\s*:` — donc un type de retour — et perdait en silence les trois actions qui n'en
 * déclarent pas. C'est le recoupement avec le registre de parité qui l'a dit ; seul, ce module
 * aurait affiché « 709 actions » avec l'assurance d'en avoir vu 712.
 */
export function decouperActions(fichier: string, source: string): SourceAction[] {
  const out: SourceAction[] = [];
  RE_ENTETE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENTETE.exec(source)) !== null) {
    const params = equilibrer(source, m.index + m[0].length - 1, "(", ")");
    if (!params) continue;
    const ouvre = debutDuCorps(source, params.fin);
    if (ouvre < 0) continue;
    const corps = equilibrer(source, ouvre, "{", "}");
    out.push({
      fichier, fonction: m[1]!,
      signature: params.texte.replace(/\s+/g, " ").trim(),
      corps: corps ? `{${corps.texte}}` : source.slice(ouvre),
    });
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ACTION QUI DÉLÈGUE SA LECTURE A QUAND MÊME UNE ENTRÉE — cinq actions le disaient en creux.
 *
 * `createStockAnnex(formData) { return createStockLocation(formData, "ANNEX"); }` sortait avec
 * « aucune lecture de champ trouvée dans le corps — l'entrée attendue reste inconnue ». C'était
 * vrai de SON corps et faux de l'action : la fonction voisine, dans le MÊME fichier, lit `name`
 * à la ligne suivante. Encore §118.78 : le refus était écrit à trois lignes de ce qu'il
 * déclarait ignorer.
 *
 * ── UN SEUL NIVEAU, ET LE MÊME FICHIER ───────────────────────────────────────────────────
 *
 * On ne suit pas une délégation vers un autre module : son texte n'est pas là, et prétendre le
 * contraire rendrait une liste de champs inventée. On ne suit pas non plus deux niveaux : la
 * règle « ce qu'on ne relie pas au formulaire à coup sûr ne déclenche rien » vaut ici comme
 * ailleurs, et un niveau suffit au parc mesuré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const RE_LOCALE = /^(?:export\s+)?(?:async\s+)?function ([A-Za-z0-9_]+)\s*\(/gm;

export function fonctionsLocales(source: string): Record<string, SourceAction> {
  const out: Record<string, SourceAction> = {};
  RE_LOCALE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_LOCALE.exec(source)) !== null) {
    const params = equilibrer(source, m.index + m[0].length - 1, "(", ")");
    if (!params) continue;
    const ouvre = debutDuCorps(source, params.fin);
    if (ouvre < 0) continue;
    const corps = equilibrer(source, ouvre, "{", "}");
    out[m[1]!] = {
      fichier: "", fonction: m[1]!,
      signature: params.texte.replace(/\s+/g, " ").trim(),
      corps: corps ? `{${corps.texte}}` : source.slice(ouvre),
    };
  }
  return out;
}
