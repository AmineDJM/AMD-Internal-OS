/**
 * L'ENTITÉ EST LA COLONNE VERTÉBRALE DE L'ARGENT.
 *
 * ── CE QU'ON CORRIGE ────────────────────────────────────────────────────────────────────────
 *
 * Le groupe compte plusieurs entités juridiques (Adventum, Pharmagène, …). Chacune a sa
 * comptabilité, sa trésorerie, ses comptes à rendre. Or l'entité d'un mouvement d'argent était
 * **facultative et implicite** : la demande de paiement prenait celle du demandeur *en silence*,
 * personne ne la voyait, personne ne la choisissait, et elle pouvait rester vide.
 *
 * Trois conséquences, toutes constatées :
 *
 *   • une file de paiements qui MÉLANGE deux sociétés, avec un total qui n'appartient à aucune ;
 *   • une dépense engagée au nom d'une entité et payée par l'autre, sans que rien ne le dise ;
 *   • une demande sans entité du tout, que la comptabilité doit rattacher à la main — donc de
 *     mémoire, donc parfois à tort.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 * **Tout mouvement d'argent porte SON entité, et elle est ÉCRITE.** Elle se propose — celle du
 * demandeur, à défaut celle de son département — mais elle ne se devine plus : elle figure dans
 * la demande, elle se voit, et la Direction peut la corriger AU MOMENT où elle valide, c'est-à-
 * dire au seul moment où quelqu'un a le dossier entier sous les yeux.
 *
 * ── POURQUOI PROPOSER PLUTÔT QU'IMPOSER ─────────────────────────────────────────────────────
 *
 * Un délégué d'une business unit sait pour QUI il travaille, rarement quelle entité juridique
 * porte la dépense. Lui demander de choisir dans une liste vide de sens produirait un champ
 * rempli au hasard — pire qu'un champ vide, parce qu'il a l'air renseigné. On propose donc la
 * sienne, et l'on garde la correction pour celui qui sait.
 *
 * Module PUR : ni base, ni session. Testé.
 */

export interface EntitySources {
  /** Ce que le formulaire a envoyé — un choix explicite l'emporte toujours. */
  explicit?: string | null;
  /** L'entité du demandeur (sa fiche employé, ou son entité d'accès). */
  requester?: string | null;
  /** L'entité du DÉPARTEMENT du demandeur — le repli quand sa fiche n'en porte pas. */
  department?: string | null;
  /** L'entité du dossier d'origine (l'événement, le marché…), quand la demande en découle. */
  source?: string | null;
}

/**
 * L'ENTITÉ D'UN MOUVEMENT D'ARGENT, dans l'ordre de préséance.
 *
 * L'ordre n'est pas arbitraire : du plus INTENTIONNEL au plus DÉDUIT. Un choix explicite est une
 * décision ; l'entité du dossier source est un fait ; celle du demandeur une probabilité ; celle
 * de son département un repli. Remonter cet ordre reviendrait à laisser une déduction écraser une
 * décision.
 */
export function resolveMoneyEntity(s: EntitySources): string | null {
  return firstNonEmpty(s.explicit, s.source, s.requester, s.department);
}

const firstNonEmpty = (...vals: (string | null | undefined)[]): string | null => {
  for (const v of vals) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return null;
};

export interface EntityCheck {
  ok: boolean;
  companyId?: string;
  reason?: string;
}

/**
 * L'ENTITÉ EST-ELLE RENSEIGNÉE, ET AI-JE LE DROIT DE L'ÉCRIRE ?
 *
 * Deux refus, et ils ne disent pas la même chose. « Aucune entité » se répare en en choisissant
 * une ; « pas la vôtre » se répare en s'adressant à quelqu'un d'autre. Un message unique
 * enverrait la moitié des gens à la mauvaise porte.
 *
 * `allowed` vide signifie « aucune entité ouverte à cette personne » : on refuse plutôt que
 * d'ouvrir tout — une liste vide de droits n'est pas une liste de tous les droits.
 *
 * ⚠️ L'APPELANT décide QUAND poser la question. Exiger un choix de quelqu'un dont le sélecteur est
 * vide n'est pas une règle, c'est une impasse : ces demandes-là partent sans entité, et la
 * Direction les retrouve dans le groupe « Sans entité — à rattacher » (`groupByEntity`), qui
 * existe précisément pour cela. La règle bite là où elle peut être satisfaite.
 */
export function checkMoneyEntity(
  chosen: string | null,
  allowed: readonly string[],
  opts: { hasGlobalView?: boolean } = {},
): EntityCheck {
  const id = (chosen ?? "").trim();
  if (!id) {
    return {
      ok: false,
      reason: "Indiquez l'entité concernée : c'est elle qui paiera, et sa comptabilité doit pouvoir s'y retrouver.",
    };
  }
  if (opts.hasGlobalView) return { ok: true, companyId: id };
  if (!allowed.includes(id)) {
    return {
      ok: false,
      reason: "Cette entité ne vous est pas ouverte : demandez à la Direction de rattacher la dépense, ou choisissez la vôtre.",
    };
  }
  return { ok: true, companyId: id };
}

/**
 * QUI PEUT CORRIGER L'ENTITÉ D'UNE DEMANDE, ET QUAND ?
 *
 * La Direction, au moment où elle valide — le seul moment où quelqu'un a le dossier entier sous
 * les yeux et sait quelle société porte réellement la dépense. Pas après : une fois l'ordre émis,
 * changer d'entité déplacerait un décaissement déjà inscrit dans une comptabilité, et il faut
 * alors une écriture, pas une correction de champ.
 */
export function canOverrideEntity(
  viewer: { hasGlobalView: boolean },
  state: { settled: boolean },
): boolean {
  return viewer.hasGlobalView && !state.settled;
}

export interface EntityBucket<T> {
  companyId: string | null;
  label: string;
  rows: T[];
  total: number;
}

/**
 * RANGER DES MOUVEMENTS PAR ENTITÉ — chacun son total, et un total par société qui veut dire
 * quelque chose.
 *
 * Une file mélangée affiche un total qui n'appartient à personne : ni Adventum ni Pharmagène ne
 * doit ce chiffre-là. Le grouper n'est pas de la présentation, c'est ce qui rend la somme vraie.
 *
 * Les mouvements SANS entité forment leur propre groupe, en dernier, et il est NOMMÉ — les noyer
 * dans une société les ferait disparaître, alors que ce sont précisément ceux qu'il faut
 * rattacher.
 */
export function groupByEntity<T>(
  rows: readonly T[],
  read: (row: T) => { companyId: string | null; amount: number },
  labels: Record<string, string>,
): EntityBucket<T>[] {
  const buckets = new Map<string, EntityBucket<T>>();
  for (const row of rows) {
    const { companyId, amount } = read(row);
    const key = companyId ?? "";
    const bucket = buckets.get(key) ?? {
      companyId,
      label: companyId ? (labels[companyId] ?? "Entité inconnue") : "Sans entité — à rattacher",
      rows: [],
      total: 0,
    };
    bucket.rows.push(row);
    bucket.total += amount;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    // « Sans entité » ferme la marche : c'est une anomalie à traiter, pas une société.
    if (!a.companyId) return 1;
    if (!b.companyId) return -1;
    return a.label.localeCompare(b.label, "fr");
  });
}

/** Ce que l'écran dit d'un lot sans entité — ou `null` quand tout est rattaché. */
export function unassignedWarning(buckets: readonly EntityBucket<unknown>[]): string | null {
  const orphelins = buckets.find((b) => !b.companyId);
  if (!orphelins || orphelins.rows.length === 0) return null;
  return `${orphelins.rows.length} mouvement(s) ne portent aucune entité : leur montant n'entre dans la comptabilité d'aucune société tant qu'ils ne sont pas rattachés.`;
}
