import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleApiError } from "./client";

/**
 * LE CHOIX DU COMPTE ET LES REFUS — sans base ni réseau : la connexion lue en base et la
 * connexion active sont remplacées. Chaque cas doit rendre la phrase qui dit quoi connecter,
 * jamais une exception muette ni un lien inventé.
 */

const etat = vi.hoisted(() => ({
  compte: null as null | { userId: string; status: string; paused: boolean; grantedScopes: string | null },
  where: null as unknown,
  active: null as null | { id: string; userId: string; address: string; displayName: string | null; accessToken: string } | Error,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    googleConnection: {
      findFirst: async (args: { where: unknown }) => { etat.where = args.where; return etat.compte; },
    },
  },
}));
vi.mock("./connection", () => ({
  getActiveGoogleConnection: async () => {
    if (etat.active instanceof Error) throw etat.active;
    return etat.active;
  },
}));

const { genererLienMeetEntreprise } = await import("./meet-entreprise");

const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://erp.test/api/google/callback" };
const TOUS_DROITS = "openid https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify";
const DEMANDE = { titre: "Point hebdo", debut: "2026-11-25T09:00" };
const AUTEUR = { nom: "Test" };

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("GOOGLE_ADAM_EMAIL", "");
  etat.compte = { userId: "u-adam", status: "connected", paused: false, grantedScopes: TOUS_DROITS };
  etat.active = { id: "c1", userId: "u-adam", address: "adam@example.test", displayName: "Adam", accessToken: "jeton" };
  etat.where = null;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("le lien Meet de l'entreprise", () => {
  it("tout est en place : le lien rendu par Google, et le compte qui le porte", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "e", hangoutLink: "https://meet.google.com/abc-defg-hij" }), { status: 200 })));
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toEqual({ ok: true, lien: "https://meet.google.com/abc-defg-hij", compte: "adam@example.test" });
  });

  it("GOOGLE_ADAM_EMAIL posé : seule CETTE adresse est retenue", async () => {
    vi.stubEnv("GOOGLE_ADAM_EMAIL", "Adam@Example.test");
    etat.compte = null;
    await genererLienMeetEntreprise(DEMANDE, AUTEUR);
    expect(etat.where).toMatchObject({ address: { equals: "adam@example.test", mode: "insensitive" } });
  });

  it("serveur sans configuration Google", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ ok: false, raison: "non-configure" });
  });

  it("aucun compte connecté", async () => {
    etat.compte = null;
    const r = await genererLienMeetEntreprise(DEMANDE, AUTEUR);
    expect(r).toMatchObject({ ok: false, raison: "non-connecte" });
    expect(!r.ok && r.message).toContain("Connecter Google");
  });

  it("coupe-circuit, reconnexion due, droit d'agenda absent : chacun son refus", async () => {
    etat.compte = { userId: "u", status: "connected", paused: true, grantedScopes: TOUS_DROITS };
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ raison: "suspendu" });
    etat.compte = { userId: "u", status: "needs-reconnect", paused: false, grantedScopes: TOUS_DROITS };
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ raison: "reconnecter" });
    etat.compte = { userId: "u", status: "connected", paused: false, grantedScopes: "openid https://www.googleapis.com/auth/gmail.modify" };
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ raison: "droit-agenda" });
  });

  it("`calendar.events` seul suffit (le droit étroit)", async () => {
    etat.compte = { userId: "u", status: "connected", paused: false, grantedScopes: "https://www.googleapis.com/auth/calendar.events" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "e", hangoutLink: "https://meet.google.com/abc-defg-hij" }), { status: 200 })));
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ ok: true });
  });

  it("jeton qui ne se rafraîchit plus : reconnecter", async () => {
    etat.active = new GoogleApiError("unauthorized", 401, "refreshFailed");
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ ok: false, raison: "reconnecter" });
  });

  it("Google refuse l'écriture faute de droit : droit d'agenda", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 })));
    expect(await genererLienMeetEntreprise(DEMANDE, AUTEUR)).toMatchObject({ ok: false, raison: "droit-agenda" });
  });
});
