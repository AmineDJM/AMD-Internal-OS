"use server";

import { requireUser, type CurrentUser } from "@/lib/session";
import { porte } from "./infra/porte-actions";
import {
  annulerEffetSortant, annulerGeste, effetsSortantsDe, gestesDeLAssistant, gestesDeLaFiche, gestesRecents, planDAnnulation, retablirEffetSortant, retablirGeste,
  type CompteRenduAnnulation, type EffetSortantVu, type GesteEcranVu, type GesteListe, type IssueEffetSortant,
} from "@/platform/ia/hors-requete";

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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LA BARRE « ANNULER » DE L'ERP (K10b, décision 0040) — pour TOUT le monde, pas seulement l'Assistant IA : le geste
// d'écran réversible qu'on vient de faire (« Annuler »), l'envoi qui attend sa fenêtre (« Annuler l'envoi »), et le
// rétablissement d'une annulation. Identité prise de la session, jamais d'un paramètre ; en « Vue exacte », lecture seule.
// ═══════════════════════════════════════════════════════════════════════════════════════════

type Refus = { ok: false; error: string };
async function personne(ecriture: boolean): Promise<{ ok: true; user: CurrentUser } | Refus> {
  const user = await requireUser();
  if (ecriture && (user.impersonatedBy || user.visualise)) return { ok: false, error: "Indisponible en « Vue exacte »." };
  return { ok: true, user };
}
const idValide = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length < 64;

/** Ce que la barre montre : les gestes réversibles des dernières minutes, et les envois en fenêtre (ou récents). */
export async function mesGestesEtEnvoisRecents(): Promise<{ ok: true; gestes: GesteEcranVu[]; envois: EffetSortantVu[]; maintenant: string } | Refus> {
  const p = await personne(false);
  if (!p.ok) return p;
  const [gestes, envois] = await Promise.all([gestesRecents(p.user), effetsSortantsDe(p.user, { depuisMinutes: 10 })]);
  return { ok: true, gestes, envois, maintenant: new Date().toISOString() };
}

/** L'historique d'une fiche : les gestes journalisés qui l'ont touchée, et ses envois. */
export async function historiqueDeLaFiche(modele: string, id: string): Promise<{ ok: true; gestes: GesteEcranVu[]; envois: EffetSortantVu[] } | Refus> {
  const p = await personne(false);
  if (!p.ok) return p;
  if (!idValide(modele) || !idValide(id)) return { ok: false, error: "Fiche introuvable." };
  const [gestes, envois] = await Promise.all([gestesDeLaFiche(p.user, modele, id), effetsSortantsDe(p.user, { objet: { modele, id } })]);
  return { ok: true, gestes, envois };
}

/** « Annuler » — le geste d'écran (ou de carte) de la personne, effet par effet. */
export async function annulerMonGeste(gesteId: string): Promise<{ ok: true; compte: CompteRenduAnnulation } | Refus> {
  const p = await personne(true);
  if (!p.ok) return p;
  if (!idValide(gesteId)) return { ok: false, error: "Geste introuvable." };
  const r = await annulerGeste(gesteId, p.user);
  return "refus" in r ? { ok: false, error: r.refus } : { ok: true, compte: r };
}

/** « Rétablir » — l'annulation s'annule : ce qu'elle avait défait est refait (sauf ce qui a bougé depuis, dit). */
export async function retablirMonGeste(gesteId: string): Promise<{ ok: true; compte: CompteRenduAnnulation } | Refus> {
  const p = await personne(true);
  if (!p.ok) return p;
  if (!idValide(gesteId)) return { ok: false, error: "Geste introuvable." };
  const r = await retablirGeste(gesteId, p.user);
  return "refus" in r ? { ok: false, error: r.refus } : { ok: true, compte: r };
}

/** « Annuler l'envoi » (dans la fenêtre : rien ne part) ; « Rétablir l'envoi » (il repart pour une fenêtre neuve). */
export async function agirSurMonEnvoi(id: string, geste: "annuler" | "retablir"): Promise<{ ok: true; issue: IssueEffetSortant } | Refus> {
  const p = await personne(true);
  if (!p.ok) return p;
  if (!idValide(id) || (geste !== "annuler" && geste !== "retablir")) return { ok: false, error: "Envoi introuvable." };
  // P1 : le mail d'Adam garde son intention d'envoi juste (annulée / rétablie) — son exécuteur est armé ici.
  (await import("./infra/operations/envoi-gmail")).enregistrerExecuteurGmail();
  const issue = geste === "annuler" ? await annulerEffetSortant(id, p.user) : await retablirEffetSortant(id, p.user);
  return { ok: true, issue };
}
