import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LES MEMBRES D'UN DÉPARTEMENT SANS LEURS COORDONNÉES PERSONNELLES (audit sécurité 27/10, reste de SA-05).
 *
 * `department/:id/related` rendait la ligne ENTIÈRE de chaque membre : adresse et téléphone personnels, que la
 * fiche du salarié réserve aux RH. La relation a désormais sa projection — ce que la liste des employés rend.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { GET as aspectGET } from "./entities/[entity]/[id]/[aspect]/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zrel${Date.now()}`;
const ids = { user: "", dept: "", client: "" };
let cle = "";

suite("API v1 — department/related : la projection des membres", () => {
  beforeAll(async () => {
    ids.user = (await prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, passwordHash: "x", role: "DIRECTION" } })).id;
    ids.dept = (await prisma.department.create({ data: { name: `${TAG} Ventes`, code: `${TAG}V` } })).id;
    await prisma.employee.create({ data: { fullName: `${TAG} salariée`, departmentId: ids.dept, address: `${TAG} 12 rue des Oliviers`, phone: "0555 12 34 56" } });
    const k = generateApiKey();
    cle = k.key;
    ids.client = (await prisma.apiClient.create({ data: { name: TAG, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: ["erp.read"], actAsUserId: ids.user } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.apiCall.deleteMany({ where: { clientId: ids.client } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: ids.client } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { departmentId: ids.dept } }).catch(() => undefined);
    await prisma.department.deleteMany({ where: { id: ids.dept } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ids.user } }).catch(() => undefined);
  }, 60_000);

  it("les membres sont listés, sans adresse ni téléphone", async () => {
    const r = await aspectGET(
      new NextRequest(`http://localhost/api/v1/entities/department/${ids.dept}/related`, { headers: { authorization: `Bearer ${cle}` } }),
      { params: Promise.resolve({ entity: "department", id: ids.dept, aspect: "related" }) },
    );
    expect(r.status).toBe(200);
    const json = JSON.stringify((await r.json()).data);
    expect(json).toContain(`${TAG} salariée`);
    expect(json).not.toContain("rue des Oliviers");
    expect(json).not.toContain("0555 12 34 56");
  });
});
