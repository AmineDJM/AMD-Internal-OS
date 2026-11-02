import { describe, expect, it } from "vitest";
import {
  cleRattachement, clesDeCharge, composerCharge, lireChargePieceDeposee, nomPourRegistre,
  normaliserEmpreinte, planifierEmission, validerDepot, type PieceDeposeeInput,
} from "./depot";

const SHA = "a".repeat(64);
const base = (o: Partial<PieceDeposeeInput> = {}): PieceDeposeeInput => ({
  blobId: "blob-1", empreinte: SHA, nomFichier: "devis.pdf", mime: "application/pdf", taille: 1200,
  source: "ADPRO", deposeParId: "u1", confidentialite: "INTERNAL",
  rattachements: [{ type: "AD_PRO_ITEM", id: "poste-1", role: "devis" }], ...o,
});

describe("le dépôt d'une pièce — validation", () => {
  it("normalise l'empreinte (casse, préfixe) et refuse ce qui n'est pas un SHA-256", () => {
    expect(normaliserEmpreinte(`sha256:${"A".repeat(64)}`)).toBe(SHA);
    expect(normaliserEmpreinte("direct:drive/objet-123")).toBeNull();
    expect(validerDepot(base({ empreinte: "direct:drive/x" }))).toEqual({ ok: false, raison: "empreinte absente ou non SHA-256" });
  });

  it("refuse un dépôt sans rattachement, sans blob, de source ou confidentialité inconnue", () => {
    expect(validerDepot(base({ rattachements: [] })).ok).toBe(false);
    expect(validerDepot(base({ blobId: "  " })).ok).toBe(false);
    expect(validerDepot(base({ source: "FAX" as never })).ok).toBe(false);
    expect(validerDepot(base({ confidentialite: "SECRET" as never })).ok).toBe(false);
    expect(validerDepot(base({ rattachements: [{ type: "poste", id: "", role: "x" }] })).ok).toBe(false);
  });

  it("dédoublonne les rattachements et normalise type et rôle", () => {
    const v = validerDepot(base({
      rattachements: [
        { type: "ad_pro_item", id: "poste-1", role: "Devis" },
        { type: "AD_PRO_ITEM", id: "poste-1", role: "devis" },
        { type: "PERSON", id: "p-9", role: "Pièce jointe" },
      ],
    }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.depot.rattachements).toEqual([
      { type: "AD_PRO_ITEM", id: "poste-1", role: "devis" },
      { type: "PERSON", id: "p-9", role: "pièce-jointe" },
    ]);
  });
});

describe("le dépôt d'une pièce — idempotence par (empreinte, rattachement)", () => {
  it("n'émet que les rattachements nouveaux", () => {
    const v = validerDepot(base({
      rattachements: [{ type: "AD_PRO_ITEM", id: "poste-1", role: "devis" }, { type: "AD_PRO_ITEM", id: "poste-2", role: "devis" }],
    }));
    if (!v.ok) throw new Error(v.raison);
    const deja = cleRattachement(SHA, { type: "AD_PRO_ITEM", id: "poste-1", role: "devis" });
    const plan = planifierEmission(v.depot, [deja]);
    expect(plan.dejaEmis).toBe(1);
    expect(plan.nouveaux).toEqual([{ type: "AD_PRO_ITEM", id: "poste-2", role: "devis" }]);
    expect(planifierEmission(v.depot, [deja, ...plan.cles]).nouveaux).toHaveLength(0);
  });

  it("le même fichier avec un AUTRE rôle sur le même sujet est un nouveau lien", () => {
    const a = cleRattachement(SHA, { type: "EMPLOYEE", id: "e1", role: "passeport" });
    const b = cleRattachement(SHA, { type: "EMPLOYEE", id: "e1", role: "visa" });
    expect(a).not.toBe(b);
  });
});

describe("le dépôt d'une pièce — la charge au registre", () => {
  it("réduit le nom d'une pièce confidentielle à son extension", () => {
    expect(nomPourRegistre("passeport_benali.PDF", "CONFIDENTIAL")).toBe("*.pdf");
    expect(nomPourRegistre("sans_extension", "CONFIDENTIAL")).toBe("*");
    expect(nomPourRegistre("devis.pdf", "RESTRICTED")).toBe("devis.pdf");
  });

  it("compose une charge relisible, et refuse une charge d'une autre version", () => {
    const v = validerDepot(base({ confidentialite: "CONFIDENTIAL", nomFichier: "paie_mars.xlsx" }));
    if (!v.ok) throw new Error(v.raison);
    const charge = composerCharge(v.depot, planifierEmission(v.depot, []));
    expect(charge.nomFichier).toBe("*.xlsx");
    expect(JSON.stringify(charge)).not.toContain("paie");
    const relue = lireChargePieceDeposee(JSON.parse(JSON.stringify(charge)));
    expect(relue?.cles).toEqual(charge.cles);
    expect(clesDeCharge(charge)).toHaveLength(1);
    expect(lireChargePieceDeposee({ ...charge, v: 2 })).toBeNull();
    expect(clesDeCharge(null)).toEqual([]);
  });
});
