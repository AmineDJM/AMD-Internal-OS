import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LA PAIE NE SORT PAS PAR L'API, NI PAR LES RELATIONS, NI PAR L'HISTORIQUE (audit sécurité 27/10, SECURITE-ACCES-05).
 *
 * Le filtre `CHAMPS_JAMAIS_EXPOSES` retirait le salaire de base, mais pas le reste de la paie :
 * `employee/:id/related` rendait les bulletins (`payrolls` : brut, net, primes, retenues) mois par mois,
 * et `employee/:id/history` rendait l'ancienne et la nouvelle valeur d'un changement de salaire —
 * à toute clé dont l'identité lit le module RH, alors que l'écran les réserve à qui gère la paie.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { GET as aspectGET } from "./entities/[entity]/[id]/[aspect]/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zpaie${Date.now()}`;
let userId = "";
let employeId = "";
let clientId = "";
let cle = "";

const facette = async (aspect: string) => {
  const r = await aspectGET(
    new NextRequest(`http://localhost/api/v1/entities/employee/${employeId}/${aspect}`, { headers: { authorization: `Bearer ${cle}` } }),
    { params: { entity: "employee", id: employeId, aspect } },
  );
  expect(r.status).toBe(200);
  return JSON.stringify((await r.json()).data);
};

suite("API v1 — fiche employé : aucune donnée de paie", () => {
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, passwordHash: "x", role: "DIRECTION" } })).id;
    employeId = (await prisma.employee.create({
      data: { fullName: `${TAG} salarié`, baseSalary: 123456, retIrg: 23456, birthDate: new Date("1990-01-01") },
    })).id;
    await prisma.payrollEntry.create({ data: { employeeId: employeId, year: 2026, month: 9, gross: 987654, net: 876543, bonuses: 11111, deductions: 22222 } });
    await prisma.auditLog.create({ data: { actorId: userId, action: "UPDATE", module: "RH", entityType: "EMPLOYEE", entityId: employeId, field: "baseSalary", oldValue: "654321", newValue: "123456" } });
    const k = generateApiKey();
    cle = k.key;
    clientId = (await prisma.apiClient.create({ data: { name: TAG, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: ["erp.read"], actAsUserId: userId } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.apiCall.deleteMany({ where: { clientId } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: clientId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { entityId: employeId } }).catch(() => undefined);
    await prisma.payrollEntry.deleteMany({ where: { employeeId: employeId } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  it("related : les bulletins sont listés sans aucun montant", async () => {
    const json = await facette("related");
    for (const montant of ["987654", "876543", "11111", "22222"]) expect(json).not.toContain(montant);
  });

  it("history : le changement de salaire est dit, ses valeurs non", async () => {
    const json = await facette("history");
    expect(json).toContain("baseSalary");
    expect(json).not.toContain("654321");
    expect(json).not.toContain("123456");
  });
});
