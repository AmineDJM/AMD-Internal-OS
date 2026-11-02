import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BANCS QUI SE PARTAGENT UNE BASE — tests seulement (F1, 02/11/2026).
 *
 * La suite fait tourner ~1 500 fichiers dans plusieurs processus, contre UNE base Postgres locale. Deux outils pour que
 * l'un ne tienne jamais l'autre en otage :
 *
 *   • `exclusifEntreBancs` — un geste GLOBAL par conception (« Masquer les ordres réglés de l'historique » masque TOUS
 *     les ordres réglés) se joue un banc à la fois ;
 *   • `poserBarriere` + `attendreBloques` — la BARRIÈRE qui force deux gestes à se croiser (§118.164e) : un verrou de
 *     TABLE (`SHARE` : les lectures passent, les écritures attendent), relâché quand les gestes DU BANC y sont arrivés.
 *
 * ── CE QUE LA BARRIÈRE FAISAIT AUX AUTRES ────────────────────────────────────────────────────
 *
 * Un verrou de table arrête les écritures de TOUS les processus, pas seulement celles du banc. Trente barrières de la
 * suite tenaient ainsi `LegalDocument`, `AdProItem`, `ValidationStep`, `AdministrativeRequest`… et comptaient « les
 * sessions qui attendent un verrou dont la requête nomme la table » — n'importe lesquelles :
 *
 *   1. une écriture d'un AUTRE banc bloquée là comptait pour un geste du banc : la barrière s'ouvrait avant que ses
 *      gestes y soient (§118.65), et le croisement qu'elle prétend forcer n'avait pas lieu ;
 *   2. tant que les gestes du banc n'arrivaient pas (un processus chargé), la table restait tenue jusqu'à dix secondes
 *      — et chaque banc qui y écrivait attendait d'autant (MESURÉ pendant la suite : une mise à jour de `LegalDocument`
 *      d'un banc voisin bloquée 4 s par une barrière « idle in transaction ») ;
 *   3. deux barrières sur deux tables, dont les gestes écrivent chacun dans la table de l'autre, s'attendaient l'une
 *      l'autre sans que Postgres puisse le voir (les barrières sondent, elles n'attendent pas un verrou) : dix secondes
 *      de table tenue des deux côtés, puis deux échecs.
 *
 * Additionnés, ces arrêts faisaient dépasser 20 s à des tests de 0,4 s qui n'avaient rien de faux — « LE DÉPÔT D'UN
 * DEVIS… » (`devis-bc-flow`, il écrit un `LegalDocument`), « REMETTRE une caisse… », « DÉCIDER (Finances…) » —, puis
 * toute leur suite tombait en cascade.
 *
 * ── LE REMÈDE ────────────────────────────────────────────────────────────────────────────────
 *
 *   • on ne compte que les sessions bloquées PAR la barrière (directement, ou derrière une session qu'elle bloque) :
 *     `pg_blocking_pids`. Une écriture voisine ne l'ouvre plus, et elle s'ouvre dès que les gestes du banc y sont ;
 *   • une barrière à la fois dans toute la suite : le premier geste de sa transaction prend un verrou consultatif
 *     commun, AVANT la table. Le cycle (3) n'a plus de second participant ; et le verrou tombe avec la transaction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── UN GESTE GLOBAL, UN BANC À LA FOIS ──────────────────────────────────────────────────────

/**
 * La section exclusive ENTRE fichiers de test : le second banc ATTEND que le premier ait fini (une attente
 * déterministe, jamais un délai). Le verrou consultatif est celui de la transaction qui enveloppe `fn` : il tombe avec
 * elle, même si `fn` lève ou si le processus meurt. La transaction ne porte que le verrou (elle n'écrit rien) : `fn`
 * écrit par le client ordinaire.
 *
 * MESURÉ : « Masquer les ordres réglés de l'historique » joué par `purge-historique-flow.test.ts` pendant
 * `reversibilite-demandes-flow.test.ts` masquait, sous SON geste, les 520 ordres que l'autre venait de semer — dont
 * l'annulation n'en rendait plus que 167. Le geste a raison d'être global ; ce sont les bancs qui se succèdent.
 */
export function exclusifEntreBancs<T>(cle: string, fn: () => Promise<T>): Promise<T> {
  // Le budget de la transaction est celui du geste qui la tient, pas un plafond de test : elle ne fait qu'attendre.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('banc-exclusif'), hashtext(${cle}))`;
    return fn();
  }, { maxWait: 120_000, timeout: 120_000 });
}

/** La clé des bancs qui jouent « Masquer les ordres réglés de l'historique ». */
export const PURGE_HISTORIQUE = "expense-actions:purgeSettledExpenseOrders";

// ── LA BARRIÈRE ─────────────────────────────────────────────────────────────────────────────

/**
 * POSER LA BARRIÈRE, premier geste de la transaction du banc : le tour (une barrière à la fois dans la suite), puis le
 * verrou `SHARE` de chaque table — les lectures passent, les écritures attendent.
 */
export async function poserBarriere(tx: Prisma.TransactionClient, ...tables: string[]): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('banc-exclusif'), hashtext('barriere-de-table'))`;
  for (const t of tables) await tx.$executeRawUnsafe(`LOCK TABLE "${t.replace(/"/g, "")}" IN SHARE MODE`);
}

/** `"signedAt"` → `%signedAt%` ; un motif qui porte déjà ses jokers est pris tel quel. */
const enMotif = (m: string): string => (m.includes("%") ? m : `%${m}%`);

/**
 * Les sessions qui attendent un verrou PAR CETTE TRANSACTION — directement, ou derrière une session qu'elle bloque (le
 * second geste attend souvent le verrou de ligne du premier, qui attend la barrière) —, et dont la requête nomme un des
 * motifs. L'instantané de `pg_stat_activity` est rafraîchi : dans une transaction, Postgres le fige au premier accès.
 */
export async function compterBloques(tx: Prisma.TransactionClient, motifs: string | string[]): Promise<number> {
  await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    WITH RECURSIVE bloquees(pid) AS (
      SELECT a.pid FROM pg_stat_activity a WHERE pg_backend_pid() = ANY(pg_blocking_pids(a.pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN bloquees b ON b.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT count(*)::int AS n FROM pg_stat_activity a JOIN bloquees b ON b.pid = a.pid
    WHERE a.wait_event_type = 'Lock' AND a.query ILIKE ANY(${[motifs].flat().map(enMotif)}::text[])`;
  return n;
}

/**
 * ATTENDRE que `n` gestes du banc soient arrêtés à la barrière — sondé toutes les 25 ms. Au-delà de `delaiMs` : une
 * erreur qui dit ce que faisaient les sessions (`exiger`), ou le compte vu (une attente « au mieux »). Le délai borne un
 * geste qui ne viendra JAMAIS ; il n'est jamais le chemin ordinaire.
 */
export async function attendreBloques(
  tx: Prisma.TransactionClient, motifs: string | string[], n: number, o: { delaiMs?: number; exiger?: boolean } = {},
): Promise<number> {
  const delaiMs = o.delaiMs ?? 10_000;
  const debut = Date.now();
  for (;;) {
    const k = await compterBloques(tx, motifs);
    if (k >= n) return k;
    if (Date.now() - debut > delaiMs) {
      if (o.exiger === false) return k;
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const vues = await tx.$queryRaw<{ etat: string | null; attente: string; bloquee_par: string; requete: string }[]>`
        SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente,
          array_to_string(pg_blocking_pids(pid), ',') AS bloquee_par, left(query, 90) AS requete
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`;
      throw new Error(`les gestes n'ont pas atteint la barrière : ${k} bloqué(s) par elle sur ${[motifs].flat().join(", ")}, ${n} attendu(s) — ${JSON.stringify(vues)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
