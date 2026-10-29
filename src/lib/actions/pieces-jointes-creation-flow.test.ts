import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { createRequest } from "./admin-request-actions";
import { createAdProOtherRequest } from "@/modules/ad-pro/actions-autres";
import { CHAMP_PIECES_COMPLEMENTAIRES } from "@/modules/ad-pro/partage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pjcreation__";
const T0 = new Date();

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/** Des octets d'archive Office (« PK ») — ce qu'est un vrai .xlsx. */
const fichier = (nom: string) => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], nom);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DES PIÈCES JOINTES DÈS LA CRÉATION — tout type, Excel compris, sauf ce qui s'exécute (Direction,
 * 10/2026). Par les VRAIS points d'entrée : la demande au bureau du secrétariat (`createRequest`)
 * et la demande Ad & Pro « autre » (`createAdProOtherRequest`), avec un vrai `FormData`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Pièces jointes à la création — tout type sauf les programmes", () => {
  let demandeurId = "", pmId = "";

  /**
   * Tout ce que le banc a écrit — y compris par un passage précédent interrompu. La copie Drive des pièces
   * part EN ARRIÈRE-PLAN (`attachFiles`) : elle peut écrire après la fin d'un test, d'où la purge aussi au début.
   */
  async function nettoyer() {
    const secretariat = (await prisma.administrativeRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
    const autres = (await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
    const ids = [...secretariat, ...autres];
    const docs = await prisma.document.findMany({ where: { entityId: { in: ids } }, select: { fileKey: true } });
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: secretariat } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { id: { in: autres } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, body: { contains: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [d, pm] = await Promise.all([mk("demandeur", "MEDICAL_DELEGATE"), mk("pm", "PRODUCT_MANAGER")]);
    demandeurId = d.id; pmId = pm.id;
  });

  afterAll(async () => {
    // Laisse la copie Drive en arrière-plan finir avant d'effacer ses propriétaires.
    await new Promise((r) => setTimeout(r, 1500));
    await nettoyer();
  });

  const docsDe = (entityId: string) =>
    prisma.document.findMany({ where: { entityId }, select: { name: true, category: true }, orderBy: { name: "asc" } });

  describe("au bureau du secrétariat", () => {
    const demande = (titre: string, ...pieces: File[]) => {
      const fd = new FormData();
      fd.set("type", "OTHER");
      fd.set("title", `${TAG}${titre}`);
      for (const p of pieces) fd.append("files", p);
      return fd;
    };

    it("Excel, CSV, PDF, Word, archive : la demande naît avec ses pièces", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      const r = await createRequest(undefined, demande("Avec pièces",
        fichier("budget.xlsx"), fichier("ancien.xls"), fichier("macros.xlsm"), fichier("liste.csv"), fichier("devis.pdf"), fichier("lettre.docx"), fichier("lot.zip")));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const docs = await docsDe(r.id!);
      expect(docs.map((d) => d.name).sort()).toEqual(["ancien.xls", "budget.xlsx", "devis.pdf", "lettre.docx", "liste.csv", "lot.zip", "macros.xlsm"]);
      expect(new Set(docs.map((d) => d.category))).toEqual(new Set(["SUPPORTING_DOC"]));
    });

    it("un programme ou un script est refusé, nommé, et AUCUNE demande n'est créée", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      for (const nom of ["outil.exe", "lancer.bat", "script.ps1"]) {
        const r = await createRequest(undefined, demande(`Refusée ${nom}`, fichier("budget.xlsx"), fichier(nom)));
        expect(r.ok).toBe(false);
        expect(r.ok ? "" : r.error).toContain(nom);
        expect(await prisma.administrativeRequest.count({ where: { title: `${TAG}Refusée ${nom}` } })).toBe(0);
      }
    });

    it("sans pièce, rien ne change", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      const r = await createRequest(undefined, demande("Sans pièce"));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(await docsDe(r.id!)).toEqual([]);
    });
  });

  describe("en Ad & Pro — demande « autre »", () => {
    const demande = (titre: string, ...pieces: File[]) => {
      const fd = new FormData();
      fd.set("title", `${TAG}${titre}`);
      fd.set("description", "Pièces jointes à la création");
      for (const p of pieces) fd.append(CHAMP_PIECES_COMPLEMENTAIRES, p);
      return fd;
    };

    it("un Excel se joint dès la création", async () => {
      ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
      const r = await createAdProOtherRequest(undefined, demande("Avec Excel", fichier("chiffrage.xlsx"), fichier("liste.csv")));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(await docsDe(r.id!)).toEqual([
        { name: "chiffrage.xlsx", category: "SUPPORTING_DOC" },
        { name: "liste.csv", category: "SUPPORTING_DOC" },
      ]);
    });

    it("un exécutable est refusé et la demande n'existe pas", async () => {
      ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
      const r = await createAdProOtherRequest(undefined, demande("Avec exe", fichier("chiffrage.xlsx"), fichier("outil.exe")));
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toContain("outil.exe");
      expect(await prisma.adProOtherRequest.count({ where: { title: `${TAG}Avec exe` } })).toBe(0);
    });
  });
});
