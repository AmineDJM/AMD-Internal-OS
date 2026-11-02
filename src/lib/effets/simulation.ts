import type { CurrentUser } from "@/lib/session";
import { sansBloquer } from "@/lib/journal";
import { prismaBrut } from "@/lib/prisma";
import { avecStoreHorsRequete, etatPour, type ContexteDuGeste } from "./geste";
import { finaliserCapture } from "./capture";
import { clientCapturant } from "./client";
import { construireDiff, type DiffSimulation } from "./diff";
import { sousGeste, type Capture } from "./magasin";
import { installerPortReseau } from "./reseau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SIMULATION TRANSACTIONNELLE (J7, décision 0029) — l'action de l'écran, jouée pour de vrai, puis ANNULÉE.
 *
 * ── LE GESTE ─────────────────────────────────────────────────────────────────────────────
 *
 * Une transaction Prisma est ouverte ; le contexte du geste passe en mode SIMULATION, avec la transaction pour
 * client. L'action s'exécute — la même que le bouton, ses `requireUser` / `userCan` compris, au nom de la personne.
 * Chacune de ses requêtes passe par la transaction (`prisma.ts` les y route) et chacune de ses écritures est
 * capturée (`capture.ts`). Puis la transaction est ANNULÉE, quoi qu'il arrive : la sortie normale lève un signal
 * d'annulation que nous seuls attrapons.
 *
 * ── CE QUI NE SORT PAS ───────────────────────────────────────────────────────────────────
 *
 * Les ports lisent le mode : courriel (SMTP, Graph, API), notification poussée, stockage objet, site Adventum,
 * et tout `fetch` qui écrit vers l'extérieur (webhooks, fournisseurs) — notés, jamais émis. Les invalidations de
 * cache vont dans un store à part : une simulation ne rafraîchit aucune page.
 *
 * ── CE QUE LA SIMULATION REND ────────────────────────────────────────────────────────────
 *
 * Le DIFF lisible (`diff.ts`) et son empreinte. Une action qui refuse ou lève donne un diff en ÉCHEC, avec la raison :
 * la carte le dit, elle ne montre jamais un diff vide comme une preuve que « rien ne change ».
 *
 * ── APRÈS L'ANNULATION ───────────────────────────────────────────────────────────────────
 *
 * Une promesse lancée sans être attendue (« au mieux ») qui écrirait APRÈS la fin du geste trouve une transaction
 * close et échoue — jamais le client de base : le contexte garde la transaction, il ne retombe pas sur la vraie base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface IssueSimulation<T> {
  ok: boolean;
  resultat?: T;
  erreur?: string;
  capture: Capture;
  invalidations: string[];
  debut: number;
  fin: number;
}

const ANNULATION = Symbol("simulation-annulee");

/** Délai d'une simulation : au-delà, la transaction est abandonnée (et donc annulée). */
const DELAI_MS = 20_000;

export async function simulerGeste<T>(
  user: CurrentUser,
  ctx: Omit<ContexteDuGeste, "mode">,
  geste: () => Promise<T>,
  opts: { delaiMs?: number } = {},
): Promise<IssueSimulation<T>> {
  installerPortReseau();
  const capture: Capture = { ecritures: [], effets: [] };
  const debut = Date.now();
  let issue: { ok: boolean; resultat?: T; erreur?: string; invalidations: string[] } = { ok: false, erreur: "la simulation n'a pas démarré", invalidations: [] };
  try {
    await clientCapturant().$transaction(async (tx) => {
      const etat = { ...etatPour(user, { ...ctx, mode: "SIMULATION" }), mode: "SIMULATION" as const, capture, client: tx, debut };
      try {
        const r = await sousGeste(etat, () => avecStoreHorsRequete(ctx.origine, geste, true));
        issue = { ok: true, resultat: r.resultat, invalidations: r.invalidations };
        // Ce qu'une promesse « au mieux » écrit encore, et l'état final des lignes touchées — AVANT l'annulation.
        await finaliserCapture(capture, tx as unknown as Record<string, unknown>);
      } catch (e) {
        issue = { ok: false, erreur: e instanceof Error ? e.message : String(e), invalidations: [] };
      }
      throw ANNULATION;
    }, { timeout: opts.delaiMs ?? DELAI_MS, maxWait: 10_000 });
  } catch (e) {
    if (e !== ANNULATION) {
      const message = e instanceof Error ? e.message : String(e);
      issue = { ok: false, erreur: /expired|timeout|closed/i.test(message) ? "la simulation a dépassé son délai" : message, invalidations: [] };
    }
  }
  return { ...issue, capture, debut, fin: Date.now() };
}

/** Les noms des personnes visées par une notification ou une poussée — lus HORS de la transaction annulée. */
export async function nomsDesDestinataires(capture: Capture): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const e of capture.ecritures) if (e.modele === "Notification" && typeof e.apres?.userId === "string") ids.add(e.apres.userId);
  for (const f of capture.effets) if (f.acte === "NOTIFICATION_PUSH") ids.add(f.cible);
  if (!ids.size) return new Map();
  const users = await prismaBrut.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }).catch(sansBloquer("effets.simulation.noms", [] as { id: string; name: string | null }[]));
  return new Map(users.map((u) => [u.id, u.name ?? "une personne"]));
}

/** Simule et rend le DIFF lisible — la forme que la carte affiche. `echecDeclare` lit le refus propre à l'action. */
export async function simulerEnDiff<T>(
  user: CurrentUser,
  ctx: Omit<ContexteDuGeste, "mode">,
  geste: () => Promise<T>,
  echecDeclare: (r: T) => string | null = () => null,
): Promise<{ diff: DiffSimulation; issue: IssueSimulation<T> }> {
  const issue = await simulerGeste(user, ctx, geste);
  const refus = issue.ok ? echecDeclare(issue.resultat as T) : issue.erreur ?? "erreur inconnue";
  const noms = await nomsDesDestinataires(issue.capture);
  return { diff: construireDiff(issue.capture, { debut: issue.debut, fin: issue.fin }, noms, refus ?? undefined), issue };
}
