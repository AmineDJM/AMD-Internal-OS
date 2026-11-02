import { PrismaClient } from "@prisma/client";
import { estUnBancDeMesure } from "@/lib/sortie/garde";
import { etatDuGeste } from "@/lib/effets/magasin";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BANC N'OUVRE PAS LA BASE DE TRAVAIL — refus à la CONSTRUCTION, avant la première requête.
 *
 * ── LE DÉFAUT MESURÉ ─────────────────────────────────────────────────────────────────────
 *
 * La garde de sortie (`sortie/garde.ts`) empêche un banc d'ENVOYER quoi que ce soit au monde.
 * Rien n'empêchait un banc d'ÉCRIRE dans la base de travail. Deux conséquences, mesurées
 * toutes les deux sur ce conteneur :
 *
 *   · `DATABASE_URL` y pointe, par défaut, sur la base de PRODUCTION de Render. Un
 *     `npx tsx scripts/bench/…` distrait — ou un `npm run office:bench` — semait, écrivait et
 *     supprimait chez Adventum. Aucune garde ne le voyait.
 *   · Pointée sur la base de développement, la campagne live échouait sur
 *     `PaymentRequest.reference PAY-2026-044` : cette base porte 592 demandes de paiement et
 *     211 comptes marqués « test » — le résidu de la suite unitaire, qui a le droit d'y vivre.
 *     Le banc accusait son propre semis d'être non idempotent ; la cause était le VOISINAGE.
 *
 * ── LE FAIT SUR LEQUEL LA GARDE S'ARME ───────────────────────────────────────────────────
 *
 * Le même que la garde de sortie, et pour la même raison (§118.17) : le script d'entrée vit-il
 * sous `scripts/bench/` ? C'est un fait du LANCEMENT. Une variable qu'un banc futur devrait
 * penser à poser serait oubliée, et l'oubli est exactement ce contre quoi on se protège.
 *
 * La base d'un banc doit alors satisfaire DEUX choses, toutes deux lues dans l'URL :
 * l'hôte est LOCAL, et le nom de la base CONTIENT « bench ». Deux bases, deux voisinages :
 * la suite unitaire garde le sien, la campagne live le sien.
 *
 * ── POURQUOI REFUSER, ET NON REDIRIGER ───────────────────────────────────────────────────
 *
 * Rediriger en silence serait pire que le défaut : un banc qui croit avoir écrit dans la base
 * qu'on lui a nommée, et dont les vérifications lisent ailleurs, rend un vert qui ne prouve
 * rien. Le refus, lui, NOMME le remède (§118.30) — le script `npm run` qui porte la bonne base.
 *
 * ── LE SECOND ÉTAGE, ET C'EST LUI QUI A ARRÊTÉ UNE CATASTROPHE ───────────────────────────
 *
 * La première version de cette garde EXEMPTAIT la suite unitaire, avec une raison qui sonnait
 * juste : « la suite a le droit d'écrire dans la base de TRAVAIL, c'est son voisinage ».
 * Mesuré cinq minutes plus tard, dans ce conteneur : `DATABASE_URL` par défaut porte l'hôte
 * `…oregon-postgres.render.com` et la base `amd_internal_os` — la PRODUCTION d'Adventum. Rien
 * dans `vitest.config.ts` ne la remplace, et la suite SÈME (592 demandes de paiement, 211
 * comptes marqués « test » dans la base de développement en témoignent). Autrement dit :
 * `npm test`, la porte que ce dépôt franchit avant chaque commit, écrivait chez le client.
 *
 * L'exemption était juste dans son INTENTION et fausse dans son ÉTENDUE. La règle a donc deux
 * étages, tous deux lus dans la même URL :
 *
 *   · un BANC exige une base LOCALE dont le nom contient « bench » (son propre voisinage) ;
 *   · un TEST exige une base LOCALE, quel qu'en soit le nom (le voisinage de la suite) ;
 *   · la PRODUCTION n'est pas concernée : ni banc, ni test, aucune contrainte.
 *
 * Et il n'y a PAS de dérogation. Un intégrateur qui voudrait faire tourner la suite contre une
 * base distante recevra un refus qui nomme le remède — bruyant, corrigé en une minute. Le coût
 * de l'erreur inverse est une corruption silencieuse des données d'un client : les deux ne se
 * comparent pas. Ouvrir une porte ici serait une décision de revue de code (§118.39).
 *
 * ── CE QUE LA GARDE NE FAIT PAS ──────────────────────────────────────────────────────────
 *
 * `office-sabotage.ts` lance `vitest` en enfant, et cet enfant hérite de
 * `npm_lifecycle_script`, donc du fait « je suis un banc ». Il est jugé comme un TEST, pas
 * comme un banc — sans quoi la suite unitaire tomberait sur le nom de la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'hôte est-il cette machine ? Lu dans l'URL, sans résolution DNS : un nom qui ressemble à
 *  « localhost » sans en être un ne doit pas passer. */
export function estUneBaseLocale(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Le nom d'une base de banc : lu dans l'URL, pas déclaré à côté (§118.5). */
export function estUneBaseDeBanc(url: string): boolean {
  if (!estUneBaseLocale(url)) return false;
  try {
    return /bench/i.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}

/**
 * LA BASE D'ESSAI DU BANC PROGRAMMÉ (J5, décision 0022) — la seule base DISTANTE qu'un banc puisse ouvrir : celle que
 * le worker lui a DÉCLARÉE (`BANC_ESSAI_DATABASE_URL`, identique à `DATABASE_URL`), dont l'empreinte (hôte, port, nom)
 * diffère de celle de la production qu'il lui a transmise (`BANC_EMPREINTE_PRODUCTION`). Le marqueur en base
 * (`BancBaseEssai`) est vérifié ensuite par le banc lui-même. Même empreinte que `domaine/qualite/base-essai.ts`.
 */
export function estLaBaseEssaiDeclaree(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const prod = env.BANC_EMPREINTE_PRODUCTION?.trim();
  if (!prod || !url || url !== env.BANC_ESSAI_DATABASE_URL?.trim()) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const e = `${["localhost", "127.0.0.1", "::1"].includes(h) ? "local" : h}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1)).toLowerCase()}`;
    return e !== prod;
  } catch {
    return false;
  }
}

/** La base d'un banc : locale « bench », ou la base d'essai déclarée par le worker. */
export function estUneBaseDeBancOuDEssai(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return estUneBaseDeBanc(url) || estLaBaseEssaiDeclaree(url, env);
}

/**
 * Rend le REFUS (une phrase) ou `null`. Pur : `prisma.ts` l'appelle à la construction, et un
 * test l'exerce sans ouvrir de connexion — vérifier un corps sans son appelant ne prouverait
 * rien (§118.49), d'où l'appel juste en dessous.
 */
export function refusDeBase(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string | null {
  const test = env.NODE_ENV === "test" || Boolean(env.VITEST);
  const banc = !test && estUnBancDeMesure(env, argv);
  if (!test && !banc) return null;

  const url = env.DATABASE_URL ?? "";
  if (banc ? estUneBaseDeBanc(url) || estLaBaseEssaiDeclaree(url, env) : estUneBaseLocale(url)) return null;

  let ou = "(DATABASE_URL absente)";
  try { const u = new URL(url); ou = `${u.hostname}${u.pathname}`; } catch { if (url) ou = "(URL illisible)"; }
  const qui = banc
    ? `un banc de mesure (${(argv[1] ?? env.npm_lifecycle_script ?? "?").split("/").slice(-1)[0]})`
    : "la suite de tests";
  const exige = banc
    ? "hôte local ET nom de base contenant « bench »"
    : "un hôte local (localhost, 127.0.0.1) — jamais une base distante";
  const remede = banc
    ? `lancer le banc par son script npm (ils portent tous DATABASE_URL="${'$'}{BENCH_DATABASE_URL:-postgresql://amd:amd@localhost:5432/amd_bench}"), ou poser cette variable pour un appel direct`
    : `passer par \`npm test\`, qui porte DATABASE_URL="${'$'}{TEST_DATABASE_URL:-postgresql://amd:amd@localhost:5432/amd_internal_os}" — ou poser TEST_DATABASE_URL si la base locale porte un autre nom`;
  return (
    `REFUS — ce processus est ${qui} et sa base est « ${ou} ». Exigé : ${exige}. Remède : ${remede}. `
    + `La suite SÈME des lignes ; contre une base distante, elle les sème chez le client.`
  );
}

const refus = refusDeBase();
if (refus) throw new Error(refus);

/**
 * POOL DE CONNEXIONS — **12 par défaut**, sans rien à configurer côté hébergeur.
 *
 * Prisma dimensionne le pool à `CPUs × 2 + 1`, soit **3 connexions sur 1 vCPU**. C'est le vrai
 * goulot d'étranglement de cette application : dès qu'une analyse CTD tourne (le passage de jobs
 * prend plusieurs dossiers de front) ou qu'un gros dossier monte (chaque partie = une écriture),
 * les 3 connexions sont prises et **toute autre requête attend** — y compris l'ouverture d'une
 * session de téléversement, qui rendait alors « serveur injoignable ou trop lent (30 s) ».
 * Élargir le pool ne coûte rien : Postgres accepte par défaut une centaine de connexions, et
 * l'instance n'en tenait que 3.
 *
 * Le défaut ne s'applique qu'EN PRODUCTION, où l'application tourne dans un seul processus. Un
 * pool se compte par processus : en test, les fichiers s'exécutent dans une dizaine de workers
 * parallèles, et douze connexions chacun dépasseraient le `max_connections` de Postgres.
 *
 * `DB_CONNECTION_LIMIT` reste prioritaire et s'applique partout (à relever seulement en connaissant
 * le `max_connections` de la base, et en tenant compte du NOMBRE D'INSTANCES : chacune ouvre son
 * propre pool). `DB_POOL_TIMEOUT` (s) : délai d'attente d'une connexion libre avant erreur.
 * Une URL qui porte déjà `connection_limit` n'est jamais modifiée.
 */
const DEFAULT_CONNECTION_LIMIT = "12";

function pooledDatasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  const limit = process.env.DB_CONNECTION_LIMIT || (process.env.NODE_ENV === "production" ? DEFAULT_CONNECTION_LIMIT : "");
  if (!limit) return undefined;
  try {
    const u = new URL(base);
    if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
    const poolTimeout = process.env.DB_POOL_TIMEOUT;
    if (poolTimeout && !u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", poolTimeout);
    return u.toString();
  } catch {
    return undefined; // URL non standard → on laisse Prisma gérer l'original
  }
}

// Reuse a single PrismaClient across hot reloads in development to avoid
// exhausting database connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const datasourceUrl = pooledDatasourceUrl();

/** Le client de BASE — sans extension. La capture y lit ses lignes « avant » d'un geste réel (`effets/capture.ts`). */
export const prismaBrut: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(datasourceUrl ? { datasourceUrl } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prismaBrut;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIENT DU GESTE (J7, décision 0029) — `prisma` est le client de base, SAUF pendant un geste d'agent.
 *
 * Toute l'application écrit par `prisma` (`import { prisma } from "@/lib/prisma"`). Pour SIMULER une action de
 * l'écran — celle-là même que le bouton appelle — dans une transaction annulée, et pour JOURNALISER la valeur avant
 * de chaque écriture d'un geste réel, il fallait que ses requêtes passent par un autre client sans qu'une ligne de
 * l'action change. D'où ce relais : il lit le magasin du geste (`effets/magasin.ts`) et y prend le client posé par
 * `effets/simulation.ts` (la transaction) ou `effets/journal.ts` (le client qui capture). Hors geste, il rend le
 * client de base, tel quel.
 *
 * Dans une transaction interactive, `$transaction` n'existe pas : le relais la rend « en place » — une fonction
 * reçoit la transaction du geste, un tableau de requêtes s'exécute dans l'ordre. L'action ne voit pas la différence,
 * et rien n'échappe à l'annulation finale.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function clientDuGeste(): Record<string | symbol, unknown> | null {
  const c = etatDuGeste()?.client;
  return c && typeof c === "object" ? (c as Record<string | symbol, unknown>) : null;
}

async function transactionEnPlace(tx: Record<string | symbol, unknown>, arg: unknown): Promise<unknown> {
  if (typeof arg === "function") return (arg as (t: unknown) => unknown)(tx);
  const out: unknown[] = [];
  for (const requete of (arg as unknown[]) ?? []) out.push(await requete);
  return out;
}

export const prisma: PrismaClient = new Proxy(prismaBrut, {
  get(cible, prop) {
    const geste = clientDuGeste();
    const source = (geste && prop in geste ? geste : cible) as Record<string | symbol, unknown>;
    if (geste && prop === "$transaction" && typeof geste.$transaction !== "function") {
      return (arg: unknown) => transactionEnPlace(geste, arg);
    }
    const v = source[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(source) : v;
  },
});
