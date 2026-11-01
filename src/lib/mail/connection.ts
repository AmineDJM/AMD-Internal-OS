import { prisma } from "@/lib/prisma";
import { sealSecret, openSecret } from "@/lib/crypto/secret-box";
import { resolveMicrosoftConfig } from "./config";
import { refreshTokens, type TokenSet } from "./oauth";
import { MailError } from "./provider";

/**
 * LA CONNEXION D'UNE PERSONNE À SA BOÎTE — et l'isolation, garantie par construction.
 *
 * Toute lecture part de `userId`. Aucune fonction de ce module n'accepte un identifiant de boîte
 * ou de connexion venu de l'extérieur : il n'y a donc **aucune URL à modifier** pour atteindre la
 * boîte de quelqu'un d'autre. Ce n'est pas une vérification qu'on pourrait oublier quelque part,
 * c'est la seule forme que prend l'accès.
 *
 * Les jetons dorment chiffrés (AES-256-GCM) et ne sont déchiffrés qu'au moment d'appeler Graph.
 * Ils ne sont **jamais** rendus au navigateur ni écrits dans un journal.
 */

export interface ActiveConnection {
  id: string;
  userId: string;
  address: string;
  displayName: string | null;
  signature: string | null;
  accessToken: string;
}

/** L'état affichable d'une connexion — sans aucun jeton. */
export interface ConnectionStatus {
  connected: boolean;
  address: string | null;
  displayName: string | null;
  status: string;
  lastError: string | null;
  lastSyncAt: Date | null;
  signature: string | null;
}

export async function getConnectionStatus(userId: string): Promise<ConnectionStatus> {
  const c = await prisma.mailConnection.findUnique({ where: { userId } });
  if (!c) return { connected: false, address: null, displayName: null, status: "none", lastError: null, lastSyncAt: null, signature: null };
  return {
    connected: c.status === "connected",
    address: c.address,
    displayName: c.displayName,
    status: c.status,
    lastError: c.lastError,
    lastSyncAt: c.lastSyncAt,
    signature: c.signature,
  };
}

/** Enregistre (ou remplace) la connexion d'une personne après un consentement réussi. */
export async function saveConnection(opts: {
  userId: string;
  address: string;
  displayName: string | null;
  homeAccountId: string | null;
  tokens: TokenSet;
}): Promise<void> {
  const data = {
    provider: "microsoft",
    address: opts.address.toLowerCase(),
    displayName: opts.displayName,
    homeAccountId: opts.homeAccountId,
    accessTokenEnc: sealSecret(opts.tokens.accessToken),
    refreshTokenEnc: opts.tokens.refreshToken ? sealSecret(opts.tokens.refreshToken) : null,
    expiresAt: opts.tokens.expiresAt,
    grantedScopes: opts.tokens.scopes,
    status: "connected",
    lastError: null,
  };
  await prisma.mailConnection.upsert({
    where: { userId: opts.userId },
    create: { userId: opts.userId, ...data },
    update: data,
  });
}

/** Marque la connexion à reconnecter — l'écran doit distinguer « en panne » de « à reconnecter ». */
export async function markNeedsReconnect(userId: string, reason: string): Promise<void> {
  await prisma.mailConnection.updateMany({
    where: { userId },
    // On ne garde qu'un motif court : jamais de contenu de message, jamais de jeton.
    data: { status: "needs-reconnect", lastError: reason.slice(0, 200) },
  });
}

/** Coupe la connexion et EFFACE les jetons — se déconnecter doit vraiment déconnecter. */
export async function disconnect(userId: string): Promise<void> {
  const c = await prisma.mailConnection.findUnique({ where: { userId }, select: { id: true } });
  if (!c) return;
  await prisma.mailFolderState.deleteMany({ where: { connectionId: c.id } });
  // K10b (décision 0040) : les liens de provenance partaient EN CASCADE, hors du journal — retirés ici, un par un, ils
  // sont journalisés : la déconnexion s'annule (connexion, dossiers et liens recréés à l'identique, mêmes identifiants).
  await prisma.mailLink.deleteMany({ where: { connectionId: c.id } });
  await prisma.mailConnection.delete({ where: { id: c.id } });
}

/**
 * La connexion prête à l'emploi, jeton d'accès **valide** en main.
 *
 * Le rafraîchissement est fait ici, une fois pour toutes : chaque appelant qui devrait y penser
 * serait un appelant qui, un jour, ne le fait pas — et l'utilisateur verrait sa messagerie tomber
 * toutes les heures sans raison visible.
 *
 * Rend `null` quand il n'y a pas de connexion. **Lève** `MailError("unauthorized")` quand elle
 * existe mais ne peut plus servir : les deux cas appellent des écrans différents.
 */
export async function getActiveConnection(userId: string): Promise<ActiveConnection | null> {
  const c = await prisma.mailConnection.findUnique({ where: { userId } });
  if (!c) return null;

  const base = { id: c.id, userId: c.userId, address: c.address, displayName: c.displayName, signature: c.signature };

  const stillValid = c.expiresAt && c.expiresAt.getTime() > Date.now();
  const access = openSecret(c.accessTokenEnc);
  if (stillValid && access) return { ...base, accessToken: access };

  const refresh = openSecret(c.refreshTokenEnc);
  if (!refresh) {
    await markNeedsReconnect(userId, "Aucun jeton de rafraîchissement — reconnexion nécessaire.");
    throw new MailError("unauthorized", "Votre boîte Microsoft doit être reconnectée.");
  }

  const cfg = resolveMicrosoftConfig(process.env as Record<string, string | undefined>);
  if (!cfg) throw new MailError("unknown", "La messagerie Microsoft n'est pas configurée sur ce serveur.");

  try {
    const tokens = await refreshTokens(cfg, refresh);
    await prisma.mailConnection.update({
      where: { id: c.id },
      data: {
        accessTokenEnc: sealSecret(tokens.accessToken),
        // Microsoft fait tourner les jetons de rafraîchissement : ne pas enregistrer le nouveau
        // ferait tomber la connexion au bout de quelques jours, sans explication.
        refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken) : c.refreshTokenEnc,
        expiresAt: tokens.expiresAt,
        grantedScopes: tokens.scopes || c.grantedScopes,
        status: "connected",
        lastError: null,
      },
    });
    return { ...base, accessToken: tokens.accessToken };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Rafraîchissement impossible.";
    await markNeedsReconnect(userId, reason);
    throw new MailError("unauthorized", "Votre boîte Microsoft doit être reconnectée.");
  }
}

/** Le jeton de delta d'un dossier — chiffré au repos comme les autres. */
export async function readDeltaToken(connectionId: string, folderId: string): Promise<string | null> {
  const row = await prisma.mailFolderState.findUnique({
    where: { connectionId_folderId: { connectionId, folderId } },
    select: { deltaTokenEnc: true },
  });
  return openSecret(row?.deltaTokenEnc);
}

export async function writeFolderState(opts: {
  connectionId: string;
  folderId: string;
  displayName?: string | null;
  wellKnown?: string | null;
  deltaToken?: string | null;
  unread?: number;
  total?: number;
}): Promise<void> {
  const data = {
    displayName: opts.displayName ?? undefined,
    wellKnown: opts.wellKnown ?? undefined,
    deltaTokenEnc: opts.deltaToken !== undefined ? (opts.deltaToken ? sealSecret(opts.deltaToken) : null) : undefined,
    unread: opts.unread ?? undefined,
    total: opts.total ?? undefined,
    lastSyncAt: new Date(),
  };
  await prisma.mailFolderState.upsert({
    where: { connectionId_folderId: { connectionId: opts.connectionId, folderId: opts.folderId } },
    create: { connectionId: opts.connectionId, folderId: opts.folderId, ...data, unread: opts.unread ?? 0, total: opts.total ?? 0 },
    update: data,
  });
}
