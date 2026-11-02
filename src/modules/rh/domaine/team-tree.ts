import { directReportsOf, type DepartmentNodeLite, type EmployeeNode } from "./reporting-line";

/**
 * TOUT CE QUI EST SOUS MOI — l'arbre, pas la première rangée.
 *
 * ── POURQUOI L'ARBRE, ET PAS LA LISTE ───────────────────────────────────────────────────────
 *
 * « Mon Équipe » ne montrait que les N-1. Pour un directeur, c'est quatre cartes qui cachent
 * quarante personnes : celles qui font le travail sont toutes au deuxième rang, et l'on n'avait
 * aucun moyen de savoir qui, sans ouvrir l'organigramme des ressources humaines — c'est-à-dire un
 * écran qu'un encadrant n'a en général pas le droit d'ouvrir.
 *
 * L'arbre répond à la question telle qu'elle se pose : « qui travaille sous moi, à n'importe
 * quelle profondeur, et par qui passe-t-on pour lui parler ? » La HIÉRARCHIE compte autant que
 * la liste — savoir que Untel dépend de Unetelle, c'est savoir à qui s'adresser.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────────────────────
 *
 * Il n'invente aucune règle d'appartenance : chaque niveau est `directReportsOf`, la MÊME
 * fonction qui route les demandes. Un arbre construit sur une autre définition (« tous les
 * employés de mon département et de ses sous-départements ») afficherait des gens dont les
 * demandes vont ailleurs — deux vérités, et l'on ne découvre l'écart que le jour où une décision
 * dort chez quelqu'un qui ne se savait pas concerné.
 *
 * ── DEUX GARDES, ET ELLES NE SONT PAS DÉCORATIVES ───────────────────────────────────────────
 *
 * `resolveManager` donne UN N+1 par personne, ce qui fait normalement une forêt. Mais deux
 * managers explicites qui se désignent mutuellement (A dirige B, B dirige A) referment le
 * graphe : la descente boucle, et le serveur se fige — le genre de panne qu'une saisie
 * d'organigramme provoque un mardi matin. On tient donc un ensemble des personnes DÉJÀ PLACÉES
 * (nul ne paraît deux fois dans le même arbre) ET une profondeur maximale.
 *
 * Module PUR : aucune base. L'appelant charge les deux tables et les passe telles quelles.
 */

export interface TeamTreeNode {
  employeeId: string;
  fullName: string;
  userId: string | null;
  /** 1 = mes N-1, 2 = leurs N-1, … — le rang tel qu'un humain le compte. */
  depth: number;
  /** Le N+1 de cette personne DANS CET ARBRE (null au premier rang : c'est moi). */
  managerEmployeeId: string | null;
  reports: TeamTreeNode[];
}

/** Au-delà, c'est une hiérarchie fautive, pas une entreprise profonde. */
const MAX_DEPTH = 12;

export function subtreeOf(
  managerEmployeeId: string,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
  maxDepth = MAX_DEPTH,
): TeamTreeNode[] {
  // La racine est placée d'avance : sans cela, une hiérarchie qui reboucle sur moi me ferait
  // apparaître dans ma propre équipe.
  const places = new Set<string>([managerEmployeeId]);

  const descendre = (chefId: string, depth: number): TeamTreeNode[] => {
    if (depth > maxDepth) return [];
    const rang = directReportsOf(chefId, employees, departments).filter((e) => !places.has(e.id));
    // On marque TOUT le rang avant de descendre : deux frères ne peuvent pas se revendiquer
    // l'un l'autre en cascade.
    for (const e of rang) places.add(e.id);
    return rang.map((e) => ({
      employeeId: e.id,
      fullName: e.fullName,
      userId: e.userId,
      depth,
      managerEmployeeId: depth === 1 ? null : chefId,
      reports: descendre(e.id, depth + 1),
    }));
  };

  return descendre(managerEmployeeId, 1);
}

/**
 * L'ARBRE À PLAT, dans l'ordre où on le LIT — un chef, puis ses gens, puis le chef suivant.
 *
 * L'ordre compte : c'est lui qui permet d'afficher l'arbre avec une simple indentation, sans
 * que la page ait à refaire la descente. Un tri par nom rendrait l'écran illisible pour la seule
 * question qu'il sert (« par qui passe-t-on ? »).
 */
export function flattenTree(nodes: readonly TeamTreeNode[]): TeamTreeNode[] {
  const out: TeamTreeNode[] = [];
  const pousser = (list: readonly TeamTreeNode[]) => {
    for (const n of list) {
      out.push(n);
      pousser(n.reports);
    }
  };
  pousser(nodes);
  return out;
}

/** Combien de personnes en tout — l'encadrant compte son monde, pas son premier rang. */
export function totalUnder(nodes: readonly TeamTreeNode[]): number {
  return flattenTree(nodes).length;
}

/** Jusqu'où descend la chaîne — 1 quand personne n'encadre personne sous moi. */
export function depthOf(nodes: readonly TeamTreeNode[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.depth, depthOf(n.reports)), 0);
}
