import { cache } from "react";
import { cookies } from "next/headers";
import { actionAsyncStorage } from "next/dist/client/components/action-async-storage.external";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "./prisma";
import { getAccess, userCan, type Action, type EffectiveAccess, type Module } from "./rbac";
import { firstAccessibleHref } from "./labels";
import { shouldTouch } from "./touch-throttle";
import { getAppSettings } from "./settings";
import { canOpenModule } from "./modules-visibility";
import { IMPERSONATE_COOKIE } from "./vue-exacte";
import { vueHonoree } from "./vue-exacte-ui";
import { lectureDeclaree } from "./vue-lecture";

/**
 * Nom du cookie de « Vue exacte » (impersonation), honoré uniquement pour un Super Admin. Défini dans
 * `vue-exacte.ts` (qui sait aussi refuser une création sous la vue) et réexporté ici : les actions de
 * création le lisent sans importer la session, que les bancs remplacent entièrement.
 */
export { IMPERSONATE_COOKIE };

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** « Autre rôle » cumulé (réglé par le Super Admin), résolu depuis l'accès effectif. */
  secondaryRole?: UserRole | null;
  access: EffectiveAccess;
  sid?: string;
  mustChangePassword: boolean;
  /** Présent quand un Super Admin visualise l'OS « comme » cet utilisateur. */
  impersonatedBy?: { id: string; name: string };
  /**
   * Présent sur le Super Admin RÉEL (corps d'une écriture) quand une Vue exacte est ouverte : la personne
   * visualisée. Un geste qui ne vaut que pour « soi » (Adam, sa mémoire) le refuse — `impersonatedBy`
   * seul n'y suffit pas, il n'existe jamais dans le corps d'une action.
   */
  visualise?: { id: string; name: string };
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

interface OptionsDeSession {
  /** Route d'API qui écrit : au nom du Super Admin (§118.184). */
  ecriture?: boolean;
  /** Création d'une demande : au nom de la personne visualisée (Direction, 06/10). */
  auNomDeLaVue?: boolean;
}

async function build(session: Session | null, opts: OptionsDeSession = {}): Promise<CurrentUser | null> {
  if (!session?.user) return null;

  // Validate the revocable session: reject revoked/expired tokens so the admin
  // can force-logout a user (or a single device) from the console.
  //
  // Le COMPTE se relit avec la session, dans la même requête (audit sécurité 27/10, SECURITE-ACCES-07) :
  //   • un compte DÉSACTIVÉ n'a plus de session — `toggleUserActive` (Adam) ne révoquait rien, et l'ancien
  //     salarié restait connecté jusqu'à 30 jours ;
  //   • le rôle qui ouvre la « Vue exacte » est le rôle EN BASE, pas celui que le JWT a figé au login — un
  //     Super Admin rétrogradé gardait sinon la vue (lire l'OS comme n'importe qui) jusqu'à expiration.
  const sid = session.user.sid;
  let compte: { isActive: boolean; role: UserRole } | null | undefined;
  if (sid) {
    const us = await prisma.userSession.findUnique({
      where: { id: sid },
      select: { revokedAt: true, expiresAt: true, user: { select: { isActive: true, role: true } } },
    });
    if (!us || us.revokedAt || us.expiresAt < new Date()) return null;
    compte = us.user;
    if (compte && !compte.isActive) return null;
    // `lastSeenAt` = « dernier clic » : granularité à la minute suffit. On throttle donc
    // l'UPDATE (au plus 1×/min par session) au lieu d'écrire à CHAQUE requête (WAL/disque).
    if (shouldTouch(`sess:${sid}`, 60_000)) {
      prisma.userSession
        .update({ where: { id: sid }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
  }

  // « Vue exacte » : un Super Admin peut visualiser l'OS exactement comme un autre
  // utilisateur. Le cookie n'est honoré QUE si la session réelle est Super Admin —
  // un cookie forgé par un non-admin est donc sans effet.
  //
  // C'est une VUE, pas une usurpation (§118.184, audit 360° S8). Le bandeau promettait « vos actions
  // seront enregistrées au nom de l'administrateur », et chaque action partait pourtant AU NOM de la
  // personne visualisée : une décision, un envoi, un dépôt s'écrivaient sous son nom au journal et
  // dans les notifications. Une requête qui ÉCRIT ignore donc la vue : elle part au nom du Super
  // Admin, avec ses droits — ce que le bandeau dit.
  //
  // EXCEPTION VOULUE (Direction, 06/10) : la CRÉATION D'UNE DEMANDE sous « Vue exacte » se fait au nom de
  // la personne visualisée (`opts.auNomDeLaVue`, via `requireUserAuNomDeLaVue`), pour que le Super Admin
  // teste son parcours de bout en bout : la fiche se crée à son nom, avec ses droits et sa gamme, et
  // s'ouvre dans cette même vue. Réservé au Super Admin RÉEL (la condition ci-dessous) ; la requête
  // garde `impersonatedBy` pour que l'on sache qui a testé.
  //
  // QUI EST À L'ÉCRAN (Direction, 06/10 — « pas de chevauchement possible ») : la règle tient dans
  // `vueHonoree` (vue-exacte-ui.ts). Tout ce qui s'AFFICHE voit la vue — y compris le rendu qui suit une
  // action et les actions qui ne font que lire (`enLecture(requireUser)`) ; seul le CORPS d'une écriture part
  // au nom du Super Admin, qui garde alors `visualise` : un geste réservé à « soi » (Adam) sait le refuser.
  let visualise: CurrentUser["visualise"];
  const roleReel = compte?.role ?? session.user.role;
  const targetId = roleReel === "SUPER_ADMIN" ? cookieDeVue() : undefined;
  if (targetId && targetId !== session.user.id) {
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    if (target && target.isActive) {
      const honoree = vueHonoree({
        ecriture: !!opts.ecriture,
        auNomDeLaVue: !!opts.auNomDeLaVue,
        lecture: lectureDeclaree(),
        actionServeur: actionServeurEnCours(),
        rendu: rendreEnCours(),
      });
      if (!honoree) visualise = { id: target.id, name: target.name };
      else {
        const targetAccess = await getAccess(target.id, target.role);
        return {
          id: target.id,
          name: target.name,
          email: target.email,
          role: target.role,
          secondaryRole: targetAccess.secondaryRole,
          access: targetAccess,
          sid,
          mustChangePassword: false,
          impersonatedBy: { id: session.user.id, name: session.user.name ?? "Administrateur" },
        };
      }
    }
  }

  const access = await getAccess(session.user.id, session.user.role);
  return {
    id: session.user.id,
    name: session.user.name ?? "",
    email: session.user.email ?? "",
    // Rôle EN DIRECT depuis la base (résolu par getAccess) : le JWT fige le rôle au login,
    // donc un compte dont le rôle a changé (ex. promu National Sales) verrait sinon un accès
    // ET un libellé de rôle périmés jusqu'à sa reconnexion. La « Vue exacte » lisant déjà le
    // rôle en base, l'écran réel de l'utilisateur devient fidèle à ce que l'admin y voit.
    role: access.role ?? session.user.role,
    secondaryRole: access.secondaryRole,
    access,
    sid,
    mustChangePassword: session.user.mustChangePassword ?? false,
    ...(visualise ? { visualise } : {}),
  };
}

/** Returns the signed-in user (with resolved access) or redirects to /login. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await build(await auth());
  if (!user) redirect("/login");
  return user;
}

/**
 * L'utilisateur AU NOM DE QUI se crée une demande : la personne que le Super Admin visualise en « Vue
 * exacte », sinon l'utilisateur réel. Réservé aux actions de CRÉATION d'une demande (Ad & Pro) — toute
 * autre écriture reste au nom du Super Admin (§118.184).
 */
export async function requireUserAuNomDeLaVue(): Promise<CurrentUser> {
  const user = await build(await auth(), { auNomDeLaVue: true });
  if (!user) redirect("/login");
  return user;
}

/**
 * Première destination de navigation que l'utilisateur peut **réellement voir**.
 * Sert d'atterrissage sûr en cas de refus : on ne renvoie JAMAIS vers une page qui
 * le refuserait à nouveau (sinon boucle infinie, ex. un refus de DASHBOARD renvoyé
 * vers /dashboard). Parcourt la navigation dans l'ordre de la barre latérale.
 */
export function safeLanding(user: CurrentUser): string {
  return firstAccessibleHref((module) => userCan(user, module, "VIEW")) ?? "/no-access";
}

/**
 * Guards a module page. Redirects unauthenticated users to /login, users who
 * must change their password to /change-password, and unauthorised users to a
 * **safe landing** (the first tab they can actually see). Enforced via the
 * user's *effective* access. Never redirects to a page the user can't view —
 * which would otherwise cause an `ERR_TOO_MANY_REDIRECTS` loop.
 */
export async function requireModule(
  module: Module,
  action: Action = "VIEW",
): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  if (!userCan(user, module, action)) {
    redirect(`${safeLanding(user)}?denied=${module}`);
  }
  // MODULE MASQUÉ : la garde de navigation ne suffit pas. Sans ce contrôle, « masqué » ne
  // voudrait dire que « absent du menu », et un lien envoyé par courriel il y a un mois
  // rouvrirait l'écran qu'on croyait retiré. Le Super Admin passe : il doit pouvoir vérifier
  // ce qu'il vient d'éteindre, et le rallumer.
  const { hiddenModules } = await getAppSettings();
  if (!canOpenModule(module, hiddenModules, { isSuperAdmin: user.role === "SUPER_ADMIN" })) {
    redirect(`${safeLanding(user)}?masque=${module}`);
  }
  return user;
}

/** Non-redirecting variant for layouts / optional checks. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  return build(await auth());
}

/**
 * La personne au nom de qui une route d'API ÉCRIT — jamais la personne qu'un Super Admin visualise
 * en « Vue exacte » (§118.184). Toute route POST/PUT/PATCH/DELETE l'appelle à la place de
 * `getCurrentUser` : une action serveur se reconnaît d'elle-même, une route d'API non.
 */
export async function getCurrentUserPourEcrire(): Promise<CurrentUser | null> {
  return build(await auth(), { ecriture: true });
}
