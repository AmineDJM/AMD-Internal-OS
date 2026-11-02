import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { passerLaVeille, type Redacteur } from "./veille";
import { accorderMandat, executerGestesSousMandat, FENETRE_GESTES_MS, revoquerMandat } from "./mandats";
import { donnerRetour, etatDeMaVeille, reglerPreferences, reglerVeilleur, suggestionsDuDossier } from "./service";
import { remplacerConsolePourTests } from "./reglages";
import { effacerJournalDe } from "../testing/journal";

/**
 * J12 — LA PROACTIVITÉ SOUS MANDAT, de bout en bout sur la vraie base : des veilleurs (règles de code) qui
 * constatent une fois, un budget d'interruptions qui regroupe, se tait aux heures calmes et plafonne, un point du
 * matin rédigé (faux rédacteur : aucun appel au modèle), des retours qui ajustent, et des mandats bornés,
 * révocables, journalisés, dont le geste passe par l'action de l'écran.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaveil_${Date.now().toString(36)}_`;
const J = 86_400_000;
/** Mardi 3 novembre 2026, 10 h à Alger (UTC+1). */
const MARDI_10H = new Date("2026-11-03T09:00:00.000Z");
const plus = (ms: number) => new Date(MARDI_10H.getTime() + ms);

let assistante: CurrentUser;
let directeur: CurrentUser;
let curieux: CurrentUser;
const demandes: string[] = [];
let spoId = "";
let budgetId = "";
const textesRediges: string[] = [];
const redacteur: Redacteur = async (_u, faits) => { textesRediges.push(faits); return `Point rédigé : ${faits.split("\n").length} lignes.`; };

async function compte(nom: string, role: CurrentUser["role"], modules: string[]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  for (const module of modules) await prisma.userAccess.create({ data: { userId: u.id, module, canView: true, canCreate: true, canUpdate: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

async function demandeDeValidation(titre: string, depuisJours: number): Promise<string> {
  const quand = plus(-depuisJours * J);
  const id = (await prisma.validationRequest.create({
    data: { reference: `${TAG}VAL-${demandes.length + 1}`, title: `${TAG}${titre}`, module: "ADMIN", requesterId: assistante.id, createdAt: quand, steps: { create: [{ order: 1, validatorId: directeur.id, createdAt: quand }] } },
  })).id;
  demandes.push(id);
  return id;
}

const notifs = (u: CurrentUser, titre?: string) => prisma.notification.count({ where: { userId: u.id, ...(titre ? { title: { contains: titre } } : {}) } });
const signaux = (u: CurrentUser, veilleur?: string) => prisma.assistantSignal.findMany({ where: { userId: u.id, ...(veilleur ? { veilleur } : {}) }, orderBy: { detecteLe: "asc" } });

suite("Assistant IA — proactivité sous mandat (J12)", () => {
  beforeAll(async () => {
    assistante = await compte("assistante", "DIRECTION_ASSISTANT", ["ASSISTANT_IA", "VALIDATIONS", "SPONSORING", "BUDGETS"]);
    directeur = await compte("directeur", "DIRECTION", ["ASSISTANT_IA", "VALIDATIONS"]);
    curieux = await compte("curieux", "VIEWER", ["ASSISTANT_IA"]);
    await demandeDeValidation("Achat de toner", 6);
    spoId = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}CHU Oran`, type: "Congrès", requesterId: assistante.id, createdById: assistante.id, status: "AWAITING_FINAL" } })).id;
    await prisma.$executeRaw`UPDATE "SponsoringRequest" SET "updatedAt" = ${plus(-9 * J)} WHERE id = ${spoId}`;
    budgetId = (await prisma.budgetLine.create({ data: { year: 2026, department: "SPONSORING", label: `${TAG}Congrès`, initialBudget: 1_000_000, consumedBudget: 900_000, futureCommitted: 50_000, ownerId: assistante.id } })).id;
  });
  afterEach(() => { ACTOR = null; remplacerConsolePourTests(null); });
  afterAll(async () => {
    const ids = [assistante?.id, directeur?.id, curieux?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.assistantMandat.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantSignal.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantVeilleur.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantVeille.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: demandes } } }).catch(() => {});
    await prisma.validationStep.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.budgetLine.deleteMany({ where: { id: budgetId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("trois veilleurs constatent ; UNE interruption regroupée ; le passage suivant ne redit rien", async () => {
    // Le point du matin de ce mardi a déjà eu lieu : ce passage de 10 h est une veille ordinaire.
    await prisma.assistantVeille.create({ data: { userId: assistante.id, dernierMatinLe: plus(-2 * 3_600_000) } });
    const b = await passerLaVeille(assistante.id, MARDI_10H, { redacteur });
    expect(b).toMatchObject({ statut: "FAIT", nouveaux: 3, interrompu: 3, matin: false });
    expect((await signaux(assistante)).map((s) => s.veilleur).sort()).toEqual(["ADPRO_DEMANDE_BLOQUEE", "BUDGET_SEUIL", "VALIDATION_EN_ATTENTE"]);
    expect(await notifs(assistante, "3 points de vos veilleurs")).toBe(1);
    const encore = await passerLaVeille(assistante.id, plus(15 * 60_000), { redacteur });
    expect(encore).toMatchObject({ nouveaux: 0, interrompu: 0 });
    expect(await notifs(assistante)).toBe(1);
  });

  it("à l'ouverture du dossier : le constat de CETTE fiche, sans interruption ; rien pour un autre", async () => {
    const s = await suggestionsDuDossier(assistante.id, "SPONSORING", spoId);
    expect(s).toHaveLength(1);
    expect(s[0]!.titre).toContain("SPO-1");
    expect(await suggestionsDuDossier(curieux.id, "SPONSORING", spoId)).toHaveLength(0);
  });

  it("heures calmes : le constat neuf attend ; le point du matin le dit (rédigé), une fois", async () => {
    await demandeDeValidation("Billets Oran", 7);
    const soir = await passerLaVeille(assistante.id, plus(12 * 3_600_000), { redacteur }); // 22 h à Alger
    expect(soir).toMatchObject({ nouveaux: 1, interrompu: 0 });
    expect((await signaux(assistante, "VALIDATION_EN_ATTENTE")).filter((s) => s.etat === "EN_ATTENTE")).toHaveLength(1);
    const matin = await passerLaVeille(assistante.id, plus(22 * 3_600_000), { redacteur }); // mercredi 8 h
    expect(matin).toMatchObject({ matin: true, interrompu: 1 });
    expect(textesRediges.at(-1)).toContain("Billets Oran");
    expect(await notifs(assistante, "Votre point du matin")).toBe(1);
    expect((await signaux(assistante, "VALIDATION_EN_ATTENTE")).filter((s) => s.canal === "MATIN")).toHaveLength(1);
    expect((await passerLaVeille(assistante.id, plus(22.5 * 3_600_000), { redacteur })).matin).toBe(false);
  });

  it("le plafond du jour : au-delà, le journal, sans notification", async () => {
    await reglerPreferences(assistante.id, { interruptionsMax: 1 });
    await demandeDeValidation("Salle de réunion", 8);
    const avant = await notifs(assistante);
    const b = await passerLaVeille(assistante.id, plus(26 * 3_600_000), { redacteur }); // mercredi 12 h : le matin a compté
    expect(b).toMatchObject({ nouveaux: 1, interrompu: 0, journal: 1 });
    expect(await notifs(assistante)).toBe(avant);
    await reglerPreferences(assistante.id, { interruptionsMax: 5 });
  });

  it("« pas utile » trois fois : le veilleur attend plus longtemps et devient discret ; « utile » se compte", async () => {
    const budget = (await signaux(assistante, "BUDGET_SEUIL"))[0]!;
    const [a, b2] = (await signaux(assistante, "VALIDATION_EN_ATTENTE")).slice(0, 2);
    expect((await donnerRetour(assistante.id, budget.id, "UTILE")).ok).toBe(true);
    for (const s of [a!, b2!]) await donnerRetour(assistante.id, s.id, "PAS_UTILE");
    const troisieme = (await signaux(assistante, "VALIDATION_EN_ATTENTE"))[2]!;
    await donnerRetour(assistante.id, troisieme.id, "PAS_UTILE");
    expect((await donnerRetour(curieux.id, troisieme.id, "UTILE")).ok).toBe(false);
    const v = await prisma.assistantVeilleur.findUnique({ where: { userId_code: { userId: assistante.id, code: "VALIDATION_EN_ATTENTE" } } });
    expect(v).toMatchObject({ inutiles: 3, utiles: 0 });
    expect(v!.facteur).toBeCloseTo(1.95, 2);
    const e = await etatDeMaVeille(assistante, plus(26 * 3_600_000));
    expect(e.veilleurs.find((x) => x.code === "VALIDATION_EN_ATTENTE")).toMatchObject({ discret: true, seuilEffectif: 10 });
    expect(e.utilite.phrase).toContain("25 %");
  });

  it("désactiver un veilleur : plus rien de lui", async () => {
    await reglerVeilleur(assistante.id, "BUDGET_SEUIL", { actif: false });
    await prisma.budgetLine.update({ where: { id: budgetId }, data: { consumedBudget: 1_000_000 } });
    expect((await passerLaVeille(assistante.id, plus(27 * 3_600_000), { redacteur })).nouveaux).toBe(0);
    await reglerVeilleur(assistante.id, "BUDGET_SEUIL", { actif: true });
  });

  it("un mandat de relance : borné, fait par l'action de l'écran, une fois par étape, journalisé, révocable", async () => {
    ACTOR = assistante;
    // Le veilleur de validation n'est plus discret pour ce test : on remet ses compteurs.
    await prisma.assistantVeilleur.update({ where: { userId_code: { userId: assistante.id, code: "VALIDATION_EN_ATTENTE" } }, data: { inutiles: 0, facteur: 1 } });
    // Le seuil relevé avait résolu les constats ; revenu à 5 jours, ils se rouvrent (au journal : ils ne sonnent pas deux fois).
    const avantReouverture = await notifs(assistante, "attend");
    await passerLaVeille(assistante.id, plus(27.5 * 3_600_000), { redacteur });
    expect(await notifs(assistante, "attend")).toBe(avantReouverture);
    expect((await signaux(assistante, "VALIDATION_EN_ATTENTE")).filter((s) => s.etat !== "RESOLU")).toHaveLength(3);
    expect((await accorderMandat(assistante, { capacite: "RELANCER_VALIDATEUR", jours: 0 })).ok).toBe(false);
    const m = await accorderMandat(assistante, { capacite: "RELANCER_VALIDATEUR", jours: 30, gestesParJour: 2 }, plus(27 * 3_600_000));
    expect(m.ok && m.mandat.statut).toBe("ACTIF");
    const t = plus(28 * 3_600_000);
    const notifsDirecteur = await notifs(directeur);
    const b = await executerGestesSousMandat(assistante, t);
    expect(b).toMatchObject({ faits: 2, echecs: 0 });
    expect(await notifs(directeur)).toBeGreaterThan(notifsDirecteur);
    const gestes = await prisma.assistantMandatGeste.findMany({ where: { userId: assistante.id } });
    expect(gestes.filter((g) => g.statut === "FAIT")).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { actorId: assistante.id, module: "Assistant IA — mandats", summary: { startsWith: "Geste sous mandat —" } } })).toBe(2);
    // Même fenêtre : rien. Fenêtre suivante, même jour : le plafond de 2 par jour tient, la 3e attend demain.
    expect((await executerGestesSousMandat(assistante, plus(28 * 3_600_000 + 60_000))).raison).toBe("fenêtre déjà prise");
    expect((await executerGestesSousMandat(assistante, new Date(t.getTime() + FENETRE_GESTES_MS + 1))).faits).toBe(0);
    // Le lendemain : la troisième, et jamais une seconde fois les deux premières.
    const lendemain = await executerGestesSousMandat(assistante, plus(48 * 3_600_000));
    expect(lendemain.faits).toBe(1);
    expect(await prisma.assistantMandatGeste.count({ where: { userId: assistante.id, statut: "FAIT" } })).toBe(3);
    // Un autre ne révoque pas ; la personne, si ; révoqué, plus rien ne se fait.
    expect(await revoquerMandat(curieux, m.ok ? m.mandat.id : "")).toBe(false);
    expect(await revoquerMandat(assistante, m.ok ? m.mandat.id : "")).toBe(true);
    await demandeDeValidation("Après révocation", 9);
    await passerLaVeille(assistante.id, plus(49 * 3_600_000), { redacteur });
    expect((await executerGestesSousMandat(assistante, plus(50 * 3_600_000))).raison).toBe("aucun mandat");
  });

  it("le point du matin récapitule ce qui a été fait sous mandat", async () => {
    const b = await passerLaVeille(assistante.id, plus(70 * 3_600_000), { redacteur }); // vendredi 8 h : week-end calme
    expect(b.matin).toBe(false);
    await passerLaVeille(assistante.id, plus(118 * 3_600_000), { redacteur }); // dimanche 8 h, jour ouvré
    // Le point du jeudi (le passage de 10 h) a récapitulé les relances faites mercredi et jeudi.
    expect(textesRediges.some((t) => /FAIT SOUS MANDAT/.test(t) && /Relancer/.test(t)), textesRediges.join("\n----\n")).toBe(true);
  });

  it("des destinataires bornés : un geste vers quelqu'un d'autre est refusé, dit une fois, à l'audit", async () => {
    ACTOR = assistante;
    const m = await accorderMandat(assistante, { capacite: "RELANCER_VALIDATEUR", jours: 10, destinataires: [curieux.id] }, plus(119 * 3_600_000));
    expect(m.ok).toBe(true);
    const b = await executerGestesSousMandat(assistante, plus(120 * 3_600_000));
    expect(b.faits).toBe(0);
    expect(b.refuses).toBeGreaterThanOrEqual(1);
    expect((await prisma.assistantMandatGeste.findFirst({ where: { mandatId: m.ok ? m.mandat.id : "", statut: "REFUSE" } }))?.resume).toContain("destinataire hors du mandat");
    // Échu : il passe EXPIRE, rien ne se fait.
    expect((await executerGestesSousMandat(assistante, plus(140 * 86_400_000))).raison).toBe("aucun mandat");
    expect((await prisma.assistantMandat.findUnique({ where: { id: m.ok ? m.mandat.id : "" } }))?.statut).toBe("EXPIRE");
  });

  it("la console coupe tout ; un assistant fermé ne veille plus", async () => {
    remplacerConsolePourTests({ interruptionsMaxJour: 5, coupee: true });
    expect((await passerLaVeille(assistante.id, plus(121 * 3_600_000), { redacteur })).raison).toBe("proactivité coupée par la console");
    remplacerConsolePourTests(null);
    await prisma.userAccess.deleteMany({ where: { userId: curieux.id, module: "ASSISTANT_IA" } });
    expect((await passerLaVeille(curieux.id, plus(121 * 3_600_000), { redacteur })).raison).toBe("assistant fermé");
  });
});
