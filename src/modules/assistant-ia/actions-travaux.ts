"use server";

import { porte } from "./infra/porte-actions";
import type { DemandeRecue, EtapeVue, TableauDesMissions, TravailDEquipe } from "@/modules/assistant-ia/api";

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
// Chargée à l'appel : la porte du module ne pèse que sur ces gestes-là.
const api = () => import("@/modules/assistant-ia/api");

export async function listerMesDemandesRecues(): Promise<{ ok: true; demandes: DemandeRecue[]; ouvertes: number } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const demandes = await (await api()).listerDemandesRecues(p.user.id);
  return { ok: true, demandes, ouvertes: demandes.filter((d) => d.statut === "OUVERTE").length };
}

export async function repondreAMaDemande(demandeId: string, texte: string, piecesJointes: string[] = []) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(demandeId)) return { ok: false as const, erreur: "Demande introuvable." };
  const liste = (Array.isArray(piecesJointes) ? piecesJointes : []).map(id).filter((x): x is string => !!x);
  const m = await api();
  return m.repondreDemande(demandeId, p.user.id, { texte: typeof texte === "string" ? texte : "", pieces: liste }, m.PIECES_TRAVAUX);
}

export async function declinerMaDemande(demandeId: string, motif: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(demandeId)) return { ok: false as const, erreur: "Demande introuvable." };
  return (await api()).declinerDemande(demandeId, p.user.id, typeof motif === "string" ? motif : "");
}

export async function reglerPrioriteMonTravail(travailId: string, priorite: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await api()).reglerPrioriteTravail(travailId, p.user.id, String(priorite ?? "").toUpperCase());
}

/** L'onglet « Mon équipe » existe-t-il ? La console seule le dit — rien n'est lu, rien n'est audité. */
export async function equipeVisiblePourMoi(): Promise<boolean> {
  const p = await porte(false);
  if (!p.ok) return false;
  return (await api()).equipeVisible();
}

export async function listerTravauxDeMonEquipe(): Promise<{ ok: true; visible: boolean; travaux: TravailDEquipe[] } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const m = await api();
  if (!(await m.equipeVisible())) return { ok: true, visible: false, travaux: [] };
  const r = await m.listerTravauxEquipe(p.user.id);
  return r.ok ? { ok: true, visible: true, travaux: r.valeur } : { ok: false, erreur: r.erreur };
}

export async function lireTravailDeMonEquipe(travailId: string): Promise<{ ok: true; travail: TravailDEquipe & { liste: EtapeVue[] } } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false, erreur: "Travail introuvable." };
  const r = await (await api()).lireTravailEquipe(p.user.id, travailId);
  return r.ok ? { ok: true, travail: r.valeur } : { ok: false, erreur: r.erreur };
}

// ─────────────────────────── K3 (décision 0033) : les sous-missions et leur tableau de bord ───────────────────────────

/** LE TABLEAU DE BORD, lu une fois — le REPLI du flux temps réel (`/api/assistant-ia/missions/flux`) quand il coupe. */
export async function lireMonTableauDeMissions(): Promise<{ ok: true; tableau: TableauDesMissions } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, tableau: await (await api()).tableauDesMissions(p.user.id) };
}

/** ANNULER UNE MISSION — et ses sous-missions vivantes ; la synthèse suit si c'était la dernière d'un groupe. */
export async function annulerMaMission(travailId: string): Promise<{ ok: true; message: string } | { ok: false; erreur: string }> {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false, erreur: "Mission introuvable." };
  return (await api()).annulerMissionEtSousMissions(travailId, p.user.id);
}

/** « Démarrer d'office les travaux sans geste » : la préférence de la personne (null = le défaut de la console). */
export async function lireMaPreferenceDOffice(): Promise<{ ok: true; preference: boolean | null; effectif: boolean } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, ...(await (await api()).lirePreferenceDOffice(p.user)) };
}

export async function reglerMaPreferenceDOffice(valeur: boolean | null): Promise<{ ok: true; effectif: boolean } | { ok: false; erreur: string }> {
  const p = await porte(true);
  if (!p.ok) return p;
  const m = await api();
  await m.reglerPreferenceDOffice(p.user.id, typeof valeur === "boolean" ? valeur : null);
  return { ok: true, effectif: await m.travauxDOfficePour(p.user) };
}
