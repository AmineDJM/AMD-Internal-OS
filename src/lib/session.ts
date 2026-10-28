import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { getAccess, userCan, type Action, type EffectiveAccess, type Module } from "./rbac";
import { firstAccessibleHref } from "./labels";
import { getAppSettings } from "./settings";
import { canOpenModule } from "./modules-visibility";
import { IMPERSONATE_COOKIE } from "./vue-exacte";
import { lireSessionRevocable, vueDemandee, type CompteDeSession, type OptionsDeSession } from "./session-compte";

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

async function build(session: Session | null, opts: OptionsDeSession = {}): Promise<CurrentUser | null> {
  if (!session?.user) return null;

  // La session révocable et le compte EN BASE (révocation, compte désactivé, rôle réel) puis la « Vue
  // exacte » : les deux règles vivent dans `session-compte.ts`, partagées avec l'identité légère des
  // sondages de la coque (`session-legere.ts`) — un sondage ne voit jamais ce qu'une page refuserait.
  const sid = session.user.sid;
  let compte: CompteDeSession | null | undefined;
  if (sid) {
    const lue = await lireSessionRevocable(sid);
    if (!lue) return null;
    compte = lue.compte;
    if (compte && !compte.isActive) return null;
  }

  // EXCEPTION VOULUE (Direction, 06/10) : la CRÉATION D'UNE DEMANDE sous « Vue exacte » se fait au nom de
  // la personne visualisée (`opts.auNomDeLaVue`, via `requireUserAuNomDeLaVue`), pour que le Super Admin
  // teste son parcours de bout en bout. Le CORPS de toute autre écriture part au nom du Super Admin, qui
  // garde alors `visualise` : un geste réservé à « soi » (Adam) sait le refuser.
  let visualise: CurrentUser["visualise"];
  const vue = await vueDemandee(compte?.role ?? session.user.role, session.user.id, opts);
  if (vue && !vue.honoree) visualise = { id: vue.cible.id, name: vue.cible.name };
  else if (vue) {
    const target = vue.cible;
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
