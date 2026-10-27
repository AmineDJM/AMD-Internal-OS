import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { documentLisibleParApi } from "./document-lisible";

/**
 * `GET /api/v1/documents/:id/content` — UNE PIÈCE HORS REGISTRE API NE SE LIT PAS SANS DROIT SUR SON PORTEUR
 * (audit du 27/10/2026, RH-DOCUMENTS-COMMS-01). Avant : seuls les types du registre étaient contrôlés ; la pièce
 * d'une demande RH d'un autre salarié se téléchargeait avec la seule portée `erp.documents.read`.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__doclisible${Date.now()}__`;

async function sessionDe(id: string, role: SessionUser["role"]): Promise<SessionUser> {
  return { id, role, access: await getAccess(id, role) } as SessionUser;
}

describe("la route de contenu passe par la règle unique", () => {
  it("route.ts appelle documentLisibleParApi", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/v1/documents/[id]/content/route.ts"), "utf8");
    expect(src).toMatch(/documentLisibleParApi\s*\(/);
  });
});

suite("documentLisibleParApi — pièces hors registre", () => {
  let salarieId = "", autreId = "", reqId = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [salarie, autre] = await Promise.all([mk("salarie", "MEDICAL_DELEGATE"), mk("autre", "MEDICAL_DELEGATE")]);
    salarieId = salarie.id; autreId = autre.id;
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} Salarié`, userId: salarieId, isActive: true } });
    const req = await prisma.hrDocumentRequest.create({ data: { employeeId: emp.id, type: "WORK_CERTIFICATE", status: "PENDING" } });
    reqId = req.id;
  });

  afterAll(async () => {
    await prisma.hrDocumentRequest.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un collègue sans droit RH ne lit pas la pièce de la demande RH d'un autre", async () => {
    const doc = { entityType: "HR_REQUEST", entityId: reqId };
    expect(await documentLisibleParApi(await sessionDe(autreId, "MEDICAL_DELEGATE"), doc)).toBe(false);
  });

  it("le salarié lit la pièce de SA demande (même règle que l'écran)", async () => {
    const doc = { entityType: "HR_REQUEST", entityId: reqId };
    expect(await documentLisibleParApi(await sessionDe(salarieId, "MEDICAL_DELEGATE"), doc)).toBe(true);
  });

  it("une pièce sans objet porteur ne se lit pas", async () => {
    expect(await documentLisibleParApi(await sessionDe(salarieId, "MEDICAL_DELEGATE"), { entityType: null, entityId: null })).toBe(false);
  });
});
