import { describe, expect, it } from "vitest";
import { CATALOGUE_BASES } from "./catalogue.genere";
import {
  baseDe, baseDuModele, droitEffectif, droitParModules, enVigueur, niveauPour, propresDonneesParDefaut,
  refusVerrouillage, touchePlusRestrictifSuperAdmin, appliqueeSur, empreinteRefus, lireRefusBase,
} from "./regle";
import type { ReglageBase } from "./types";

const J = (s: string) => new Date(`${s}T10:00:00.000Z`);
const MAINTENANT = J("2026-11-02");
let n = 0;
const r = (o: Partial<ReglageBase>): ReglageBase => ({
  id: `r${++n}`, base: "paie", userId: null, role: null, niveau: "FERMEE", ecriture: false,
  du: J("2026-11-01"), au: null, revoqueLe: null, ...o,
});
const radia = { userId: "radia", roles: ["DIRECTION_ASSISTANT", null] };

describe("catalogue applicatif", () => {
  it("chaque table a une base, et une seule", () => {
    const toutes = CATALOGUE_BASES.flatMap((b) => b.tables);
    expect(new Set(toutes).size).toBe(toutes.length);
    expect(baseDuModele("PayrollEntry")).toBe("paie");
    expect(baseDuModele("payrollEntry")).toBe("paie");
    expect(baseDuModele("AccesBase")).toBe("comptes-et-droits");
    expect(baseDuModele("Inconnue")).toBeNull();
    expect(baseDe("paie")?.lectureExige).toBe("UPDATE");
  });
});

describe("un réglage en vigueur", () => {
  it("commencé, pas fini (jour de fin compris), pas révoqué", () => {
    expect(enVigueur(r({}), MAINTENANT)).toBe(true);
    expect(enVigueur(r({ du: J("2026-11-03") }), MAINTENANT)).toBe(false);
    expect(enVigueur(r({ au: new Date("2026-11-02T00:00:00.000Z") }), MAINTENANT)).toBe(true);
    expect(enVigueur(r({ au: new Date("2026-11-01T00:00:00.000Z") }), MAINTENANT)).toBe(false);
    expect(enVigueur(r({ revoqueLe: J("2026-11-02") }), new Date("2026-11-02T11:00:00Z"))).toBe(false);
  });
});

describe("le niveau d'une base pour une personne", () => {
  it("sans réglage : Normal", () => {
    expect(niveauPour(radia, "paie", [], MAINTENANT)).toMatchObject({ niveau: "NORMAL", source: "defaut" });
  });
  it("la personne prime sur son rôle", () => {
    const l = [r({ role: "DIRECTION_ASSISTANT", niveau: "FERMEE" }), r({ userId: "radia", niveau: "OUVERTE", ecriture: true })];
    expect(niveauPour(radia, "paie", l, MAINTENANT)).toMatchObject({ niveau: "OUVERTE", ecriture: true, source: "personne" });
  });
  it("entre deux rôles, le plus restrictif ; un droit expiré ne compte plus", () => {
    const l = [
      r({ role: "DIRECTION_ASSISTANT", niveau: "OUVERTE" }),
      r({ role: "COORDINATOR", niveau: "LECTURE_SEULE" }),
      r({ userId: "radia", niveau: "OUVERTE", au: J("2026-10-30") }),
    ];
    expect(niveauPour({ userId: "radia", roles: ["DIRECTION_ASSISTANT", "COORDINATOR"] }, "paie", l, MAINTENANT))
      .toMatchObject({ niveau: "LECTURE_SEULE", source: "role" });
  });
  it("un réglage d'une autre base ou d'une autre personne ne compte pas", () => {
    const l = [r({ base: "personnel", userId: "radia" }), r({ userId: "assia" })];
    expect(niveauPour(radia, "paie", l, MAINTENANT).niveau).toBe("NORMAL");
  });
  it("l'écriture n'accompagne qu'une base OUVERTE", () => {
    expect(niveauPour(radia, "paie", [r({ userId: "radia", niveau: "LECTURE_SEULE", ecriture: true })], MAINTENANT).ecriture).toBe(false);
  });
});

describe("le droit effectif : modules ET base", () => {
  const paie = baseDe("paie")!;
  const rhLecteur = droitParModules(paie, (m, g) => m === "RH" && g === "VIEW");
  const rhGestion = droitParModules(paie, (m, g) => m === "RH" && ["VIEW", "UPDATE"].includes(g));
  const nv = (niveau: "NORMAL" | "FERMEE" | "LECTURE_SEULE" | "OUVERTE", ecriture = false) =>
    ({ niveau, ecriture, source: niveau === "NORMAL" ? "defaut" as const : "personne" as const, reglageId: null });

  it("la paie exige RH en modification pour être lue", () => {
    expect(rhLecteur).toEqual({ lecture: false, ecriture: false });
    expect(rhGestion).toEqual({ lecture: true, ecriture: true });
  });
  it("Normal : les modules ; Fermée : rien, même avec les modules", () => {
    expect(droitEffectif(rhGestion, nv("NORMAL"), "Paie")).toMatchObject({ lecture: true, ecriture: true });
    expect(droitEffectif(rhGestion, nv("FERMEE"), "Paie")).toMatchObject({ lecture: false, ecriture: false });
  });
  it("Lecture seule retire l'écriture, n'ajoute pas la lecture", () => {
    expect(droitEffectif(rhGestion, nv("LECTURE_SEULE"), "Paie")).toMatchObject({ lecture: true, ecriture: false });
    expect(droitEffectif(rhLecteur, nv("LECTURE_SEULE"), "Paie")).toMatchObject({ lecture: false, ecriture: false });
  });
  it("Ouverte donne la lecture sans module, l'écriture seulement si accordée", () => {
    expect(droitEffectif(rhLecteur, nv("OUVERTE"), "Paie")).toMatchObject({ lecture: true, ecriture: false });
    expect(droitEffectif(rhLecteur, nv("OUVERTE", true), "Paie")).toMatchObject({ lecture: true, ecriture: true });
  });
});

describe("garde-fous", () => {
  it("on ne ferme pas « Comptes & droits » au dernier Super Admin actif", () => {
    expect(refusVerrouillage("comptes-et-droits", "FERMEE", 0)).toMatch(/dernier Super Admin/);
    expect(refusVerrouillage("comptes-et-droits", "LECTURE_SEULE", 0)).toMatch(/dernier Super Admin/);
    expect(refusVerrouillage("comptes-et-droits", "FERMEE", 1)).toBeNull();
    expect(refusVerrouillage("comptes-et-droits", "OUVERTE", 0)).toBeNull();
    expect(refusVerrouillage("paie", "FERMEE", 0)).toBeNull();
  });
  it("un réglage restrictif qui touche un Super Admin demande une confirmation", () => {
    expect(touchePlusRestrictifSuperAdmin("FERMEE", 1)).toBe(true);
    expect(touchePlusRestrictifSuperAdmin("OUVERTE", 1)).toBe(false);
    expect(touchePlusRestrictifSuperAdmin("FERMEE", 0)).toBe(false);
  });
  it("ses propres données : oui par défaut pour Personnel, Paie, Recrutement", () => {
    expect(["personnel", "paie", "recrutement"].every(propresDonneesParDefaut)).toBe(true);
    expect(propresDonneesParDefaut("finances")).toBe(false);
  });
});

describe("D4 — application stricte et refus clair", () => {
  it("SENSIBLES : bases secrètes et confidentielles ; TOUTES : toutes les métier ; jamais une technique", () => {
    expect(appliqueeSur("AUCUNE", baseDe("paie")!)).toBe(false);
    expect(appliqueeSur("SENSIBLES", baseDe("paie")!)).toBe(true);
    expect(appliqueeSur("SENSIBLES", baseDe("personnel")!)).toBe(true);
    expect(appliqueeSur("SENSIBLES", baseDe("stocks")!)).toBe(false);
    expect(appliqueeSur("TOUTES", baseDe("stocks")!)).toBe(true);
    expect(appliqueeSur("TOUTES", baseDe("comptes-et-droits")!)).toBe(false);
  });
  it("l'écran reconnaît l'empreinte et nomme la base", () => {
    expect(lireRefusBase(empreinteRefus("paie", "FERMEE"))?.phrase).toMatch(/« Paie & rémunérations » vous est fermée/);
    expect(lireRefusBase(empreinteRefus("paie", "LECTURE_SEULE"))?.phrase).toMatch(/lecture seule/);
    expect(lireRefusBase("1234567890")).toBeNull();
    expect(lireRefusBase(undefined)).toBeNull();
  });
});
