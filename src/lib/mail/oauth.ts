import { authorizeUrl, tokenUrl, SCOPE_STRING, type MicrosoftMailConfig } from "./config";
import { sansBloquer } from "@/lib/journal";
export { signState, verifyState, makePkce } from "@/lib/oauth-state";

/**
 * L'AUTHENTIFICATION MICROSOFT — code d'autorisation avec PKCE, permissions DÉLÉGUÉES.
 *
 * Déléguées, et pas « application » : une permission d'application donnerait à AMD Internal OS
 * l'accès à **toutes** les boîtes de l'entreprise, d'un coup, sans que personne n'ait rien
 * accepté. Avec le mode délégué, chacun connecte SA boîte et peut la déconnecter — c'est ce qui
 * rend un pilote sur une seule boîte réellement possible.
 *
 * Le `state` est **signé et daté**. Sans lui, n'importe qui peut envoyer à un collègue un lien de
 * retour forgé et faire connecter SA boîte au compte du collègue : le collègue lirait alors les
 * mails de l'attaquant, et surtout enverrait en son nom. C'est le CSRF de connexion, et il est
 * silencieux.
 */

/** L'URL vers laquelle envoyer la personne pour qu'elle accepte (ou refuse). */
export function buildAuthorizeUrl(cfg: MicrosoftMailConfig, state: string, challenge: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: SCOPE_STRING,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // PAS DE `prompt`. `select_account` imposait le sélecteur À CHAQUE FOIS, et un sélecteur
    // affiché l'emporte sur `login_hint` : la personne devait re-choisir son compte alors que
    // l'adresse était déjà connue — c'est là qu'on prend la mauvaise vignette. Sans lui, la
    // session professionnelle en cours est reprise directement.
    //
    // Ce qui protégeait un poste partagé est repris, en mieux, par les deux indications
    // ci-dessous : `domain_hint` exclut les comptes personnels, `login_hint` désigne la boîte.

    // `domain_hint=organizations` : ne proposer QUE le compte professionnel ou scolaire.
    //
    // Une adresse d'entreprise existe souvent AUSSI comme compte Microsoft personnel — créé un
    // jour pour Skype, Windows ou Office grand public, bien avant le déploiement de Microsoft 365.
    // Le sélecteur affiche alors deux vignettes portant la même adresse, on prend la mauvaise, et
    // Microsoft répond `AADSTS50020` : « le compte du fournisseur d'identité live.com n'existe pas
    // dans ce locataire ». Le message est exact et parfaitement incompréhensible pour la personne,
    // qui EST membre du locataire — avec son autre compte.
    //
    // L'indication ferme cette porte : le routage vers live.com n'est plus proposé. Elle ne
    // remplace pas l'autorité, qui reste celle du locataire (`MICROSOFT_TENANT_ID`) : c'est elle,
    // et elle seule, qui décide de qui a le droit d'entrer.
    domain_hint: "organizations",
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${authorizeUrl(cfg.tenantId)}?${p.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
}

/** Réponse de Microsoft, traduite — et jamais journalisée : elle contient les jetons. */
function toTokenSet(json: Record<string, unknown>): TokenSet {
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: String(json.access_token ?? ""),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    // On retire 60 s : un jeton qui expire pendant le vol d'une requête produit une erreur
    // incompréhensible côté utilisateur.
    expiresAt: new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000),
    scopes: String(json.scope ?? ""),
  };
}

/**
 * LE REFUS DE MICROSOFT, PORTÉ PAR L'ERREUR — pas seulement raconté dans son message.
 *
 * Le message reste identique à ce qu'il était (il est parfois affiché à l'utilisateur) ; on ajoute
 * à côté le **code** du fournisseur et le **statut HTTP**, pour qu'un journal serveur puisse dire
 * `invalid_client` plutôt que « ça a échoué ». Aucun jeton, aucun secret, aucun code OAuth n'entre
 * jamais ici : `error_description` de Microsoft est délibérément ignorée, elle peut recopier des
 * éléments de la requête.
 */
export class MicrosoftAuthError extends Error {
  readonly providerCode: string;
  readonly httpStatus: number;
  /** Les codes AADSTS, quand Microsoft les met dans `error_codes` (numériques, sans contenu). */
  readonly aadCodes: number[];

  constructor(providerCode: string, httpStatus: number, aadCodes: number[]) {
    super(`Microsoft a refusé l'authentification (${providerCode}).`);
    this.name = "MicrosoftAuthError";
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
    this.aadCodes = aadCodes;
  }
}

async function postToken(cfg: MicrosoftMailConfig, body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(tokenUrl(cfg.tenantId), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(sansBloquer("oauth.postToken.json", {}))) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    // On rend le CODE d'erreur de Microsoft (`invalid_grant`, `consent_required`…), jamais la
    // description brute, qui peut contenir des éléments de la requête.
    const code = String(json.error ?? res.status);
    const aad = Array.isArray(json.error_codes)
      ? json.error_codes.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    throw new MicrosoftAuthError(code, res.status, aad);
  }
  return toTokenSet(json);
}

export function exchangeCode(cfg: MicrosoftMailConfig, code: string, verifier: string): Promise<TokenSet> {
  return postToken(cfg, new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    scope: SCOPE_STRING,
  }));
}

export function refreshTokens(cfg: MicrosoftMailConfig, refreshToken: string): Promise<TokenSet> {
  return postToken(cfg, new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPE_STRING,
  }));
}
