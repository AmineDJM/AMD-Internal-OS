import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { resolveGoogleConfig, isExpectedAccount, GOOGLE_USERINFO_URL } from "@/lib/google/config";
import { exchangeCode, verifyState, readIdTokenClaims, revokeToken, GoogleAuthError } from "@/lib/google/oauth";
import { saveGoogleConnection } from "@/lib/google/connection";
import { ensureWatch } from "@/lib/google/gmail/reconcile";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

const PKCE_COOKIE = "amd_google_pkce";

/**
 * RETOUR DE GOOGLE.
 *
 * Quatre vérifications avant d'enregistrer quoi que ce soit, et aucune n'est décorative :
 *   1. le `state` est **signé** et récent — sinon un lien de retour forgé permettrait de brancher
 *      la boîte d'un attaquant sur le compte du PDG, qui enverrait alors des messages en son nom
 *      sans jamais s'en apercevoir ;
 *   2. le `state` désigne **la personne connectée** — un `state` valide volé ne sert à rien ;
 *   3. le vérificateur PKCE vient du cookie de CE navigateur — un code intercepté est inutilisable
 *      ailleurs ;
 *   4. la boîte réellement connectée est **celle d'Adam** — sinon on révoque immédiatement le
 *      consentement obtenu par erreur plutôt que de garder l'accès à la boîte de quelqu'un d'autre.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const env = process.env as Record<string, string | undefined>;
  const base = env.APP_URL || req.nextUrl.origin;
  const back = (q: string) => NextResponse.redirect(new URL(`/chief-of-staff/reglages?${q}`, base));

  if (!hasGlobalView(user)) return back("erreur=droit");

  const error = req.nextUrl.searchParams.get("error");
  if (error) return back("erreur=refus"); // la personne a refusé, ou Google a refusé : même écran

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stateUser = verifyState(state);
  if (!code || !stateUser || stateUser !== user.id) return back("erreur=state");

  const verifier = (await cookies()).get(PKCE_COOKIE)?.value;
  if (!verifier) return back("erreur=state");
  (await cookies()).delete(PKCE_COOKIE);

  const cfg = resolveGoogleConfig(env);
  if (!cfg) return back("erreur=non-configure");

  try {
    const tokens = await exchangeCode(cfg, code, verifier);

    // Qui vient d'être connecté ? On lit d'abord l'`id_token` (obtenu à l'instant, contre notre
    // secret, sans passer par le navigateur), et on retombe sur `userinfo` s'il manque.
    const claims = readIdTokenClaims(tokens.idToken);
    let address = claims.email;
    let displayName = claims.name;
    if (!address) {
      const res = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      const me = (await res.json().catch(sansBloquer("callback-route.GET.json", {}))) as { email?: string; name?: string; sub?: string };
      address = me.email?.toLowerCase() ?? null;
      displayName = me.name ?? null;
    }
    if (!address) {
      console.error("[adam][google-callback] profil sans adresse exploitable");
      return back("erreur=profil");
    }

    if (!isExpectedAccount(cfg, address)) {
      // Un consentement donné depuis le mauvais compte : on ne le garde pas une seconde.
      await revokeToken(tokens.refreshToken ?? tokens.accessToken);
      console.error("[adam][google-callback] compte inattendu — consentement révoqué");
      return back("erreur=mauvais-compte");
    }

    await saveGoogleConnection({
      userId: user.id,
      address,
      displayName: displayName ?? null,
      googleSub: claims.sub,
      tokens,
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Chief of Staff",
      summary: `Compte Google d'Adam connecté (${address})`,
    });

    // La veille s'arme tout de suite : un Adam connecté mais sourd n'a aucun intérêt.
    const conn = await import("@/lib/google/gmail/reconcile").then((m) => m.adamConnection());
    if (conn) await ensureWatch(conn.id, { force: true }).catch(sansBloquer("callback-route.GET.ensureWatch"));

    return back("connecte=1");
  } catch (err) {
    // Aucun détail dans l'URL : un message d'erreur peut contenir des éléments de la requête, et
    // une URL se partage par copier-coller. Le détail va au JOURNAL SERVEUR.
    const detail = err instanceof GoogleAuthError
      ? { providerCode: err.providerCode, httpStatus: err.httpStatus }
      : { message: err instanceof Error ? err.message.slice(0, 200) : "inconnu" };
    console.error("[adam][google-callback] échec", detail);
    return back("erreur=echec");
  }
}
