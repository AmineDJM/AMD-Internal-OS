"use server";

import { requireUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import {
  ajouterMemoire, effacerMemoire, listerMemoire, modifierMemoire, toutEffacerMemoire,
  type ElementMemoire,
} from "@/lib/agent/memoire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — les gestes de la personne sur SA mémoire.
 *
 * Voir, retenir (après une proposition de l'assistant, ou à la main), corriger, effacer, tout
 * effacer. L'identité vient TOUJOURS de la session (`requireUser`) — jamais d'un paramètre : une
 * action serveur peut être appelée hors de l'écran, et un `userId` reçu permettrait d'écrire dans
 * la mémoire d'un collègue (§118.153). Indisponible en « Vue exacte » : on ne modifie pas la
 * mémoire de quelqu'un en se mettant à sa place.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Porte = { ok: true; user: CurrentUser } | { ok: false; erreur: string };

async function porte(ecriture: boolean): Promise<Porte> {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) return { ok: false, erreur: REFUS_ASSISTANT_IA };
  if (ecriture && (user.impersonatedBy || user.visualise)) return { ok: false, erreur: "Indisponible en « Vue exacte »." };
  return { ok: true, user };
}

export async function listerMaMemoire(): Promise<{ ok: true; elements: ElementMemoire[] } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, elements: await listerMemoire(p.user.id) };
}

/** Retenir — le geste de CONFIRMATION d'une mémoire proposée, ou un ajout à la main. */
export async function retenirMemoire(contenu: string, sorte?: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  const r = await ajouterMemoire(p.user.id, contenu, sorte);
  return r.ok ? { ok: true as const, element: r.element } : { ok: false as const, erreur: r.erreur };
}

export async function corrigerMemoire(id: string, contenu: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Élément introuvable." };
  const r = await modifierMemoire(p.user.id, id, contenu);
  return r.ok ? { ok: true as const, element: r.element } : { ok: false as const, erreur: r.erreur };
}

export async function effacerElementMemoire(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Élément introuvable." };
  return (await effacerMemoire(p.user.id, id)) ? { ok: true as const } : { ok: false as const, erreur: "Élément introuvable." };
}

export async function effacerToutMaMemoire() {
  const p = await porte(true);
  if (!p.ok) return p;
  return { ok: true as const, effaces: await toutEffacerMemoire(p.user.id) };
}

// ─────────────────────────────── Les routines ───────────────────────────────
//
// Les gestes de la personne sur SES routines, depuis l'onglet « Routines » : les voir, lire un
// passage (il passe « lu »), mettre en pause, reprendre, supprimer, exécuter maintenant. La
// création passe par la conversation et sa carte. Identité de la session, jamais d'un paramètre.

export async function listerMesRoutines() {
  const p = await porte(false);
  if (!p.ok) return p;
  const { listerRoutines, passagesNonLus } = await import("@/lib/agent/routines/service");
  return { ok: true as const, routines: await listerRoutines(p.user.id), nonLus: await passagesNonLus(p.user.id) };
}

export async function lireMonPassage(runId: string) {
  const p = await porte(false);
  if (!p.ok) return p;
  if (typeof runId !== "string" || !runId) return { ok: false as const, erreur: "Passage introuvable." };
  const { lirePassage } = await import("@/lib/agent/routines/service");
  const passage = await lirePassage(p.user.id, runId);
  return passage ? { ok: true as const, passage: JSON.parse(JSON.stringify(passage)) as typeof passage } : { ok: false as const, erreur: "Passage introuvable." };
}

export async function basculerMaRoutine(id: string, statut: "ACTIVE" | "PAUSED") {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id || (statut !== "ACTIVE" && statut !== "PAUSED")) return { ok: false as const, erreur: "Routine introuvable." };
  const { changerStatut } = await import("@/lib/agent/routines/service");
  const r = await changerStatut(p.user.id, id, statut);
  return r.ok ? { ok: true as const } : { ok: false as const, erreur: r.erreur };
}

export async function supprimerMaRoutine(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Routine introuvable." };
  const { supprimerRoutine } = await import("@/lib/agent/routines/service");
  return (await supprimerRoutine(p.user.id, id)) ? { ok: true as const } : { ok: false as const, erreur: "Routine introuvable." };
}

export async function executerMaRoutine(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Routine introuvable." };
  const { executerMaintenant } = await import("@/lib/agent/routines/service");
  const r = await executerMaintenant(p.user.id, id);
  return r.ok ? { ok: true as const, statut: r.statut, runId: r.runId } : { ok: false as const, erreur: r.erreur };
}
