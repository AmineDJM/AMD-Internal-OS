import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  deciderPlanTournee, demanderRevisionPlanTournee, escaladerPlanTournee, planifierVisites, soumettrePlanTournee,
} from "@/lib/actions/tour-plan-actions";
import { direVisiteNonTenue, rapporterVisite } from "@/lib/actions/tour-visit-actions";
import { deleteVisit, updateVisit } from "@/lib/actions/medical-actions";
import { getActionCenter } from "@/lib/queries/action-center";
import { loadEmploiDuTemps, loadPlanTournee } from "@/lib/queries/tour-schedule";
import { periodeDe } from "@/lib/sfe/tournee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN DE TOURNÉE SE RÉVISE, UNE VISITE SE DIT NON TENUE, UN GESTE À LA FOIS (audit 360°, R13 et M5 du
 * KAM — §118.193). Par les VRAIS points d'entrée, avec un superviseur SANS vue globale (§118.104), et des
 * courses FORCÉES : le détenteur d'un verrou de table attend que le geste soit bloqué entre sa lecture et
 * son écriture, écrit lui-même le changement concurrent, puis relâche (§118.164e).
 *
 * Le décor écrit ce que le produit écrit (un plan validé porte son validateur, sa décision et sa date ; une
 * visite de la grille porte son plan, son KAM et son origine), et chaque plan a SA période : un KAM n'a qu'un
 * plan par période.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__tourrev__";
const DEJA = /vient de changer/;
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};
const jourIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "");
const H = 3_600_000;

suite("Plan de tournée — réviser un plan validé, dire une visite non tenue, un geste à la fois", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, string> = {
    kam: "MEDICAL_DELEGATE", sup: "NATIONAL_SALES", n2: "OPERATIONS_DIRECTOR", col: "MEDICAL_DELEGATE", dir: "DIRECTION",
  };
  let doc1 = "", doc2 = "";
  const acteur = async (k: string) =>
    ({ id: u[k], name: `${TAG}${k}`, role: roles[k], secondaryRole: null, access: await getAccess(u[k]!, roles[k] as never) } as unknown as SessionUser);
  const comme = async (k: string) => { ACTEUR = await acteur(k); };
  const notifs = (userId: string, planId: string) =>
    prisma.notification.findMany({ where: { userId, link: { contains: planId } }, select: { title: true, body: true } });

  async function nettoyer() {
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: ids } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const crees = await Promise.all(Object.entries(roles).map(([k, role]) =>
      prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" }, select: { id: true } })
        .then((x) => [k, x.id] as const)));
    for (const [k, id] of crees) u[k] = id;
    // L'ORGANIGRAMME : le superviseur rapporte au N+2. La BU : le superviseur la pilote, le KAM y est rattaché.
    const eN2 = await prisma.employee.create({ data: { fullName: `${TAG}N2`, userId: u.n2 } });
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, supervisorId: u.sup } });
    const [, , , d1, d2] = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG}Superviseur`, userId: u.sup, managerId: eN2.id } }),
      prisma.employee.create({ data: { fullName: `${TAG}Kam`, userId: u.kam } }),
      prisma.salesRepProfile.create({ data: { repId: u.kam!, businessUnitId: bu.id } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: u.kam, wilaya: "Alger" }, select: { id: true } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Benali`, delegateId: u.kam, wilaya: "Alger" }, select: { id: true } }),
    ]);
    doc1 = d1.id; doc2 = d2.id;
  });
  afterAll(nettoyer);

  // ── LE DÉCOR ────────────────────────────────────────────────────────────────────────────
  let futur = 1, passe = -1;
  async function planDe(statut: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED", quand: "futur" | "passe", extra: Partial<Prisma.TourPlanUncheckedCreateInput> = {}) {
    const ref = new Date(); ref.setDate(15); ref.setMonth(ref.getMonth() + (quand === "futur" ? ++futur : --passe));
    const { debut, fin } = periodeDe("MONTH", ref);
    const decide = statut === "APPROVED" || statut === "REJECTED";
    const p = await prisma.tourPlan.create({
      data: {
        repId: u.kam!, periodStart: debut, periodEnd: fin, granularity: "MONTH", status: statut, submissionDueAt: debut,
        reviewerId: statut === "DRAFT" ? null : u.sup, submittedAt: statut === "DRAFT" ? null : new Date(),
        decidedById: decide ? u.sup : null, decidedAt: decide ? new Date() : null, createdById: u.kam, ...extra,
      },
      select: { id: true },
    });
    return { id: p.id, debut, fin };
  }
  /** Le n-ième jour ouvré (dimanche → jeudi) de la période, à 9 h — l'heure que la grille écrit. */
  function jourOuvre(debut: Date, rang = 0): Date {
    const d = new Date(debut);
    let vus = -1;
    for (;;) {
      if (d.getDay() !== 5 && d.getDay() !== 6) vus++;
      if (vus === rang) break;
      d.setDate(d.getDate() + 1);
    }
    return new Date(`${jourIso(d)}T09:00:00`);
  }
  async function visite(planId: string | null, date: Date, doctorId = doc1, status: "PLANNED" | "COMPLETED" = "PLANNED") {
    return (await prisma.medicalVisit.create({
      data: { date, doctorId, delegateId: u.kam, status, origin: "PLAN", tourPlanId: planId, createdById: u.kam, report: status === "COMPLETED" ? "Vu." : null },
      select: { id: true },
    })).id;
  }

  /** La course FORCÉE (§118.164e) : le geste est bloqué entre sa lecture et son écriture, le détenteur écrit, puis relâche. */
  async function pendantLaLecture<T>(table: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${`%"${table}"%`}`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error(`le geste n'a pas atteint la barrière (${table})`);
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  /**
   * DEUX gestes réels FORCÉS à se croiser : tous deux lisent, puis attendent ensemble à leur première écriture sur
   * la ligne que le détenteur verrouille. Un verrou de LIGNE, pas de table : sous la suite complète, un verrou de
   * table ferait aussi attendre les écritures des autres fichiers, et la barrière s'ouvrirait trop tôt (§118.65).
   */
  async function deuxEnMemeTemps<T>(table: string, id: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
    let ga!: Promise<T>, gb!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
      ga = a(); gb = b();
      ga.catch(() => undefined); gb.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${`%"${table}"%`}`;
        if (n >= 2) break;
        if (Date.now() - debut > 10_000) throw new Error(`les deux gestes n'ont pas atteint la barrière (${table})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all([ga, gb]);
  }

  // ── LES PRÉMISSES ───────────────────────────────────────────────────────────────────────
  it("PRÉMISSES : le superviseur n'a pas la vue globale ; le collègue a le module — un refus ne viendra que du périmètre", async () => {
    expect(hasGlobalView(await acteur("sup"))).toBe(false);
    expect(userCan(await acteur("col"), "MEDICAL", "CREATE")).toBe(true);
    expect(userCan(await acteur("kam"), "MEDICAL", "CREATE")).toBe(true);
    expect(hasGlobalView(await acteur("dir"))).toBe(true);
  });

  // ── LE MOTIF D'UN REJET ─────────────────────────────────────────────────────────────────
  it("MOTIF : un rejet se motive côté serveur ; une validation, non", async () => {
    const p = await planDe("SUBMITTED", "futur");
    await comme("sup");
    expect(err(await deciderPlanTournee(fd({ planId: p.id, decision: "REJECT" })))).toMatch(/Un rejet sans commentaire/);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUBMITTED");
    const r = await deciderPlanTournee(fd({ planId: p.id, decision: "APPROVE" }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("APPROVED");
  });

  // ── LA RÉVISION ─────────────────────────────────────────────────────────────────────────
  it("RÉVISER — l'état d'abord : un plan soumis ne se révise pas, un brouillon se modifie déjà, et le refus ne demande pas de motif", async () => {
    const soumis = await planDe("SUBMITTED", "futur");
    const brouillon = await planDe("DRAFT", "futur");
    await comme("kam");
    const r1 = err(await demanderRevisionPlanTournee(fd({ planId: soumis.id })));
    expect(r1).toMatch(/attend la décision de son validateur/);
    expect(r1).not.toMatch(/Dites ce qui change/);
    expect(err(await demanderRevisionPlanTournee(fd({ planId: brouillon.id })))).toMatch(/il se modifie déjà/);
  });

  it("RÉVISER — le KAM rouvre son plan validé, motif exigé : « En révision », 48 h, et la personne qui l'a validé est prévenue", async () => {
    const p = await planDe("APPROVED", "futur");
    await comme("kam");
    expect(err(await demanderRevisionPlanTournee(fd({ planId: p.id })))).toMatch(/Dites ce qui change/);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("APPROVED");
    const avant = Date.now();
    const r = await demanderRevisionPlanTournee(fd({ planId: p.id, note: "Le Dr Achour est en congé la semaine du 18." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    const plan = await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } });
    expect(plan).toMatchObject({ status: "REVISION", revisionNote: "Le Dr Achour est en congé la semaine du 18.", revisionRequestedById: u.kam, revisionCount: 1 });
    const delai = plan.resubmitDueAt!.getTime() - avant;
    expect(delai).toBeGreaterThan(47 * H);
    expect(delai).toBeLessThan(49 * H);
    const n = await notifs(u.sup!, p.id);
    expect(n.map((x) => x.title)).toEqual([expect.stringContaining("rouvert pour révision")]);
    expect(n[0]!.body).toContain("Le Dr Achour est en congé");
    expect(await notifs(u.kam!, p.id), "on ne se prévient pas soi-même").toHaveLength(0);
  });

  it("RÉVISER — un collègue ne rouvre pas le plan d'un autre ; le superviseur le peut, et c'est le KAM qu'on prévient", async () => {
    const p = await planDe("APPROVED", "futur");
    await comme("col");
    expect(err(await demanderRevisionPlanTournee(fd({ planId: p.id, note: "x" })))).toMatch(/pas dans votre périmètre/);
    await comme("sup");
    const r = await demanderRevisionPlanTournee(fd({ planId: p.id, note: "Ajoutez le CHU de Blida la deuxième semaine." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    const n = await notifs(u.kam!, p.id);
    expect(n.map((x) => x.title)).toEqual(["Votre plan de tournée est rouvert pour révision"]);
    expect(n[0]!.body).toContain("À resoumettre avant le");
    expect(await notifs(u.sup!, p.id), "le superviseur a validé ET rouvert : on ne le prévient pas de son propre geste").toHaveLength(0);
  });

  it("RÉVISER — la Direction rouvre : le KAM ET la personne qui a validé sont prévenus", async () => {
    const p = await planDe("APPROVED", "futur");
    await comme("dir");
    const r = await demanderRevisionPlanTournee(fd({ planId: p.id, note: "Réunion nationale le 12 : libérez la journée." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect((await notifs(u.kam!, p.id)).map((x) => x.title)).toEqual(["Votre plan de tournée est rouvert pour révision"]);
    const v = await notifs(u.sup!, p.id);
    expect(v.map((x) => x.title)).toEqual([expect.stringContaining("rouvert pour révision")]);
    expect(v[0]!.body).toContain("Réunion nationale le 12");
  });

  it("EN RÉVISION — l'avenir se replanifie, le passé reste ; un plan jamais validé n'est pas concerné", async () => {
    // L'avenir : deux visites, on en retire une.
    const f = await planDe("APPROVED", "futur");
    const v1 = await visite(f.id, jourOuvre(f.debut, 0), doc1);
    const v2 = await visite(f.id, jourOuvre(f.debut, 1), doc2);
    await comme("kam");
    expect((await demanderRevisionPlanTournee(fd({ planId: f.id, note: "Benali indisponible." }))).ok).toBe(true);
    const r1 = await planifierVisites(fd({ planId: f.id, visite: [`${jourIso(jourOuvre(f.debut, 0))}|${doc1}`] }));
    expect(r1.ok, err(r1) ?? "").toBe(true);
    expect(await prisma.medicalVisit.count({ where: { id: { in: [v1, v2] } } })).toBe(1);
    // Le passé : une visite planifiée passée d'un plan validé ne se retire pas.
    const p = await planDe("APPROVED", "passe");
    const vp = await visite(p.id, jourOuvre(p.debut, 0));
    expect((await demanderRevisionPlanTournee(fd({ planId: p.id, note: "Rattrapage." }))).ok).toBe(true);
    const refus = err(await planifierVisites(fd({ planId: p.id, visite: [] })));
    expect(refus).toMatch(/déjà passée/);
    // La phrase nomme le geste qui EXISTE : la fiche d'une visite n'offre pas « non tenue » (§118.128).
    expect(refus).toMatch(/depuis « Ma journée » dans leurs 48 h/);
    expect(await prisma.medicalVisit.count({ where: { id: vp } })).toBe(1);
    // Le témoin : un brouillon jamais validé retire sa visite passée — la règle ne vise que ce qui a été accordé.
    const b = await planDe("DRAFT", "passe");
    const vb = await visite(b.id, jourOuvre(b.debut, 0));
    const r2 = await planifierVisites(fd({ planId: b.id, visite: [] }));
    expect(r2.ok, err(r2) ?? "").toBe(true);
    expect(await prisma.medicalVisit.count({ where: { id: vb } })).toBe(0);
  });

  it("L'ÉCRAN DU PLAN dit pourquoi une visite est verrouillée : passée d'un plan révisé, dite non tenue — et qui a rouvert", async () => {
    const p = await planDe("APPROVED", "passe", {
      status: "REVISION", revisionCount: 1, revisionNote: "Semaine 2 à revoir.", revisionRequestedAt: new Date(), revisionRequestedById: u.kam,
    });
    const passee = jourOuvre(p.debut, 0);
    await visite(p.id, passee, doc1);
    const reportee = jourOuvre(p.debut, 1);
    const vr = await visite(p.id, reportee, doc2);
    await prisma.medicalVisit.update({ where: { id: vr }, data: { status: "POSTPONED", notHeldReason: "Congé.", notHeldById: u.kam, notHeldAt: new Date() } });
    const vue = await loadPlanTournee(p.id);
    expect(vue?.pairesPassees).toEqual([`${jourIso(passee)}|${doc1}`]);
    expect(vue?.pairesNonTenues).toEqual([`${jourIso(reportee)}|${doc2}`]);
    expect(vue?.revisionPar).toBe(`${TAG}kam`);
    // Le témoin : le même passé sur un brouillon jamais validé n'est pas verrouillé — il se retire.
    const b = await planDe("DRAFT", "passe");
    await visite(b.id, jourOuvre(b.debut, 0), doc1);
    expect((await loadPlanTournee(b.id))?.pairesPassees).toEqual([]);
  });

  it("RESOUMETTRE une révision : le validateur lit le motif, et sa décision clôt la révision", async () => {
    const p = await planDe("APPROVED", "futur");
    await visite(p.id, jourOuvre(p.debut, 0));
    await comme("kam");
    expect((await demanderRevisionPlanTournee(fd({ planId: p.id, note: "Congrès à Oran le 20." }))).ok).toBe(true);
    const s = await soumettrePlanTournee(fd({ planId: p.id }));
    expect(s.ok, err(s) ?? "").toBe(true);
    const n = await notifs(u.sup!, p.id);
    expect(n.some((x) => x.title.includes("à valider") && (x.body ?? "").includes("révisé : « Congrès à Oran le 20. »"))).toBe(true);
    expect((await loadPlanTournee(p.id))?.revisionNote, "le validateur le lit sur le plan").toBe("Congrès à Oran le 20.");
    await comme("sup");
    expect((await deciderPlanTournee(fd({ planId: p.id, decision: "APPROVE" }))).ok).toBe(true);
    expect(await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id }, select: { status: true, revisionNote: true, revisionCount: true } }))
      .toEqual({ status: "APPROVED", revisionNote: null, revisionCount: 1 });
  });

  it("MON ESPACE : un plan en révision ou rejeté est « À corriger », avec son échéance — chez le KAM, et chez lui seul", async () => {
    const rev = await planDe("APPROVED", "futur");
    await comme("kam");
    expect((await demanderRevisionPlanTournee(fd({ planId: rev.id, note: "Semaine du 18 à revoir." }))).ok).toBe(true);
    const due = new Date(Date.now() + 30 * H);
    const rej = await planDe("REJECTED", "futur", { rejectionComment: "Pas assez de CHU.", resubmitDueAt: due });
    const { items } = await getActionCenter(await acteur("kam"));
    const a = items.find((i) => i.href === `/medical/plan-de-tournee?plan=${rev.id}`);
    expect(a, "le plan en révision est dans « À corriger »").toBeTruthy();
    expect(a!.statusLabel).toBe("À corriger");
    expect(a!.subtitle).toMatch(/En révision : Semaine du 18 à revoir\./);
    const plan = await prisma.tourPlan.findUniqueOrThrow({ where: { id: rev.id }, select: { resubmitDueAt: true } });
    expect(a!.deadline).toBe(plan.resubmitDueAt!.toISOString());
    const b = items.find((i) => i.href === `/medical/plan-de-tournee?plan=${rej.id}`);
    expect(b!.subtitle).toMatch(/Rejeté : Pas assez de CHU\./);
    expect(b!.deadline).toBe(due.toISOString());
    const { items: chezSup } = await getActionCenter(await acteur("sup"));
    expect(chezSup.some((i) => i.href.includes(rev.id) && i.statusLabel === "À corriger")).toBe(false);
  });

  // ── UN GESTE À LA FOIS — courses forcées ─────────────────────────────────────────────────
  it("UN GESTE À LA FOIS — la décision perd contre une escalade passée pendant sa lecture", async () => {
    const p = await planDe("SUBMITTED", "futur");
    await comme("sup");
    const r = await pendantLaLecture("TourPlan",
      () => deciderPlanTournee(fd({ planId: p.id, decision: "APPROVE" })),
      (tx) => tx.tourPlan.update({ where: { id: p.id }, data: { status: "ESCALATED", escalatedToId: u.n2, escalatedAt: new Date() } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("ESCALATED");
    expect(await notifs(u.kam!, p.id), "le KAM n'apprend pas une validation qui n'a pas eu lieu").toHaveLength(0);
  });

  it("UN GESTE À LA FOIS — une soumission perd contre une soumission passée pendant sa lecture", async () => {
    const p = await planDe("DRAFT", "futur");
    await visite(p.id, jourOuvre(p.debut, 0));
    await comme("kam");
    const r = await pendantLaLecture("TourPlan",
      () => soumettrePlanTournee(fd({ planId: p.id })),
      (tx) => tx.tourPlan.update({ where: { id: p.id }, data: { status: "SUBMITTED", reviewerId: u.sup, submittedAt: new Date() } }));
    expect(err(r)).toMatch(DEJA);
    expect(await notifs(u.sup!, p.id), "une seule soumission prévient le validateur — et ce n'est pas celle-ci").toHaveLength(0);
  });

  it("UN GESTE À LA FOIS — l'escalade perd contre une décision passée pendant sa lecture", async () => {
    const p = await planDe("SUBMITTED", "futur");
    await comme("sup");
    const r = await pendantLaLecture("TourPlan",
      () => escaladerPlanTournee(fd({ planId: p.id })),
      (tx) => tx.tourPlan.update({ where: { id: p.id }, data: { status: "APPROVED", decidedById: u.sup, decidedAt: new Date() } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("APPROVED");
    expect(await notifs(u.n2!, p.id)).toHaveLength(0);
  });

  it("UN GESTE À LA FOIS — deux révisions croisées n'en font qu'une", async () => {
    const p = await planDe("APPROVED", "futur");
    await comme("kam");
    const r = await pendantLaLecture("TourPlan",
      () => demanderRevisionPlanTournee(fd({ planId: p.id, note: "La mienne." })),
      (tx) => tx.tourPlan.update({ where: { id: p.id }, data: { status: "REVISION", revisionNote: "L'autre.", revisionCount: { increment: 1 } } }));
    expect(err(r)).toMatch(DEJA);
    expect(await prisma.tourPlan.findUniqueOrThrow({ where: { id: p.id }, select: { revisionNote: true, revisionCount: true } }))
      .toEqual({ revisionNote: "L'autre.", revisionCount: 1 });
  });

  it("UN GESTE À LA FOIS — la grille perd contre une soumission passée pendant son enregistrement", async () => {
    const p = await planDe("DRAFT", "futur");
    const v = await visite(p.id, jourOuvre(p.debut, 0));
    await comme("kam");
    const r = await pendantLaLecture("TourPlan",
      () => planifierVisites(fd({ planId: p.id, visite: [] })),
      (tx) => tx.tourPlan.update({ where: { id: p.id }, data: { status: "SUBMITTED", reviewerId: u.sup } }));
    expect(err(r)).toMatch(DEJA);
    expect(await prisma.medicalVisit.count({ where: { id: v } }), "le validateur verra la grille qu'il a reçue").toBe(1);
  });

  it("UN GESTE À LA FOIS — la grille ne retire pas une visite rapportée pendant son enregistrement", async () => {
    const p = await planDe("DRAFT", "futur");
    const v = await visite(p.id, jourOuvre(p.debut, 0));
    await comme("kam");
    const r = await pendantLaLecture("MedicalVisit",
      () => planifierVisites(fd({ planId: p.id, visite: [] })),
      (tx) => tx.medicalVisit.update({ where: { id: v }, data: { status: "COMPLETED", report: "Vu pendant l'enregistrement." } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status, "une visite rapportée reste, quoi qu'il arrive").toBe("COMPLETED");
  });

  it("UN GESTE À LA FOIS — deux enregistrements croisés de la grille : le second perd, il n'ajoute rien à une grille qu'il n'a pas vue", async () => {
    const p = await planDe("DRAFT", "futur");
    await comme("kam");
    // Deux onglets ouverts sur le même plan vide : l'un garde Achour le premier jour, l'autre Benali le deuxième.
    const [a, b] = await deuxEnMemeTemps("TourPlan", p.id,
      () => planifierVisites(fd({ planId: p.id, visite: [`${jourIso(jourOuvre(p.debut, 0))}|${doc1}`] })),
      () => planifierVisites(fd({ planId: p.id, visite: [`${jourIso(jourOuvre(p.debut, 1))}|${doc2}`] })));
    const issues = [a, b].map((r) => (r.ok ? "ok" : DEJA.test(r.error ?? "") ? "déjà" : `autre : ${r.error}`));
    expect(issues.sort()).toEqual(["déjà", "ok"]);
    expect(await prisma.medicalVisit.count({ where: { tourPlanId: p.id } }), "une seule sélection est enregistrée, entière").toBe(1);
  });

  // ── LA VISITE QUI N'A PAS EU LIEU ───────────────────────────────────────────────────────
  it("NON TENUE — une visite à venir se dit reportée, motif à l'appui ; « Ma journée » montre le motif", async () => {
    // DEMAIN À 11 H, jamais « dans 24 h » : la vue « Aujourd'hui » est un jour LOCAL, et lancé entre 23 h et minuit le
    // cas lisait la visite d'un jour et la vue du lendemain — rouge une heure par jour, sur une règle juste (§118.195).
    const demain = new Date(Date.now() + 24 * H);
    demain.setHours(11, 0, 0, 0);
    const v = await visite(null, demain);
    await comme("kam");
    expect(err(await direVisiteNonTenue(fd({ visitId: v, issue: "NOPE", motif: "x" })))).toMatch(/reportée ou annulée/);
    expect(err(await direVisiteNonTenue(fd({ visitId: v, issue: "POSTPONED" })))).toMatch(/Dites pourquoi/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status).toBe("PLANNED");
    const r = await direVisiteNonTenue(fd({ visitId: v, issue: "POSTPONED", motif: "Le Dr Achour est en congé." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect(await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v }, select: { status: true, notHeldReason: true, notHeldById: true } }))
      .toEqual({ status: "POSTPONED", notHeldReason: "Le Dr Achour est en congé.", notHeldById: u.kam });
    expect(await prisma.notification.count({ where: { userId: u.kam, title: { contains: "Visite reportée" } } }), "on ne se prévient pas soi-même").toBe(0);
    const edt = await loadEmploiDuTemps(await acteur("kam"), "AUJOURD_HUI", new Date(demain.getTime() + H));
    const ligne = edt.lignes.find((l) => l.id === v);
    expect(ligne).toMatchObject({ etat: "REPORTEE", motifNonTenue: "Le Dr Achour est en congé." });
  });

  it("NON TENUE — l'état d'abord : une visite rapportée a eu lieu, et le refus ne demande pas de motif", async () => {
    const v = await visite(null, new Date(Date.now() - 2 * H), doc1, "COMPLETED");
    await comme("kam");
    const r = err(await direVisiteNonTenue(fd({ visitId: v, issue: "CANCELLED" })));
    expect(r).toMatch(/rapportée : elle a eu lieu/);
    expect(r).not.toMatch(/Dites pourquoi/);
  });

  it("NON TENUE — la même fenêtre que le rapport : deux heures après, oui ; trois jours après, non", async () => {
    const recente = await visite(null, new Date(Date.now() - 2 * H));
    const ancienne = await visite(null, new Date(Date.now() - 72 * H));
    await comme("kam");
    const r = await direVisiteNonTenue(fd({ visitId: recente, issue: "CANCELLED", motif: "Cabinet fermé." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect(err(await direVisiteNonTenue(fd({ visitId: ancienne, issue: "CANCELLED", motif: "Cabinet fermé." })))).toMatch(/fenêtre de 48 h/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: ancienne } })).status, "une visite perdue ne s'efface pas après coup").toBe("PLANNED");
  });

  it("NON TENUE — un collègue ne la dit pas pour un autre ; la Direction le peut, et le KAM est prévenu", async () => {
    const v = await visite(null, new Date(Date.now() + 48 * H));
    await comme("col");
    expect(err(await direVisiteNonTenue(fd({ visitId: v, issue: "CANCELLED", motif: "x" })))).toMatch(/n'est pas la vôtre/);
    await comme("dir");
    const r = await direVisiteNonTenue(fd({ visitId: v, issue: "CANCELLED", motif: "Réunion nationale ce jour-là." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    const n = await prisma.notification.findMany({ where: { userId: u.kam, title: { contains: "Visite annulée" } }, select: { body: true } });
    expect(n.some((x) => (x.body ?? "").includes("Réunion nationale ce jour-là."))).toBe(true);
  });

  it("NON TENUE — un rapport saisi pendant ce temps l'emporte", async () => {
    const v = await visite(null, new Date(Date.now() - 2 * H));
    await comme("kam");
    const r = await pendantLaLecture("MedicalVisit",
      () => direVisiteNonTenue(fd({ visitId: v, issue: "CANCELLED", motif: "Absent." })),
      (tx) => tx.medicalVisit.update({ where: { id: v }, data: { status: "COMPLETED", report: "Vu finalement." } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status).toBe("COMPLETED");
  });

  // ── LES PORTES D'À CÔTÉ ─────────────────────────────────────────────────────────────────
  it("LA SECONDE PORTE : updateVisit ne déplace pas une visite d'un plan validé — celle d'un brouillon, oui", async () => {
    const valide = await planDe("APPROVED", "futur");
    const vv = await visite(valide.id, jourOuvre(valide.debut, 0));
    const brouillon = await planDe("DRAFT", "futur");
    const vb = await visite(brouillon.id, jourOuvre(brouillon.debut, 0));
    await comme("kam");
    expect(err(await updateVisit(fd({ id: vv, date: jourIso(jourOuvre(valide.debut, 2)) })))).toMatch(/change(nt)? par le plan/);
    expect(err(await updateVisit(fd({ id: vv, doctorId: doc2 })))).toMatch(/change(nt)? par le plan/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: vv } })).date).toEqual(jourOuvre(valide.debut, 0));
    const r = await updateVisit(fd({ id: vb, date: jourIso(jourOuvre(brouillon.debut, 2)) }));
    expect(r.ok, err(r) ?? "").toBe(true);
  });

  it("deleteVisit : ce qui a eu lieu ne s'efface pas, ni une visite d'un plan validé, ni le passé d'un plan révisé", async () => {
    const faite = await visite(null, new Date(Date.now() - 2 * H), doc1, "COMPLETED");
    const valide = await planDe("APPROVED", "futur");
    const vv = await visite(valide.id, jourOuvre(valide.debut, 0));
    const revise = await planDe("APPROVED", "passe", { status: "REVISION", revisionCount: 1, revisionNote: "x", revisionRequestedAt: new Date() });
    const vr = await visite(revise.id, jourOuvre(revise.debut, 0));
    const brouillon = await planDe("DRAFT", "futur");
    const vb = await visite(brouillon.id, jourOuvre(brouillon.debut, 0));
    await comme("kam");
    expect(err(await deleteVisit(fd({ id: faite })))).toMatch(/rapportée ne se supprime pas/);
    expect(err(await deleteVisit(fd({ id: vv })))).toMatch(/sort du plan par le plan/);
    expect(err(await deleteVisit(fd({ id: vr })))).toMatch(/reste au plan/);
    expect(await prisma.medicalVisit.count({ where: { id: { in: [faite, vv, vr] } } })).toBe(3);
    // Le témoin : la visite à venir d'un brouillon s'efface.
    const r = await deleteVisit(fd({ id: vb }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect(await prisma.medicalVisit.count({ where: { id: vb } })).toBe(0);
  });

  it("deleteVisit perd contre un rapport saisi pendant ce temps — une visite faite ne s'efface pas par la course", async () => {
    const b = await planDe("DRAFT", "futur");
    const v = await visite(b.id, jourOuvre(b.debut, 0));
    await comme("kam");
    const r = await pendantLaLecture("MedicalVisit",
      () => deleteVisit(fd({ id: v })),
      (tx) => tx.medicalVisit.update({ where: { id: v }, data: { status: "COMPLETED", report: "Vu pendant la suppression." } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status).toBe("COMPLETED");
  });

  it("UN GESTE À LA FOIS — la modification ne ramène pas à « planifiée » une visite rapportée pendant ce temps", async () => {
    const v = await visite(null, new Date(Date.now() + 24 * H));
    await comme("kam");
    const r = await pendantLaLecture("MedicalVisit",
      () => updateVisit(fd({ id: v, objective: "Présenter l'étude." })),
      (tx) => tx.medicalVisit.update({ where: { id: v }, data: { status: "COMPLETED", report: "Vu pendant la modification." } }));
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status, "le rapport l'emporte").toBe("COMPLETED");
  });

  it("une visite DÉJÀ dite annulée reste modifiable ici (son objectif), statut renvoyé à l'identique — la porte ne refuse que le CHANGEMENT", async () => {
    const v = await visite(null, new Date(Date.now() + 24 * H));
    await prisma.medicalVisit.update({ where: { id: v }, data: { status: "CANCELLED", notHeldReason: "Fermé.", notHeldById: u.kam, notHeldAt: new Date() } });
    await comme("kam");
    const r = await updateVisit(fd({ id: v, status: "CANCELLED", objective: "Replanifier en novembre." }));
    expect(r.ok, err(r) ?? "").toBe(true);
    expect(await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v }, select: { status: true, objective: true } }))
      .toEqual({ status: "CANCELLED", objective: "Replanifier en novembre." });
  });

  it("LA PHRASE DES 48 H EST VRAIE : plus de régularisation promise, et le rapport fait foi", async () => {
    const perdue = await visite(null, new Date(Date.now() - 72 * H));
    const faite = await visite(null, new Date(Date.now() - 72 * H), doc1, "COMPLETED");
    await comme("kam");
    const r1 = err(await rapporterVisite(fd({ visitId: perdue, report: "Vu." })));
    expect(r1).toMatch(/ne se dit plus reportée ou annulée/);
    expect(r1).not.toMatch(/régularis/);
    expect(err(await rapporterVisite(fd({ visitId: faite, report: "Correction." })))).toMatch(/le rapport fait foi/);
  });
});
