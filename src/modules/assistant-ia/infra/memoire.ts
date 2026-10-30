import { prisma } from "@/lib/prisma";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import {
  estSorteMemoire, MEMOIRE_MAX_CARACTERES, MEMOIRE_MAX_ELEMENTS,
  type ElementMemoire, type SorteMemoire,
} from "../domaine/memoire-ui";

export * from "../domaine/memoire-ui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — ce que l'assistant retient de LA personne.
 *
 * Sa société, ses produits, ses habitudes, ses raccourcis. Trois règles, toutes tenues ICI :
 *
 *   • À ELLE SEULE. Chaque lecture et chaque écriture filtre sur `userId`, toujours celui de la
 *     SESSION (les actions serveur le prennent de `requireUser`, jamais d'un paramètre). Jamais
 *     partagée : aucun autre compte, aucun autre contexte ne la lit.
 *   • RIEN SANS CONFIRMATION. L'assistant PROPOSE ; la personne confirme d'un geste. Elle voit,
 *     corrige et efface chaque élément à tout moment — l'effacement est réel (suppression).
 *   • RIEN DE SENSIBLE. Une rémunération, une coordonnée bancaire, un numéro de pièce d'identité
 *     n'y entrent pas : la mémoire est réinjectée au modèle, et ces données ne partent jamais au
 *     modèle (même filtre que le reste du contexte).
 *
 * Stockage : `AssistantMemoryItem` (déjà là, déjà scopé par personne) — pas de table de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatMemoire = { ok: true; element: ElementMemoire } | { ok: false; erreur: string };

function nettoyer(contenu: unknown): { ok: true; texte: string } | { ok: false; erreur: string } {
  const texte = typeof contenu === "string" ? contenu.replace(/\s+/g, " ").trim() : "";
  if (!texte) return { ok: false, erreur: "Rien à retenir." };
  if (texte.length > MEMOIRE_MAX_CARACTERES) return { ok: false, erreur: `Trop long : ${MEMOIRE_MAX_CARACTERES} caractères au plus.` };
  if (censurerTexte(texte).censure) {
    return { ok: false, erreur: "Une rémunération, une coordonnée bancaire ou un numéro de pièce d'identité ne se retient pas : ces données ne vont jamais à l'assistant." };
  }
  return { ok: true, texte };
}

const versElement = (i: { id: string; type: string; content: string; updatedAt: Date }): ElementMemoire =>
  ({ id: i.id, sorte: i.type, contenu: i.content, modifieLe: i.updatedAt.toISOString() });

export async function listerMemoire(userId: string): Promise<ElementMemoire[]> {
  const items = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true },
    select: { id: true, type: true, content: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: MEMOIRE_MAX_ELEMENTS,
  });
  return items.map(versElement);
}

export async function ajouterMemoire(userId: string, contenu: unknown, sorte: unknown): Promise<ResultatMemoire> {
  const n = nettoyer(contenu);
  if (!n.ok) return { ok: false, erreur: n.erreur };
  const type: SorteMemoire = estSorteMemoire(sorte) ? sorte : "USER_PREFERENCE";
  const existant = await prisma.assistantMemoryItem.findFirst({
    where: { userId, active: true, content: { equals: n.texte, mode: "insensitive" } },
    select: { id: true, type: true, content: true, updatedAt: true },
  });
  if (existant) return { ok: true, element: versElement(existant) };
  const total = await prisma.assistantMemoryItem.count({ where: { userId, active: true } });
  if (total >= MEMOIRE_MAX_ELEMENTS) return { ok: false, erreur: `Mémoire pleine (${MEMOIRE_MAX_ELEMENTS} éléments) : effacez-en avant d'en ajouter.` };
  const cree = await prisma.assistantMemoryItem.create({
    data: { userId, type, content: n.texte, confidence: 1 },
    select: { id: true, type: true, content: true, updatedAt: true },
  });
  return { ok: true, element: versElement(cree) };
}

export async function modifierMemoire(userId: string, id: string, contenu: unknown): Promise<ResultatMemoire> {
  const n = nettoyer(contenu);
  if (!n.ok) return { ok: false, erreur: n.erreur };
  // ÉCRITURE CONDITIONNELLE (§118.151) : l'élément doit appartenir à CETTE personne.
  const r = await prisma.assistantMemoryItem.updateMany({ where: { id, userId, active: true }, data: { content: n.texte } });
  if (r.count === 0) return { ok: false, erreur: "Élément introuvable." };
  const e = await prisma.assistantMemoryItem.findFirstOrThrow({ where: { id, userId }, select: { id: true, type: true, content: true, updatedAt: true } });
  return { ok: true, element: versElement(e) };
}

/** Effacer, c'est supprimer : un souvenir effacé ne doit plus exister nulle part. */
export async function effacerMemoire(userId: string, id: string): Promise<boolean> {
  const r = await prisma.assistantMemoryItem.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

export async function toutEffacerMemoire(userId: string): Promise<number> {
  const r = await prisma.assistantMemoryItem.deleteMany({ where: { userId } });
  return r.count;
}

/** Ce que le contexte du modèle reçoit : les souvenirs de la personne, filtrés une seconde fois. */
export async function memoirePourContexte(userId: string, limite = 30): Promise<string[]> {
  const items = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true },
    select: { content: true },
    orderBy: { updatedAt: "desc" },
    take: limite,
  });
  return items.map((i) => i.content);
}
