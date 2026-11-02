import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LES OBJETS PERSONNELS NE SE LISENT PAS PAR LE SEUL MODULE (audit sécurité 27/10, SECURITE-ACCES-04).
 *
 * `notification` (module NOTIFICATIONS) et `task` (module WORKSPACE) étaient déclarés « le module
 * suffit » au registre. Or TOUS les rôles ont ces deux modules : une clé agissant au nom de n'importe
 * qui listait les notifications de toute l'entreprise (titre, corps, lien) et toutes les tâches,
 * là où l'écran montre les siennes. Mesuré par la vraie route de liste.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { GET as listGET } from "./entities/[entity]/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zperso${Date.now()}`;
const users: string[] = [];
let clientId = "";
let cle = "";

const lister = async (entite: string) => {
  const r = await listGET(
    new NextRequest(`http://localhost/api/v1/entities/${entite}?q=${TAG}`, { headers: { authorization: `Bearer ${cle}` } }),
    { params: Promise.resolve({ entity: entite }) },
  );
  expect(r.status).toBe(200);
  return ((await r.json()).data.items as { title: string }[]).map((i) => i.title).sort();
};

suite("API v1 — notifications et tâches : celles de l'identité, pas celles de tout le monde", () => {
  beforeAll(async () => {
    const [moi, autre] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
    ]);
    users.push(moi.id, autre.id);
    await prisma.notification.createMany({ data: [
      { userId: moi.id, title: `${TAG} la mienne` },
      { userId: autre.id, title: `${TAG} celle d'un collègue` },
    ] });
    await prisma.task.createMany({ data: [
      { title: `${TAG} la mienne`, assignedToId: moi.id, createdById: autre.id },
      { title: `${TAG} celle d'un collègue`, assignedToId: autre.id, createdById: autre.id },
    ] });
    const k = generateApiKey();
    cle = k.key;
    clientId = (await prisma.apiClient.create({ data: { name: TAG, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: ["erp.read"], actAsUserId: moi.id } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.apiCall.deleteMany({ where: { clientId } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: clientId } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
  }, 60_000);

  it("notifications : seulement les miennes", async () => {
    expect(await lister("notification")).toEqual([`${TAG} la mienne`]);
  });

  it("tâches : seulement celles de mon cercle", async () => {
    expect(await lister("task")).toEqual([`${TAG} la mienne`]);
  });
});
