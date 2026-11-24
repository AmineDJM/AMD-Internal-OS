import { describe, expect, it } from "vitest";
import { ECHEANCES_PAR_MODULE, echeanceVisible, joursAvant, lignesEcheances, type Echeance, type Lecteur } from "./regles";
import { regrouperFile } from "@/lib/espace/aujourdhui";
import { grouperAFaire } from "@/lib/espace/a-faire";

const MAINTENANT = new Date("2026-11-24T09:00:00Z");
const dans = (j: number) => new Date(Date.UTC(2026, 10, 24 + j));

const echeance = (p: Partial<Echeance> = {}): Echeance => ({
  source: "rh.contrat", id: "e1", module: "Ressources humaines", libelle: "Fin de CDD — Samir Haddad", detail: "Délégué médical",
  date: dans(20), href: "/rh/e1", liste: "/rh", companyId: "A", responsables: ["n1"], droit: { module: "RH", action: "UPDATE" }, ...p,
});

const lecteur = (p: Partial<Lecteur> = {}): Lecteur => ({
  id: "x", sommet: false, superAdmin: false, peut: () => false, societePermise: () => true, ...p,
});
const rh = lecteur({ id: "rh", peut: (d) => d.module === "RH" });
const sa = lecteur({ id: "sa", sommet: true, superAdmin: true, peut: () => true });

describe("les échéances des modules — règles pures", () => {
  it("compte les jours civils d'Alger, négatifs une fois dépassée", () => {
    expect(joursAvant(dans(0), MAINTENANT)).toBe(0);
    expect(joursAvant(dans(30), MAINTENANT)).toBe(30);
    expect(joursAvant(dans(-3), MAINTENANT)).toBe(-3);
  });

  it("le responsable la voit à J-30, pas à J-31 ; le N+1 nommé aussi, quelle que soit sa société", () => {
    expect(echeanceVisible(echeance({ date: dans(30) }), rh, MAINTENANT)).toBe(true);
    expect(echeanceVisible(echeance({ date: dans(31) }), rh, MAINTENANT)).toBe(false);
    expect(echeanceVisible(echeance(), lecteur({ id: "n1", societePermise: () => false }), MAINTENANT)).toBe(true);
    expect(echeanceVisible(echeance(), lecteur({ id: "quelqu'un" }), MAINTENANT)).toBe(false);
  });

  it("le sommet ne voit que ce qui est dépassé ou à moins de 10 jours — même avec tous les droits", () => {
    expect(echeanceVisible(echeance({ date: dans(20) }), sa, MAINTENANT)).toBe(false);
    expect(echeanceVisible(echeance({ date: dans(10) }), sa, MAINTENANT)).toBe(true);
    expect(echeanceVisible(echeance({ date: dans(-40) }), sa, MAINTENANT)).toBe(true);
    // Nommément responsable (il est le N+1) : il la voit comme tout responsable.
    expect(echeanceVisible(echeance({ responsables: ["sa"] }), sa, MAINTENANT)).toBe(true);
  });

  it("cloisonnement : la société d'abord, et une pièce restreinte à ses lecteurs (et au Super Admin)", () => {
    expect(echeanceVisible(echeance(), lecteur({ id: "rh", peut: () => true, societePermise: (c) => c === "B" }), MAINTENANT)).toBe(false);
    expect(echeanceVisible(echeance({ date: dans(2) }), lecteur({ id: "dg", sommet: true, societePermise: (c) => c === "B" }), MAINTENANT)).toBe(false);
    const restreinte = echeance({ responsables: [], lecteurs: ["lecteur"], droit: { module: "LEGAL", action: "UPDATE" } });
    const juriste = (id: string) => lecteur({ id, peut: () => true });
    expect(echeanceVisible(restreinte, juriste("voisin"), MAINTENANT)).toBe(false);
    expect(echeanceVisible(restreinte, juriste("lecteur"), MAINTENANT)).toBe(true);
    expect(echeanceVisible({ ...restreinte, date: dans(3) }, sa, MAINTENANT)).toBe(true);
  });

  it("dans la file : « Plus tard » à J-30, « Aujourd'hui » à J-10, « En retard » une fois dépassée — sous le module", () => {
    const groupeDe = (date: Date) => {
      const lots = regrouperFile(lignesEcheances([echeance({ date })], rh, MAINTENANT), MAINTENANT);
      expect(lots).toHaveLength(1);
      expect(lots[0].chapeau).toBe("Ressources humaines");
      const g = grouperAFaire(lots).groupes.find((x) => x.n > 0);
      return { cle: g?.cle, ligne: g?.lignes[0] };
    };
    expect(groupeDe(dans(30)).cle).toBe("plus-tard");
    expect(groupeDe(dans(30)).ligne?.titre).toBe("Fin de CDD — Samir Haddad");
    expect(groupeDe(dans(30)).ligne?.sousTitre).toContain("dans 30 j");
    expect(groupeDe(dans(10)).cle).toBe("aujourdhui");
    expect(groupeDe(dans(-2)).cle).toBe("retard");
    expect(groupeDe(dans(-2)).ligne?.sousTitre).toContain("2 j de retard");
  });

  it("un lot par module, la plus proche en tête ; au-delà du plafond, une ligne « et N autres » mène à la liste", () => {
    const beaucoup = Array.from({ length: ECHEANCES_PAR_MODULE + 3 }, (_, i) => echeance({ id: `e${i}`, libelle: `Fin de CDD — n°${i}`, date: dans(25 - (i % 20)) }));
    const legal = echeance({ source: "legal.document", id: "d1", module: "Legal", libelle: "Échéance — Bail", droit: { module: "LEGAL", action: "UPDATE" }, responsables: ["rh"], liste: "/legal?echeances=1" });
    const lots = regrouperFile(lignesEcheances([...beaucoup, legal], rh, MAINTENANT), MAINTENANT);
    const lotRh = lots.find((l) => l.module === "Ressources humaines");
    expect(lotRh?.n).toBe(ECHEANCES_PAR_MODULE);
    expect(lotRh?.suite?.libelle).toBe("Et 3 autres échéances — tout voir");
    expect(lotRh?.geste.href).toBe("/rh");
    expect(lotRh?.lignes[0].echeanceDans).toBeLessThanOrEqual(lotRh?.lignes[1].echeanceDans ?? 0);
    expect(lots.find((l) => l.module === "Legal")?.titre).toBe("Échéance — Bail");
  });

  it("la société est dite sur la ligne quand le groupe en a plusieurs", () => {
    const [l] = lignesEcheances([echeance()], rh, MAINTENANT, new Map([["A", "Adventum"], ["B", "Pharmagène"]]));
    expect(l.subtitle).toBe("Délégué médical · Adventum · le 14 décembre 2026 · dans 20 j");
    expect(l.objet).toBe("ECHEANCE:rh.contrat:e1");
  });
});
