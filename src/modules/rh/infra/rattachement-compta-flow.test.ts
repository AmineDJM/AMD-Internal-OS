import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { rattacherSalariesAEntite, envoyerPaieAuCentre } from "@/modules/rh/actions-paie";
import { updateEmployee } from "@/modules/rh/actions";
import { getMyCompanies } from "@/lib/company";
import { getResultatMensuel } from "@/lib/queries/compta";
import { lirePeriode } from "@/lib/finance/resultat-mensuel";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__rattachepaie__";
const YEAR = 2041;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RATTACHER LES SALARIÉS SANS ENTITÉ, ET LA PAIE DANS LE RÉSULTAT DE SON MOIS (Direction,
 * 04/10/2026) — par les VRAIS points d'entrée, avec des acteurs SANS vue globale (§118.104) : une
 * RH qui ne voit que l'entité A, un financier qui ne voit que l'entité A. Les juges lisent le lien
 * causal (la fiche, son audit, le virement qui couvre la ligne) ou des entités créées ICI — jamais
 * un total de la base partagée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Rattacher à une entité depuis la paie ; la paie dans le résultat de son mois", () => {
  let aId = "", bId = "", cId = "";
  let rhId = "", financeId = "";
  const sans: Record<string, string> = {};
  let empA = "", empB = "";
  const ordres: string[] = [];
  const wires: string[] = [];

  const rh = () => actorFor(rhId, "DIRECTION_ASSISTANT");
  const finance = () => actorFor(financeId, "FINANCE_BUDGET_MANAGER");
  const rattacher = async (companyId: string, ids: string[]) => {
    ACTOR = await rh();
    return rattacherSalariesAEntite(form({ companyId, employeeIds: ids }));
  };
  const entiteDe = async (id: string) => (await prisma.employee.findUniqueOrThrow({ where: { id }, select: { companyId: true } })).companyId;
  const tx = (label: string, date: string, direction: "IN" | "OUT", amount: number, companyId: string) =>
    prisma.financeTransaction.create({
      data: { reference: `${TAG}${label}`, label: `${TAG}${label}`, date: new Date(date), direction, amount, category: direction === "IN" ? "RECETTE" : "SALAIRE", status: "SETTLED", companyId },
      select: { id: true },
    }).then((t) => t.id);
  const ordre = async (companyId: string, wireId: string, extra: { status?: "PENDING" | "PAID"; transactionId?: string } = {}) => {
    const o = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OD${ordres.length}`, label: `${TAG} paie`, amount: 1, category: "SALAIRE", companyId,
        sourceType: "PAYROLL", sourceId: wireId, status: extra.status ?? "PENDING", centralStatus: "PENDING",
        transactionId: extra.transactionId ?? null,
      },
      select: { id: true, reference: true },
    });
    ordres.push(o.id);
    return o;
  };

  beforeAll(async () => {
    await nettoyer();
    const [a, b, c] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: `${TAG}ADV` } }),
      prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: `${TAG}PHA` } }),
      prisma.company.create({ data: { name: `${TAG} Tierce`, shortName: `${TAG}TRC` } }),
    ]);
    aId = a.id; bId = b.id; cId = c.id;
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } }).then((u) => u.id);
    [rhId, financeId] = await Promise.all([mk("rh", "DIRECTION_ASSISTANT"), mk("finance", "FINANCE_BUDGET_MANAGER")]);
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: rhId, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    await prisma.employee.create({ data: { fullName: `${TAG} RH`, userId: rhId, companyId: aId } });
    await prisma.userCompanyAccess.create({ data: { userId: rhId, companyId: aId, canEdit: true } });
    await prisma.employee.create({ data: { fullName: `${TAG} Finance`, userId: financeId, companyId: aId } });
    await prisma.userCompanyAccess.create({ data: { userId: financeId, companyId: aId, canEdit: true } });

    for (const k of ["saisi", "autreEntite", "lot", "ancien", "course"]) {
      sans[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, position: "Délégué" } })).id;
    }
    empA = (await prisma.employee.create({ data: { fullName: `${TAG} salarié A`, companyId: aId } })).id;
    empB = (await prisma.employee.create({ data: { fullName: `${TAG} salarié B`, companyId: bId } })).id;
  });

  // LE NETTOYAGE SE FAIT PAR LE TAG, avant ET après : un run interrompu ne doit pas faire tomber le
  // suivant sur une contrainte d'unicité dont la cause est invisible (§118.91).
  async function nettoyer() {
    const societes = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const tous = (await prisma.employee.findMany({ where: { fullName: { startsWith: TAG } }, select: { id: true } })).map((e) => e.id);
    await prisma.payrollEntry.deleteMany({ where: { employeeId: { in: tous } } }).catch(() => {});
    const w = await prisma.payrollWire.findMany({ where: { companyId: { in: societes } }, select: { expenseOrderId: true } });
    const parTag = await prisma.expenseOrder.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const idsOrdres = [...parTag.map((o) => o.id), ...w.map((x) => x.expenseOrderId).filter((v): v is string => Boolean(v))];
    await prisma.payrollWire.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: idsOrdres } } }).catch(() => {});
    const txOrdres = (await prisma.expenseOrder.findMany({ where: { id: { in: idsOrdres } }, select: { transactionId: true } }))
      .map((o) => o.transactionId).filter((v): v is string => Boolean(v));
    await prisma.expenseOrder.deleteMany({ where: { id: { in: idsOrdres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ reference: { startsWith: TAG } }, { id: { in: txOrdres } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: comptes } }, { entityId: { in: tous } }] } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: tous } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(() => {});
  }
  afterAll(nettoyer);

  describe("rattacher — la fiche salarié, une entité ouverte, et jamais une paie partie ailleurs", () => {
    it("PRÉMISSES : la RH n'a pas la vue globale et ne voit que A ; le financier non plus", async () => {
      expect(hasGlobalView("DIRECTION_ASSISTANT")).toBe(false);
      expect(hasGlobalView("FINANCE_BUDGET_MANAGER")).toBe(false);
      expect((await getMyCompanies(rhId)).map((c) => c.id)).toEqual([aId]);
    });

    it("seule la RH qui écrit rattache ; l'entité doit être ouverte ; rien ne bouge sur un refus", async () => {
      ACTOR = await finance();
      const pasRh = await rattacherSalariesAEntite(form({ companyId: aId, employeeIds: [sans.saisi!] }));
      expect(pasRh).toMatchObject({ ok: false, error: "Réservé aux RH." });
      const fermee = await rattacher(cId, [sans.saisi!]);
      expect(fermee.ok).toBe(false);
      expect(fermee.error).toMatch(/ne vous est pas ouverte/);
      expect(await entiteDe(sans.saisi!)).toBeNull();
    });

    it("UN SALAIRE SAISI SUIT LA FICHE : rattaché, il part ensuite dans le virement de A ; l'audit nomme la fiche", async () => {
      const ligne = await prisma.payrollEntry.create({
        data: { employeeId: sans.saisi!, year: YEAR, month: 3, status: "PAID", net: 80_000, employerCost: 120_000, paidDate: new Date() },
        select: { id: true },
      });
      const r = await rattacher(aId, [sans.saisi!]);
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/1 salarié rattaché à .*ADV/);
      expect(r.message).toMatch(/1 salaire saisi pourra partir au centre/);
      expect(await entiteDe(sans.saisi!)).toBe(aId);
      const audit = await prisma.auditLog.findFirst({ where: { entityType: "EMPLOYEE", entityId: sans.saisi!, field: "companyId" } });
      expect(audit).toMatchObject({ actorId: rhId, oldValue: null, newValue: aId });

      ACTOR = await rh();
      const envoi = await envoyerPaieAuCentre(form({ companyId: aId, year: String(YEAR), month: "3", amount: "80000" }));
      expect(envoi.ok).toBe(true);
      const couverte = await prisma.payrollEntry.findUniqueOrThrow({ where: { id: ligne.id }, select: { payrollWire: { select: { companyId: true } } } });
      expect(couverte.payrollWire?.companyId).toBe(aId);

      const encore = await rattacher(aId, [sans.saisi!]);
      expect(encore.ok).toBe(false);
      expect(encore.error).toMatch(/déjà une entité/);
    });

    it("UNE PAIE PARTIE AU NOM D'UNE AUTRE ENTITÉ refuse TOUT le lot, en la nommant", async () => {
      const wire = await prisma.payrollWire.create({ data: { companyId: bId, year: YEAR, month: 4, amount: 50_000 }, select: { id: true } });
      wires.push(wire.id);
      const o = await ordre(bId, wire.id);
      await prisma.payrollWire.update({ where: { id: wire.id }, data: { expenseOrderId: o.id } });
      await prisma.payrollEntry.create({
        data: { employeeId: sans.autreEntite!, year: YEAR, month: 4, status: "PAID", net: 50_000, paidDate: new Date(), payrollWireId: wire.id },
      });
      const r = await rattacher(aId, [sans.lot!, sans.autreEntite!]);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Rien n'est rattaché/);
      expect(r.error).toContain(`${TAG} autreEntite — paie de avril ${YEAR} partie au nom de ${TAG}PHA (${o.reference})`);
      expect(await entiteDe(sans.lot!)).toBeNull();
      expect(await entiteDe(sans.autreEntite!)).toBeNull();
    });

    it("VERSÉ PAR L'ANCIEN CIRCUIT sans entité connue : rattaché, et la phrase le dit", async () => {
      await prisma.payrollEntry.create({
        data: { employeeId: sans.ancien!, year: YEAR, month: 1, status: "PAID", net: 70_000, paidDate: new Date(), budgetTransferredAt: new Date() },
      });
      const r = await rattacher(aId, [sans.ancien!, sans.lot!]);
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^2 salariés rattachés/);
      expect(r.message).toMatch(/1 salaire déjà versé par l'ancien circuit/);
      expect(await entiteDe(sans.ancien!)).toBe(aId);
      expect(await entiteDe(sans.lot!)).toBe(aId);
    });

    it("CHANGER L'ENTITÉ D'UNE FICHE passe par la MÊME règle : un salaire parti au nom de A ne change pas d'entité en silence (audit n° 32)", async () => {
      const chg = (await prisma.employee.create({ data: { fullName: `${TAG} chg`, companyId: aId } })).id;
      const acces = await prisma.userCompanyAccess.create({ data: { userId: rhId, companyId: cId, canEdit: true } });
      try {
        const wire = await prisma.payrollWire.create({ data: { companyId: aId, year: YEAR, month: 5, amount: 40_000 }, select: { id: true } });
        wires.push(wire.id);
        const o = await ordre(aId, wire.id);
        await prisma.payrollWire.update({ where: { id: wire.id }, data: { expenseOrderId: o.id } });
        await prisma.payrollEntry.create({ data: { employeeId: chg, year: YEAR, month: 5, status: "PAID", net: 40_000, paidDate: new Date(), payrollWireId: wire.id } });
        ACTOR = await rh();
        const refus = await updateEmployee(form({ id: chg, companyId: cId }));
        expect(refus.ok).toBe(false);
        expect(refus.error).toContain(`paie de mai ${YEAR} partie au nom de ${TAG}ADV`);
        expect(await entiteDe(chg)).toBe(aId);
        // TÉMOIN : sans salaire parti, le même changement passe — la garde ne refuse pas tout.
        const libre = (await prisma.employee.create({ data: { fullName: `${TAG} chg libre`, companyId: aId } })).id;
        const ok = await updateEmployee(form({ id: libre, companyId: cId }));
        expect(ok.ok, ok.error).toBe(true);
        expect(await entiteDe(libre)).toBe(cId);
      } finally {
        await prisma.userCompanyAccess.delete({ where: { id: acces.id } }).catch(() => {});
      }
    });

    it("ÉCRITURE CONDITIONNELLE : rattaché ailleurs PENDANT le geste, le salarié garde SON entité", async () => {
      // La transaction du banc tient la ligne de la fiche ; le geste lit « sans entité », puis attend
      // sur son écriture ; pendant qu'il attend, la fiche est rattachée à B. Sans la condition
      // `companyId: null`, le geste écraserait B par A.
      ACTOR = await rh();
      let promesse: Promise<Awaited<ReturnType<typeof rattacherSalariesAEntite>>> | null = null;
      await prisma.$transaction(async (t) => {
        await t.$queryRaw`SELECT id FROM "Employee" WHERE id = ${sans.course!} FOR UPDATE`;
        promesse = rattacherSalariesAEntite(form({ companyId: aId, employeeIds: [sans.course!] }));
        promesse.catch(() => undefined);
        const debut = Date.now();
        for (;;) {
          await t.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const [{ n }] = await t.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
          if (n > 0) break;
          if (Date.now() - debut > 15_000) throw new Error("le geste n'a jamais attendu sur la fiche");
          await new Promise((res) => setTimeout(res, 25));
        }
        await t.employee.update({ where: { id: sans.course! }, data: { companyId: bId } });
      }, { timeout: 30_000 });
      const r = await promesse!;
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/entre-temps/);
      expect(await entiteDe(sans.course!)).toBe(bId);
    }, 40_000);
  });

  describe("comptabilité — la paie d'un mois dans les dépenses de CE mois", () => {
    let paieSept = "";

    beforeAll(async () => {
      // Septembre : une vente, la paie de septembre VIRÉE LE 3 OCTOBRE (virement → écriture), et une
      // ligne de l'ancien circuit versée SANS écriture (A visible, B non).
      await tx("vente-sept", `${YEAR}-09-15T10:00:00Z`, "IN", 1_000_000, aId);
      paieSept = await tx("paie-sept", `${YEAR}-10-03T10:00:00Z`, "OUT", 500_000, aId);
      const w = await prisma.payrollWire.create({ data: { companyId: aId, year: YEAR, month: 9, amount: 500_000, paidAt: new Date(), transactionId: paieSept }, select: { id: true } });
      wires.push(w.id);
      await tx("fournisseur-oct", `${YEAR}-10-10T10:00:00Z`, "OUT", 100_000, aId);
      // Octobre : un virement dont seul l'ORDRE porte l'écriture (le crochet a manqué), réglé en novembre.
      const paieOct = await tx("paie-oct", `${YEAR}-11-02T10:00:00Z`, "OUT", 300_000, aId);
      const w2 = await prisma.payrollWire.create({ data: { companyId: aId, year: YEAR, month: 10, amount: 300_000 }, select: { id: true } });
      wires.push(w2.id);
      const o2 = await ordre(aId, w2.id, { status: "PAID", transactionId: paieOct });
      await prisma.payrollWire.update({ where: { id: w2.id }, data: { expenseOrderId: o2.id } });
      // Ancien circuit : écriture de l'ancien transfert datée en octobre pour une paie d'AOÛT.
      const ancienne = await tx("transfert-aout", `${YEAR}-10-20T10:00:00Z`, "OUT", 40_000, aId);
      await prisma.payrollEntry.create({
        data: { employeeId: empA, year: YEAR, month: 8, status: "PAID", net: 40_000, paidDate: new Date(), transactionId: ancienne, budgetTransferredAt: new Date() },
      });
      // Versé SANS écriture (transféré au budget, aucune écriture) — A compte, B ne se voit pas.
      await prisma.payrollEntry.create({ data: { employeeId: empA, year: YEAR, month: 9, status: "PAID", net: 25_000, paidDate: new Date(), budgetTransferredAt: new Date() } });
      await prisma.payrollEntry.create({ data: { employeeId: empB, year: YEAR, month: 9, status: "PAID", net: 999_000, paidDate: new Date(), budgetTransferredAt: new Date() } });
      // Saisi après la bascule, jamais envoyé : pas encore une dépense.
      await prisma.payrollEntry.create({ data: { employeeId: empA, year: YEAR, month: 10, status: "PAID", net: 7_000, paidDate: new Date() } });
    });

    const resultat = (du: string, au: string) => getResultatMensuel(financeId, lirePeriode({ periode: "perso", du, au }, `${YEAR}-12`));

    it("SEPTEMBRE porte sa paie virée en octobre, la paie versée sans écriture à son net, et rien d'une autre entité", async () => {
      const r = await resultat(`${YEAR}-09`, `${YEAR}-09`);
      expect(r.lignes).toHaveLength(1);
      expect(r.lignes[0]).toMatchObject({ recettes: 1_000_000, depenses: 525_000, dontPaie: 525_000, resultat: 475_000 });
      expect(r.total).toMatchObject({ recettes: 1_000_000, depenses: 525_000 });
    });

    it("OCTOBRE ne la compte pas une seconde fois ; sa propre paie, réglée en novembre, y revient par l'ordre", async () => {
      const r = await resultat(`${YEAR}-10`, `${YEAR}-10`);
      expect(r.lignes[0]).toMatchObject({ depenses: 400_000, dontPaie: 300_000 });
    });

    it("LA PÉRIODE ENTIÈRE compte chaque écriture une fois, chacune dans son mois de paie", async () => {
      const r = await resultat(`${YEAR}-08`, `${YEAR}-11`);
      expect(r.lignes.map((l) => [l.mois, l.depenses, l.dontPaie])).toEqual([
        [`${YEAR}-08`, 40_000, 40_000],
        [`${YEAR}-09`, 525_000, 525_000],
        [`${YEAR}-10`, 400_000, 300_000],
        [`${YEAR}-11`, 0, 0],
      ]);
      expect(r.total).toEqual({ recettes: 1_000_000, depenses: 965_000, dontPaie: 865_000, resultat: 35_000 });
    });

    it("TÉMOIN : l'écriture de paie, prise seule, est bien datée d'octobre — c'est son LIEN qui la range en septembre", async () => {
      const e = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: paieSept }, select: { date: true } });
      expect(e.date.toISOString().slice(0, 7)).toBe(`${YEAR}-10`);
    });
  });
});
