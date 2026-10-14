import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  CATEGORIES_2026, DECISIONS_LIGNES, DEMANDES_2026, NB_DEMANDES_ATTENDUES, NB_DEPENSES_ATTENDUES, TOTAL_ATTENDU_CENTIMES,
  controlerFichier, dateDeLaDepense, formatCentimes, incoherences, lireLignes, moisDuTexte, montantDeLaDemande, normaliserTexte,
} from "./integration-2026";
import { cellulesSynthetiques, lignesSynthetiques } from "./integration-fixture";
import { lireFichierIntegration } from "./integration-serveur";

/**
 * L'INTÉGRATION AD & PRO 2026 — LES DÉCISIONS ET LA LECTURE DU FORMAT (tests purs, sur une feuille SYNTHÉTIQUE au format
 * du fichier : jamais le fichier réel).
 */

const classeur = (cellules: (string | number | null)[][]): Uint8Array => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cellules), "Feuil1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["autre"]]), "Feuil2");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
};
const c = (dzd: number) => Math.round(dzd * 100);

describe("les décisions versionnées", () => {
  it("sont cohérentes : 32 dépenses, 30 demandes, 33 558 715,94 DZD au centime", () => {
    expect(incoherences()).toEqual([]);
    expect(DECISIONS_LIGNES).toHaveLength(NB_DEPENSES_ATTENDUES);
    expect(DEMANDES_2026).toHaveLength(NB_DEMANDES_ATTENDUES);
    expect(DECISIONS_LIGNES.reduce((s, d) => s + d.montantRetenu, 0)).toBe(TOTAL_ATTENDU_CENTIMES);
    expect(formatCentimes(TOTAL_ATTENDU_CENTIMES)).toBe("33 558 715,94");
    expect(DEMANDES_2026.reduce((s, d) => s + montantDeLaDemande(d), 0)).toBe(TOTAL_ATTENDU_CENTIMES);
  });

  it("appliquent les montants décidés : staff, symposium SAI, pharmaciens, webinaire, Sapsox, lettre, Oran", () => {
    const m = (l: number) => DECISIONS_LIGNES.find((d) => d.ligne === l)!;
    expect([42, 43, 44, 45, 48, 49].map((l) => m(l).montantRetenu)).toEqual([174_316.74, 170_316.74, 182_316.74, 185_316.74, 210_316.74, 217_816.74].map(c));
    expect(m(22).montantRetenu).toBe(c(215_475));
    expect(m(32).montantRetenu).toBe(c(124_750));
    expect(m(32).mois).toBe(10);
    expect(m(19).montantRetenu).toBe(c(53_550));
    expect(m(14)).toMatchObject({ montantRetenu: c(300_000), mois: 2 });
    expect(m(20).montantRetenu).toBe(c(14_280));
    expect(m(10).montantRetenu).toBe(c(2_157_018.5));
    expect(DECISIONS_LIGNES.some((d) => d.ligne === 58)).toBe(false);
  });

  it("nomment comme décidé : Santé Expo (Paris), 2ème conférence de Tlemcen, ASARI + symposium Pr Djaballah", () => {
    const libelles = DEMANDES_2026.map((d) => d.libelle);
    expect(libelles).toContain("Santé Expo (Paris)");
    expect(libelles.some((l) => /HOPI/i.test(l))).toBe(false);
    expect(libelles).toContain("2ème conférence de Tlemcen");
    expect(libelles).toContain("ASARI + symposium Pr Djaballah");
  });

  it("font des symposiums des POSTES de leur congrès, imputés Événements › Symposium", () => {
    const sai = DEMANDES_2026.find((d) => d.cle === "D-L21")!;
    expect(sai.type).toBe("SPONSORING");
    expect(sai.lignes).toEqual([21, 22]);
    expect(sai.postes.map((p) => [p.montant, p.categorie, p.sousCategorie])).toEqual([
      [c(1_500_000), "Sponsoring", null], [c(195_475), "Événements", "Symposium"], [c(8_000), "Événements", "Symposium"], [c(12_000), "Événements", "Symposium"],
    ]);
    const asari = DEMANDES_2026.find((d) => d.cle === "D-L25")!;
    expect(asari.postes.map((p) => [p.montant, p.sousCategorie])).toEqual([[c(2_000_000), null], [c(195_475), "Symposium"]]);
  });

  it("donnent deux postes aux staffs (honoraires + restauration) et rangent Taghit en Événements › Réunions", () => {
    for (const d of DEMANDES_2026.filter((x) => x.sousType === "Staff post-event")) {
      expect(d.postes.map((p) => p.libelle)).toEqual(["Honoraires orateur", "Restauration"]);
      expect(d.postes[0].montant).toBe(c(130_316.74));
      expect(d.postes.every((p) => p.sousCategorie === "Staff post-event")).toBe(true);
    }
    expect(DEMANDES_2026.find((d) => d.cle === "D-L12")!.postes[0]).toMatchObject({ categorie: "Événements", sousCategorie: "Réunions" });
  });

  it("font du visa de publicité une déclaration d'information médicale, budget en Matériel promotionnel", () => {
    const visa = DEMANDES_2026.find((d) => d.ligne === 40)!;
    expect(visa.type).toBe("MEDICAL_INFO_DECLARATION");
    expect(visa.postes[0]).toMatchObject({ montant: c(240_000), categorie: "Matériel promotionnel" });
    expect(visa.piecesAttendues.map((p) => p.cle)).toContain("quittance");
  });

  it("ouvrent les fiches voyageurs aux prises en charge internationales (un poste global)", () => {
    const pec = DEMANDES_2026.filter((d) => d.type === "CONGRESS_INTERNATIONAL");
    expect(pec.map((d) => d.ligne)).toEqual([5, 7, 9]);
    for (const d of pec) { expect(d.fichesVoyageurs).toBe(true); expect(d.postes).toHaveLength(1); }
  });

  it("datent au dernier jour du mois (2026)", () => {
    expect(dateDeLaDepense(2).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(dateDeLaDepense(6).toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(dateDeLaDepense(10).toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(moisDuTexte("Aoiut")).toBe(8);
    expect(moisDuTexte("Sep")).toBe(9);
    expect(moisDuTexte("Juillet ")).toBe(7);
    expect(moisDuTexte(null)).toBeNull();
    expect(normaliserTexte("Sympo  Lors du congrés")).toBe("sympo lors du congres");
  });
});

describe("la lecture du format et le contrôle", () => {
  it("la feuille synthétique passe : le plan, les totaux par catégorie et sous-catégorie, au centime", () => {
    const r = controlerFichier(lignesSynthetiques());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.lignes).toHaveLength(32);
    expect(r.plan.demandes).toHaveLength(30);
    expect(r.plan.totalCentimes).toBe(TOTAL_ATTENDU_CENTIMES);
    expect(r.plan.parCategorie).toEqual({
      "Prise en charge internationale": c(18_789_940),
      "Prise en charge nationale": c(124_750),
      Sponsoring: c(8_043_208.5),
      "Matériel promotionnel": c(3_055_675),
      Formation: c(350_000),
      Consulting: 0,
      "Événements": c(3_195_142.44),
    });
    expect(r.plan.parSousCategorie).toEqual({ "Réunions": c(1_643_792), Symposium: c(410_950), "Staff post-event": c(1_140_400.44), "Tables rondes": 0 });
    expect(Object.keys(r.plan.parCategorie)).toEqual([...CATEGORIES_2026]);
    expect(r.plan.ecartees.map((e) => e.ligne)).toEqual([58]);
  });

  it("refuse un fichier qui ne correspond plus : montant changé, détail changé, ligne nouvelle avec une dépense", () => {
    const montant = cellulesSynthetiques(); montant[4][6] = 10_989_941;
    const detail = cellulesSynthetiques(); detail[9][2] = "7ème conférence d'Oran";
    const nouvelle = cellulesSynthetiques(); nouvelle[5][6] = 12_000; // L6 (Venise) porte soudain une dépense
    const mois = cellulesSynthetiques(); mois[11][4] = "Mars";
    for (const [cas, cellules, motif] of [["montant", montant, /dépense réelle a changé/], ["détail", detail, /détail a changé/], ["nouvelle", nouvelle, /qu'aucune décision ne couvre/], ["mois", mois, /mois a changé/]] as const) {
      const r = controlerFichier(lignesSynthetiques(cellules));
      expect(r.ok, cas).toBe(false);
      if (!r.ok) expect(r.erreurs.join(" "), cas).toMatch(motif);
    }
  });

  it("lit un vrai classeur .xlsx (Feuil1, en-têtes ligne 4) et en garde l'empreinte", () => {
    const r = lireFichierIntegration(classeur(cellulesSynthetiques()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.plan.totalCentimes).toBe(TOTAL_ATTENDU_CENTIMES);
    }
  });

  it("refuse une feuille sans les en-têtes attendus, ou sans Feuil1", () => {
    const sans = cellulesSynthetiques(); sans[3][6] = "Réalisé";
    const lu = lireLignes(sans);
    expect(lu.ok).toBe(false);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cellulesSynthetiques()), "Feuille unique");
    const r = lireFichierIntegration(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs[0]).toMatch(/Feuil1/);
  });
});
