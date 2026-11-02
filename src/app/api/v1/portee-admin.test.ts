import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LES OBJETS D'ADMINISTRATION EXIGENT LA PORTÉE `erp.admin` (audit sécurité 27/10, SA-15).
 *
 * Le registre le disait (« l'exposer demande la portée `erp.admin` ») et rien ne le vérifiait : une clé `erp.read`
 * au nom d'un détenteur d'`ADMIN:VIEW` listait les comptes et le journal d'audit. Mesuré par les vraies routes :
 * sans la portée, la liste, la fiche et la recherche refusent ou taisent ; avec, elles répondent.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { GET as listGET } from "./entities/[entity]/route";
import { GET as ficheGET } from "./entities/[entity]/[id]/route";
import { GET as searchGET } from "./search/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zadminapi${Date.now()}`;
let adminId = "";
const clients: string[] = [];
const cles = { lecture: "", admin: "" };
const appel = (url: string, cle: string) => new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${cle}` } });

suite("API v1 — comptes et journal d'audit : la portée `erp.admin` est exigée", () => {
  beforeAll(async () => {
    adminId = (await prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    for (const [nom, scopes] of [["lecture", ["erp.read", "erp.search"]], ["admin", ["erp.read", "erp.search", "erp.admin"]]] as const) {
      const k = generateApiKey();
      cles[nom] = k.key;
      clients.push((await prisma.apiClient.create({ data: { name: `${TAG}${nom}`, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: [...scopes], actAsUserId: adminId } })).id);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.apiCall.deleteMany({ where: { clientId: { in: clients } } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: { in: clients } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: adminId } }).catch(() => undefined);
  }, 60_000);

  it("sans `erp.admin` : la liste des comptes et du journal est refusée, la fiche d'un compte aussi", async () => {
    for (const entite of ["user", "audit_log"]) {
      const r = await listGET(appel(`/api/v1/entities/${entite}`, cles.lecture), { params: Promise.resolve({ entity: entite }) });
      expect(r.status, entite).toBe(403);
      expect((await r.json()).error.code).toBe("MISSING_SCOPE");
    }
    const fiche = await ficheGET(appel(`/api/v1/entities/user/${adminId}`, cles.lecture), { params: Promise.resolve({ entity: "user", id: adminId }) });
    expect(fiche.status).toBe(403);
  });

  it("sans `erp.admin` : la recherche ne passe pas par les comptes", async () => {
    const r = await searchGET(appel(`/api/v1/search?q=${TAG}&entities=user`, cles.lecture), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain(adminId);
  });

  it("témoin : avec `erp.admin`, la même identité liste les comptes", async () => {
    const r = await listGET(appel(`/api/v1/entities/user?q=${TAG}`, cles.admin), { params: Promise.resolve({ entity: "user" }) });
    expect(r.status).toBe(200);
    expect(((await r.json()).data.items as { id: string }[]).map((u) => u.id)).toContain(adminId);
  });
});
