import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LA RECHERCHE `q` NE REMPLACE JAMAIS LA PORTÉE (audit sécurité 27/10, SECURITE-ACCES-03).
 *
 * La portée par ligne d'un module « mes lignes » est un `{ OR: [...] }` (`scopeMedicalVisits` :
 * mes visites, ou celles qu'on m'a ouvertes). La recherche plein texte est AUSSI un `{ OR: [...] }`.
 * Étalées dans le même objet, la seconde écrasait la première : `?q=e` rendait les comptes rendus
 * de visite de TOUS les délégués à une clé agissant au nom d'un seul. Mesuré par les vraies routes.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { GET as listGET } from "./entities/[entity]/route";
import { GET as searchGET } from "./search/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zqportee${Date.now()}`;
const users: string[] = [];
let clientId = "";
let cle = "";
let maVisite = "";

const appel = (url: string) => new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${cle}` } });

suite("API v1 — la recherche plein texte reste dans la portée de l'identité", () => {
  beforeAll(async () => {
    const [moi, autre] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    users.push(moi.id, autre.id);
    maVisite = (await prisma.medicalVisit.create({ data: { date: new Date(), delegateId: moi.id, objective: `${TAG} la mienne` } })).id;
    await prisma.medicalVisit.create({ data: { date: new Date(), delegateId: autre.id, objective: `${TAG} celle d'un collègue`, report: "compte rendu confidentiel" } });
    const k = generateApiKey();
    cle = k.key;
    clientId = (await prisma.apiClient.create({ data: { name: TAG, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: ["erp.read", "erp.search"], actAsUserId: moi.id } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.apiCall.deleteMany({ where: { clientId } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: clientId } }).catch(() => undefined);
    await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: users } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
  }, 60_000);

  it("la portée « mes visites » s'applique d'abord (sans recherche)", async () => {
    const r = await listGET(appel(`/api/v1/entities/medical_visit`), { params: Promise.resolve({ entity: "medical_visit" }) });
    const body = await r.json();
    expect(r.status).toBe(200);
    const ids = (body.data.items as { id: string }[]).map((v) => v.id);
    expect(ids).toContain(maVisite);
    expect(body.data.items.every((v: { delegateId: string }) => v.delegateId === users[0])).toBe(true);
  });

  it("`?q=` ne rend pas la visite d'un collègue (liste)", async () => {
    const r = await listGET(appel(`/api/v1/entities/medical_visit?q=${TAG}`), { params: Promise.resolve({ entity: "medical_visit" }) });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect((body.data.items as { id: string }[]).map((v) => v.id)).toEqual([maVisite]);
  });

  it("`/search?q=` ne rend pas la visite d'un collègue", async () => {
    const r = await searchGET(appel(`/api/v1/search?q=${TAG}&entities=medical_visit`), { params: Promise.resolve({}) });
    const body = await r.json();
    expect(r.status).toBe(200);
    const groupe = (body.data.results as { entity: string; items: { id: string }[] }[]).find((g) => g.entity === "medical_visit");
    expect(groupe).toBeTruthy();
    if (!groupe) return;
    expect(groupe.items.map((i) => i.id)).toEqual([maVisite]);
  });
});
