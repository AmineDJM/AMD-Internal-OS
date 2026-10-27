import crypto from "crypto";
import os from "os";
import { prisma } from "@/lib/prisma";
import type { StatutTacheDeFond } from "@prisma/client";
import type { Executeur } from "./mode";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BAIL D'UNE TÂCHE DE FOND — un seul exécutant la tient à la fois (refonte V2-F).
 *
 * ── CE QU'IL FERME ───────────────────────────────────────────────────────────────────────
 *
 * Avant V2-F, le seul verrou était un drapeau EN MÉMOIRE (`running` dans `scheduled.ts`) : il
 * empêchait un processus de se chevaucher lui-même, rien de plus. Dès que deux processus battent —
 * le web et le worker pendant la bascule, deux instances pendant un déploiement —, chacun faisait
 * tout le passage. Les tâches sont idempotentes une à une (marqueurs, `updateMany` de réservation),
 * mais deux exécutants paient deux fois les mêmes appels de modèle et se disputent les mêmes lignes.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * Même forme que le bail des missions (`missions/runtime/bail.ts`) : un `UPDATE … WHERE` atomique.
 * La base tranche entre deux prétendants — sous READ COMMITTED, le second attend le premier puis
 * réévalue sa condition sur la ligne déjà prise, et repart bredouille.
 *
 * Une tâche se prend si (a) personne ne tient son bail, ou qu'il est EXPIRÉ (processus mort :
 * c'est la reprise après plantage, gratuite), et (b) son dernier départ date d'au moins
 * `intervalleMs` — sans quoi le second exécutant referait la tâche aussitôt la première rendue.
 *
 * Pourquoi pas un verrou consultatif (`pg_try_advisory_lock`) : il vit sur UNE connexion, or
 * Prisma prête une connexion différente à chaque requête — le verrou serait pris sur l'une et
 * rendu (ou pas) sur une autre. La variante transactionnelle obligerait à garder une transaction
 * ouverte pendant toute la tâche (minutes d'extraction). Une ligne de bail dit en plus QUI tient
 * la tâche et depuis quand : c'est le signal de santé, sans table de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Durée d'un bail sans renouvellement. L'exécutant le renouvelle tant que la tâche tourne. */
export const BAIL_TACHE_MS = 120_000;

/**
 * Écart minimal entre deux départs d'une même tâche, tous exécutants confondus. Inférieur au
 * battement (60 s) pour qu'un passage un peu en avance sur le précédent ne saute pas la tâche ;
 * assez long pour qu'un second exécutant ne la refasse pas dans la même minute.
 */
export const INTERVALLE_MIN_MS = 45_000;

/** L'identité de CE processus, telle que le bail l'écrit : lisible dans le Diagnostic. */
export function identiteDuProcessus(executeur: Executeur): string {
  return `${executeur}@${os.hostname()}#${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
}

export type OptionsBail = {
  detenteur: string;
  executeur: Executeur;
  bailMs?: number;
  intervalleMs?: number;
  maintenant?: Date;
};

/**
 * Prend le bail de la tâche — atomique. Vrai si CET exécutant la tient désormais.
 * La ligne naît au premier appel (`skipDuplicates` : deux naissances simultanées n'en font qu'une).
 */
export async function prendreBailTache(cle: string, o: OptionsBail): Promise<boolean> {
  const maintenant = o.maintenant ?? new Date();
  const bailMs = o.bailMs ?? BAIL_TACHE_MS;
  const intervalleMs = o.intervalleMs ?? INTERVALLE_MIN_MS;
  await prisma.tacheDeFond.createMany({ data: [{ cle }], skipDuplicates: true });
  const r = await prisma.tacheDeFond.updateMany({
    where: {
      cle,
      AND: [
        { OR: [{ bailJusqua: null }, { bailJusqua: { lt: maintenant } }, { detenteur: o.detenteur }] },
        { OR: [{ dernierDebutA: null }, { dernierDebutA: { lte: new Date(maintenant.getTime() - intervalleMs) } }] },
      ],
    },
    data: {
      detenteur: o.detenteur,
      executeur: o.executeur,
      bailJusqua: new Date(maintenant.getTime() + bailMs),
      dernierDebutA: maintenant,
      dernierStatut: "EN_COURS",
    },
  });
  return r.count === 1;
}

/** Prolonge le bail — seulement le sien. Faux : le bail a été perdu (expiré puis repris). */
export async function renouvelerBailTache(cle: string, detenteur: string, bailMs = BAIL_TACHE_MS): Promise<boolean> {
  const r = await prisma.tacheDeFond.updateMany({
    where: { cle, detenteur },
    data: { bailJusqua: new Date(Date.now() + bailMs) },
  });
  return r.count === 1;
}

export type IssueTache = {
  statut: Exclude<StatutTacheDeFond, "EN_COURS">;
  dureeMs: number;
  /** L'erreur tronquée (ECHEC) ou la raison (IGNOREE). */
  message?: string | null;
};

/**
 * Rend le bail en écrivant l'issue du passage — seulement le sien : rendre le bail d'un autre le
 * lui volerait, et écraserait son issue. Faux si le bail n'était plus à nous.
 */
export async function rendreBailTache(cle: string, detenteur: string, issue: IssueTache): Promise<boolean> {
  const r = await prisma.tacheDeFond.updateMany({
    where: { cle, detenteur },
    data: {
      detenteur: null,
      bailJusqua: null,
      dernierFinA: new Date(),
      derniereDureeMs: Math.round(issue.dureeMs),
      dernierStatut: issue.statut,
      dernierMessage: issue.message ?? null,
      executions: { increment: 1 },
      ...(issue.statut === "ECHEC" ? { echecs: { increment: 1 } } : {}),
    },
  });
  return r.count === 1;
}
