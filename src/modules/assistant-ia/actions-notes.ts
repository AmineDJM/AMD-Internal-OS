"use server";

import { porte } from "./infra/porte-actions";
import {
  creerPage, ecrirePage, lireCorbeille, lirePage, listerPages, listerVersions, lireVersion, oublier, renommerPage, reordonnerPages,
  restaurerLigne, restaurerPage, restaurerVersion, supprimerPage, type Corbeille, type PageNotes, type ResumePage, type VersionNotes,
} from "./infra/notes/pages";
import { accepter, annuler, propositionsDuPanneau, refuser, toutAccepter, type PropositionNote } from "./infra/notes/propositions";
import type { BlocNote } from "./domaine/notes/blocs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES GESTES DE LA PERSONNE (décision 0026), clé `assistant-ia-notes-actions`.
 *
 * Écrire, nommer, réordonner, supprimer ses pages ; l'historique et la corbeille ; accepter, refuser, tout accepter,
 * annuler ce que l'assistant a PROPOSÉ. L'identité vient TOUJOURS de la session (`porte`) ; aucune action ne prend
 * un compte en paramètre. La porte est celle d'une ÉCRITURE même pour lire : en « Vue exacte », un Super Admin qui
 * visualise l'OS comme quelqu'un ne lit pas ses notes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const id = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const INTROUVABLE = { ok: false as const, erreur: "Introuvable." };

export interface EtatMesNotes {
  ok: boolean;
  erreur?: string;
  pages?: ResumePage[];
  page?: PageNotes | null;
  propositions?: PropositionNote[];
}

/** LE PANNEAU : les pages, la page ouverte (la première par défaut), les propositions de l'assistant. */
export async function etatMesNotes(pageId?: string): Promise<EtatMesNotes> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pages = await listerPages(p.user.id);
  const voulue = id(pageId) && pages.some((x) => x.id === pageId) ? pageId! : pages[0].id;
  const [page, propositions] = await Promise.all([lirePage(p.user.id, voulue), propositionsDuPanneau(p.user.id)]);
  return { ok: true, pages, page, propositions };
}

/**
 * L'ENREGISTREMENT AUTOMATIQUE : la page (ses blocs en JSON — une valeur simple pour le contrat des actions), avec la
 * version lue ; un conflit rend la page à jour. Les blocs sont rebornés par `normaliserBlocs`.
 */
export async function enregistrerMaPage(pageId: string, version: number, blocsJson: string): Promise<{ ok: boolean; erreur?: string; page?: PageNotes; conflit?: PageNotes }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pid = id(pageId);
  if (!pid || !Number.isInteger(version) || typeof blocsJson !== "string" || blocsJson.length > 2_000_000) return INTROUVABLE;
  let blocs: unknown;
  try { blocs = JSON.parse(blocsJson); } catch { return { ok: false, erreur: "Contenu illisible." }; }
  return ecrirePage(p.user.id, pid, version, blocs);
}

export async function creerMaPage(titre: string): Promise<{ ok: boolean; erreur?: string; page?: PageNotes }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  return creerPage(p.user.id, titre);
}

export async function renommerMaPage(pageId: string, titre: string): Promise<{ ok: boolean; erreur?: string; page?: PageNotes }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pid = id(pageId);
  return pid ? renommerPage(p.user.id, pid, titre) : INTROUVABLE;
}

export async function reordonnerMesPages(ids: string[]): Promise<{ ok: boolean; erreur?: string; pages?: ResumePage[] }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const propres = (Array.isArray(ids) ? ids : []).map(id).filter((x): x is string => !!x).slice(0, 100);
  return { ok: true, pages: await reordonnerPages(p.user.id, propres) };
}

export async function supprimerMaPage(pageId: string): Promise<{ ok: boolean; erreur?: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pid = id(pageId);
  return pid && (await supprimerPage(p.user.id, pid)) ? { ok: true } : INTROUVABLE;
}

export async function versionsDeMaPage(pageId: string): Promise<{ ok: boolean; erreur?: string; versions?: VersionNotes[] }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pid = id(pageId);
  return pid ? { ok: true, versions: await listerVersions(p.user.id, pid) } : INTROUVABLE;
}

export async function lireMaVersion(versionId: string): Promise<{ ok: boolean; erreur?: string; titre?: string; blocs?: BlocNote[] }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const v = id(versionId) ? await lireVersion(p.user.id, versionId) : null;
  return v ? { ok: true, titre: v.titre, blocs: v.blocs } : INTROUVABLE;
}

export async function restaurerMaVersion(versionId: string): Promise<{ ok: boolean; erreur?: string; page?: PageNotes }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const vid = id(versionId);
  return vid ? restaurerVersion(p.user.id, vid) : INTROUVABLE;
}

export async function maCorbeille(): Promise<{ ok: boolean; erreur?: string; corbeille?: Corbeille }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  return { ok: true, corbeille: await lireCorbeille(p.user.id) };
}

/** RESTAURER depuis la corbeille : une page (et son contenu), ou une ligne à son rang d'avant. */
export async function restaurerDeMaCorbeille(quoi: "page" | "ligne", elementId: string): Promise<{ ok: boolean; erreur?: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const eid = id(elementId);
  if (!eid) return INTROUVABLE;
  if (quoi === "page") return (await restaurerPage(p.user.id, eid)) ? { ok: true } : INTROUVABLE;
  const r = await restaurerLigne(p.user.id, eid);
  return r.ok ? { ok: true } : { ok: false, erreur: r.erreur };
}

export async function oublierDeMaCorbeille(quoi: "page" | "ligne", elementId: string): Promise<{ ok: boolean; erreur?: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const eid = id(elementId);
  return eid && (await oublier(p.user.id, quoi === "page" ? "page" : "ligne", eid)) ? { ok: true } : INTROUVABLE;
}

/** Le prélude d'une décision sur une proposition : la porte, et l'identifiant. */
async function surProposition<T extends { ok: boolean; erreur?: string }>(propositionId: string, decider: (userId: string, id: string) => Promise<T>): Promise<T | { ok: false; erreur: string }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const pid = id(propositionId);
  return pid ? decider(p.user.id, pid) : INTROUVABLE;
}

/** ACCEPTER une modification proposée par l'assistant — elle s'écrit maintenant, pas avant. */
export async function accepterPropositionNote(propositionId: string): Promise<{ ok: boolean; erreur?: string; acceptees?: string[] }> {
  return surProposition(propositionId, async (userId, pid) => {
    const r = await accepter(userId, pid);
    return r.ok ? { ok: true, acceptees: r.acceptees } : { ok: false, erreur: r.erreur };
  });
}

export async function refuserPropositionNote(propositionId: string): Promise<{ ok: boolean; erreur?: string; refusees?: string[] }> {
  return surProposition(propositionId, async (userId, pid) => {
    const r = await refuser(userId, pid);
    return r.ok ? { ok: true, refusees: r.refusees } : { ok: false, erreur: "Cette proposition n'est plus en attente." };
  });
}

/** TOUT ACCEPTER — les propositions données (celles d'une carte), ou toutes celles en attente. */
export async function toutAccepterNotes(ids?: string[]): Promise<{ ok: boolean; erreur?: string; acceptees?: string[]; echecs?: { id: string; erreur: string }[] }> {
  const p = await porte(true);
  if (!p.ok) return { ok: false, erreur: p.erreur };
  const propres = (Array.isArray(ids) ? ids : []).map(id).filter((x): x is string => !!x).slice(0, 100);
  const r = await toutAccepter(p.user.id, propres.length ? propres : undefined);
  return { ok: r.echecs.length === 0, acceptees: r.acceptees, echecs: r.echecs, ...(r.echecs.length ? { erreur: r.echecs[0].erreur } : {}) };
}

/** ANNULER une modification de l'assistant déjà acceptée (son inverse est rejoué). */
export async function annulerPropositionNote(propositionId: string): Promise<{ ok: boolean; erreur?: string }> {
  return surProposition(propositionId, annuler);
}
