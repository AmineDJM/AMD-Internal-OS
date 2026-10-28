import crypto from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

/**
 * Authentification du PORTAIL FOURNISSEUR — totalement séparée de l'auth interne
 * (NextAuth). Comptes dans la table SupplierUser, session via un cookie signé HMAC
 * dédié, scopé au chemin /portail (jamais envoyé aux routes internes). Chaque
 * accès revalide en base que l'utilisateur ET le fournisseur sont toujours actifs.
 */

const COOKIE = "amd_portal_session";
const PATH = "/portail";
const MAX_AGE = 60 * 60 * 8; // 8 h

function signingKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "amd-internal-os";
  return crypto.createHmac("sha256", secret).update("supplier-portal-session-v1").digest();
}

function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token: string): { u: string; s: string; exp: number } | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", signingKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (typeof data.u !== "string" || typeof data.s !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export interface SupplierSession {
  supplierUserId: string;
  supplierId: string;
  supplierName: string;
  userName: string;
}

export async function setSupplierSession(supplierUserId: string, supplierId: string): Promise<void> {
  const token = sign({ u: supplierUserId, s: supplierId, exp: Date.now() + MAX_AGE * 1000 });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: PATH,
    maxAge: MAX_AGE,
  });
}

export async function clearSupplierSession(): Promise<void> {
  (await cookies()).set(COOKIE, "", { httpOnly: true, path: PATH, maxAge: 0 });
}

/** Lit + revalide la session fournisseur (DB), ou null si invalide/expirée/désactivée. */
export async function getSupplierSession(): Promise<SupplierSession | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const data = verifyToken(token);
  if (!data) return null;
  const su = await prisma.supplierUser.findUnique({
    where: { id: data.u },
    include: { supplier: { select: { id: true, name: true, active: true } } },
  });
  if (!su || !su.active || su.supplierId !== data.s || !su.supplier.active) return null;
  return { supplierUserId: su.id, supplierId: su.supplierId, supplierName: su.supplier.name, userName: su.name };
}

/** Garde de page : redirige vers le login du portail si pas de session valide. */
export async function requireSupplier(): Promise<SupplierSession> {
  const session = await getSupplierSession();
  if (!session) redirect("/portail/login");
  return session;
}
