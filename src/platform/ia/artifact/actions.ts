"use server";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DU WORKSPACE — ce que le doigt de la personne déclenche, sans passer par un modèle.
 *
 * ── §30 : ZÉRO MODÈLE QUAND L'ACTION ENCODE DÉJÀ L'INTENTION ────────────────────────────
 *
 * Cliquer « Annuler » ne demande pas d'interpréter une phrase : l'intention est dans le bouton.
 * Ces actions vont donc DIRECTEMENT au moteur. Le modèle n'intervient que pour les phrases que
 * le décodeur direct ne reconnaît pas — et c'est ce qui rend l'édition instantanée.
 *
 * ── POURQUOI CES ACTIONS VIVENT DANS LE PONT ────────────────────────────────────────────
 *
 * Le workspace est un composant d'Adam ; le moteur est dans l'ERP. Écrire ces actions dans
 * `src/lib/actions/` obligeait le composant à importer l'ERP — cinq franchissements de plus, que
 * le cliquet a refusés, et il avait raison. Ce fichier est une COMPOSITION : il assemble la
 * session, les droits et le moteur. C'est exactement la définition du pont, comme
 * `in-process/missions/control.ts` à côté.
 *
 * ── LE CLOISONNEMENT ────────────────────────────────────────────────────────────────────
 *
 * `requireUser()` à chaque appel, et le moteur ne lit une session que si son `userId` correspond
 * (`magasin.lire` met l'identifiant dans le `where`, pas dans un test après coup). Une session
 * d'artefact n'est donc jamais visible d'une autre personne, même en devinant son identifiant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import type { VueArtefact } from "@/lib/artifact/render/view";
import {
  annulerDocument, editerDocument, fermerDocument, ouvrirDocument, phraseSurDocument,
  retablirDocument, sauvegarderDocument, viserDansDocument, vueDocument,
} from "./office";

export interface ReponseArtefact {
  ok: boolean;
  message: string;
  vue: VueArtefact | null;
  /** Renseigné quand plusieurs documents portent le nom demandé (§32). */
  candidats?: { nodeId: string; nom: string; format: string }[];
}

/** OUVRE un document — par identifiant Drive (clic) ou par nom (phrase). */
export async function ouvrirArtefact(
  cible: { nodeId?: string; nom?: string; threadId?: string | null },
): Promise<ReponseArtefact> {
  const user = await requireUser();
  const r = await ouvrirDocument(user, cible);
  return { ok: r.ok, message: r.motif ?? "", vue: r.vue, candidats: r.candidats };
}

/** APPLIQUE des commandes déjà compilées — le chemin des boutons et de la barre d'outils. */
export async function editerArtefact(
  sessionId: string, commandes: CommandeArtefact[], operationId?: string,
): Promise<ReponseArtefact> {
  const user = await requireUser();
  const r = await editerDocument(user, sessionId, commandes, operationId);
  const dits = r.effets.filter((e) => e.ok).map((e) => e.resume);
  const rates = r.effets.filter((e) => !e.ok).map((e) => e.motif).filter(Boolean);
  return {
    ok: r.ok,
    message: [dits.join(" "), rates.join(" ")].filter(Boolean).join(" — ") || (r.motif ?? ""),
    vue: r.vue,
  };
}

/**
 * TRAITE une phrase tapée dans la barre du workspace.
 *
 * Rend `ok: false` avec un message vide quand le décodeur ne reconnaît rien : c'est le signal
 * que la phrase doit partir dans la conversation d'Adam, où le modèle produira des commandes.
 * Le workspace ne fait donc jamais semblant de comprendre.
 */
export async function phraseArtefact(sessionId: string, phrase: string): Promise<ReponseArtefact & { aDeleguer: boolean }> {
  const user = await requireUser();
  const r = await phraseSurDocument(user, phrase, sessionId);
  return { ok: r.ok, message: r.message, vue: r.vue, aDeleguer: r.aDeleguer };
}

export async function annulerArtefact(sessionId: string): Promise<ReponseArtefact> {
  const user = await requireUser();
  const r = await annulerDocument(user, sessionId);
  return { ok: r.ok, message: r.ok ? (r.effets[0]?.resume ?? "Annulé.") : (r.motif ?? ""), vue: r.vue };
}

export async function retablirArtefact(sessionId: string): Promise<ReponseArtefact> {
  const user = await requireUser();
  const r = await retablirDocument(user, sessionId);
  return { ok: r.ok, message: r.ok ? (r.effets[0]?.resume ?? "Rétabli.") : (r.motif ?? ""), vue: r.vue };
}

/**
 * ENREGISTRE. §78 : « Sauvegarde » est une intention EXPLICITE — pas de « Êtes-vous sûr ? ».
 *
 * La seule question posée est celle qu'on ne peut pas trancher à la place de la personne : un
 * conflit de version (§50), où quelqu'un d'autre a écrit pendant qu'elle travaillait.
 */
export async function sauvegarderArtefact(
  sessionId: string, opts: { sousLeNom?: string; forcer?: boolean } = {},
): Promise<ReponseArtefact & { version: number | null; nodeId: string | null }> {
  const user = await requireUser();
  const r = await sauvegarderDocument(user, sessionId, opts);
  if (r.ok) revalidatePath("/drive");
  return {
    ok: r.ok,
    message: r.ok ? `Enregistré — version ${r.version}.` : (r.motif ?? "L'enregistrement a échoué."),
    vue: r.vue, version: r.version, nodeId: r.nodeId,
  };
}

/** MET À JOUR le working set : la page regardée, la diapo, la feuille, la sélection cliquée. */
export async function viserArtefact(
  sessionId: string,
  ou: { page?: number | null; diapo?: number | null; feuille?: string | null; selection?: string[] | null },
): Promise<ReponseArtefact> {
  const user = await requireUser();
  const r = await viserDansDocument(user, sessionId, ou);
  return { ok: r.ok, message: r.motif ?? "", vue: r.vue };
}

export async function fermerArtefact(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  const r = await fermerDocument(user, sessionId);
  return {
    ok: r.ok,
    message: r.perdues
      ? "Document fermé. Des modifications n'étaient pas enregistrées."
      : (r.motif ?? "Document fermé."),
  };
}

/** RELIT l'état d'une session — reprise après rechargement de page ou fermeture de l'app (§81). */
export async function relireArtefact(sessionId: string): Promise<ReponseArtefact> {
  const user = await requireUser();
  const vue = await vueDocument(user, sessionId);
  return { ok: Boolean(vue), message: vue ? "" : "Cette session n'existe plus.", vue };
}
