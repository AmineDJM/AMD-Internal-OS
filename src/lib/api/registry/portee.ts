import { Prisma } from "@prisma/client";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { clauseTachesVisibles } from "@/lib/tasks/request-flow";
import { companyScopedWhere } from "@/lib/company";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { entityScopeWhere, type EntityDef } from "./entities";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTÉE DE LA PORTE GÉNÉRIQUE — la MÊME que celle de l'écran, jamais plus large.
 *
 * ── LE DÉFAUT, MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * `entityScopeWhere` rend la portée PAR LIGNE du module (`scopeRegulatory`, `scopeSales`…).
 * Les écrans, eux, en composent une seconde que le registre ignorait : le CLOISONNEMENT PAR
 * ENTITÉ (`companyScopedWhere`). Sur une chargée Regulatory rattachée à Alpha, avec un dossier
 * Alpha et un dossier Beta en base :
 *
 *     ÉCRAN    voit : [ A-1 ]
 *     REGISTRE voit : [ A-1, B-1 ]        ← le dossier d'une société qui ne la regarde pas
 *
 * Ce n'était pas une entité isolée : **18 des 29 entités du registre portent `companyId`** —
 * dossiers réglementaires, salariés, demandes administratives, sponsorings, congrès,
 * événements, contrats de consulting, ordres de dépense, appels d'offres PCH, praticiens,
 * déclarations d'information médicale, courriers, ventes, dossiers de suivi. Toutes passaient
 * par ces routes sans le moindre filtre d'entité.
 *
 * Le commentaire de `queries/regulatory-rows.ts` disait déjà la règle, et c'est celle-ci :
 * « LE CHIEF NE DOIT JAMAIS CONTREDIRE L'ÉCRAN parce que son outil poserait un filtre plus
 * faible. » Une porte générique qui voit plus que l'écran n'est pas une commodité : c'est le
 * cloisonnement du groupe qui cesse d'exister dès qu'on passe par l'API.
 *
 * ── CE QUI ARME LA GARDE : UN FAIT DU SCHÉMA, PAS UNE LISTE ──────────────────────────────
 *
 * Les modèles cloisonnables sont lus dans le DMMF de Prisma — « ce modèle a-t-il un champ
 * scalaire `companyId` ? ». Une liste écrite à la main aurait oublié le 19ᵉ modèle le jour où
 * quelqu'un l'ajoute, et le trou serait silencieux (§118.17 : un garde-fou s'arme sur un fait
 * du processus, jamais sur une variable qu'un futur appelant devrait penser à poser).
 *
 * ── ET ON NE DEVIENT PAS PLUS STRICT QUE L'ÉCRAN ─────────────────────────────────────────
 *
 * On appelle `companyScopedWhere`, la fonction des écrans — pas `platformScope` directement.
 * Elle laisse volontairement passer les enregistrements SANS entité (`companyId: null`) : les
 * retirer ici cacherait des lignes que l'écran montre, c'est-à-dire un refus à tort, pire que
 * le défaut qu'on corrige (§118.27).
 *
 * Quand un écran connaît une portée ENCORE plus fine que « module + entité » — Regulatory
 * compose en plus le filtre de GAMME — c'est SA clause qu'on appelle, pas une copie (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les modèles qui portent une entité — LU DU SCHÉMA à chaque démarrage, jamais recopié. */
export const MODELES_CLOISONNES: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "companyId" && f.kind === "scalar"))
    .map((m) => m.name),
);

/**
 * LES PORTÉES D'ÉCRAN, quand l'écran en a une plus fine que « module + entité ».
 *
 * Chaque entrée pointe la fonction que l'écran appelle LUI-MÊME. En écrire une variante ici
 * donnerait deux clauses pour une seule question, et celle de l'API prendrait du retard au
 * premier correctif appliqué à l'autre (§118.5).
 */
const PORTEES_D_ECRAN: Record<string, (user: SessionUser) => Promise<Record<string, unknown>>> = {
  // Regulatory compose TROIS choses : le verrou du pipeline, le cloisonnement par entité, et
  // le filtre de GAMME — avec « être nommé sur un dossier » qui passe avant la gamme.
  regulatory_dossier: regulatoryVisibleWhere as (user: SessionUser) => Promise<Record<string, unknown>>,
  // Une tâche se lit dans son CERCLE (assigné, demandeur, participants, lecteurs) : la clause de la recherche
  // globale, jumelle de `canSee` (audit sécurité 27/10 — l'API rendait les tâches de toute l'entreprise).
  task: async (user) => clauseTachesVisibles(user.id, hasGlobalView(user.role)),
};

/**
 * LA PORTÉE À POSER SUR TOUTE LECTURE GÉNÉRIQUE. Asynchrone parce que le cloisonnement par
 * entité l'est — il lit les rattachements et les autorisations de la personne.
 */
export async function porteeEntite(user: SessionUser, def: EntityDef): Promise<Record<string, unknown>> {
  const ecran = PORTEES_D_ECRAN[def.name];
  if (ecran) return ecran(user);
  const base = entityScopeWhere(user, def);
  return MODELES_CLOISONNES.has(def.model) ? companyScopedWhere(user.id, base) : base;
}
