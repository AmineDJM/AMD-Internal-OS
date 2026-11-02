import { describe, expect, it } from "vitest";
import { foldOrg, orgTokens, coreTokens, initialsOf, rankOrgCandidates, resolveOrg } from "./entity-normalize";

/**
 * GOLDEN RÉGRESSION — la résolution d'entités qui manquait en production :
 * « SD » devait retrouver « S.D. Pharmaceuticals », « SAI » la « Société Algérienne
 * d'Infectiologie » — sans JAMAIS fusionner deux sociétés réellement différentes.
 * Les noms de ces tests sont des FIXTURES, pas des règles : aucun nom n'est codé en dur
 * dans le module (§42 — les primitives sont générales).
 */

describe("normalisation d'organisations", () => {
  it("replie accents et ponctuation d'entreprise, recolle les sigles pointés", () => {
    expect(foldOrg("S.D. Pharmaceuticals")).toBe("s d pharmaceuticals");
    expect(orgTokens("S.D. Pharmaceuticals")).toEqual(["sd", "pharmaceuticals"]);
    expect(orgTokens("Société Algérienne d'Infectiologie")).toEqual(["societe", "algerienne", "infectiologie"]);
  });

  it("coreTokens retire le bruit corporate (Pharma, Laboratoires, SARL…), sans jamais vider le nom", () => {
    expect(coreTokens("Kwality Pharma")).toEqual(["kwality"]);
    expect(coreTokens("Laboratoires Alpha SARL")).toEqual(["alpha"]);
    expect(coreTokens("Pharma Group")).toEqual(["pharma", "group"]); // que du bruit → on garde tout
  });

  it("initiales sur les jetons significatifs — la matière des acronymes", () => {
    expect(initialsOf("Société Algérienne d'Infectiologie")).toBe("sai");
    expect(initialsOf("Association de Recherche en Oncologie")).toBe("aro");
  });
});

describe("résolution — un candidat s'impose OU les candidats remontent, jamais de fusion muette", () => {
  const partners = ["Kwality Pharma", "S.D. Pharmaceuticals", "Hetero Labs", "MSN Laboratories"];

  it("« SD » → « S.D. Pharmaceuticals » (identité de cœur), décisif", () => {
    const r = resolveOrg("SD", partners);
    expect(r.kind).toBe("decisive");
    expect(r.best?.value).toBe("S.D. Pharmaceuticals");
  });

  it("« sd pharma » et « S.D. Pharmaceuticals » convergent — graphies d'une même société", () => {
    const r = resolveOrg("sd pharma", partners);
    expect(r.kind).toBe("decisive");
    expect(r.best?.value).toBe("S.D. Pharmaceuticals");
  });

  it("« Kwality » → « Kwality Pharma », décisif", () => {
    const r = resolveOrg("Kwality", partners);
    expect(r.kind).toBe("decisive");
    expect(r.best?.value).toBe("Kwality Pharma");
  });

  it("un ACRONYME retrouve le nom complet : « SAI » ← « Société Algérienne d'Infectiologie »", () => {
    const orgs = ["Société Algérienne d'Infectiologie", "Société Algérienne de Cardiologie", "Forum El Djazair"];
    const ranked = rankOrgCandidates("SAI", orgs);
    expect(ranked[0]?.value).toBe("Société Algérienne d'Infectiologie");
    expect(ranked[0]?.why).toMatch(/acronyme/);
    // SAC existe aussi : SAI ne matche PAS la cardiologie (initiales ≠).
    expect(ranked.find((x) => x.value.includes("Cardiologie"))?.score ?? 0).toBeLessThan(0.85);
  });

  it("deux sociétés RÉELLEMENT différentes ne fusionnent jamais : requête trop vague → ambigu ou rien", () => {
    const r = resolveOrg("Pharma", ["Alpha Pharma", "Beta Pharma"]);
    expect(r.kind).not.toBe("decisive"); // choisir l'une des deux serait une erreur de gouvernance
  });

  it("aucun candidat crédible → none (et pas un score inventé)", () => {
    const r = resolveOrg("Zeppelin Quantique", ["Kwality Pharma", "Hetero Labs"]);
    expect(r.kind).toBe("none");
    expect(r.best).toBeNull();
  });

  it("les graphies d'une MÊME société ne créent pas d'ambiguïté artificielle", () => {
    const r = resolveOrg("SD", ["SD Pharma", "S.D. Pharmaceuticals"]);
    expect(r.kind).toBe("decisive"); // même cœur « sd » — un seul candidat logique
  });
});
