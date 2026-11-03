import { afterAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { executePowerTool, POWER_TOOLS, powerToolsFor } from "./power-tools";
import { SANDBOX_TOOLS } from "./sandbox-tools";
import { shortlistNames } from "./context/tool-shortlist";
import { routeQuery } from "./context/router";
import { stripDisplayPayload } from "./workspace/compose";

/**
 * LES OUTILS DU BAC À SABLE, PAR LE VRAI POINT D'ENTRÉE (§14) : `executePowerTool`, qui revérifie
 * le droit. Ce qu'on prouve : `sql_query` est fermé à qui n'a pas la vue globale et OUVERT à la
 * direction, avec une ligne d'audit à son nom ; `run_analysis` refuse une source qui n'est pas
 * une lecture ; ses résultats portent un tableau composé par le code et une provenance ;
 * `run_code` calcule ; `chart_advice` juge une spec trompeuse ; et le routeur mène une
 * question d'analyse au domaine qui expose ces outils.
 */
const salarie = { id: "sandbox-tools-salarie", name: "Salarié", email: "s@test.dz", role: "VIEWER", access: { modules: new Map() } } as unknown as CurrentUser;

/** La direction est À CE BANC : un Super Admin emprunté peut être celui d'un voisin, retiré avant que l'audit ne s'écrive. */
const comptes = comptesDeBanc("__sandboxsql_");
afterAll(() => comptes.retirer());

async function directionReelle(): Promise<CurrentUser> {
  const admin = await comptes.creer("direction", { role: "SUPER_ADMIN" });
  return { ...admin, access: { modules: new Map() } } as unknown as CurrentUser;
}

const lignes = [
  { societe: "Adventum", categorie: "Marketing", date: "2026-01-10", montant: 120_000 },
  { societe: "Adventum", categorie: "IT", date: "2026-02-22", montant: 40_000 },
  { societe: "Pharmalliance", categorie: "Marketing", date: "2026-02-05", montant: 80_000 },
  { societe: "Adventum", categorie: "Marketing", date: "2026-03-14", montant: 150_000 },
];

describe("droits et branchement", () => {
  it("les quatre outils sont branchés dans POWER_TOOLS, et sql_query n'est pas montré à un compte sans vue globale", () => {
    const noms = POWER_TOOLS.map((t) => t.def.name);
    for (const t of SANDBOX_TOOLS) expect(noms).toContain(t.def.name);
    const ouverts = powerToolsFor(salarie).map((t) => t.name);
    expect(ouverts).not.toContain("sql_query");
    expect(ouverts).toEqual(expect.arrayContaining(["run_analysis", "run_code", "chart_advice"]));
  });
  it("sql_query est REFUSÉ à l'exécution pour un compte sans vue globale — la liste envoyée au modèle n'est pas une garantie", async () => {
    const r = await executePowerTool("sql_query", { sql: 'SELECT id FROM "Company" LIMIT 1' }, salarie);
    expect(r).toMatch(/ne vous est pas ouvert/);
  });
  it("une question de finance qui demande un calcul GARDE son domaine et ouvre le bac à sable en plus", () => {
    const route = routeQuery("Analyse les dépenses par mois et donne-moi la tendance");
    expect(route.domain).toBe("FINANCE");
    expect(route.secondaires).toEqual(["DATA"]);
    const noms = shortlistNames(route);
    expect(noms).toEqual(expect.arrayContaining(["sql_query", "run_analysis", "run_code", "chart_advice", "finance_totals"]));
    // Une demande SANS ambiguïté (SQL, graphique) fait de DATA le domaine principal.
    expect(routeQuery("Fais-moi une requête SQL qui compte les tâches par statut").domain).toBe("DATA");
    expect(routeQuery("Quel graphique pour montrer la répartition par partenaire ?").domain).toBe("DATA");
    // Et une question de messagerie ne charge rien de tout cela.
    const mail = routeQuery("Prépare un mail à Raihana pour lui demander le rapport");
    expect(mail.secondaires).toBeUndefined();
    expect(shortlistNames(mail)).not.toContain("run_code");
  });
});

describe("run_analysis", () => {
  it("regroupe des lignes fournies, compose un tableau et une provenance, et le modèle ne reçoit pas le bloc", async () => {
    const raw = await executePowerTool("run_analysis", {
      source: { lignes },
      etapes: [{ op: "regrouper", par: ["societe"], mesures: [{ colonne: "montant", agregat: "sum", alias: "total" }] }, { op: "trier", colonne: "total" }],
      titre: "Dépenses par société", question: "compare les sociétés",
    }, salarie);
    const out = JSON.parse(raw!);
    expect(out.ok).toBe(true);
    expect(out.lignes).toEqual([{ societe: "Adventum", total: 310_000 }, { societe: "Pharmalliance", total: 80_000 }]);
    expect(out.etapes.map((e: { op: string }) => e.op)).toEqual(["regrouper", "trier"]);
    expect(out.avertissement).toMatch(/pas vérifiés à la source/);
    expect(out.graphique.type).toBe("barres");
    expect(out._blocs[0]).toMatchObject({ kind: "table", title: "Dépenses par société", total: 2 });
    // `toLocaleString("fr-FR")` sépare les milliers par une espace fine insécable (U+202F).
    expect(out._blocs[0].rows[0].cells.total).toBe("310\u202f000");
    expect(out._provenance[0].calcul).toMatchObject({ transformation: "regrouper → trier", entrees: ["lignes fournies par la conversation"] });
    const pourLeModele = JSON.parse(stripDisplayPayload(raw!));
    expect(pourLeModele._blocs).toBeUndefined();
    expect(pourLeModele._provenance).toBeUndefined();
    expect(pourLeModele.lignes).toHaveLength(2);
  });
  it("une étape refusée est dite, les autres tournent ; une source qui n'est pas une lecture est refusée", async () => {
    const out = JSON.parse((await executePowerTool("run_analysis", { source: { lignes }, etapes: [{ op: "exploser" }, { op: "limiter", n: 2 }] }, salarie))!);
    expect(out.etapesRefusees[0]).toMatch(/opération inconnue/);
    expect(out.lignesTotal).toBe(2);
    const refus = JSON.parse((await executePowerTool("run_analysis", { source: { outil: "teach_adam", args: {} }, etapes: [{ op: "decrire" }] }, salarie))!);
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toMatch(/n'est pas une lecture/);
    const sansSource = JSON.parse((await executePowerTool("run_analysis", { source: {}, etapes: [] }, salarie))!);
    expect(sansSource.erreur).toMatch(/aucune source/);
  });
  it("une source SQL exige la vue globale, même à travers run_analysis", async () => {
    const out = JSON.parse((await executePowerTool("run_analysis", { source: { sql: 'SELECT id FROM "Company"' }, etapes: [{ op: "decrire" }] }, salarie))!);
    expect(out.ok).toBe(false);
    expect(out.erreur).toMatch(/vue globale/);
  });
});

describe("run_code et chart_advice", () => {
  it("run_code (js) calcule sur les lignes de la source et rend un tableau quand le résultat est tabulaire", async () => {
    const out = JSON.parse((await executePowerTool("run_code", {
      langage: "js", source: { lignes }, titre: "Part par catégorie",
      code: "const t = lib.sum(data.map(d => d.montant)); const g = lib.groupBy(data, 'categorie'); return Object.entries(g).map(([k, v]) => ({ categorie: k, part: lib.round(100 * lib.sum(v.map(x => x.montant)) / t, 1) }));",
    }, salarie))!);
    expect(out.ok).toBe(true);
    expect(out.resultat).toEqual([{ categorie: "Marketing", part: 89.7 }, { categorie: "IT", part: 10.3 }]);
    expect(out._blocs[0].kind).toBe("table");
    expect(out.ms).toBeLessThan(3_000);
  });
  it("run_code refuse un code qui cherche l'hôte, et l'explique", async () => {
    const out = JSON.parse((await executePowerTool("run_code", { code: "return process.env", donnees: [] }, salarie))!);
    expect(out.ok).toBe(false);
    expect(out.erreur).toMatch(/process/);
  });
  it("LA PORTE DE QUALITÉ (§34) : un calcul FAUX n'est pas exposé (l'étape « tests » refuse et dit la correction) ; une forme fausse non plus ; un calcul juste passe avec son rapport", async () => {
    const attentes = [{ chemin: "total", op: "egal", valeur: 390_000, libelle: "total des montants" }];
    const faux = JSON.parse((await executePowerTool("run_code", { langage: "js", source: { lignes }, code: "return { total: lib.sum(data.map(d => d.montant)) * 1.19 };", attentes }, salarie))!);
    expect(faux.ok).toBe(false);
    expect(faux.resultat).toBeUndefined();
    expect(faux.porte.refusePar).toBe("tests");
    expect(faux.porte.tests).toBe("0/1");
    expect(faux.erreur).toMatch(/corriger le calcul, pas l'attente/);
    const forme = JSON.parse((await executePowerTool("run_code", { langage: "js", source: { lignes }, code: "return [1, 2, 3];", schema: { forme: "objet", cles: ["total"] } }, salarie))!);
    expect(forme.ok).toBe(false);
    expect(forme.porte.refusePar).toBe("validation");
    const juste = JSON.parse((await executePowerTool("run_code", { langage: "js", source: { lignes }, code: "return { total: lib.sum(data.map(d => d.montant)), n: data.length };", attentes, schema: { forme: "objet", cles: ["total", "n"] } }, salarie))!);
    expect(juste.ok).toBe(true);
    expect(juste.resultat).toEqual({ total: 390_000, n: 4 });
    expect(juste.porte).toMatchObject({ expose: true, refusePar: null, tests: "1/1" });
    expect(juste.porte.etapes).toHaveLength(4);
  });
  it("chart_advice recommande, et juge trompeuse une spec à axe tronqué en 3D", async () => {
    const out = JSON.parse((await executePowerTool("chart_advice", {
      lignes: [{ societe: "A", total: 900 }, { societe: "B", total: 300 }, { societe: "C", total: 150 }], question: "compare les sociétés",
      spec: { type: "barres", x: "societe", y: ["total"], axeYdepartZero: false, troisD: true, titre: "Total" },
    }, salarie))!);
    expect(out.recommandation.type).toBe("barres");
    expect(out.jugementDeLaSpec.trompeur).toBe(true);
    expect(out.jugementDeLaSpec.alertes.join(" ")).toMatch(/axe_tronque/);
    expect(out.jugementDeLaSpec.alertes.join(" ")).toMatch(/trois_d/);
  });
});

describe("sql_query, pour la direction", () => {
  it("lit, compose le tableau, porte la provenance, et laisse une ligne d'audit au nom de la personne", async () => {
    const direction = await directionReelle();
    const marque = `sandbox-audit-${Date.now()}`;
    const raw = await executePowerTool("sql_query", { sql: `SELECT id, name, '${marque}' AS marque FROM "Company" ORDER BY name LIMIT 2`, titre: "Sociétés" }, direction);
    const out = JSON.parse(raw!);
    expect(out.ok, out.erreur).toBe(true);
    expect(out.relations).toEqual(["Company"]);
    expect(out._provenance[0].calcul).toMatchObject({ transformation: "requête SQL en lecture seule", entrees: ["table Company"] });
    expect(out._provenance[0].calcul.formule).toMatch(/^SELECT id, name/);
    if (out.lignes.length) expect(out._blocs[0].kind).toBe("table");
    const audit = await prisma.auditLog.findFirst({ where: { actorId: direction.id, summary: { contains: marque } }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toMatch(/Bac à sable SQL/);
    await prisma.auditLog.deleteMany({ where: { summary: { contains: marque } } });
  });
});
