import { describe, expect, it } from "vitest";
import {
  aujourdhuiAlger, chevauchementsDe, couvreLeJour, jourDuConge, minuitUtc, periodesCommunes, plusJours, seChevauchent,
  type AbsenceDEquipe,
} from "./absences";

/**
 * LES ABSENCES AU JOUR (§118.196, lot E3 — audit 360°, M19 et M21) — la règle PURE, sans base.
 *
 * Aucun cas n'ajoute des heures à « maintenant » : un juge qui vise « dans trois heures » vise un
 * instant, et un instant tombe parfois de l'autre côté de minuit (§118.195h). Chaque instant est
 * FIXÉ, et l'heure d'Alger qu'il représente est écrite à côté.
 */

const abs = (o: Partial<AbsenceDEquipe> & Pick<AbsenceDEquipe, "employeeId" | "debut" | "fin">): AbsenceDEquipe => ({
  leaveId: `${o.employeeId}-${o.debut}`,
  nom: o.employeeId.toUpperCase(),
  enAttente: false,
  groupe: "chef",
  ...o,
});

describe("un congé est fait de jours, pas d'instants (M21)", () => {
  it("LE DERNIER JOUR D'UN CONGÉ EST UN JOUR D'ABSENCE — fini à minuit UTC, il couvre encore le matin à Alger", () => {
    const fin = new Date("2026-10-04"); // la saisie d'un <input type="date"> : minuit UTC
    const huitHeuresAlger = new Date("2026-10-04T07:00:00Z");
    // LE DÉFAUT, nommé : la comparaison d'instants le déclarait déjà fini.
    expect(fin >= huitHeuresAlger).toBe(false);
    // La règle compare des JOURS : le 4 est un jour d'absence, du matin au soir.
    const conge = { debut: jourDuConge(new Date("2026-10-01")), fin: jourDuConge(fin) };
    expect(couvreLeJour(conge, aujourdhuiAlger(huitHeuresAlger))).toBe(true);
    expect(couvreLeJour(conge, aujourdhuiAlger(new Date("2026-10-04T22:00:00Z")))).toBe(true); // 23:00 à Alger
    expect(couvreLeJour(conge, "2026-10-05")).toBe(false);
    expect(couvreLeJour(conge, "2026-10-01")).toBe(true);
    expect(couvreLeJour(conge, "2026-09-30")).toBe(false);
  });

  it("AUJOURD'HUI SE LIT À ALGER — à 23 h 30 UTC, c'est déjà le lendemain", () => {
    expect(aujourdhuiAlger(new Date("2026-10-03T23:30:00Z"))).toBe("2026-10-04"); // 00:30 à Alger
    expect(aujourdhuiAlger(new Date("2026-10-04T22:59:00Z"))).toBe("2026-10-04"); // 23:59 à Alger
    expect(aujourdhuiAlger(new Date("2026-10-04T23:00:00Z"))).toBe("2026-10-05"); // minuit à Alger
    expect(aujourdhuiAlger(new Date("2026-10-04T07:00:00Z"))).toBe("2026-10-04");
  });

  it("UN JOUR DE CONGÉ SE LIT COMME IL A ÉTÉ ÉCRIT — minuit UTC, aller et retour", () => {
    expect(jourDuConge(new Date("2026-10-04"))).toBe("2026-10-04");
    expect(minuitUtc("2026-10-04").toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(jourDuConge(minuitUtc("2031-03-12"))).toBe("2031-03-12");
    expect(plusJours("2026-10-31", 1)).toBe("2026-11-01");
    expect(plusJours("2028-02-28", 1)).toBe("2028-02-29");
    expect(plusJours("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("deux absences ne se chevauchent que dans une même équipe (M19)", () => {
  it("UN JOUR COMMUN SUFFIT, DEUX JOURS QUI SE SUIVENT NE SE CHEVAUCHENT PAS", () => {
    expect(seChevauchent({ debut: "2026-10-01", fin: "2026-10-04" }, { debut: "2026-10-04", fin: "2026-10-06" })).toBe(true);
    expect(seChevauchent({ debut: "2026-10-04", fin: "2026-10-06" }, { debut: "2026-10-01", fin: "2026-10-04" })).toBe(true);
    expect(seChevauchent({ debut: "2026-10-01", fin: "2026-10-04" }, { debut: "2026-10-05", fin: "2026-10-06" })).toBe(false);
    expect(seChevauchent({ debut: "2026-10-02", fin: "2026-10-02" }, { debut: "2026-10-01", fin: "2026-10-09" })).toBe(true);
  });

  it("DEUX ABSENCES NE SE CHEVAUCHENT QUE DANS LA MÊME ÉQUIPE — et jamais avec soi-même", () => {
    const cible = abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-07", enAttente: true });
    const toutes = [
      cible,
      abs({ employeeId: "a", debut: "2026-10-07", fin: "2026-10-08" }), // sa propre prolongation : jamais un chevauchement
      abs({ employeeId: "b", debut: "2026-10-07", fin: "2026-10-10" }), // même équipe, un jour commun
      abs({ employeeId: "c", debut: "2026-10-06", fin: "2026-10-06", groupe: "autre-chef" }), // autre équipe
      abs({ employeeId: "d", debut: "2026-10-08", fin: "2026-10-09" }), // même équipe, aucun jour commun
      abs({ employeeId: "e", debut: "2026-10-01", fin: "2026-10-05", enAttente: true }), // même équipe, en attente
    ];
    expect(chevauchementsDe(cible, toutes).map((a) => a.employeeId)).toEqual(["e", "b"]);
    // Le groupe `null` (« mes N-1 ») est un groupe comme un autre.
    const n1 = abs({ employeeId: "x", debut: "2026-10-05", fin: "2026-10-05", groupe: null });
    expect(chevauchementsDe(n1, [n1, abs({ employeeId: "y", debut: "2026-10-05", fin: "2026-10-05", groupe: null }), abs({ employeeId: "z", debut: "2026-10-05", fin: "2026-10-05" })])
      .map((a) => a.employeeId)).toEqual(["y"]);
  });

  it("UNE PÉRIODE COMMUNE S'ARRÊTE QUAND LA LISTE DES ABSENTS CHANGE", () => {
    const p = periodesCommunes([
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-09" }),
      abs({ employeeId: "b", debut: "2026-10-07", fin: "2026-10-12" }),
      abs({ employeeId: "c", debut: "2026-10-08", fin: "2026-10-08" }),
    ], "2026-10-01", 30);
    expect(p.map((x) => [x.debut, x.fin, x.personnes.map((q) => q.employeeId).join("+")])).toEqual([
      ["2026-10-07", "2026-10-07", "a+b"],
      ["2026-10-08", "2026-10-08", "a+b+c"],
      ["2026-10-09", "2026-10-09", "a+b"],
    ]);
  });

  it("UNE PERSONNE NE SE CHEVAUCHE PAS ELLE-MÊME — un congé et sa prolongation comptent une fois", () => {
    expect(periodesCommunes([
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-08" }),
      abs({ employeeId: "a", debut: "2026-10-08", fin: "2026-10-10", enAttente: true }),
    ], "2026-10-01", 30)).toEqual([]);
  });

  it("EN ATTENTE SEULEMENT SI RIEN N'EST ACCORDÉ CE JOUR-LÀ", () => {
    const p = periodesCommunes([
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-05" }),
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-05", enAttente: true }),
      abs({ employeeId: "b", debut: "2026-10-05", fin: "2026-10-05", enAttente: true }),
    ], "2026-10-01", 30);
    expect(p).toHaveLength(1);
    expect(p[0].personnes).toEqual([
      { employeeId: "a", nom: "A", enAttente: false },
      { employeeId: "b", nom: "B", enAttente: true },
    ]);
  });

  it("UN CHANGEMENT DE STATUT COUPE LA PÉRIODE — « en attente » puis « accordé » ne se fondent pas", () => {
    const p = periodesCommunes([
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-06" }),
      abs({ employeeId: "b", debut: "2026-10-05", fin: "2026-10-05", enAttente: true }),
      abs({ employeeId: "b", debut: "2026-10-06", fin: "2026-10-06" }),
    ], "2026-10-01", 30);
    expect(p.map((x) => [x.debut, x.fin, x.personnes.map((q) => `${q.employeeId}${q.enAttente ? "?" : ""}`).join("+")])).toEqual([
      ["2026-10-05", "2026-10-05", "a+b?"],
      ["2026-10-06", "2026-10-06", "a+b"],
    ]);
  });

  it("DEUX ÉQUIPES NE SE CHEVAUCHENT PAS — chaque période porte son équipe", () => {
    const p = periodesCommunes([
      abs({ employeeId: "a", debut: "2026-10-05", fin: "2026-10-05", groupe: "un" }),
      abs({ employeeId: "b", debut: "2026-10-05", fin: "2026-10-05", groupe: "deux" }),
      abs({ employeeId: "c", debut: "2026-10-05", fin: "2026-10-05", groupe: "deux" }),
    ], "2026-10-01", 30);
    expect(p.map((x) => [x.groupe, x.personnes.map((q) => q.employeeId).join("+")])).toEqual([["deux", "b+c"]]);
  });

  it("LA FENÊTRE BORNE LES JOURS — ni la veille, ni le lendemain du dernier jour", () => {
    const toutes = [
      abs({ employeeId: "a", debut: "2026-09-28", fin: "2026-10-02" }),
      abs({ employeeId: "b", debut: "2026-09-28", fin: "2026-10-02" }),
    ];
    // Fenêtre du 30/09 sur 2 jours : 30/09 et 01/10 — la période est COUPÉE aux bornes, pas élargie.
    expect(periodesCommunes(toutes, "2026-09-30", 2).map((x) => [x.debut, x.fin])).toEqual([["2026-09-30", "2026-10-01"]]);
    // Fenêtre qui commence le lendemain du dernier jour commun : rien.
    expect(periodesCommunes(toutes, "2026-10-03", 30)).toEqual([]);
    // Fenêtre qui s'arrête la veille du premier jour commun : rien.
    expect(periodesCommunes(toutes, "2026-09-20", 8)).toEqual([]);
  });
});
