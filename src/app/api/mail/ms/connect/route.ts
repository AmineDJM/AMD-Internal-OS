import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { mailAccess } from "@/lib/mail/access";
import { resolveMicrosoftConfig } from "@/lib/mail/config";
import { buildAuthorizeUrl, makePkce, signState } from "@/lib/mail/oauth";

export const dynamic = "force-dynamic";

/** Cookie du vérificateur PKCE — court, strict, et jamais lisible par un script de page. */
const PKCE_COOKIE = "amd_ms_pkce";

/**
 * DÉPART DE LA CONNEXION MICROSOFT.
 *
 * On ne redirige QUE si la personne a le droit d'entrer : sans ce contrôle, quelqu'un hors pilote
 * arriverait sur l'écran de consentement Microsoft, accepterait, puis se verrait refuser à son
 * retour — après avoir donné un consentement pour rien.
 */
export async function GET() {
  const user = await requireUser();
  const env = process.env as Record<string, string | undefined>;

  const access = mailAccess(user as never, env);
  if (!access.allowed) {
    return NextResponse.redirect(new URL(`/messagerie?erreur=${access.reason}`, env.APP_URL || "http://localhost:3000"));
  }
  const cfg = resolveMicrosoftConfig(env);
  if (!cfg) {
    return NextResponse.redirect(new URL("/messagerie?erreur=not-configured", env.APP_URL || "http://localhost:3000"));
  }

  const { verifier, challenge } = makePkce();
  (await cookies()).set(PKCE_COOKIE, verifier, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/mail/ms", maxAge: 600,
  });

  // `login_hint` avec l'adresse de l'ERP : sur un poste où plusieurs comptes Microsoft ont servi,
  // cela évite de connecter par mégarde la boîte de quelqu'un d'autre.
  const state = signState(user.id);
  return NextResponse.redirect(buildAuthorizeUrl(cfg, state, challenge, user.email ?? undefined));
}
