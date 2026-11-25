import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("@/lib/session", () => ({ requireUser: async () => null, requireUserAuNomDeLaVue: async () => null, getUser: async () => null }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { runLegalExpirySweep } from "@/lib/legal/expiry-sweep";
import { echeancesLegal } from "@/lib/legal/echeances";
import { horizonEcheances } from "@/lib/echeances/regles";
import { statutLegalAffiche } from "@/lib/legal/lifecycle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN ENGAGEMENT COURT TERMINÉ N'ALERTE PLUS (Super Admin, 25/11/2026), sur la base, par le VRAI balayage et la VRAIE
 * source des échéances d'« Aujourd'hui » :
 *   • la « Convention Orateur » d'un jour (début = fin), passée : alignée EXPIRED, « Terminé » à l'écran, AUCUNE
 *     notification, AUCUNE ligne dans « Aujourd'hui » ;
 *   • un contrat DURABLE dépassé, à côté : rappelé (« DÉPASSÉE »), et toujours dans « Aujourd'hui ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__ponctuel__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const JOUR = 86_400_000;

suite("Legal — l'engagement ponctuel terminé se tait ; le durable alerte (base réelle)", () => {
  const maintenant = new Date();
  let auteur = "", convention = "", maintenance = "";

  async function nettoyer() {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    auteur = (await prisma.user.create({ data: { name: `${TAG}auteur`, email: `${TAG}auteur@t.dz`, role: "VIEWER", passwordHash: "x" } })).id;
    // Le cas réel : une convention d'orateur d'un jour, il y a 72 jours (dans la fenêtre de 90 jours d'« Aujourd'hui »).
    const jourJ = new Date(maintenant.getTime() - 72 * JOUR);
    convention = (await prisma.legalDocument.create({
      data: { title: `${TAG}Convention Orateur`, kind: "CONTRACT", status: "ACTIVE", createdById: auteur, startDate: jourJ, endDate: jourJ },
    })).id;
    maintenance = (await prisma.legalDocument.create({
      data: {
        title: `${TAG}Contrat de maintenance`, kind: "CONTRACT", status: "ACTIVE", createdById: auteur,
        startDate: new Date(maintenant.getTime() - 400 * JOUR), endDate: new Date(maintenant.getTime() - 10 * JOUR),
      },
    })).id;
  }, 120_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: auteur } }).catch(() => {});
    await nettoyer();
  });

  it("le balayage aligne les deux en EXPIRED, mais ne rappelle QUE le durable", async () => {
    await runLegalExpirySweep(maintenant);
    const notes = await prisma.notification.findMany({ where: { userId: auteur }, select: { title: true, body: true } });
    expect(notes.filter((n) => (n.body ?? "").includes("Convention Orateur")), "aucun rappel pour la convention terminée").toEqual([]);
    expect(notes.filter((n) => (n.body ?? "").includes("Contrat de maintenance")).map((n) => n.title)).toEqual([expect.stringContaining("DÉPASSÉE")]);
    const conv = await prisma.legalDocument.findUniqueOrThrow({ where: { id: convention } });
    expect(conv.status, "le statut en base reste EXPIRED").toBe("EXPIRED");
    expect(conv.lastRemindedAt, "rien n'a été envoyé").toBeNull();
    expect(statutLegalAffiche(conv, maintenant), "l'écran dit « Terminé »").toBe("TERMINE");
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: maintenance } })).status).toBe("EXPIRED");
  }, 180_000);

  it("« Aujourd'hui » ne montre pas la convention terminée ; le contrat durable dépassé y reste", async () => {
    const lignes = await echeancesLegal.lire({ maintenant, jusquau: horizonEcheances(maintenant) });
    expect(lignes.some((l) => l.id === convention)).toBe(false);
    expect(lignes.some((l) => l.id === maintenance)).toBe(true);
  }, 60_000);
});
