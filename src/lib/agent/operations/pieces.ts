// L'ORDRE COMPTE : `lib/assistant` (le point d'entrée des ops) se charge AVANT une implémentation
// d'op — importée seule, elle ferait vérifier un catalogue à moitié chargé, qui refuse de démarrer.
import "@/lib/assistant";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { driveNodeToFile, resolveDriveFile } from "@/lib/assistant/ops/impl-wave8-files";
import { PIECES_PAR_ENVOI_MAX } from "@/lib/agent/lecture/depot";

/**
 * LES PIÈCES JOINTES D'UNE OPÉRATION — un fichier du Drive de la personne, ou un fichier glissé
 * dans la conversation (qui atterrit dans son Drive, `/api/drive/upload`).
 *
 * À la PROPOSITION, la pièce est désignée par son identifiant Drive ou par son nom, et doit être
 * VISIBLE par la personne. À l'EXÉCUTION, son contenu est relu depuis le Drive, droits revérifiés
 * (`driveNodeToFile`) : un fichier retiré entre-temps n'est jamais envoyé.
 */
export interface PieceResolue {
  id: string;
  nom: string;
}

const RE_ID = /^c[a-z0-9]{20,}$/;

export async function resoudrePiece(user: CurrentUser, ref: string): Promise<PieceResolue | { erreur: string }> {
  const r = ref.trim();
  if (!r) return { erreur: "Pièce non désignée." };
  if (RE_ID.test(r)) {
    if (!canViewDrive(await resolveDriveAccess(user, r))) return { erreur: "Cette pièce du Drive ne vous est pas accessible." };
    const n = await prisma.driveNode.findUnique({ where: { id: r }, select: { id: true, name: true, type: true, isTrashed: true } });
    if (!n || n.type !== "FILE" || n.isTrashed) return { erreur: "Pièce introuvable dans le Drive (supprimée ?)." };
    return { id: n.id, nom: n.name };
  }
  const f = await resolveDriveFile(user, r);
  if ("error" in f) return { erreur: f.error };
  return { id: f.id, nom: f.name };
}

/** Plusieurs pièces : la première erreur arrête tout — une demande ne part pas avec une pièce devinée. */
export async function resoudrePieces(user: CurrentUser, refs: string[]): Promise<PieceResolue[] | { erreur: string }> {
  const out: PieceResolue[] = [];
  for (const ref of refs) {
    const p = await resoudrePiece(user, ref);
    if ("erreur" in p) return { erreur: `« ${ref} » : ${p.erreur}` };
    if (!out.some((x) => x.id === p.id)) out.push(p);
  }
  return out;
}

/** À l'exécution : le contenu, relu du Drive, droits revérifiés. */
export async function fichiersDepuisDrive(user: CurrentUser, ids: string[]): Promise<File[] | { erreur: string }> {
  const out: File[] = [];
  for (const id of ids) {
    const f = await driveNodeToFile(user, id);
    if (!(f instanceof File)) return { erreur: f.error };
    out.push(f);
  }
  return out;
}

export const idsDe = (json: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * LES PIÈCES JOINTES D'UN MESSAGE de la conversation — revérifiées (la personne les VOIT) ; le tour
 * les LIT ensuite (`agent/lecture/pieces.ts`, décision 0011 : coffre refusé, contenu filtré, borné et
 * encadré) et les nomme par leur identifiant pour les joindre à une demande. Une pièce invisible est
 * écartée en silence (elle ne vient pas d'elle).
 */
export async function piecesDuMessage(user: CurrentUser, brutes: unknown): Promise<PieceResolue[]> {
  if (!Array.isArray(brutes)) return [];
  return piecesVisibles(user, brutes.map((b) => (b && typeof b === "object" ? (b as { id?: unknown }).id : null)));
}

/** Les identifiants Drive (10 au plus) que la personne VOIT, sans doublon ; le reste est écarté en silence. */
async function piecesVisibles(user: CurrentUser, ids: unknown[]): Promise<PieceResolue[]> {
  const out: PieceResolue[] = [];
  for (const id of ids.slice(0, PIECES_PAR_ENVOI_MAX)) {
    if (typeof id !== "string" || !RE_ID.test(id)) continue;
    const p = await resoudrePiece(user, id);
    if (!("erreur" in p) && !out.some((x) => x.id === p.id)) out.push(p);
  }
  return out;
}

/**
 * LES PIÈCES QUE L'ASSISTANT A RENVOYÉES (décision 0015) — les fichiers du Drive cités par un lien
 * `/drive/<id>` (document créé, traduction…), revérifiés sous les droits de la personne : l'écran les
 * montre comme des pièces ouvrables. Un fichier retiré ou invisible n'apparaît pas.
 */
export const piecesCitees = (user: CurrentUser, ids: string[]): Promise<PieceResolue[]> => piecesVisibles(user, ids);
