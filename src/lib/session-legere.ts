import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "./prisma";
import { accesAttribue, getAccess, userCan } from "./rbac";
import { lireSessionRevocable, vueDemandee, type CompteDeSession } from "./session-compte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IDENTITÉ DES SONDAGES DE LA COQUE — sans la matrice des droits (audit performance PERF-06).
 *
 * La coque interroge le serveur en boucle depuis chaque onglet ouvert : le badge de la messagerie
 * (`/api/messaging/sync?portee=badge`, 12 s) et les notifications (`/api/notifications/poll`, 15 s). Chaque
 * appel passait par `getCurrentUser()`, qui résout l'accès EFFECTIF complet (`getAccess` : 8 lectures —
 * accès, partages, validations en attente, départements, intérims, réglages, siège…) pour ne lire au bout
 * que `user.id`. Mesuré : 10 requêtes SQL d'authentification sur les 11 à 12 de chaque sondage.
 *
 * Ici, la personne et RIEN d'autre :
 *   · le jeton décodé (`auth()`, sans base) ;
 *   · la session révocable ET le compte en base, en UNE requête — la même règle que `session.ts`
 *     (`lireSessionRevocable`) : session révoquée ou expirée, compte DÉSACTIVÉ, rôle changé valent dès le
 *     sondage suivant. Aucun cache : la révocation n'attend rien ;
 *   · la même « Vue exacte » que les pages (`vueDemandee`) : un Super Admin qui visualise Leila voit le
 *     badge de Leila — jamais le sien superposé à son écran.
 *
 * Le droit de voir la messagerie se décide par `peutVoirLaMessagerie`, sans `getAccess` dans le cas courant.
 * Tout le reste (pages, actions, routes qui écrivent) garde `getCurrentUser` / `requireUser`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface IdentiteDuSondage {
  /** La personne À L'ÉCRAN : la personne visualisée sous « Vue exacte ». */
  id: string;
  /** Rôles EN BASE (le JWT fige le rôle au login). */
  role: UserRole;
  secondaryRole: UserRole | null;
  mustChangePassword: boolean;
}

/** `null` : pas de session, session révoquée ou expirée, compte désactivé ou disparu. */
export async function identiteDuSondage(): Promise<IdentiteDuSondage | null> {
  const session = await auth();
  if (!session?.user) return null;

  // Le compte en base. Avec une session révocable (`sid`, toute connexion depuis la console des sessions),
  // il vient avec elle ; sans (jeton ancien), on le relit — sa fiche porte le rôle réel.
  let compte: CompteDeSession | null;
  if (session.user.sid) {
    const lue = await lireSessionRevocable(session.user.sid);
    if (!lue) return null;
    compte = lue.compte;
  } else {
    compte = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { isActive: true, role: true, secondaryRole: true },
    });
  }
  if (!compte || !compte.isActive) return null;

  const vue = await vueDemandee(compte.role, session.user.id);
  if (vue?.honoree) {
    return { id: vue.cible.id, role: vue.cible.role, secondaryRole: vue.cible.secondaryRole, mustChangePassword: false };
  }
  return {
    id: session.user.id,
    role: compte.role,
    secondaryRole: compte.secondaryRole,
    mustChangePassword: session.user.mustChangePassword ?? false,
  };
}

/**
 * Cette personne peut-elle voir la messagerie ? MÊME réponse que `userCan(await getCurrentUser(), "MESSAGING",
 * "VIEW")`, en une lecture au lieu de huit.
 *
 * Pourquoi c'est exact : l'accès effectif = l'accès ATTRIBUÉ (rôle, « autre rôle », ligne de la console —
 * `accesAttribue`, la règle pure que `getAccess` applique lui-même) + des accès IMPLICITES qui ne font
 * qu'AJOUTER (jamais retirer : aucun `modules.delete` dans `getAccess`, le mode « remplacer » ne vise que
 * Regulatory et Recrutement) et ne passent jamais un blocage de l'administrateur. Donc :
 *   · attribué → oui, sans rien lire de plus (tous les rôles l'ont : le cas de chaque sondage) ;
 *   · BLOQUÉ par la console → non, aucun accès implicite ne le rouvre ;
 *   · ni l'un ni l'autre → un accès implicite POURRAIT l'ouvrir (la messagerie ne se prête pas en intérim,
 *     mais une validation en attente qui pointe vers elle l'ouvrirait) : on demande à la règle complète.
 */
export async function peutVoirLaMessagerie(qui: IdentiteDuSondage): Promise<boolean> {
  const ligne = await prisma.userAccess.findUnique({ where: { userId_module: { userId: qui.id, module: "MESSAGING" } } });
  const { modules, blockedModules } = accesAttribue(qui.role, qui.secondaryRole, ligne ? [ligne] : []);
  if (modules.get("MESSAGING")?.actions.has("VIEW")) return true;
  if (blockedModules.has("MESSAGING")) return false;
  return userCan({ ...qui, access: await getAccess(qui.id, qui.role) }, "MESSAGING", "VIEW");
}
