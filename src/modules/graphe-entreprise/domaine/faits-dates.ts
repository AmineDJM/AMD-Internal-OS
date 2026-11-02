/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAITS BITEMPORELS (J9, décision 0021) — règle PURE, zéro import.
 *
 * Deux temps, jamais confondus :
 *   • le temps de VALIDITÉ — `valideDu` / `valideAu` : quand c'était vrai dans le monde ;
 *   • le temps de CONSTAT — `confirmeLe` / `fermeLe` : quand le référentiel l'a su, puis cessé de le tenir pour vrai.
 *
 * UN FAIT PÉRIMÉ SE FERME, IL N'EST JAMAIS ÉCRASÉ : on pose `valideAu` (fin de validité), `fermeLe` (le jour où on l'a
 * clos), `fermeParId` (qui) et `remplaceParId` (le fait qui le remplace). La ligne reste ; l'histoire se relit.
 *
 *   « Quelle était la raison sociale le 3 mars ? »                  → `etatA(faits, 3 mars)`
 *   « Que savait-on le 3 mars de la raison sociale au 1er janvier ? » → `etatA(faits, 1er janvier, { connuLe: 3 mars })`
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FaitDate {
  id: string;
  attribut: string;
  valeur: string | null;
  valideDu: Date | null;
  valideAu: Date | null;
  confirmeLe: Date;
  fermeLe: Date | null;
  source: string;
  pieceId: string | null;
  confirmeParId: string | null;
}

/** Vrai dans le monde à cet instant (temps de validité). Sans `valideDu`, il vaut depuis sa confirmation. */
export function vraiA(f: FaitDate, quand: Date): boolean {
  const debut = (f.valideDu ?? f.confirmeLe).getTime();
  return quand.getTime() >= debut && (!f.valideAu || quand.getTime() < f.valideAu.getTime());
}

/** Tenu pour vrai par le référentiel à cet instant (temps de constat). */
export function tenuA(f: FaitDate, quand: Date): boolean {
  return f.confirmeLe.getTime() <= quand.getTime() && (!f.fermeLe || quand.getTime() < f.fermeLe.getTime());
}

/**
 * Ce que le référentiel savait à `connuLe` : la ligne existait, et sa fin de validité n'était pas encore posée. Un fait
 * fermé APRÈS `connuLe` était alors ouvert — on lit sa validité telle qu'elle était, sans la borne ajoutée plus tard.
 */
function telQuOnLeSavait(f: FaitDate, connuLe: Date): FaitDate | null {
  if (f.confirmeLe.getTime() > connuLe.getTime()) return null;
  if (f.fermeLe && f.fermeLe.getTime() > connuLe.getTime()) return { ...f, valideAu: null, fermeLe: null };
  return f;
}

export interface ValeurALaDate {
  attribut: string;
  /** Une valeur pour un attribut à valeur unique ; plusieurs pour un attribut multiple (adresses, sites). */
  valeurs: { valeur: string | null; faitId: string; source: string; pieceId: string | null; depuis: Date; confirmeLe: Date }[];
}

export interface EtatALaDate {
  date: Date;
  connuLe: Date | null;
  valeurs: ValeurALaDate[];
  /** Les attributs que l'on connaît du sujet, mais pas à cette date (ni avant sa première confirmation). */
  inconnus: string[];
}

/** L'état d'un sujet à une date (et, au besoin, tel qu'on le savait à une autre date). */
export function etatA(faits: readonly FaitDate[], date: Date, o: { connuLe?: Date | null } = {}): EtatALaDate {
  const lus = o.connuLe ? faits.map((f) => telQuOnLeSavait(f, o.connuLe!)).filter((f): f is FaitDate => !!f) : [...faits];
  const parAttribut = new Map<string, ValeurALaDate>();
  for (const f of lus) {
    if (!vraiA(f, date)) continue;
    const v = parAttribut.get(f.attribut) ?? { attribut: f.attribut, valeurs: [] };
    v.valeurs.push({ valeur: f.valeur, faitId: f.id, source: f.source, pieceId: f.pieceId, depuis: f.valideDu ?? f.confirmeLe, confirmeLe: f.confirmeLe });
    parAttribut.set(f.attribut, v);
  }
  for (const v of parAttribut.values()) v.valeurs.sort((a, b) => b.depuis.getTime() - a.depuis.getTime());
  const connus = new Set(faits.map((f) => f.attribut));
  return {
    date, connuLe: o.connuLe ?? null,
    valeurs: [...parAttribut.values()].sort((a, b) => a.attribut.localeCompare(b.attribut)),
    inconnus: [...connus].filter((a) => !parAttribut.has(a)).sort(),
  };
}

/** L'histoire d'un attribut, de la plus ancienne valeur à la plus récente. */
export function histoire(faits: readonly FaitDate[], attribut: string): FaitDate[] {
  return faits.filter((f) => f.attribut === attribut)
    .sort((a, b) => (a.valideDu ?? a.confirmeLe).getTime() - (b.valideDu ?? b.confirmeLe).getTime());
}

/**
 * LA FERMETURE d'un fait remplacé — les colonnes à écrire, rien d'autre. `valideAu` est la fin de validité (le début de
 * validité du remplaçant quand on le connaît, sinon maintenant) ; `fermeLe` le temps de constat.
 */
export function fermeture(o: { maintenant: Date; parId: string | null; remplaceParId?: string | null; finDeValidite?: Date | null }) {
  return {
    actif: false,
    valideAu: o.finDeValidite ?? o.maintenant,
    fermeLe: o.maintenant,
    fermeParId: o.parId,
    remplaceParId: o.remplaceParId ?? null,
  };
}
