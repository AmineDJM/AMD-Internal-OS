import { prisma } from "@/lib/prisma";
import type { StatutTacheDeFond, TacheDeFond } from "@prisma/client";
import { lireModeTachesDeFond, modeInconnu, type ModeTachesDeFond } from "./mode";

/**
 * LE SIGNAL DE SANTÉ DES TÂCHES DE FOND (refonte V2-F) — lu par `/api/health/worker` et par le
 * Diagnostic (Super Admin). Il ne lit que la table des baux : pas la chaîne des tâches, donc ni
 * battement armé ni module lourd chargé pour répondre.
 *
 * « Vivant » = au moins une tâche est partie depuis moins de `SEUIL_SILENCE_MS`. Une tâche dont
 * le dernier départ est plus vieux est EN RETARD ; une tâche EN_COURS dont le bail a expiré a été
 * INTERROMPUE (processus tué) et attend sa reprise.
 */

/** Cinq battements manqués : au-delà, quelque chose s'est arrêté. */
export const SEUIL_SILENCE_MS = 5 * 60_000;

export type EtatTache = {
  cle: string;
  executeur: string | null;
  dernierDebutA: string | null;
  dernierFinA: string | null;
  derniereDureeMs: number | null;
  statut: StatutTacheDeFond | null;
  enCours: boolean;
  interrompue: boolean;
  enRetard: boolean;
  executions: number;
  echecs: number;
  /** Détail réservé au Super Admin : identité du processus et message du dernier passage. */
  detenteur?: string | null;
  message?: string | null;
};

export type SanteTachesDeFond = {
  mode: ModeTachesDeFond;
  modeInconnu: boolean;
  verifieA: string;
  vivant: boolean;
  dernierBattementA: string | null;
  /** Qui a fait des passages récents (« web », « worker ») — la bascule se lit ici. */
  executeursRecents: string[];
  taches: EtatTache[];
};

type LigneTache = Pick<TacheDeFond,
  "cle" | "detenteur" | "executeur" | "bailJusqua" | "dernierDebutA" | "dernierFinA" | "derniereDureeMs"
  | "dernierStatut" | "dernierMessage" | "executions" | "echecs">;

/** Pur : des lignes de bail à l'état de santé. */
export function evaluerSante(lignes: LigneTache[], o: { maintenant: Date; mode: ModeTachesDeFond; modeInconnu: boolean; detail: boolean }): SanteTachesDeFond {
  const t = o.maintenant.getTime();
  const recent = (d: Date | null) => d !== null && t - d.getTime() < SEUIL_SILENCE_MS;
  const taches = [...lignes].sort((a, b) => a.cle.localeCompare(b.cle)).map((l): EtatTache => {
    const bailVivant = l.bailJusqua !== null && l.bailJusqua.getTime() >= t;
    return {
      cle: l.cle,
      executeur: l.executeur,
      dernierDebutA: l.dernierDebutA?.toISOString() ?? null,
      dernierFinA: l.dernierFinA?.toISOString() ?? null,
      derniereDureeMs: l.derniereDureeMs,
      statut: l.dernierStatut,
      enCours: l.dernierStatut === "EN_COURS" && bailVivant,
      interrompue: l.dernierStatut === "EN_COURS" && !bailVivant,
      enRetard: !recent(l.dernierDebutA),
      executions: l.executions,
      echecs: l.echecs,
      ...(o.detail ? { detenteur: l.detenteur, message: l.dernierMessage } : {}),
    };
  });
  const dernier = lignes.reduce<Date | null>((m, l) => (l.dernierDebutA && (!m || l.dernierDebutA > m) ? l.dernierDebutA : m), null);
  const executeursRecents = [...new Set(lignes.filter((l) => recent(l.dernierDebutA) && l.executeur).map((l) => l.executeur as string))].sort();
  return {
    mode: o.mode,
    modeInconnu: o.modeInconnu,
    verifieA: o.maintenant.toISOString(),
    vivant: recent(dernier),
    dernierBattementA: dernier?.toISOString() ?? null,
    executeursRecents,
    taches,
  };
}

export async function lireSanteTachesDeFond(o: { detail: boolean }): Promise<SanteTachesDeFond> {
  const lignes = await prisma.tacheDeFond.findMany({
    select: {
      cle: true, detenteur: true, executeur: true, bailJusqua: true, dernierDebutA: true, dernierFinA: true,
      derniereDureeMs: true, dernierStatut: true, dernierMessage: true, executions: true, echecs: true,
    },
  });
  return evaluerSante(lignes, { maintenant: new Date(), mode: lireModeTachesDeFond(), modeInconnu: modeInconnu(), detail: o.detail });
}
