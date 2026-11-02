/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GRAPHE — tri topologique, cycles, profondeur, vagues.
 *
 * ── POURQUOI C'EST UN FICHIER À PART ─────────────────────────────────────────────────────
 *
 * Le compilateur en a besoin pour REFUSER un plan impossible ; le moteur en a besoin pour
 * DÉCIDER quoi lancer ensuite. Ce sont deux moments très différents de la vie d'une mission, et
 * la même arithmétique. La dupliquer, c'est se garantir qu'un jour le compilateur acceptera un
 * graphe que le moteur ne saura pas exécuter.
 *
 * Tout ici est PUR : des clés, des dépendances, des entiers. Aucune base, aucun modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface GraphNode {
  key: string;
  dependsOn: readonly string[];
}

export interface GraphLayout {
  /** L'ordre d'exécution valide. Vide si le graphe a un cycle. */
  order: string[];
  /**
   * LA VAGUE DE CHAQUE ÉTAPE : 0 pour celles qui ne dépendent de rien, sinon un de plus que sa
   * dépendance la plus tardive. Deux étapes de la même vague sont PARALLÉLISABLES — c'est le
   * fait que le pool exploite, et c'est ce qui distingue « trente-trois e-mails en parallèle »
   * de « trente-trois e-mails à la file » (§10).
   */
  wave: Map<string, number>;
  /** La plus longue chaîne. Une mission profonde est lente quel que soit le parallélisme. */
  depth: number;
  /** Les clés prises dans un cycle. Non vide ⇒ le graphe est inexécutable. */
  cycle: string[];
  /** Les dépendances citées mais inexistantes. */
  missing: { key: string; dependsOn: string }[];
}

/**
 * LE TRI, PAR NIVEAUX (Kahn).
 *
 * On aurait pu faire un parcours en profondeur : il aurait donné l'ordre, mais pas les VAGUES,
 * et c'est justement la vague qui porte l'information utile au moteur. Ce qui reste après le
 * balayage EST le cycle — c'est la propriété de l'algorithme, pas une seconde détection.
 */
export function layout(nodes: readonly GraphNode[]): GraphLayout {
  const known = new Set(nodes.map((n) => n.key));
  const missing: { key: string; dependsOn: string }[] = [];

  const deps = new Map<string, string[]>();
  const enfants = new Map<string, string[]>();
  for (const n of nodes) {
    const propres = [...new Set(n.dependsOn)].filter((d) => {
      if (!known.has(d)) { missing.push({ key: n.key, dependsOn: d }); return false; }
      // Une étape qui se déclare dépendante d'elle-même est un cycle de longueur 1 ; on le laisse
      // passer ici pour que le balayage le rapporte comme cycle, plutôt que de le taire.
      return true;
    });
    deps.set(n.key, propres);
    for (const d of propres) {
      if (!enfants.has(d)) enfants.set(d, []);
      enfants.get(d)!.push(n.key);
    }
  }

  const restant = new Map<string, number>(nodes.map((n) => [n.key, deps.get(n.key)!.length]));
  const wave = new Map<string, number>();
  const order: string[] = [];

  let file = nodes.filter((n) => restant.get(n.key) === 0).map((n) => n.key);
  for (const k of file) wave.set(k, 0);

  while (file.length > 0) {
    const suivante: string[] = [];
    for (const k of file) {
      order.push(k);
      for (const enfant of enfants.get(k) ?? []) {
        const reste = restant.get(enfant)! - 1;
        restant.set(enfant, reste);
        wave.set(enfant, Math.max(wave.get(enfant) ?? 0, wave.get(k)! + 1));
        if (reste === 0) suivante.push(enfant);
      }
    }
    file = suivante;
  }

  const cycle = nodes.map((n) => n.key).filter((k) => !wave.has(k) || restant.get(k)! > 0);
  const depth = cycle.length > 0 ? 0 : Math.max(0, ...[...wave.values()].map((w) => w + 1));

  return { order: cycle.length > 0 ? [] : order, wave, depth, cycle: cycle.sort(), missing };
}

/**
 * LES ANCÊTRES D'UNE ÉTAPE — tout ce qui doit être fini avant elle, transitivement.
 *
 * Sert à une question précise : une expansion en éventail lit la sortie d'une autre étape. Cette
 * étape doit être EN AMONT, pas simplement « ailleurs dans le plan » — sinon le moteur
 * découvrirait à l'exécution qu'il doit lire un résultat qui n'existe pas encore.
 */
export function ancetres(nodes: readonly GraphNode[], key: string): Set<string> {
  const par = new Map(nodes.map((n) => [n.key, n.dependsOn]));
  const vus = new Set<string>();
  const pile = [...(par.get(key) ?? [])];
  while (pile.length > 0) {
    const k = pile.pop()!;
    if (vus.has(k)) continue;
    vus.add(k);
    for (const d of par.get(k) ?? []) pile.push(d);
  }
  return vus;
}
