import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { remplirOrdreDeMission, phraseDesDates, refusOrdreMission, nomOrdreMission, VALEURS_DU_MODELE, type ChampsOrdreMission } from "./modele";

const MODELE = readFileSync(join(process.cwd(), "src/modules/rh/infra/ordre-mission/modele-ordre-de-mission.docx"));
const champs: ChampsOrdreMission = {
  dateEmission: "2026-07-23", reference: "007/DPG/2026", ...VALEURS_DU_MODELE,
  collaborateur: "Mme Radia KEBIR", fonction: "Assistante de Direction Générale",
  objet: "de récupérer une commande de goodies chez Eprint à Kouba Alger & de les apporter à l'aéroport",
  destination: "Ben Omar Kouba\nAéroport d'Alger", datesDepart: ["2026-07-23", "2026-07-24"], datesRetour: ["2026-07-23", "2026-07-24"],
  transport: "Véhicule personnel",
};
const texteDe = async (docx: Buffer) => {
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
};

describe("l'ordre de mission — le document de la Direction, rempli", () => {
  it("le modèle porte bien tous ses marqueurs, et le document généré n'en garde aucun", async () => {
    expect(await texteDe(MODELE)).toContain("{{REFERENCE}}");
    const t = await texteDe(await remplirOrdreDeMission(MODELE, champs));
    expect(t).not.toMatch(/\{\{/);
    expect(t).toContain("Date, le 23/07/2026");
    expect(t).toContain("ORDRE DE MISSION N° 007/DPG/2026");
    expect(t).toContain("Nom et prénom du collaborateur : Mme Radia KEBIR");
    expect(t).toContain("ayant pour but de récupérer une commande");
    expect(t).toContain("&amp; de les apporter");
    expect(t).toContain("Date de départ : le 23/07/2026 et le 24/07/2026");
    expect(t).toContain("Mode de transport : Véhicule personnel");
    expect(t).toContain("Directeur Des Ressources Humaines");
  });
  it("en-tête, pied et logo du modèle voyagent intacts", async () => {
    const z = await JSZip.loadAsync(await remplirOrdreDeMission(MODELE, champs));
    for (const f of ["word/header1.xml", "word/footer1.xml", "word/media/image1.png", "word/media/image2.png", "word/styles.xml"]) expect(z.file(f), f).not.toBeNull();
  });
  it("les dates, l'objet sans « de », ce qui manque, le nom du fichier", async () => {
    expect(phraseDesDates(["2026-07-23"])).toBe("le 23/07/2026");
    expect(phraseDesDates(["2026-07-23", "2026-07-24", "2026-07-25"])).toBe("le 23/07/2026, le 24/07/2026 et le 25/07/2026");
    expect(await texteDe(await remplirOrdreDeMission(MODELE, { ...champs, objet: "récupérer des goodies" }))).toContain("ayant pour but de récupérer des goodies");
    expect(refusOrdreMission({ ...champs, reference: "", datesDepart: [] })).toMatch(/la référence, la date de départ/);
    expect(refusOrdreMission(champs)).toBeNull();
    expect(nomOrdreMission("007/DPG/2026", "Mme Radia KEBIR")).toBe("Ordre de mission 007-DPG-2026 — Radia KEBIR");
  });
});
