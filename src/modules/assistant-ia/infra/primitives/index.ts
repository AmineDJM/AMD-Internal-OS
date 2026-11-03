import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import type { JeuxDuTour } from "../../domaine/analyse/jeux";
import { outilLire, OUTIL_LIRE } from "./lire";
import { outilProduire, OUTIL_PRODUIRE } from "./produire";
import { outilFichier, OUTIL_FICHIER } from "./fichier";
import { outilObserver, OUTIL_OBSERVER } from "./observer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — LES PRIMITIVES DANS LE CATALOGUE (décision 0065) : `lire`, `produire`, `fichier`, `observer`.
 *
 * L'INTERRUPTEUR DE REPLI : `ADAM_PRIMITIVES=0` rend le catalogue d'avant à l'identique (aucune primitive, rien de masqué).
 * Par défaut, les primitives sont offertes et ce qu'elles rendent inutile est MASQUÉ — retiré du catalogue, pas du code :
 * la suppression attend la mesure du banc et la décision de la Direction (0055 : « ne supprime rien, quitte à tout masquer »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Lu à chaque tour (pas au chargement) : l'interrupteur se bascule sans redéploiement de code. */
export const primitivesActives = (): boolean => process.env.ADAM_PRIMITIVES !== "0";

export const OUTILS_PRIMITIVES = [OUTIL_LIRE, OUTIL_PRODUIRE, OUTIL_FICHIER, OUTIL_OBSERVER] as const;
/** Les primitives qui ÉCRIVENT (un fichier, une version) : ni routine ni travail ne les reçoit (`ECRITURES_DU_MOTEUR`). */
export const ECRITURES_PRIMITIVES = [OUTIL_PRODUIRE, OUTIL_FICHIER] as const;

/**
 * CE QUE LES PRIMITIVES RENDENT INUTILE — masqué quand elles sont actives (AU2 §6.4). Seulement ce qu'elles couvrent
 * DÉJÀ entièrement : un export d'écran dont aucune vue ne lit encore les données (suivi Regulatory, budgets, PCH…) reste
 * offert jusqu'à ce que sa vue existe (étape M4) — masquer avant ferait perdre une capacité.
 */
export const MASQUES_PAR_LES_PRIMITIVES: Readonly<Record<string, string>> = {
  // `produire(xlsx|csv|pdf)` sur un jeu lu (les mêmes jeux du tour, K1).
  exporter_donnees: "produire",
  // La couche d'outils de l'Atelier : `fichier` écrit la version lui-même (l'ÉCRAN de l'Atelier reste, et `ouvrir_dans_l_atelier` pour relire).
  modifier_document: "fichier", convertir_document: "fichier",
  // Les lectures doublons des vues de M0.
  list_my_tasks: "lire (vue taches)", list_my_requests: "lire (vue demandes)", search_products: "lire (vue produits)",
  // L'ancien Adam en double (A2, Super Admin seul) : documents, classeurs, conversions.
  format_convertir: "fichier", document_build: "produire", sheet_build: "produire",
};

export const estMasqueParLesPrimitives = (nom: string): boolean => primitivesActives() && nom in MASQUES_PAR_LES_PRIMITIVES;

/**
 * AUCUNE CAPACITÉ PERDUE : un outil absent d'un catalogue est-il MASQUÉ et sa primitive offerte à sa place ? Les bancs
 * d'inventaire (équivalents d'avant J6, fonctions d'Adam, corpus de sélection) le demandent au lieu du nom d'avant.
 */
export function couvertParUnePrimitive(nom: string, offerts: ReadonlySet<string>): boolean {
  const par = MASQUES_PAR_LES_PRIMITIVES[nom];
  return estMasqueParLesPrimitives(nom) && !!par && offerts.has(par.split(" ")[0]!);
}

/** Les quatre primitives de CETTE personne ; `jeux` : les jeux du tour (ceux de l'analyse K1 quand elle est là). */
export function outilsPrimitives(user: CurrentUser, jeux: JeuxDuTour): PowerTool[] {
  if (!primitivesActives()) return [];
  return [outilLire(user, jeux), outilProduire(user, { jeux }), outilFichier(user), outilObserver(user)];
}
