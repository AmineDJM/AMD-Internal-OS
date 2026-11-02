import { prisma } from "@/lib/prisma";
import { ditQuiEstLaPersonne, REFUS_IDENTITE } from "@/platform/ia/memoire-identite";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import {
  estSorteMemoire, MEMOIRE_MAX_CARACTERES, MEMOIRE_MAX_ELEMENTS,
  type ElementMemoire, type OrigineMemoire, type SorteMemoire,
} from "../domaine/memoire-ui";
import { SEUIL_DOUBLON, similarite } from "../domaine/memoire/capture";
import { DUREE_HISTORIQUE_MS, jetonsStockes } from "../domaine/memoire/consolidation";

export * from "../domaine/memoire-ui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — ce que l'assistant retient de LA personne.
 *
 * Sa vie (famille, études, voyages, goûts — M1, décision 0045), sa société, ses habitudes, ses raccourcis. Règles,
 * toutes tenues ICI :
 *
 *   • À ELLE SEULE. Chaque lecture et chaque écriture filtre sur `userId`, toujours celui de la SESSION (les actions
 *     serveur le prennent de `requireUser`, jamais d'un paramètre). Aucun autre compte — Super Admin compris — ne la lit.
 *   • VISIBLE ET RÉVERSIBLE. La capture automatique (`memoire-capture.ts`) écrit d'office ce que la personne dit d'elle,
 *     mais chaque ajout se voit (« Retenu : … (annuler) »), s'annule (`annulerSouvenir` : l'ancien revient s'il a été
 *     remplacé), se corrige et s'efface. L'effacement est réel (suppression, historique compris).
 *   • UN FAIT QUI CHANGE REMPLACE L'ANCIEN — l'ancien reste, inactif (`remplaceLe`), dans l'historique du souvenir.
 *   • RIEN DE SENSIBLE. Une rémunération, une coordonnée bancaire, un numéro de pièce d'identité n'y entrent pas : la
 *     mémoire est réinjectée au modèle (même filtre que le reste du contexte).
 *
 * Stockage : `AssistantMemoryItem` (scopé par personne), réglage `AssistantIaPreference.memoireAuto`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatMemoire = { ok: true; element: ElementMemoire; geste?: "ajoute" | "remplace" | "doublon" } | { ok: false; erreur: string };

export function nettoyerSouvenir(contenu: unknown): { ok: true; texte: string } | { ok: false; erreur: string } {
  const texte = typeof contenu === "string" ? contenu.replace(/\s+/g, " ").trim() : "";
  if (!texte) return { ok: false, erreur: "Rien à retenir." };
  if (texte.length > MEMOIRE_MAX_CARACTERES) return { ok: false, erreur: `Trop long : ${MEMOIRE_MAX_CARACTERES} caractères au plus.` };
  if (censurerTexte(texte).censure) {
    return { ok: false, erreur: "Une rémunération, une coordonnée bancaire ou un numéro de pièce d'identité ne se retient pas : ces données ne vont jamais à l'assistant." };
  }
  // S1 (décision 0048) : qui est la personne vient de son compte, jamais de sa mémoire — quelle que soit l'origine.
  if (ditQuiEstLaPersonne(texte)) return { ok: false, erreur: REFUS_IDENTITE };
  return { ok: true, texte };
}

const CHAMPS = { id: true, type: true, content: true, updatedAt: true, createdAt: true, origine: true, sourceThreadId: true, remplaceId: true } as const;
type Ligne = { id: string; type: string; content: string; updatedAt: Date; createdAt: Date; origine: string; sourceThreadId: string | null; remplaceId: string | null };

const versElement = (i: Ligne, extra: Partial<ElementMemoire> = {}): ElementMemoire => ({
  id: i.id, sorte: i.type, contenu: i.content, modifieLe: i.updatedAt.toISOString(),
  origine: i.origine, sourceLe: i.createdAt.toISOString(), ...extra,
});

/** La mémoire de la personne, avec l'origine de chaque souvenir (conversation, date) et son nombre de versions. */
export async function listerMemoire(userId: string): Promise<ElementMemoire[]> {
  const [items, anciens] = await Promise.all([
    prisma.assistantMemoryItem.findMany({ where: { userId, active: true }, select: CHAMPS, orderBy: { updatedAt: "desc" }, take: MEMOIRE_MAX_ELEMENTS }),
    prisma.assistantMemoryItem.findMany({ where: { userId, active: false, remplaceLe: { not: null } }, select: { id: true, remplaceId: true, consolideDans: true }, take: 2_000 }),
  ]);
  const precedent = new Map(anciens.map((a) => [a.id, a.remplaceId]));
  const versions = (id: string | null) => {
    let n = 0;
    for (let c = id; c && precedent.has(c) && n < 50; c = precedent.get(c) ?? null) n += 1;
    return n;
  };
  const ids = [...new Set(items.map((i) => i.sourceThreadId).filter((x): x is string => !!x))];
  // La conversation d'origine — SEULEMENT si elle est à la personne (et existe encore : une privée expirée disparaît).
  const fils = ids.length ? await prisma.assistantIaFil.findMany({ where: { id: { in: ids }, userId }, select: { id: true, titre: true } }) : [];
  const titres = new Map(fils.map((f) => [f.id, f.titre]));
  const repris = new Map<string, number>();
  for (const a of anciens) if (a.consolideDans) repris.set(a.consolideDans, (repris.get(a.consolideDans) ?? 0) + 1);
  return items.map((i) => versElement(i, {
    conversation: i.sourceThreadId && titres.has(i.sourceThreadId) ? { id: i.sourceThreadId, titre: titres.get(i.sourceThreadId) ?? null } : null,
    versionsAnterieures: versions(i.remplaceId) + (repris.get(i.id) ?? 0),
  }));
}

/** Ce que la mémoire ACTIVE de la personne occupe, en jetons (le compteur calibré du rappel). */
export async function jetonsDeLaMemoire(userId: string): Promise<number> {
  const items = await prisma.assistantMemoryItem.findMany({ where: { userId, active: true }, select: { content: true } });
  return jetonsStockes(items.map((i) => ({ contenu: i.content })));
}

export interface OptionsAjout {
  origine?: OrigineMemoire;
  sujet?: string | null;
  sourceThreadId?: string | null;
  sourceTourId?: string | null;
  /** L'id d'un souvenir ACTIF que celui-ci remplace (un fait qui a changé). */
  remplace?: string | null;
}

/**
 * RETENIR — à la main, sur confirmation d'une carte, ou par la capture automatique. Un doublon (même phrase, ou presque)
 * n'écrit rien ; un souvenir qui en REMPLACE un autre (désigné, ou de même `sujet`) le passe à l'historique.
 */
export async function ajouterMemoire(userId: string, contenu: unknown, sorte: unknown, o: OptionsAjout = {}): Promise<ResultatMemoire> {
  const n = nettoyerSouvenir(contenu);
  if (!n.ok) return { ok: false, erreur: n.erreur };
  const type: SorteMemoire = estSorteMemoire(sorte) ? sorte : "USER_PREFERENCE";
  const actifs = await prisma.assistantMemoryItem.findMany({ where: { userId, active: true }, select: { ...CHAMPS, sujet: true }, orderBy: { updatedAt: "desc" }, take: MEMOIRE_MAX_ELEMENTS });
  const cible = (o.remplace ? actifs.find((a) => a.id === o.remplace) : undefined)
    ?? (o.sujet ? actifs.find((a) => a.sujet === o.sujet) : undefined);
  // Un fait qui CHANGE ressemble à l'ancien (« le 12 » → « le 14 ») : seul un AUTRE souvenir presque identique est un doublon.
  const memePhrase = (a: { content: string }) => a.content.toLowerCase() === n.texte.toLowerCase();
  const doublon = actifs.find((a) => memePhrase(a) || (a.id !== cible?.id && similarite(a.content, n.texte) >= SEUIL_DOUBLON));
  if (doublon) return { ok: true, element: versElement(doublon), geste: "doublon" };
  if (!cible && actifs.length >= MEMOIRE_MAX_ELEMENTS) return { ok: false, erreur: `Mémoire pleine (${MEMOIRE_MAX_ELEMENTS} éléments) : effacez-en avant d'en ajouter.` };
  const cree = await prisma.$transaction(async (tx) => {
    if (cible) {
      // ÉCRITURE CONDITIONNELLE : l'ancien n'est remplacé que s'il est encore actif et à CETTE personne.
      const r = await tx.assistantMemoryItem.updateMany({ where: { id: cible.id, userId, active: true }, data: { active: false, remplaceLe: new Date() } });
      if (r.count === 0) return null;
    }
    return tx.assistantMemoryItem.create({
      data: {
        userId, type, content: n.texte, confidence: o.origine === "auto" || o.origine === "voix" ? 0.8 : 1,
        origine: o.origine ?? "manuel", sujet: o.sujet ?? cible?.sujet ?? null, remplaceId: cible?.id ?? null,
        sourceThreadId: o.sourceThreadId ?? null, sourceTourId: o.sourceTourId ?? null,
      },
      select: CHAMPS,
    });
  });
  if (!cree) return { ok: false, erreur: "Le souvenir à remplacer a changé entre-temps." };
  return { ok: true, element: versElement(cree), geste: cible ? "remplace" : "ajoute" };
}

export async function modifierMemoire(userId: string, id: string, contenu: unknown): Promise<ResultatMemoire> {
  const n = nettoyerSouvenir(contenu);
  if (!n.ok) return { ok: false, erreur: n.erreur };
  // ÉCRITURE CONDITIONNELLE (§118.151) : l'élément doit appartenir à CETTE personne. Le plongement est à refaire.
  const r = await prisma.assistantMemoryItem.updateMany({ where: { id, userId, active: true }, data: { content: n.texte, vecteur: [] } });
  if (r.count === 0) return { ok: false, erreur: "Élément introuvable." };
  const e = await prisma.assistantMemoryItem.findFirstOrThrow({ where: { id, userId }, select: CHAMPS });
  return { ok: true, element: versElement(e) };
}

/** Les ancêtres d'un souvenir (ce qu'il a remplacé, de proche en proche) — à la personne seulement. */
async function ancetres(userId: string, depuis: string | null): Promise<string[]> {
  const out: string[] = [];
  for (let c = depuis; c && out.length < 50;) {
    const a = await prisma.assistantMemoryItem.findFirst({ where: { id: c, userId, active: false }, select: { id: true, remplaceId: true } });
    if (!a) break;
    out.push(a.id);
    c = a.remplaceId;
  }
  return out;
}

/** Effacer, c'est supprimer : un souvenir effacé ne doit plus exister nulle part — son historique (remplacé, repris) non plus. */
export async function effacerMemoire(userId: string, id: string): Promise<boolean> {
  const e = await prisma.assistantMemoryItem.findFirst({ where: { id, userId }, select: { remplaceId: true } });
  if (!e) return false;
  const repris = await prisma.assistantMemoryItem.findMany({ where: { userId, consolideDans: id }, select: { id: true } });
  const r = await prisma.assistantMemoryItem.deleteMany({ where: { id: { in: [id, ...(await ancetres(userId, e.remplaceId)), ...repris.map((x) => x.id)] }, userId } });
  return r.count > 0;
}

/**
 * L'HISTORIQUE GARDÉ 12 MOIS (Direction, 01/11/2026) : un fait REMPLACÉ ou REPRIS par une consolidation est purgé un an
 * après ; un fait ACTIF ne l'est jamais par l'âge. Idempotent (tâche `assistant.memoire`).
 */
export async function purgerHistoriqueMemoire(maintenant = new Date()): Promise<{ purges: number }> {
  const limite = new Date(maintenant.getTime() - DUREE_HISTORIQUE_MS);
  const r = await prisma.assistantMemoryItem.deleteMany({ where: { active: false, remplaceLe: { not: null, lt: limite } } });
  return { purges: r.count };
}

export async function toutEffacerMemoire(userId: string): Promise<number> {
  const r = await prisma.assistantMemoryItem.deleteMany({ where: { userId } });
  return r.count;
}

/**
 * ANNULER UN SOUVENIR RETENU D'OFFICE (« Retenu : … (annuler) ») : il disparaît ; s'il remplaçait un fait, l'ancien
 * redevient actif — la mémoire est exactement celle d'avant le tour. Un souvenir déjà annulé l'est « sans objet ».
 * Un souvenir né d'une CONSOLIDATION s'annule de même : les faits qu'il avait repris redeviennent actifs.
 */
export async function annulerSouvenir(userId: string, id: string): Promise<{ ok: true; restaure: string | null } | { ok: false; erreur: string }> {
  const e = await prisma.assistantMemoryItem.findFirst({ where: { id, userId }, select: { id: true, active: true, remplaceId: true } });
  if (!e) return { ok: true, restaure: null };
  if (!e.active) return { ok: false, erreur: "Ce souvenir a déjà été remplacé : annulez le plus récent, ou corrigez-le dans « Ce qu'il retient »." };
  return prisma.$transaction(async (tx) => {
    await tx.assistantMemoryItem.deleteMany({ where: { id, userId } });
    const repris = await tx.assistantMemoryItem.updateMany({ where: { userId, consolideDans: id, active: false }, data: { active: true, remplaceLe: null, consolideDans: null } });
    if (repris.count) return { ok: true as const, restaure: null };
    if (!e.remplaceId) return { ok: true as const, restaure: null };
    const r = await tx.assistantMemoryItem.updateMany({ where: { id: e.remplaceId, userId, active: false }, data: { active: true, remplaceLe: null } });
    return { ok: true as const, restaure: r.count ? e.remplaceId : null };
  });
}

/** L'état présent de souvenirs retenus par un tour — la ligne de la conversation dit s'ils ont été annulés depuis. */
export async function souvenirsParIds(userId: string, ids: readonly string[]): Promise<Map<string, { contenu: string; sorte: string; actif: boolean; remplace: boolean }>> {
  if (!ids.length) return new Map();
  const items = await prisma.assistantMemoryItem.findMany({ where: { id: { in: [...ids] }, userId }, select: { id: true, content: true, type: true, active: true, remplaceId: true } });
  return new Map(items.map((i) => [i.id, { contenu: i.content, sorte: i.type, actif: i.active, remplace: !!i.remplaceId }]));
}

// ─────────────────────────────── Le réglage de la personne ───────────────────────────────

/** « Mémoire automatique » : oui par défaut (la Direction veut qu'il retienne) — la personne peut la couper. */
export async function memoireAutoActive(userId: string): Promise<boolean> {
  const p = await prisma.assistantIaPreference.findUnique({ where: { userId }, select: { memoireAuto: true } });
  return p?.memoireAuto !== false;
}

export async function reglerMemoireAuto(userId: string, active: boolean): Promise<void> {
  await prisma.assistantIaPreference.upsert({ where: { userId }, create: { userId, memoireAuto: active }, update: { memoireAuto: active } });
}

/** Ce que le contexte du modèle reçoit : les souvenirs de la personne, du plus récent au plus ancien. */
export async function memoirePourContexte(userId: string, limite = MEMOIRE_MAX_ELEMENTS): Promise<{ id: string; sorte: string; contenu: string; vecteur: number[] }[]> {
  const items = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true },
    select: { id: true, type: true, content: true, vecteur: true },
    orderBy: { updatedAt: "desc" },
    take: limite,
  });
  // Un souvenir ANCIEN qui dirait qui elle est (« Prénom : Amine », retenu avant la garde) ne se relit plus.
  return items.filter((i) => !ditQuiEstLaPersonne(i.content)).map((i) => ({ id: i.id, sorte: i.type, contenu: i.content, vecteur: i.vecteur }));
}
