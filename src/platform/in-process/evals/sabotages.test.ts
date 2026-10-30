import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { Reasoner, ReasonRequest, ReasonResult } from "@/lib/missions/ports";
import { trancher, type Candidat } from "@/lib/fabric";
import { calibrer, type FaitCalibrable } from "@/lib/assistant/confidence/calibrate";
import { detecter } from "@/lib/quality/rules";
import { enseigner, politiquesPourMission, reglesEnVigueurPour } from "@/platform/ia/teach/store";
import { executeReadTool } from "@/lib/assistant";
import { estPanneTransitoire, lancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { signauxFinance } from "@/platform/in-process/intelligence";
import { balayerSurveillances, creerSurveillance } from "@/platform/in-process/missions/watch";
import { balayerMissions } from "@/platform/in-process/missions/sweep";
import { callModel } from "@/lib/models/gateway";
import { specialistesActifs } from "@/lib/assistant/specialists/registry";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MATRICE DES SABOTAGES (mandat 4 §33, étendue §17) — dix-sept situations qui font mentir un assistant
 * ordinaire, jouées contre le VRAI code, jugées par le code.
 *
 * Un sabotage n'est pas une mutation du programme (cela, c'est `office:sabotage`) : c'est une
 * SITUATION adverse — une entité ambiguë, deux fiches pour une personne, une source qui n'est pas
 * sûre, deux chiffres pour un même fait, une règle qui en contredit une autre, un droit absent, un
 * fournisseur qui tombe, une facture sans commande, une panne pendant une surveillance, un
 * redéploiement, une règle changée en cours de mission, deux spécialistes en désaccord, un plafond
 * de coût atteint, le modèle principal indisponible — et, depuis §17, trois situations qui
 * n'étaient pas couvertes : des ÉVÉNEMENTS QUI ARRIVENT DANS LE DÉSORDRE, une ÉCHÉANCE DÉJÀ
 * PASSÉE au moment où on la découvre, et DES DIZAINES DE MISSIONS EN MÊME TEMPS. Pour chacune,
 * le comportement exigé est déjà une propriété codée quelque part ; ce fichier prouve qu'elle
 * tient, depuis l'entrée réelle, et compte : 17 tenus sur 17 est la cible, tout écart est une
 * régression nommée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sabo${Date.now().toString(36)}`;
const JOUR = 86_400_000;
let pdg: CurrentUser;
let lecteur: CurrentUser;
const tenus = new Set<string>();
const SABOTAGES = 17;

/**
 * LE JOUR DU BANC — la date à laquelle ces faits sont JUGÉS. Les faits portent une date fixe
 * (`horodatage`), et la calibration juge la fraîcheur d'une COPIE contre « maintenant » (§118.55) :
 * sans jour fixé, le cas « une lecture OCR n'est jamais certaine » est passé de PROBABLE à PÉRIMÉ le
 * 1er octobre 2026, trente jours après la date du fait — rouge un matin, sur une règle juste. Un juge
 * relatif à « aujourd'hui » ne prouve une règle de calendrier que les jours où le calendrier le veut
 * bien (§118.131) : chaque `calibrer` de ce banc reçoit ce jour-là.
 */
const JOUR_DU_BANC = { maintenant: new Date("2026-09-02T00:00:00.000Z") } as const;

const fait = (p: Partial<FaitCalibrable> & Pick<FaitCalibrable, "id" | "libelle" | "valeur">): FaitCalibrable => ({
  nature: "ERP", outil: "inspect_record", confiance: 0.95, base: "native", fraicheur: "TEMPS_REEL", horodatage: "2026-09-01T00:00:00.000Z", preuveNegative: null, ...p,
});
const candidat = (id: string, libelle: string, score: number): Candidat => ({ type: "PERSONNE", id, libelle, detail: null, score, preuves: ["jetons"], href: null });

const PLAN = planScripte({
  goal: "Retrouver ce que l'entreprise sait du sujet.",
  reasoningComplexity: "A", executionScale: "S",
  acceptanceCriteria: ["Une recherche a été faite."],
  workstreams: [{ id: "lecture", title: "Lecture", outcome: "La recherche est faite." }],
  steps: [{
    key: "recherche", title: "Chercher", workstream: "lecture", nodeType: "CAPABILITY", capability: "search_everything",
    inputs: [{ key: "query", kind: "TEXT", value: TAG }], dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
    waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
    outputFields: [], completionCondition: "La recherche a eu lieu.",
    reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
  }],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: "La recherche a eu lieu.", gaps: [], rationale: "lecture nue",
});

/** Un raisonneur dont le FOURNISSEUR tombe une fois (HTTP 503) puis répond. */
function fournisseurQuiTombe(message: string): Reasoner & { appels: number } {
  return {
    appels: 0,
    configured: () => true,
    async reason<T>(req: ReasonRequest): Promise<ReasonResult<T>> {
      this.appels += 1;
      if (req.purpose === "mission.plan" && this.appels === 1) return { ok: false, data: null, error: message, usage: null, latencyMs: 3 };
      if (req.purpose === "mission.plan") return { ok: true, data: PLAN as unknown as T, usage: null, latencyMs: 3 };
      return { ok: true, data: { satisfied: true, confidence: 1, criteria: [], missing: [], contradictions: [] } as unknown as T, usage: null, latencyMs: 1 };
    },
  };
}

suite("sabotages — quatorze situations adverses, tenues par le code", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const v = await prisma.user.create({ data: { name: `${TAG} Lecteur`, email: `${TAG}lecteur@amd.dz`, passwordHash: "x", role: "VIEWER" }, select: { id: true, name: true, email: true, role: true } });
    lecteur = { id: v.id, name: v.name, email: v.email, role: v.role, access: (await getAccess(v.id, v.role)) as EffectiveAccess, mustChangePassword: false };
  }, 60_000);

  afterAll(async () => {
    consignerMesure("sabotages", { n: SABOTAGES, ok: tenus.size }, "platform/in-process/evals/sabotages.test.ts", [...tenus].join(", "));
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.adamWatch.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.adamRule.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [pdg.id, lecteur.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("1. mauvaise entité : deux « Ahmed » plausibles → aucun n'est retenu, une question est posée", () => {
    const t = trancher("Ahmed", [candidat("p1", "Ahmed Benali", 0.82), candidat("p2", "Ahmed Haddad", 0.81)]);
    expect(t.verdict).not.toBe("CERTAIN");
    expect(t.retenu).toBeNull();
    expect(t.question).toBeTruthy();
    expect(t.candidats.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
    tenus.add("mauvaise_entite");
  });

  it("2. doublons : deux fiches salarié au même nom sont détectées par le moteur de qualité, jamais fusionnées", async () => {
    const nom = `${TAG} Karim Benali`;
    const [a, b] = await Promise.all([
      prisma.employee.create({ data: { fullName: nom, email: `${TAG}a@amd.dz`, position: "Comptable", isActive: true }, select: { id: true } }),
      prisma.employee.create({ data: { fullName: nom, email: `${TAG}b@amd.dz`, position: "Comptable", isActive: true }, select: { id: true } }),
    ]);
    const constats = await detecter("doublon_nom_salaries");
    const notres = constats.filter((c) => c.entiteId === a.id || c.entiteId === b.id);
    expect(notres).toHaveLength(2);
    expect(notres.every((c) => c.resolution === "HUMAIN")).toBe(true);
    // Rien n'a été fusionné : les deux lignes existent toujours.
    expect(await prisma.employee.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);
    tenus.add("doublons");
  }, 60_000);

  it("3. source obsolète ou non sûre : une lecture OCR ou de modèle n'est jamais CERTAINE → vérifier avant d'agir", () => {
    const ocr = calibrer([fait({ id: "f1", libelle: "Total TTC", valeur: "142 800", nature: "DOCUMENT", outil: "read_document", base: "ocr", confiance: 0.6, fraicheur: "INDEXEE" })], JOUR_DU_BANC);
    expect(ocr.certitude).toBe("PROBABLE");
    expect(ocr.conduite).toBe("VERIFIER");
    const luna = calibrer([fait({ id: "f2", libelle: "Fournisseur", valeur: "Kwality", nature: "DOCUMENT", outil: "read_document", base: "luna", confiance: 0.97 })], JOUR_DU_BANC);
    expect(luna.certitude).not.toBe("CERTAIN");
    tenus.add("source_obsolete");
  });

  it("4. contradiction : ERP 15 M et classeur 17 M pour le même fait → CONTRADICTION, arbitrage humain", () => {
    const c = calibrer([
      fait({ id: "e1", libelle: "Chiffre d'affaires 2025", valeur: "15 000 000 DZD", nature: "ERP", outil: "finance_totals" }),
      fait({ id: "x1", libelle: "Chiffre d'affaires 2025", valeur: "17 000 000 DZD", nature: "DOCUMENT", outil: "read_spreadsheet", confiance: 0.9 }),
    ], JOUR_DU_BANC);
    expect(c.certitude).toBe("CONTRADICTION");
    expect(c.conduite).toBe("ARBITRER");
    expect(c.contradictions).toHaveLength(1);
    expect(c.contradictions[0].valeurs).toHaveLength(2);
    tenus.add("contradiction");
  });

  it("5. règle conflictuelle : une seconde règle de même clé est REFUSÉE et dite ; la remplacer crée la version 2 et garde la v1", async () => {
    const v1 = await enseigner(pdg, { statement: `${TAG} Nos devis sont valables 30 jours.`, kind: "DOCUMENT_STANDARD", scope: "PERSON" });
    expect(v1.ok, JSON.stringify(v1)).toBe(true);
    if (!v1.ok) return;
    const conflit = await enseigner(pdg, { statement: `${TAG} Nos devis sont valables 45 jours.`, kind: "DOCUMENT_STANDARD", scope: "PERSON" });
    expect(conflit.ok).toBe(false);
    if (conflit.ok) return;
    expect(conflit.echec).toBe("MISSING_INPUT");
    expect(conflit.motif).toMatch(/porte déjà/);
    const v2 = await enseigner(pdg, { statement: `${TAG} Nos devis sont valables 45 jours.`, kind: "DOCUMENT_STANDARD", scope: "PERSON", remplaceId: v1.regle.id });
    expect(v2.ok, JSON.stringify(v2)).toBe(true);
    if (!v2.ok) return;
    expect(v2.regle.version).toBe(2);
    const ancienne = await prisma.adamRule.findUnique({ where: { id: v1.regle.id }, select: { status: true } });
    expect(ancienne?.status).toBe("SUPERSEDED");
    tenus.add("regle_conflictuelle");
  }, 60_000);

  it("6. permission refusée : un compte sans droit n'obtient pas la lecture exécutive, et la phrase le dit", async () => {
    const refus = await executeReadTool("executive_alerts", {}, lecteur);
    expect(refus).toMatch(/ne vous est pas ouvert/);
    const ok = await executeReadTool("executive_alerts", {}, pdg);
    expect(ok).not.toMatch(/ne vous est pas ouvert/);
    tenus.add("permission_refusee");
  }, 60_000);

  it("7. fournisseur indisponible : une panne HTTP 503 pendant la planification RETIENT la demande (talon PLANNING), rien n'est perdu", async () => {
    expect(estPanneTransitoire("Erreur IA (HTTP 502) : upstream request failed")).toBe(true);
    expect(estPanneTransitoire("Le fournisseur refuse la demande : contenu non autorisé")).toBe(false);
    const cerveau = fournisseurQuiTombe("Erreur IA (HTTP 503) : upstream request failed");
    const r = await lancerMission(pdg, `Occupe-toi du sujet ${TAG}.`, { reasoner: cerveau, sansEnquete: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.differe).toBe(true);
    const m = await prisma.mission.findUnique({ where: { id: r.missionId }, select: { status: true, goalRaw: true } });
    expect(m?.status).toBe("PLANNING");
    expect(m?.goalRaw).toContain(TAG);
    const journal = await prisma.missionEvent.findMany({ where: { missionId: r.missionId }, select: { kind: true } });
    expect(journal.map((e) => e.kind)).toContain("PLANNING_DEFERRED");
    tenus.add("fournisseur_indisponible");
  }, 90_000);

  it("8. facture sans BC : une facture enregistrée sans commande chaînée est un SIGNAL de l'intelligence finance", async () => {
    const f = await prisma.legalDocument.create({
      data: { title: `${TAG} Facture Kwality 0042`, kind: "INVOICE", status: "ACTIVE", counterparty: "Kwality", amount: 142_800, createdById: pdg.id, createdAt: new Date(Date.now() - 10 * JOUR) },
      select: { id: true },
    });
    const lecture = await signauxFinance(pdg, { horizonJours: 30 });
    const signal = lecture.signaux.find((s) => s.code === "facture_sans_bc" && s.entite?.id === f.id);
    expect(signal, lecture.signaux.map((s) => `${s.code}:${s.entite?.id ?? ""}`).join(", ")).toBeDefined();
    tenus.add("facture_sans_bc");
  }, 60_000);

  it("9. crash pendant une surveillance : la ligne durable suffit — le balayage suivant la relit une fois, pas deux", async () => {
    await prisma.task.create({ data: { title: `${TAG} Livrer le rapport de stock`, status: "TODO", dueDate: new Date(Date.now() + 10 * JOUR), assignedToId: pdg.id, createdById: pdg.id } });
    const w = await creerSurveillance(pdg, { reference: `${TAG} Livrer le rapport de stock` });
    expect(w.ok, JSON.stringify(w)).toBe(true);
    if (!w.ok) return;
    // Le processus meurt en plein balayage : la relecture n'a pas été inscrite, l'échéance est due.
    const t0 = new Date();
    await prisma.adamWatch.update({ where: { id: w.id }, data: { lastCheckedAt: null, nextCheckAt: new Date(t0.getTime() - 60_000) } });
    await balayerSurveillances(new Date(), { max: 500 });
    const apres = await prisma.adamWatch.findUnique({ where: { id: w.id }, select: { lastCheckedAt: true, status: true, nextCheckAt: true } });
    expect(apres?.status).toBe("ACTIVE");
    expect(apres?.lastCheckedAt && apres.lastCheckedAt >= t0).toBe(true);
    expect(apres!.nextCheckAt > new Date()).toBe(true);
    await balayerSurveillances(new Date(), { max: 500 });
    const rejoue = await prisma.adamWatch.findUnique({ where: { id: w.id }, select: { lastCheckedAt: true } });
    expect(rejoue?.lastCheckedAt?.getTime()).toBe(apres?.lastCheckedAt?.getTime());
    tenus.add("crash_surveillance");
  }, 90_000);

  it("10. redéploiement : règles et surveillances ne vivent qu'en base — une relecture neuve retrouve tout", async () => {
    const r = await enseigner(pdg, { statement: `${TAG} Pour mes rapports, toujours une synthèse en tête.`, kind: "PREFERENCE", scope: "PERSON" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // « Nouveau processus » : aucune mémoire — on relit depuis la base, par l'entrée de production.
    const { resolution } = await reglesEnVigueurPour(pdg.id);
    expect(resolution.enVigueur.some((x) => x.statement.includes("synthèse en tête"))).toBe(true);
    const enBase = await prisma.adamRule.count({ where: { ownerId: pdg.id } });
    expect(enBase).toBeGreaterThanOrEqual(3); // v1 remplacée, v2, préférence — les versions comprises
    const watches = await prisma.adamWatch.count({ where: { ownerId: pdg.id, status: "ACTIVE" } });
    expect(watches).toBeGreaterThanOrEqual(1);
    tenus.add("redeploiement");
  }, 60_000);

  it("11. règle mise à jour en cours de mission : le planificateur relit les politiques à chaque plan — la nouvelle règle est vue au tour suivant", async () => {
    const avant = await politiquesPourMission(pdg.id);
    expect(avant.some((p) => p.includes("relance fournisseur passe par Lina"))).toBe(false);
    const r = await enseigner(pdg, { statement: `${TAG} Toute relance fournisseur passe par Lina avant envoi.`, kind: "WORKFLOW", scope: "PERSON" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const apres = await politiquesPourMission(pdg.id);
    expect(apres.some((p) => p.includes("relance fournisseur passe par Lina"))).toBe(true);
    tenus.add("regle_en_cours_de_mission");
  }, 60_000);

  it("12. sous-agents en désaccord : deux spécialistes rendent deux chiffres → CONTRADICTION, arbitrage — et aucun spécialiste n'est actif sans bénéfice mesuré", () => {
    const c = calibrer([
      fait({ id: "s1", libelle: "Pénalité contractuelle", valeur: "10 %", nature: "DOCUMENT", outil: "specialiste:legal", confiance: 0.9 }),
      fait({ id: "s2", libelle: "Pénalité contractuelle", valeur: "5 %", nature: "DOCUMENT", outil: "specialiste:finance", confiance: 0.9 }),
    ], JOUR_DU_BANC);
    expect(c.certitude).toBe("CONTRADICTION");
    expect(c.conduite).toBe("ARBITRER");
    expect(c.contradictions[0].outils.sort()).toEqual(["specialiste:finance", "specialiste:legal"]);
    expect(specialistesActifs()).toEqual([]);
    tenus.add("sous_agents_en_desaccord");
  });

  it("13. coût trop élevé : le plafond de modèle atteint fait DORMIR la mission (BUDGET_HOLD) — rien n'est payé, rien n'échoue", async () => {
    const m = await prisma.mission.create({
      data: {
        ownerId: pdg.id, kind: "RUNTIME", title: `${TAG} Mission plafonnée`, objective: "Lire l'annuaire.", goalRaw: "Lire l'annuaire.", status: "RUNNING",
        modelCallsCap: 1, modelCalls: 1, priority: 100,
        steps: { create: [{ key: "lecture", title: "Lire l'annuaire", capability: "directory_list", nodeType: "CAPABILITY", status: "PENDING", input: {} }] },
      },
      select: { id: true },
    });
    await balayerMissions();
    const journal = await prisma.missionEvent.findMany({ where: { missionId: m.id }, select: { kind: true, summary: true } });
    expect(journal.map((e) => e.kind)).toContain("BUDGET_HOLD");
    const etape = await prisma.missionStep.findFirst({ where: { missionId: m.id }, select: { status: true } });
    expect(etape?.status).toBe("PENDING");
    const mission = await prisma.mission.findUnique({ where: { id: m.id }, select: { status: true, modelCalls: true } });
    expect(mission?.status).toBe("RUNNING");
    expect(mission?.modelCalls).toBe(1);
    tenus.add("cout_trop_eleve");
  }, 120_000);

  it("14. modèle principal indisponible : HTTP 503 → une réponse honnête (ok: false, arrêt « error »), classée transitoire, jamais une exception ni un faux texte", async () => {
    const ancienne = process.env.OPENAI_API_KEY;
    if (!ancienne) process.env.OPENAI_API_KEY = "sk-test-indisponible";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "upstream request failed" } }), { status: 503, headers: { "content-type": "application/json" } }));
    try {
      const r = await callModel("orchestrator", [{ role: "user", content: "ping" }], { maxOutputTokens: 16 });
      expect(r.ok).toBe(false);
      expect(r.stop).toBe("error");
      expect(r.configured).toBe(true);
      expect(r.blocks).toEqual([]);
      const message = r.error ?? "";
      expect(message.length).toBeGreaterThan(0);
      expect(estPanneTransitoire(message) || /503|impossible|indisponible/i.test(message), message).toBe(true);
      tenus.add("modele_indisponible");
    } finally {
      vi.unstubAllGlobals();
      if (!ancienne) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = ancienne;
    }
  }, 60_000);

  it("15. événements dans le DÉSORDRE : le plus récent gagne, et l'ancien n'écrase jamais le neuf", async () => {
    // Un webhook rejoué, un relais lent, deux sources qui se doublent : les faits n'arrivent
    // PAS dans l'ordre où ils se sont produits. La règle est celle du §46 — la fraîcheur se lit
    // sur `occurredAt`, l'instant du FAIT, jamais sur `createdAt`, l'instant de l'écriture.
    const t = Date.now();
    const recent = new Date(t - 1 * JOUR);
    const ancien = new Date(t - 9 * JOUR);

    // On INSÈRE le récent en premier, puis l'ancien : l'ordre d'arrivée contredit la chronologie.
    await prisma.businessEvent.create({ data: { type: `${TAG}_STATUT`, sourceDomain: "REGULATORY", entityType: "REGULATORY_PRODUCT", entityId: `${TAG}-p1`, occurredAt: recent, payload: { statut: "AWAITING_ANPP" }, actorId: pdg.id } });
    await prisma.businessEvent.create({ data: { type: `${TAG}_STATUT`, sourceDomain: "REGULATORY", entityType: "REGULATORY_PRODUCT", entityId: `${TAG}-p1`, occurredAt: ancien, payload: { statut: "IN_PREPARATION" }, actorId: pdg.id } });

    const lus = await prisma.businessEvent.findMany({
      where: { type: `${TAG}_STATUT` }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true, payload: true },
    });
    expect(lus).toHaveLength(2);
    // Le plus RÉCENT au sens du fait, quel que soit l'ordre d'insertion.
    expect((lus[0]!.payload as { statut: string }).statut).toBe("AWAITING_ANPP");
    expect(lus[0]!.occurredAt.getTime()).toBeGreaterThan(lus[1]!.occurredAt.getTime());
    // Et RIEN N'EST PERDU : l'ancien reste, il fait partie de l'histoire (§45).
    expect((lus[1]!.payload as { statut: string }).statut).toBe("IN_PREPARATION");
    tenus.add("evenements_desordre");
  }, 60_000);

  it("16. échéance DÉJÀ PASSÉE : le battement la règle une fois, ne la rejoue pas, et ne dort pas dessus", async () => {
    // Le cas se produit à chaque redémarrage après une interruption : des attentes dont la date
    // est passée pendant que personne ne tournait. Elles doivent se régler AU PREMIER battement
    // — pas au suivant, et pas deux fois.
    // Une attente D'ÉVÉNEMENT dont la date butoir est déjà passée : le cas exact d'un
    // redémarrage après interruption. Le battement règle le temps AVANT tout le reste.
    const cerveau = planScripte({
      goal: `Attendre puis conclure ${TAG}`, reasoningComplexity: "A", executionScale: "S",
      acceptanceCriteria: ["[REGLE:AUCUNE_ECRITURE] l'attente est réglée."],
      workstreams: [], expectedArtifacts: [], approvalStrategy: "BUNDLE",
      completionCriteria: "[REGLE:AUCUNE_ECRITURE] l'attente est réglée.", gaps: [], rationale: "banc chaos",
      steps: [
        { key: "attente", title: "Attendre une confirmation", nodeType: "WAIT_EVENT", waitEvent: "MESSAGE_RECEIVED", waitFrom: `Personne ${TAG}`, waitUntil: new Date(Date.now() + 3 * JOUR).toISOString(), dependsOn: [], completionCondition: "réponse reçue" },
        { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["attente"], completionCondition: "fini" },
      ],
    });
    const r = await lancerMission(pdg, `Attends trois jours puis conclus ${TAG}.`, {
      reasoner: new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: cerveau }))]),
      sansEnquete: true, lectureSeule: true, demarrer: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    // On fait passer l'échéance DANS LE PASSÉ — comme si le processus avait dormi quatre jours.
    // Ce que l'étape attend vit dans `waitFor` ({ type, from, entity, until }) : on remonte la
    // date de butoir sans rien inventer d'autre.
    const etape = await prisma.missionStep.findFirst({ where: { missionId: r.missionId, key: "attente" }, select: { id: true, waitFor: true } });
    expect(etape, "l'étape d'attente n'existe pas").toBeTruthy();
    await prisma.missionStep.update({
      where: { id: etape!.id },
      data: {
        status: "WAITING",
        waitFor: { ...(etape!.waitFor as Record<string, unknown>), until: new Date(Date.now() - 4 * JOUR).toISOString() },
      },
    });
    const premier = await balayerMissions();
    expect(premier.examinees).toBeGreaterThanOrEqual(1);
    const apres = await prisma.missionStep.findFirst({ where: { missionId: r.missionId, key: "attente" }, select: { status: true } });
    // Réglée au PREMIER battement : elle n'attend plus. Le moteur choisit sa suite (reprise,
    // relance, échec dit) ; ce qui compte ici est qu'elle ne dorme pas indéfiniment dessus.
    expect(apres?.status, "l'attente expirée dort encore").not.toBe("WAITING");

    /**
     * ET LE BATTEMENT SUIVANT NE LA REJOUE PAS.
     *
     * On compte les RÉVEILS D'ÉCHÉANCE (`TIME_WAKE`), pas tous les événements de la mission.
     * La première version comptait tout et tolérait « au plus trois » ; elle est tombée sous
     * charge (neuf événements) alors que le moteur se comportait parfaitement : entre les deux
     * battements, la mission avait simplement AVANCÉ, et chaque avancée écrit son
     * `STATE_CHANGED`. Compter le progrès pour détecter un rejeu confond ce qui marche avec ce
     * qui se dédouble — et un test qui tombe quand tout va bien finit par être ignoré.
     *
     * Le nouveau compte est à la fois plus JUSTE et plus STRICT : zéro réveil supplémentaire,
     * là où l'ancien en tolérait trois de n'importe quelle sorte.
     */
    const reveils = () => prisma.missionEvent.count({ where: { missionId: r.missionId, kind: "TIME_WAKE" } });
    const avantSecond = await reveils();
    await balayerMissions();
    expect(await reveils() - avantSecond, "l'échéance a été rejouée").toBe(0);
    tenus.add("echeance_expiree");
  }, 120_000);

  it("17. DES DIZAINES de missions en même temps : rien n'est perdu, rien n'est dupliqué, aucun spam", async () => {
    // Trente missions lancées d'affilée. Ce qu'on vérifie n'est pas la vitesse : c'est que
    // chacune existe UNE fois, avec SON objectif, et qu'aucune n'a hérité de l'état d'une autre.
    const N = 30;
    const cerveau = (i: number) => planScripte({
      goal: `Objectif ${i} de ${TAG}`, reasoningComplexity: "A", executionScale: "S",
      acceptanceCriteria: ["[REGLE:AUCUNE_ECRITURE] la liste est rendue."],
      workstreams: [], expectedArtifacts: [], approvalStrategy: "BUNDLE",
      completionCriteria: "[REGLE:AUCUNE_ECRITURE] la liste est rendue.", gaps: [], rationale: "banc chaos",
      steps: [
        { key: "liste", title: `Lister ${i}`, nodeType: "CAPABILITY", capability: "directory_list", inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "5" }], dependsOn: [], completionCondition: "la liste est rendue" },
        { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["liste"], completionCondition: "fini" },
      ],
    });

    const lancees = await Promise.all(
      Array.from({ length: N }, (_, i) => lancerMission(pdg, `Mission simultanée ${i} — ${TAG}`, {
        reasoner: new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: cerveau(i) }))]),
        sansEnquete: true, lectureSeule: true, demarrer: false,
      }).catch((e) => ({ ok: false as const, error: String(e) }))),
    );

    const ok = lancees.filter((x): x is Extract<typeof x, { ok: true }> => x.ok);
    // RIEN N'EST PERDU : toutes ont abouti à une mission en base.
    expect(ok.length, `${N - ok.length} mission(s) perdues`).toBe(N);

    // RIEN N'EST DUPLIQUÉ : autant de missions distinctes que d'identifiants rendus.
    const ids = new Set(ok.map((x) => x.missionId));
    expect(ids.size).toBe(N);
    const enBase = await prisma.mission.count({ where: { id: { in: [...ids] } } });
    expect(enBase).toBe(N);

    // RIEN N'EST MÉLANGÉ : chaque mission porte SON objectif, pas celui d'une voisine.
    const lignes = await prisma.mission.findMany({ where: { id: { in: [...ids] } }, select: { id: true, goalRaw: true } });
    const numeros = new Set(lignes.map((l) => /simultanée (\d+)/.exec(l.goalRaw ?? "")?.[1]).filter(Boolean));
    expect(numeros.size, "deux missions partagent le même objectif").toBe(N);

    // PAS DE SPAM : trente missions ne produisent pas trente notifications au dirigeant. Le
    // silence est la conduite par défaut (§14) ; ce qui mérite l'attention le dit lui-même.
    const notifs = await prisma.notification.count({ where: { userId: pdg.id, createdAt: { gte: new Date(Date.now() - 60_000) } } });
    expect(notifs, `${notifs} notifications pour ${N} missions : c'est du spam`).toBeLessThan(N);
    tenus.add("missions_simultanees");
  }, 180_000);

  it("le compte : 17 sabotages tenus sur 17", () => {
    expect([...tenus].sort()).toHaveLength(SABOTAGES);
    consignerMesure("chaos_tenu", { n: SABOTAGES, ok: tenus.size },
      "platform/in-process/evals/sabotages.test.ts",
      `${tenus.size}/${SABOTAGES} situations adverses tenues, dont désordre des événements, échéance expirée et 30 missions simultanées`);
  });
});
