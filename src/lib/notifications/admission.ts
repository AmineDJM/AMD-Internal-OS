import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  anyRoleFilter, getAccess, ouvreLeBureauAdam, peutUtiliserAssistantIA, rolesWithModule, userCan,
  type Module, type SessionUser,
} from "@/lib/rbac";
import { sitsOnPaymentCentre } from "@/modules/finances/partage";
import { siegeAuCentreAdPro } from "@/modules/ad-pro/partage";
import { ouvreLeCentreDeValidations } from "@/lib/validations/centre";
import { journal } from "@/lib/journal";
import { admisParLaPorte, clauseLiensFermes, porteDuLien, type Adresse } from "./porte-du-lien";

/**
 * L'ADMISSION DES DESTINATAIRES D'UNE NOTIFICATION — la seule porte (Super Admin, 25/11/2026 : « C'est très important, le
 * système de notification »).
 *
 * Tous les écrivains de notifications y passent AVANT d'écrire (`notifyUser`, `notifyRoles`, `notifyModule`,
 * `broadcastNotification`, et les `createMany` directs des tâches et des directives) : le destinataire qui ne peut pas
 * ouvrir le module du lien est RETIRÉ, sans bruit pour l'appelant, et le retrait est JOURNALISÉ. La lecture (cloche,
 * page, « Aujourd'hui », boîte) et l'envoi poussé relisent la même règle : une notification dont le lien n'est plus
 * ouvrable — droits retirés depuis — ne s'affiche plus, sans être effacée.
 *
 * L'écriture elle-même reste DANS le corps de chaque écrivain (`ecrire.ts` dit pourquoi : la dérivation des contrats lit
 * un seul niveau) ; ce module ne fait que LIRE.
 */

/**
 * PEUT-IL OUVRIR CE MODULE ? Le « Voir » du module, sauf là où le module a SA règle — un siège n'est pas un droit de lecture
 * (le centre de paiement : la Direction générale seule, même si la console coche la case à un autre).
 */
export function ouvreLeModule(user: SessionUser, module: Module): boolean {
  switch (module) {
    case "PAYMENT_CENTRE": return sitsOnPaymentCentre(user);
    case "VALIDATION_CENTRE": return ouvreLeCentreDeValidations(user);
    case "AD_PRO_CENTRE": return siegeAuCentreAdPro(user);
    case "ASSISTANT_IA": return peutUtiliserAssistantIA(user);
    case "CHIEF_OF_STAFF": return ouvreLeBureauAdam(user);
    default: return userCan(user, module, "VIEW");
  }
}

/** Les comptes, avec leur accès RÉSOLU (`getAccess` : rôle, « autre rôle », console, accès implicites). */
async function sessionsDe(ids: readonly string[]): Promise<Map<string, SessionUser>> {
  const lus = ids.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, role: true, secondaryRole: true } })
    : [];
  const sessions = new Map<string, SessionUser>();
  for (const u of lus) {
    sessions.set(u.id, { id: u.id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(u.id, u.role) });
  }
  return sessions;
}

/**
 * LES DESTINATAIRES ADMIS — ceux, parmi `ids`, que le lien ne trahit pas. Un lien sans module (ou une fiche adressée
 * nommément) ne coûte aucune lecture. Un compte introuvable est laissé : l'écriture le refusera et le rejeu le compte
 * (`ecrire.ts`). Ne lève jamais : un doute sur les droits RETIRE le destinataire plutôt que d'interrompre l'envoi.
 */
export async function admettreDestinataires(
  ids: readonly string[], lien: string | null | undefined, adresse: Adresse, origine: string,
): Promise<string[]> {
  const porte = porteDuLien(lien);
  if (!porte.connu) journal.info("notification.lien-sans-module", { origine, lien });
  if (!porte.module || ids.length === 0) return [...ids];
  if (admisParLaPorte(porte, () => false, adresse)) return [...ids];
  const module = porte.module;
  let sessions: Map<string, SessionUser>;
  try {
    sessions = await sessionsDe(ids);
  } catch (e) {
    journal.avertissement("notification.admission-illisible", { origine, lien, module }, e);
    return [];
  }
  const admis: string[] = [];
  const retires: string[] = [];
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s || ouvreLeModule(s, module)) admis.push(id);
    else retires.push(id);
  }
  if (retires.length) {
    journal.info("notification.destinataires-retires", { origine, lien, module, adresse, retires });
  }
  return admis;
}

/**
 * LA MÊME ADMISSION POUR UN LOT DE LIGNES DÉJÀ COMPOSÉES — les écrivains directs (`createMany` des tâches, des
 * directives) : chaque ligne passe la règle avec SON lien. Rend les lignes admises, dans leur ordre.
 */
export async function admettreLignes<L extends { userId: string; link?: string | null }>(
  lignes: readonly L[], adresse: Adresse, origine: string,
): Promise<L[]> {
  const parLien = new Map<string, string[]>();
  for (const l of lignes) {
    const cle = l.link ?? "";
    parLien.set(cle, [...(parLien.get(cle) ?? []), l.userId]);
  }
  const admis = new Set<string>();
  for (const [lien, ids] of parLien) {
    for (const id of await admettreDestinataires(ids, lien || null, adresse, origine)) admis.add(`${lien}\u0000${id}`);
  }
  return lignes.filter((l) => admis.has(`${l.link ?? ""}\u0000${l.userId}`));
}

/** Une seule ligne, adressée nommément : la personne est-elle admise ? (les `create` directs). */
export async function lienAdmis(userId: string, lien: string | null | undefined, origine: string): Promise<boolean> {
  return (await admettreDestinataires([userId], lien, "nominatif", origine)).length > 0;
}

/** Ce lien est-il ouvrable par cette personne ? — la règle de LECTURE (une fiche se lit comme nominative). */
export function lienOuvrable(user: SessionUser, lien: string | null | undefined): boolean {
  return admisParLaPorte(porteDuLien(lien), (m) => ouvreLeModule(user, m), "nominatif");
}

/** La même question pour une personne désignée par son seul identifiant (l'envoi poussé différé). */
export async function lienOuvrablePour(userId: string, lien: string | null | undefined): Promise<boolean> {
  const porte = porteDuLien(lien);
  if (admisParLaPorte(porte, () => false, "nominatif")) return true;
  const s = (await sessionsDe([userId])).get(userId);
  return !s || lienOuvrable(s, lien);
}

/**
 * LA CLAUSE DE LECTURE — à ajouter à toute requête de notifications d'une personne (liste, compte, badge) : ses
 * notifications dont le lien ne lui est plus ouvrable n'en sortent pas. Rien n'est effacé : la règle se relit à chaque
 * lecture, et rendre le module rend les notifications.
 */
export function clauseNotificationsOuvrables(user: SessionUser): Prisma.NotificationWhereInput {
  return (clauseLiensFermes((m) => ouvreLeModule(user, m)) ?? {}) as Prisma.NotificationWhereInput;
}

/**
 * LA MÊME CLAUSE POUR LE SONDAGE DE LA COQUE (`/api/notifications/poll`, toutes les 15 s par onglet), qui ne résout pas
 * l'accès complet (PERF-06). Calculée au plus une fois par minute et par personne : un droit retiré se reflète dans la
 * minute, sans huit lectures de plus à chaque sondage.
 */
const MEMOIRE_MS = 60_000;
const memoire = new Map<string, { jusqua: number; clause: Prisma.NotificationWhereInput }>();
export async function clauseOuvrablesDe(userId: string, role: UserRole): Promise<Prisma.NotificationWhereInput> {
  const now = Date.now();
  const deja = memoire.get(userId);
  if (deja && deja.jusqua > now) return deja.clause;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { secondaryRole: true } });
  const clause = clauseNotificationsOuvrables({ id: userId, role, secondaryRole: u?.secondaryRole ?? null, access: await getAccess(userId, role) });
  if (memoire.size > 5_000) memoire.clear();
  memoire.set(userId, { jusqua: now + MEMOIRE_MS, clause });
  return clause;
}

/**
 * LES PERSONNES QUI ONT LE MODULE — et non les rôles qu'on croit l'avoir : le rôle (ou l'« autre rôle ») qui l'a par
 * défaut, et toute personne à qui la console l'ouvre ; puis la règle propre du module (un siège), sur l'accès résolu.
 * Celui que la console bloque n'y est plus ; celui qu'elle y fait entrer y est.
 */
export async function personnesAyantLeModule(module: Module): Promise<string[]> {
  const roles = rolesWithModule(module) as UserRole[];
  const candidats = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [...(roles.length ? [anyRoleFilter(roles)] : []), { access: { some: { module, canView: true } } }],
    },
    select: { id: true },
  });
  const sessions = await sessionsDe(candidats.map((c) => c.id));
  return [...sessions.values()].filter((s) => ouvreLeModule(s, module)).map((s) => s.id);
}
