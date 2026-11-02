import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { resolveGoogleConfig } from "@/lib/google/config";
import { signState, makePkce, buildAuthorizeUrl } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

const PKCE_COOKIE = "amd_google_pkce";

/**
 * DÉPART DE LA CONNEXION GOOGLE D'ADAM.
 *
 * Réservé au PDG / Super Admin : la boîte d'Adam n'est pas une boîte d'entreprise partagée, c'est
 * l'identité de communication du chef de cabinet. Laisser n'importe qui la (re)connecter
 * reviendrait à laisser n'importe qui écrire au nom de la direction.
 *
 * Le vérificateur PKCE part dans un cookie `httpOnly` de CE navigateur : un code d'autorisation
 * intercepté est alors inutilisable ailleurs.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const env = process.env as Record<string, string | undefined>;
  const base = env.APP_URL || req.nextUrl.origin;
  const back = (q: string) => NextResponse.redirect(new URL(`/chief-of-staff/reglages?${q}`, base));

  if (!hasGlobalView(user)) return back("erreur=droit");

  const cfg = resolveGoogleConfig(env);
  if (!cfg) return back("erreur=non-configure");

  const { verifier, challenge } = makePkce();
  (await cookies()).set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(cfg, signState(user.id), challenge));
}
