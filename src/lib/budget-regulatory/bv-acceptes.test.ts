import { describe, expect, it } from "vitest";
import {
  categorieDuBvAccepte, dateDuPaiement, encadreBudgetBv, imputationDesBvAcceptes,
  type BvAccepte, type CategorieBvCandidate,
} from "./bv-acceptes";
import { lignesBv, totauxBv, type DossierBv, type OrdreBv } from "./bv";
import { syntheseSimple } from "./synthese";

/**
 * LES BV ACCEPTÉS AU CENTRE DE VALIDATIONS DANS LE BUDGET REGULATORY — engagé, consommé, la ligne choisie, et jamais
 * deux fois le même dinar (prévision 3 × BV 25 %, ancien circuit).
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const env = (id: string, debut: string, fin: string, isActive = true, companyId: string | null = null) =>
  ({ id, nom: `Env ${id}`, companyId, isActive, periodStart: d(debut), periodEnd: d(fin) });
const cat = (id: string, cle: string, e: ReturnType<typeof env>): CategorieBvCandidate => ({ id, nom: `Cat ${id}`, cle, enveloppe: e });

describe("BV acceptés — la ligne du budget", () => {
  const e26 = env("2026", "2026-01-01", "2026-12-31");
  const e27 = env("2027", "2027-01-01", "2027-12-31");
  const brouillon = env("2026b", "2026-06-01", "2026-12-31", false);
  const candidates = [cat("c25-26", "BV_25", e26), cat("c75-26", "BV_75", e26), cat("c25-27", "BV_25", e27), cat("c25-b", "BV_25", brouillon)];

  it("la catégorie de SA part, dans l'enveloppe qui couvre la date d'acceptation — l'active d'abord", () => {
    expect(categorieDuBvAccepte("25", d("2026-11-24"), candidates)?.id).toBe("c25-26");
    expect(categorieDuBvAccepte("75", d("2026-11-24"), candidates)?.id).toBe("c75-26");
    expect(categorieDuBvAccepte("25", d("2027-02-01"), candidates)?.id).toBe("c25-27");
    expect(categorieDuBvAccepte("75", d("2027-02-01"), candidates), "pas de ligne BV 75 % en 2027").toBeNull();
    expect(categorieDuBvAccepte("25", d("2025-05-01"), candidates)).toBeNull();
  });

  it("jamais l'enveloppe d'une autre entité que celle du dossier", () => {
    const autre = [cat("x", "BV_25", env("pg", "2026-01-01", "2026-12-31", true, "pharmagene"))];
    expect(categorieDuBvAccepte("25", d("2026-03-01"), autre, "adventum")).toBeNull();
    expect(categorieDuBvAccepte("25", d("2026-03-01"), autre, "pharmagene")?.id).toBe("x");
    expect(categorieDuBvAccepte("25", d("2026-03-01"), autre, null)?.id).toBe("x");
  });

  it("la date du paiement : celle de l'étape « fait », à défaut l'acceptation", () => {
    expect(dateDuPaiement({ date: "2026-11-30" }, d("2026-11-01")).toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(dateDuPaiement(null, d("2026-11-01")).toISOString().slice(0, 10)).toBe("2026-11-01");
  });
});

describe("BV acceptés — engagé puis consommé, jamais les deux", () => {
  const bv = (o: Partial<BvAccepte>): BvAccepte => ({
    validationId: "v", productId: "p", companyId: null, nature: "25", montant: 100_000, accepteLe: d("2026-11-10"),
    paiementFait: false, payeLe: null, categoryId: "c25", ...o,
  });
  const cats = new Set(["c25", "c75"]);

  it("accepté → engagé ; payé → consommé du MÊME montant (rien ne s'ajoute) ; remis à « à faire » → réengagé", () => {
    const engage = imputationDesBvAcceptes([bv({})], cats);
    expect(engage.committed.get("c25")).toBe(100_000);
    expect(engage.consumed.size).toBe(0);
    const paye = imputationDesBvAcceptes([bv({ paiementFait: true, payeLe: d("2026-11-20") })], cats);
    expect(paye.consumed.get("c25")).toBe(100_000);
    expect(paye.committed.get("c25") ?? 0).toBe(0);
    expect(paye.rows).toEqual([{ categoryId: "c25", date: d("2026-11-20"), amount: 100_000 }]);
    expect(imputationDesBvAcceptes([bv({ paiementFait: false })], cats).committed.get("c25")).toBe(100_000);
  });

  it("hors des catégories lues, sans catégorie, ou consommé hors période : rien", () => {
    expect(imputationDesBvAcceptes([bv({ categoryId: "ailleurs" })], cats).committed.size).toBe(0);
    expect(imputationDesBvAcceptes([bv({ categoryId: null })], cats).committed.size).toBe(0);
    const hors = imputationDesBvAcceptes([bv({ paiementFait: true, payeLe: d("2025-12-31") })], cats, d("2026-01-01"), d("2026-12-31"));
    expect(hors.consumed.size).toBe(0);
    const apres = imputationDesBvAcceptes([bv({ accepteLe: d("2027-01-02") })], cats, d("2026-01-01"), d("2026-12-31"));
    expect(apres.committed.size, "accepté après la période : pas encore engagé dans celle-ci").toBe(0);
  });
});

describe("BV acceptés — lus avec l'ancien circuit et la prévision, sans double compte", () => {
  const dossier: DossierBv = { id: "p", reference: "REG-1", dci: "DCI", nom: null, status: "IN_PREPARATION", workflow: {} };
  const ordre = (o: Partial<OrdreBv>): OrdreBv => ({
    id: "o", productId: "p", label: "BV 25 % — REG-1", amount: 100_000, status: "PENDING", paidDate: null,
    createdAt: d("2026-11-01"), budgetCategoryId: "c25", transactionCategoryId: null, ...o,
  });

  it("BV 25 % accepté : engagé, et la prévision 3 × engage le 75 % ; le 75 % réel accepté remplace la prévision", () => {
    const seul25 = lignesBv({ dossiers: [dossier], ordres: [ordre({ id: "v25", circuit: "VALIDATION" })], saisies: [], categories: { bv25: "c25", bv75: "c75" } });
    expect(seul25[0].bv25.demande).toBe(100_000);
    expect(seul25[0].prevision75).toBe(300_000);
    expect(seul25[0].bv25.aImputer, "un BV du centre n'est jamais « à ranger »").toEqual([]);
    const s1 = syntheseSimple(seul25, { total: 1_000_000, consumed: 0, committed: 100_000 });
    expect(s1.engage, "100 000 engagés + 300 000 prévus").toBe(400_000);

    const avec75 = lignesBv({
      dossiers: [dossier],
      ordres: [ordre({ id: "v25", circuit: "VALIDATION" }), ordre({ id: "v75", label: "BV 75 %", amount: 280_000, budgetCategoryId: "c75", circuit: "VALIDATION" })],
      saisies: [], categories: { bv25: "c25", bv75: "c75" },
    });
    expect(avec75[0].prevision75, "le 75 % réel engagé efface la prévision").toBe(0);
    // L'enveloppe compte déjà ces deux engagements (getBudgetOverview) : la synthèse ne les ajoute pas une seconde fois.
    const s2 = syntheseSimple(avec75, { total: 1_000_000, consumed: 0, committed: 380_000 });
    expect(s2.engage).toBe(380_000);
  });

  it("payé : consommé et compté dans l'enveloppe ; la prévision reste tant que le 75 % n'est pas engagé", () => {
    const payes = lignesBv({
      dossiers: [dossier],
      ordres: [ordre({ id: "v25", status: "PAID", paidDate: d("2026-11-20"), transactionCategoryId: "c25", circuit: "VALIDATION" })],
      saisies: [], categories: { bv25: "c25", bv75: "c75" },
    });
    expect(payes[0].bv25.paye).toBe(100_000);
    expect(payes[0].bv25.demande).toBe(0);
    expect(payes[0].bv25.dansEnveloppe).toBe(100_000);
    expect(totauxBv(payes).paye25).toBe(100_000);
  });

  it("encadré de la fiche : demandé / engagé / consommé, prévision du 75 % jusqu'à son engagement", () => {
    const [l25, l75] = encadreBudgetBv([{ nature: "25", circuit: "VALIDATION", demande: 100_000, engage: 100_000, consomme: 0, enveloppe: "Env › BV 25 %" }], true);
    expect(l25).toMatchObject({ demande: 100_000, engage: 100_000, consomme: 0, enveloppe: "Env › BV 25 %" });
    expect(l75.prevision).toBe(300_000);
    const [, avec75] = encadreBudgetBv([
      { nature: "25", circuit: "ORDRE", demande: 100_000, engage: 0, consomme: 100_000, enveloppe: null },
      { nature: "75", circuit: "VALIDATION", demande: 300_000, engage: 300_000, consomme: 0, enveloppe: "Env › BV 75 %" },
    ], true);
    expect(avec75.prevision).toBe(0);
    const [, demande75] = encadreBudgetBv([
      { nature: "25", circuit: "VALIDATION", demande: 100_000, engage: 0, consomme: 100_000, enveloppe: null },
      { nature: "75", circuit: "VALIDATION", demande: 300_000, engage: 0, consomme: 0, enveloppe: null },
    ], true);
    expect(demande75.prevision, "un 75 % demandé mais pas accepté n'engage rien : la prévision tient").toBe(300_000);
    expect(encadreBudgetBv([{ nature: "25", circuit: "VALIDATION", demande: 1, engage: 1, consomme: 0, enveloppe: null }], false)[1].prevision).toBe(0);
  });
});
