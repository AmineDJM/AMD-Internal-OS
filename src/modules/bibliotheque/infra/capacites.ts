import { prisma } from "@/lib/prisma";
import { lunaEmbed } from "@/lib/openai-luna";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA BASE SAIT FAIRE — détecté, jamais supposé (J1).
 *
 * La migration `20270207110000_bibliotheque` ne pose la colonne `vecteur` (et son index HNSW) que si
 * l'extension pgvector est disponible sur le serveur, les trigrammes que si pg_trgm l'est. Le code lit
 * ce que la base porte VRAIMENT et retombe sans bruit :
 *   • sans vecteur : plein texte + trigrammes (aucun embedding n'est calculé, aucun appel ne sort) ;
 *   • sans trigrammes : plein texte (+ vecteur s'il y en a).
 * Lu une fois par processus et gardé cinq minutes. `BIBLIOTHEQUE_VECTEUR=off` force le repli (un banc,
 * ou un incident chez le fournisseur d'embeddings).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Capacites {
  vecteur: boolean;
  trigrammes: boolean;
}

const DUREE_MS = 5 * 60_000;
let cache: { a: number; c: Capacites } | null = null;

export async function capacites(): Promise<Capacites> {
  if (cache && Date.now() - cache.a < DUREE_MS) return cache.c;
  let c: Capacites = { vecteur: false, trigrammes: false };
  try {
    const [r] = await prisma.$queryRaw<{ vecteur: boolean; trigrammes: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema() AND table_name = 'BibliothequePassage' AND column_name = 'vecteur') AS vecteur,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trigrammes`;
    c = { vecteur: !!r?.vecteur, trigrammes: !!r?.trigrammes };
  } catch (err) {
    console.error("[bibliotheque] capacités illisibles — plein texte seul", err);
  }
  if ((process.env.BIBLIOTHEQUE_VECTEUR ?? "").trim().toLowerCase() === "off") c = { ...c, vecteur: false };
  cache = { a: Date.now(), c };
  return c;
}

/** Oublie la détection (tests, ou après l'installation de l'extension). */
export function oublierCapacites(): void {
  cache = null;
}

// ─────────────────────────────── Les embeddings ───────────────────────────────

/** Rend un vecteur par texte, ou `null` (pas de clé, interrupteur IA coupé, échec) : l'appelant reste lexical. */
export type Embedder = (textes: string[]) => Promise<number[][] | null>;

/** 512 dimensions : la taille de la colonne `vecteur` (et de tous les vecteurs de la plateforme). */
export const DIMENSIONS = 512;
/** Textes par appel au fournisseur. */
export const LOT_EMBEDDINGS = 64;

/** text-embedding-3-small par la porte commune (`lunaEmbed` : interrupteur IA, clé, mandataire). */
export const embedderParDefaut: Embedder = (textes) => lunaEmbed(textes, DIMENSIONS);

/** Le littéral pgvector d'un vecteur (`[0.1,0.2,…]`), refusé s'il n'a pas la bonne taille. */
export function litteralVecteur(v: readonly number[]): string {
  if (v.length !== DIMENSIONS || v.some((x) => !Number.isFinite(x))) throw new Error(`vecteur invalide (${v.length} dimensions)`);
  return `[${v.join(",")}]`;
}

/**
 * UN EMBEDDER DÉTERMINISTE, sans réseau — pour `npm test` et le banc local (`scripts/bench/bibliotheque.ts`).
 * L'astuce du hachage : chaque racine de mot (repliée, cinq lettres) allume une dimension ; deux textes qui
 * partagent leur vocabulaire sont proches. Il mesure le MÉCANISME (colonne, index, fusion) — la qualité du
 * vrai modèle se mesure au banc vivant (`npm run bench:live -- scripts/bench/bibliotheque.ts --vivant`).
 */
export function embedderDeterministe(dims: number = DIMENSIONS): Embedder {
  return async (textes) => textes.map((t) => {
    const v = new Array<number>(dims).fill(0);
    const mots = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    for (const m of mots) {
      const racine = m.slice(0, 5);
      let h = 2166136261;
      for (let i = 0; i < racine.length; i++) h = Math.imul(h ^ racine.charCodeAt(i), 16777619) >>> 0;
      v[h % dims] += 1;
    }
    const norme = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norme);
  });
}
