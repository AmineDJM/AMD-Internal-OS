import { describe, it, expect } from "vitest";
import type { FaitExtrait } from "@/lib/enrichissement/types";
import { extraireProgrammeCongres, MOTEUR_PROGRAMME } from "./programme-congres";

// Un programme scientifique, anonymisé — en-tête, partenaires, agence logistique, secrétariat.
const PROGRAMME = [
  "Société Algérienne de Cardiologie Interventionnelle (SACI)",
  "XIIe CONGRÈS NATIONAL DE CARDIOLOGIE INTERVENTIONNELLE",
  "Organisé par la Société Algérienne de Cardiologie Interventionnelle (SACI)",
  "Du 12 au 14 novembre 2026",
  "Hôtel Méridien, Oran — Centre des conventions",
  "Date limite de soumission des résumés : 15 septembre 2026",
  "",
  "PROGRAMME SCIENTIFIQUE",
  "Jeudi 12 novembre — 08h30 Ouverture",
  "Session 1 : Syndromes coronariens aigus",
  "",
  "Partenaires : Laboratoires Atlas Pharma, Médi-Distrib SARL",
  "Organisation logistique : Agence Horizon Événements — contact@horizon-events.dz — 041 33 22 11",
  "Secrétariat du congrès : secretariat@saci-cardio.dz — Tél. 0550 12 34 56",
  "Site web : www.saci-cardio.dz",
].join("\n");

const de = (faits: FaitExtrait[], sujetRef: string, attribut: string) => faits.filter((f) => f.sujetRef === sujetRef && f.attribut === attribut);

describe("le programme d'un congrès national", () => {
  const r = extraireProgrammeCongres({ texte: PROGRAMME });

  it("lu localement, par règles", () => {
    expect(r).toMatchObject({ nature: "PROGRAMME_CONGRES", moteur: MOTEUR_PROGRAMME, local: true });
  });

  it("l'organisateur : la société savante et son sigle — jamais un sponsor ni l'agence", () => {
    expect(de(r.faits, "organisateur-1", "organisation.raisonSociale")[0]).toMatchObject({
      role: "ORGANISATEUR", sujetType: "ORGANISATION", valeur: "Société Algérienne de Cardiologie Interventionnelle", confiance: 0.75,
    });
    expect(de(r.faits, "organisateur-1", "organisation.nomCommercial")[0].valeur).toBe("SACI");
    expect(new Set(r.faits.map((f) => f.sujetRef))).toEqual(new Set(["organisateur-1"]));
    expect(r.faits.some((f) => /atlas|horizon/i.test(f.valeur))).toBe(false);
  });

  it("les coordonnées du secrétariat, pas celles de l'agence logistique", () => {
    expect(de(r.faits, "organisateur-1", "organisation.email")[0].valeur).toBe("secretariat@saci-cardio.dz");
    expect(de(r.faits, "organisateur-1", "organisation.telephone")[0].valeurNormalisee).toBe("+213550123456");
    expect(de(r.faits, "organisateur-1", "organisation.siteWeb")[0].valeurNormalisee).toBe("saci-cardio.dz");
  });

  it("l'événement : intitulé, dates (pas la date limite des résumés), lieu", () => {
    expect(r.evenement.intitule?.valeur).toBe("XIIe CONGRÈS NATIONAL DE CARDIOLOGIE INTERVENTIONNELLE");
    expect(r.evenement.dateDebut?.valeur).toBe("2026-11-12");
    expect(r.evenement.dateFin?.valeur).toBe("2026-11-14");
    expect(r.evenement.lieu?.valeur).toBe("Hôtel Méridien, Oran — Centre des conventions");
    expect(r.notes).toEqual([]);
  });
});

describe("co-organisation, en-tête seul, rien", () => {
  it("deux sociétés savantes : deux organisateurs, aucune coordonnée rattachée", () => {
    const r = extraireProgrammeCongres({ texte: [
      "IVes Journées algéro-françaises de pneumologie",
      "Organisées par la Société Algérienne de Pneumo-Phtisiologie (SAPP) en collaboration avec la Société de Pneumologie de Langue Française (SPLF)",
      "Les 3, 4 et 5 décembre 2026 — Centre International de Conférences, Alger",
      "Contact : info@sapp.dz",
    ].join("\n") });
    expect(de(r.faits, "organisateur-1", "organisation.nomCommercial")[0].valeur).toBe("SAPP");
    expect(de(r.faits, "organisateur-2", "organisation.raisonSociale")[0].valeur).toBe("Société de Pneumologie de Langue Française");
    expect(r.faits.some((f) => f.attribut === "organisation.email")).toBe(false);
    expect(r.notes.some((n) => n.includes("Plusieurs organisateurs"))).toBe(true);
    expect([r.evenement.dateDebut?.valeur, r.evenement.dateFin?.valeur]).toEqual(["2026-12-03", "2026-12-05"]);
    expect(r.evenement.lieu?.valeur).toBe("Centre International de Conférences, Alger");
  });

  it("sans « organisé par » : la société savante en tête, à confiance de déduction", () => {
    const r = extraireProgrammeCongres({ texte: "Association Algérienne d'Endocrinologie\nSymposium diabète et obésité\nLe 1er décembre 2026\nLieu : Hôtel Sofitel, Alger" });
    expect(de(r.faits, "organisateur-1", "organisation.raisonSociale")[0]).toMatchObject({ valeur: "Association Algérienne d'Endocrinologie", confiance: 0.65 });
    expect(r.evenement.dateDebut?.valeur).toBe("2026-12-01");
    expect(r.evenement.lieu?.valeur).toBe("Hôtel Sofitel, Alger");
  });

  it("rien de lisible : pas de fait, et chaque absence est dite", () => {
    const r = extraireProgrammeCongres({ texte: "Bienvenue\nMerci de votre présence" });
    expect(r.faits).toEqual([]);
    expect(r.notes).toHaveLength(4);
  });
});
