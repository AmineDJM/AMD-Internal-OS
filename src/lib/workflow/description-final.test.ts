import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { defaultDefinition, ETAPE_DIRECTEUR_OPERATIONS } from "./defaults";
import { parcoursAdPro, etapesNonAtteintes, SLUG_DIRECTION, SLUG_MARKETING } from "./parcours";
import { argentEffectif } from "./pouvoirs-argent";
import { WORKFLOW_CATEGORIES } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DESCRIPTION DE L'ÉTAPE « final » DIT CE QUE L'ÉTAPE FAIT — sur les deux routes.
 *
 * Elle affirmait « le montant et la sous-catégorie budgétaire ne se décident PAS ici ». Depuis
 * §118.197g, sur la route d'une demande de rang 2 (Direction Marketing, Manager Promotion
 * médicale), l'étape CONCLUT et hérite des pouvoirs d'argent des étapes qu'elle n'atteint pas.
 * La phrase que lit le Super Admin contredisait le moteur.
 *
 * Trois propriétés : la graine et la migration portent le MÊME texte (deux sources de la même
 * étape feraient deux circuits sous un seul nom, §118.5) ; ce que le texte annonce, le moteur le
 * fait (on le lit dans `argentEffectif`, pas dans la prose) ; la migration, jouée sur son TEXTE
 * RÉEL contre une table temporaire, ne remplace que l'ancien texte mot pour mot — une description
 * qu'un Super Admin a réécrite est une décision.
 *
 * DEPUIS LE 27/10/2026, l'étape est celle du DIRECTEUR DES OPÉRATIONS (rôle OPERATIONS_DIRECTOR) et
 * ne conclut plus aucune route : la graine a changé de texte, et c'est la migration
 * `20270131130000_adpro_circuit_prevalidation` qui le pose en base. La migration de §118.197g reste
 * éprouvée sur SON texte (on ne réécrit pas une migration jouée) ; la graine, elle, se compare à la
 * nouvelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SQL = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20270104091000_description_etape_final/migration.sql"), "utf8",
);
const ANCIEN = "La Direction donne son accord sur l'opération. Le montant et la sous-catégorie budgétaire ne se "
  + "décident PAS ici : ils appartiennent à Direction Marketing, qui tranche ensuite.";

/** Le littéral SQL qui suit `SET "description" =`, apostrophes doublées rendues simples. */
function texteDeLaMigration(): string {
  const m = /SET "description" = '((?:[^']|'')*)'/.exec(SQL);
  if (!m) throw new Error("la migration ne pose aucune description");
  return m[1].replace(/''/g, "'");
}

const SQL_PREVALIDATION = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20270131130000_adpro_circuit_prevalidation/migration.sql"), "utf8",
);

/** L'instruction de la nouvelle migration qui vise l'étape `final` (commentaires retirés). */
function instructionFinaleDuCircuit(): string {
  const sql = SQL_PREVALIDATION.replace(/--[^\n]*/g, "");
  // On découpe sur le `;` qui FINIT une ligne : une description peut en contenir un en son milieu.
  const u = sql.split(/;\s*$/m).map((i) => i.trim()).find((i) => i.includes(`s."slug" = 'final'`));
  if (!u) throw new Error("la migration du 27/10/2026 ne vise pas l'étape `final`");
  return u;
}
const litDans = (instruction: string, champ: string) =>
  (new RegExp(`"${champ}"\\s*=\\s*'((?:[^']|'')*)'`).exec(instruction)?.[1] ?? "").replace(/''/g, "'");

const descriptionFinale = (categorie: (typeof WORKFLOW_CATEGORIES)[number]) =>
  defaultDefinition(categorie).steps.find((s) => s.slug === SLUG_DIRECTION)?.description ?? "";

describe("La description de l'étape « final » — la graine, la migration, le moteur", () => {
  it("la graine et la migration du 27/10/2026 portent le MÊME texte, pour les quatre circuits", () => {
    const instruction = instructionFinaleDuCircuit();
    for (const c of WORKFLOW_CATEGORIES) {
      const finale = defaultDefinition(c).steps.find((s) => s.slug === SLUG_DIRECTION)!;
      expect(finale, c).toBe(ETAPE_DIRECTEUR_OPERATIONS);
      expect(descriptionFinale(c), c).toBe(litDans(instruction, "description"));
      expect(finale.title, c).toBe(litDans(instruction, "title"));
    }
  });

  it("l'étape est tenue par le rôle OPERATIONS_DIRECTOR — et la migration ne garde DIRECTION qu'à défaut de compte", () => {
    // « Il faut que ce soit lui, l'Operations Director » (27/10/2026). Ce qui le ferait tomber : la
    // portée GLOBAL_VIEW d'avant — toute la Direction validerait à sa place.
    expect(ETAPE_DIRECTEUR_OPERATIONS.actorScope).toBe("ROLE");
    expect(ETAPE_DIRECTEUR_OPERATIONS.actorRoles).toEqual(["OPERATIONS_DIRECTOR"]);
    expect(ETAPE_DIRECTEUR_OPERATIONS.powers, "elle ne fixe aucun argent").toEqual(["APPROVE", "REJECT", "COMMENT"]);
    const instruction = instructionFinaleDuCircuit();
    expect(instruction).toMatch(/THEN ARRAY\['OPERATIONS_DIRECTOR'\]::TEXT\[\]/);
    expect(instruction).toMatch(/ELSE ARRAY\['OPERATIONS_DIRECTOR','DIRECTION'\]::TEXT\[\]/);
    expect(instruction, "elle n'agit que sur l'étape encore à sa graine d'avant").toMatch(/s\."title" = 'Validation \(Direction des opérations\)'/);
  });

  it("l'ancienne phrase a quitté la graine, et la migration ne remplace qu'elle, mot pour mot", () => {
    for (const c of WORKFLOW_CATEGORIES) expect(descriptionFinale(c), c).not.toContain("ne se décident PAS ici");
    expect(SQL).toContain(`AND "description" = '${ANCIEN.replace(/'/g, "''")}'`);
    expect(SQL).toMatch(/WHERE "slug" = 'final'/);
  });

  it("ce que la phrase annonce, le moteur le fait : « final » ne conclut aucune route et n'y décide aucun argent", () => {
    // « Il ne fixe aucun montant — la Direction Marketing prévalide ensuite. » Ce qui le ferait
    // tomber : une route qui s'arrêterait à « final » (l'ancienne demande de rang 2), où l'étape
    // hériterait des pouvoirs d'argent de la Direction Marketing.
    const texte = descriptionFinale("EVENTS");
    expect(texte).toMatch(/Directeur des opérations/);
    expect(texte).toMatch(/ne fixe aucun montant/);
    const demandeurs = [
      { rang: 0, kam: true, directionMarketing: false }, { rang: 0, kam: false, directionMarketing: false },
      { rang: 1, kam: false, directionMarketing: false }, { rang: 2, kam: false, directionMarketing: false },
      { rang: 2, kam: false, directionMarketing: true }, { rang: 3, kam: false, directionMarketing: false },
    ];
    for (const c of WORKFLOW_CATEGORIES) {
      const etapes = defaultDefinition(c).steps;
      const cfg = (s: (typeof etapes)[number]) => ({ powers: s.powers, requireAmount: !!s.requireAmount, requireCategory: !!s.requireCategory });
      const finale = etapes.find((s) => s.slug === SLUG_DIRECTION)!;
      for (const d of demandeurs) {
        const p = parcoursAdPro({ ...d, categorie: c });
        expect(p.decision, `${c} ${JSON.stringify(d)}`).toBeNull();
        const non = new Set(etapesNonAtteintes(etapes.map((s) => s.slug), p.decision, p.ignorees));
        expect(non.has(SLUG_MARKETING), `${c} ${JSON.stringify(d)} : la prévalidation est toujours atteinte`).toBe(false);
        // « final » ne conclut pas : même si on la faisait conclure, il n'y aurait rien à hériter.
        const effective = argentEffectif(cfg(finale), true, etapes.filter((s) => non.has(s.slug)).map(cfg));
        expect([effective.requireAmount, effective.requireCategory], `${c} ${JSON.stringify(d)}`).toEqual([false, false]);
      }
    }
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/** Joue le SQL du FICHIER `passes` fois sur une table temporaire préparée par `lignes`. */
async function jouer(lignes: { id: string; slug: string; description: string | null }[], passes: number) {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  let apres: { id: string; description: string | null }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // `pg_temp` passe devant `public` pour la session : le SQL s'exécute tel qu'il est écrit,
      // sans lire ni écrire les circuits réels de la base partagée (§118.173).
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "WorkflowStep" ("id" text PRIMARY KEY, "slug" text NOT NULL, "description" text) ON COMMIT DROP`);
      for (const l of lignes) {
        await tx.$executeRawUnsafe(`INSERT INTO "WorkflowStep" (id, slug, description) VALUES ($1, $2, $3)`, l.id, l.slug, l.description);
      }
      for (let i = 0; i < passes; i++) await tx.$executeRawUnsafe(SQL);
      apres = await tx.$queryRawUnsafe(`SELECT id, description FROM "WorkflowStep" ORDER BY id`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return new Map(apres.map((l) => [l.id, l.description]));
}

suite("La migration, jouée sur son texte réel", () => {
  const PERSO = "Validation de la Direction des opérations — réglée par le Super Admin, avec sa propre phrase.";
  const lignes = [
    { id: "a-ancien", slug: "final", description: ANCIEN },
    { id: "b-perso", slug: "final", description: PERSO },
    { id: "c-autre-etape", slug: "marketing", description: ANCIEN },
    { id: "d-vide", slug: "final", description: null },
  ];

  it("l'ancien texte devient celui de la migration ; une phrase réécrite, une autre étape et un vide ne bougent pas", async () => {
    const apres = await jouer(lignes, 1);
    // Le texte que CETTE migration pose (§118.197g) — la graine a depuis changé de texte, et c'est
    // la migration du 27/10/2026 qui le remplace en base (éprouvée plus bas).
    expect(apres.get("a-ancien")).toBe(texteDeLaMigration());
    expect(apres.get("b-perso")).toBe(PERSO);
    expect(apres.get("c-autre-etape")).toBe(ANCIEN);
    expect(apres.get("d-vide")).toBeNull();
  });

  it("rejouée, elle ne change RIEN de plus — deux passes identiques", async () => {
    const une = await jouer(lignes, 1);
    const deux = await jouer(lignes, 2);
    expect([...deux]).toEqual([...une]);
  });
});

/**
 * LA MIGRATION DU 27/10/2026, jouée sur son texte réel — même banc que ci-dessus : des tables
 * temporaires masquent les vraies pour la session, et la transaction est annulée à la fin.
 */
async function jouerLeCircuit(avecDirecteurDesOperations: boolean, passes: number) {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  const instructions = SQL_PREVALIDATION.replace(/--[^\n]*/g, "").split(/;\s*$/m).map((i) => i.trim()).filter(Boolean);
  let apres: { id: string; title: string; description: string | null; actorRoles: string[]; requireAmount: boolean; emitExpenseOrder: boolean }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "WorkflowDefinition" ("id" text PRIMARY KEY, "category" text NOT NULL) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "User" ("id" text PRIMARY KEY, "isActive" boolean NOT NULL, "role" text NOT NULL, "secondaryRole" text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "WorkflowStep" (
        "id" text PRIMARY KEY, "definitionId" text NOT NULL, "slug" text NOT NULL, "title" text NOT NULL, "description" text,
        "actorScope" text NOT NULL, "actorRoles" text[] NOT NULL, "notifyRoles" text[] NOT NULL, "powers" text[] NOT NULL,
        "requireAmount" boolean NOT NULL, "requireCategory" boolean NOT NULL, "emitExpenseOrder" boolean NOT NULL,
        "emitDeclaration" boolean NOT NULL, "confidential" boolean NOT NULL) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO "WorkflowDefinition" VALUES ('def-c', 'CONGRESS_NATIONAL'), ('def-s', 'SPONSORING')`);
      await tx.$executeRawUnsafe(`INSERT INTO "User" VALUES ('u-od-inactif', FALSE, 'OPERATIONS_DIRECTOR', NULL)`);
      if (avecDirecteurDesOperations) await tx.$executeRawUnsafe(`INSERT INTO "User" VALUES ('u-od', TRUE, 'SALES_USER', 'OPERATIONS_DIRECTOR')`);
      const etape = (id: string, def: string, slug: string, title: string) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "WorkflowStep" VALUES ($1, $2, $3, $4, 'avant', 'GLOBAL_VIEW', ARRAY['DIRECTION'], ARRAY['DIRECTION'],
            ARRAY['APPROVE','REJECT','SET_AMOUNT','SET_CATEGORY','COMMENT'], TRUE, TRUE, TRUE, TRUE, FALSE)`,
          id, def, slug, title,
        );
      await etape("c-final", "def-c", "final", "Validation (Direction des opérations)");
      await etape("c-final-perso", "def-s", "final", "Validation maison");
      await etape("c-marketing", "def-c", "marketing", "Décision et budget (Direction Marketing)");
      await etape("s-marketing", "def-s", "marketing", "Décision et budget (Direction Marketing)");
      await etape("c-dg", "def-c", "dg", "Validation du Directeur Général");
      for (let i = 0; i < passes; i++) for (const sql of instructions) await tx.$executeRawUnsafe(sql);
      apres = await tx.$queryRawUnsafe(`SELECT "id", "title", "description", "actorRoles", "requireAmount", "emitExpenseOrder" FROM "WorkflowStep" ORDER BY "id"`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return new Map(apres.map((l) => [l.id, l]));
}

suite("La migration du 27/10/2026, jouée sur son texte réel", () => {
  it("l'étape `final` devient celle du Directeur des opérations — DIRECTION à ses côtés tant qu'aucun compte OD actif n'existe", async () => {
    const sans = await jouerLeCircuit(false, 1);
    expect(sans.get("c-final")!.title).toBe(ETAPE_DIRECTEUR_OPERATIONS.title);
    expect(sans.get("c-final")!.description).toBe(ETAPE_DIRECTEUR_OPERATIONS.description);
    expect(sans.get("c-final")!.actorRoles, "un compte OD INACTIF ne tient pas l'étape").toEqual(["OPERATIONS_DIRECTOR", "DIRECTION"]);
    const avec = await jouerLeCircuit(true, 1);
    expect(avec.get("c-final")!.actorRoles, "le rôle SECONDAIRE compte").toEqual(["OPERATIONS_DIRECTOR"]);
    expect(avec.get("c-final-perso")!.title, "une étape remodelée ne bouge pas").toBe("Validation maison");
  });

  it("l'étape `marketing` des PEC devient la prévalidation ; celle du sponsoring n'est pas touchée ici", async () => {
    const apres = await jouerLeCircuit(true, 1);
    const c = apres.get("c-marketing")!;
    expect(c.title).toBe("Prévalidation (Direction Marketing)");
    expect([c.requireAmount, c.emitExpenseOrder]).toEqual([false, false]);
    expect(apres.get("s-marketing")!.title).toBe("Décision et budget (Direction Marketing)");
    expect(apres.get("c-dg")!.description).toMatch(/^Hors circuit depuis le 27\/10\/2026/);
  });

  it("rejouée, elle ne change RIEN de plus — deux passes identiques", async () => {
    const une = await jouerLeCircuit(false, 1);
    const deux = await jouerLeCircuit(false, 2);
    expect([...deux]).toEqual([...une]);
  });
});
