import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { createAccountWithInvite, issueInvite, inviteState, redeemInvite, INVITE_TTL_HOURS } from "./user-invites";

/**
 * INVITATION DE COMPTE — la règle absolue : AUCUN mot de passe ne transite (ni chat, ni admin).
 * Ces goldens verrouillent : compte inconnectable tant que le lien n'est pas utilisé, lien à
 * usage unique, expiration, réémission qui invalide l'ancien lien, e-mail dupliqué refusé.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__inv__${Date.now()}`;
let adminId = "";

suite("création de compte par lien d'invitation (jamais de mot de passe transmis)", () => {
  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    adminId = admin.id;
  });
  afterAll(async () => {
    await prisma.userInvite.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("crée le compte INCONNECTABLE + un lien 72 h ; l'e-mail dupliqué est refusé", async () => {
    const r = await createAccountWithInvite({ name: `${TAG} Sara`, email: `${TAG}sara@t.dz`, role: "VIEWER" }, adminId);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.path).toBe(`/invite/${r.token}`);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + (INVITE_TTL_HOURS - 1) * 3_600_000);

    const u = await prisma.user.findUnique({ where: { id: r.userId } });
    expect(u?.isActive).toBe(true);
    expect(u?.mustOnboard).toBe(true);
    // Le hash provient d'un secret aléatoire jamais renvoyé : aucun mot de passe « deviné » ne colle.
    expect(await bcrypt.compare("", u!.passwordHash)).toBe(false);
    expect(await bcrypt.compare(r.token, u!.passwordHash)).toBe(false);

    const dup = await createAccountWithInvite({ name: "X", email: `${TAG}sara@t.dz`, role: "VIEWER" }, adminId);
    expect("error" in dup && dup.error).toMatch(/existe déjà/);
  });

  it("la page lit l'état sans rien révéler d'exploitable ; le lien inconnu est « unknown »", async () => {
    const r = await createAccountWithInvite({ name: `${TAG} Yanis`, email: `${TAG}yanis@t.dz`, role: "VIEWER" }, adminId);
    if ("error" in r) throw new Error(r.error);
    const st = await inviteState(r.token);
    expect(st.valid).toBe(true);
    if (st.valid) expect(st.email).toBe(`${TAG}yanis@t.dz`);
    expect((await inviteState("token-bidon")).valid).toBe(false);
  });

  it("USAGE UNIQUE : le mot de passe se définit une fois — la 2e tentative est refusée, le login marche", async () => {
    const r = await createAccountWithInvite({ name: `${TAG} Lila`, email: `${TAG}lila@t.dz`, role: "VIEWER" }, adminId);
    if ("error" in r) throw new Error(r.error);

    expect((await redeemInvite(r.token, "court")).ok).toBe(false); // < 8 caractères
    const ok = await redeemInvite(r.token, "MotDePasse#2026");
    expect(ok.ok).toBe(true);

    const u = await prisma.user.findUnique({ where: { id: r.userId } });
    expect(await bcrypt.compare("MotDePasse#2026", u!.passwordHash)).toBe(true);
    expect(u?.mustChangePassword).toBe(false);

    const again = await redeemInvite(r.token, "AutreMotDePasse1");
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toMatch(/plus valable/);
    expect((await inviteState(r.token)).valid).toBe(false);
  });

  it("EXPIRATION : un lien périmé refuse ; la réémission invalide l'ancien lien et en donne un neuf", async () => {
    const r = await createAccountWithInvite({ name: `${TAG} Omar`, email: `${TAG}omar@t.dz`, role: "VIEWER" }, adminId);
    if ("error" in r) throw new Error(r.error);
    await prisma.userInvite.updateMany({ where: { token: r.token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeemInvite(r.token, "MotDePasse#2026")).ok).toBe(false);
    const st = await inviteState(r.token);
    expect(!st.valid && st.reason).toBe("expired");

    const renewed = await issueInvite(r.userId, adminId);
    expect(renewed.token).not.toBe(r.token);
    expect((await inviteState(r.token)).valid).toBe(false); // l'ancien lien N'EXISTE plus
    expect((await inviteState(renewed.token)).valid).toBe(true);
    expect((await redeemInvite(renewed.token, "MotDePasse#2026")).ok).toBe(true);
  });
});
