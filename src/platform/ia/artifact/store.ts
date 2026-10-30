/**
 * LE MAGASIN DE SESSIONS, adossé à Prisma.
 *
 * L'autre moitié du composeur : `ports.ts` donne au moteur l'accès aux documents, ce fichier lui
 * donne la persistance des sessions et du journal. Le moteur, lui, ne connaît ni l'un ni l'autre.
 *
 * ── L'IDEMPOTENCE EST ICI, PAS DANS LE MOTEUR ──────────────────────────────────────────
 *
 * `ajouterOperation` rend `false` quand la clé `operationId` existe déjà sur cette session. C'est
 * la contrainte d'unicité de la base qui tranche, pas un `findFirst` suivi d'un `create` — entre
 * les deux, deux requêtes concurrentes passeraient toutes les deux.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import type { MagasinSessions, OperationPersistee, SessionPersistee } from "@/lib/artifact/runtime/engine";

type LigneSession = {
  id: string; userId: string; threadId: string | null; blockId: string; nodeId: string;
  baseVersion: number; name: string; format: string; state: string; revision: number;
  dirty: boolean; savedVersion: number | null; activePage: number | null;
  activeSlide: number | null; activeSheet: string | null; activeSelection: unknown;
};

function versSession(l: LigneSession): SessionPersistee {
  return {
    id: l.id, userId: l.userId, threadId: l.threadId, blockId: l.blockId, nodeId: l.nodeId,
    baseVersion: l.baseVersion, name: l.name, format: l.format as ArtifactFormat, state: l.state,
    revision: l.revision, dirty: l.dirty, savedVersion: l.savedVersion,
    activePage: l.activePage, activeSlide: l.activeSlide, activeSheet: l.activeSheet,
    activeSelection: Array.isArray(l.activeSelection) ? (l.activeSelection as string[]) : null,
  };
}

/** Les états dans lesquels une session est encore « ouverte » — tout sauf fermée ou en échec. */
const VIVANTS = ["OPENING", "OPEN", "EDITING", "DIRTY", "SAVING", "SAVED"] as const;

export const magasinSessions: MagasinSessions = {
  async creer(s) {
    const l = await prisma.artifactSession.create({
      data: {
        userId: s.userId, threadId: s.threadId, blockId: s.blockId, nodeId: s.nodeId,
        baseVersion: s.baseVersion, name: s.name, format: s.format,
        activePage: s.activePage, activeSlide: s.activeSlide, activeSheet: s.activeSheet,
        activeSelection: s.activeSelection ?? Prisma.DbNull,
        state: "OPENING",
      },
    });
    return versSession(l);
  },

  async lire(sessionId, userId) {
    // Le `userId` est dans le `where`, pas dans un test après coup : c'est le cloisonnement
    // lui-même, et il ne peut pas être oublié par un appelant.
    const l = await prisma.artifactSession.findFirst({ where: { id: sessionId, userId } });
    return l ? versSession(l) : null;
  },

  async ouverte(userId, nodeId) {
    const l = await prisma.artifactSession.findFirst({
      where: { userId, nodeId, state: { in: [...VIVANTS] } },
      orderBy: { updatedAt: "desc" },
    });
    return l ? versSession(l) : null;
  },

  async derniere(userId) {
    const l = await prisma.artifactSession.findFirst({
      where: { userId, state: { in: [...VIVANTS] } },
      orderBy: { updatedAt: "desc" },
    });
    return l ? versSession(l) : null;
  },

  async majSession(sessionId, champs) {
    const data: Prisma.ArtifactSessionUpdateInput = {};
    if (champs.state !== undefined) data.state = champs.state as never;
    if (champs.revision !== undefined) data.revision = champs.revision;
    if (champs.dirty !== undefined) data.dirty = champs.dirty;
    if (champs.savedVersion !== undefined) data.savedVersion = champs.savedVersion;
    if (champs.activePage !== undefined) data.activePage = champs.activePage;
    if (champs.activeSlide !== undefined) data.activeSlide = champs.activeSlide;
    if (champs.activeSheet !== undefined) data.activeSheet = champs.activeSheet;
    if (champs.activeSelection !== undefined) data.activeSelection = champs.activeSelection ?? Prisma.DbNull;
    if (champs.lastError !== undefined) data.lastError = champs.lastError;
    if (Object.keys(data).length === 0) return;
    await prisma.artifactSession.update({ where: { id: sessionId }, data });
  },

  async operations(sessionId) {
    const lignes = await prisma.artifactOperation.findMany({
      where: { sessionId }, orderBy: { seq: "asc" },
    });
    return lignes.map((o): OperationPersistee => ({
      operationId: o.operationId, seq: o.seq, beforeVersion: o.beforeVersion, afterVersion: o.afterVersion,
      command: o.command as unknown as CommandeArtefact, summary: o.summary,
      actorId: o.actorId, actorLabel: o.actorLabel, undone: o.undone, createdAt: o.createdAt,
    }));
  },

  async ajouterOperation(sessionId, op) {
    try {
      await prisma.artifactOperation.create({
        data: {
          sessionId, operationId: op.operationId, seq: op.seq,
          beforeVersion: op.beforeVersion, afterVersion: op.afterVersion,
          command: op.command as unknown as Prisma.InputJsonValue,
          summary: op.summary.slice(0, 900),
          actorId: op.actorId, actorLabel: op.actorLabel, undone: op.undone,
        },
      });
      return true;
    } catch (e) {
      // P2002 = la clé (sessionId, operationId) existait déjà : l'opération a DÉJÀ été appliquée.
      // Ce n'est pas une erreur, c'est exactement ce que l'idempotence doit produire.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
      throw e;
    }
  },

  async marquerAnnulee(sessionId, seq, annulee) {
    await prisma.artifactOperation.updateMany({ where: { sessionId, seq }, data: { undone: annulee } });
  },

  async fermer(sessionId) {
    await prisma.artifactSession.update({
      where: { id: sessionId }, data: { state: "CLOSED", closedAt: new Date() },
    });
  },
};
