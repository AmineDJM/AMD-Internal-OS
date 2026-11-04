import type { SessionUser } from "@/lib/rbac";
import { microsoftMailEnabled, pilotMailboxes, resolveMicrosoftConfig, missingMicrosoftVars, type Env } from "./config";

/**
 * QUI A LE DROIT D'OUVRIR LA MESSAGERIE MICROSOFT — pendant le pilote, et après.
 *
 * Trois verrous, dans cet ordre, et chacun a une raison distincte :
 *   1. **le drapeau** `MICROSOFT_MAIL` : tant qu'il est fermé, le module n'existe pour personne,
 *      même configuré. C'est ce qui permet de déployer le code avant d'ouvrir le service ;
 *   2. **la configuration** : sans les variables d'Entra, proposer « Connecter ma boîte » mènerait
 *      à un écran d'erreur Microsoft incompréhensible ;
 *   3. **la liste pilote** : on valide sur UNE boîte avant d'ouvrir à l'entreprise. Le Super Admin
 *      passe toujours — c'est lui qui mène le pilote.
 *
 * Le résultat dit POURQUOI c'est fermé, pas seulement que ça l'est : « configurez le serveur » et
 * « vous n'êtes pas dans le pilote » appellent deux actions très différentes.
 *
 * Module PUR — testé (l'environnement est reçu en argument).
 */

export type MailAccessReason = "ok" | "flag-off" | "not-configured" | "not-in-pilot";

export interface MailAccess {
  allowed: boolean;
  reason: MailAccessReason;
  /** Ce qui manque côté serveur, nommé — vide quand ce n'est pas le sujet. */
  missingVars: string[];
}

export const ACCESS_MESSAGE: Record<MailAccessReason, string> = {
  ok: "",
  "flag-off": "La messagerie Microsoft 365 n'est pas encore ouverte sur cette plateforme.",
  "not-configured": "La messagerie Microsoft 365 n'est pas configurée sur ce serveur.",
  "not-in-pilot": "La messagerie Microsoft 365 est en phase pilote : votre boîte n'y est pas encore.",
};

/** La valeur de `MICROSOFT_MAIL_PILOT` qui ouvre la messagerie à toute l'entreprise. */
export const OUVERT_A_TOUS = "*";

export function mailAccess(
  user: Pick<SessionUser, "role"> & { email?: string | null },
  env: Env,
): MailAccess {
  if (!microsoftMailEnabled(env)) return { allowed: false, reason: "flag-off", missingVars: [] };
  if (!resolveMicrosoftConfig(env)) {
    return { allowed: false, reason: "not-configured", missingVars: missingMicrosoftVars(env) };
  }
  // Le Super Admin mène le pilote : il entre toujours, sans avoir à s'inscrire dans sa propre liste.
  if (user.role === "SUPER_ADMIN") return { allowed: true, reason: "ok", missingVars: [] };

  const pilot = pilotMailboxes(env);
  // Liste vide = pilote fermé, Super Admin seulement. C'est le comportement voulu au premier jour :
  // ouvrir à tous par défaut sur une liste oubliée serait exactement la mauvaise valeur par défaut.
  if (pilot.length === 0) return { allowed: false, reason: "not-in-pilot", missingVars: [] };

  const email = (user.email ?? "").trim().toLowerCase();
  // L'OUVERTURE À L'ENTREPRISE (Direction, 04/11/2026) : `MICROSOFT_MAIL_PILOT=*` fait entrer chaque compte qui a une adresse.
  // Un choix ÉCRIT, jamais un défaut : la liste vide reste fermée. La connexion, elle, ne s'ouvre qu'aux comptes du
  // locataire Microsoft de la société (`MICROSOFT_TENANT_ID`) — l'étoile n'ouvre pas la porte aux boîtes d'ailleurs.
  if (email && pilot.includes(OUVERT_A_TOUS)) return { allowed: true, reason: "ok", missingVars: [] };
  if (email && pilot.includes(email)) return { allowed: true, reason: "ok", missingVars: [] };
  return { allowed: false, reason: "not-in-pilot", missingVars: [] };
}
