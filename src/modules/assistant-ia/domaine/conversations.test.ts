import { describe, expect, it } from "vitest";
import {
  expireLe, extraitAutour, grouperConversations, nettoyerTitre, refusChangerPrive, termeDeRecherche, titreProvisoire, type ConversationResumee,
} from "./conversations";
import { lireDocuments, sectionDossier } from "./dossiers";

const c = (id: string, dernierLe: string, extra: Partial<ConversationResumee> = {}): ConversationResumee =>
  ({ id, titre: id, prive: false, epingle: false, archive: false, dossierId: null, dernierLe, ...extra });

describe("conversations — règles pures (décision 0027)", () => {
  it("regroupe : Épinglées, Aujourd'hui (jour d'Alger), 7 derniers jours, Plus ancien ; sans les archivées", () => {
    const maintenant = new Date("2026-10-30T10:00:00Z");
    const g = grouperConversations([
      c("vieille", "2026-10-01T10:00:00Z"),
      c("hier", "2026-10-29T22:30:00Z"), // 23 h 30 à Alger : hier
      c("minuit", "2026-10-29T23:30:00Z"), // 0 h 30 à Alger : aujourd'hui
      c("matin", "2026-10-30T08:00:00Z"),
      c("epinglee", "2026-09-01T08:00:00Z", { epingle: true }),
      c("archivee", "2026-10-30T09:00:00Z", { archive: true }),
    ], maintenant);
    expect(g.map((x) => [x.groupe, x.conversations.map((y) => y.id)])).toEqual([
      ["Épinglées", ["epinglee"]],
      ["Aujourd'hui", ["matin", "minuit"]],
      ["7 derniers jours", ["hier"]],
      ["Plus ancien", ["vieille"]],
    ]);
  });

  it("titre provisoire coupé à un mot ; titre du modèle nettoyé (guillemets, ponctuation, longueur)", () => {
    expect(titreProvisoire("Combien il reste sur l'enveloppe du congrès d'Oran ?")).toBe("Combien il reste sur l'enveloppe du…");
    expect(titreProvisoire("Bonjour")).toBe("Bonjour");
    expect(titreProvisoire("", true)).toBe("Message vocal");
    expect(nettoyerTitre("« Budget congrès d'Oran ».\n")).toBe("Budget congrès d'Oran");
    expect(nettoyerTitre("   ")).toBeNull();
    expect(nettoyerTitre("x".repeat(200))!.length).toBe(80);
  });

  it("privée : réglable seulement avant le premier message ; expire 30 jours après sa création", () => {
    expect(refusChangerPrive(0)).toBeNull();
    expect(refusChangerPrive(1)).toMatch(/ne peut plus devenir privée/);
    expect(expireLe(new Date("2026-10-01T00:00:00Z")).toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("recherche : deux caractères au moins ; extrait autour du terme, accents ignorés", () => {
    expect(termeDeRecherche(" a ")).toBeNull();
    expect(termeDeRecherche("  congrès   Oran ")).toBe("congrès Oran");
    const t = `${"x ".repeat(80)}le congrès d'Oran coûte cher${" y".repeat(80)}`;
    const e = extraitAutour(t, "CONGRES");
    expect(e).toContain("congrès d'Oran");
    expect(e.startsWith("…") && e.endsWith("…")).toBe(true);
  });

  it("dossier : documents dédoublonnés et bornés ; la section dit que les consignes ne lèvent aucune règle", () => {
    expect(lireDocuments([{ id: "a", nom: "A" }, { id: "a", nom: "A bis" }, { nom: "sans id" }, "x"])).toEqual([{ id: "a", nom: "A" }]);
    expect(lireDocuments(null)).toEqual([]);
    const s = sectionDossier({ nom: "Congrès", consignes: "En tableau.", documents: [{ id: "c1", nom: "programme.pdf" }] })!;
    expect(s).toContain("DOSSIER « Congrès »");
    expect(s).toContain("AUCUNE des règles");
    expect(s).toContain("« programme.pdf » (identifiant c1)");
    expect(sectionDossier(null)).toBeNull();
  });
});
