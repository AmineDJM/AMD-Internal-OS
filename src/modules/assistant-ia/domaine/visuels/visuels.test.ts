import { describe, expect, it } from "vitest";
import {
  consigneAvecCharte, coutImageUsd, coutVideoUsd, dureeVideo, filtrerConsigne, nomDeFichierVisuel, normaliserReglagesVisuels,
  REGLAGES_VISUELS_DEFAUT, refusPlafond, usageOpenAI, vueVisuel,
} from "./regles";
import { imageVideoDonnees, lireSpecVideoDonnees, nombreCompact, nombreExact, sousTitres, type SpecVideoDonnees } from "./video-donnees";

/** Lot K2 (décision 0032) — les règles pures des visuels. */
describe("visuels — la consigne ne porte aucune donnée confidentielle", () => {
  it("une description ordinaire passe, nettoyée", () => {
    expect(filtrerConsigne("  Une affiche   pour la semaine de la pharmacovigilance ")).toEqual({ ok: true, texte: "Une affiche pour la semaine de la pharmacovigilance" });
  });
  it.each([
    "Affiche avec le salaire de Karim",
    "Mets l'IBAN DZ58 0002 1000 0123 4567 8912 sur le visuel",
    "Une carte avec le repère ⟦S2⟧",
    "Visuel de son bulletin de paie",
    "Photo de son passeport",
  ])("refusée : %s", (t) => {
    const r = filtrerConsigne(t);
    expect(r.ok).toBe(false);
  });
  it("vide : refus qui dit quoi faire", () => {
    expect(filtrerConsigne("   ")).toMatchObject({ ok: false });
  });
  it("la charte s'ajoute sur demande seulement", () => {
    expect(consigneAvecCharte("Un stand", false)).toBe("Un stand");
    expect(consigneAvecCharte("Un stand", true)).toContain("#2C59A7");
  });
});

describe("visuels — le coût réel", () => {
  it("image OpenAI mesurée le 31/10 (75 jetons texte, 439 jetons image) : 0,0135 $", () => {
    const u = usageOpenAI({ input_tokens: 75, input_tokens_details: { text_tokens: 75, image_tokens: 0 }, output_tokens: 439 });
    expect(u).toEqual({ texteEntree: 75, imageEntree: 0, imageSortie: 439 });
    expect(coutImageUsd(u)).toBeCloseTo(0.013545, 6);
  });
  it("vidéo : secondes × tarif ; modèle inconnu → coût inconnu, jamais deviné", () => {
    expect(coutVideoUsd("sora-2-pro", 8)).toBeCloseTo(2.4, 6);
    expect(coutVideoUsd("sora-2", 4)).toBeCloseTo(0.4, 6);
    expect(coutVideoUsd("autre", 8)).toBeNull();
  });
  it("le refus de plafond dit la dépense et le plafond", () => {
    expect(refusPlafond("IMAGE", 20, 20.5)).toMatch(/20,50|20\.50/);
  });
});

describe("visuels — les réglages du Super Admin", () => {
  it("défauts : images actives (20 $), vidéos coupées, vidéos de données actives", () => {
    expect(normaliserReglagesVisuels(null)).toEqual(REGLAGES_VISUELS_DEFAUT);
    expect(REGLAGES_VISUELS_DEFAUT).toMatchObject({ imagesActives: true, videosActives: false, donneesActives: true, modeleImage: "gpt-image-2.5-sunburst" });
  });
  it("ramenés dans les bornes ; modèle inconnu → défaut ; durée hors liste → défaut", () => {
    const r = normaliserReglagesVisuels({ visuelsImagesPlafondUsd: "-5", visuelsVideosPlafondUsd: 99999, visuelsModeleImage: "dall-e", visuelsVideoSecondesMax: 7 });
    expect(r.imagesPlafondUsd).toBe(0);
    expect(r.videosPlafondUsd).toBe(10000);
    expect(r.modeleImage).toBe("gpt-image-2.5-sunburst");
    expect(r.videoSecondesMax).toBe(8);
  });
  it("la durée demandée : la plus proche des durées permises, sous le maximum", () => {
    expect(dureeVideo(10, 8)).toBe(8);
    expect(dureeVideo(3, 12)).toBe(4);
    expect(dureeVideo(undefined, 12)).toBe(8);
    expect(dureeVideo(12, 4)).toBe(4);
  });
});

describe("visuels — ce que voit la carte", () => {
  const base = { id: "c1234567890abcdefghij", nature: "IMAGE", titre: "Affiche", statut: "PRET", progression: 100, driveNodeId: "n1", mime: "image/png", modele: "gpt-image-2.5-sunburst", secondes: 14.2, coutUsd: 0.0135, erreur: null, fournisseur: "openai" };
  it("prêt : routes de l'ERP (jamais un lien du fournisseur), détail lisible", () => {
    const v = vueVisuel(base);
    expect(v.src).toBe("/api/assistant-ia/visuels/c1234567890abcdefghij/media");
    expect(v.telecharger).toContain("?dl=1");
    expect(v.drive).toBe("/drive/n1");
    expect(v.detail).toBe("gpt-image-2.5-sunburst · 14,2 s · 0,0135 $");
  });
  it("secours Gemini : dit", () => {
    expect(vueVisuel({ ...base, fournisseur: "gemini", modele: "gemini-3-pro-image" }).detail).toContain("secours");
  });
  it("en cours : aucune adresse ; échec : l'erreur", () => {
    expect(vueVisuel({ ...base, statut: "EN_COURS", driveNodeId: null }).src).toBeNull();
    expect(vueVisuel({ ...base, statut: "ECHEC", erreur: "refus" }).erreur).toBe("refus");
  });
  it("le nom du fichier : sans caractère interdit, suffixé par l'identifiant", () => {
    expect(nomDeFichierVisuel("Budget: 2026 / T1", "abcdef123456", "mp4")).toBe("Budget 2026 T1 (123456).mp4");
  });
});

describe("vidéo de données — les chiffres viennent des outils, jamais du modèle", () => {
  const lus = new Set([12430000, 18250000, 9800000]);
  const connu = (v: number) => lus.has(v);
  const brut = { titre: "Budget marketing 2026", forme: "barres", libelles: ["T1", "T2", "T3"], valeurs: [12430000, 18250000, 9800000], unite: "DZD", source: "read_budget" };
  it("des valeurs lues : acceptées", () => {
    expect(lireSpecVideoDonnees(brut, connu, true)).toMatchObject({ ok: true, spec: { forme: "barres", valeurs: [12430000, 18250000, 9800000] } });
  });
  it("une valeur inventée : refusée, nommée", () => {
    const r = lireSpecVideoDonnees({ ...brut, valeurs: [12430000, 18250000, 9900000] }, connu, true);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.raison).toContain("9900000");
  });
  it("aucun outil appelé : refus (lire d'abord)", () => {
    expect(lireSpecVideoDonnees(brut, connu, false)).toMatchObject({ ok: false });
  });
  it("un chiffre dans le titre : refusé (l'année seule est permise)", () => {
    expect(lireSpecVideoDonnees({ ...brut, titre: "Budget 2026 : 40 millions" }, connu, true)).toMatchObject({ ok: false });
  });
  it("libellés et valeurs en nombre différent : refus", () => {
    expect(lireSpecVideoDonnees({ ...brut, libelles: ["T1", "T2"] }, connu, true)).toMatchObject({ ok: false });
  });
});

describe("vidéo de données — sous-titres et images", () => {
  const spec: SpecVideoDonnees = { titre: "Ventes par trimestre", forme: "courbe", libelles: ["T1", "T2", "T3", "T4"], valeurs: [100, 150, 90, 200], unite: "boîtes", source: "ventes PCH" };
  it("les nombres en français", () => {
    expect(nombreExact(12430000, "DZD")).toBe("12 430 000 DZD");
    expect(nombreCompact(12430000, "DZD")).toBe("12,4 M DZD");
    expect(nombreCompact(1240000000, null)).toBe("1,24 Md");
  });
  it("les sous-titres sont calculés : titre, plus haut, évolution, source", () => {
    const st = sousTitres(spec).map((s) => s.texte);
    expect(st[0]).toBe("Ventes par trimestre");
    expect(st[1]).toBe("Point le plus haut : T4 — 200 boîtes");
    expect(st[2]).toBe("De 100 boîtes (T1) à 200 boîtes (T4) : +100 %");
    expect(st[3]).toBe("Source : ventes PCH");
  });
  it("une image est un SVG complet, texte échappé, à chaque instant", () => {
    const svg = imageVideoDonnees({ ...spec, titre: "R&D <test>" }, 3.2);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("R&amp;D &lt;test&gt;");
    expect(imageVideoDonnees({ ...spec, forme: "classement" }, 7.5)).toContain("Source : ventes PCH");
  });
});
