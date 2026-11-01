import { describe, expect, it } from "vitest";
import { lireNotificationWhatsApp, nomDuMedia, signatureWhatsAppValide, signerCommeMeta, verifierAbonnement, telechargerMediaWhatsApp } from "./whatsapp";
import { destinatairesDuCourrier, entetesDuCourrier, piecesDuCourrier } from "./courrier";

/** La charge réelle d'une notification « messages » de l'API Cloud de Meta (document + statut de remise). */
const CHARGE = {
  object: "whatsapp_business_account",
  entry: [{
    id: "102290129340398",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
        contacts: [{ profile: { name: "Amine" }, wa_id: "213555987654" }],
        messages: [
          { from: "213555987654", id: "wamid.A1", timestamp: "1761904800", type: "document", document: { filename: "Lettre.pdf", mime_type: "application/pdf", sha256: "x", id: "M1", caption: "la lettre" } },
          { from: "213555987654", id: "wamid.A2", timestamp: "1761904801", type: "image", image: { mime_type: "image/jpeg", sha256: "y", id: "M2" } },
          { from: "213555987654", id: "wamid.A3", timestamp: "1761904802", type: "text", text: { body: "bonjour" } },
        ],
        statuses: [{ id: "wamid.S", status: "delivered", recipient_id: "213555987654" }],
      },
    }],
  }],
};

describe("K6 — le canal WhatsApp (socle)", () => {
  it("signature : vraie acceptée, fausse ou absente refusée, sans secret rien n'entre", () => {
    const brut = JSON.stringify(CHARGE);
    expect(signatureWhatsAppValide(brut, signerCommeMeta(brut, "s"), "s")).toBe(true);
    expect(signatureWhatsAppValide(brut, signerCommeMeta(brut, "autre"), "s")).toBe(false);
    expect(signatureWhatsAppValide(`${brut} `, signerCommeMeta(brut, "s"), "s")).toBe(false);
    expect(signatureWhatsAppValide(brut, null, "s")).toBe(false);
    expect(signatureWhatsAppValide(brut, signerCommeMeta(brut, "s"), "")).toBe(false);
    expect(signatureWhatsAppValide(brut, "sha256=zz", "s")).toBe(false);
  });

  it("abonnement : le défi au bon jeton seulement", () => {
    const p = (j: string, m = "subscribe") => new URLSearchParams({ "hub.mode": m, "hub.verify_token": j, "hub.challenge": "42" });
    expect(verifierAbonnement(p("jeton"), "jeton")).toBe("42");
    expect(verifierAbonnement(p("autre"), "jeton")).toBeNull();
    expect(verifierAbonnement(p("jeton", "unsubscribe"), "jeton")).toBeNull();
    expect(verifierAbonnement(p(""), "")).toBeNull();
  });

  it("lecture : les messages (les statuts ignorés), média, légende, profil", () => {
    const m = lireNotificationWhatsApp(CHARGE);
    expect(m.map((x) => x.sorte)).toEqual(["document", "image", "text"]);
    expect(m[0]).toMatchObject({ id: "wamid.A1", de: "213555987654", nomProfil: "Amine", texte: "la lettre", media: { id: "M1", nom: "Lettre.pdf", mime: "application/pdf" } });
    expect(m[2]).toMatchObject({ texte: "bonjour", media: null });
    expect(nomDuMedia(m[0]!)).toBe("Lettre.pdf");
    expect(nomDuMedia(m[1]!)).toMatch(/^WhatsApp \d\d-\d\d-2025 \d\dh\d\d\.jpg$/);
    expect(lireNotificationWhatsApp({ foo: 1 })).toEqual([]);
  });

  it("média : deux appels avec le jeton, taille bornée avant et pendant", async () => {
    const vus: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      vus.push(`${url} ${(init?.headers as Record<string, string>)?.authorization}`);
      return url.endsWith("/M1") ? Response.json({ url: "https://cdn.test/m1", mime_type: "application/pdf", file_size: 5 }) : new Response("%PDF-");
    }) as unknown as typeof fetch;
    const cfg = { base: "https://graph.test/v21.0", jeton: "T", telephoneId: "1" };
    const r = await telechargerMediaWhatsApp(cfg, "M1", 100, f);
    expect(r.ok && r.octets.toString()).toBe("%PDF-");
    expect(vus).toEqual(["https://graph.test/v21.0/M1 Bearer T", "https://cdn.test/m1 Bearer T"]);
    const trop = await telechargerMediaWhatsApp(cfg, "M1", 3, f);
    expect(trop).toMatchObject({ ok: false, trop: true });
  });
});

describe("K6 — les pièces d'un courrier entrant (socle)", () => {
  it("Postmark : destinataires, en-têtes, pièces en base64", () => {
    const p = {
      To: "Assistant <assistant@adventum.dz>", Cc: "x@y.dz", ToFull: [{ Email: "assistant@adventum.dz" }],
      Headers: [{ Name: "Auto-Submitted", Value: "no" }],
      Attachments: [{ Name: "Lettre.pdf", Content: Buffer.from("%PDF").toString("base64"), ContentType: "application/pdf", ContentLength: 4 }],
    };
    expect(destinatairesDuCourrier(p)).toEqual(["assistant@adventum.dz", "x@y.dz"]);
    expect(entetesDuCourrier(p)["auto-submitted"]).toBe("no");
    expect(piecesDuCourrier(p)[0]).toMatchObject({ nom: "Lettre.pdf", mime: "application/pdf", taille: 4 });
    expect(piecesDuCourrier(p)[0]!.octets!.toString()).toBe("%PDF");
  });

  it("forme générique (Resend) : sans contenu, la pièce est rendue sans octets (la réception le dit)", () => {
    const p = { data: { to: ["assistant@adventum.dz"], attachments: [{ filename: "a/b.pdf", content_type: "application/pdf", size: 12 }] } };
    expect(destinatairesDuCourrier(p)).toEqual(["assistant@adventum.dz"]);
    expect(piecesDuCourrier(p)[0]).toEqual({ nom: "a_b.pdf", mime: "application/pdf", octets: null, taille: 12 });
  });
});
