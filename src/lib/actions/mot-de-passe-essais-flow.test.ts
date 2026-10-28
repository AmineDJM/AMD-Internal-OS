import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORTAIL FOURNISSEUR ET LE CHANGEMENT DE MOT DE PASSE ONT UNE LIMITE D'ESSAIS (audit 27/10/2026, SA-17).
 *
 * Seule la connexion de l'ERP comptait les échecs (`login-throttle.ts`). Le portail fournisseur et le changement
 * de mot de passe (« mot de passe actuel ») se devinaient à volonté. Après cinq échecs, même le BON mot de passe
 * est refusé le temps du verrou ; un témoin prouve qu'un compte non verrouillé passe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("@/lib/supplier-auth", () => ({ setSupplierSession: () => {}, clearSupplierSession: () => {} }));
let SESSION: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({ auth: async () => SESSION, signIn: async () => {}, signOut: async () => {} }));
vi.mock("@/lib/vue-exacte", () => ({ effacerVueExacte: () => {} }));

import { prisma } from "@/lib/prisma";
import { supplierLogin } from "./supplier-portal-actions";
import { changePassword } from "./auth-actions";
import { MAX_FAILURES, cleChangementMotDePasse, cleConnexionPortail } from "@/lib/login-throttle";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zessais${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ids = { fournisseur: "", salarie: "" };
const emails = { verrouille: `${TAG}v@fournisseur.dz`, temoin: `${TAG}t@fournisseur.dz` };

suite("Limite d'essais du mot de passe — portail fournisseur et changement de mot de passe", () => {
  beforeAll(async () => {
    const hash = await bcrypt.hash("bon-secret", 4);
    ids.fournisseur = (await prisma.supplier.create({ data: { name: `${TAG} Atlas` } })).id;
    await prisma.supplierUser.createMany({
      data: [emails.verrouille, emails.temoin].map((email) => ({ supplierId: ids.fournisseur, email, name: email, passwordHash: hash })),
    });
    ids.salarie = (await prisma.user.create({ data: { name: `${TAG} s`, email: `${TAG}s@t.dz`, role: "COORDINATOR", passwordHash: hash } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.loginAttempt.deleteMany({ where: { email: { in: [cleConnexionPortail(emails.verrouille), cleConnexionPortail(emails.temoin), cleChangementMotDePasse(ids.salarie)] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: ids.salarie } }).catch(() => {});
    await prisma.userSession.deleteMany({ where: { userId: ids.salarie } }).catch(() => {});
    await prisma.supplierUser.deleteMany({ where: { supplierId: ids.fournisseur } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { id: ids.fournisseur } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: ids.salarie } }).catch(() => {});
  }, 60_000);

  it("portail : après cinq échecs, le bon mot de passe est refusé ; un autre compte passe", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await supplierLogin(undefined, fd({ email: emails.verrouille, password: `faux-${i}` }))).ok).toBe(false);
    }
    expect((await supplierLogin(undefined, fd({ email: emails.verrouille, password: "bon-secret" }))).ok).toBe(false);
    expect((await supplierLogin(undefined, fd({ email: emails.temoin, password: "bon-secret" }))).ok).toBe(true);
  });

  it("changement de mot de passe : après cinq échecs, le bon mot de passe actuel est refusé", async () => {
    SESSION = { user: { id: ids.salarie } };
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(await changePassword(undefined, fd({ current: `faux-${i}`, next: "nouveau-secret", confirm: "nouveau-secret" }))).toBe("Mot de passe actuel incorrect.");
    }
    const r = await changePassword(undefined, fd({ current: "bon-secret", next: "nouveau-secret", confirm: "nouveau-secret" }));
    expect(r).toMatch(/Trop d'essais/);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: ids.salarie }, select: { passwordHash: true } });
    expect(await bcrypt.compare("bon-secret", u.passwordHash)).toBe(true);
  });
});
