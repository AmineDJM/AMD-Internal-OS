import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { recordEvent } from "@/lib/events/ledger";
import { arreterSurveillance, balayerSurveillances, creerSurveillance, listerSurveillances } from "@/platform/in-process/missions/watch";
import { WATCH_TOOLS } from "@/lib/assistant/watch-tools";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « SURVEILLE CETTE TÂCHE ET PRÉVIENS-MOI SEULEMENT S'IL Y A UN PROBLÈME » — par l'entrée réelle.
 *
 * L'outil crée la surveillance (cible résolue, règles par défaut, mission-support) ; le balayage
 * la relit : une échéance à 2 jours est un problème → UNE notification ; le même problème le
 * lendemain → aucune ; la tâche terminée par le VRAI registre d'événements réveille la
 * surveillance → une information « terminée », la surveillance se ferme, la mission conclut.
 * Rien ne dépend de la mémoire d'un processus : chaque appel repart de la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__watch${Date.now()}`;
let pdg: CurrentUser;
let taskId = "";
let marcheId = "";
const refMarche = `AO ${String(Date.now()).slice(-4)}/77`;
const titreTache = `${TAG} Préparer la réponse ANPP`;

const notifs = () => prisma.notification.findMany({ where: { userId: pdg.id, title: { contains: "Surveillance" } }, orderBy: { createdAt: "asc" }, select: { title: true, body: true, type: true } });

suite("SURVEILLANCE DURABLE — un problème dit une fois, une fin dite une fois, rien entre les deux", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const t = await prisma.task.create({
      data: { title: titreTache, status: "TODO", dueDate: new Date(Date.now() + 2 * 86_400_000), assignedToId: pdg.id, createdById: pdg.id },
      select: { id: true },
    });
    taskId = t.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.adamWatch.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { entityType: "TASK", entityId: taskId } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: taskId } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: TAG }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.emailRecord.deleteMany({ where: { threadId: { startsWith: TAG } } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: marcheId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: pdg.id } }).catch(() => {});
  }, 120_000);

  it("l'outil crée la surveillance : cible résolue par son titre, règles du type, mission-support, état initial relu", async () => {
    const outil = WATCH_TOOLS.find((t) => t.def.name === "watch_entity")!;
    const brut = await outil.run({ reference: titreTache, instruction: `Surveille la tâche « ${titreTache} » et préviens-moi seulement s'il y a un problème.` }, pdg);
    const r = JSON.parse(brut) as { ok: boolean; surveillance: string; mission: string; type: string; regles: string; etatActuel: string };
    expect(r.ok, brut).toBe(true);
    expect(r.type).toBe("TASK");
    expect(r.regles).toMatch(/échéance à moins de 3 jours/);
    expect(r.etatActuel).toMatch(/TODO/);
    const mission = await prisma.mission.findUnique({ where: { id: r.mission }, select: { kind: true, status: true, title: true } });
    expect(mission?.kind).toBe("WATCH");
    expect(mission?.status).toBe("WAITING_EVENT");
    expect(mission?.title).toMatch(/^Surveillance — /);
    // La création n'a PAS notifié : rien ne se passe tant que tout va bien.
    expect(await notifs()).toHaveLength(0);
    // Une seconde création sur la même cible COMPLÈTE la première au lieu de la doubler.
    const bis = JSON.parse(await outil.run({ reference: titreTache }, pdg)) as { surveillance: string };
    expect(bis.surveillance).toBe(r.surveillance);
    expect(await prisma.adamWatch.count({ where: { ownerId: pdg.id, status: "ACTIVE" } })).toBe(1);
  }, 120_000);

  it("le balayage signale l'échéance proche UNE fois ; le lendemain, le même problème se tait", async () => {
    // La surveillance vient d'être créée : son prochain contrôle est dans 24 h. Le fait qui l'a
    // mise à jour (la seconde création) l'a ramené à maintenant — on balaie.
    const r1 = await balayerSurveillances(new Date());
    expect(r1.examinees).toBeGreaterThanOrEqual(1);
    expect(r1.signalees).toBe(1);
    const n1 = await notifs();
    expect(n1).toHaveLength(1);
    expect(n1[0].title).toMatch(/^Surveillance — /);
    expect(n1[0].body).toMatch(/échéance dans 2 jour/);
    expect(n1[0].body).toMatch(/Recommandation/);

    // Le lendemain : le problème est le MÊME (signature stable) → rien.
    const demain = new Date(Date.now() + 25 * 3_600_000);
    const r2 = await balayerSurveillances(demain);
    expect(r2.examinees).toBeGreaterThanOrEqual(1);
    expect(r2.signalees).toBe(0);
    expect(await notifs()).toHaveLength(1);

    const w = await prisma.adamWatch.findFirst({ where: { ownerId: pdg.id }, select: { lastSignature: true, nextCheckAt: true } });
    expect(w?.lastSignature).toBeTruthy();
    expect(w!.nextCheckAt.getTime()).toBeGreaterThan(demain.getTime());
  }, 120_000);

  it("la tâche terminée par le VRAI registre réveille la surveillance : une information « terminée », et la surveillance se ferme", async () => {
    await prisma.task.update({ where: { id: taskId }, data: { status: "DONE", completedAt: new Date() } });
    // LE FAIT — c'est lui qui réveille (« changement ERP → réveil »), pas un appel direct.
    await recordEvent({ type: "TASK_COMPLETED", sourceDomain: "tasks", entityType: "TASK", entityId: taskId, actorId: pdg.id } as never);
    const w = await prisma.adamWatch.findFirst({ where: { ownerId: pdg.id }, select: { id: true, nextCheckAt: true, missionId: true } });
    expect(w!.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());

    const r = await balayerSurveillances(new Date());
    expect(r.terminees).toBe(1);
    const n = await notifs();
    expect(n).toHaveLength(2);
    expect(n[1].title).toMatch(/^Surveillance terminée — /);
    expect(n[1].body).toMatch(/DONE/);
    const apres = await prisma.adamWatch.findUnique({ where: { id: w!.id }, select: { status: true, closeReason: true } });
    expect(apres?.status).toBe("CLOSED");
    expect(apres?.closeReason).toMatch(/terminée/);
    expect((await prisma.mission.findUnique({ where: { id: w!.missionId }, select: { status: true } }))?.status).toBe("COMPLETED");
    // Le journal de la mission-support dit toute l'histoire.
    const kinds = (await prisma.missionEvent.findMany({ where: { missionId: w!.missionId }, select: { kind: true } })).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["WATCH_CREATED", "WATCH_CHECKED", "NOTIFIED", "WATCH_ENDED"]));
    expect(await listerSurveillances(pdg)).toHaveLength(0);
  }, 120_000);

  /**
   * ── UN CRITÈRE N'EST PAS UNE CIBLE, ET LE REFUS DOIT DIRE LE RECOURS (§118.19) ────────
   *
   * MESURÉ sur le banc d'autonomie : « Surveille les dossiers dont l'échéance tombe dans les
   * soixante jours et préviens-moi seulement si l'un d'eux devient vraiment dangereux. » Le
   * plan a passé la PHRASE comme `reference`. Aucune fiche ne s'appelle ainsi : refus, et le
   * refus ne disait que ce qu'il avait cherché. La mission est morte sur une demande
   * parfaitement réalisable — il suffisait de lister d'abord, puis de surveiller chaque fiche.
   */
  it("un CRITÈRE au lieu d'une cible : le refus nomme le recours — lister, puis une surveillance par fiche", async () => {
    const r = await creerSurveillance(pdg, {
      reference: "Dossiers réglementaires dont l'échéance tombe dans les 60 jours à compter du 08/09/2026",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.raison).toContain("UNE cible");
    expect(r.raison).toContain("éventail");
    // ET LE CAS QUI LE FAIT TOMBER : une cible AMBIGUË ne reçoit pas ce conseil, elle reçoit
    // ses candidats — un conseil hors sujet ferait chercher une liste là où il faut choisir.
    const ambigu = await creerSurveillance(pdg, { reference: `${TAG} Relire` });
    if (!ambigu.ok && ambigu.candidats.length > 0) expect(ambigu.raison).not.toContain("éventail");
  }, 60_000);

  it("arrêter : la sienne seulement, et la mission-support est annulée", async () => {
    const r = await creerSurveillance(pdg, { reference: titreTache });
    // La tâche est DONE : elle n'est plus « ouverte », donc introuvable par titre — le refus est dit.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toMatch(/rien à surveiller/);
    const autre = await prisma.user.create({ data: { name: `${TAG} autre`, email: `${TAG}autre@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    const t2 = await prisma.task.create({ data: { title: `${TAG} Relire le contrat`, status: "TODO", assignedToId: pdg.id, createdById: pdg.id }, select: { id: true } });
    const c = await creerSurveillance(pdg, { reference: `${TAG} Relire le contrat` });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const intrus: CurrentUser = { ...pdg, id: autre.id };
    expect((await arreterSurveillance(intrus, c.id)).ok).toBe(false);
    expect((await arreterSurveillance(pdg, c.id)).ok).toBe(true);
    expect((await prisma.mission.findUnique({ where: { id: c.missionId }, select: { status: true } }))?.status).toBe("CANCELLED");
    await prisma.task.deleteMany({ where: { id: t2.id } });
    await prisma.user.deleteMany({ where: { id: autre.id } });
  }, 120_000);
  it("un APPEL D'OFFRES se surveille : « PCH 9999/77 », « AO 9999-77 » désignent le même marché, l'échéance est le dépôt, les règles sont celles du type", async () => {
    const m = await prisma.pchTender.create({
      data: { reference: refMarche, title: `${TAG} — oncologie`, status: "IN_PROGRESS", submissionDeadline: new Date(Date.now() + 5 * 86_400_000) },
      select: { id: true },
    });
    marcheId = m.id;
    const dit = refMarche.replace("AO ", "appel d'offres PCH ").replace("/", "-");
    const r = await creerSurveillance(pdg, { reference: dit, instruction: `Surveille l'${dit} et préviens-moi seulement s'il y a un problème.` });
    expect(r.ok, r.ok ? "" : r.raison).toBe(true);
    if (!r.ok) return;
    expect(r.cible.type).toBe("PCH_TENDER");
    expect(r.cible.exact).toBe(true);
    expect(r.cible.ref).toBe(refMarche);
    expect(r.etat.statut).toBe("IN_PROGRESS");
    expect(r.etat.echeance).toBeTruthy();
    expect(r.reglesTexte).toMatch(/échéance à moins de 7 jours/);
    // Une référence qui ne désigne aucun marché ne trouve rien — jamais « le plus proche ».
    const rien = await creerSurveillance(pdg, { reference: "appel d'offres PCH 1234/99" });
    expect(rien.ok).toBe(false);
  }, 120_000);


  // ── MANDAT 4 §28 : contrat, enveloppe, document attendu, réponse e-mail, redémarrage ──
  const echue = async (id: string) => prisma.adamWatch.update({ where: { id }, data: { nextCheckAt: new Date(Date.now() - 60_000) } });
  const ligne = async (id: string) => prisma.adamWatch.findUnique({ where: { id }, select: { status: true, closeReason: true, lastSignature: true, lastState: true, lastCheckedAt: true, nextCheckAt: true } });
  const dernierJournal = async (missionId: string) => (await prisma.missionEvent.findMany({ where: { missionId }, orderBy: { at: "desc" }, take: 3, select: { summary: true } })).map((j) => j.summary).join(" ");

  it("un CONTRAT se surveille par son titre : l'échéance à 20 j est dite une fois ; renouvelé, la fin est dite et la surveillance close", async () => {
    const titre = `${TAG} Contrat de distribution Sofradis`;
    const doc = await prisma.legalDocument.create({ data: { title: titre, kind: "CONTRACT", status: "ACTIVE", counterparty: "Sofradis", endDate: new Date(Date.now() + 20 * 86_400_000), createdById: pdg.id } });
    const r = await creerSurveillance(pdg, { reference: titre });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cible.type).toBe("LEGAL_DOCUMENT");
    expect(r.reglesTexte).toMatch(/échéance à moins de 30 jours/);
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l1 = await ligne(r.id);
    expect(l1?.lastSignature).toBeTruthy();
    expect(await dernierJournal(r.missionId)).toMatch(/échéance dans (19|20) jour/);
    // Le lendemain, même problème : rien de nouveau n'est dit.
    await echue(r.id);
    const avant = (await notifs()).length;
    await balayerSurveillances(new Date(), { max: 200 });
    expect((await notifs()).length).toBe(avant);
    await prisma.legalDocument.update({ where: { id: doc.id }, data: { status: "RENEWED" } });
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l2 = await ligne(r.id);
    expect(l2?.status).toBe("CLOSED");
    expect(l2?.closeReason).toMatch(/RENEWED/);
  }, 60_000);

  it("une ENVELOPPE budgétaire à 85 % : le seuil de 80 % (règle VALEUR) est dit, avec le calcul du rythme", async () => {
    const nom = `${TAG} Marketing`;
    const env = await prisma.budgetEnvelope.create({
      data: { name: nom, periodStart: new Date(Date.now() - 30 * 86_400_000), periodEnd: new Date(Date.now() + 335 * 86_400_000), totalAmount: 100_000, isActive: true, categories: { create: [{ name: "Stands", allocated: 100_000 }] } },
      include: { categories: true },
    });
    await prisma.financeTransaction.create({ data: { reference: `${TAG}-FIN-1`, direction: "OUT", category: "EVENEMENT", label: "Stand congrès", amount: 85_000, status: "SETTLED", date: new Date(Date.now() - 5 * 86_400_000), budgetCategoryId: env.categories[0].id, createdById: pdg.id } });
    const r = await creerSurveillance(pdg, { reference: nom });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cible.type).toBe("BUDGET_ENVELOPE");
    expect(r.etat.champs?.consommePct).toBe(85);
    expect(String(r.etat.champs?.calcul)).toMatch(/85 % consommé/);
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l = await ligne(r.id);
    expect(l?.lastSignature).toBeTruthy();
    expect(await dernierJournal(r.missionId)).toMatch(/consommePct/);
    expect(l?.status).toBe("ACTIVE");
  }, 60_000);

  it("un DOCUMENT ATTENDU dans un dossier : rien tant qu'il n'est pas là ; quand il arrive, une information et la surveillance se clôt", async () => {
    const dossier = await prisma.driveNode.create({ data: { name: `${TAG} Dossier ANPP`, type: "FOLDER", ownerId: pdg.id, createdById: pdg.id } });
    const r = await creerSurveillance(pdg, { reference: "CPP Nivolex", attendu: { motif: "CPP Nivolex", dossier: `${TAG} Dossier ANPP` } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cible).toMatchObject({ type: "DRIVE_ATTENDU", id: dossier.id, ref: "CPP Nivolex" });
    expect(r.etat.statut).toBe("ABSENT");
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    expect((await ligne(r.id))?.lastSignature).toBeNull(); // absent depuis moins de 7 jours : silence
    await prisma.driveNode.create({ data: { name: `${TAG} CPP Nivolex 10mg.pdf`, type: "FILE", parentId: dossier.id, ownerId: pdg.id, createdById: pdg.id, size: 10, mimeType: "application/pdf" } });
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l = await ligne(r.id);
    expect(l?.status).toBe("CLOSED");
    expect(l?.closeReason).toMatch(/PRESENT/);
    expect((l?.lastState as { champs?: { fichier?: string } })?.champs?.fichier).toMatch(/CPP Nivolex 10mg/);
  }, 60_000);

  it("une RÉPONSE E-MAIL attendue : six jours de silence valent relance ; la réponse arrive → close — et seule la boîte de la personne est lue", async () => {
    const cx = await prisma.googleConnection.create({ data: { userId: pdg.id, address: `${TAG}@amd.dz` } });
    const fil = `${TAG}-thread`;
    const sujet = `${TAG} Contrat Sofradis — signature`;
    await prisma.emailRecord.create({ data: { connectionId: cx.id, providerMessageId: `${TAG}-m1`, threadId: fil, direction: "OUTBOUND", fromAddress: `${TAG}@amd.dz`, toAddresses: ["sarah@sofradis.dz"], subject: sujet, sentAt: new Date(Date.now() - 6 * 86_400_000) } });
    const r = await creerSurveillance(pdg, { reference: sujet });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cible.type).toBe("EMAIL_THREAD");
    expect(r.etat.statut).toBe("SANS_REPONSE");
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l1 = await ligne(r.id);
    expect(l1?.lastSignature).toBeTruthy();
    expect(await dernierJournal(r.missionId)).toMatch(/aucun changement depuis 6 jour/);
    await prisma.emailRecord.create({ data: { connectionId: cx.id, providerMessageId: `${TAG}-m2`, threadId: fil, direction: "INBOUND", fromAddress: "sarah@sofradis.dz", fromName: "Sarah B.", toAddresses: [`${TAG}@amd.dz`], subject: `Re: ${sujet}`, sentAt: new Date() } });
    await echue(r.id);
    await balayerSurveillances(new Date(), { max: 200 });
    const l2 = await ligne(r.id);
    expect(l2?.status).toBe("CLOSED");
    expect(l2?.closeReason).toMatch(/REPONDU/);
    // Une autre personne ne peut pas cibler ce fil : il n'est pas dans sa boîte.
    const autre = await prisma.user.create({ data: { name: `${TAG} autre`, email: `${TAG}autre@amd.dz`, passwordHash: "x", role: "DIRECTION" }, select: { id: true, name: true, email: true, role: true } });
    const autreUser: CurrentUser = { id: autre.id, name: autre.name, email: autre.email, role: autre.role, access: (await getAccess(autre.id, autre.role)) as EffectiveAccess, mustChangePassword: false };
    const r2 = await creerSurveillance(autreUser, { reference: sujet });
    expect(r2.ok).toBe(false);
    await prisma.user.delete({ where: { id: autre.id } }).catch(() => {});
  }, 60_000);

  it("après REDÉMARRAGE : 100 % des surveillances dues sont relues par le premier balayage, aucune deux fois", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await prisma.task.create({ data: { title: `${TAG} tâche redémarrage ${i}`, status: "TODO", dueDate: new Date(Date.now() + 10 * 86_400_000), assignedToId: pdg.id, createdById: pdg.id }, select: { id: true } });
      const r = await creerSurveillance(pdg, { reference: `${TAG} tâche redémarrage ${i}` });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) ids.push(r.id);
      void t;
    }
    // « Redémarrage » : rien n'est en mémoire — la seule vérité est la ligne durable et son
    // `nextCheckAt`. On les rend toutes dues, puis un balayage neuf les relit.
    const t0 = new Date();
    await prisma.adamWatch.updateMany({ where: { id: { in: ids } }, data: { nextCheckAt: new Date(t0.getTime() - 3_600_000) } });
    const bilan = await balayerSurveillances(new Date(), { max: 500 });
    expect(bilan.examinees).toBeGreaterThanOrEqual(ids.length);
    const apres = await prisma.adamWatch.findMany({ where: { id: { in: ids } }, select: { lastCheckedAt: true, nextCheckAt: true, status: true } });
    expect(apres.length).toBe(ids.length);
    consignerMesure("watches_restaures", { n: ids.length, ok: apres.filter((w) => w.status === "ACTIVE" && w.lastCheckedAt !== null && w.lastCheckedAt >= t0).length }, "platform/in-process/missions/watch.test.ts");
    for (const w of apres) { expect(w.lastCheckedAt && w.lastCheckedAt >= t0).toBe(true); expect(w.nextCheckAt > new Date()).toBe(true); expect(w.status).toBe("ACTIVE"); }
    // Le même balayage rejoué (second worker, redéploiement) ne relit aucune des nôtres.
    const avant = new Map(apres.map((w, i) => [ids[i], w.lastCheckedAt?.getTime()]));
    await balayerSurveillances(new Date(), { max: 500 });
    const rejoue = await prisma.adamWatch.findMany({ where: { id: { in: ids } }, select: { id: true, lastCheckedAt: true } });
    for (const w of rejoue) expect(w.lastCheckedAt?.getTime()).toBe(avant.get(w.id) ?? (await ligne(w.id))?.lastCheckedAt?.getTime());
  }, 90_000);
});
