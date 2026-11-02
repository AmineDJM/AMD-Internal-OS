/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI EST DIT ≠ CE QUI EST CONSIGNÉ AU MODÈLE VOCAL (lot F2, banc réel du 02/11, TR-VX-02) — règle PURE, zéro import.
 *
 * Mesuré : « Combien de jours de congé il me reste ? » à la voix → la réponse commençait par « Le travail est lancé, il
 * n'y a pas encore de résultat. Dis en quelques mots que tu regardes… N'invente aucun résultat » : la CONSIGNE d'attente
 * de la délégation (K9) voyageait dans le même champ que le texte à dire (`pourVoix`), et ressortait telle quelle — à
 * l'oreille, dans la transcription, à l'écran.
 *
 * Deux canaux, jamais mêlés : `pourVoix` = ce que la voix DIT (le modèle vocal le paraphrase, l'écran peut l'afficher) ;
 * `consigne` = ce qu'on demande au modèle vocal (envoyé en contexte silencieux, jamais prononcé ni affiché).
 * `sortieOrale` est la GARDE DE SORTIE, appliquée par le serveur à tout retour vocal ET par le navigateur avant de faire
 * parler : une phrase porteuse de consigne (un impératif adressé au modèle, « la personne », « de toi-même »…) quitte
 * `pourVoix` pour `consigne` ; une parole citée (« Dis « Noté, PDF » ») reste dite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un impératif ADRESSÉ AU MODÈLE en tête de phrase (« Dis… », « N'invente… », « Récapitule… »). */
const IMPERATIF = /^(?:(?:puis|et|ensuite|alors)\s+)?(?:dis|dis-le|dis-lui|annonce|annonce-le|demande|demande-lui|redemande|redemande-lui|réponds|reponds|réponds-y|propose|pose|récapitule|recapitule|relis|termine|mentionne|interromps-toi|tais-toi|engage|recopie|attends|préviens|previens|ne|n['’]|sois|reste|parle|donne|cite|évite|evite)\b/i;
/** Des marques de consigne n'importe où dans la phrase — dont la personne nommée à la 3e personne (« elle peut dire… »). */
const MARQUE = /(?:\bde toi-m[eê]me|\bla personne (?:a dit|veut|ne |demande|n['’])|\bque tu (?:regardes|pr[ée]viens|attends)|\bn['’]invente|\bne pose pas de question|\bavec tes mots|\ben (?:trois|deux|quelques) mots|\bsans r[ée]sultat invent|\bil n['’]y a pas encore de r[ée]sultat|\bc['’]est de la conversation|\bqu['’]elle (?:n['’]a|a dit|peut|veut|change)|\belle peut (?:dire|redemander))/i;

/** Une phrase (ou une proposition) porte-t-elle une consigne au modèle vocal ? */
export const porteUneConsigne = (phrase: string): boolean => {
  const t = phrase.trim().replace(/^[\s,;:—–-]+/, "");
  return !!t && (IMPERATIF.test(t) || MARQUE.test(t));
};

/** Les morceaux d'un texte : phrases, propositions séparées par « ; », « — » ou « : » (sans couper une citation « … » ni une parenthèse). */
function morceaux(texte: string): string[] {
  const out: string[] = [];
  let cur = "";
  let cite = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i]!;
    cur += c;
    if (c === "«" || c === "(") cite++;
    else if (c === "»" || c === ")") cite = Math.max(0, cite - 1);
    if (cite) continue;
    const fin = /[.!?]/.test(c) && (i + 1 >= texte.length || /\s/.test(texte[i + 1]!));
    const sep = c === ";" || ((c === "—" || c === ":") && /\s/.test(texte[i - 1] ?? "") && /\s/.test(texte[i + 1] ?? ""));
    if (fin || sep) { out.push(cur); cur = ""; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** La parole CITÉE d'une consigne (« Dis en quelques mots « Noté, PDF » … » → « Noté, PDF »), à dire telle quelle. */
const citee = (m: string): string | null => {
  const q = /«\s*([^»]+?)\s*»/.exec(m);
  return q && /^\s*(?:dis|r[ée]ponds|termine par|demande)(?:\s+(?:simplement|en\s+(?:quelques|trois|deux)\s+mots))?\s*«/i.test(m) ? q[1]!.trim() : null;
};

const propre = (s: string): string => s.replace(/\s+/g, " ").replace(/^[\s,;:—–-]+/, "").replace(/[\s,;:—–-]+$/, "").trim();
const finir = (s: string): string => (s && !/[.!?…»]$/.test(s) ? `${s}.` : s);

/** Sépare un texte en ce qui se DIT (ses morceaux gardés tels quels, ponctuation comprise) et ce qui se CONSIGNE au modèle. */
export function separerDitEtConsigne(texte: string): { dit: string; consigne: string } {
  let dit = "";
  const consignes: string[] = [];
  for (const m of morceaux(texte ?? "")) {
    const p = propre(m);
    if (!p) continue;
    if (!porteUneConsigne(p)) { dit += m; continue; }
    consignes.push(finir(p));
    const c = citee(p);
    if (c) dit += ` ${finir(c)} `;
  }
  return { dit: finir(propre(dit)), consigne: consignes.join(" ").trim() };
}

/**
 * LA GARDE DE SORTIE d'un retour vocal : `pourVoix` ne garde que ce qui se dit ; toute consigne (celle déclarée par le
 * serveur et celle qui se serait glissée dans le texte) passe dans `consigne`. Rien d'autre ne change.
 */
export function sortieOrale<T extends { pourVoix: string; consigne?: string }>(r: T): T {
  const { dit, consigne } = separerDitEtConsigne(r.pourVoix ?? "");
  const toutes = [r.consigne?.trim(), consigne].filter(Boolean).join(" ");
  return { ...r, pourVoix: dit, ...(toutes ? { consigne: toutes } : {}) };
}
