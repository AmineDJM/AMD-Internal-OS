import { describe, expect, it } from "vitest";
import { lignesDeLaVision, numerotationFiable } from "@/lib/pieces-lues/vision-lignes";
import { cadreDeLEncre } from "@/lib/pieces-lues/images-vision";
import { pdfEstUnScan } from "@/lib/pieces-lues/positions";
import { BANC_DEVIS, fichierDuDevis, scanner } from "@/lib/pieces-lues/banc/devis-fabriques";
import { VISION_DU_TICKET, ticketScanne } from "@/lib/pieces-lues/banc/ticket-fabrique";

/**
 * UN SCAN SE LIT SUR SON IMAGE (Moyens généraux, 09/11/2026) — les règles pures. Le cas réel : un ticket de caisse de
 * 15 articles, scanné sur une page A4 avec la couche texte du scanner (décimales perdues), ressorti en 6 lignes aux
 * montants centuplés. Banc de bout en bout : `banc/banc-ticket.test.ts`.
 */

const TICKET_VISION = VISION_DU_TICKET;

describe("la vision d'un ticket : tous les articles, aux bons montants", () => {
  it("une quantité recopiée comme numéro n'est pas une numérotation", () => {
    const lues = TICKET_VISION.lignes.map((l) => ({ numero: Number(l.numero), designation: l.designation }));
    expect(numerotationFiable(lues)).toBe(false);
    expect(numerotationFiable([1, 2, 3].map((n) => ({ numero: n, designation: `article ${n}` })))).toBe(true);
    // Une page dupliquée répète un numéro sur la MÊME désignation : la numérotation reste celle de la pièce.
    expect(numerotationFiable([{ numero: 1, designation: "A" }, { numero: 2, designation: "B" }, { numero: 2, designation: "b" }])).toBe(true);
    // Un numéro manquant, ou qui redescend : pas fiable.
    expect(numerotationFiable([{ numero: 1, designation: "A" }, { numero: Number.NaN, designation: "B" }])).toBe(false);
    expect(numerotationFiable([{ numero: 2, designation: "A" }, { numero: 1, designation: "B" }])).toBe(false);
  });

  it("les 15 articles du ticket ressortent, sans doublon supposé, et font le total imprimé", () => {
    const t = lignesDeLaVision(TICKET_VISION, "vision-test");
    expect(t.lignes).toHaveLength(15);
    expect(t.lignes.map((l) => l.numero)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(t.lignes.flatMap((l) => l.doutes)).toEqual([]);
    expect(t.trous).toEqual([]);
    expect(t.lignes[0]).toMatchObject({ designation: "DIZOL DETARTRANT 700ML", quantite: 2, prixUnitaire: 230, montant: 460 });
    expect(t.lignes[3]).toMatchObject({ quantite: 2, prixUnitaire: 680, montant: 1360 });
    expect(t.lignes.reduce((s, l) => s + (l.montant ?? 0), 0)).toBe(7650);
    expect(t.totalHt).toBe(7650);
  });
});

describe("le recadrage sur la pièce : le ticket remplit l'image, les poussières n'y comptent pas", () => {
  it("un ticket dans le quart haut-gauche d'une page blanche, une poussière à droite", () => {
    const L = 400, H = 600;
    const gris = new Uint8Array(L * H).fill(255);
    for (let y = 30; y < 330; y++) for (let x = 20; x < 150; x++) if ((x + y) % 3 === 0) gris[y * L + x] = 20;
    gris[300 * L + 380] = 0; // une poussière de scan
    const c = cadreDeLEncre(gris, L, H)!;
    expect(c).not.toBeNull();
    expect(c.gauche).toBeLessThanOrEqual(20);
    expect(c.gauche + c.largeur).toBeLessThan(200);
    expect(c.haut + c.hauteur).toBeLessThan(360);
  });

  it("une image qui est déjà la pièce (ou une photo) ne se recadre pas", () => {
    const L = 100, H = 100;
    const gris = new Uint8Array(L * H).fill(255);
    for (let y = 2; y < 98; y++) for (let x = 2; x < 98; x++) if ((x * y) % 4 === 0) gris[y * L + x] = 10;
    expect(cadreDeLEncre(gris, L, H)).toBeNull();
    expect(cadreDeLEncre(new Uint8Array(L * H).fill(255), L, H)).toBeNull();
  });
});

describe("un PDF qui est un scan se reconnaît — même s'il porte une couche texte", () => {
  it("un PDF natif n'est pas un scan ; le même rendu en image l'est", async () => {
    const d = BANC_DEVIS.find((x) => !x.scan)!;
    const natif = await fichierDuDevis(d);
    expect(await pdfEstUnScan(natif)).toBe(false);
    expect(await pdfEstUnScan(await scanner(natif))).toBe(true);
  }, 30_000);

  it("le ticket scanné avec la couche texte de son scanner est un scan", async () => {
    expect(await pdfEstUnScan(await ticketScanne("t"))).toBe(true);
  }, 30_000);

  it("des octets qui ne sont pas un PDF : pas un scan, sans lever", async () => {
    expect(await pdfEstUnScan(Buffer.from("pas un pdf"))).toBe(false);
  });
});
