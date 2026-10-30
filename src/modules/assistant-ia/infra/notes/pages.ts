import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  blocsSupprimes, compteCases, memesBlocs, nettoyerTitrePage, normaliserBlocs, PAGES_MAX, TITRE_PAGE_DEFAUT, type BlocNote,
} from "../../domaine/notes/blocs";
import { doitGarderVersion, joursRestants, limiteCorbeille, VERSIONS_MAX } from "../../domaine/notes/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES PAGES D'UNE PERSONNE (décision 0026).
 *
 * PRIVÉ, TENU ICI : chaque lecture et chaque écriture filtre sur `userId` — toujours celui de la SESSION (les actions
 * le prennent de la porte, jamais d'un paramètre ; les outils, de la personne du tour). Aucun écran d'administration,
 * aucune porte pour un autre compte, Super Admin compris ; la « Vue exacte » est refusée à la porte.
 *
 * L'enregistrement automatique part avec la VERSION lue (verrou optimiste) : deux onglets, ou une modification de
 * l'assistant acceptée entre-temps, ne s'écrasent pas — le second reçoit la page à jour. L'état d'AVANT est gardé
 * en version au plus toutes les 5 minutes de frappe, et toujours avant une modification de l'IA ; une ligne non
 * vide supprimée va à la corbeille (30 jours), une page aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PageNotes {
  id: string;
  titre: string;
  rang: number;
  blocs: BlocNote[];
  version: number;
  modifieeLe: string;
}

export interface ResumePage {
  id: string;
  titre: string;
  rang: number;
  cases: { total: number; faites: number };
}

type Ligne = { id: string; titre: string; rang: number; blocs: Prisma.JsonValue; version: number; updatedAt: Date };
const CHAMPS = { id: true, titre: true, rang: true, blocs: true, version: true, updatedAt: true } as const;

export const versPage = (p: Ligne): PageNotes =>
  ({ id: p.id, titre: p.titre, rang: p.rang, blocs: normaliserBlocs(p.blocs), version: p.version, modifieeLe: p.updatedAt.toISOString() });

const json = (blocs: BlocNote[]) => blocs as unknown as Prisma.InputJsonValue;

/** Un identifiant de page posé d'avance (une page PROPOSÉE par l'assistant a le sien avant d'exister). */
export const nouvelIdPage = (): string => `np${randomUUID().replace(/-/g, "").slice(0, 22)}`;

/**
 * LES PAGES de la personne, dans son ordre — la page « Mes notes » est créée au premier passage (et recréée si
 * toutes sont parties à la corbeille : on n'ouvre jamais un panneau vide de page).
 */
export async function listerPages(userId: string): Promise<ResumePage[]> {
  let pages = await prisma.assistantIaNotePage.findMany({
    where: { userId, supprimeeLe: null }, select: CHAMPS, orderBy: [{ rang: "asc" }, { createdAt: "asc" }],
  });
  if (!pages.length) {
    const p = await prisma.assistantIaNotePage.create({ data: { userId, titre: TITRE_PAGE_DEFAUT, rang: 0, blocs: [] }, select: CHAMPS });
    pages = [p];
  }
  return pages.map((p) => ({ id: p.id, titre: p.titre, rang: p.rang, cases: compteCases(normaliserBlocs(p.blocs)) }));
}

export async function lirePage(userId: string, pageId: string): Promise<PageNotes | null> {
  const p = await prisma.assistantIaNotePage.findFirst({ where: { id: pageId, userId, supprimeeLe: null }, select: CHAMPS });
  return p ? versPage(p) : null;
}

export type Resultat<T> = ({ ok: true } & T) | { ok: false; erreur: string };

/** CRÉER une page — `id` posé d'avance quand elle vient d'une proposition acceptée. */
export async function creerPage(userId: string, titre: unknown, id?: string): Promise<Resultat<{ page: PageNotes }>> {
  const t = nettoyerTitrePage(titre);
  if (!t) return { ok: false, erreur: "Donnez un nom à la page." };
  const n = await prisma.assistantIaNotePage.count({ where: { userId, supprimeeLe: null } });
  if (n >= PAGES_MAX) return { ok: false, erreur: `${PAGES_MAX} pages au plus : regroupez-en avant d'en créer une autre.` };
  const dernier = await prisma.assistantIaNotePage.aggregate({ where: { userId, supprimeeLe: null }, _max: { rang: true } });
  const p = await prisma.assistantIaNotePage.create({
    data: { ...(id ? { id } : {}), userId, titre: t, rang: (dernier._max.rang ?? -1) + 1, blocs: [] }, select: CHAMPS,
  });
  return { ok: true, page: versPage(p) };
}

export async function renommerPage(userId: string, pageId: string, titre: unknown): Promise<Resultat<{ page: PageNotes }>> {
  const t = nettoyerTitrePage(titre);
  if (!t) return { ok: false, erreur: "Donnez un nom à la page." };
  // ÉCRITURE CONDITIONNELLE (§118.151) : la page doit appartenir à CETTE personne.
  const r = await prisma.assistantIaNotePage.updateMany({ where: { id: pageId, userId, supprimeeLe: null }, data: { titre: t } });
  if (!r.count) return { ok: false, erreur: "Page introuvable." };
  const p = await lirePage(userId, pageId);
  return p ? { ok: true, page: p } : { ok: false, erreur: "Page introuvable." };
}

/** RÉORDONNER : les pages dans l'ordre donné ; une page d'un autre compte ou inconnue est ignorée. */
export async function reordonnerPages(userId: string, ids: readonly string[]): Promise<ResumePage[]> {
  const miennes = new Set((await prisma.assistantIaNotePage.findMany({ where: { userId, supprimeeLe: null }, select: { id: true } })).map((p) => p.id));
  const ordre = [...new Set(ids)].filter((id) => miennes.has(id));
  await prisma.$transaction(ordre.map((id, rang) => prisma.assistantIaNotePage.updateMany({ where: { id, userId }, data: { rang } })));
  return listerPages(userId);
}

/** SUPPRIMER une page : à la corbeille 30 jours ; ses propositions en attente n'ont plus d'objet. */
export async function supprimerPage(userId: string, pageId: string): Promise<boolean> {
  const r = await prisma.assistantIaNotePage.updateMany({ where: { id: pageId, userId, supprimeeLe: null }, data: { supprimeeLe: new Date() } });
  if (r.count) {
    await prisma.assistantIaNoteProposition.updateMany({ where: { userId, pageId, etat: "PROPOSEE" }, data: { etat: "PERIMEE", decideLe: new Date() } });
  }
  return r.count > 0;
}

export async function restaurerPage(userId: string, pageId: string): Promise<boolean> {
  const r = await prisma.assistantIaNotePage.updateMany({
    where: { id: pageId, userId, supprimeeLe: { gte: limiteCorbeille(new Date()) } }, data: { supprimeeLe: null },
  });
  return r.count > 0;
}

/** L'ÉTAT D'AVANT, gardé en version (et l'historique borné à `VERSIONS_MAX`). */
async function garderVersion(tx: Prisma.TransactionClient, userId: string, avant: Ligne, auteur: "PERSONNE" | "IA" | "RESTAURATION"): Promise<void> {
  const derniere = await tx.assistantIaNoteVersion.findFirst({ where: { pageId: avant.id, userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (!doitGarderVersion(derniere?.createdAt ?? null, new Date(), auteur)) return;
  await tx.assistantIaNoteVersion.create({ data: { pageId: avant.id, userId, version: avant.version, titre: avant.titre, blocs: avant.blocs as Prisma.InputJsonValue, auteur } });
  const anciennes = await tx.assistantIaNoteVersion.findMany({ where: { pageId: avant.id, userId }, orderBy: { createdAt: "desc" }, skip: VERSIONS_MAX, select: { id: true } });
  if (anciennes.length) await tx.assistantIaNoteVersion.deleteMany({ where: { id: { in: anciennes.map((v) => v.id) } } });
}

export type Enregistrement = { ok: true; page: PageNotes } | { ok: false; erreur: string; conflit?: PageNotes };

/**
 * ÉCRIRE une page : la version lue doit être la version en base (sinon CONFLIT — la page à jour est rendue, rien
 * n'est écrasé). L'état d'avant en version si besoin, les lignes non vides disparues à la corbeille.
 */
export interface OptionsEcriture {
  auteur?: "PERSONNE" | "IA" | "RESTAURATION";
  /** Dans la transaction d'une proposition acceptée (elle et la page s'écrivent ensemble). */
  tx?: Prisma.TransactionClient;
  /** Faux pour « Annuler » une ligne ajoutée par l'assistant : elle n'a rien à faire à la corbeille. */
  corbeille?: boolean;
}

export async function ecrirePage(userId: string, pageId: string, baseVersion: number, blocsBruts: unknown, o: OptionsEcriture = {}): Promise<Enregistrement> {
  const auteur = o.auteur ?? "PERSONNE";
  const faire = async (t: Prisma.TransactionClient): Promise<Enregistrement> => {
    const avant = await t.assistantIaNotePage.findFirst({ where: { id: pageId, userId, supprimeeLe: null }, select: CHAMPS });
    if (!avant) return { ok: false, erreur: "Page introuvable." };
    if (avant.version !== baseVersion) return { ok: false, erreur: "La page a changé entre-temps.", conflit: versPage(avant) };
    const blocsAvant = normaliserBlocs(avant.blocs);
    const blocs = normaliserBlocs(blocsBruts);
    if (memesBlocs(blocsAvant, blocs)) return { ok: true, page: versPage(avant) };
    await garderVersion(t, userId, avant, auteur);
    const partis = o.corbeille === false ? [] : blocsSupprimes(blocsAvant, blocs);
    if (partis.length) {
      await t.assistantIaNoteCorbeille.createMany({ data: partis.map((x) => ({ userId, pageId, bloc: x.bloc as unknown as Prisma.InputJsonValue, position: x.position })) });
    }
    const r = await t.assistantIaNotePage.updateMany({ where: { id: pageId, userId, version: baseVersion }, data: { blocs: json(blocs), version: { increment: 1 } } });
    if (!r.count) {
      const maintenant = await t.assistantIaNotePage.findFirst({ where: { id: pageId, userId }, select: CHAMPS });
      return { ok: false, erreur: "La page a changé entre-temps.", ...(maintenant ? { conflit: versPage(maintenant) } : {}) };
    }
    const apres = await t.assistantIaNotePage.findFirstOrThrow({ where: { id: pageId, userId }, select: CHAMPS });
    return { ok: true, page: versPage(apres) };
  };
  return o.tx ? faire(o.tx) : prisma.$transaction(faire);
}

export interface VersionNotes {
  id: string;
  version: number;
  auteur: string;
  creeLe: string;
  lignes: number;
  apercu: string;
}

export async function listerVersions(userId: string, pageId: string): Promise<VersionNotes[]> {
  const vs = await prisma.assistantIaNoteVersion.findMany({
    where: { pageId, userId }, orderBy: { createdAt: "desc" }, take: VERSIONS_MAX,
    select: { id: true, version: true, auteur: true, createdAt: true, blocs: true },
  });
  return vs.map((v) => {
    const blocs = normaliserBlocs(v.blocs);
    return {
      id: v.id, version: v.version, auteur: v.auteur, creeLe: v.createdAt.toISOString(), lignes: blocs.length,
      apercu: blocs.map((b) => b.texte).filter(Boolean).slice(0, 3).join(" · ").slice(0, 140),
    };
  });
}

export async function lireVersion(userId: string, versionId: string): Promise<{ titre: string; blocs: BlocNote[]; pageId: string } | null> {
  const v = await prisma.assistantIaNoteVersion.findFirst({ where: { id: versionId, userId }, select: { titre: true, blocs: true, pageId: true } });
  return v ? { titre: v.titre, blocs: normaliserBlocs(v.blocs), pageId: v.pageId } : null;
}

/** RESTAURER une version : la page reprend ce contenu — l'état présent est gardé en version d'abord (rien ne se perd). */
export async function restaurerVersion(userId: string, versionId: string): Promise<Enregistrement> {
  const v = await lireVersion(userId, versionId);
  if (!v) return { ok: false, erreur: "Version introuvable." };
  const p = await lirePage(userId, v.pageId);
  if (!p) return { ok: false, erreur: "La page n'existe plus (restaurez-la d'abord depuis la corbeille)." };
  return ecrirePage(userId, p.id, p.version, v.blocs, { auteur: "RESTAURATION" });
}

export interface Corbeille {
  pages: { id: string; titre: string; supprimeeLe: string; joursRestants: number; lignes: number }[];
  lignes: { id: string; pageId: string; page: string; texte: string; supprimeLe: string; joursRestants: number }[];
}

/** LA CORBEILLE (30 jours) : ce qui a passé le délai est oublié au passage — supprimé pour de bon. */
export async function lireCorbeille(userId: string): Promise<Corbeille> {
  const maintenant = new Date();
  const limite = limiteCorbeille(maintenant);
  const perimees = await prisma.assistantIaNotePage.findMany({ where: { userId, supprimeeLe: { lt: limite } }, select: { id: true } });
  if (perimees.length) {
    const ids = perimees.map((p) => p.id);
    await prisma.$transaction([
      prisma.assistantIaNoteVersion.deleteMany({ where: { userId, pageId: { in: ids } } }),
      prisma.assistantIaNoteCorbeille.deleteMany({ where: { userId, pageId: { in: ids } } }),
      prisma.assistantIaNotePage.deleteMany({ where: { userId, id: { in: ids } } }),
    ]);
  }
  await prisma.assistantIaNoteCorbeille.deleteMany({ where: { userId, supprimeLe: { lt: limite } } });
  const [pages, lignes, titres] = await Promise.all([
    prisma.assistantIaNotePage.findMany({ where: { userId, supprimeeLe: { not: null } }, orderBy: { supprimeeLe: "desc" }, select: { id: true, titre: true, supprimeeLe: true, blocs: true } }),
    prisma.assistantIaNoteCorbeille.findMany({ where: { userId }, orderBy: { supprimeLe: "desc" }, take: 200 }),
    prisma.assistantIaNotePage.findMany({ where: { userId }, select: { id: true, titre: true, supprimeeLe: true } }),
  ]);
  const titreDe = new Map(titres.map((p) => [p.id, p]));
  return {
    pages: pages.map((p) => ({
      id: p.id, titre: p.titre, supprimeeLe: p.supprimeeLe!.toISOString(), joursRestants: joursRestants(p.supprimeeLe!, maintenant), lignes: normaliserBlocs(p.blocs).length,
    })),
    // Une ligne d'une page elle-même à la corbeille revient avec la page : elle n'est pas listée à part.
    lignes: lignes.filter((l) => titreDe.get(l.pageId) && !titreDe.get(l.pageId)!.supprimeeLe).map((l) => ({
      id: l.id, pageId: l.pageId, page: titreDe.get(l.pageId)!.titre, texte: normaliserBlocs([l.bloc])[0]?.texte ?? "",
      supprimeLe: l.supprimeLe.toISOString(), joursRestants: joursRestants(l.supprimeLe, maintenant),
    })),
  };
}

/** RESTAURER une ligne : à son rang d'avant (borné), avec un identifiant neuf si l'ancien est repris. */
export async function restaurerLigne(userId: string, corbeilleId: string): Promise<Enregistrement> {
  const l = await prisma.assistantIaNoteCorbeille.findFirst({ where: { id: corbeilleId, userId } });
  if (!l) return { ok: false, erreur: "Élément introuvable dans la corbeille." };
  const p = await lirePage(userId, l.pageId);
  if (!p) return { ok: false, erreur: "La page de cette ligne n'existe plus." };
  const [bloc] = normaliserBlocs([l.bloc]);
  if (!bloc) return { ok: false, erreur: "Élément illisible." };
  const pose = p.blocs.some((b) => b.id === bloc.id) ? normaliserBlocs([...p.blocs, { ...bloc, id: "" }]).slice(-1)[0] : bloc;
  const k = Math.min(l.position, p.blocs.length);
  const r = await ecrirePage(userId, p.id, p.version, [...p.blocs.slice(0, k), { ...pose, niveau: k ? pose.niveau : 0 }, ...p.blocs.slice(k)]);
  if (r.ok) await prisma.assistantIaNoteCorbeille.deleteMany({ where: { id: l.id, userId } });
  return r;
}

/** OUBLIER un élément de la corbeille tout de suite (une ligne, ou une page et son historique). */
export async function oublier(userId: string, quoi: "page" | "ligne", id: string): Promise<boolean> {
  if (quoi === "ligne") return (await prisma.assistantIaNoteCorbeille.deleteMany({ where: { id, userId } })).count > 0;
  const page = await prisma.assistantIaNotePage.findFirst({ where: { id, userId, supprimeeLe: { not: null } }, select: { id: true } });
  if (!page) return false;
  await prisma.$transaction([
    prisma.assistantIaNoteVersion.deleteMany({ where: { userId, pageId: id } }),
    prisma.assistantIaNoteCorbeille.deleteMany({ where: { userId, pageId: id } }),
    prisma.assistantIaNoteProposition.deleteMany({ where: { userId, pageId: id } }),
    prisma.assistantIaNotePage.deleteMany({ where: { userId, id } }),
  ]);
  return true;
}
