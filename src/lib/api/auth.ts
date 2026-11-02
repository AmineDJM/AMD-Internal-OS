import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ApiError, errors } from "./errors";
import { hasAllScopes, normalizeScopes, isReadOnly, type Scope } from "./scopes";
import { sansBloquer } from "@/lib/journal";

/**
 * AUTHENTIFICATION DES AGENTS — machine à machine, jamais un compte humain partagé.
 *
 * Une clé porte une identité (`ApiClient`), des portées, et l'utilisateur au nom duquel l'agent
 * agit. C'est ce dernier point qui rend l'API sûre SANS réécrire une ligne de règle métier :
 * on reconstruit exactement le `SessionUser` de l'ERP, puis toutes les gardes existantes
 * (`userCan`, `scopeRegulatory`, `canAccessEntity`…) s'appliquent telles quelles. L'API ne
 * connaît donc pas de « droits d'API » parallèles qui pourraient diverger des droits réels.
 */

const PREFIX = "amd_sk_";

/** Émet une clé : 32 octets aléatoires. Rendue UNE SEULE FOIS — seule l'empreinte est stockée. */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, PREFIX.length + 6) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Comparaison à temps constant : comparer deux empreintes avec `===` fuit leur préfixe commun. */
export function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Lit la clé dans l'en-tête. Accepte « Bearer <clé> » et la clé nue, rien d'autre. */
export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const raw = (m ? m[1] : header).trim();
  return raw.startsWith(PREFIX) ? raw : null;
}

export interface ApiContext {
  client: { id: string; name: string; scopes: string[]; readOnly: boolean };
  /** L'utilisateur dont la portée s'applique — le cœur du dispositif. */
  user: SessionUser;
  correlationId: string;
}

/**
 * Authentifie une requête et reconstruit le contexte.
 *
 * Lève une `ApiError` explicite à chaque refus : « clé inconnue », « clé expirée », « client
 * désactivé » ne demandent pas la même correction, et un agent doit pouvoir les distinguer.
 */
export async function authenticate(authorization: string | null, correlationId: string): Promise<ApiContext> {
  const key = readBearer(authorization);
  if (!key) throw errors.unauthenticated();

  const hash = hashApiKey(key);
  const client = await prisma.apiClient.findUnique({
    where: { keyHash: hash },
    select: {
      id: true, name: true, scopes: true, isActive: true, expiresAt: true, keyHash: true,
      actAs: { select: { id: true, role: true, secondaryRole: true, isActive: true } },
    },
  });
  // Recherche par empreinte exacte : la comparaison à temps constant qui suit protège le cas où
  // l'index rendrait un enregistrement voisin, et documente l'intention.
  if (!client || !sameHash(client.keyHash, hash)) throw errors.invalidKey();
  if (!client.isActive) throw errors.disabled();
  if (client.expiresAt && client.expiresAt.getTime() < Date.now()) throw errors.expired();
  if (!client.actAs || !client.actAs.isActive) {
    throw new ApiError("CLIENT_DISABLED", "Ce client n'est rattaché à aucun utilisateur actif.", {
      hint: "Un agent agit toujours AU NOM d'une personne : c'est sa portée qui détermine ce qu'il voit.",
    });
  }

  const scopes = normalizeScopes(client.scopes);
  const access = await getAccess(client.actAs.id, client.actAs.role);
  const user: SessionUser = {
    id: client.actAs.id,
    role: client.actAs.role,
    secondaryRole: client.actAs.secondaryRole ?? null,
    access,
  };

  // Sans attendre : la date de dernier usage sert à repérer une clé oubliée, pas à bloquer.
  void prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } }).catch(sansBloquer("auth.authenticate.apiClient"));

  return {
    client: { id: client.id, name: client.name, scopes, readOnly: isReadOnly(scopes) },
    user,
    correlationId,
  };
}

/** Exige des portées, sinon refuse en disant lesquelles manquent. */
export function requireScopes(ctx: ApiContext, required: readonly Scope[]): void {
  if (!hasAllScopes(ctx.client.scopes, required)) {
    throw errors.missingScope([...required], ctx.client.scopes);
  }
}
