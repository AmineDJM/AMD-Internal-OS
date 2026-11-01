import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { MoyenAgent } from "./ports";

/**
 * LES LANCEMENTS DE CLAUDE CODE ET LEUR CLÉ D'IDEMPOTENCE (lot C2, décision 0041).
 *
 * La Routines API n'a pas d'idempotence : « each successful request creates a new session » (doc Anthropic). La
 * clé vit donc chez Adventum, dans `DevLancement` :
 *   • RÉCLAMER avant d'envoyer (contrainte d'unicité) — deux tours concurrents du moteur ne lancent qu'une session ;
 *   • une clé déjà `LANCE` rend le premier résultat ; `EN_COURS` ou `INCERTAIN` refuse (on ne sait pas si la session
 *     existe : un humain regarde claude.ai/code avant toute relance) ; `ECHEC` (rien n'a été créé) se re-réclame.
 * La même table compte les quotas (30 lancements/h/routine, 100/h/compte) pour refuser AVANT le 429.
 */

export const QUOTA_ROUTINE_HEURE = 30;
export const QUOTA_COMPTE_HEURE = 100;
const HEURE = 3_600_000;

export type StatutLancement = "EN_COURS" | "LANCE" | "ECHEC" | "INCERTAIN";

export interface LigneLancement {
  id: string;
  statut: string;
  sessionId: string | null;
  sessionUrl: string | null;
  commentaireId: string | null;
  erreur: string | null;
}

export type Reclamation = { etat: "NOUVEAU"; id: string } | { etat: "DEJA"; ligne: LigneLancement };

export const empreinteTexte = (texte: string): string => `sha256:${createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 32)}`;

const CHOIX = { id: true, statut: true, sessionId: true, sessionUrl: true, commentaireId: true, erreur: true } as const;

export async function reclamer(d: { cle: string; moyen: MoyenAgent; cible: string; missionId?: string | null; texte: string }): Promise<Reclamation> {
  const empreinte = empreinteTexte(d.texte);
  const cle = d.cle.slice(0, 190);
  // `skipDuplicates` = ON CONFLICT DO NOTHING : la contrainte d'unicité désigne UN gagnant, même en concurrence.
  const pris = await prisma.devLancement.createMany({ data: [{ cleIdempotence: cle, moyen: d.moyen, cible: d.cible, missionId: d.missionId ?? null, empreinte }], skipDuplicates: true });
  const ligne = await prisma.devLancement.findUniqueOrThrow({ where: { cleIdempotence: cle }, select: CHOIX });
  if (pris.count === 1) return { etat: "NOUVEAU", id: ligne.id };
  if (ligne.statut === "ECHEC") {
    // Rien n'a été créé chez Anthropic : la clé se re-réclame, atomiquement (un seul gagnant).
    const n = await prisma.devLancement.updateMany({ where: { id: ligne.id, statut: "ECHEC" }, data: { statut: "EN_COURS", erreur: null, empreinte, createdAt: new Date() } });
    if (n.count === 1) return { etat: "NOUVEAU", id: ligne.id };
  }
  return { etat: "DEJA", ligne };
}

export async function conclure(id: string, issue: { statut: Exclude<StatutLancement, "EN_COURS">; sessionId?: string | null; sessionUrl?: string | null; commentaireId?: string | null; erreur?: string | null }): Promise<void> {
  await prisma.devLancement.update({
    where: { id },
    data: { statut: issue.statut, sessionId: issue.sessionId ?? null, sessionUrl: issue.sessionUrl ?? null, commentaireId: issue.commentaireId ?? null, erreur: issue.erreur?.slice(0, 500) ?? null },
  });
}

/** Les lancements qui comptent dans la dernière heure (tout ce qui a pu créer une session). */
async function compter(where: Prisma.DevLancementWhereInput, maintenant: Date): Promise<{ n: number; plusAncien: Date | null }> {
  const filtre: Prisma.DevLancementWhereInput = { ...where, statut: { in: ["EN_COURS", "LANCE", "INCERTAIN"] }, createdAt: { gte: new Date(maintenant.getTime() - HEURE) } };
  const [n, premier] = await Promise.all([
    prisma.devLancement.count({ where: filtre }),
    prisma.devLancement.findFirst({ where: filtre, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return { n, plusAncien: premier?.createdAt ?? null };
}

export interface QuotasRoutine { routine: { utilises: number; limite: number }; compte: { utilises: number; limite: number }; libreDansMs: number | null }

/** Les quotas horaires d'une routine et du compte, comptés par Adventum (les « Run now » du web n'y sont pas). */
export async function quotasRoutine(alias: string, maintenant = new Date()): Promise<QuotasRoutine> {
  const [r, c] = await Promise.all([compter({ moyen: "ROUTINE", cible: alias }, maintenant), compter({ moyen: "ROUTINE" }, maintenant)]);
  const plein = r.n >= QUOTA_ROUTINE_HEURE ? r.plusAncien : c.n >= QUOTA_COMPTE_HEURE ? c.plusAncien : null;
  return {
    routine: { utilises: r.n, limite: QUOTA_ROUTINE_HEURE },
    compte: { utilises: c.n, limite: QUOTA_COMPTE_HEURE },
    libreDansMs: plein ? Math.max(1_000, plein.getTime() + HEURE - maintenant.getTime()) : null,
  };
}
