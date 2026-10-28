import type { CurrentUser } from "@/lib/session";
import { getActiveGoogleConnection } from "@/lib/google/connection";

/**
 * LE SOCLE DES OUTILS D'ADAM — les aides partagées par les morceaux de `adam-tools/` : le siège
 * exécutif (`EXEC`), la lecture des entrées, la date d'Alger, et la connexion Google active (ou le
 * message qui dit quoi faire).
 */

/** Le siège exécutif : PDG et Super Admin — Adam est LEUR chef de cabinet. */
export const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

export const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";
export const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const fr = (d: Date | null | undefined): string => {
  if (!d) return "—";
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
};

export const NOT_CONNECTED =
  "Le compte Google d'Adam n'est pas connecté (ou il est suspendu). Ouvrez les réglages du Chief of Staff pour le connecter — je ne peux rien lire ni préparer sans lui.";

/** La connexion active du PDG, ou le message qui dit quoi faire. Jamais une exception opaque. */
export async function activeOrMessage(userId: string): Promise<{ token: string; connectionId: string; address: string } | string> {
  try {
    const conn = await getActiveGoogleConnection(userId);
    if (!conn) return NOT_CONNECTED;
    return { token: conn.accessToken, connectionId: conn.id, address: conn.address };
  } catch {
    return "Le compte Google d'Adam doit être RECONNECTÉ (jeton expiré ou révoqué). Réglages du Chief of Staff → Reconnecter.";
  }
}
