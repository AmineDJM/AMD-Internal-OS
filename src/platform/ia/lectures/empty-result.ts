/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « JE N'AI RIEN TROUVÉ » — une PHRASE pour l'humain, un FAIT pour le runtime.
 *
 * ── LE DÉFAUT MESURÉ, ET IL A COÛTÉ TROIS REPLANIFICATIONS ──────────────────────────────
 *
 * Un run Render, scénario PREUVE_ABSENCE. La mission devait établir qu'il n'existe rien sur une
 * molécule. Elle a interrogé les produits, le Drive, les marchés, le corpus — correctement, et
 * chaque recherche a rendu une phrase :
 *
 *     "Aucun produit ne correspond à « Zorbamyxine-K7 »."
 *
 * Humainement juste. Machinalement muette. Le juge d'objectif ne pouvait pas citer « zéro
 * résultat » comme preuve, parce qu'aucun code n'avait COMPTÉ zéro — quelqu'un l'avait ÉCRIT.
 * La mission a alors brûlé trois replanifications à faire reformuler par un modèle un fait que
 * la requête SQL connaissait déjà.
 *
 * ── POURQUOI CE N'EST PAS RÉSOLU EN DEVINANT ────────────────────────────────────────────
 *
 * On aurait pu apprendre au runtime à reconnaître « Aucun… » et en déduire zéro. C'est
 * précisément ce que `runtime/receipt.ts` REFUSE de faire, et pour une bonne raison : zéro est
 * une affirmation qui autorise le juge à conclure à l'absence. La déduire d'une tournure de
 * phrase, c'est fabriquer une preuve à partir d'une expression française — et le jour où une
 * capacité écrit « Aucun filtre n'a été appliqué », le juge signerait une absence qui n'existe
 * pas.
 *
 * La seule façon honnête est que la capacité DISE le compte, puisque c'est elle qui l'a mesuré.
 *
 * ── CE QUE LA CONVERSATION Y PERD : RIEN ────────────────────────────────────────────────
 *
 * La phrase reste, sous `message`. L'assistant la lit et la restitue comme avant. On n'a pas
 * remplacé la prose par de la structure : on a ajouté la structure SOUS la prose.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * UN RÉSULTAT VIDE, CANONIQUE.
 *
 * `items: []` et `count: 0` sont ce que `compterResultats` sait lire — un seul tableau, sans
 * ambiguïté, donc un compte mesuré et non deviné. C'est ce compte qui devient, dans le compte
 * rendu au juge, une ligne de PREUVE NÉGATIVE horodatée avec sa requête.
 *
 * `message` porte la phrase d'origine, mot pour mot : elle sert à l'humain, et parfois elle dit
 * quelque chose que le compte ne dit pas (« le portefeuille compte 69 produits au total »).
 */
export function resultatVide(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ items: [], count: 0, message, ...extra });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ET LA MÊME FORME QUAND ON TROUVE (§118.20) — sinon la moitié du travail est perdue.
 *
 * `resultatVide` donnait au runtime un compte MESURÉ quand la liste était vide. Mais le cas
 * PLEIN, lui, rendait ce que chaque capacité avait envie : `{ produits }` ici, `{ collegues }`
 * là, `{ taches }` ailleurs — jamais `items`, jamais `count`. Résultat : les deux sorties d'une
 * même capacité n'avaient PAS UNE CLÉ EN COMMUN. Le planificateur écrit ses références avant de
 * savoir si la recherche trouvera quelque chose : `{{produits.produits.0.reference}}` mourait le
 * jour où il n'y avait rien, et `{{produits.items}}` le jour où il y avait quelque chose. Une
 * étape morte coûte une replanification complète.
 *
 * Une seule enveloppe, donc, dans les DEUX cas : `items` (la liste, vide ou non), `count` (son
 * compte, mesuré et non déduit d'une tournure de phrase) et `message` (la phrase pour l'humain).
 * Ce que la capacité a de PROPRE — le total du portefeuille, un avertissement de troncature —
 * s'ajoute à côté, sans jamais remplacer l'enveloppe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function resultatListe(
  items: readonly unknown[],
  message: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ items, count: items.length, message, ...extra });
}
