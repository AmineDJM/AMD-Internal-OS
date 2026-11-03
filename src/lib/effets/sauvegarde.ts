import type { AsyncLocalStorage } from "node:async_hooks";
import { constructeurAls } from "@/platform/donnees/contexte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE REQUÊTE QUI ÉCHOUE NE FAIT PAS ÉCHOUER LES SUIVANTES — pour l'essai d'un agent (« Essayer l'agent de… »).
 *
 * L'essai joue le vrai tour d'une personne dans UNE transaction, annulée à la fin (`simulation.ts`). Or, dans une
 * transaction Postgres, la première requête en erreur interrompt tout : « current transaction is aborted, commands
 * ignored until end of transaction block ». En vrai, chaque requête est la sienne — un `create` refusé par l'unicité et
 * rattrapé (`.catch(sansBloquer…)`), un accès au mieux qui échoue, et le tour continue. Dans l'essai, tout ce qui
 * suivait échouait : l'agent répondait MOINS bien que le vrai, et l'essai ne disait plus ce que la personne verra.
 *
 * Chaque requête passe donc entre un POINT DE SAUVEGARDE et sa libération ; en erreur, la transaction revient au point
 * de sauvegarde (son écriture s'efface, comme une requête refusée en vrai) et l'erreur remonte telle quelle. Les
 * requêtes du geste passent UNE à la fois : la transaction n'a qu'une connexion (Prisma les sérialise déjà), et deux
 * points de sauvegarde entremêlés se libéreraient l'un l'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Fn = (...a: unknown[]) => unknown;
const SQL = new Set(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);

/**
 * UNE REQUÊTE IMBRIQUÉE passe DANS le point de sauvegarde de sa parente : l'extension de capture relit la ligne « avant »
 * d'une écriture par le client du geste, PENDANT cette écriture — mise en file derrière elle, elle l'aurait attendue, et
 * l'écriture l'attendait (interblocage mesuré : l'essai figé jusqu'au délai). Le magasin asynchrone dit « dedans ».
 */
const C = constructeurAls();
const dedans: AsyncLocalStorage<true> | null = C ? new C<true>() : null;

export function clientAvecPointsDeSauvegarde<T extends object>(tx: T): T {
  const brut = tx as unknown as Record<string | symbol, unknown>;
  const executer = (sql: string) => (brut.$executeRawUnsafe as Fn).call(tx, sql) as Promise<unknown>;
  let file: Promise<unknown> = Promise.resolve();
  let n = 0;

  const isoler = <R>(requete: () => unknown): Promise<R> => {
    if (dedans?.getStore()) return Promise.resolve(requete() as Promise<R>);
    const tour = file.then(() => (dedans ? dedans.run(true, avecPoint) : avecPoint()));
    file = tour.catch(() => undefined);
    return tour;

    async function avecPoint(): Promise<R> {
      const point = `essai_${++n}`;
      await executer(`SAVEPOINT ${point}`);
      try {
        const r = await (requete() as Promise<R>);
        await executer(`RELEASE SAVEPOINT ${point}`);
        return r;
      } catch (e) {
        // La transaction revient où elle était avant la requête ; l'erreur, elle, est celle que le code aurait reçue.
        await executer(`ROLLBACK TO SAVEPOINT ${point}`).catch(() => undefined);
        throw e;
      }
    }
  };

  const delegues = new Map<string | symbol, unknown>();
  const delegue = (prop: string | symbol, d: Record<string | symbol, unknown>) => {
    if (!delegues.has(prop)) {
      delegues.set(prop, new Proxy(d, {
        get(cible, m) {
          const v = cible[m];
          return typeof v === "function" ? (...a: unknown[]) => isoler(() => (v as Fn).apply(cible, a)) : v;
        },
      }));
    }
    return delegues.get(prop);
  };

  return new Proxy(tx, {
    has: (cible, prop) => prop in cible,
    get(cible, prop) {
      const v = (cible as Record<string | symbol, unknown>)[prop];
      if (typeof prop === "string" && SQL.has(prop) && typeof v === "function") return (...a: unknown[]) => isoler(() => (v as Fn).apply(cible, a));
      // Un délégué de modèle (`tx.user`, `tx.assistantIaTour`…) : chacune de ses opérations est isolée.
      if (typeof prop === "string" && !prop.startsWith("$") && v && typeof v === "object") return delegue(prop, v as Record<string | symbol, unknown>);
      return typeof v === "function" ? (v as Fn).bind(cible) : v;
    },
  });
}
