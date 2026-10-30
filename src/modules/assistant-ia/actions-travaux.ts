"use server";

import { porte } from "./infra/porte-actions";
import type { DemandeRecue } from "@/lib/missions/travaux/delegation";
import type { EtapeVue } from "@/lib/missions/travaux/service";
import type { TravailDEquipe } from "@/modules/assistant-ia/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TRAVAUX, SUITE (J8, décision 0023) — les gestes de la personne sur ce que les travaux des AUTRES lui
 * demandent (demandes reçues : lire, répondre, décliner), la priorité de SES travaux, et la vue d'un responsable
 * sur ceux de son équipe (si la console l'autorise ; chaque consultation à l'audit).
 *
 * L'identité vient TOUJOURS de la session (`porte`), jamais d'un paramètre : un identifiant de demande deviné ne
 * donne rien s'il n'est pas adressé à la personne (le service la met dans chaque `where`). Aucune écriture en
 * « Vue exacte ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const id = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 64 ? v : null);
const delegation = () => import("@/lib/missions/travaux/delegation");
const pieces = async () => (await import("@/modules/assistant-ia/infra/travaux-pieces")).PIECES_TRAVAUX;

export async function listerMesDemandesRecues(): Promise<{ ok: true; demandes: DemandeRecue[]; ouvertes: number } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const demandes = await (await delegation()).listerDemandesRecues(p.user.id);
  return { ok: true, demandes, ouvertes: demandes.filter((d) => d.statut === "OUVERTE").length };
}

export async function repondreAMaDemande(demandeId: string, texte: string, piecesJointes: string[] = []) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(demandeId)) return { ok: false as const, erreur: "Demande introuvable." };
  const liste = (Array.isArray(piecesJointes) ? piecesJointes : []).map(id).filter((x): x is string => !!x);
  return (await delegation()).repondreDemande(demandeId, p.user.id, { texte: typeof texte === "string" ? texte : "", pieces: liste }, await pieces());
}

export async function declinerMaDemande(demandeId: string, motif: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(demandeId)) return { ok: false as const, erreur: "Demande introuvable." };
  return (await delegation()).declinerDemande(demandeId, p.user.id, typeof motif === "string" ? motif : "");
}

export async function reglerPrioriteMonTravail(travailId: string, priorite: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await import("@/lib/missions/travaux/service")).reglerPrioriteTravail(travailId, p.user.id, String(priorite ?? "").toUpperCase());
}

/** L'onglet « Mon équipe » existe-t-il ? La console seule le dit — rien n'est lu, rien n'est audité. */
export async function equipeVisiblePourMoi(): Promise<boolean> {
  const p = await porte(false);
  if (!p.ok) return false;
  return (await import("@/modules/assistant-ia/api")).equipeVisible();
}

export async function listerTravauxDeMonEquipe(): Promise<{ ok: true; visible: boolean; travaux: TravailDEquipe[] } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const api = await import("@/modules/assistant-ia/api");
  if (!(await api.equipeVisible())) return { ok: true, visible: false, travaux: [] };
  const r = await api.listerTravauxEquipe(p.user.id);
  return r.ok ? { ok: true, visible: true, travaux: r.valeur } : { ok: false, erreur: r.erreur };
}

export async function lireTravailDeMonEquipe(travailId: string): Promise<{ ok: true; travail: TravailDEquipe & { liste: EtapeVue[] } } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false, erreur: "Travail introuvable." };
  const r = await (await import("@/modules/assistant-ia/api")).lireTravailEquipe(p.user.id, travailId);
  return r.ok ? { ok: true, travail: r.valeur } : { ok: false, erreur: r.erreur };
}
