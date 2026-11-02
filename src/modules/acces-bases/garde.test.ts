import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaBrut } from "@/lib/prisma";
import { avecIdentiteDonnees, enSysteme, type IdentiteDonnees } from "@/platform/donnees/contexte";
import { modelesTouches } from "@/platform/donnees/garde";
import { brancherGardeDonnees, debrancherGardeDonnees, evaluateurAccesBases, poserInstantaneDeTest } from "./infra/garde";
import { envoyerObservations } from "./infra/observations";
import type { ReglageBase } from "./domaine/types";

/**
 * D3 (décision 0057) — LA GARDE EN OBSERVATION, contre la base locale : elle COMPTE ce qu'elle aurait refusé (jointures
 * comprises), elle ne refuse RIEN, elle se tait pour le système et sans réglage — et elle ne coûte presque rien.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zd3garde${Date.now()}`;
let radiaId = "";
let assiaId = "";
let employeeId = "";
const radia = (): IdentiteDonnees => ({ userId: radiaId, roles: ["DIRECTION_ASSISTANT", null], peut: () => true });
const reglage = (o: Partial<ReglageBase>): ReglageBase => ({
  id: `${TAG}-r`, base: "paie", userId: radiaId, role: null, niveau: "FERMEE", ecriture: false,
  du: new Date(Date.now() - 86_400_000), au: null, revoqueLe: null, ...o,
});
const observees = () => prismaBrut.observationAccesBase.findMany({ where: { userId: radiaId } });

suite("D3 — la garde des données, en observation", () => {
  beforeAll(async () => {
    radiaId = (await prismaBrut.user.create({ data: { name: `${TAG} Radia`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id;
    assiaId = (await prismaBrut.user.create({ data: { name: `${TAG} Assia`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "VIEWER" } })).id;
    employeeId = (await prismaBrut.employee.create({ data: { fullName: `${TAG} Assia`, userId: assiaId } })).id;
    await prismaBrut.payrollEntry.create({ data: { employeeId, year: 2026, month: 10, gross: 100_000, net: 80_000 } });
    await prismaBrut.salaryAdvance.create({ data: { employeeId, amount: 10_000, reason: TAG } as never }).catch(() => undefined);
    brancherGardeDonnees();
  }, 60_000);

  afterAll(async () => {
    debrancherGardeDonnees();
    poserInstantaneDeTest(null);
    await prismaBrut.observationAccesBase.deleteMany({ where: { userId: { in: [radiaId, assiaId] } } });
    await prismaBrut.salaryAdvance.deleteMany({ where: { employeeId } }).catch(() => undefined);
    await prismaBrut.payrollEntry.deleteMany({ where: { employeeId } });
    await prismaBrut.employee.deleteMany({ where: { id: employeeId } });
    await prismaBrut.user.deleteMany({ where: { id: { in: [radiaId, assiaId] } } });
  });

  it("base fermée : la lecture PASSE (observation) mais elle est comptée", async () => {
    poserInstantaneDeTest([reglage({})]);
    const lignes = await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } }));
    expect(lignes).toHaveLength(1); // rien n'est bloqué en D3
    await envoyerObservations();
    const o = await observees();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ base: "paie", geste: "lecture", niveau: "FERMEE", nombre: 1 });
    expect(o[0].modeles).toContain("PayrollEntry");
  });

  it("la JOINTURE compte : lire un salarié en incluant sa paie touche la base Paie", async () => {
    poserInstantaneDeTest([reglage({})]);
    expect(modelesTouches("Employee", { include: { payrolls: true } })).toEqual(["Employee", "PayrollEntry"]);
    await avecIdentiteDonnees(radia(), () => prisma.employee.findUnique({ where: { id: employeeId }, include: { payrolls: true } }));
    await envoyerObservations();
    const paie = (await observees()).find((x) => x.base === "paie" && x.geste === "lecture")!;
    expect(paie.nombre).toBe(2);
  });

  it("lecture seule : la lecture ne compte pas, l'écriture oui", async () => {
    poserInstantaneDeTest([reglage({ niveau: "LECTURE_SEULE" })]);
    await avecIdentiteDonnees(radia(), async () => {
      await prisma.payrollEntry.findMany({ where: { employeeId } });
      await prisma.payrollEntry.updateMany({ where: { employeeId }, data: { notes: TAG } });
    });
    await envoyerObservations();
    const o = await observees();
    expect(o.find((x) => x.geste === "lecture")!.nombre).toBe(2); // inchangé
    expect(o.find((x) => x.geste === "ecriture")).toMatchObject({ niveau: "LECTURE_SEULE", nombre: 1 });
  });

  it("muette : sans identité, pour le système déclaré, sans réglage, pour une base technique, pour une autre personne", async () => {
    poserInstantaneDeTest([reglage({})]);
    await prisma.payrollEntry.findMany({ where: { employeeId } });
    await enSysteme("banc D3", () => avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } })));
    await avecIdentiteDonnees({ ...radia(), userId: assiaId }, () => prisma.payrollEntry.findMany({ where: { employeeId } }));
    await avecIdentiteDonnees(radia(), () => prisma.user.findMany({ where: { id: radiaId } }));
    poserInstantaneDeTest([]);
    await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } }));
    await envoyerObservations();
    expect((await observees()).find((x) => x.geste === "lecture")!.nombre).toBe(2);
    expect(await prismaBrut.observationAccesBase.count({ where: { userId: assiaId } })).toBe(0);
  });

  it("OUVERTE donne la lecture sans module ; NORMAL suit les modules (rien à compter)", () => {
    const sansModule: IdentiteDonnees = { ...radia(), peut: () => false };
    poserInstantaneDeTest([reglage({ niveau: "OUVERTE" })]);
    expect(evaluateurAccesBases({ modele: "PayrollEntry", geste: "lecture", operation: "findMany", contexte: sansModule })).toBeNull();
    expect(evaluateurAccesBases({ modele: "PayrollEntry", geste: "ecriture", operation: "update", contexte: sansModule })?.refus).toBeTruthy();
    poserInstantaneDeTest([reglage({ base: "budgets" })]);
    expect(evaluateurAccesBases({ modele: "PayrollEntry", geste: "lecture", operation: "findMany", contexte: sansModule })).toBeNull();
  });

  it("le SURCOÛT de la garde est négligeable (mesuré : une évaluation, relations comprises)", () => {
    poserInstantaneDeTest(Array.from({ length: 40 }, (_, i) => reglage({ id: `${TAG}-${i}`, base: i % 2 ? "paie" : "personnel", userId: i % 3 ? radiaId : `autre${i}` })));
    const id = radia();
    const N = 50_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      for (const m of modelesTouches("Employee", { include: { payrolls: true, departmentRef: true } })) {
        evaluateurAccesBases({ modele: m, geste: "lecture", operation: "findMany", contexte: id });
      }
    }
    const parRequeteUs = ((performance.now() - t0) * 1000) / N;
    console.info(`[D3] surcoût de la garde : ${parRequeteUs.toFixed(2)} µs par requête (3 modèles, 40 réglages)`);
    // Une requête Prisma coûte ~1 000 µs et plus : la garde doit rester sous 50 µs (5 %), on vise bien moins.
    expect(parRequeteUs).toBeLessThan(50);
  });
});
