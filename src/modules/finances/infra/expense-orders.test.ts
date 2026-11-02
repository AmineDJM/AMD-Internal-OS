import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { createExpenseOrder, EXPENSE_SOURCE_TYPES } from "./expense-orders";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__eotest__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENTITÉ D'UN ORDRE DE DÉPENSE — et pourquoi un ordre sans entité DISPARAÎT.
 *
 * Le défaut rapporté : « le DG ne voit rien dans son centre de paiement, c'est tout blanc ». Deux
 * causes enchaînées, et aucune ne se voyait :
 *
 *   1. `companyOfExpense` ne connaissait que quatre sources et **pas `PAYMENT_REQUEST`** — la plus
 *      fréquente depuis que le centre est le guichet unique. Les ordres naissaient sans entité.
 *   2. Le filtre d'entité vaut `companyId = X`, et `NULL` n'est pas `X`. Ces ordres étaient donc
 *      invisibles à quiconque est cloisonné sur une société — le Super Admin (vue groupe) voyait
 *      tout, le Directeur Général voyait le vide.
 *
 * Les deux se testent ici, parce que ni l'une ni l'autre ne se rattrape en aval.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("L'entité d'un ordre de dépense", () => {
  let companyId = "", autreId = "", requesterId = "", scopedId = "";
  const orderIds: string[] = [];

  beforeAll(async () => {
    const [c1, c2] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Adventum`, shortName: `${TAG}A`, isActive: true } }),
      prisma.company.create({ data: { name: `${TAG}Pharmagene`, shortName: `${TAG}P`, isActive: true } }),
    ]);
    companyId = c1.id; autreId = c2.id;

    const [req, scoped] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}req`, email: `${TAG}req@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
      // Une personne CLOISONNÉE sur une entité — c'est elle qui ne voyait rien.
      prisma.user.create({ data: { name: `${TAG}dg`, email: `${TAG}dg@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" } }),
    ]);
    requesterId = req.id; scopedId = scoped.id;
    await prisma.employee.create({
      data: { fullName: `${TAG} DG`, userId: scopedId, companyId, email: `${TAG}dg@t.dz` },
    });
  });

  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: "PAY-" }, title: { contains: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  });

  it("UN ORDRE NÉ D'UNE DEMANDE DE PAIEMENT porte l'entité de la demande", async () => {
    // C'était le trou : `PAYMENT_REQUEST` ne figurait pas dans la table des sources, et l'ordre
    // retombait sur la fiche salarié du demandeur — donc sur rien, quand il n'en a pas.
    const demande = await prisma.paymentRequest.create({
      data: {
        reference: `PAY-${TAG}-1`, title: `${TAG} Facture agence`, payee: "Agence",
        amount: 120000, companyId, requesterId, status: "SUBMITTED",
      },
    });
    const order = await createExpenseOrder({
      label: `${TAG} depuis demande`, amount: 120000, category: "FOURNISSEUR",
      sourceType: "PAYMENT_REQUEST", sourceId: demande.id, requestedById: requesterId,
    });
    orderIds.push(order.id);
    expect(order.companyId).toBe(companyId);
  });

  it("à défaut de source rattachée, la société du DEMANDEUR — et sinon rien, assumé", async () => {
    const orphelin = await createExpenseOrder({
      label: `${TAG} sans source`, amount: 5000, category: "AUTRE", requestedById: requesterId,
    });
    orderIds.push(orphelin.id);
    // Le demandeur n'a pas de fiche salarié : on ne devine pas, l'ordre reste À RATTACHER.
    expect(orphelin.companyId).toBeNull();
  });

  it("UN ORDRE SANS ENTITÉ RESTE VISIBLE d'une personne cloisonnée — sinon il n'existe plus", async () => {
    // LE CŒUR DU DÉFAUT. Avec le filtre brut (`companyId = X`), cet ordre disparaissait de la file
    // du DG : invisible, donc jamais autorisé, donc jamais payé — et l'écran ne disait rien.
    const sansEntite = await createExpenseOrder({
      label: `${TAG} a rattacher`, amount: 7000, category: "AUTRE",
    });
    orderIds.push(sansEntite.id);

    const vus = await prisma.expenseOrder.findMany({
      where: await companyScopedWhere(scopedId, { label: { startsWith: TAG } }),
      select: { id: true },
    });
    expect(vus.map((o) => o.id)).toContain(sansEntite.id);
  });

  it("…mais l'ordre d'UNE AUTRE société reste invisible — le filtre protège toujours", async () => {
    // Garder les orphelins ne doit pas ouvrir les lignes du voisin : c'est un `OR` composé dans un
    // `AND`, pas un filtre désactivé.
    const ailleurs = await prisma.expenseOrder.create({
      data: { reference: `OD-${TAG}-X`, label: `${TAG} autre societe`, amount: 9000, category: "AUTRE", companyId: autreId },
    });
    orderIds.push(ailleurs.id);

    const vus = await prisma.expenseOrder.findMany({
      where: await companyScopedWhere(scopedId, { label: { startsWith: TAG } }),
      select: { id: true },
    });
    expect(vus.map((o) => o.id)).not.toContain(ailleurs.id);
  });

  it("DOUZE DÉCAISSEMENTS À LA MÊME SECONDE : douze ordres, douze références, douze dossiers (§118.182)", async () => {
    // LE DÉFAUT, trouvé par la suite complète le 02/10 : l'ordre se créait SANS filet — deux demandes
    // simultanées lisaient le même maximum, et la seconde échouait sur la contrainte d'unicité, après le
    // clic. Le dossier compagnon, lui, réessayait six fois : au-delà de six concurrents il manquait, EN
    // SILENCE — il est best-effort, et un ordre sans dossier redevient un libellé qu'on ne peut pas ouvrir.
    const N = 12;
    const ordres = await Promise.all(Array.from({ length: N }, (_, i) => createExpenseOrder({
      label: `${TAG} rafale ${i}`, amount: 1000 + i, category: "AUTRE", requestedById: requesterId,
    })));
    orderIds.push(...ordres.map((o) => o.id));
    expect(new Set(ordres.map((o) => o.reference)).size, "douze références distinctes").toBe(N);
    const dossiers = await prisma.paymentRequest.findMany({
      where: { expenseOrderId: { in: ordres.map((o) => o.id) } }, select: { expenseOrderId: true },
    });
    expect(new Set(dossiers.map((d) => d.expenseOrderId)).size, "chaque ordre a SON dossier compagnon").toBe(N);
    expect(dossiers, "un seul dossier par ordre").toHaveLength(N);
  });
});

/**
 * LA TABLE DES SOURCES EST-ELLE COMPLÈTE ?
 *
 * Une cascade de ternaires se complète en l'oubliant — c'est exactement ce qui est arrivé à
 * `PAYMENT_REQUEST`. Ce test relit le code appelant : tout `sourceType` littéral réellement passé à
 * `createExpenseOrder` doit figurer dans la table, ou être nommé ci-dessous comme exclu volontaire.
 *
 * Il ne lit PAS la base : c'est une vérification de couverture, pas de données.
 */
describe("aucun circuit de dépense n'est oublié", () => {
  /** `SALARY_ADVANCE` ne porte pas d'entité : elle appartient à un salarié, et le repli sur sa
   *  fiche donne la bonne réponse. L'absence est une décision, pas un trou. */
  const EXCLUS_VOLONTAIRES = new Set(["SALARY_ADVANCE"]);

  it("chaque sourceType littéral passé à createExpenseOrder est couvert", () => {
    const racine = path.join(process.cwd(), "src");
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) parcourir(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) fichiers.push(p);
      }
    };
    parcourir(racine);

    const utilises = new Set<string>();
    for (const f of fichiers) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("createExpenseOrder(")) continue;
      // Seuls les littéraux : une variable (`decl.sourceType`, `entityFor(t)`) ne se lit pas
      // statiquement, et prétendre le contraire donnerait un test qui rassure à tort.
      for (const m of src.matchAll(/sourceType:\s*"([A-Z_]+)"/g)) utilises.add(m[1]);
    }

    expect(utilises.size).toBeGreaterThan(0);
    const manquants = [...utilises].filter((t) => !EXPENSE_SOURCE_TYPES.includes(t as never) && !EXCLUS_VOLONTAIRES.has(t));
    expect(manquants, `sources sans lecture d'entité : ${manquants.join(", ")}`).toEqual([]);
  });
});
