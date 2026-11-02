/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « JE N'AI PAS PU » — une PHRASE pour l'humain, un ÉCHEC pour le runtime.
 *
 * ── LE DÉFAUT MESURÉ, ET IL PORTAIT LE MASQUE D'UN SUCCÈS ───────────────────────────────
 *
 * Run Render, scénario SATISFIABLE. `list_artifacts` retrouve la synthèse ; `read_document` est
 * appelée dessus et rend :
 *
 *     "Pièce introuvable ou sans fichier."
 *
 * Rien n'a levé d'exception, la chaîne n'est pas vide, et l'exécutant de mission a rangé cette
 * phrase comme un RÉSULTAT. L'étape est passée DONE. Le juge d'objectif a reçu, comme preuve
 * qu'un document avait été lu, une phrase disant que la lecture n'avait pas eu lieu.
 *
 * ── LE FRÈRE JUMEAU DE `empty-result.ts`, ET POUR LA MÊME RAISON ────────────────────────
 *
 * On aurait pu apprendre au runtime à reconnaître « introuvable », « indisponible », « non
 * extractible ». C'est exactement ce que `empty-result.ts` refuse de faire pour « aucun » : un
 * fait déduit d'une tournure française est une preuve fabriquée. Ici le risque est symétrique et
 * tout aussi coûteux — le jour où une capacité écrit « le dossier est introuvable DANS LE DRIVE,
 * mais le voici depuis Legal », la reconnaissance de motif transformerait un succès en panne.
 *
 * La seule façon honnête est que la capacité DISE qu'elle a échoué, puisque c'est elle qui le
 * sait. `echec` porte la cause dans la taxonomie §75 ; `message` porte la phrase, mot pour mot,
 * pour la conversation qui la lira comme avant.
 *
 * ── POURQUOI LA CAUSE EST UNE CHAÎNE ET NON UN TYPE IMPORTÉ ─────────────────────────────
 *
 * `ErrorKind` vit dans `src/lib/missions/`, une FAÇADE (L2). Adam la consomme par le contrat de
 * plateforme, jamais par un import direct — `boundary.test.ts` le vérifie, et le contourner pour
 * une commodité de typage ouvrirait la porte que ce test existe pour tenir fermée.
 *
 * La liste ci-dessous est donc locale, et `capability-failure.test.ts` vérifie qu'elle reste un
 * SOUS-ENSEMBLE de `ERROR_KINDS`. Si quelqu'un y ajoute une cause inventée, le test tombe ; et
 * côté runtime, une cause non reconnue retombe sur `CAPABILITY_FAILURE` — jamais sur un succès.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES CAUSES QU'UNE CAPACITÉ DE LECTURE SAIT NOMMER.
 *
 * Un sous-ensemble volontaire des douze causes §75 : celles qu'un outil peut CONSTATER lui-même.
 * `PROVIDER_FAILURE` ou `QA_FAILED` n'y sont pas — ce n'est pas l'outil qui les observe.
 */
export const ECHECS_CAPACITE = [
  /** La chose cherchée n'est pas LÀ où on a cherché. */
  "NOT_FOUND",
  /** Un document précis, nommé, est introuvable. */
  "MISSING_DOCUMENT",
  /** Le fichier existe mais on ne sait pas le lire (scan sans OCR, format opaque). */
  "UNKNOWN_FORMAT",
  /** L'acteur n'a pas le droit. Réessayer ne fait pas apparaître un droit. */
  "MISSING_PERMISSION",
  /** Il manque une donnée d'entrée que seul l'appelant peut fournir. */
  "MISSING_INPUT",
  /** L'outil a échoué pour une raison qui lui est propre. */
  "CAPABILITY_FAILURE",
] as const;
export type EchecCapacite = (typeof ECHECS_CAPACITE)[number];

/**
 * UN ÉCHEC DE CAPACITÉ, CANONIQUE.
 *
 * `echec` est ce que le runtime lit pour choisir un recours — chercher ailleurs sur `NOT_FOUND`,
 * ne pas insister sur `MISSING_PERMISSION`. `message` reste la phrase d'origine : la
 * conversation continue de l'afficher, et rien n'y perd en lisibilité.
 */
export function resultatIndisponible(
  echec: EchecCapacite,
  message: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ echec, message, ...extra });
}
