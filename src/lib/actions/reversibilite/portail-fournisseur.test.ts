import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10b (décision 0040) — LE PORTAIL FOURNISSEUR : la connexion et la déconnexion se défont l'une par l'autre.
 *
 * Le portail n'a pas de session ERP (un fournisseur n'est pas une personne de l'ERP) : pas de journal des effets à son nom.
 * Sa compensation est le geste INVERSE, déclaré « compensation-metier » : se connecter → se déconnecter défait la session ;
 * se déconnecter → se reconnecter la rend. La trace de sécurité (date de dernière connexion, audit) reste : elle ne
 * s'efface pas. La session (le cookie) est observée par un faux `supplier-auth` — le reste est la vraie action.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const session = { courante: null as null | { u: string; s: string } };
vi.mock("@/lib/supplier-auth", () => ({
  setSupplierSession: async (u: string, s: string) => { session.courante = { u, s }; },
  clearSupplierSession: async () => { session.courante = null; },
}));

import { prisma } from "@/lib/prisma";
import { cleConnexionPortail } from "@/lib/login-throttle";
import { DECLARATIONS_COMMUNICATIONS } from "@/lib/effets/declarations/communications";
import { supplierLogin, supplierLogout } from "../supplier-portal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zk10bportail${Date.now().toString(36)}`;
const email = `${TAG}@fournisseur.dz`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let fournisseur = "";

suite("K10b — portail fournisseur : connexion et déconnexion, chacune défaite par l'autre", () => {
  beforeAll(async () => {
    fournisseur = (await prisma.supplier.create({ data: { name: `${TAG} Atlas` } })).id;
    await prisma.supplierUser.create({ data: { supplierId: fournisseur, email, name: email, passwordHash: await bcrypt.hash("bon-secret", 4) } });
  });
  afterAll(async () => {
    await prisma.loginAttempt.deleteMany({ where: { email: cleConnexionPortail(email) } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { entityId: fournisseur } }).catch(() => undefined);
    await prisma.supplierUser.deleteMany({ where: { supplierId: fournisseur } }).catch(() => undefined);
    await prisma.supplier.deleteMany({ where: { id: fournisseur } }).catch(() => undefined);
  });

  it("les deux actions sont déclarées « compensation » par leur geste inverse", () => {
    for (const id of ["supplier-portal-actions:supplierLogin", "supplier-portal-actions:supplierLogout"]) {
      expect(DECLARATIONS_COMMUNICATIONS[id]).toMatchObject({ annulation: "compensation", mecanisme: "compensation-metier" });
    }
  });

  it("se connecter, puis l'annuler (se déconnecter) : la session est défaite, la trace de sécurité reste ; rétablir (se reconnecter) la rend", async () => {
    expect((await supplierLogin(undefined, fd({ email, password: "bon-secret" }))).ok).toBe(true);
    const u = await prisma.supplierUser.findUniqueOrThrow({ where: { email } });
    expect(session.courante).toEqual({ u: u.id, s: fournisseur });
    expect(u.lastLoginAt).not.toBeNull();
    // L'annulation de la connexion : la déconnexion.
    expect((await supplierLogout()).ok).toBe(true);
    expect(session.courante).toBeNull();
    expect((await prisma.supplierUser.findUniqueOrThrow({ where: { email } })).lastLoginAt).toEqual(u.lastLoginAt);
    expect(await prisma.auditLog.count({ where: { entityId: fournisseur, action: "LOGIN" } })).toBe(1);
    // Rétablir : se reconnecter.
    expect((await supplierLogin(undefined, fd({ email, password: "bon-secret" }))).ok).toBe(true);
    expect(session.courante).toEqual({ u: u.id, s: fournisseur });
    // Et l'annulation de la déconnexion est la reconnexion : symétrique.
    await supplierLogout();
    expect(session.courante).toBeNull();
  });
});
