import { cache } from "react";
import { cookies } from "next/headers";
import { actionAsyncStorage } from "next/dist/client/components/action-async-storage.external";
import type { UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { shouldTouch } from "./touch-throttle";
import { IMPERSONATE_COOKIE } from "./vue-exacte";
import { vueHonoree } from "./vue-exacte-ui";
import { lectureDeclaree } from "./vue-lecture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX QUESTIONS QUE POSE TOUTE RÉSOLUTION D'IDENTITÉ — écrites UNE fois.
 *
 *   1. « Ce jeton vaut-il encore ? » — `lireSessionRevocable` : session non révoquée, non expirée, compte
 *      ACTIF, rôle EN BASE (audit sécurité 27/10, SECURITE-ACCES-07).
 *   2. « Ce Super Admin visualise-t-il quelqu'un, et la vue vaut-elle pour CE calcul ? » —
 *      `vueDemandee` (§118.184, règle `vueHonoree`).
 *
 * Deux lecteurs : `session.ts` (l'utilisateur complet, avec la matrice des droits — pages, actions) et
 * `session-legere.ts` (l'identité des SONDAGES de la coque, sans la matrice — audit performance PERF-06).
 * Une seule règle de révocation et de vue pour les deux : un sondage ne peut pas voir un compte
 * désactivé, ni une vue qu'une page refuserait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le compte tel qu'il est EN BASE (le JWT fige le rôle au login). */
export interface CompteDeSession {
  isActive: boolean;
  role: UserRole;
  secondaryRole: UserRole | null;
}

/**
 * La session révocable `sid` : `null` si elle est absente, révoquée ou expirée — l'administrateur peut
 * ainsi déconnecter un compte (ou un seul appareil) depuis la console. Sinon le compte relu dans la MÊME
 * requête (`compte` vaut `null` si la fiche a disparu ; à l'appelant de refuser un compte inactif).
 */
export async function lireSessionRevocable(sid: string): Promise<{ compte: CompteDeSession | null } | null> {
  // UNE requête, jointure comprise : `userSession.findUnique({ select: { user: … } })` en émet DEUX (Prisma 5
  // charge la relation à part), et cette lecture précède CHAQUE page, action et sondage (PERF-06).
  const [us] = await prisma.$queryRaw<
    { revokedAt: Date | null; expiresAt: Date; isActive: boolean | null; role: UserRole | null; secondaryRole: UserRole | null }[]
  >`SELECT s."revokedAt", s."expiresAt", u."isActive", u."role", u."secondaryRole"
      FROM "UserSession" s LEFT JOIN "User" u ON u."id" = s."userId"
     WHERE s."id" = ${sid}`;
  if (!us || us.revokedAt || us.expiresAt < new Date()) return null;
  // `lastSeenAt` = « dernier clic » : granularité à la minute suffit. On throttle donc
  // l'UPDATE (au plus 1×/min par session) au lieu d'écrire à CHAQUE requête (WAL/disque).
  if (shouldTouch(`sess:${sid}`, 60_000)) {
    prisma.userSession
      .update({ where: { id: sid }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }
  const compte = us.role ? { isActive: us.isActive === true, role: us.role, secondaryRole: us.secondaryRole } : null;
  return { compte };
}

/**
 * UNE ACTION SERVEUR S'EXÉCUTE-T-ELLE EN CE MOMENT ? La question n'est pas « cette requête porte-t-elle
 * l'en-tête `Next-Action` ? » : c'est ce qu'on lisait (§118.184), et c'était faux de deux façons.
 *
 *   · Une action qui `redirect()` ne renvoie pas une redirection : Next rend la page cible DANS la
 *     réponse de l'action, en rejouant les en-têtes de la requête — `Next-Action` compris. La page
 *     d'arrivée de « Voir comme cet utilisateur » se rendait donc comme celle du Super Admin, sans
 *     bandeau ; seul un rechargement (une vraie requête GET) montrait la vue. Même défaut après toute
 *     action qui revalide la page affichée : l'écran retombait sur l'administrateur jusqu'au prochain
 *     rechargement. Mesuré contre le build de production (`e2e/vue-exacte.spec.ts`).
 *   · L'en-tête dit « cette requête VIENT d'une action », pas « le code qui tourne est celui de
 *     l'action » : le rendu de la page qui suit l'action est un RENDU, il LIT.
 *
 * Next marque l'exécution de l'action dans un stockage asynchrone (`actionAsyncStorage`, `isAction`) :
 * c'est le fait que `cookies().set` et `redirect` lisent eux-mêmes. ⚠️ Pas « d'elle seule » : le rendu
 * qui suit une action qui revalide y tourne aussi — d'où `rendreEnCours` ci-dessous (Direction, 06/10).
 * Une route d'API qui écrit le DIT en appelant `getCurrentUserPourEcrire` (un cliquet l'exige de chaque
 * gestionnaire POST/PUT/PATCH/DELETE). Hors requête (banc, battement), personne n'usurpe rien.
 */
function actionServeurEnCours(): boolean {
  try {
    return actionAsyncStorage.getStore()?.isAction === true;
  } catch {
    return false;
  }
}

/**
 * UN RENDU DE COMPOSANTS SERVEUR EST-IL EN COURS ? — la moitié manquante de la règle ci-dessus.
 *
 * « Le problème d'interface quand je vois à la place d'un user refait surface » (Direction, 06/10). LU dans
 * Next 14.2 (`server/app-render/action-handler.js`) : `generateFlight` — le rendu de la page qui SUIT une
 * action qui revalide — s'exécute DANS `actionAsyncStorage.run({ isAction: true })`. Tout ce rendu (la coque :
 * nom en haut, menu, pastilles, bandeau ; et la page) se faisait donc au nom de l'ADMINISTRATEUR, au milieu
 * de l'écran de la personne visualisée : le chevauchement, après chaque geste.
 *
 * React dit, lui, si l'on rend : `cache` ne mémorise QUE pendant un rendu de composants serveur (documenté ;
 * hors rendu — corps d'une action, route d'API — chaque appel recalcule). Deux appels qui rendent le même
 * objet = un rendu en cours. Hors de Next (bancs : React 18 sans `cache`), aucun rendu.
 */
const sondeDeRendu: (() => object) | null =
  typeof cache === "function" ? (cache as <T extends () => object>(f: T) => T)(() => ({})) : null;
function rendreEnCours(): boolean {
  if (!sondeDeRendu) return false;
  try {
    return sondeDeRendu() === sondeDeRendu();
  } catch {
    return false;
  }
}

/** Le cookie de la vue, ou `undefined` hors requête (banc, battement : personne ne visualise rien). */
function cookieDeVue(): string | undefined {
  try {
    return cookies().get(IMPERSONATE_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

export interface OptionsDeSession {
  /** Route d'API qui écrit : au nom du Super Admin (§118.184). */
  ecriture?: boolean;
  /** Création d'une demande : au nom de la personne visualisée (Direction, 06/10). */
  auNomDeLaVue?: boolean;
}

/** La personne qu'un Super Admin visualise (fiche relue en base, compte actif). */
export interface PersonneVisualisee {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  secondaryRole: UserRole | null;
}

/**
 * « Vue exacte » : un Super Admin peut visualiser l'OS exactement comme un autre utilisateur. Le cookie
 * n'est honoré QUE si le rôle RÉEL (en base) est Super Admin — un cookie forgé par un non-admin, ou gardé
 * par un Super Admin rétrogradé, est sans effet.
 *
 * C'est une VUE, pas une usurpation (§118.184, audit 360° S8) : `honoree` dit si CE calcul d'identité la
 * voit (tout ce qui s'affiche) ou non (le corps d'une écriture, qui part au nom du Super Admin et garde la
 * personne en `visualise`). La règle tient dans `vueHonoree` (vue-exacte-ui.ts).
 *
 * `null` : aucune vue (pas Super Admin, pas de cookie, cookie sur soi-même, cible absente ou inactive).
 */
export async function vueDemandee(
  roleReel: UserRole,
  idReel: string,
  opts: OptionsDeSession = {},
): Promise<{ cible: PersonneVisualisee; honoree: boolean } | null> {
  const targetId = roleReel === "SUPER_ADMIN" ? cookieDeVue() : undefined;
  if (!targetId || targetId === idReel) return null;
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, email: true, role: true, secondaryRole: true, isActive: true },
  });
  if (!target || !target.isActive) return null;
  const honoree = vueHonoree({
    ecriture: !!opts.ecriture,
    auNomDeLaVue: !!opts.auNomDeLaVue,
    lecture: lectureDeclaree(),
    actionServeur: actionServeurEnCours(),
    rendu: rendreEnCours(),
  });
  return {
    cible: { id: target.id, name: target.name, email: target.email, role: target.role, secondaryRole: target.secondaryRole },
    honoree,
  };
}
