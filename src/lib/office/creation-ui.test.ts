import { describe, it, expect } from "vitest";
import { executerCreationOffice, messageEchecCreation, MESSAGE_DELAI_CREATION } from "./creation-ui";

describe("Créer un document Office : l'appel finit toujours (plus de roue sans fin)", () => {
  it("succès → l'identifiant du document", async () => {
    expect(await executerCreationOffice(async () => ({ ok: true, id: "n1" }))).toEqual({ ok: true, id: "n1" });
  });

  it("refus du serveur → son message, tel quel", async () => {
    const r = await executerCreationOffice(async () => ({ ok: false, error: "Non autorisé." }));
    expect(r).toEqual({ ok: false, error: "Non autorisé." });
  });

  it("succès sans identifiant → une erreur, pas une navigation vers /drive/undefined", async () => {
    const r = await executerCreationOffice(async () => ({ ok: true }));
    expect(r.ok).toBe(false);
  });

  it("l'appel REJETTE (erreur serveur opaque) → une phrase en français, jamais une exception", async () => {
    const r = await executerCreationOffice(async () => { throw new Error("An error occurred in the Server Components render."); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'a pas pu être créé/);
  });

  it("l'appel lève SYNCHRONEMENT → rattrapé aussi", async () => {
    const r = await executerCreationOffice(() => { throw new Error("boum"); });
    expect(r.ok).toBe(false);
  });

  it("l'appel ne répond jamais → le délai rend la main, en prévenant qu'il a peut-être abouti", async () => {
    const r = await executerCreationOffice(() => new Promise(() => {}), 20);
    expect(r).toEqual({ ok: false, error: MESSAGE_DELAI_CREATION });
    expect(MESSAGE_DELAI_CREATION).toMatch(/peut-être été créé/);
  });

  it("onglet ouvert avant un déploiement → « rechargez la page »", () => {
    expect(messageEchecCreation(new Error('Failed to find Server Action "abc". This request might be from an older or newer deployment.'))).toMatch(/rechargez/);
  });

  it("connexion coupée → le dire", () => {
    expect(messageEchecCreation(new TypeError("Failed to fetch"))).toMatch(/connexion/);
  });
});
