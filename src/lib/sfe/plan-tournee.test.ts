import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  ouvrirPlanTournee, planifierVisites, soumettrePlanTournee, deciderPlanTournee, escaladerPlanTournee,
} from "@/lib/actions/tour-plan-actions";
import { rapporterVisite, ajouterVisiteImprevue, commanderVisite } from "@/lib/actions/tour-visit-actions";
import { createPromoMessage } from "@/lib/actions/promo-message-actions";
import { saveTourPlanningSettings } from "@/lib/actions/sales-planning-actions";
import { loadEmploiDuTemps, loadPanelPlanifiable, loadPlanTournee, loadTourneeDirection } from "@/lib/queries/tour-schedule";
import { avancementTournee, echeanceDeSoumission, periodeSuivante } from "@/lib/sfe/tournee";
import { lireReglageTournee } from "@/lib/sfe/tournee-reglage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__tournee__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};
const jourIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN DE TOURNÉE, PAR SES VRAIS POINTS D'ENTRÉE.
 *
 * Les server actions de l'écran et les chargeurs qu'il appelle — pas un état injecté à la main
 * (§118.14). Ce que le module PUR décide est testé à part (`tournee.test.ts`, 29 cas) ; ici on
 * vérifie que le code l'APPELLE, et que la base porte ce qu'il faut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Plan de tournée — écran, validation, rapport, dénominateur", () => {
  let kamId = "", superviseurId = "", patronId = "", adminId = "";
  let buId = "", planId = "";
  let doc1 = "", doc2 = "", doc3 = "";
  let produitId = "", messageId = "";
  let periode = { debut: new Date(), fin: new Date() };

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [admin, kam, sup, patron] = await Promise.all([
      mk("admin", "SUPER_ADMIN"), mk("Kam Terrain", "MEDICAL_DELEGATE"),
      mk("Superviseur", "NATIONAL_SALES"), mk("Patron", "DIRECTION"),
    ]);
    adminId = admin.id; kamId = kam.id; superviseurId = sup.id; patronId = patron.id;

    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, supervisorId: sup.id } });
    buId = bu.id;
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });

    // UN PRODUIT DE SA GAMME, avec son produit canonique : sans lui, aucun rapport n'est
    // possible — c'est la chaîne `PromoProduct.productId → Product` que l'action vérifie.
    // `Product` EXIGE code, dci et identityKey — les trois sont UNIQUES. On les préfixe du même
    // TAG que le reste : c'est ce qui rend le nettoyage capable de les retrouver, et c'est la
    // clé unique qui, sinon, fait échouer le semis suivant sur une cause invisible (§118.91).
    const canon = await prisma.product.create({
      data: { code: `${TAG}PRD-NVX`, canonicalName: `${TAG}Nivolex`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivo` },
    });
    produitId = canon.id;
    await prisma.promoProduct.create({ data: { name: `${TAG}Nivolex`, businessUnitId: bu.id, productId: canon.id } });

    const [d1, d2, d3] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: kam.id, wilaya: "Alger" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Benali`, delegateId: kam.id, wilaya: "Alger" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Cherif`, delegateId: kam.id, wilaya: "Oran" } }),
    ]);
    doc1 = d1.id; doc2 = d2.id; doc3 = d3.id;

    ACTEUR = await acteur(admin.id, "SUPER_ADMIN");
    const m = await createPromoMessage(fd({ title: `${TAG}Tolérance hépatique`, businessUnitId: bu.id }));
    messageId = m.ok ? (m.id ?? "") : "";

    periode = periodeSuivante("MONTH", new Date());
  });

  afterAll(async () => {
    await prisma.medicalVisit.deleteMany({ where: { delegate: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { rep: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.promoMessage.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { canonicalName: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { businessUnit: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  // ── LE PANEL ────────────────────────────────────────────────────────────────────────────
  it("le panel planifiable réunit le SECTEUR et le rattachement direct", async () => {
    // Borner au seul secteur ferait disparaître les libéraux ; borner au seul rattachement
    // ferait disparaître l'hôpital que la Direction vient de confier. C'est leur RÉUNION.
    const panel = await loadPanelPlanifiable(kamId);
    expect(panel.map((p) => p.id).sort()).toEqual([doc1, doc2, doc3].sort());
    // Le secteur n'existe pas encore : la colonne le DIT plutôt que d'inventer un nom.
    expect(panel.every((p) => p.secteur === null)).toBe(true);
  });

  // ── OUVRIR, PLANIFIER, SOUMETTRE ────────────────────────────────────────────────────────
  it("ouvrir le plan est IDEMPOTENT — le rappeler rend le MÊME plan", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const a = await ouvrirPlanTournee(fd({ granularity: "MONTH", date: periode.debut.toISOString() }));
    expect(a.ok, a.ok === false ? a.error : "").toBe(true);
    const b = await ouvrirPlanTournee(fd({ granularity: "MONTH", date: periode.debut.toISOString() }));
    expect(b.ok).toBe(true);
    // Ce qui le ferait tomber : un `create` sec. Deux plans pour la même période, et deux
    // dénominateurs pour « visitées / planifiées ».
    expect(b.ok === true ? b.id : null).toBe(a.ok === true ? a.id : "autre");
    planId = a.ok === true ? (a.id ?? "") : "";
    expect(await prisma.tourPlan.count({ where: { repId: kamId } })).toBe(1);
  });

  it("l'échéance de soumission est FIGÉE à la création, et AVANT le début de la période", async () => {
    // Recalculée à la lecture, un changement de maille rendrait « en retard » un plan écrit sous
    // une autre règle (§118.107). Et une échéance postérieure au début de la période ferait
    // planifier des journées déjà passées — c'est la lecture assumée du module pur.
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(p.submissionDueAt.getTime()).toBeLessThan(p.periodStart.getTime());
    const jour = p.submissionDueAt.getDay();
    expect(jour === 5 || jour === 6, "une échéance ne tombe jamais un vendredi ni un samedi").toBe(false);
  });

  // ── LE RÉGLAGE : écrit par le Super Admin SEUL, lu par l'action qui ouvre ──────────────
  it("LA MAILLE se règle par le Super Admin seul — et c'est l'action d'ouverture qui la LIT", async () => {
    // Le réglage était lu à trois endroits et écrit NULLE PART : « configurable » dans la
    // doctrine, « réglée par le Super Admin » à l'écran du KAM, et aucun formulaire (§118.45).
    // Deux cas qui feraient tomber ce test : la porte ouverte à la Direction ; et
    // `ouvrirPlanTournee` retombant sur « MONTH » en dur quand le formulaire ne nomme pas de maille.
    const avant = await prisma.sfeSettings.findUnique({ where: { id: "global" } });
    try {
      ACTEUR = await acteur(patronId, "DIRECTION");
      const refus = await saveTourPlanningSettings(fd({ granularity: "QUARTER", submissionLeadDays: "20" }));
      expect(refus.ok).toBe(false);
      expect(refus.ok === false ? refus.error : "").toContain("Super Admin");

      ACTEUR = await acteur(adminId, "SUPER_ADMIN");
      const hors = await saveTourPlanningSettings(fd({ granularity: "QUARTER", submissionLeadDays: "900" }));
      expect(hors.ok, "900 jours est une faute de frappe, pas une politique — refusée en NOMMANT la borne").toBe(false);
      expect(hors.ok === false ? hors.error : "").toContain("90");
      const inconnue = await saveTourPlanningSettings(fd({ granularity: "DECADE", submissionLeadDays: "20" }));
      expect(inconnue.ok).toBe(false);
      expect(inconnue.ok === false ? inconnue.error : "").toContain("QUARTER");

      const ok = await saveTourPlanningSettings(fd({ granularity: "QUARTER", submissionLeadDays: "20" }));
      expect(ok.ok, ok.ok === false ? ok.error : "").toBe(true);
      expect(await lireReglageTournee()).toEqual({ granularite: "QUARTER", joursAvant: 20 });
      // LES AUTRES PARAMÈTRES SFE N'ONT PAS BOUGÉ : deux actions sur une ligne, chacune ses colonnes.
      const apres = await prisma.sfeSettings.findUniqueOrThrow({ where: { id: "global" } });
      expect(apres.capacity).toEqual(avant?.capacity ?? null);
      expect(apres.positionWeights).toEqual(avant?.positionWeights ?? null);
      expect(apres.frequencyByTier).toEqual(avant?.frequencyByTier ?? null);

      // L'ACTION D'OUVERTURE LIT LE RÉGLAGE : sans maille dans le formulaire, un plan TRIMESTRIEL,
      // et son échéance à 20 jours de la fin du mois qui précède le trimestre.
      ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
      const dans = new Date(periode.debut.getFullYear() + 1, 3, 15); // un 15 avril, loin des plans du banc
      const r = await ouvrirPlanTournee(fd({ date: dans.toISOString() }));
      expect(r.ok, r.ok === false ? r.error : "").toBe(true);
      const plan = await prisma.tourPlan.findUniqueOrThrow({ where: { id: r.ok === true ? (r.id ?? "") : "" } });
      expect(String(plan.granularity)).toBe("QUARTER");
      expect(jourIso(plan.periodStart)).toBe(`${dans.getFullYear()}-04-01`);
      expect(jourIso(plan.periodEnd)).toBe(`${dans.getFullYear()}-06-30`);
      expect(plan.submissionDueAt).toEqual(echeanceDeSoumission(plan.periodStart, 20));
    } finally {
      // ON REMET LE RÉGLAGE ET L'ON RETIRE LE PLAN : la base de travail est partagée, et un
      // trimestre laissé derrière soi changerait la maille de tous les autres bancs (§118.113).
      await prisma.tourPlan.deleteMany({ where: { repId: kamId, granularity: "QUARTER" } }).catch(() => {});
      if (!avant) {
        await prisma.sfeSettings.delete({ where: { id: "global" } }).catch(() => {});
      } else {
        const restaure = avant.tourPlanning == null ? Prisma.DbNull : (avant.tourPlanning as Prisma.InputJsonValue);
        await prisma.sfeSettings.update({ where: { id: "global" }, data: { tourPlanning: restaure } });
      }
    }
  });

  it("planifier écrit des `MedicalVisit` PLANNED rattachées au plan", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    // Deux jours OUVRÉS de la période (la semaine algérienne va du dimanche au jeudi).
    const jours: string[] = [];
    for (const d = new Date(periode.debut); d <= periode.fin && jours.length < 2; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 5 && d.getDay() !== 6) jours.push(jourIso(d));
    }
    const r = await planifierVisites(fd({
      planId, visite: [`${jours[0]}|${doc1}`, `${jours[0]}|${doc2}`, `${jours[1]}|${doc3}`],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const visites = await prisma.medicalVisit.findMany({ where: { tourPlanId: planId }, select: { status: true, origin: true, delegateId: true } });
    expect(visites.length).toBe(3);
    expect(visites.every((v) => v.status === "PLANNED")).toBe(true);
    expect(visites.every((v) => v.origin === "PLAN")).toBe(true);
    // LE DÉLÉGUÉ VIENT DU PLAN, jamais du formulaire : sinon un KAM planifierait pour un autre.
    expect(visites.every((v) => v.delegateId === kamId)).toBe(true);
    // LE JOURNAL NOMME UN PLAN, PAS UNE VISITE (§118.181) : `entityId` est l'identifiant du PLAN,
    // et l'ancien type VISIT faisait lire cette ligne comme l'histoire d'une visite qui n'existe pas.
    const journal = await prisma.auditLog.findMany({ where: { entityId: planId }, select: { entityType: true } });
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.map((l) => l.entityType)).toEqual(journal.map(() => "TOUR_PLAN"));
  });

  it("REPLANIFIER remplace la sélection — décocher retire", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const avant = await prisma.medicalVisit.findMany({ where: { tourPlanId: planId }, select: { date: true, doctorId: true } });
    const garde = `${jourIso(avant[0]!.date)}|${avant[0]!.doctorId}`;
    const r = await planifierVisites(fd({ planId, visite: [garde] }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    // Ce qui le ferait tomber : un `createMany` sans le retrait en face — un plan ne pourrait
    // que grandir, et retirer une visite serait impossible depuis l'écran.
    expect(await prisma.medicalVisit.count({ where: { tourPlanId: planId } })).toBe(1);
  });

  it("une visite HORS PÉRIODE est refusée, et rien n'est écrit", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const avant = await prisma.medicalVisit.count({ where: { tourPlanId: planId } });
    const horsPeriode = new Date(periode.fin.getFullYear(), periode.fin.getMonth() + 2, 10);
    const r = await planifierVisites(fd({ planId, visite: [`${jourIso(horsPeriode)}|${doc1}`] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("hors de la période");
    expect(await prisma.medicalVisit.count({ where: { tourPlanId: planId } })).toBe(avant);
  });

  it("une sélection ILLISIBLE est refusée — une paire perdue ferait un plan amputé qui a l'air complet", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await planifierVisites(fd({ planId, visite: ["n-importe-quoi"] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("illisibles");
  });

  it("un praticien HORS du panel est refusé — l'écran ne le propose pas, une requête forgée ne le planifie pas", async () => {
    // Le cas qui le ferait tomber : une action qui ne vérifie que l'EXISTENCE du praticien. Le
    // découpage d'une BU par service ne tiendrait alors qu'à l'écran.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const etranger = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Etranger`, wilaya: "Alger" } });
    const panel = (await loadPanelPlanifiable(kamId)).map((p) => p.id);
    expect(panel, "PRÉMISSE : le praticien n'est pas dans le panel").not.toContain(etranger.id);
    const avant = await prisma.medicalVisit.findMany({ where: { tourPlanId: planId }, select: { date: true, doctorId: true } });
    const garde = avant.map((v) => `${jourIso(v.date)}|${v.doctorId}`);
    const r = await planifierVisites(fd({ planId, visite: [...garde, `${jourIso(avant[0]!.date)}|${etranger.id}`] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("hors du panel");
    expect(await prisma.medicalVisit.count({ where: { tourPlanId: planId, doctorId: etranger.id } })).toBe(0);
    expect(await prisma.medicalVisit.count({ where: { tourPlanId: planId } })).toBe(avant.length);
  });

  it("une visite DÉJÀ planifiée dont le praticien a QUITTÉ le panel reste — seul ce qu'on AJOUTE est vérifié", async () => {
    // Le cas qui le ferait tomber : une garde posée sur TOUTE la sélection. Un secteur redécoupé
    // après coup bloquerait alors toute retouche du plan, pour un fait que le KAM n'a pas causé.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const avant = await prisma.medicalVisit.findMany({ where: { tourPlanId: planId }, select: { date: true, doctorId: true } });
    expect(avant.length, "PRÉMISSE : une visite déjà planifiée").toBeGreaterThan(0);
    const parti = avant[0]!.doctorId!;
    await prisma.medicalDoctor.update({ where: { id: parti }, data: { delegateId: null } });
    try {
      expect((await loadPanelPlanifiable(kamId)).map((p) => p.id), "PRÉMISSE : il a quitté le panel").not.toContain(parti);
      const r = await planifierVisites(fd({ planId, visite: avant.map((v) => `${jourIso(v.date)}|${v.doctorId}`) }));
      expect(r.ok, r.ok === false ? r.error : "").toBe(true);
      expect(await prisma.medicalVisit.count({ where: { tourPlanId: planId, doctorId: parti } })).toBe(1);
    } finally {
      await prisma.medicalDoctor.update({ where: { id: parti }, data: { delegateId: kamId } });
    }
  });

  it("soumettre RÉSOUT le validateur — le superviseur de la BU, et il est FIGÉ", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await soumettrePlanTournee(fd({ planId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(p.status).toBe("SUBMITTED");
    // LA CASCADE : le superviseur de la BU passe AVANT le N+1 d'organigramme — un plan de
    // tournée est un acte commercial, et c'est lui qui pilote le terrain de cette gamme.
    expect(p.reviewerId).toBe(superviseurId);
    expect(p.submittedAt).not.toBeNull();
  });

  it("un plan SOUMIS ne se modifie plus", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await planifierVisites(fd({ planId, visite: [] }));
    expect(r.ok).toBe(false);
    // Le refus dit pourquoi ET quand il redeviendra modifiable (§118.193) : rejeté, ou validé puis rouvert.
    expect(r.ok === false ? r.error : "").toContain("attend la décision de son validateur");
  });

  it("SEUL le validateur désigné tranche — pas quiconque a le module", async () => {
    // Ce qui le ferait tomber : garder sur `userCan(MEDICAL, UPDATE)`. N'importe quel délégué
    // validerait le plan d'un collègue, et l'audit porterait son nom.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await deciderPlanTournee(fd({ planId, decision: "APPROVE" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("Seule la personne à qui ce plan est soumis");
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe("SUBMITTED");
  });

  it("un REJET exige son motif, et ouvre 48 h pour resoumettre", async () => {
    ACTEUR = await acteur(superviseurId, "NATIONAL_SALES");
    const sans = await deciderPlanTournee(fd({ planId, decision: "REJECT" }));
    expect(sans.ok).toBe(false);
    expect(sans.ok === false ? sans.error : "").toContain("sans commentaire");

    const avec = await deciderPlanTournee(fd({ planId, decision: "REJECT", comment: "Trop de libéraux la première semaine." }));
    expect(avec.ok, avec.ok === false ? avec.error : "").toBe(true);
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(p.status).toBe("REJECTED");
    expect(p.rejectionComment).toContain("libéraux");
    expect(p.resubmitDueAt).not.toBeNull();
    const heures = (p.resubmitDueAt!.getTime() - p.decidedAt!.getTime()) / 3_600_000;
    expect(Math.round(heures)).toBe(48);
  });

  it("un plan REJETÉ redevient modifiable — le rejet REND la main au KAM", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const jours: string[] = [];
    for (const d = new Date(periode.debut); d <= periode.fin && jours.length < 2; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 5 && d.getDay() !== 6) jours.push(jourIso(d));
    }
    const r = await planifierVisites(fd({ planId, visite: [`${jours[0]}|${doc1}`, `${jours[1]}|${doc2}`] }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const re = await soumettrePlanTournee(fd({ planId }));
    expect(re.ok, re.ok === false ? re.error : "").toBe(true);
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    // LA DÉCISION PRÉCÉDENTE S'EFFACE : ce qui repart en validation n'est plus rejeté.
    expect(p.status).toBe("SUBMITTED");
    expect(p.rejectionComment).toBeNull();
    expect(p.resubmitDueAt).toBeNull();
  });

  it("le validateur peut ESCALADER — une fois, et le N+2 décide", async () => {
    // L'organigramme de ce banc ne place personne au-dessus du superviseur : le refus doit
    // NOMMER le remède plutôt que de laisser le plan sans issue (§118.30).
    ACTEUR = await acteur(superviseurId, "NATIONAL_SALES");
    const r = await escaladerPlanTournee(fd({ planId }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("organigramme");
  });

  it("le validateur VALIDE, et le plan ne se re-décide pas", async () => {
    ACTEUR = await acteur(superviseurId, "NATIONAL_SALES");
    const r = await deciderPlanTournee(fd({ planId, decision: "APPROVE" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe("APPROVED");
    const encore = await deciderPlanTournee(fd({ planId, decision: "REJECT", comment: "changement d'avis" }));
    expect(encore.ok).toBe(false);
    expect(encore.ok === false ? encore.error : "").toContain("ne se décide pas");
  });

  it("TOUT le journal du plan est sous SON type — planifier, soumettre, rejeter, valider (§118.181)", async () => {
    const journal = await prisma.auditLog.findMany({ where: { entityId: planId }, select: { entityType: true, summary: true } });
    const resumes = journal.map((l) => l.summary ?? "");
    // Les gestes que ce banc a joués y sont TOUS : sans eux, l'assertion de type porterait sur une
    // liste amputée et passerait au vert. L'escalade n'y est pas — ce banc n'a pas de N+2, elle est
    // refusée plus haut, et son type n'est éprouvé par aucun cas qui réussit.
    for (const geste of ["planifiée", "soumis à validation", "REJETÉ", "VALIDÉ"]) {
      expect(resumes.some((s) => s.includes(geste)), geste).toBe(true);
    }
    expect(journal.map((l) => l.entityType)).toEqual(journal.map(() => "TOUR_PLAN"));
  });

  // ── LE RAPPORT TERRAIN ──────────────────────────────────────────────────────────────────
  it("le rapport EXIGE produits ET messages — sans eux, rien ne se mesure", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    // Une visite DATÉE D'AUJOURD'HUI : la fenêtre de 48 h est ouverte.
    const v = await prisma.medicalVisit.create({
      data: { date: new Date(), doctorId: doc1, delegateId: kamId, status: "PLANNED", origin: "PLAN", tourPlanId: planId },
      select: { id: true },
    });
    const sansProduit = await rapporterVisite(fd({ visitId: v.id, report: "Bon accueil." }));
    expect(sansProduit.ok).toBe(false);
    expect(sansProduit.ok === false ? sansProduit.error : "").toContain("produits discutés");

    const sansMessage = await rapporterVisite(fd({ visitId: v.id, report: "Bon accueil.", productId: [produitId] }));
    expect(sansMessage.ok).toBe(false);
    expect(sansMessage.ok === false ? sansMessage.error : "").toContain("messages de la Direction Marketing");

    const sansTexte = await rapporterVisite(fd({ visitId: v.id, productId: [produitId], messageId: [messageId] }));
    expect(sansTexte.ok).toBe(false);
    expect(sansTexte.ok === false ? sansTexte.error : "").toContain("case cochée");

    const bon = await rapporterVisite(fd({
      visitId: v.id, report: "Intéressé, veut l'étude de tolérance.", productId: [produitId], messageId: [messageId],
    }));
    expect(bon.ok, bon.ok === false ? bon.error : "").toBe(true);
    const relu = await prisma.medicalVisit.findUniqueOrThrow({
      where: { id: v.id },
      include: { productLinks: true, messageLinks: true },
    });
    expect(relu.status).toBe("COMPLETED");
    expect(relu.productLinks.length).toBe(1);
    expect(relu.messageLinks.length).toBe(1);
    // Le texte hérité reste renseigné pour les écrans qui le lisent encore.
    expect(relu.presentedProducts).toContain(TAG);
  });

  it("un produit HORS de sa gamme est refusé", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const autre = await prisma.product.create({
      data: { code: `${TAG}PRD-HORS`, canonicalName: `${TAG}Hors gamme`, dci: `${TAG}horsgamme`, identityKey: `${TAG}hors` },
    });
    const v = await prisma.medicalVisit.create({
      data: { date: new Date(), doctorId: doc2, delegateId: kamId, status: "PLANNED", origin: "PLAN", tourPlanId: planId },
      select: { id: true },
    });
    const r = await rapporterVisite(fd({ visitId: v.id, report: "x", productId: [autre.id], messageId: [messageId] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("gamme de ce KAM");
  });

  it("LE VERROU DE 48 H est côté serveur, et le refus dit la date de fermeture", async () => {
    // Ce qui le ferait tomber : un verrou seulement à l'écran. Il se contourne en rechargeant
    // la page, et des visites d'il y a trois semaines rentreraient au pilotage.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const vieille = new Date(Date.now() - 5 * 24 * 3_600_000);
    const v = await prisma.medicalVisit.create({
      data: { date: vieille, doctorId: doc3, delegateId: kamId, status: "PLANNED", origin: "PLAN", tourPlanId: planId },
      select: { id: true },
    });
    const r = await rapporterVisite(fd({ visitId: v.id, report: "x", productId: [produitId], messageId: [messageId] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("48 h");
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("PLANNED");
  });

  it("une visite IMPRÉVUE est hors plan, rapportée d'emblée, message FACULTATIF", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await ajouterVisiteImprevue(fd({
      doctorId: doc2, report: "Croisé en sortant, veut de la doc.", productId: [produitId],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const v = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: r.ok === true ? r.id! : "" } });
    expect(v.tourPlanId, "hors plan : c'est ce qui l'empêche de gonfler le dénominateur").toBeNull();
    expect(v.origin).toBe("UNPLANNED");
    expect(v.status).toBe("COMPLETED");
  });

  it("une visite imprévue HORS DÉLAI est refusée — sinon elle contournerait le verrou", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const vieux = new Date(Date.now() - 20 * 24 * 3_600_000);
    const r = await ajouterVisiteImprevue(fd({ doctorId: doc2, date: jourIso(vieux), report: "x" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("48 h");
  });

  it("la Direction COMMANDE une visite — à faire, hors plan, et distinguée d'un imprévu", async () => {
    ACTEUR = await acteur(superviseurId, "NATIONAL_SALES");
    const demain = new Date(Date.now() + 24 * 3_600_000);
    const r = await commanderVisite(fd({
      repId: kamId, doctorId: doc3, date: demain.toISOString(), objective: "Point sur le Nivolex",
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const v = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: r.ok === true ? r.id! : "" } });
    expect(v.status).toBe("PLANNED");
    expect(v.origin, "sans `origin`, « le KAM improvise » et « la Direction envoie » se liraient pareil").toBe("DIRECTION");
    expect(v.tourPlanId).toBeNull();
    expect(v.delegateId).toBe(kamId);
  });

  it("se commander une visite À SOI-MÊME est refusé, avec le geste qui convient", async () => {
    ACTEUR = await acteur(superviseurId, "NATIONAL_SALES");
    const r = await commanderVisite(fd({ repId: superviseurId, doctorId: doc3, date: new Date().toISOString() }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("visite imprévue");
  });

  it("commander la visite d'un KAM HORS de son périmètre est refusé", async () => {
    ACTEUR = await acteur(patronId, "DIRECTION");
    // La DIRECTION a une vue globale, donc elle passe : le cas qui doit tomber est celui d'un
    // délégué qui commanderait la visite d'un collègue.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await commanderVisite(fd({ repId: superviseurId, doctorId: doc3, date: new Date().toISOString() }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("périmètre de supervision");
  });

  // ── LE DÉNOMINATEUR — UN SEUL ───────────────────────────────────────────────────────────
  it("L'ÉCRAN DU KAM ET LE TABLEAU DE BORD DE LA DIRECTION COMPTENT LA MÊME CHOSE", async () => {
    // §118.51 : deux écrans qui comptent séparément divergent, toujours — et le symptôme serait
    // un KAM à qui l'on reproche un taux que son propre écran ne montre pas. Le cas qui ferait
    // tomber cette assertion : l'un des deux cesse d'appeler `avancementTournee` et refait
    // l'arithmétique sur place.
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const kamUser = await acteur(kamId, "MEDICAL_DELEGATE");
    const maintenant = new Date();
    const mois = { debut: new Date(maintenant.getFullYear(), maintenant.getMonth(), 1), fin: new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0, 23, 59, 59, 999) };

    const edt = await loadEmploiDuTemps(kamUser, "MOIS", maintenant);
    const dir = await loadTourneeDirection([kamId], mois.debut, mois.fin, maintenant);
    const ligne = dir.lignes.find((l) => l.repId === kamId);
    expect(ligne, "le KAM doit apparaître au tableau de bord").toBeTruthy();
    expect(ligne!.avancement).toEqual(edt.avancementDuMois);
    // ET LE TOTAL EST LA SOMME DES LIGNES, jamais un second calcul.
    expect(dir.total.planifiees).toBe(ligne!.avancement.planifiees);
    expect(dir.total.visitesTotales).toBe(ligne!.avancement.visitesTotales);
  });

  it("LE TAUX TOTAL SE CALCULE SUR LES TOTAUX — une MOYENNE des taux de ligne mentirait", async () => {
    // CE CAS EXISTE PARCE QU'UN SABOTAGE EST PASSÉ AU VERT. Remplacer le taux du total par la
    // moyenne des taux de ligne n'a fait tomber AUCUN des 26 cas : tous chargeaient une portée
    // d'UNE seule ligne, où la moyenne d'un taux et le taux sur les totaux sont le MÊME nombre.
    // L'assertion de comparaison (§118.51) visait donc l'autre moitié du mécanisme — vraie, mais
    // aveugle à ce qu'elle prétendait garder (§118.111).
    //
    // Il faut DEUX lignes aux dénominateurs DIFFÉRENTS, et c'est le cas que le commentaire de
    // `loadTourneeDirection` nommait déjà sans que personne l'exerce : « un KAM de 4 visites et
    // un KAM de 40 ».
    //
    //   · petit : 1 planifiée, 1 faite            → 100 %
    //   · gros  : 9 planifiées, 0 faite           →   0 %
    //   · moyenne des taux .......................→  50 %   ← le mensonge
    //   · taux sur les totaux (1 / 10) ...........→  10 %   ← la vérité
    //
    // Quarante points d'écart, et dans le sens qui FLATTE : la Direction lirait « la moitié de
    // la tournée est faite » sur une force de vente qui en a réalisé un dixième.
    const maintenant = new Date();
    const mois = { debut: new Date(maintenant.getFullYear(), maintenant.getMonth(), 1), fin: new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0, 23, 59, 59, 999) };
    const jourDuMois = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1, 9, 0, 0);

    const mkKam = async (suffixe: string) => {
      const u = await prisma.user.create({
        data: { name: `${TAG}${suffixe}`, email: `${TAG}${suffixe}@t.dz`, role: "MEDICAL_DELEGATE" as never, passwordHash: "x" },
      });
      const plan = await prisma.tourPlan.create({
        data: {
          repId: u.id, periodStart: mois.debut, periodEnd: mois.fin, granularity: "MONTH",
          status: "APPROVED", submissionDueAt: mois.debut, createdById: u.id,
        },
        select: { id: true },
      });
      return { id: u.id, planId: plan.id };
    };
    const [petit, gros] = await Promise.all([mkKam("Petit KAM"), mkKam("Gros KAM")]);

    // La SEULE visite du petit, rapportée : FAITE.
    await prisma.medicalVisit.create({
      data: {
        date: jourDuMois, doctorId: doc1, delegateId: petit.id, status: "COMPLETED", origin: "PLAN",
        tourPlanId: petit.planId, createdById: petit.id, report: "fait",
      },
    });
    // Les NEUF du gros, aucune rapportée. `A_FAIRE` ou `PERDUE` selon la date du jour : les deux
    // comptent au dénominateur et jamais au numérateur, donc ce cas ne dépend pas du calendrier.
    await prisma.medicalVisit.createMany({
      data: Array.from({ length: 9 }, () => ({
        date: jourDuMois, doctorId: doc1, delegateId: gros.id, status: "PLANNED" as const,
        origin: "PLAN" as const, tourPlanId: gros.planId, createdById: gros.id,
      })),
    });

    const dir = await loadTourneeDirection([petit.id, gros.id], mois.debut, mois.fin, maintenant);
    const lp = dir.lignes.find((l) => l.repId === petit.id)!;
    const lg = dir.lignes.find((l) => l.repId === gros.id)!;
    expect([lp.avancement.planifiees, lp.avancement.visitees]).toEqual([1, 1]);
    expect([lg.avancement.planifiees, lg.avancement.visitees]).toEqual([9, 0]);
    expect(lp.avancement.tauxRealisation).toBe(100);
    expect(lg.avancement.tauxRealisation).toBe(0);

    expect(dir.total.planifiees).toBe(10);
    expect(dir.total.visitees).toBe(1);
    const moyenneDesTaux = Math.round((lp.avancement.tauxRealisation + lg.avancement.tauxRealisation) / 2);
    expect(moyenneDesTaux).toBe(50); // la valeur que le défaut produirait
    expect(dir.total.tauxRealisation, "le total doit valoir 1/10, pas la moyenne de 100 % et 0 %").toBe(10);
    expect(dir.total.tauxRealisation).not.toBe(moyenneDesTaux);
  });

  it("une visite IMPRÉVUE gonfle « le nombre de visites », jamais « planifiées »", async () => {
    const maintenant = new Date();
    const mois = { debut: new Date(maintenant.getFullYear(), maintenant.getMonth(), 1), fin: new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0, 23, 59, 59, 999) };
    const dir = await loadTourneeDirection([kamId], mois.debut, mois.fin, maintenant);
    const l = dir.lignes.find((x) => x.repId === kamId)!;
    expect(l.avancement.imprevues).toBeGreaterThanOrEqual(1);
    expect(l.avancement.visitesTotales).toBeGreaterThan(l.avancement.visitees);
    // Le cas qui la ferait tomber : compter l'imprévue au dénominateur — le taux dépasserait
    // 100 % et la planification deviendrait illisible.
    expect(l.avancement.tauxRealisation).toBeLessThanOrEqual(100);
  });

  it("un KAM SANS PLAN est NOMMÉ, pas compté 0/0 comme s'il n'avait rien à faire", async () => {
    const orphelin = await prisma.user.create({
      data: { name: `${TAG}Sans plan`, email: `${TAG}sansplan@t.dz`, role: "MEDICAL_DELEGATE" as never, passwordHash: "x" },
    });
    const maintenant = new Date();
    const dir = await loadTourneeDirection(
      [orphelin.id],
      new Date(maintenant.getFullYear(), maintenant.getMonth(), 1),
      new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0),
      maintenant,
    );
    expect(dir.sansPlan).toBe(1);
    expect(dir.lignes[0]!.statutPlan).toBeNull();
    // ZÉRO PLANIFIÉE REND 0 %, jamais 100 % : « rien à faire donc tout est fait » est le faux
    // succès de l'arithmétique.
    expect(dir.lignes[0]!.avancement.tauxRealisation).toBe(0);
  });

  it("LA DIRECTION VOIT LE RETARD : sans plan après l'échéance, brouillon en retard — jamais un plan soumis", async () => {
    // `enRetardDeSoumission` était écrite, testée, et SANS appelant : l'échéance s'affichait
    // « à soumettre avant le … » avant comme après son passage (§118.14, §118.49). Le cas qui
    // ferait tomber l'avant-dernière assertion : juger un plan SOUMIS sur la date du jour — on
    // reprocherait au KAM le temps de décision de son manager.
    const retardataire = await prisma.user.create({
      data: { name: `${TAG}Retardataire`, email: `${TAG}retard@t.dz`, role: "MEDICAL_DELEGATE" as never, passwordHash: "x" },
    });
    // Le mois COURANT : son échéance (avant la fin du mois précédent) est passée à coup sûr.
    const maintenant = new Date();
    const mois = { debut: new Date(maintenant.getFullYear(), maintenant.getMonth(), 1), fin: new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0, 23, 59, 59, 999) };

    const sans = await loadTourneeDirection([retardataire.id], mois.debut, mois.fin, maintenant);
    expect(sans.lignes[0]!.statutPlan).toBeNull();
    expect(sans.lignes[0]!.retard.enRetard, "aucun plan après l'échéance = en retard, pas « rien à faire »").toBe(true);
    expect(sans.lignes[0]!.retard.jours).toBeGreaterThan(0);
    expect(sans.enRetard).toBe(1);

    const brouillon = await prisma.tourPlan.create({
      data: {
        repId: retardataire.id, periodStart: mois.debut, periodEnd: mois.fin, granularity: "MONTH", status: "DRAFT",
        submissionDueAt: echeanceDeSoumission(mois.debut), createdById: retardataire.id,
      },
    });
    const avecBrouillon = await loadTourneeDirection([retardataire.id], mois.debut, mois.fin, maintenant);
    expect(avecBrouillon.lignes[0]!.statutPlan).toBe("DRAFT");
    expect(avecBrouillon.lignes[0]!.retard.enRetard).toBe(true);
    expect(avecBrouillon.enRetard).toBe(1);

    // SOUMIS — même très tard — plus aucun retard à signaler.
    await prisma.tourPlan.update({ where: { id: brouillon.id }, data: { status: "SUBMITTED", submittedAt: maintenant } });
    const soumis = await loadTourneeDirection([retardataire.id], mois.debut, mois.fin, maintenant);
    expect(soumis.lignes[0]!.retard.enRetard).toBe(false);
    expect(soumis.enRetard).toBe(0);

    // REJETÉ avec 47 h devant lui : pas en retard — c'est l'échéance de RESOUMISSION qui compte,
    // et l'écran du KAM lit la MÊME (un seul calcul, §118.51).
    await prisma.tourPlan.update({
      where: { id: brouillon.id },
      data: { status: "REJECTED", resubmitDueAt: new Date(maintenant.getTime() + 47 * 3_600_000) },
    });
    const rejete = await loadTourneeDirection([retardataire.id], mois.debut, mois.fin, maintenant);
    expect(rejete.lignes[0]!.retard.enRetard).toBe(false);
    expect(rejete.lignes[0]!.retard.echeance.getTime()).toBeGreaterThan(maintenant.getTime());
    const vue = await loadPlanTournee(brouillon.id, maintenant);
    expect(vue!.retard).toEqual(rejete.lignes[0]!.retard);
  });

  it("une portée VIDE ne divise pas par zéro et ne prétend rien", async () => {
    const dir = await loadTourneeDirection([], new Date(), new Date());
    expect(dir.lignes).toEqual([]);
    expect(dir.total).toEqual(avancementTournee([]));
  });
});
