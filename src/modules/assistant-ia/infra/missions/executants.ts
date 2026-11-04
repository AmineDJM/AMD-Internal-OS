import { prisma } from "@/lib/prisma";
import { lireInterrupteurMissions, phraseSuspension } from "@/lib/interrupteurs/missions";
import { silenceDesExecutants, type EtatDesExecutants } from "../../domaine/missions/pilotage";

/**
 * QUI CONDUIT LES MISSIONS (lot P1, décision 0047) — lu sur les baux des tâches de fond (`TacheDeFond`) : le dernier
 * passage EFFECTIF du balayage des travaux, et le dernier battement du service worker. Le tableau « Missions », l'outil
 * `mes_missions` et Administration › IA le disent : une mission que personne ne conduit n'est pas « en cours ».
 */
/** Qui conduit les travaux en ce moment — le dernier passage EFFECTIF du balayage, et le dernier battement du worker. */
export async function etatDesExecutants(): Promise<EtatDesExecutants & { executeur: string | null }> {
  const [b, w, interrupteur] = await Promise.all([
    prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" }, select: { dernierDebutA: true, dernierStatut: true, dernierMessage: true, executeur: true } }),
    prisma.tacheDeFond.findFirst({ where: { executeur: "worker", dernierDebutA: { not: null } }, orderBy: { dernierDebutA: "desc" }, select: { dernierDebutA: true } }),
    lireInterrupteurMissions().catch(() => null),
  ]);
  const workerVu = w?.dernierDebutA?.toISOString() ?? null;
  // Un passage « ignoré » n'a rien conduit : s'il s'est abstenu parce que le worker conduit, c'est le worker qui compte.
  const ignore = b?.dernierStatut === "IGNOREE";
  const dernierPassage = !b?.dernierDebutA ? null
    : ignore ? (/worker/i.test(b.dernierMessage ?? "") ? workerVu : null)
      : b.dernierDebutA.toISOString();
  // P1 ter : le passage ignoré et SA RAISON — un balayage débrayé (TRAVAUX_SWEEP=off) n'est pas « aucun battement ».
  return {
    dernierPassage, workerVu, balayageVu: b?.dernierDebutA?.toISOString() ?? null, raisonIgnore: ignore ? (b?.dernierMessage ?? "passage ignoré") : null, executeur: b?.executeur ?? null,
    suspension: interrupteur?.suspendues ? phraseSuspension(interrupteur) : null,
    dernierBalayage: b ? { qui: b.executeur, quand: b.dernierDebutA?.toISOString() ?? null, statut: b.dernierStatut, bilan: b.dernierMessage } : null,
  };
}


/** Administration › IA : qui conduit les missions, et combien attendent un exécutant (toutes personnes confondues). */
export async function executantsPourAdministration(maintenant = new Date()): Promise<EtatDesExecutants & { silence: string | null; enAttente: number; mode: string }> {
  const [ex, enAttente] = await Promise.all([
    etatDesExecutants(),
    prisma.mission.count({ where: { kind: "TRAVAIL", planApprouveLe: { not: null }, status: { in: ["READY", "RUNNING", "RETRYING"] } } }),
  ]);
  return { ...ex, silence: silenceDesExecutants(ex, maintenant.getTime()), enAttente, mode: (process.env.TACHES_DE_FOND ?? "web (défaut)").trim() || "web (défaut)" };
}
