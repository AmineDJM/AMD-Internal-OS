import { describe, expect, it } from "vitest";
import { faitDurablePossible, garderCandidat, lireExtraction, normaliserSujet, similarite, SEUIL_DOUBLON, entreeExtracteur } from "./capture";
import { choisirSouvenirs, ENVELOPPES_MEMOIRE, sectionDuRappel, toutTient } from "./rappel";
import { estimerJetons } from "../assembleur";
import { GROUPES_MEMOIRE, SORTES_MEMOIRE } from "../memoire-ui";

/** M1 (décision 0045) — la capture et le rappel de la mémoire, règles pures. */
describe("mémoire — le filtre déterministe (aucun appel sans fait durable)", () => {
  it.each([
    "Je pars à Lyon le 12 avec ma fille Lina.",
    "Ma femme s'appelle Sarah et nous avons deux enfants.",
    "J'ai fait mon master à l'université de Constantine.",
    "J'adore le café noir et je joue au tennis le samedi.",
    "Retiens que je préfère les réponses courtes.",
    "Je suis allergique à la pénicilline.",
    "[Conversation vocale — transcription]\nmoi je vais en Espagne en juillet avec mon frère",
  ])("retient la possibilité : %s", (m) => expect(faitDurablePossible(m)).toBe(true));

  it.each([
    "Montre-moi les demandes en cours.",
    "Combien de bons de commande ce mois ?",
    "merci",
    "Liste les factures du fournisseur Biopharm.",
    "Quel est le budget marketing 2026 ?",
    "Tu te souviens de mon voyage ?",
  ])("ne dépense rien pour : %s", (m) => expect(faitDurablePossible(m)).toBe(false));
});

describe("mémoire — l'extracteur et sa garde", () => {
  it("lit le JSON strict, même entouré de ```json, et ignore une sorte inconnue", () => {
    const c = lireExtraction('```json\n{"souvenirs":[{"sorte":"VOYAGES","contenu":"Part à Lyon le 12 novembre avec sa fille Lina","sujet":"Voyage : Lyon","remplace":null},{"sorte":"INCONNUE","contenu":"x"}]}\n```');
    expect(c).toEqual([{ sorte: "VOYAGES", contenu: "Part à Lyon le 12 novembre avec sa fille Lina", sujet: "voyage:lyon", remplace: null }]);
    expect(lireExtraction("pas du json")).toEqual([]);
    expect(lireExtraction('{"souvenirs":[{"sorte":"FAMILLE","contenu":"Sa fille s\'appelle Lina","remplace":"m2"}]}')[0].remplace).toBe("m2");
  });

  it("garde les faits personnels que la personne a dits", () => {
    const msg = "Je pars à Lyon le 12 avec ma fille Lina.";
    expect(garderCandidat({ contenu: "Part à Lyon le 12 novembre 2026 avec sa fille Lina" }, msg, { aujourdhui: new Date("2026-11-01") })).toEqual({ ok: true });
    expect(garderCandidat({ contenu: "Sa fille s'appelle Lina" }, msg)).toEqual({ ok: true });
  });

  it("refuse une valeur confidentielle d'un tiers et ce que la personne n'a pas dit (lu dans la réponse, donc l'ERP)", () => {
    const msg = "Je travaille avec Karim sur le dossier export.";
    expect(garderCandidat({ contenu: "Le salaire de Karim est de 180 000 DZD" }, msg).ok).toBe(false);
    expect(garderCandidat({ contenu: "Travaille avec Karim Benali sur le dossier export" }, msg).ok).toBe(false);
    expect(garderCandidat({ contenu: "Son IBAN est enregistré" }, "mon iban change").ok).toBe(false);
    expect(garderCandidat({ contenu: "Part à Lyon le 14 novembre" }, "Je pars à Lyon le 12").ok).toBe(false);
  });

  it("dédoublonne les phrases presque identiques, pas un fait qui change", () => {
    expect(similarite("Sa fille s'appelle Lina", "Sa fille s'appelle Lina.")).toBeGreaterThanOrEqual(SEUIL_DOUBLON);
    expect(similarite("Part à Lyon le 12 novembre avec Lina", "Part à Marseille en décembre")).toBeLessThan(SEUIL_DOUBLON);
    expect(normaliserSujet("Famille : Fille")).toBe("famille:fille");
  });

  it("l'entrée reste courte : le message de la personne, borné — et rien de la réponse", () => {
    const e = entreeExtracteur({ message: "x".repeat(5_000), existants: [], aujourdhui: "dimanche 1 novembre 2026" });
    expect(e.length).toBeLessThan(1_600);
  });
});

describe("mémoire — le rappel par pertinence", () => {
  const souvenirs = [
    { id: "p1", sorte: "PERSONNEL_IDENTITE", contenu: "S'appelle Amine, directeur général, vit à Alger", rang: 0 },
    { id: "p2", sorte: "FAMILLE", contenu: "Sa fille s'appelle Lina", rang: 1 },
    ...Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, sorte: "WORKING_STYLE", contenu: `Habitude de travail numéro ${i} : relit les rapports hebdomadaires du service ${i} le matin`, rang: 2 + i })),
    { id: "v1", sorte: "VOYAGES", contenu: "Part à Lyon le 12 novembre avec sa fille Lina", rang: 90 },
  ];

  it("« tu te souviens de mon voyage ? » trouve Lyon (la sorte compte), le profil est toujours là", () => {
    const r = choisirSouvenirs(souvenirs, "tu te souviens de mon voyage ?");
    expect(r.pertinents[0].id).toBe("v1");
    expect(r.profil.map((s) => s.id)).toEqual(["p1", "p2"]);
  });

  it("l'enveloppe est tenue, quelle que soit la taille de la mémoire", () => {
    const r = choisirSouvenirs(souvenirs, "bonjour");
    expect(r.pertinents.reduce((s, x) => s + estimerJetons(x.contenu) + 1, 0)).toBeLessThanOrEqual(ENVELOPPES_MEMOIRE.pertinents);
    expect(r.ecartes).toBeGreaterThan(0);
    expect(toutTient(souvenirs)).toBe(false);
    expect(toutTient(souvenirs.slice(0, 3))).toBe(true);
  });

  it("le sens (plongement) départage quand les mots ne suffisent pas", () => {
    const sims = new Map([["v1", 0.9]]);
    expect(choisirSouvenirs(souvenirs, "et ce déplacement en France ?", { similarites: sims }).pertinents[0].id).toBe("v1");
  });

  it("la section dit le profil puis les souvenirs utiles", () => {
    const s = sectionDuRappel(choisirSouvenirs(souvenirs.slice(0, 2), "")) ?? "";
    expect(s).toContain("### MÉMOIRE DE L'INTERLOCUTEUR");
    expect(s).toContain("Sa fille s'appelle Lina");
    expect(sectionDuRappel({ profil: [], pertinents: [] })).toBeNull();
  });

  it("chaque sorte a un groupe, un seul", () => {
    const vues = GROUPES_MEMOIRE.flatMap((g) => g.sortes);
    expect([...vues].sort()).toEqual([...SORTES_MEMOIRE].sort());
  });
});
