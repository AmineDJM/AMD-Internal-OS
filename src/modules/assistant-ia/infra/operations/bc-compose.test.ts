import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { BC_COMPOSE, lignesDictees } from "./bc-compose";
import { executerOperationIA } from "./";

/**
 * LE BC DICTÉ SANS PIÈCE (lot B1, audit Q1 BC-03) : « fais un BC à l'Imprimerie Atlas : 500 kakémonos à 2 000 DZD » →
 * une carte, pas une demande de fichier ; « Créer le BC (PDF) » → brouillon + PDF. Une enveloppe NOMMÉE que la personne
 * ne voit pas (BC-02) ne bloque pas : elle est gardée « à confirmer ».
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iabcc_${Date.now().toString(36)}_`;
let admin: CurrentUser;
let societeId = "";

suite("Assistant IA — bon de commande dicté, sans pièce", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    admin = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    ACTOR = admin;
    societeId = (await prisma.company.create({ data: { name: `${TAG}Adventum`, shortName: `${TAG}ADV` } })).id;
  });
  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { companyId: societeId }, select: { id: true } });
    await prisma.documentReference.deleteMany({ where: { companyId: societeId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: admin?.id } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: admin?.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("une ligne dictée incomplète se demande — rien n'est complété", () => {
    expect(lignesDictees({ lignes: [{ designation: "Kakémono", quantite: 500 }] }).incompletes).toEqual(["le prix unitaire HT de « Kakémono »"]);
  });

  it("500 kakémonos à 2 000 DZD chez un fournisseur hors annuaire, enveloppe « Marketing » invisible : une carte, puis le brouillon + PDF", async () => {
    const p = await BC_COMPOSE.proposer({
      fournisseur: `${TAG}Imprimerie Atlas`, lignes: [{ designation: "Kakémono 85 × 200 cm", quantite: 500, prixUnitaire: 2_000 }],
      societe: `${TAG}ADV`, enveloppe: `${TAG}Marketing`,
    }, admin);
    if (!("carte" in p)) throw new Error(`une question a été posée : ${JSON.stringify(p)}`);
    const champ = (l: string) => p.carte.fields.find((f) => f.label === l)?.value ?? "";
    expect(p.carte.libelleBouton).toBe("Créer le BC (PDF)");
    expect(champ("Fournisseur")).toMatch(/hors annuaire/);
    expect(champ("Total HT")).toMatch(/^1\s000\s000 DZD$/);
    expect(champ("Total TTC")).toMatch(/^1\s190\s000 DZD$/);
    expect(champ("Enveloppe proposée")).toBe(`« ${TAG}Marketing » (demandée — à confirmer à la validation)`);
    expect(champ("Validateur")).toMatch(/à désigner/);
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: BC_COMPOSE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/créé en brouillon .* PDF/);
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { companyId: societeId, kind: "PURCHASE_ORDER" } });
    expect(bc.counterparty).toBe(`${TAG}Imprimerie Atlas`);
    expect(bc.bcPrevalidationAt).not.toBeNull();
    expect((bc.custom as { bcAssistant: { origine: string; enveloppe: { nom: string } } }).bcAssistant).toMatchObject({ origine: "DICTE", enveloppe: { nom: `${TAG}Marketing` } });
  });
});
