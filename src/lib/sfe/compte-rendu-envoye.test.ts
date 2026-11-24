import { describe, expect, it } from "vitest";
import { alertePvOuverte, comptesRendusEnRetard, etatLectureIa, etatRelecture, refusEcarterAlertePv, tonDuDelai } from "./compte-rendu-envoye";

const LU = "2026-11-24T10:00:00.000Z";
const base = { pvIa: null as string | null, extrait: null as string | null, analyseLe: null as string | null, cas: null, ecarteLe: null as string | null };

describe("après l'envoi — la lecture par l'IA, dans l'ordre où elle se tranche", () => {
  it("pas encore lue : en attente, sans geste", () => {
    expect(etatLectureIa(base)).toMatchObject({ sorte: "EN_ATTENTE", gestes: false });
    // Lue mais en échec (pvIa nul) : toujours en attente.
    expect(etatLectureIa({ ...base, analyseLe: LU })).toMatchObject({ sorte: "EN_ATTENTE" });
  });
  it("lue sans signal : rien à faire", () => {
    expect(etatLectureIa({ ...base, pvIa: "AUCUN", analyseLe: LU })).toMatchObject({ sorte: "RIEN", gestes: false, citation: null });
  });
  it("signal : l'alerte, la citation exacte, les deux gestes", () => {
    const e = etatLectureIa({ ...base, pvIa: "POSSIBLE", analyseLe: LU, extrait: "malaise avec sueurs" });
    expect(e).toMatchObject({ sorte: "ALERTE", gestes: true, citation: "malaise avec sueurs", ton: "danger", titre: "Possible cas de pharmacovigilance" });
    expect(etatLectureIa({ ...base, pvIa: "PROBABLE", analyseLe: LU }).titre).toBe("Probable cas de pharmacovigilance");
  });
  it("« ce n'est pas un cas » : la réponse est dite, plus de geste, la citation reste", () => {
    expect(etatLectureIa({ ...base, pvIa: "POSSIBLE", analyseLe: LU, extrait: "x", ecarteLe: LU })).toMatchObject({ sorte: "ECARTE", gestes: false, citation: "x" });
  });
  it("un cas déclaré passe devant tout : la référence, plus d'alerte", () => {
    expect(etatLectureIa({ ...base, pvIa: "POSSIBLE", analyseLe: LU, cas: { id: "c1", reference: "PV-2026-034" } as never }))
      .toMatchObject({ sorte: "DECLARE", titre: "Cas déclaré : PV-2026-034", citation: null, gestes: false });
  });
  it("la pastille « Possible PV — à déclarer » n'est allumée que par l'alerte ouverte", () => {
    expect(alertePvOuverte({ pvIa: "POSSIBLE", analyseLe: LU, cas: null, ecarteLe: null })).toBe(true);
    expect(alertePvOuverte({ pvIa: "POSSIBLE", analyseLe: LU, cas: null, ecarteLe: LU })).toBe(false);
    expect(alertePvOuverte({ pvIa: "AUCUN", analyseLe: LU, cas: null, ecarteLe: null })).toBe(false);
  });
});

describe("« ce n'est pas un cas » — qui, et quand", () => {
  const ok = { delegateId: "k", userId: "k", pvIa: "POSSIBLE", nbCas: 0, ecarteLe: null };
  it("le délégué de la visite, sur une alerte ouverte", () => expect(refusEcarterAlertePv(ok)).toBeNull());
  it("refusé à un autre, sans signal, après un cas, ou une seconde fois — chaque refus dit pourquoi", () => {
    expect(refusEcarterAlertePv({ ...ok, userId: "x" })).toMatch(/Seul le délégué/);
    expect(refusEcarterAlertePv({ ...ok, pvIa: "AUCUN" })).toMatch(/aucun possible cas/);
    expect(refusEcarterAlertePv({ ...ok, pvIa: null })).toMatch(/aucun possible cas/);
    expect(refusEcarterAlertePv({ ...ok, nbCas: 1 })).toMatch(/déjà déclaré/);
    expect(refusEcarterAlertePv({ ...ok, ecarteLe: new Date() })).toMatch(/déjà indiqué/);
  });
});

describe("la relecture du superviseur, en une ligne", () => {
  it("relu, prioritaire, ou en attente", () => {
    expect(etatRelecture({ relu: { le: LU, par: "S", mot: null }, pvIa: "POSSIBLE", cas: null })).toEqual({ libelle: "Relu", ton: "success" });
    expect(etatRelecture({ relu: null, pvIa: "PROBABLE", cas: null })).toEqual({ libelle: "À relire en priorité", ton: "danger" });
    expect(etatRelecture({ relu: null, pvIa: "AUCUN", cas: null })).toEqual({ libelle: "En attente de relecture", ton: "warning" });
  });
});

describe("les comptes rendus en retard de « Ma journée »", () => {
  const jourDe = (iso: string) => iso.slice(0, 10);
  const v = (id: string, date: string, etat: "A_FAIRE" | "FAITE" | "PERDUE", heuresRestantes: number) => ({ id, date, etat, heuresRestantes });
  it("ouverts : jours passés encore à faire, le plus pressé d'abord ; fermés : perdus, le plus récent d'abord ; le jour même n'y est pas", () => {
    const r = comptesRendusEnRetard([
      v("a", "2026-11-23T09:00:00Z", "A_FAIRE", 24),
      v("b", "2026-11-22T14:00:00Z", "A_FAIRE", 3),
      v("c", "2026-11-22T09:00:00Z", "PERDUE", 0),
      v("d", "2026-11-23T08:00:00Z", "PERDUE", 0),
      v("e", "2026-11-23T10:00:00Z", "FAITE", 20),
      v("f", "2026-11-24T08:00:00Z", "A_FAIRE", 48),
    ], "2026-11-24", jourDe);
    expect(r.ouverts.map((x) => x.id)).toEqual(["b", "a"]);
    expect(r.fermes.map((x) => x.id)).toEqual(["d", "c"]);
  });
  it("le délai : rouge sous 6 h, ambre au-delà", () => {
    expect(tonDuDelai(3)).toBe("danger");
    expect(tonDuDelai(6)).toBe("danger");
    expect(tonDuDelai(7)).toBe("warning");
  });
});
