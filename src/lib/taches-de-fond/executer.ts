import { performance } from "perf_hooks";
import { BAIL_TACHE_MS, prendreBailTache, rendreBailTache, renouvelerBailTache } from "./bail";
import { journalConsole, messageErreur, type Journal } from "./journal";
import type { Executeur } from "./mode";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXÉCUTION D'UNE TÂCHE DE FOND — bail, mesure, issue, journal (refonte V2-F).
 *
 * Le même chemin sert au web (battement `setInterval` de `scheduled.ts`) et au worker
 * (`npm run worker`) : une tâche ne sait pas qui l'exécute, et l'exécutant ne sait rien de la
 * tâche au-delà de sa clé. Ce qui change entre les deux, c'est la CONTEXTE : l'identité écrite
 * dans le bail et la question « dois-je m'arrêter ? » (SIGTERM côté worker).
 *
 * Une tâche qui échoue n'arrête plus le passage : avant V2-F, cinq étapes sans `.catch` (rappels
 * de réunion, jobs réglementaires, veille ANPP, lots IA, Pulse) faisaient sauter TOUT le reste du
 * passage sur une seule exception, et une vingtaine d'autres avalaient la leur en silence
 * (`.catch(() => 0)`). Désormais chaque échec est attrapé, compté en base et journalisé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'une tâche peut rendre pour dire « rien à faire, et c'est voulu » (débrayée, pas livrée). */
export type TacheIgnoree = { readonly ignoree: string };

export function ignoree(raison: string): TacheIgnoree {
  return { ignoree: raison };
}

function estIgnoree(x: unknown): x is TacheIgnoree {
  return typeof x === "object" && x !== null && typeof (x as TacheIgnoree).ignoree === "string";
}

export type TachePlanifiee = {
  /** Clé stable — c'est la ligne `TacheDeFond`. La changer remet à zéro son historique. */
  cle: string;
  /** Le travail. Sa valeur de retour est ignorée, sauf un `ignoree(raison)`. */
  executer: () => Promise<unknown>;
  /** Durée du bail (renouvelé pendant l'exécution). Défaut `BAIL_TACHE_MS`. */
  bailMs?: number;
  /** Écart minimal entre deux départs, tous exécutants confondus. Défaut `INTERVALLE_MIN_MS`. */
  intervalleMs?: number;
};

export type ContexteExecution = {
  /** L'identité écrite dans le bail (`identiteDuProcessus`). */
  detenteur: string;
  executeur: Executeur;
  journal?: Journal;
  /** Consulté ENTRE deux tâches : vrai = ne plus en prendre de nouvelle (arrêt propre). */
  doitSArreter?: () => boolean;
};

export type IssueExecution = "ok" | "echec" | "ignoree" | "occupee" | "bail-indisponible";

export type BilanTache = { cle: string; issue: IssueExecution; dureeMs: number };

export type BilanPassage = { dureeMs: number; interrompu: boolean; taches: BilanTache[] };

/** Au-delà, la fin d'une tâche est journalisée même quand elle réussit : c'est elle qu'on cherchera. */
export const SEUIL_TACHE_LENTE_MS = 2_000;

/** Exécute UNE tâche si cet exécutant obtient son bail. Ne lève jamais. */
export async function executerTache(tache: TachePlanifiee, ctx: ContexteExecution): Promise<BilanTache> {
  const journal = ctx.journal ?? journalConsole;
  const bailMs = tache.bailMs ?? BAIL_TACHE_MS;

  let pris: boolean;
  try {
    pris = await prendreBailTache(tache.cle, {
      detenteur: ctx.detenteur, executeur: ctx.executeur, bailMs, intervalleMs: tache.intervalleMs,
    });
  } catch (e) {
    // Base injoignable, table absente (migration non appliquée) : la tâche ne part pas — partir
    // sans bail, c'est précisément le double passage que le bail existe pour empêcher.
    journal("erreur", "tache.bail-indisponible", { tache: tache.cle, erreur: messageErreur(e) });
    return { cle: tache.cle, issue: "bail-indisponible", dureeMs: 0 };
  }
  if (!pris) return { cle: tache.cle, issue: "occupee", dureeMs: 0 };

  // Le bail se RENOUVELLE tant que la tâche tourne : une extraction de dix minutes ne doit pas
  // paraître morte au bout de deux. `unref` : ce minuteur ne retient jamais un arrêt du processus.
  const renouvellement = setInterval(() => {
    void renouvelerBailTache(tache.cle, ctx.detenteur, bailMs)
      .then((garde) => { if (!garde) journal("avertissement", "tache.bail-perdu", { tache: tache.cle, detenteur: ctx.detenteur }); })
      .catch((e) => journal("avertissement", "tache.renouvellement-echoue", { tache: tache.cle, erreur: messageErreur(e) }));
  }, Math.max(1_000, Math.floor(bailMs / 3)));
  renouvellement.unref?.();

  const debut = performance.now();
  let issue: Exclude<IssueExecution, "occupee" | "bail-indisponible">;
  let message: string | null = null;
  try {
    const r = await tache.executer();
    if (estIgnoree(r)) { issue = "ignoree"; message = r.ignoree; } else issue = "ok";
  } catch (e) {
    issue = "echec";
    message = messageErreur(e);
  } finally {
    clearInterval(renouvellement);
  }
  const dureeMs = Math.round(performance.now() - debut);

  const statut = issue === "ok" ? "OK" : issue === "echec" ? "ECHEC" : "IGNOREE";
  const rendu = await rendreBailTache(tache.cle, ctx.detenteur, { statut, dureeMs, message })
    .catch((e) => { journal("avertissement", "tache.rendu-echoue", { tache: tache.cle, erreur: messageErreur(e) }); return true; });
  if (!rendu) journal("avertissement", "tache.bail-perdu", { tache: tache.cle, detenteur: ctx.detenteur, dureeMs });

  if (issue === "echec") journal("erreur", "tache.echec", { tache: tache.cle, executeur: ctx.executeur, dureeMs, erreur: message });
  else if (dureeMs >= SEUIL_TACHE_LENTE_MS) journal("info", "tache.lente", { tache: tache.cle, executeur: ctx.executeur, dureeMs });

  return { cle: tache.cle, issue, dureeMs };
}

/**
 * Un PASSAGE : les tâches une à une, dans l'ordre de la table (certaines lisent ce que la
 * précédente vient d'écrire — le briefing du matin après le Pulse). Les tâches tenues par un autre
 * exécutant sont passées. L'arrêt demandé est respecté ENTRE deux tâches : celle en cours finit.
 */
export async function executerPassage(taches: readonly TachePlanifiee[], ctx: ContexteExecution): Promise<BilanPassage> {
  const journal = ctx.journal ?? journalConsole;
  const debut = performance.now();
  const bilans: BilanTache[] = [];
  let interrompu = false;
  for (const tache of taches) {
    if (ctx.doitSArreter?.()) { interrompu = true; break; }
    bilans.push(await executerTache(tache, ctx));
  }
  const dureeMs = Math.round(performance.now() - debut);
  const compte = (i: IssueExecution) => bilans.filter((b) => b.issue === i).length;
  const executees = bilans.filter((b) => b.issue === "ok" || b.issue === "echec" || b.issue === "ignoree");
  journal(compte("echec") > 0 ? "avertissement" : "info", "passage.fin", {
    executeur: ctx.executeur,
    detenteur: ctx.detenteur,
    dureeMs,
    interrompu,
    executees: executees.length,
    echecs: compte("echec"),
    occupees: compte("occupee"),
    // La durée de chaque tâche exécutée, en une ligne : le passage lent se lit sans requête.
    durees: Object.fromEntries(executees.map((b) => [b.cle, b.dureeMs])),
  });
  return { dureeMs, interrompu, taches: bilans };
}
