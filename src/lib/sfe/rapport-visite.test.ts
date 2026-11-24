import { describe, expect, it } from "vitest";
import { lireLecturePv, peutRelireRapport, texteAAnalyser, trierARelire, appelleUnHumain } from "./rapport-visite";

const CR = "Le Dr Achour a présenté le produit en staff. Une patiente a fait une éruption cutanée après la deuxième prise. Il demande la fiche posologique.";

describe("lireLecturePv — la réponse du modèle relue", () => {
  it("garde la citation quand elle se lit MOT POUR MOT dans le compte rendu (à la casse près)", () => {
    const l = lireLecturePv({ pv: "PROBABLE", raison: "Éruption chez une patiente.", extrait: "une patiente a fait une éruption cutanée après la deuxième prise", priorite: 95 }, CR);
    expect(l).toEqual({ pv: "PROBABLE", raison: "Éruption chez une patiente.", extrait: "Une patiente a fait une éruption cutanée après la deuxième prise", priorite: 95 });
  });

  it("une citation inventée ne s'affiche jamais : repli sur la phrase du texte qui porte la pharmacovigilance", () => {
    const l = lireLecturePv({ pv: "POSSIBLE", raison: "Réaction.", extrait: "La patiente est hospitalisée d'urgence.", priorite: 70 }, CR);
    expect(l?.extrait).toBe("Une patiente a fait une éruption cutanée après la deuxième prise.");
  });

  it("un cas possible ne descend pas sous son seuil ; la priorité reste bornée à 0-100", () => {
    expect(lireLecturePv({ pv: "PROBABLE", raison: "", extrait: "", priorite: 5 }, CR)?.priorite).toBe(85);
    expect(lireLecturePv({ pv: "POSSIBLE", raison: "", extrait: "", priorite: 10 }, CR)?.priorite).toBe(60);
    expect(lireLecturePv({ pv: "AUCUN", raison: "RAS", extrait: "Il demande la fiche posologique.", priorite: 250 }, CR)).toMatchObject({ priorite: 100, extrait: null });
    expect(lireLecturePv({ pv: "AUCUN", raison: "", extrait: "", priorite: -3 }, CR)).toMatchObject({ priorite: 0, raison: "Aucun signe de pharmacovigilance" });
  });

  it("une réponse hors forme est un échec (null), pas un « aucun » silencieux", () => {
    expect(lireLecturePv(null, CR)).toBeNull();
    expect(lireLecturePv({ pv: "PEUT-ÊTRE", raison: "", extrait: "", priorite: 50 }, CR)).toBeNull();
    expect(lireLecturePv({ pv: "AUCUN", raison: "", extrait: "" }, CR)).toBeNull();
  });

  it("seuls POSSIBLE et PROBABLE appellent un humain", () => {
    expect(["AUCUN", "POSSIBLE", "PROBABLE", null].map(appelleUnHumain)).toEqual([false, true, true, false]);
  });
});

describe("texteAAnalyser", () => {
  it("joint le retour du médecin et la suite, et borne la longueur", () => {
    expect(texteAAnalyser({ report: "CR.", doctorFeedback: "Content.", followUpActions: null })).toBe("CR.\nRetour du médecin : Content.");
    expect(texteAAnalyser({ report: "x".repeat(10_000) }).length).toBe(4_000);
  });
});

describe("trierARelire — l'ordre de la file du superviseur", () => {
  const d = (j: number) => new Date(2026, 10, j);
  it("probables, puis possibles, puis la priorité de l'IA ; les non lus après, les plus récents d'abord", () => {
    const lignes = [
      { id: "banal", pvIa: "AUCUN", prioriteIa: 20, date: d(20) },
      { id: "nonlu-ancien", pvIa: null, prioriteIa: null, date: d(10) },
      { id: "possible", pvIa: "POSSIBLE", prioriteIa: 60, date: d(12) },
      { id: "objection", pvIa: "AUCUN", prioriteIa: 75, date: d(11) },
      { id: "probable", pvIa: "PROBABLE", prioriteIa: 85, date: d(5) },
      { id: "nonlu-recent", pvIa: null, prioriteIa: null, date: d(21) },
    ];
    expect(trierARelire(lignes).map((l) => l.id)).toEqual(["probable", "possible", "objection", "banal", "nonlu-recent", "nonlu-ancien"]);
  });
});

describe("peutRelireRapport — l'équipe du plan de tournée", () => {
  const base = { repId: "kam", superviseurBuId: "sup", managerRhId: "n1" };
  it("le superviseur de la BU et le N+1 relisent ; personne d'autre, jamais le délégué lui-même", () => {
    expect(peutRelireRapport({ ...base, userId: "sup" })).toBe(true);
    expect(peutRelireRapport({ ...base, userId: "n1" })).toBe(true);
    expect(peutRelireRapport({ ...base, userId: "autre" })).toBe(false);
    expect(peutRelireRapport({ userId: "kam", repId: "kam", superviseurBuId: "kam", managerRhId: null })).toBe(false);
    expect(peutRelireRapport({ userId: "sup", repId: null, superviseurBuId: "sup", managerRhId: null })).toBe(false);
  });
});
