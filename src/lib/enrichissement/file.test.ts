import { describe, expect, it } from "vitest";
import {
  ESSAIS_MAX, TAILLE_MAX_ENRICHISSEMENT, cleTache, confidentialitePourEnrichissement, conflitIdDe, extensionDe, extractionIdDe,
  faitConfirmeIdDe, faitProposeIdDe, issueApresEchec, pieceIdDe, raisonDIgnorer, sourceDeLEntite,
} from "./file";
import { cleRattachement } from "./depot";

const SHA = "a".repeat(64);
const R = { type: "AD_PRO_ITEM", id: "p1", role: "id_document" };

describe("la file — clés et identifiants dérivés", () => {
  it("la clé d'une tâche est celle de PIECE_DEPOSEE ; un dépôt direct a la sienne tant que l'empreinte manque", () => {
    expect(cleTache(SHA, "b1", R)).toBe(cleRattachement(SHA, R));
    expect(cleTache(null, "b1", R)).toBe(cleRattachement("direct:b1", R));
  });

  it("les identifiants se dérivent de ce qui les cause — rejouer vise les mêmes lignes", () => {
    const piece = pieceIdDe(SHA);
    const ext = extractionIdDe(piece);
    expect(extractionIdDe(pieceIdDe(SHA))).toBe(ext);
    expect(faitProposeIdDe(ext, 3)).toBe(`${ext}_f3`);
    expect(faitConfirmeIdDe(faitProposeIdDe(ext, 3))).not.toBe(conflitIdDe(faitProposeIdDe(ext, 3)));
  });
});

describe("la file — reprise après échec", () => {
  const t0 = new Date("2026-10-27T10:00:00Z");
  it("réessaie à intervalles croissants, puis abandonne en le disant", () => {
    const attentes = [1, 2, 3, 4].map((n) => issueApresEchec(n, t0).prochainEssaiLe.getTime() - t0.getTime());
    expect(attentes).toEqual([...attentes].sort((a, b) => a - b));
    expect(new Set(attentes).size).toBe(4);
    expect(issueApresEchec(1, t0).statut).toBe("A_FAIRE");
    expect(issueApresEchec(ESSAIS_MAX, t0).statut).toBe("ECHEC");
  });
});

describe("la file — ce qui ne se lit pas est ignoré, pas en échec", () => {
  const formats = ["pdf", "png"];
  it("trop lourd, vide ou sans lecteur : une raison ; sinon rien", () => {
    expect(raisonDIgnorer({ taille: TAILLE_MAX_ENRICHISSEMENT + 1, mime: "application/pdf", nomFichier: "a.pdf" }, formats)).toMatch(/Mo/);
    expect(raisonDIgnorer({ taille: 0, mime: "application/pdf", nomFichier: "a.pdf" }, formats)).toMatch(/vide/);
    expect(raisonDIgnorer({ taille: 10, mime: "application/zip", nomFichier: "a.zip" }, formats)).toMatch(/zip/);
    expect(raisonDIgnorer({ taille: 10, mime: "image/png", nomFichier: "*" }, formats)).toBeNull();
  });
  it("l'extension se lit au nom, même réduit (« *.pdf »), sinon au type MIME", () => {
    expect(extensionDe("*.PDF", "")).toBe("pdf");
    expect(extensionDe("scan", "image/jpeg")).toBe("jpg");
  });
});

describe("la source et la confidentialité d'un document de module", () => {
  it("la source suit la fiche porteuse", () => {
    expect(sourceDeLEntite("AD_PRO_ITEM")).toBe("ADPRO");
    expect(sourceDeLEntite("EMPLOYEE")).toBe("RH");
    expect(sourceDeLEntite("LEGAL_DOCUMENT")).toBe("LEGAL");
    expect(sourceDeLEntite("SPONSORING")).toBe("AUTRE_MODULE");
  });
  it("une pièce d'identité ou RH est CONFIDENTIELLE pour l'enrichissement ; jamais moins stricte que le document", () => {
    expect(confidentialitePourEnrichissement("INTERNAL", { category: "ID_DOCUMENT", entityType: "AD_PRO_ITEM" })).toBe("CONFIDENTIAL");
    expect(confidentialitePourEnrichissement("INTERNAL", { category: "OTHER", entityType: "EMPLOYEE" })).toBe("CONFIDENTIAL");
    expect(confidentialitePourEnrichissement("INTERNAL", { category: "OTHER", entityType: "RECRUITMENT_CANDIDATE" })).toBe("RESTRICTED");
    expect(confidentialitePourEnrichissement("CONFIDENTIAL", { category: "QUOTE", entityType: "AD_PRO_ITEM" })).toBe("CONFIDENTIAL");
    expect(confidentialitePourEnrichissement("INTERNAL", { category: "QUOTE", entityType: "AD_PRO_ITEM" })).toBe("INTERNAL");
  });
});
