import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « IL Y A COMBIEN DE SALARIÉS ADVENTUM ? » — un nombre juste, et faux.
 *
 * LE TRANSCRIPT, mot pour mot :
 *
 *   PDG   — Il y'a combien de salarié adventul
 *   Adam  — 18 employés actifs.
 *   PDG   — T'es sur ?
 *   Adam  — Oui : 18 employés actifs. Bonne pioche.
 *   PDG   — Non faux, ça c'est tout ceux qui sont dans la plateforme toute entité confondu.
 *
 * LE CHIFFRE N'ÉTAIT PAS FAUX. C'est son PÉRIMÈTRE qui était tu. `read_hr_overview` ne
 * déclarait AUCUN paramètre (`input_schema: { properties: {} }`) et lisait `getRhData`, qui
 * rend le groupe entier. L'outil ne POUVAIT pas répondre à la question posée — et rien, dans sa
 * sortie, ne signalait qu'il répondait à une autre.
 *
 * LE REMÈDE N'EST PAS SEULEMENT LE FILTRE. Ajouter un paramètre `entite` que le modèle peut
 * oublier de remplir laisserait le piège intact une fois sur deux. La règle qu'on verrouille
 * ici est plus forte : **un agrégat sort TOUJOURS avec sa portée et sa ventilation**. Que le
 * modèle filtre ou non, le périmètre est dans la charge utile — il ne peut plus être omis.
 *
 * Et la contestation (« T'es sûr ? ») doit faire RELIRE, jamais répéter : voir la règle de
 * style dans `assistant.ts`. Le « bonne pioche » du transcript est l'aplomb qu'on ferme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__hrp__${Date.now()}`;
let user: CurrentUser;
const created = { users: [] as string[], companies: [] as string[], employees: [] as string[] };
/** Les fiches déjà sans entité AVANT ce test — la base de développement n'est pas vierge. */
let orphelinsAvant = 0;

function rhUser(id: string): CurrentUser {
  const modules = new Map<Module, { module: Module; actions: Set<Action>; scope: "ALL" }>([
    ["RH", { module: "RH", actions: new Set(["VIEW"] as Action[]), scope: "ALL" }],
  ]);
  return {
    id, name: `${TAG} PDG`, email: `${TAG}.pdg@example.dz`, role: "SUPER_ADMIN",
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

const readHr = async (input: Record<string, unknown> = {}) =>
  JSON.parse((await executePowerTool("read_hr_overview", input, user)) ?? "{}") as Record<string, unknown>;

/** La ventilation, indexée par nom d'entité — ce que le PDG lit. */
const lineFor = (payload: Record<string, unknown>, entite: string) =>
  (payload.parEntite as { entite: string; effectifActif: number; effectifTotal: number }[] | undefined)
    ?.find((c) => c.entite === entite);

suite("un effectif ne sort jamais sans son périmètre", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}.pdg@example.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    created.users.push(u.id);
    user = rhUser(u.id);
    orphelinsAvant = await prisma.employee.count({ where: { companyId: null, isActive: true } });

    // DEUX sociétés, des effectifs DIFFÉRENTS, plus une fiche non rattachée : la configuration
    // exacte qui rend un total de groupe indiscernable d'un total de société.
    const adventum = await prisma.company.create({ data: { name: `${TAG} Adventum Pharma`, shortName: `${TAG} Adventum` } });
    const pharmagene = await prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: null } });
    created.companies.push(adventum.id, pharmagene.id);

    const make = async (n: number, companyId: string | null, actif = true) => {
      for (let i = 0; i < n; i += 1) {
        const e = await prisma.employee.create({
          data: {
            fullName: `${TAG} ${companyId ?? "libre"} ${i}`, companyId, isActive: actif,
            baseSalary: 100_000, position: "Testeur", department: "Essais",
          },
        });
        created.employees.push(e.id);
      }
    };
    await make(4, adventum.id);
    await make(1, adventum.id, false); // une fiche inactive : elle compte dans le total, pas dans l'actif
    await make(7, pharmagene.id);
    await make(2, null); // non rattachées — elles existent, et elles se voient
  });

  afterAll(async () => {
    // On ne nettoie QUE ce que ce test a créé, par identifiant.
    await prisma.employee.deleteMany({ where: { id: { in: created.employees } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: created.companies } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: created.users } } }).catch(() => undefined);
  });

  it("sans filtre : le périmètre est NOMMÉ, et il dit « toute la plateforme »", async () => {
    const out = await readHr();
    expect(String(out.perimetre)).toMatch(/plateforme/i);
    // La correction du PDG, en toutes lettres dans la charge utile.
    expect(String(out.perimetre)).toMatch(/entités confondues/i);
  });

  it("sans filtre : la ventilation par entité accompagne TOUJOURS le total", async () => {
    const out = await readHr();
    expect(Array.isArray(out.parEntite)).toBe(true);
    expect(lineFor(out, `${TAG} Adventum`)?.effectifActif).toBe(4);
    expect(lineFor(out, `${TAG} Pharmagène`)?.effectifActif).toBe(7);
    // Le total du groupe reste disponible — on ne le retire pas, on cesse de le laisser seul.
    expect(Number(out.effectifActif)).toBeGreaterThanOrEqual(13);
  });

  it("avec le nom court : le chiffre est celui de la société, et le périmètre le dit", async () => {
    const out = await readHr({ entite: `${TAG} Adventum` });
    expect(out.entite).toBe(`${TAG} Adventum`);
    expect(out.effectifActif).toBe(4);
    expect(out.effectifTotal).toBe(5); // la fiche inactive compte dans le total
    expect(String(out.perimetre)).toContain("uniquement");
  });

  it("avec la raison sociale complète : même résultat", async () => {
    const out = await readHr({ entite: `${TAG} Adventum Pharma` });
    expect(out.effectifActif).toBe(4);
  });

  it("une entité inconnue ne rend JAMAIS un chiffre attribué à tort", async () => {
    // Le pire échec possible serait ici : répondre « 13 » à une société qui n'existe pas.
    const out = await readHr({ entite: "Société Fantôme" });
    expect(String(out.perimetre)).toMatch(/plateforme/i);
    expect(String(out.entiteDemandeeIntrouvable)).toContain("Société Fantôme");
    expect(out.entite).toBeUndefined();
  });

  it("les fiches non rattachées se VOIENT — elles ne se diluent pas dans une société", async () => {
    // On mesure l'ÉCART, pas l'absolu : la base de développement porte déjà des fiches
    // orphelines, et une assertion absolue mesurerait l'état du poste, pas le comportement.
    const out = await readHr();
    expect(lineFor(out, "Non rattaché")?.effectifActif).toBe(orphelinsAvant + 2);
  });

  it("congés et avances disent qu'ils ne suivent PAS le filtre d'entité", async () => {
    // Un chiffre qui ignore le filtre sous lequel il est affiché est le même piège, en plus petit.
    const out = await readHr({ entite: `${TAG} Adventum` });
    expect(String(out.portéeDesCongesEtAvances)).toMatch(/toutes entités/i);
  });

  /**
   * « FAIS-MOI UN TABLEAU COMME JE VEUX » — la vue est choisie, le contenu est relu.
   *
   *   PDG — Montre moi les dossiers les plus avancées de regulatory
   *   PDG — Dans un tableau
   *   Adam — Je ne peux pas afficher de tableaux Markdown ici.
   *
   * Ce qui est vérifié ici : les colonnes suivent la demande, le tri aussi, et les LIGNES
   * viennent de la lecture canonique — pas d'une paraphrase du modèle.
   */
  describe("show_table — la vue à la demande", () => {
    const table = async (input: Record<string, unknown>) => {
      const raw = (await executePowerTool("show_table", input, user)) ?? "{}";
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const bloc = (payload._blocs as { kind: string; columns: { key: string; label: string }[]; rows: Record<string, string>[]; total: number }[] | undefined)?.[0];
      return { payload, bloc };
    };

    it("les colonnes demandées sont celles affichées, dans l'ordre demandé", async () => {
      const { bloc } = await table({ source: "effectif", colonnes: ["effectifActif", "entite"] });
      expect(bloc?.kind).toBe("table");
      expect(bloc?.columns.map((c) => c.key)).toEqual(["effectifActif", "entite"]);
    });

    it("un nom de colonne APPROXIMATIF est rapproché de celui qui existe", async () => {
      // Le PDG écrit « effectif actif », la donnée s'appelle `effectifActif`. Exiger la clé
      // exacte reviendrait à lui demander de connaître le schéma.
      const { bloc } = await table({ source: "effectif", colonnes: ["entité", "effectif actif"] });
      expect(bloc?.columns.map((c) => c.key)).toEqual(["entite", "effectifActif"]);
    });

    it("une colonne qui n'existe pas est SIGNALÉE, pas inventée", async () => {
      const { payload, bloc } = await table({ source: "effectif", colonnes: ["entite", "couleur des yeux"] });
      expect(payload.colonnesIntrouvables).toContain("couleur des yeux");
      expect(bloc?.columns.map((c) => c.key)).toEqual(["entite"]);
    });

    it("le tri suit la demande", async () => {
      const { bloc } = await table({ source: "effectif", colonnes: ["entite", "effectifActif"], tri: "effectifActif", ordre: "desc" });
      const counts = (bloc?.rows ?? []).map((r) => Number(r.effectifActif));
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    });

    it("les LIGNES viennent de la lecture canonique — pas d'une reformulation", async () => {
      const { bloc } = await table({ source: "effectif", colonnes: ["entite", "effectifActif"] });
      const adventum = bloc?.rows.find((r) => r.entite === `${TAG} Adventum`);
      expect(adventum?.effectifActif).toBe("4"); // exactement ce que la base contient
    });

    it("une source inconnue nomme celles qui existent — jamais un tableau vide", async () => {
      const raw = await executePowerTool("show_table", { source: "les_trucs" }, user);
      expect(raw).toContain("dossiers_regulatory");
      expect(raw).not.toContain("_blocs");
    });

    it("les colonnes DISPONIBLES sont rendues — le tour suivant peut affiner", async () => {
      const { payload } = await table({ source: "effectif" });
      expect(payload.colonnesDisponibles).toContain("effectifTotal");
    });
  });
});
