"use server";

import { revalidatePath } from "next/cache";
import type { CurrentUser } from "@/lib/session";
import { porte } from "./infra/porte-actions";
import type { VueArtefact, VueContenu } from "@/platform/ia/artifact/view-types";
import {
  comparerAtelier, documentSensible, type Comparatif, droitsSurDocument, enregistrerAtelier, fermerOnglet, ouvrirDansAtelier, revoirModification,
  toutAccepter, vueAtelier, type Droits,
} from "@/platform/ia/artifact/atelier/service";
import { conversionsPossibles, demanderConversion, LIBELLE_VOIE, type DemandeConversion, type VersFormat } from "@/platform/ia/artifact/atelier/conversions";
import { annulerDocument, retablirDocument } from "@/platform/ia/artifact/office";
import { carteEnregistrement } from "./infra/operations/atelier-enregistrer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE L'ATELIER (J3, décision 0017) — ce que le doigt de la personne déclenche, sans modèle.
 *
 * Ouvrir un document dans un onglet, relire sa vue, accepter / refuser / remettre à revoir une modification,
 * annuler / rétablir, ENREGISTRER (une nouvelle version, jamais un écrasement ; une carte de confirmation si
 * le document est rattaché à un objet métier), comparer avant / après, convertir, fermer un onglet.
 *
 * La porte est celle des autres actions du module (`infra/porte-actions.ts`) ; le moteur ne lit une session que si
 * son `userId` correspond ; les droits du Drive sont relus à l'ouverture, à chaque modification et à l'enregistrement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const id = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

/** La porte ET l'onglet désigné — le prélude de chaque geste sur un onglet. */
async function surOnglet(sessionId: unknown, ecriture = true): Promise<{ ok: true; user: CurrentUser; s: string } | { ok: false; erreur: string }> {
  const p = await porte(ecriture);
  if (!p.ok) return p;
  const s = id(sessionId);
  return s ? { ok: true, user: p.user, s } : { ok: false, erreur: "Onglet introuvable." };
}

export interface OngletOuvert {
  ok: boolean;
  erreur?: string;
  vue?: VueArtefact;
  droits?: Droits;
  sensible?: string | null;
  conversions?: VersFormat[];
  candidats?: { nodeId: string; nom: string; format: string }[];
}

async function decorer(user: CurrentUser, vue: VueArtefact, droits?: Droits): Promise<OngletOuvert> {
  return {
    ok: true, vue,
    droits: droits ?? (await droitsSurDocument(user.id, vue.nodeId)),
    sensible: await documentSensible(vue.nodeId),
    conversions: conversionsPossibles(vue.format),
  };
}

/** OUVRE un fichier du Drive dans un onglet de l'Atelier — mêmes droits qu'à l'ouverture du fichier. */
export async function ouvrirDansLAtelier(nodeId: string): Promise<OngletOuvert> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const n = id(nodeId);
  if (!n) return { ok: false, erreur: "Document introuvable." };
  const r = await ouvrirDansAtelier(p.user, { nodeId: n });
  if (!r.ok || !r.vue) return { ok: false, erreur: r.motif ?? "Ce document n'existe pas, ou vous n'y avez pas accès.", candidats: r.candidats };
  return decorer(p.user, r.vue, r.droits);
}

/** RELIT un onglet — la vue courante (base + modifications rejouées), ses droits, ses conversions. */
export async function relireOnglet(sessionId: string): Promise<OngletOuvert> {
  const p = await porte(false);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const s = id(sessionId);
  const vue = s ? await vueAtelier(p.user, s) : null;
  if (!vue) return { ok: false, erreur: "Cet onglet n'existe plus." };
  return decorer(p.user, vue);
}

/** ACCEPTER / REFUSER / remettre À REVOIR une modification (comme le suivi des modifications). */
export async function revoirModificationAtelier(sessionId: string, seq: number, decision: "ACCEPTER" | "REFUSER" | "A_REVOIR"): Promise<{ ok: boolean; erreur?: string; vue?: VueArtefact; message?: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const s = id(sessionId);
  if (!s || !Number.isInteger(seq) || !["ACCEPTER", "REFUSER", "A_REVOIR"].includes(decision)) return { ok: false, erreur: "Demande illisible." };
  const r = await revoirModification(p.user, s, seq, decision);
  return r.ok && r.vue ? { ok: true, vue: r.vue, message: r.effets[0]?.resume } : { ok: false, erreur: r.motif ?? "La revue a échoué." };
}

export async function toutAccepterAtelier(sessionId: string): Promise<{ ok: boolean; erreur?: string; vue?: VueArtefact }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const s = id(sessionId);
  const vue = s ? await toutAccepter(p.user, s) : null;
  return vue ? { ok: true, vue } : { ok: false, erreur: "Cet onglet n'existe plus." };
}

export async function annulerDansAtelier(sessionId: string, sens: "annuler" | "retablir"): Promise<{ ok: boolean; erreur?: string; vue?: VueArtefact; message?: string }> {
  const o = await surOnglet(sessionId);
  if (!o.ok) return o;
  const r = sens === "annuler" ? await annulerDocument(o.user, o.s) : await retablirDocument(o.user, o.s);
  return r.ok && r.vue ? { ok: true, vue: r.vue, message: r.effets[0]?.resume } : { ok: false, erreur: r.motif ?? "Rien à faire." };
}

export type ResultatEnregistrement =
  | { ok: true; version: number | null; nodeId: string | null; vue: VueArtefact | null; message: string }
  | { ok: false; erreur: string }
  | { ok: false; carte: { id: string; kind: string; title: string; fields: { label: string; value: string }[]; warnings?: string[]; libelleBouton?: string; status: "PROPOSED" } };

/**
 * ENREGISTRER — une NOUVELLE version Drive. Sur un document rattaché à un objet métier, le clic ne suffit pas :
 * une carte de confirmation est rendue (et confirmée par le geste habituel de l'Assistant IA).
 */
export async function enregistrerOnglet(sessionId: string, nouveauNom?: string): Promise<ResultatEnregistrement> {
  const o = await surOnglet(sessionId);
  if (!o.ok) return o;
  const { user, s } = o;
  const sousLeNom = typeof nouveauNom === "string" && nouveauNom.trim() ? nouveauNom.trim().slice(0, 180) : undefined;
  if (!sousLeNom) {
    const vue = await vueAtelier(user, s);
    if (!vue) return { ok: false, erreur: "Cet onglet n'existe plus." };
    if (vue.dirty && (await documentSensible(vue.nodeId))) {
      const c = await carteEnregistrement(user, s);
      return c.ok ? { ok: false, carte: c.intent } : { ok: false, erreur: c.erreur };
    }
  }
  const r = await enregistrerAtelier(user, s, { sousLeNom });
  if (!r.ok) return { ok: false, erreur: r.motif ?? "L'enregistrement a échoué." };
  revalidatePath("/drive");
  return { ok: true, version: r.version, nodeId: r.nodeId, vue: r.vue, message: r.motif ?? (sousLeNom ? `Copie enregistrée : « ${sousLeNom} ».` : `Nouvelle version ${r.version} enregistrée — la précédente reste ouvrable.`) };
}

/** COMPARER avant / après — la version d'origine et l'état courant, et ce qui diffère réellement. */
export async function comparerOnglet(sessionId: string): Promise<{ ok: boolean; erreur?: string; avant?: VueContenu | null; apres?: VueContenu | null; comparaison?: Comparatif["comparaison"]; versionAvant?: number | null }> {
  const o = await surOnglet(sessionId, false);
  if (!o.ok) return o;
  const r = await comparerAtelier(o.user, o.s);
  return r.ok ? { ok: true, avant: r.avant, apres: r.apres, comparaison: r.comparaison, versionAvant: r.versionAvant } : { ok: false, erreur: r.motif ?? "Comparaison impossible." };
}

/** CONVERTIR — la dernière version enregistrée, vers un nouveau fichier ; la voie est rendue et affichée. */
export async function convertirDansAtelier(nodeId: string, vers: string, sessionId?: string): Promise<DemandeConversion & { libelleVoie: string | null }> {
  const p = await porte(true);
  const vide = { id: null, voie: null, etat: null, resultat: null, note: null, libelleVoie: null };
  if (!p.ok) return { ok: false, motif: p.erreur, ...vide };
  const n = id(nodeId);
  if (!n || !["PDF", "XLSX", "DOCX", "IMAGES"].includes(vers)) return { ok: false, motif: "Demande illisible.", ...vide };
  const r = await demanderConversion(p.user, n, vers as VersFormat, id(sessionId) ?? null);
  if (r.ok) revalidatePath("/drive");
  return { ...r, libelleVoie: r.voie ? LIBELLE_VOIE[r.voie] : null };
}

export async function fermerOngletAtelier(sessionId: string): Promise<{ ok: boolean; erreur?: string }> {
  const o = await surOnglet(sessionId);
  if (!o.ok) return o;
  const r = await fermerOnglet(o.user, o.s);
  return r.ok ? { ok: true } : { ok: false, erreur: r.motif ?? "Fermeture impossible." };
}
