import { prisma } from "@/lib/prisma";
import { sealSecret, openSecret } from "@/lib/crypto/secret-box";
import { resolveGoogleConfig, GOOGLE_SCOPES } from "./config";
import { computeMissingScopes, mergeGrantedScopes, normalizeScopes } from "./scopes";
import { refreshTokens, revokeToken, type GoogleTokenSet } from "./oauth";
import { GoogleApiError } from "./client";
import { sansBloquer } from "@/lib/journal";

/**
 * LA CONNEXION GOOGLE D'ADAM — et l'isolation, garantie par construction.
 *
 * Toute lecture part de `userId`. Aucune fonction de ce module n'accepte un identifiant de
 * connexion venu de l'extérieur : il n'y a donc **aucune URL à modifier** pour atteindre la boîte
 * de quelqu'un d'autre. Ce n'est pas une vérification qu'on pourrait oublier quelque part, c'est
 * la seule forme que prend l'accès.
 *
 * Les jetons dorment chiffrés (AES-256-GCM, `secret-box`) et ne sont déchiffrés qu'au moment
 * d'appeler Google. Ils ne sont **jamais** rendus au navigateur ni écrits dans un journal.
 */

export interface ActiveGoogleConnection {
  id: string;
  userId: string;
  address: string;
  displayName: string | null;
  accessToken: string;
}

/** L'état affichable d'une connexion — sans aucun jeton. */
export interface GoogleConnectionStatus {
  connected: boolean;
  address: string | null;
  displayName: string | null;
  status: string;
  paused: boolean;
  lastError: string | null;
  lastSyncAt: Date | null;
  /** Les droits accordés, et ceux qui MANQUENT — un consentement partiel doit se voir. */
  grantedScopes: string[];
  missingScopes: string[];
  /** Le jeton d'accès expire-t-il bientôt (information d'exploitation, jamais le jeton). */
  expiresAt: Date | null;
  hasRefreshToken: boolean;
}

export async function getGoogleStatus(userId: string): Promise<GoogleConnectionStatus> {
  const c = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!c) {
    return {
      connected: false, address: null, displayName: null, status: "none", paused: false,
      lastError: null, lastSyncAt: null, grantedScopes: [], missingScopes: [...GOOGLE_SCOPES],
      expiresAt: null, hasRefreshToken: false,
    };
  }
  const granted = normalizeScopes(c.grantedScopes);
  return {
    connected: c.status === "connected" && !c.paused,
    address: c.address,
    displayName: c.displayName,
    status: c.paused ? "paused" : c.status,
    paused: c.paused,
    lastError: c.lastError,
    lastSyncAt: c.lastSyncAt,
    grantedScopes: granted,
    missingScopes: computeMissingScopes(GOOGLE_SCOPES, c.grantedScopes),
    expiresAt: c.expiresAt,
    hasRefreshToken: Boolean(c.refreshTokenEnc),
  };
}

/** Enregistre (ou remplace) la connexion d'Adam après un consentement réussi. */
export async function saveGoogleConnection(opts: {
  userId: string;
  address: string;
  displayName: string | null;
  googleSub: string | null;
  tokens: GoogleTokenSet;
}): Promise<void> {
  // RECONNEXION INCRÉMENTALE : on part de ce que le compte possédait déjà. Écraser la liste par
  // celle du dernier échange ferait « perdre » un droit que Google n'a pas rappelé dans cette
  // réponse — et l'écran réclamerait de reconnecter pour un droit toujours accordé.
  const before = await prisma.googleConnection.findUnique({
    where: { userId: opts.userId },
    select: { grantedScopes: true },
  });
  const data = {
    address: opts.address.toLowerCase(),
    displayName: opts.displayName,
    googleSub: opts.googleSub,
    accessTokenEnc: sealSecret(opts.tokens.accessToken),
    refreshTokenEnc: opts.tokens.refreshToken ? sealSecret(opts.tokens.refreshToken) : null,
    expiresAt: opts.tokens.expiresAt,
    grantedScopes: mergeGrantedScopes(before?.grantedScopes, opts.tokens.scopes),
    status: "connected",
    lastError: null,
    paused: false,
  };
  await prisma.googleConnection.upsert({
    where: { userId: opts.userId },
    // Une RECONNEXION sans nouveau jeton de rafraîchissement (Google ne le rend qu'au premier
    // consentement) ne doit pas effacer celui qu'on a déjà : sinon la boîte tombe le lendemain.
    create: { userId: opts.userId, ...data },
    update: {
      ...data,
      ...(opts.tokens.refreshToken ? {} : { refreshTokenEnc: undefined }),
    },
  });
}

export async function markGoogleNeedsReconnect(userId: string, reason: string): Promise<void> {
  await prisma.googleConnection.updateMany({
    where: { userId },
    // Motif court : jamais de contenu de message, jamais de jeton.
    data: { status: "needs-reconnect", lastError: reason.slice(0, 200) },
  });
}

/**
 * Coupe la connexion, RÉVOQUE le consentement chez Google et efface les jetons.
 * Se déconnecter doit vraiment déconnecter : effacer sans révoquer laisserait l'autorisation
 * vivante côté Google, invisible depuis l'ERP.
 */
export async function disconnectGoogle(userId: string): Promise<{ revoked: boolean }> {
  const c = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!c) return { revoked: false };
  const refresh = openSecret(c.refreshTokenEnc) ?? openSecret(c.accessTokenEnc);
  const revoked = refresh ? await revokeToken(refresh) : false;
  await prisma.googleConnection.delete({ where: { id: c.id } });
  return { revoked };
}

/** COUPE-CIRCUIT : suspend Google (lecture ET écriture) sans perdre la connexion. */
export async function setGooglePaused(userId: string, paused: boolean): Promise<void> {
  await prisma.googleConnection.updateMany({ where: { userId }, data: { paused } });
}

/**
 * La connexion prête à l'emploi, jeton d'accès **valide** en main.
 *
 * Le rafraîchissement est fait ici, une fois pour toutes : chaque appelant qui devrait y penser
 * serait un appelant qui, un jour, ne le fait pas — et Adam tomberait toutes les heures sans
 * raison visible.
 *
 * Rend `null` quand il n'y a pas de connexion (ou qu'elle est suspendue). **Lève**
 * `GoogleApiError("unauthorized")` quand elle existe mais ne peut plus servir : les deux cas
 * appellent des écrans différents.
 */
export async function getActiveGoogleConnection(userId: string): Promise<ActiveGoogleConnection | null> {
  const c = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!c || c.paused) return null;

  const base = { id: c.id, userId: c.userId, address: c.address, displayName: c.displayName };

  const stillValid = c.expiresAt && c.expiresAt.getTime() > Date.now();
  const access = openSecret(c.accessTokenEnc);
  if (stillValid && access) return { ...base, accessToken: access };

  const refresh = openSecret(c.refreshTokenEnc);
  if (!refresh) {
    await markGoogleNeedsReconnect(userId, "Aucun jeton de rafraîchissement — reconnexion nécessaire.");
    throw new GoogleApiError("unauthorized", 401, "noRefreshToken");
  }

  const cfg = resolveGoogleConfig(process.env as Record<string, string | undefined>);
  if (!cfg) throw new GoogleApiError("unknown", 0, "notConfigured");

  try {
    const tokens = await refreshTokens(cfg, refresh);
    await prisma.googleConnection.update({
      where: { id: c.id },
      data: {
        accessTokenEnc: sealSecret(tokens.accessToken),
        // Google ne fait pas systématiquement tourner le jeton de rafraîchissement ; quand il en
        // rend un, ne pas l'enregistrer ferait tomber la connexion plus tard, sans explication.
        refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken) : c.refreshTokenEnc,
        expiresAt: tokens.expiresAt,
        grantedScopes: mergeGrantedScopes(c.grantedScopes, tokens.scopes),
        status: "connected",
        lastError: null,
      },
    });
    return { ...base, accessToken: tokens.accessToken };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Rafraîchissement impossible.";
    await markGoogleNeedsReconnect(userId, reason);
    throw new GoogleApiError("unauthorized", 401, "refreshFailed");
  }
}

/** Note la dernière synchronisation réussie — l'écran doit pouvoir dire « à jour il y a 2 min ». */
export async function touchGoogleSync(connectionId: string): Promise<void> {
  await prisma.googleConnection.update({ where: { id: connectionId }, data: { lastSyncAt: new Date() } }).catch(sansBloquer("connection.touchGoogleSync.googleConnection"));
}
