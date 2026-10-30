/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PREMIER APERÇU — ce que le code TIENT DÉJÀ arrive à l'écran à l'instant où il le tient.
 *
 * ── LA MESURE QUI A PRODUIT CE FICHIER ──────────────────────────────────────────────────
 *
 * Chronologie relevée à la milliseconde sur « Analyse-moi les retards Regulatory » :
 *
 *      25 ms   trace      Recherche fédérée effectuée
 *     108 ms   source     onze pièces nommées, avec leurs liens
 *   3 565 ms   trace      Signaux Regulatory calculés
 *  13 742 ms   workspace  ← LE PREMIER BLOC
 *
 * Adam SAVAIT à 108 millisecondes quelles onze pièces il allait lire. L'écran ne l'a montré
 * qu'à 13,7 secondes. Ce ne sont pas des secondes de calcul : ce sont des secondes de RÉTENTION.
 * Sur la demande de recherche, même figure — la donnée à 733 ms, le premier bloc à 2 893 ms.
 *
 * ── LA RÈGLE, ET ELLE EST GÉNÉRALE ──────────────────────────────────────────────────────
 *
 * `composeWorkspace` traduit les lectures dont la forme est CONNUE (annuaire, boîte mail,
 * agenda, dossier…). C'est la bonne mécanique, et elle ne couvre — par construction — que les
 * outils qu'un développeur a décrits. Toutes les autres lectures rendaient donc `null`, et la
 * personne attendait la rédaction du modèle pour voir quoi que ce soit.
 *
 * Ce module ferme le trou SANS rouvrir l'inférence que `compose.ts` interdit — l'incident des
 * six lignes de salaire affichées en réponse à « Bonsoir, ça va ? ». Il ne devine aucune forme
 * et ne lit AUCUN champ de la sortie : il reçoit les sources déjà EXTRAITES ET VALIDÉES par
 * `extractSources` (lien interne obligatoire, libellé pris dans une liste blanche de clés,
 * profondeur et nombre bornés) — celles-là mêmes qui alimentent déjà le panneau « Sources ».
 *
 * Autrement dit : **rien de nouveau n'est révélé**. La même information change seulement
 * d'instant et de place — du panneau latéral, à la fin, vers le fil principal, tout de suite.
 *
 * ── POURQUOI C'EST UNE INFORMATION ET NON UN REMPLISSAGE ────────────────────────────────
 *
 * « Bien sûr, je vais analyser… » n'apprend rien à personne. « Je lis ces onze pièces, les
 * voici » en apprend deux : ce qu'Adam a trouvé, et sur quoi sa réponse va porter. La personne
 * peut ouvrir une pièce, ou corriger la trajectoire AVANT les trente-six secondes — ce qui est
 * précisément ce qu'on attend d'un chef de cabinet.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { WORKSPACE_LIMITS, type WorkspaceComposition, type WorkspaceItem } from "@/platform/ia/workspace/protocol";

/** Une source telle que le tour la produit déjà : libellé, lien interne, et parfois un résumé. */
export interface SourceLue {
  label: string;
  href: string;
  detail?: string;
}

/**
 * DEUX, PAS UNE. Une source unique est déjà dite par sa trace et par le panneau ; lui dresser un
 * bloc ajouterait un cadre autour d'une ligne. À partir de deux, l'ensemble a une forme — et
 * c'est la forme qui informe : « voilà ce que je regarde ».
 */
export const SOURCES_MIN = 2;

/** Le libellé de repli, quand l'appelant n'a pas de nom d'écran pour cette lecture. */
export const TITRE_PAR_DEFAUT = "Éléments trouvés";

/** Sous la figure (42) et sous le tableau : un aperçu accompagne la réponse, il ne la remplace pas. */
export const POIDS_APERCU = 20;

/**
 * LE BLOC D'APERÇU, ou `null` s'il n'y a rien d'honnête à montrer.
 *
 * `null` n'est pas un échec : c'est le cas normal d'une lecture qui ne rapporte aucun élément
 * lié, ou dont la forme est déjà traduite par `composeWorkspace`. L'appelant essaie le
 * traducteur d'abord et ne vient ici qu'ensuite — jamais l'inverse, sans quoi un aperçu
 * générique prendrait la place d'une vraie fiche.
 */
export function apercuDesSources(
  outil: string,
  sources: readonly SourceLue[],
  titre?: string | null,
): WorkspaceComposition | null {
  const vues = new Set<string>();
  const items: WorkspaceItem[] = [];
  for (const s of sources) {
    // Ceinture ET bretelles : `extractSources` n'accepte déjà que des routes internes, mais un
    // aperçu qui afficherait un lien externe sortirait la personne de l'ERP sans le dire.
    if (!s.href.startsWith("/") || s.href.startsWith("//")) continue;
    if (vues.has(s.href)) continue;
    const titreLigne = s.label.trim();
    if (!titreLigne) continue;
    vues.add(s.href);
    items.push({ titre: titreLigne, href: s.href, detail: s.detail?.trim() || null });
    if (items.length >= WORKSPACE_LIMITS.queueItems) break;
  }
  if (items.length < SOURCES_MIN) return null;

  return {
    source: outil,
    blocks: [{
      kind: "queue",
      title: (titre ?? "").trim() || TITRE_PAR_DEFAUT,
      total: items.length,
      items,
      // La lecture est FAITE : ce bloc n'est pas une promesse, c'est un constat. `certitude`
      // le dit à l'écran, et `state` empêche de le confondre avec un chargement en cours.
      state: "complete",
      certitude: "fait",
      /**
       * UN APERÇU N'EST JAMAIS LE SUJET. Il emprunte la forme d'une file (`queue`) parce que
       * des lignes titrées et liées sont exactement ce qu'il faut montrer — mais il en héritait
       * aussi le POIDS, celui d'une décision en attente. Mesuré au banc live : « Recherche
       * fédérée effectuée » prenait la tête devant le graphique demandé. Il pèse donc moins
       * qu'une figure (42), moins qu'un tableau : c'est du contexte, pas la réponse.
       */
      poids: POIDS_APERCU,
    }],
  };
}
