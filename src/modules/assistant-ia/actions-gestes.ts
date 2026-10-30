"use server";

import { porte } from "./infra/porte-actions";
import { annulerGeste, gestesDeLAssistant, planDAnnulation, type CompteRenduAnnulation, type GesteListe } from "@/platform/ia/hors-requete";

/**
 * « CE QUE L'ASSISTANT A FAIT » (lot J7, décision 0029) — les gestes de l'assistant au nom de la personne (cartes
 * confirmées, étapes de travaux, gestes sous mandat), lus dans le journal des effets, et leur ANNULATION honnête :
 * annulé / compensé / impossible (+ pourquoi), effet par effet ; pour un lot, geste par geste.
 *
 * L'identité vient de la session (`porte`) ; seule la personne au nom de qui l'assistant a agi — ou le Super Admin —
 * défait un geste. Une annulation n'est pas un geste de l'assistant : il ne l'appelle jamais (surface hors assistant).
 */

export async function listerGestesAssistant(tous = false): Promise<{ ok: true; gestes: GesteListe[] } | { ok: false; error: string }> {
  const p = await porte(false);
  if (!p.ok) return { ok: false, error: p.erreur };
  return { ok: true, gestes: await gestesDeLAssistant(p.user, { tous: tous === true }) };
}

/** Ce que l'annulation ferait — RIEN n'est écrit : la personne le lit avant de cliquer. */
export async function apercevoirAnnulation(gesteId: string): Promise<{ ok: true; plan: CompteRenduAnnulation } | { ok: false; error: string }> {
  const p = await porte(false);
  if (!p.ok) return { ok: false, error: p.erreur };
  if (typeof gesteId !== "string" || !gesteId) return { ok: false, error: "Geste introuvable." };
  const r = await planDAnnulation(gesteId, p.user);
  return "refus" in r ? { ok: false, error: r.refus } : { ok: true, plan: r };
}

/** Annule UN geste ou un LOT — chaque geste rend son compte rendu, jamais un « annulé » global. */
export async function annulerGestesAssistant(gesteIds: string[]): Promise<{ ok: true; comptes: (CompteRenduAnnulation | { gesteId: string; refus: string })[] } | { ok: false; error: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, error: p.erreur };
  const ids = Array.isArray(gesteIds) ? [...new Set(gesteIds.filter((x) => typeof x === "string" && x))].slice(0, 50) : [];
  if (!ids.length) return { ok: false, error: "Aucun geste choisi." };
  const comptes: (CompteRenduAnnulation | { gesteId: string; refus: string })[] = [];
  for (const id of ids) {
    const r = await annulerGeste(id, p.user);
    comptes.push("refus" in r ? { gesteId: id, refus: r.refus } : r);
  }
  return { ok: true, comptes };
}
