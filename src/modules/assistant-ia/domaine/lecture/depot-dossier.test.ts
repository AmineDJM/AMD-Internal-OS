import { describe, expect, it } from "vitest";
import {
  BORNES_DOSSIER_DEFAUT, bornesDossier, compterLot, dossiersARecreer, empreinteDepot, entreesMaxDossier, lotFini, modeDuDepot,
  nomLibre, phraseLot, planifierDossier, racineDuDepot, restantsAEnvoyer, type EtatLot,
} from "./depot-dossier";
import { parcourirDepot, type EntreeDepot } from "./depot";

const f = (chemin: string, taille = 10) => ({ chemin, taille });
const dossier300 = Array.from({ length: 300 }, (_, i) => f(`Dossier CTD/Module ${1 + (i % 5)}/piece-${String(i).padStart(3, "0")}.pdf`, 1000 + i));

describe("le dépôt de dossier — les règles (J11)", () => {
  it("au-delà de 6 pièces (K3), un dossier OU des fichiers en vrac passent en mode « dépôt » — tout est lu en arrière-plan", () => {
    expect(modeDuDepot(dossier300)).toBe("dossier");
    // K3 (décision 0033) : au-delà de 6 pièces — dossier OU fichiers isolés —, le dépôt est proposé d'office.
    expect(modeDuDepot(dossier300.slice(0, 6))).toBe("message");
    expect(modeDuDepot(dossier300.slice(0, 7))).toBe("dossier");
    expect(modeDuDepot(dossier300.slice(0, 4), 3)).toBe("dossier");
    expect(modeDuDepot(Array.from({ length: 30 }, (_, i) => f(`vrac-${i}.pdf`)))).toBe("dossier");
    expect(modeDuDepot(Array.from({ length: 6 }, (_, i) => f(`vrac-${i}.pdf`)))).toBe("message");
  });

  it("les bornes : 1 000 fichiers et 2 Go par défaut, réglables par variable ; chaque refus nomme le fichier", () => {
    expect(BORNES_DOSSIER_DEFAUT).toEqual({ fichiers: 1000, octets: 2 * 1024 ** 3 });
    expect(bornesDossier({ ASSISTANT_DEPOT_DOSSIER_FICHIERS: "50", ASSISTANT_DEPOT_DOSSIER_MO: "100" })).toEqual({ fichiers: 50, octets: 100 * 1024 * 1024 });
    expect(bornesDossier({ ASSISTANT_DEPOT_DOSSIER_FICHIERS: "abc" })).toEqual(BORNES_DOSSIER_DEFAUT);
    const p = planifierDossier(dossier300, { fichiers: 250, octets: 10 ** 9 });
    expect(p.acceptes).toHaveLength(250);
    expect(p.refus).toHaveLength(50);
    expect(p.refus[0]!.raison).toMatch(/250 fichiers/);
    const o = planifierDossier([f("a/x.pdf", 600), f("a/y.pdf", 600), f("a/vide.pdf", 0), f("a/.DS_Store", 4)], { fichiers: 10, octets: 1000 });
    expect(o.acceptes.map((a) => a.chemin)).toEqual(["a/x.pdf"]);
    expect(o.refus.map((r) => r.chemin)).toEqual(["a/y.pdf", "a/vide.pdf"]);
  });

  it("la racine garde le nom du dossier déposé ; plusieurs dossiers se rangent sous un dossier daté", () => {
    const r = racineDuDepot(dossier300);
    expect(r.nom).toBe("Dossier CTD");
    expect(r.fichiers[0]!.relatif).toBe("Module 1/piece-000.pdf");
    const m = racineDuDepot([f("A/x.pdf"), f("B/y.pdf")], new Date(2026, 9, 30, 21, 50));
    expect(m.nom).toBe("Dépôt du 30-10-2026 21h50");
    expect(m.fichiers.map((x) => x.relatif)).toEqual(["A/x.pdf", "B/y.pdf"]);
  });

  it("l'arborescence à recréer : chaque dossier une fois, parents d'abord", () => {
    expect(dossiersARecreer(["a/b/c.pdf", "a/d.pdf", "e.pdf", "a/b/f/g.pdf"])).toEqual(["a", "a/b", "a/b/f"]);
    expect(nomLibre("Congrès", new Set(["Congrès", "Congrès (2)"]))).toBe("Congrès (3)");
  });

  it("l'empreinte retrouve le même dépôt quel que soit l'ordre ; un fichier de plus en fait un autre", () => {
    const a = empreinteDepot(dossier300);
    expect(empreinteDepot([...dossier300].reverse())).toBe(a);
    expect(empreinteDepot([...dossier300, f("Dossier CTD/x.pdf")])).not.toBe(a);
  });

  it("la reprise ne renvoie que ce qui manque dans le Drive (même chemin, même taille)", () => {
    const tous = racineDuDepot(dossier300).fichiers;
    const deja = tous.slice(0, 120).map((x) => ({ relatif: x.relatif, taille: x.taille }));
    expect(restantsAEnvoyer(tous, deja)).toHaveLength(180);
    expect(restantsAEnvoyer(tous, [{ relatif: tous[0]!.relatif, taille: 1 }])).toHaveLength(300);
  });

  it("le parcours d'un dossier va jusqu'à la borne du mode dossier (plus 500 entrées)", async () => {
    const fichier = (name: string): EntreeDepot => ({ isFile: true, isDirectory: false, name, fichier: async () => ({ name, size: 1, type: "" }) });
    const racine: EntreeDepot = { isFile: false, isDirectory: true, name: "Gros", lister: async () => Array.from({ length: 800 }, (_, i) => fichier(`f${i}.pdf`)) };
    expect((await parcourirDepot([racine], entreesMaxDossier())).trouves).toHaveLength(800);
  });

  it("l'état d'un lot : n fichiers, lus, échoués, en file — et quand il est fini", () => {
    const c = compterLot(["FAITE", "FAITE", "ECHEC", "A_FAIRE", "EN_COURS", "IGNOREE"]);
    expect(c).toEqual({ televerses: 6, lus: 2, ignores: 1, echoues: 1, enFile: 2 });
    const e: EtatLot = { id: "l", nom: "X", racineId: "r", statut: "TELEVERSEMENT", annonces: 300, ...c, createdAt: "" };
    expect(phraseLot(e)).toBe("300 fichiers — 2 lus, 1 sans texte, 1 échoué, 2 en file, 294 à téléverser");
    expect(lotFini(e)).toBe(false);
    expect(lotFini({ ...e, annonces: 6, enFile: 0 })).toBe(true);
  });
});
