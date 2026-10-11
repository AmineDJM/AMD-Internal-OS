/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DIAGNOSTIC DE L'ÉDITEUR OFFICE — la part PURE : aucune importation.
 *
 * En production, l'éditeur affichait « son serveur (OnlyOffice) est injoignable » sans dire
 * POURQUOI. Les causes réelles sont peu nombreuses et se reconnaissent : une variable absente, une
 * adresse en `http://` que la CSP `upgrade-insecure-requests` force en `https://`, une adresse
 * interne (10.x, 192.168.x, nom Docker) que le navigateur ne voit pas, un DNS faux, un certificat
 * refusé, un serveur endormi (502/503). Ce module transforme chaque constat en une phrase française
 * qui dit quoi corriger.
 *
 * Il est importé par l'action serveur (qui fait les appels réseau) ET par le panneau
 * d'administration (qui fait l'essai dans le navigateur) : il ne doit rien importer
 * (`client-bundle-guard.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatPoint = "ok" | "attention" | "echec" | "info";

export interface PointDiagnostic {
  cle: string;
  libelle: string;
  etat: EtatPoint;
  detail: string;
  /** Ce qu'il faut faire — absent quand tout va bien. */
  correctif?: string;
}

export interface RapportEditeurOffice {
  /** Vrai quand aucun point n'est en échec. */
  ok: boolean;
  points: PointDiagnostic[];
  /** L'adresse de `api.js`, pour l'essai dans le navigateur (null : rien à essayer). */
  apiJs: string | null;
  /** `api.js` atteint depuis notre serveur — sert à interpréter l'essai du navigateur. */
  serveurJoint: boolean;
  error?: string;
}

export const CHEMIN_API_JS = "/web-apps/apps/api/documents/api.js";

/** Les variables lues par `src/lib/onlyoffice.ts` (`appBaseUrl` : APP_URL, puis NEXTAUTH_URL, puis AUTH_URL). */
export const VARIABLES_URL_APP = ["APP_URL", "NEXTAUTH_URL", "AUTH_URL"] as const;

// ───────────────────────── Adresses ─────────────────────────

function ipv4(hote: string): number[] | null {
  const m = hote.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/**
 * Un hôte que l'INTERNET ne voit pas : localhost, adresses privées, nom sans domaine (un nom de
 * service Docker comme « onlyoffice »), `.local` / `.internal`. Le navigateur d'un utilisateur ne
 * l'atteindra pas — sauf à être sur le même réseau, ce qui n'est pas le cas des postes nomades.
 */
export function hotePrive(hoteBrut: string): boolean {
  const hote = hoteBrut.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hote) return true;
  if (hote === "localhost" || hote.endsWith(".localhost")) return true;
  if (hote.endsWith(".local") || hote.endsWith(".internal") || hote.endsWith(".lan")) return true;
  const v4 = ipv4(hote);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (hote.includes(":")) {
    // IPv6 : boucle locale, lien local, adresses uniques locales (fc00::/7).
    return hote === "::1" || hote === "::" || /^fe[89ab][0-9a-f]:/.test(hote) || /^f[cd][0-9a-f]{2}:/.test(hote);
  }
  // Un nom SANS point ne se résout pas sur Internet : c'est un nom de réseau interne.
  return !hote.includes(".");
}

type Role = "editeur" | "application";

const NOM_VAR: Record<Role, string> = { editeur: "ONLYOFFICE_URL", application: "APP_URL" };

/**
 * LA FORME D'UNE ADRESSE — avant tout appel réseau. Un seul point, à l'état le plus grave trouvé,
 * dont le détail nomme chaque défaut.
 */
export function formeUrl(brut: string, role: Role): PointDiagnostic {
  const cle = role === "editeur" ? "forme-editeur" : "forme-application";
  const libelle = role === "editeur" ? "Adresse du serveur d'édition" : "Adresse publique de l'application";
  const v = brut.trim();
  if (!v) return { cle, libelle, etat: "echec", detail: "Non renseignée.", correctif: `Définir ${NOM_VAR[role]}.` };

  let u: URL;
  try { u = new URL(v); } catch {
    return {
      cle, libelle, etat: "echec", detail: `« ${v} » n'est pas une adresse complète.`,
      correctif: role === "editeur" ? "Écrire l'adresse entière, ex. https://office.votre-domaine.dz" : "Écrire l'adresse entière, ex. https://erp.votre-domaine.dz",
    };
  }

  const echecs: string[] = [];
  const attentions: string[] = [];
  const correctifs: string[] = [];

  if (u.protocol === "http:") {
    if (role === "editeur") {
      echecs.push("http:// — le navigateur la force en https:// (règle de sécurité de l'application) : si rien n'écoute en HTTPS, l'éditeur ne se charge jamais.");
      correctifs.push("Servir le Document Server en HTTPS (reverse-proxy + certificat reconnu) et écrire https://… dans ONLYOFFICE_URL.");
    } else {
      attentions.push("http:// — le rappel d'enregistrement est un POST : une redirection vers https:// le fait échouer.");
      correctifs.push("Écrire l'adresse https:// définitive dans APP_URL.");
    }
  } else if (u.protocol !== "https:") {
    echecs.push(`Protocole « ${u.protocol} » : seul https:// convient.`);
    correctifs.push("Écrire une adresse https://.");
  }

  if (hotePrive(u.hostname)) {
    echecs.push(role === "editeur"
      ? `« ${u.hostname} » est une adresse interne : non joignable depuis Internet, donc pas depuis le navigateur des utilisateurs.`
      : `« ${u.hostname} » est une adresse interne : non joignable depuis Internet, donc pas par le Document Server.`);
    correctifs.push("Mettre l'adresse publique (nom de domaine) dans la variable.");
  }

  if (role === "editeur" && /\/web-apps\/|\/healthcheck|api\.js$/i.test(u.pathname)) {
    echecs.push("L'adresse contient un chemin interne du Document Server (…/web-apps/…, /healthcheck, api.js).");
    correctifs.push("Ne garder que la racine, ex. https://office.votre-domaine.dz");
  }

  // Barre finale : retirée par le code, sans effet — signalée pour que l'adresse soit propre partout.
  if (v.endsWith("/")) attentions.push("Barre « / » finale : sans effet (retirée automatiquement), mais à ôter.");

  if (u.username || u.password) {
    echecs.push("L'adresse contient un identifiant ou un mot de passe.");
    correctifs.push("Retirer « utilisateur:motdepasse@ » de l'adresse.");
  }

  const etat: EtatPoint = echecs.length ? "echec" : attentions.length ? "attention" : "ok";
  const origine = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  return {
    cle, libelle, etat,
    detail: etat === "ok" ? `Forme correcte : ${origine}` : [...echecs, ...attentions].join(" "),
    ...(correctifs.length ? { correctif: correctifs.join(" ") } : {}),
  };
}

// ───────────────────────── Variables ─────────────────────────

/** Les trois variables — JAMAIS la valeur du secret, seulement sa présence et sa longueur. */
export function diagnosticVariables(env: Record<string, string | undefined>): PointDiagnostic[] {
  const out: PointDiagnostic[] = [];
  const url = (env.ONLYOFFICE_URL ?? "").trim();
  out.push(url
    ? { cle: "var-url", libelle: "ONLYOFFICE_URL", etat: "ok", detail: `Définie : ${url}` }
    : { cle: "var-url", libelle: "ONLYOFFICE_URL", etat: "echec", detail: "Absente.", correctif: "Render → Environment : ONLYOFFICE_URL = https://office.votre-domaine.dz" });

  const secret = env.ONLYOFFICE_JWT_SECRET ?? "";
  if (!secret) {
    out.push({ cle: "var-secret", libelle: "ONLYOFFICE_JWT_SECRET", etat: "echec", detail: "Absent.", correctif: "Render → Environment : ONLYOFFICE_JWT_SECRET = le JWT_SECRET du conteneur OnlyOffice." });
  } else if (secret !== secret.trim()) {
    out.push({ cle: "var-secret", libelle: "ONLYOFFICE_JWT_SECRET", etat: "attention", detail: `Défini, ${secret.length} caractères — avec des espaces au début ou à la fin.`, correctif: "Retirer les espaces : sinon « le jeton n'est pas valide » dans l'éditeur." });
  } else {
    out.push({ cle: "var-secret", libelle: "ONLYOFFICE_JWT_SECRET", etat: "ok", detail: `Défini, ${secret.length} caractères.` });
  }

  const source = VARIABLES_URL_APP.find((k) => (env[k] ?? "").trim());
  if (!source) {
    out.push({ cle: "var-app", libelle: "APP_URL", etat: "echec", detail: "Absente (ni NEXTAUTH_URL, ni AUTH_URL).", correctif: "Render → Environment : APP_URL = l'adresse publique de l'application." });
  } else {
    const val = (env[source] ?? "").trim();
    out.push(source === "APP_URL"
      ? { cle: "var-app", libelle: "APP_URL", etat: "ok", detail: `Définie : ${val}` }
      : { cle: "var-app", libelle: "APP_URL", etat: "ok", detail: `Absente — ${source} sert à sa place : ${val}` });
  }
  return out;
}

/** L'adresse publique de l'application telle que `appBaseUrl()` la lit. */
export function urlApplication(env: Record<string, string | undefined>): string {
  const source = VARIABLES_URL_APP.find((k) => (env[k] ?? "").trim());
  return source ? (env[source] ?? "").trim() : "";
}

// ───────────────────────── Réseau ─────────────────────────

export interface ErreurReseau { name?: string; code?: string; message?: string }

/** Rend lisible l'erreur d'un `fetch` Node (undici) : le code utile est souvent dans `cause`. */
export function lireErreur(e: unknown): ErreurReseau {
  const o = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const c = (o.cause ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const s = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return {
    name: s(o.name),
    code: s(c.code) ?? s(o.code),
    message: s(c.message) ?? s(o.message),
  };
}

const CERTIFICAT: Record<string, string> = {
  CERT_HAS_EXPIRED: "Certificat HTTPS expiré.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "Certificat auto-signé : les navigateurs le refusent aussi.",
  SELF_SIGNED_CERT_IN_CHAIN: "Certificat auto-signé dans la chaîne : les navigateurs le refusent aussi.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Chaîne de certificat incomplète (certificat intermédiaire manquant).",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "Chaîne de certificat incomplète (certificat intermédiaire manquant).",
  UNABLE_TO_GET_ISSUER_CERT: "Chaîne de certificat incomplète (certificat intermédiaire manquant).",
  ERR_TLS_CERT_ALTNAME_INVALID: "Le certificat ne couvre pas ce nom de domaine.",
  CERT_NOT_YET_VALID: "Certificat pas encore valide (horloge du serveur ?).",
};

/** L'erreur réseau d'un appel → une phrase et un correctif, en français. */
export function messageErreurReseau(err: ErreurReseau, hote: string, delaiS = 8): { detail: string; correctif: string } {
  const code = (err.code ?? "").toUpperCase();
  const nom = err.name ?? "";
  if (nom === "TimeoutError" || nom === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { detail: `Pas de réponse en ${delaiS} s : serveur arrêté, endormi, ou pare-feu qui ignore la connexion.`, correctif: "Vérifier que le Document Server tourne et que le port 443 est ouvert ; relancer le test." };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { detail: `Nom de domaine introuvable (DNS) : « ${hote} » ne pointe vers aucune machine.`, correctif: "Corriger l'adresse, ou créer l'enregistrement DNS (A / CNAME) vers le Document Server." };
  }
  if (code === "ECONNREFUSED") {
    return { detail: "Connexion refusée : la machine répond, mais rien n'écoute sur ce port.", correctif: "Démarrer le conteneur OnlyOffice, ou corriger le port de l'adresse." };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return { detail: "Machine injoignable sur le réseau.", correctif: "Vérifier que la machine est allumée et exposée sur Internet." };
  }
  if (CERTIFICAT[code]) {
    return { detail: CERTIFICAT[code], correctif: "Installer un certificat reconnu (Let's Encrypt) avec sa chaîne complète, pour ce nom de domaine." };
  }
  if (code === "EPROTO" || code.startsWith("ERR_SSL") || /wrong version number/i.test(err.message ?? "")) {
    return { detail: "Ce port répond en HTTP, pas en HTTPS.", correctif: "Placer le Document Server derrière un reverse-proxy HTTPS, ou corriger le port." };
  }
  if (/CERT|TLS|SSL/.test(code)) {
    return { detail: `Erreur de certificat HTTPS (${code}).`, correctif: "Installer un certificat reconnu, chaîne complète, pour ce nom de domaine." };
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return { detail: "Connexion coupée par le serveur (proxy ou HTTPS mal configuré).", correctif: "Consulter les journaux du reverse-proxy devant le Document Server." };
  }
  const brut = code || err.message || "inconnue";
  return { detail: `Échec réseau (${brut}).`, correctif: "Vérifier l'adresse et que le Document Server tourne." };
}

const ENDORMI = "serveur endormi ou en cours de démarrage (le proxy répond, le Document Server pas encore).";
const ENDORMI_CORRECTIF = "Patienter une à deux minutes puis relancer ; s'il s'endort (offre gratuite), choisir une offre toujours active.";

/** `GET {ONLYOFFICE_URL}/healthcheck` : un Document Server en forme répond exactement `true`. */
export function verdictHealthcheck(status: number, corps: string): PointDiagnostic {
  const base = { cle: "healthcheck", libelle: "Serveur d'édition (depuis notre serveur)" };
  const c = corps.trim().toLowerCase();
  if (status === 200 && c === "true") return { ...base, etat: "ok", detail: "/healthcheck répond « true »." };
  if (status === 200 && c === "false") {
    return { ...base, etat: "echec", detail: "/healthcheck répond « false » : le Document Server tourne, mais un de ses services internes est en panne.", correctif: "Redémarrer le conteneur OnlyOffice et lire ses journaux." };
  }
  if (status === 200) {
    return { ...base, etat: "echec", detail: "Répond, mais pas comme un Document Server (page HTML ?) : l'adresse mène à un autre site.", correctif: "Vérifier ONLYOFFICE_URL : la racine du Document Server, rien d'autre." };
  }
  if (status === 502 || status === 503 || status === 504) return { ...base, etat: "echec", detail: `Code ${status} : ${ENDORMI}`, correctif: ENDORMI_CORRECTIF };
  if (status === 404) return { ...base, etat: "echec", detail: "Code 404 : aucun Document Server à cette adresse.", correctif: "ONLYOFFICE_URL doit être la racine du Document Server." };
  if (status === 401 || status === 403) return { ...base, etat: "echec", detail: `Code ${status} : un proxy filtre l'accès (mot de passe, liste d'adresses IP).`, correctif: "Ouvrir l'accès public au Document Server : il est protégé par son secret JWT." };
  return { ...base, etat: "echec", detail: `Code ${status} inattendu.`, correctif: "Lire les journaux du Document Server et de son proxy." };
}

/** `GET {ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js` : le script que l'éditeur charge. */
export function verdictApiJs(status: number, typeContenu: string): PointDiagnostic {
  const base = { cle: "api-js", libelle: "Script de l'éditeur api.js (depuis notre serveur)" };
  const t = typeContenu.toLowerCase();
  if (status === 200 && /javascript|ecmascript/.test(t)) return { ...base, etat: "ok", detail: "Code 200, script JavaScript." };
  if (status === 200) {
    return { ...base, etat: "echec", detail: `Code 200, mais « ${typeContenu || "type inconnu"} » au lieu d'un script : page d'erreur ou de connexion d'un proxy.`, correctif: "Vérifier que l'adresse mène bien au Document Server, sans page intermédiaire." };
  }
  if (status === 502 || status === 503 || status === 504) return { ...base, etat: "echec", detail: `Code ${status} : ${ENDORMI}`, correctif: ENDORMI_CORRECTIF };
  if (status === 404) return { ...base, etat: "echec", detail: `Code 404 : ${CHEMIN_API_JS} introuvable.`, correctif: "ONLYOFFICE_URL doit être la racine du Document Server (sans sous-chemin superflu)." };
  return { ...base, etat: "echec", detail: `Code ${status}.`, correctif: "Lire les journaux du Document Server et de son proxy." };
}

/**
 * `GET {APP_URL}/api/onlyoffice/file` SANS jeton, redirections NON suivies. Attendu : 401 — la
 * route est là, publique, et refuse faute de jeton. C'est vu depuis NOTRE serveur : une
 * approximation de ce que voit le Document Server, pas une preuve.
 */
export function verdictRouteApplication(status: number, location: string | null): PointDiagnostic {
  const base = { cle: "route-application", libelle: "Retour vers l'application (/api/onlyoffice/file)" };
  if (status === 401) return { ...base, etat: "ok", detail: "Répond 401 sans jeton, comme attendu : la route est en ligne." };
  if (status >= 300 && status < 400) {
    if (/\/login\b/.test(location ?? "")) {
      return { ...base, etat: "echec", detail: "Redirige vers la page de connexion : le Document Server ne pourra ni lire ni enregistrer le fichier.", correctif: "Exempter /api/onlyoffice/file et /api/onlyoffice/callback de la connexion (src/auth.config.ts)." };
    }
    return { ...base, etat: "attention", detail: `Redirige vers ${location ?? "une autre adresse"} : APP_URL n'est pas l'adresse finale.`, correctif: "Mettre dans APP_URL l'adresse exacte vers laquelle on est redirigé (https, avec ou sans www)." };
  }
  if (status === 404) return { ...base, etat: "echec", detail: "Code 404 : l'application qui répond à cette adresse n'a pas l'éditeur configuré.", correctif: "APP_URL doit désigner CE déploiement." };
  if (status === 502 || status === 503 || status === 504) return { ...base, etat: "attention", detail: `Code ${status} : l'application ne répond pas à sa propre adresse publique pour le moment.`, correctif: "Relancer le test dans une minute." };
  return { ...base, etat: "attention", detail: `Code ${status} inattendu.` };
}

/** Ce qu'aucun test ne prouve sans ouvrir un document : le Document Server qui rappelle l'application. */
export function pointRetourDocumentServer(appUrl: string): PointDiagnostic {
  const base = appUrl.replace(/\/+$/, "") || "APP_URL";
  return {
    cle: "retour-document-server", libelle: "Lecture et enregistrement par le Document Server", etat: "info",
    detail: `Il doit joindre ${base}/api/onlyoffice/file et /api/onlyoffice/callback, avec le même secret JWT. Non vérifiable sans ouvrir un document.`,
    correctif: "Ouvrir un document : « erreur de téléchargement » = il n'atteint pas l'application ; « jeton non valide » = secrets différents.",
  };
}

// ───────────────────────── Navigateur ─────────────────────────

export type IssueNavigateur = "ok" | "erreur" | "delai" | "sans-api";

/** L'essai de chargement d'`api.js` DANS le navigateur de l'administrateur. */
export function verdictNavigateur(issue: IssueNavigateur, ctx: { url: string; pageHttps: boolean; serveurJoint: boolean }): PointDiagnostic {
  const base = { cle: "navigateur", libelle: "Ce navigateur charge l'éditeur" };
  if (issue === "ok") return { ...base, etat: "ok", detail: "api.js chargé, l'éditeur est disponible ici." };
  if (issue === "sans-api") {
    return { ...base, etat: "echec", detail: "Le fichier se charge mais ne contient pas l'éditeur (page de proxy, mauvaise adresse).", correctif: "Vérifier ONLYOFFICE_URL : la racine du Document Server." };
  }
  if (/^http:/i.test(ctx.url) && ctx.pageHttps) {
    return { ...base, etat: "echec", detail: "Adresse en http:// : le navigateur la force en https:// et rien n'y répond.", correctif: "Servir le Document Server en HTTPS et écrire https://… dans ONLYOFFICE_URL." };
  }
  if (ctx.serveurJoint) {
    return {
      ...base, etat: "echec",
      detail: issue === "delai"
        ? "Notre serveur l'atteint, mais ce navigateur n'a rien reçu en 15 s."
        : "Notre serveur l'atteint, pas ce navigateur : réseau interne ou VPN, pare-feu, certificat refusé par le navigateur, ou extension qui bloque.",
      correctif: "ONLYOFFICE_URL doit être une adresse publique avec un certificat reconnu ; essayer sans extension de blocage.",
    };
  }
  return { ...base, etat: "echec", detail: issue === "delai" ? "Aucune réponse en 15 s depuis ce navigateur non plus." : "Injoignable depuis ce navigateur aussi.", correctif: "Corriger d'abord les points côté serveur ci-dessus." };
}

/** Le rapport est bon quand aucun point n'est en échec (« attention » et « info » n'arrêtent rien). */
export function rapportOk(points: readonly PointDiagnostic[]): boolean {
  return !points.some((p) => p.etat === "echec");
}
