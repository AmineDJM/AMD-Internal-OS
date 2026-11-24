import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("@/lib/session", () => ({ requireUser: async () => null, requireUserAuNomDeLaVue: async () => null, getUser: async () => null }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { runLegalExpirySweep, TAILLE_LOT_BALAYAGE } from "@/lib/legal/expiry-sweep";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RAPPELS LEGAL NE SE TAISENT PLUS DERRIÈRE L'HISTORIQUE (audit des manques F10, validé le 24/11/2026).
 *
 * Le balayage lisait au plus 300 documents par passage, termes les plus anciens d'abord, expirés compris : avec
 * plus de 300 documents arrivés à terme, le contrat qui arrivait à échéance dans 30 jours n'était jamais lu, et
 * aucun rappel ne partait. Ici : 305 documents passés (à aligner) + 1 bail à J-30 qui DOIT être rappelé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__balayage__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const JOUR = 86_400_000;
const EXPIRES = TAILLE_LOT_BALAYAGE + 5;

suite("balayage des échéances Legal — plus de 300 documents arrivés à terme", () => {
  let auteur = "";
  let bail = "";
  const maintenant = new Date();

  async function nettoyer() {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    auteur = (await prisma.user.create({ data: { name: `${TAG}auteur`, email: `${TAG}auteur@t.dz`, role: "VIEWER", passwordHash: "x" } })).id;
    // Les plus anciens termes de la base : c'est eux que l'ancien balayage lisait d'abord. Déjà rappelés au
    // dépassement (aucune notification à attendre d'eux), mais encore ACTIVE : le statut est à aligner.
    const tresVieux = new Date("2001-01-01T00:00:00Z");
    await prisma.legalDocument.createMany({
      data: Array.from({ length: EXPIRES }, (_, i) => ({
        title: `${TAG}Ancien contrat ${i}`, kind: "CONTRACT" as const, status: "ACTIVE" as const,
        endDate: new Date(tresVieux.getTime() + i * JOUR), lastRemindedAt: new Date("2010-01-01T00:00:00Z"),
      })),
    });
    bail = (await prisma.legalDocument.create({
      data: { title: `${TAG}Bail des locaux`, kind: "LEASE", createdById: auteur, endDate: new Date(maintenant.getTime() + 30 * JOUR) },
    })).id;
  }, 120_000);

  afterAll(nettoyer);

  it("le bail à J-30 est rappelé, et tous les termes passés sont alignés — au-delà de la taille d'un lot", async () => {
    await runLegalExpirySweep(maintenant);
    const rappel = await prisma.notification.findMany({ where: { userId: auteur, body: { contains: "Bail des locaux" } } });
    expect(rappel).toHaveLength(1);
    expect(rappel[0].title).toMatch(/^Échéance dans (29|30) jours$/);
    expect(await prisma.legalDocument.count({ where: { title: { startsWith: `${TAG}Ancien` }, status: "ACTIVE" } })).toBe(0);
    expect(await prisma.legalDocument.count({ where: { title: { startsWith: `${TAG}Ancien` }, status: "EXPIRED" } })).toBe(EXPIRES);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bail } })).lastRemindedAt).not.toBeNull();
  }, 180_000);

  it("idempotent : un second passage ne rappelle ni n'aligne rien de plus", async () => {
    const res = await runLegalExpirySweep(maintenant);
    expect(await prisma.notification.count({ where: { userId: auteur, body: { contains: "Bail des locaux" } } })).toBe(1);
    const nosDocs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    expect(await prisma.auditLog.count({ where: { entityId: { in: nosDocs.map((d) => d.id) } } })).toBe(EXPIRES);
    expect(res.expired).toBe(0);
  }, 180_000);

  it("des lots plus petits que la base ne font rien oublier : la lecture reprend après le dernier document lu", async () => {
    await prisma.legalDocument.update({ where: { id: bail }, data: { lastRemindedAt: null } });
    await prisma.notification.deleteMany({ where: { userId: auteur } });
    await runLegalExpirySweep(maintenant, { tailleLot: 7 });
    expect(await prisma.notification.count({ where: { userId: auteur, body: { contains: "Bail des locaux" } } })).toBe(1);
  }, 180_000);
});
