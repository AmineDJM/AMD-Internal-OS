import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { estColonneConfidentielle, masquerColonnes } from "./domaine/analyse/confidentialite";
import { chiffresNonSources } from "./domaine/analyse/chiffres";
import { JeuxDuTour } from "./domaine/analyse/jeux";
import { chartEnBloc, lireChart } from "./domaine/ui/graphique";
import { composantsEnBlocs } from "./domaine/ui/composants";
import { outilsAnalyse, type ContexteAnalyse } from "./infra/analyse/outils";
import { CoffretDuTour } from "./domaine/filtre-confidentialite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K1 (décision 0031) — l'ANALYSE DE DONNÉES de l'Assistant IA, sans modèle : les colonnes confidentielles,
 * les chiffres non sourcés, les jeux du tour, le graphique du modèle, et les outils de bout en bout.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const personne = { id: "u-analyse", name: "Banc", role: "EMPLOYEE", access: { role: "EMPLOYEE", modules: {} } } as unknown as CurrentUser;

function contexte(question = ""): ContexteAnalyse & { blocs: WorkspaceBlock[] } {
  return { jeux: new JeuxDuTour(), blocs: [], pieces: [], question, coffret: new CoffretDuTour(), driveOuvert: true };
}
const outil = (ctx: ContexteAnalyse, nom: string) => outilsAnalyse(personne, ctx).find((o) => o.def.name === nom)!;

describe("les colonnes confidentielles d'un tableau — masquées avant tout calcul", () => {
  it("un en-tête qui CONTIENT un mot sensible est confidentiel ; un mot court ne vaut qu'entier", () => {
    for (const e of ["Salaire de base (DZD)", "N° IBAN", "Rémunération brute", "Net à payer", "RIB", "Numéro de passeport"]) expect(estColonneConfidentielle(e), e).toBe(true);
    for (const e of ["Attribution", "Montant", "Ventes", "Contribution", "Nom"]) expect(estColonneConfidentielle(e), e).toBe(false);
  });
  it("les valeurs deviennent « [confidentiel] » — une somme de salaires n'existe plus", () => {
    const m = masquerColonnes([{ nom: "A", "Salaire de base": 120000 }, { nom: "B", "Salaire de base": 98000 }]);
    expect(m.masquees).toEqual(["Salaire de base"]);
    expect(m.lignes.map((l) => l["Salaire de base"])).toEqual(["[confidentiel]", "[confidentiel]"]);
  });
});

describe("les chiffres du message que rien ne prouve", () => {
  const sources = [JSON.stringify({ total: "2 850 000 DZD", part: 12.34, n: 5 })];
  it("un chiffre cité tel quel, ou à l'arrondi d'affichage près, est prouvé", () => {
    expect(chiffresNonSources("Le total est de 2 850 000 DZD (5 sociétés), soit 12,3 % ; en 2026.", sources)).toEqual([]);
  });
  it("un chiffre calculé de tête est compté", () => {
    expect(chiffresNonSources("La moyenne est de 570 000 DZD.", sources)).toEqual(["570 000"]);
  });
});

describe("les jeux de données du tour", () => {
  it("une sortie de lecture donne un jeu par tableau, le plus grand sous le nom de l'outil", () => {
    const j = new JeuxDuTour();
    j.noter("read_budget", JSON.stringify({ enveloppes: 2, detail: [{ enveloppe: "A", total: "10 DZD" }, { enveloppe: "B", total: "20 DZD" }] }));
    expect(j.trouver("read_budget")?.lignes).toHaveLength(2);
    expect(j.trouver("READ_BUDGET.detail")?.origine).toBe("lecture read_budget · detail");
    expect(j.trouver("inconnu")).toBeNull();
  });
});

describe("le composant chart du modèle — formes, choix, garde", () => {
  const sorties = [JSON.stringify({ a: 10, b: 20, c: 30, d: 5, e: 7, f: 9, g: 11, h: 13 })];
  it("huit secteurs demandés : remplacés par des barres, et dit", () => {
    const c = { type: "chart", title: "Parts", chartType: "secteurs", labels: ["A", "B", "C", "D", "E", "F", "G", "H"], series: [{ name: "v", values: [10, 20, 30, 5, 7, 9, 11, 13] }] };
    const r = composantsEnBlocs({ message: "ok", composants: [c] }, { sorties, question: "" });
    expect(r.blocs[0]).toMatchObject({ kind: "viz", type: "barres" });
    expect((r.blocs[0] as { note?: string }).note).toMatch(/remplacée/);
  });
  it("barres groupées, anneau, heatmap, nuage", () => {
    const deux = { labels: ["T1", "T2"], series: [{ name: "2025", values: [10, 20] }, { name: "2026", values: [30, 5] }] };
    expect(chartEnBloc({ chartType: "barres_groupees", ...deux }, lireChart(deux), "x")).toMatchObject({ type: "barres" });
    expect(chartEnBloc({ chartType: "anneau", ...deux }, lireChart(deux), "x")).toMatchObject({ type: "secteurs" });
    expect(chartEnBloc({ chartType: "heatmap", ...deux }, lireChart(deux), "x")).toMatchObject({ type: "heatmap" });
    const pts = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
    expect(chartEnBloc({ chartType: "nuage", ...pts }, lireChart(pts), "x")).toMatchObject({ type: "nuage" });
  });
});

describe("les outils d'analyse, de bout en bout (sans modèle ni base)", () => {
  it("analyser_donnees calcule sur une LECTURE du tour : bloc posé, chiffres formatés pour le modèle", async () => {
    const ctx = contexte("Quel budget consommé par enveloppe ?");
    ctx.jeux.noter("read_budget", JSON.stringify({ detail: [
      { enveloppe: "Marketing 2026", total: "12 000 000 DZD", consomme: "4 500 000 DZD" },
      { enveloppe: "Formation 2026", total: "3 000 000 DZD", consomme: "2 400 000 DZD" },
    ] }));
    const sortie = JSON.parse(await outil(ctx, "analyser_donnees").run({ source: "read_budget", titre: "Consommé", etapes: [{ op: "trier", colonne: "consomme", sens: "desc" }] }, personne)) as Record<string, unknown>;
    expect(sortie.ok).toBe(true);
    expect(ctx.blocs).toHaveLength(1);
    const b = ctx.blocs[0] as Extract<WorkspaceBlock, { kind: "analyse" }>;
    expect(b.lignes).toEqual([["Marketing 2026", 12_000_000, 4_500_000], ["Formation 2026", 3_000_000, 2_400_000]]);
    expect(b.totaux).toEqual([null, 15_000_000, 6_900_000]);
    expect(b.exportExcel).toBe("/api/assistant-ia/analyse/classeur");
    expect((sortie.totaux as Record<string, string>).consomme).toMatch(/^6\s900\s000 DZD$/);
  });

  it("une source inconnue : la liste des jeux est rendue, rien n'est inventé", async () => {
    const ctx = contexte();
    ctx.jeux.noter("demandes", JSON.stringify([{ id: 1 }, { id: 2 }]));
    const s = JSON.parse(await outil(ctx, "analyser_donnees").run({ source: "ventes" }, personne)) as { ok: boolean; erreur: string };
    expect(s.ok).toBe(false);
    expect(s.erreur).toContain("demandes (2 lignes");
  });

  it("calculer_code : JavaScript isolé ; un paramètre absent de la demande est refusé", async () => {
    const ctx = contexte("Taux de croissance annuel moyen de 1200 à 1800 sur 3 ans ?");
    const ok = JSON.parse(await outil(ctx, "calculer_code").run({ code: "return { tcam_pct: Math.round(((params.fin / params.debut) ** (1 / params.ans) - 1) * 10000) / 100 };", params: { debut: 1200, fin: 1800, ans: 3 }, titre: "TCAM" }, personne)) as Record<string, unknown>;
    expect(ok.ok).toBe(true);
    const b = ctx.blocs[0] as Extract<WorkspaceBlock, { kind: "analyse" }>;
    expect(b.lignes).toEqual([[14.47]]);
    expect(b.colonnes[0]).toMatchObject({ cle: "tcam_pct", format: "pourcent" });
    const ko = JSON.parse(await outil(ctx, "calculer_code").run({ code: "return 1;", params: { taux: 0.19 } }, personne)) as { ok: boolean; erreur: string };
    expect(ko.ok).toBe(false);
    expect(ko.erreur).toContain("ne vient ni de la demande");
  });

  it("requete_sql n'est pas offert sans la vue globale — et refuse une colonne confidentielle même sous un alias", async () => {
    expect(outil(contexte(), "requete_sql").allowed(personne)).toBe(false);
    for (const sql of ['SELECT "baseSalary" AS x FROM "Employee"', 'SELECT iban FROM "Supplier"', "SELECT salaire_base FROM t"]) {
      const r = JSON.parse(await outil(contexte(), "requete_sql").run({ sql }, personne)) as { ok: boolean; erreur: string };
      expect(r.ok, sql).toBe(false);
      expect(r.erreur).toContain("colonne confidentielle");
    }
  });
});
