import { AsyncLocalStorage } from "node:async_hooks";

/**
 * LE CONTEXTE ASYNCHRONE DE NEXT, HORS DE NEXT (J8, `contexte-geste.ts`) — à importer EN PREMIER par un processus
 * qui n'est pas le serveur Next (le worker, un banc, un test qui appelle une vraie action de l'écran).
 *
 * Next crée ses magasins de contexte (`workAsyncStorage`…) au CHARGEMENT de ses modules, avec `globalThis.AsyncLocalStorage`
 * — que seul son serveur pose. Ailleurs, il prend un faux qui lève « AsyncLocalStorage accessed in runtime where it is
 * not available » au premier `revalidatePath`. Poser le vrai avant que Next ne se charge rend ses magasins réels ; dans
 * le serveur Next, il est déjà là et rien ne change.
 */
const g = globalThis as { AsyncLocalStorage?: unknown };
g.AsyncLocalStorage ??= AsyncLocalStorage;
