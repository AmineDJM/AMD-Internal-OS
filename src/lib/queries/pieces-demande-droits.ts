import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { accesAuxPiecesLegal, canAccessEntity } from "@/lib/entity-access";
import { AD_PRO_ENTITY_TYPE } from "@/modules/ad-pro/partage";
import { refusDesPieces } from "@/lib/queries/suppression-piece";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI PEUT SUPPRIMER UNE PIÈCE LEGAL — OU L'UN DE SES FICHIERS — DEPUIS SA DEMANDE (§118.209).
 *
 * « On doit pouvoir supprimer les documents dans les demandes Ad & Pro » (Direction, 05/10). Le bloc
 * « Pièces Legal de la demande » les montrait en lecture seule : un devis déposé deux fois ne se
 * retirait que dans Legal, où l'on ne pense pas à aller le chercher.
 *
 * ── UNE SEULE LECTURE, POUR L'ÉCRAN ET POUR L'ACTION (§118.83) ──────────────────────────────
 *
 * Un bouton offert que l'action refuse ensuite fait chercher une panne qui n'existe pas : l'écran
 * (`droitsSuppressionDesPieces`, en lot) et les actions (`verdictSuppressionPiece`,
 * `verdictSuppressionFichiers`) lisent les MÊMES faits et la MÊME décision pure (`legal/suppression-piece`).
 *
 * ── TROIS FAITS, TOUS NÉCESSAIRES (§118.109, la double garde) ────────────────────────────────
 *
 *   1. la personne peut MODIFIER la demande (`canAccessEntity(…, "UPDATE")`) : retirer une pièce de la
 *      demande de quelqu'un d'autre est la modifier ;
 *   2. elle peut gérer la PIÈCE — la porte du serveur (`accesAuxPiecesLegal`) pour les fichiers ; pour la
 *      pièce, la règle que la fiche Legal applique déjà (`deleteOwnRecord` : son créateur, qui a le droit
 *      « supprimer » de Legal, le Super Admin) — jamais plus large que la fiche ;
 *   3. la pièce n'est pas ENGAGÉE (`refusSuppressionPiece`) : signée, réglée, partie au règlement, validée
 *      par un centre, base d'une autre pièce, portée par un poste.
 *
 * Quand les deux premiers faits sont là et que le troisième refuse, la ligne DIT pourquoi (et le geste
 * qui reste). Sans les droits, rien n'est dit par ligne : « vous ne pouvez pas » n'est pas une
 * information, c'est un bruit que l'on cesse de lire (§118.32).
 *
 * Module serveur ordinaire — pas un fichier `"use server"` : ceci est une QUESTION posée par des
 * actions qui ont déjà la session, pas un point d'entrée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un geste offert ou non, et la raison quand il est refusé par ce qui ENGAGE la pièce. */
export interface OffreGeste {
  offert: boolean;
  raison: string | null;
}

export interface DroitsPieceDemande {
  piece: OffreGeste;
  fichiers: OffreGeste;
}

const NATURES_DU_POLE: ReadonlySet<string> = new Set<string>(Object.values(AD_PRO_ENTITY_TYPE));

/**
 * La règle que la fiche Legal applique à la suppression d'une pièce (`deleteOwnRecord`) : son
 * créateur, qui a le droit « supprimer » du module, le Super Admin. Nommée — une garde écrite en
 * ligne se décrit « gardée par rien » à la carte de confirmation (§118.150g).
 */
export function peutSupprimerLaPiece(user: SessionUser, piece: { createdById: string | null }): boolean {
  return user.role === "SUPER_ADMIN" || piece.createdById === user.id || userCan(user, "LEGAL", "DELETE");
}

/** La demande dont la pièce est la pièce — `null` quand elle n'est pas rattachée à une demande du pôle. */
export function demandeDeLaPiece(piece: { sourceType: EntityType | null; sourceId: string | null }): { type: EntityType; id: string } | null {
  if (!piece.sourceType || !piece.sourceId || !NATURES_DU_POLE.has(piece.sourceType)) return null;
  return { type: piece.sourceType, id: piece.sourceId };
}

/**
 * LES DROITS, EN LOT — pour la liste des pièces d'une demande. Trois lectures de base au plus, quel que
 * soit le nombre de pièces (§118.102b) ; la modification de la demande se demande UNE fois.
 */
export async function droitsSuppressionDesPieces(
  user: SessionUser,
  demande: { type: EntityType; id: string },
  pieces: readonly { id: string; createdById: string | null }[],
): Promise<Map<string, DroitsPieceDemande>> {
  const res = new Map<string, DroitsPieceDemande>();
  if (pieces.length === 0) return res;
  const ids = pieces.map((p) => p.id);
  const [peutModifierLaDemande, droits, refus] = await Promise.all([
    canAccessEntity(user, demande.type, demande.id, "UPDATE"),
    accesAuxPiecesLegal(user, ids, ["VIEW", "UPDATE", "DELETE"]),
    refusDesPieces(ids),
  ]);
  const lisibles = droits.get("VIEW") ?? new Set<string>();
  const modifiables = droits.get("UPDATE") ?? new Set<string>();
  const supprimables = droits.get("DELETE") ?? new Set<string>();
  for (const p of pieces) {
    const refuse = refus.get(p.id);
    const gerable = lisibles.has(p.id) && (modifiables.has(p.id) || supprimables.has(p.id));
    const pieceOuverte = peutModifierLaDemande && lisibles.has(p.id) && peutSupprimerLaPiece(user, p);
    res.set(p.id, {
      piece: { offert: pieceOuverte && !refuse?.piece, raison: pieceOuverte ? refuse?.piece ?? null : null },
      fichiers: { offert: peutModifierLaDemande && gerable && !refuse?.fichiers, raison: peutModifierLaDemande && gerable ? refuse?.fichiers ?? null : null },
    });
  }
  return res;
}

export type Verdict = { ok: true; demande: { type: EntityType; id: string }; piece: { id: string; titre: string } } | { ok: false; error: string };

const REFUS_DEMANDE = "Vous ne pouvez pas modifier cette demande : retirer une de ses pièces la modifie.";
const REFUS_PIECE_INTROUVABLE = "Pièce introuvable.";

async function lirePiece(id: string) {
  return prisma.legalDocument.findUnique({
    where: { id },
    select: { id: true, title: true, reference: true, createdById: true, sourceType: true, sourceId: true },
  });
}

/** Peut-on supprimer CETTE pièce depuis sa demande ? La même décision que `droitsSuppressionDesPieces`, pour une pièce. */
export async function verdictSuppressionPiece(user: SessionUser, pieceId: string): Promise<Verdict> {
  const piece = await lirePiece(pieceId);
  if (!piece) return { ok: false, error: REFUS_PIECE_INTROUVABLE };
  const demande = demandeDeLaPiece(piece);
  if (!demande) {
    return { ok: false, error: "Cette pièce n'est pas rattachée à une demande Ad & Pro : sa suppression se fait depuis sa fiche Legal." };
  }
  // La pièce doit être OUVRABLE par la personne : supprimer par un identifiant deviné ne doit pas confirmer qu'il existe.
  const droits = await accesAuxPiecesLegal(user, [piece.id], ["VIEW"]);
  if (!droits.get("VIEW")?.has(piece.id)) return { ok: false, error: REFUS_PIECE_INTROUVABLE };
  if (!(await canAccessEntity(user, demande.type, demande.id, "UPDATE"))) return { ok: false, error: REFUS_DEMANDE };
  if (!peutSupprimerLaPiece(user, piece)) {
    return { ok: false, error: "Seul le créateur de la pièce, ou qui a le droit de supprimer dans Legal, peut la supprimer." };
  }
  const refus = (await refusDesPieces([piece.id])).get(piece.id)?.piece ?? null;
  if (refus) return { ok: false, error: refus };
  return { ok: true, demande, piece: { id: piece.id, titre: piece.reference ? `${piece.reference} — ${piece.title}` : piece.title } };
}

export type VerdictFichier =
  | { ok: true; demande: { type: EntityType; id: string }; pieceId: string; chemin: string }
  | { ok: false; error: string };

/** Peut-on supprimer CE FICHIER (un `Document` posé sur une pièce Legal) depuis la demande de la pièce ? */
export async function verdictSuppressionFichier(user: SessionUser, documentId: string): Promise<VerdictFichier> {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, entityType: true, entityId: true } });
  if (!doc) return { ok: false, error: "Document introuvable." };
  if (doc.entityType !== "LEGAL_DOCUMENT") return { ok: false, error: "Ce fichier n'est pas celui d'une pièce Legal : il se supprime depuis son propre écran." };
  const piece = await lirePiece(doc.entityId);
  if (!piece) return { ok: false, error: "Document introuvable." };
  const demande = demandeDeLaPiece(piece);
  if (!demande) return { ok: false, error: "Cette pièce n'est pas rattachée à une demande Ad & Pro : ses fichiers se gèrent depuis sa fiche Legal." };
  const droits = await accesAuxPiecesLegal(user, [piece.id], ["VIEW", "UPDATE", "DELETE"]);
  const lisible = droits.get("VIEW")?.has(piece.id) ?? false;
  const gerable = (droits.get("UPDATE")?.has(piece.id) ?? false) || (droits.get("DELETE")?.has(piece.id) ?? false);
  if (!lisible) return { ok: false, error: "Document introuvable." };
  if (!(await canAccessEntity(user, demande.type, demande.id, "UPDATE"))) return { ok: false, error: REFUS_DEMANDE };
  if (!gerable) return { ok: false, error: "Suppression non autorisée : vous ne gérez pas les fichiers de cette pièce." };
  const refus = (await refusDesPieces([piece.id])).get(piece.id)?.fichiers ?? null;
  if (refus) return { ok: false, error: refus };
  return { ok: true, demande, pieceId: piece.id, chemin: `/legal/${piece.id}` };
}
