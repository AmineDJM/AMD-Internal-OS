import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { resolveMicrosoftConfig, GRAPH_BASE } from "@/lib/mail/config";
import { exchangeCode, verifyState, MicrosoftAuthError } from "@/lib/mail/oauth";
import { saveConnection } from "@/lib/mail/connection";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

const PKCE_COOKIE = "amd_ms_pkce";

/**
 * L'ÉTAPE EN COURS — pour qu'un échec dise OÙ il s'est produit.
 *
 * Les trois appels du bloc `try` peuvent échouer pour des raisons totalement différentes (Microsoft
 * refuse le jeton · Graph refuse le profil · la base refuse l'écriture) et produisaient tous le
 * même `erreur=echec`. Sans cette étiquette, le journal ne permet pas de trancher.
 */
type Stage = "token" | "graph-me" | "save";

/**
 * JOURNAL DE DIAGNOSTIC — TEMPORAIRE, et sûr par construction.
 *
 * Ce qui entre ici : l'étape, le nom et le message de l'erreur, le code du fournisseur, les statuts
 * HTTP, le code d'erreur Prisma. Ce qui n'y entre JAMAIS : le code OAuth, le vérificateur PKCE, le
 * jeton d'accès, le jeton de rafraîchissement, le secret d'application. Le message est tronqué —
 * une erreur de base de données peut recopier une requête entière.
 *
 * À RETIRER une fois la cause identifiée.
 */
function logFailure(stage: Stage, userId: string, err: unknown, graphStatus: number | null): void {
  const e = err as { name?: unknown; message?: unknown; code?: unknown };
  const detail: Record<string, unknown> = {
    stage,
    userId,
    errorName: typeof e?.name === "string" ? e.name : typeof err,
    errorMessage: typeof e?.message === "string" ? e.message.slice(0, 300) : null,
    // Code d'erreur Prisma (P2002, P2021…) quand c'est la base qui refuse.
    errorCode: typeof e?.code === "string" || typeof e?.code === "number" ? e.code : null,
    graphStatus,
  };
  if (err instanceof MicrosoftAuthError) {
    detail.providerCode = err.providerCode;
    detail.providerHttpStatus = err.httpStatus;
    detail.aadCodes = err.aadCodes;
  }
  console.error("[ms-mail][callback] échec", detail);
}

/**
 * RETOUR DE MICROSOFT.
 *
 * Trois vérifications avant d'enregistrer quoi que ce soit, et aucune n'est décorative :
 *   1. le `state` est **signé** et récent — sinon un lien de retour forgé permettrait de brancher
 *      la boîte d'un attaquant sur le compte d'un collègue, qui enverrait alors des mails en son
 *      nom sans jamais s'en apercevoir ;
 *   2. le `state` désigne **la personne connectée** — un `state` valide volé à quelqu'un d'autre
 *      ne sert à rien ;
 *   3. le vérificateur PKCE vient du cookie de CE navigateur — un code intercepté est inutilisable
 *      ailleurs.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const env = process.env as Record<string, string | undefined>;
  const base = env.APP_URL || req.nextUrl.origin;
  const back = (q: string) => NextResponse.redirect(new URL(`/messagerie?${q}`, base));

  const error = req.nextUrl.searchParams.get("error");
  if (error) return back(`erreur=refus`); // l'utilisateur a refusé, ou Microsoft a refusé : même écran

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stateUser = verifyState(state);
  if (!code || !stateUser || stateUser !== user.id) return back("erreur=state");

  const verifier = (await cookies()).get(PKCE_COOKIE)?.value;
  if (!verifier) return back("erreur=state");
  (await cookies()).delete(PKCE_COOKIE);

  const cfg = resolveMicrosoftConfig(env);
  if (!cfg) return back("erreur=not-configured");

  let stage: Stage = "token";
  let graphStatus: number | null = null;
  try {
    const tokens = await exchangeCode(cfg, code, verifier);

    // Qui vient d'être connecté ? On le demande à Microsoft plutôt que de le déduire : c'est la
    // seule source fiable, et l'adresse affichée doit être celle de la boîte réellement servie.
    stage = "graph-me";
    const meRes = await fetch(`${GRAPH_BASE}/me`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    graphStatus = meRes.status;
    const me = (await meRes.json().catch(sansBloquer("callback-route.GET.json", {}))) as Record<string, unknown>;
    const address = String(me.mail ?? me.userPrincipalName ?? "").trim();
    if (!address) {
      // Ce chemin ne lève pas : sans ce journal, un refus de Graph (401/403) se présenterait comme
      // un simple « profil introuvable », alors que la cause est le jeton ou les permissions.
      logFailure("graph-me", user.id, new Error("Graph /me sans adresse exploitable"), graphStatus);
      return back("erreur=profil");
    }

    stage = "save";
    await saveConnection({
      userId: user.id,
      address,
      displayName: me.displayName ? String(me.displayName) : null,
      homeAccountId: me.id ? String(me.id) : null,
      tokens,
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Messagerie",
      summary: `Boîte Microsoft connectée (${address})`,
    });
    return back("connecte=1");
  } catch (err) {
    // Aucun détail dans l'URL : un message d'erreur de Microsoft peut contenir des éléments
    // de la requête, et une URL se partage par copier-coller. Le détail va au JOURNAL SERVEUR,
    // que seul l'exploitant lit.
    logFailure(stage, user.id, err, graphStatus);
    return back("erreur=echec");
  }
}
