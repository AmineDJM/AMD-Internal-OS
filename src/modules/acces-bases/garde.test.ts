import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, prismaBrut } from "@/lib/prisma";
import { avecIdentiteDonnees, enSysteme, type IdentiteDonnees } from "@/platform/donnees/contexte";
import { AccesBaseRefuse, modelesTouches } from "@/platform/donnees/garde";
import { brancherGardeDonnees, debrancherGardeDonnees, evaluateurAccesBases, famillesParBase, modulesParBaseAccesBases, poserInstantaneDeTest } from "./infra/garde";
import { refusPourTables } from "@/platform/donnees/garde";
import { generateApiKey } from "@/lib/api/auth";
import { handle } from "@/lib/api/http";
import { NextRequest } from "next/server";
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
let radiaEmployeeId = "";
const radia = (): IdentiteDonnees => ({ userId: radiaId, roles: ["DIRECTION_ASSISTANT", null], peut: () => true });
const reglage = (o: Partial<ReglageBase>): ReglageBase => ({
  id: `${TAG}-r`, base: "paie", userId: radiaId, role: null, niveau: "FERMEE", ecriture: false,
  du: new Date(Date.now() - 86_400_000), au: null, revoqueLe: null, ...o,
});
const RELATIONS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, new Map(m.fields.filter((f) => f.kind === "object").map((f) => [f.name, String(f.type)]))]));
const relations = (m: string) => RELATIONS.get(m) ?? new Map<string, string>();
const observees = () => prismaBrut.observationAccesBase.findMany({ where: { userId: radiaId } });

suite("D3 — la garde des données, en observation", () => {
  beforeAll(async () => {
    radiaId = (await prismaBrut.user.create({ data: { name: `${TAG} Radia`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id;
    assiaId = (await prismaBrut.user.create({ data: { name: `${TAG} Assia`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "VIEWER" } })).id;
    employeeId = (await prismaBrut.employee.create({ data: { fullName: `${TAG} Assia`, userId: assiaId } })).id;
    await prismaBrut.payrollEntry.create({ data: { employeeId, year: 2026, month: 10, gross: 100_000, net: 80_000 } });
    radiaEmployeeId = (await prismaBrut.employee.create({ data: { fullName: `${TAG} Radia`, position: "Assistante", iban: "DZ00TEST", userId: radiaId } })).id;
    await prismaBrut.payrollEntry.create({ data: { employeeId: radiaEmployeeId, year: 2026, month: 10, gross: 60_000, net: 50_000 } });
    await prismaBrut.salaryAdvance.create({ data: { employeeId, amount: 10_000, reason: TAG } as never }).catch(() => undefined);
    brancherGardeDonnees();
  }, 60_000);

  afterAll(async () => {
    debrancherGardeDonnees();
    poserInstantaneDeTest(null);
    await prismaBrut.observationAccesBase.deleteMany({ where: { userId: { in: [radiaId, assiaId] } } });
    await prismaBrut.salaryAdvance.deleteMany({ where: { employeeId } }).catch(() => undefined);
    await prismaBrut.payrollEntry.deleteMany({ where: { employeeId } });
    await prismaBrut.payrollEntry.deleteMany({ where: { employeeId: radiaEmployeeId } });
    await prismaBrut.employee.deleteMany({ where: { id: { in: [employeeId, radiaEmployeeId] } } });
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
    expect(modelesTouches("Employee", { include: { payrolls: true } }, relations)).toEqual(["Employee", "PayrollEntry"]);
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
      for (const m of modelesTouches("Employee", { include: { payrolls: true, departmentRef: true } }, relations)) {
        evaluateurAccesBases({ modele: m, geste: "lecture", operation: "findMany", contexte: id });
      }
    }
    const parRequeteUs = ((performance.now() - t0) * 1000) / N;
    console.info(`[D3] surcoût de la garde : ${parRequeteUs.toFixed(2)} µs par requête (3 modèles, 40 réglages)`);
    // Une requête Prisma coûte ~1 000 µs et plus : la garde doit rester sous 50 µs (5 %), on vise bien moins.
    expect(parRequeteUs).toBeLessThan(50);
  });

  // ── D4 : l'application STRICTE (réglage du Super Admin, désactivé par défaut) ─────────────────────────────────────
  const strict = (reglages: ReglageBase[], autre: Parameters<typeof poserInstantaneDeTest>[1] = {}) =>
    poserInstantaneDeTest(reglages, { strict: "SENSIBLES", fiches: new Map([[radiaId, radiaEmployeeId]]), ...autre });
  const refuse = async (p: Promise<unknown>, digest: RegExp) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e, "la requête devait être refusée").toBeInstanceOf(AccesBaseRefuse);
    expect((e as AccesBaseRefuse).digest).toMatch(digest);
  };

  it("D4 — désactivée par défaut : même fermée, la base se lit (observation seulement)", async () => {
    poserInstantaneDeTest([reglage({})]); // strict = AUCUNE (défaut)
    expect(await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } }))).toHaveLength(1);
  });

  it("D4 — activée : la base fermée est REFUSÉE, avec l'empreinte que l'écran reconnaît", async () => {
    strict([reglage({})]);
    await refuse(avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } })), /^ACCES_BASE:paie:FERMEE$/);
    await refuse(avecIdentiteDonnees(radia(), () => prisma.payrollEntry.count()), /^ACCES_BASE:paie/);
  });

  it("D4 — ses propres données (paramètre de la base) : SES lignes seulement, jamais celles d'autrui", async () => {
    strict([reglage({})], { propres: { paie: true } });
    const miennes = await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId: { in: [employeeId, radiaEmployeeId] } } }));
    expect(miennes.map((l) => l.employeeId)).toEqual([radiaEmployeeId]);
    const sansFiltre = await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ select: { net: true } }));
    expect(sansFiltre).toHaveLength(1);
    expect(Object.keys(sansFiltre[0])).toEqual(["net"]); // les colonnes ajoutées pour juger sont retirées
    const autrui = await prismaBrut.payrollEntry.findFirstOrThrow({ where: { employeeId } });
    await refuse(avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findUnique({ where: { id: autrui.id } })), /^ACCES_BASE:paie/);
    // Paramètre à « non » : même ses propres données sont fermées.
    strict([reglage({})], { propres: { paie: false } });
    await refuse(avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId: radiaEmployeeId } })), /^ACCES_BASE:paie/);
  });

  it("D4 — nom et poste restent visibles : une jointure vers une base fermée est réduite aux colonnes de référence", async () => {
    strict([reglage({ base: "personnel" })]);
    const lignes = await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId: radiaEmployeeId }, include: { employee: true } }));
    expect(lignes[0].employee).toMatchObject({ fullName: `${TAG} Radia`, position: "Assistante" });
    expect((lignes[0].employee as Record<string, unknown>).iban).toBeUndefined();
    expect((lignes[0].employee as Record<string, unknown>).baseSalary).toBeUndefined();
    // La table elle-même : refusée en entier… sauf une lecture qui ne demande QUE le nom et le poste.
    await refuse(avecIdentiteDonnees(radia(), () => prisma.employee.findMany({ where: { id: employeeId } })), /^ACCES_BASE:personnel/);
    const noms = await avecIdentiteDonnees(radia(), () => prisma.employee.findMany({ where: { id: employeeId }, select: { fullName: true, position: true } }));
    expect(noms).toHaveLength(1);
  });

  it("D4 — lecture seule : la lecture passe, l'écriture est refusée", async () => {
    strict([reglage({ niveau: "LECTURE_SEULE" })]);
    expect(await avecIdentiteDonnees(radia(), () => prisma.payrollEntry.findMany({ where: { employeeId } }))).toHaveLength(1);
    await refuse(avecIdentiteDonnees(radia(), () => prisma.payrollEntry.updateMany({ where: { employeeId }, data: { notes: "x" } })), /^ACCES_BASE:paie:LECTURE_SEULE$/);
  });

  it("D4 — la portée : SENSIBLES n'applique pas une base restreinte, TOUTES oui ; une base technique jamais", async () => {
    const stocks = reglage({ base: "stocks" });
    strict([stocks]);
    await expect(avecIdentiteDonnees(radia(), () => prisma.stockSnapshot.count())).resolves.toBeTypeOf("number");
    strict([stocks], { strict: "TOUTES" });
    await refuse(avecIdentiteDonnees(radia(), () => prisma.stockSnapshot.count()), /^ACCES_BASE:stocks/);
    strict([reglage({ base: "comptes-et-droits" })], { strict: "TOUTES" });
    expect(await avecIdentiteDonnees(radia(), () => prisma.user.findMany({ where: { id: radiaId } }))).toHaveLength(1);
  });

  it("D4 — le système et une autre personne ne sont pas touchés", async () => {
    strict([reglage({})]);
    expect(await enSysteme("banc D4", () => prisma.payrollEntry.findMany({ where: { employeeId } }))).toHaveLength(1);
    expect(await avecIdentiteDonnees({ ...radia(), userId: assiaId }, () => prisma.payrollEntry.findMany({ where: { employeeId } }))).toHaveLength(1);
  });

  // ── D5 : les modules, l'assistant, le SQL libre, l'API v1 ───────────────────────────────────────────────────────
  it("D5 — modules : OUVERTE ouvre ses modules, une base FERMÉE masque un module dont toutes les bases le sont ; rien sans l'application stricte", () => {
    const qui = { userId: radiaId, roles: ["DIRECTION_ASSISTANT", null] };
    poserInstantaneDeTest([reglage({ base: "recrutement", niveau: "OUVERTE" }), reglage({ id: "r2", base: "paie" }), reglage({ id: "r3", base: "personnel" })]);
    expect(modulesParBaseAccesBases(qui)).toBeNull(); // AUCUNE (défaut)
    strict([reglage({ base: "recrutement", niveau: "OUVERTE" }), reglage({ id: "r2", base: "paie" }), reglage({ id: "r3", base: "personnel" })]);
    const r = modulesParBaseAccesBases(qui)!;
    expect(r.ouvrir).toContainEqual({ module: "RECRUITMENT", gestes: ["VIEW"] });
    expect(r.masquer).toEqual(expect.arrayContaining(["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING", "MY_TEAM"]));
    expect(r.masquer).not.toContain("ADMIN"); // bases techniques : jamais de verrouillage
    strict([reglage({ id: "r2", base: "paie" })]); // Paie seule fermée : RH mène aussi au Personnel → RH reste
    expect(modulesParBaseAccesBases(qui)!.masquer).not.toContain("RH");
  });

  it("D5 — assistant : base fermée = familles fermées ; ouverture NOMINATIVE de la Paie = périmètre nommé ; de rôle = pas de périmètre", () => {
    const qui = { userId: radiaId, roles: ["DIRECTION_ASSISTANT", null] };
    strict([reglage({ base: "budgets" }), reglage({ id: "rp", base: "paie", niveau: "OUVERTE", motif: "Audit de paie" })]);
    const f = famillesParBase(qui)!;
    expect(f.fermees).toContain("BUDGETS");
    expect(f.ouvertes).toContain("SALAIRES");
    expect(f.perimetres).toContainEqual(expect.objectContaining({ famille: "SALAIRES", ref: "rp", motif: "Audit de paie" }));
    strict([reglage({ id: "rr", base: "paie", niveau: "OUVERTE", userId: null, role: "DIRECTION_ASSISTANT" })]);
    expect(famillesParBase(qui)!.perimetres).toEqual([]);
  });

  it("D5 — SQL libre : une table d'une base fermée est refusée (application stricte), pas une autre", async () => {
    strict([reglage({})]);
    expect(await avecIdentiteDonnees(radia(), () => refusPourTables(["PayrollEntry", "Task"]))).toEqual([expect.stringMatching(/Paie/)]);
    expect(await avecIdentiteDonnees(radia(), () => refusPourTables(["Task"]))).toEqual([]);
    poserInstantaneDeTest([reglage({})]); // désactivée : rien
    expect(await avecIdentiteDonnees(radia(), () => refusPourTables(["PayrollEntry"]))).toEqual([]);
  });

  it("D5 — API v1 : l'identité de l'agent est jugée ; un refus est un 403 qui nomme la base", async () => {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const client = await prismaBrut.apiClient.create({ data: { name: `${TAG} agent`, keyHash, keyPrefix, scopes: [], actAsUserId: radiaId } });
    try {
      strict([reglage({})]);
      const route = handle({ operationId: `${TAG}-lire-paie`, scopes: [] }, () => prisma.payrollEntry.findMany({ where: { employeeId } }));
      const req = new NextRequest("http://localhost/api/v1/test", { headers: { authorization: `Bearer ${key}` } });
      const rep = await route(req, { params: Promise.resolve({}) });
      expect(rep.status).toBe(403);
      expect(JSON.stringify(await rep.json())).toMatch(/Paie & rémunérations/);
      poserInstantaneDeTest([reglage({})]); // désactivée : l'agent lit
      expect((await route(req, { params: Promise.resolve({}) })).status).toBe(200);
    } finally {
      await prismaBrut.apiCall.deleteMany({ where: { clientId: client.id } }).catch(() => undefined);
      await prismaBrut.apiClient.delete({ where: { id: client.id } });
    }
  });
});
