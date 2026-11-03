import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getGoogleStatus, saveGoogleConnection } from "./connection";
import { GOOGLE_SCOPES } from "./config";

/**
 * LA PREUVE EN BASE — le critère d'acceptation, pas seulement la fonction pure.
 *
 * `scopes.test.ts` prouve que la comparaison est juste. Ici on prouve que le CHEMIN RÉEL l'est
 * aussi : ce qu'un consentement écrit dans `GoogleConnection`, et ce que l'écran de réglages
 * lit ensuite. C'est la différence entre « le calcul est bon » et « l'écran affiche AUCUN droit
 * manquant » — et c'est le second que le PDG regarde.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__gscope__${Date.now()}`;

/** Le champ `scope` tel que Google le rend réellement — URI canoniques, pas noms courts. */
const SCOPES_RENDUS_PAR_GOOGLE = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

async function utilisateurJetable(): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `${TAG}-${Math.random().toString(36).slice(2)}@example.test`,
      name: "Compte de test — droits Google",
      role: "SUPER_ADMIN",
      passwordHash: "x",
    },
    select: { id: true },
  });
  return u.id;
}

const cree: string[] = [];

afterEach(async () => {
  if (!dbOk) return;
  await prisma.googleConnection.deleteMany({ where: { userId: { in: cree } } });
});

afterAll(async () => {
  if (!dbOk) return;
  await prisma.googleConnection.deleteMany({ where: { userId: { in: cree } } });
  await retirerComptesEtSemis({ where: { id: { in: cree } } });
});

suite("connexion Google — l'écran de réglages après un vrai consentement", () => {
  it("après le consentement complet d'Adam : AUCUN droit manquant", async () => {
    const userId = await utilisateurJetable();
    cree.push(userId);

    await saveGoogleConnection({
      userId,
      address: "adam.executive.ai@gmail.com",
      displayName: "Adam",
      googleSub: "sub-1",
      tokens: {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: SCOPES_RENDUS_PAR_GOOGLE,
        idToken: null,
      },
    });

    const status = await getGoogleStatus(userId);
    expect(status.connected).toBe(true);
    expect(status.address).toBe("adam.executive.ai@gmail.com");
    // LE critère d'acceptation : « Droits manquants : AUCUN ».
    expect(status.missingScopes).toEqual([]);
    expect(status.hasRefreshToken).toBe(true);
  });

  it("une RECONNEXION qui ne rend qu'un droit ne fait pas perdre les autres", async () => {
    const userId = await utilisateurJetable();
    cree.push(userId);

    // Premier consentement : tout sauf l'agenda.
    const sansAgenda = SCOPES_RENDUS_PAR_GOOGLE.replace("https://www.googleapis.com/auth/calendar ", "");
    await saveGoogleConnection({
      userId, address: "adam.executive.ai@gmail.com", displayName: "Adam", googleSub: "sub-1",
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000), scopes: sansAgenda, idToken: null },
    });
    expect((await getGoogleStatus(userId)).missingScopes).toEqual([
      "https://www.googleapis.com/auth/calendar",
    ]);

    // Reconnexion incrémentale : Google ne mentionne que l'agenda, et ne rend PAS de nouveau
    // jeton de rafraîchissement (il ne le fait qu'au premier consentement).
    await saveGoogleConnection({
      userId, address: "adam.executive.ai@gmail.com", displayName: "Adam", googleSub: "sub-1",
      tokens: {
        accessToken: "at-2", refreshToken: null, expiresAt: new Date(Date.now() + 3600_000),
        scopes: "https://www.googleapis.com/auth/calendar", idToken: null,
      },
    });

    const apres = await getGoogleStatus(userId);
    expect(apres.missingScopes).toEqual([]);
    // Le jeton de rafraîchissement d'origine survit : sans lui, la boîte tomberait le lendemain.
    expect(apres.hasRefreshToken).toBe(true);
    expect(apres.grantedScopes.length).toBeGreaterThanOrEqual(GOOGLE_SCOPES.length);
  });

  it("sans connexion, TOUS les droits sont annoncés manquants", async () => {
    const userId = await utilisateurJetable();
    cree.push(userId);
    const status = await getGoogleStatus(userId);
    expect(status.connected).toBe(false);
    expect(status.missingScopes).toEqual([...GOOGLE_SCOPES]);
  });

  it("un consentement réellement partiel reste signalé — l'alerte n'est pas muselée", async () => {
    const userId = await utilisateurJetable();
    cree.push(userId);
    await saveGoogleConnection({
      userId, address: "adam.executive.ai@gmail.com", displayName: "Adam", googleSub: "sub-1",
      tokens: {
        accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000),
        scopes: "openid https://www.googleapis.com/auth/userinfo.email",
        idToken: null,
      },
    });
    const status = await getGoogleStatus(userId);
    expect(status.missingScopes).toContain("profile");
    expect(status.missingScopes).toContain("https://www.googleapis.com/auth/gmail.modify");
  });
});
