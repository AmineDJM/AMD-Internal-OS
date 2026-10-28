/**
 * COMPTER CE QU'ON ENVOIE — honnêtement.
 *
 * CE MODULE ESTIME, IL NE MESURE PAS. Aucun tokeniseur du fournisseur n'est installé dans ce
 * dépôt, et en installer un pour compter des prompts serait payer une dépendance native (et un
 * mégaoctet de tables BPE) pour une précision dont on n'a pas besoin. Ce qui est EXACT ici, c'est
 * le nombre de CARACTÈRES ; les tokens sont dérivés.
 *
 * POURQUOI C'EST QUAND MÊME UTILE. Les décisions qu'on prend avec ce chiffre — « ce bloc
 * tient-il dans le budget ? », « a-t-on réduit le prompt de moitié ? » — sont des décisions de
 * RATIO, pas de valeur absolue. Un estimateur systématiquement biaisé de 10 % donne exactement
 * les mêmes réponses qu'un tokeniseur exact sur ces questions-là.
 *
 * OÙ IL NE FAUT PAS S'EN SERVIR : pour affirmer un coût en dinars, ou pour se coller au plafond
 * de fenêtre d'un modèle. Ces deux usages demandent le vrai compte, et le vrai compte est rendu
 * par le fournisseur dans sa réponse (`usage.input_tokens`) — c'est CE chiffre-là qu'il faut
 * enregistrer quand on l'a, jamais celui-ci.
 *
 * LA MÉTHODE. Les tokeniseurs BPE découpent en morceaux de mots : un mot courant vaut un token,
 * un mot long ou accentué en vaut plusieurs, la ponctuation et les chiffres comptent à part. On
 * approxime mot à mot plutôt que par un ratio global, parce qu'un ratio global se trompe
 * lourdement sur les textes denses en ponctuation — et les prompts système en sont pleins.
 */

/** Ce que rend l'estimateur : le chiffre exact, et le chiffre dérivé. */
export interface TokenEstimate {
  /** EXACT — c'est ce qu'on cite quand on veut être irréprochable. */
  chars: number;
  /** ESTIMÉ — dérivé par la méthode ci-dessus. Jamais présenté comme un compte réel. */
  tokens: number;
}

/**
 * Un mot de 1 à 4 caractères vaut ~1 token ; au-delà, il se découpe. Les accents comptent : en
 * BPE, « réglementaire » coûte plus que « regulatory » à longueur égale, parce que les octets
 * accentués sortent des fusions les plus fréquentes.
 */
function wordTokens(word: string): number {
  const len = word.length;
  if (len === 0) return 0;
  // Les caractères hors ASCII (accents, guillemets français, tirets cadratins) se découpent plus.
  const exotic = (word.match(/[^\x20-\x7e]/g) ?? []).length;
  const base = len <= 4 ? 1 : Math.ceil(len / 4);
  return base + Math.ceil(exotic / 2);
}

export function estimateTokens(text: string): number {
  const s = text ?? "";
  if (!s) return 0;
  let tokens = 0;
  // Mots (lettres, y compris accentuées) / nombres / tout le reste caractère par caractère.
  const parts = s.match(/[\p{L}\p{M}]+|\d+|[^\s\p{L}\p{M}\d]|\s+/gu) ?? [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      // Les espaces se fondent dans le token du mot suivant ; seuls les sauts de ligne comptent.
      tokens += (part.match(/\n/g) ?? []).length;
    } else if (/^\d+$/.test(part)) {
      tokens += Math.ceil(part.length / 3); // les chiffres se découpent par groupes courts
    } else if (/^[\p{L}\p{M}]+$/u.test(part)) {
      tokens += wordTokens(part);
    } else {
      tokens += 1; // ponctuation, symboles
    }
  }
  return tokens;
}

export function measure(text: string): TokenEstimate {
  return { chars: (text ?? "").length, tokens: estimateTokens(text ?? "") };
}

/**
 * Le coût d'un schéma d'outil, tel que le fournisseur le sérialise. C'est le chiffre qui compte
 * pour §23 : des centaines de capacités décrites à CHAQUE tour, c'est un budget de contexte
 * dépensé avant que le PDG ait ouvert la bouche.
 */
export function measureToolDefs(defs: unknown[]): TokenEstimate {
  return measure(JSON.stringify(defs ?? []));
}
