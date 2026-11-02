import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { attentesDeMission, centreDeMissions, journalDeMission } from "./control";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE MISSIONS DIT LA VÉRITÉ, ET LA DIT AU BON GRAIN.
 *
 * Le piège de cet écran est le COMPTE — le même qu'à la page d'une mission, mais sur vingt
 * missions à la fois et sans les charger. Trois défauts sont possibles et coûteux :
 *
 *   • compter un MODÈLE d'éventail pour un : « 2/2 » sur une mission de trente-trois envois ;
 *   • compter les étapes d'un plan PÉRIMÉ : le dénominateur enfle et l'avancement recule ;
 *   • afficher les étapes du sous-plan courant comme l'avancement d'une mission LONGUE :
 *     « presque fini » sur une mission qui a six jalons devant elle (§118.40).
 *
 * Ces tests partent de la BASE, avec de vraies lignes — une vue construite sur un objet injecté
 * prouverait que la fonction sait lire ce qu'on lui donne, ce qui n'a jamais été la question.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__centre__${Date.now()}`;
const creees: string[] = [];

/**
 * LE PROPRIÉTAIRE DU BANC, À LUI. Emprunter « le premier utilisateur venu » rendait le banc instable
 * sous la suite complète : un autre fichier, en parallèle, supprime ses propres comptes — dont celui
 * qu'on venait d'emprunter (clé étrangère `Mission_ownerId_fkey` violée, aucun défaut du produit).
 */
let proprietaireDuBanc: Promise<string> | null = null;
function proprietaire(): Promise<string> {
  proprietaireDuBanc ??= prisma.user
    .create({ data: { name: TAG, email: `${TAG}@t.dz`, passwordHash: "x" }, select: { id: true } })
    .then((u) => u.id);
  return proprietaireDuBanc;
}

async function mission(
  ownerId: string,
  over: Partial<{ status: string; priority: number; title: string; replanBloque: boolean }> = {},
): Promise<string> {
  const m = await prisma.mission.create({
    data: {
      kind: "RUNTIME", title: over.title ?? TAG, objective: TAG, goalRaw: TAG,
      ownerId, status: (over.status ?? "RUNNING") as never, acceptance: [] as never,
      priority: over.priority ?? 0, replanBloque: over.replanBloque ?? false,
    },
    select: { id: true },
  });
  creees.push(m.id);
  return m.id;
}

async function etape(
  missionId: string,
  key: string,
  over: Partial<{ status: string; nodeType: string; supersededAt: Date; title: string; waitFor: unknown }> = {},
) {
  await prisma.missionStep.create({
    data: {
      missionId, key, title: over.title ?? key,
      nodeType: over.nodeType ?? "CAPABILITY",
      capability: over.nodeType && over.nodeType !== "CAPABILITY" ? null : "directory_list",
      status: over.status ?? "PENDING",
      supersededAt: over.supersededAt ?? null,
      waitFor: (over.waitFor ?? null) as never,
    },
  });
}

suite("le parc de missions", () => {
  afterAll(async () => {
    if (creees.length > 0) await prisma.mission.deleteMany({ where: { id: { in: creees } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: `${TAG}@t.dz` } }).catch(() => {});
    proprietaireDuBanc = null;
  });

  it("compte les étapes RÉELLES : un modèle d'éventail ne vaut pas un, ce sont ses filles qui comptent", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-eventail` });
    await etape(id, "envoi", { status: "DONE" });                 // le MODÈLE
    await etape(id, "envoi#a", { status: "DONE" });
    await etape(id, "envoi#b", { status: "DONE" });
    await etape(id, "envoi#c", { status: "FAILED" });
    await etape(id, "consolider", { status: "PENDING" });

    const c = await centreDeMissions(owner, { limite: 200 });
    const ligne = c.vivantes.find((l) => l.id === id);
    /**
     * CE QUI FERAIT TOMBER CE TEST : compter le modèle. On lirait « 2/2 » — donc « tout est
     * fait » — sur une mission où un envoi n'est jamais parti.
     */
    expect(ligne?.etapes).toEqual({ total: 4, faites: 2, echouees: 1 });
  });

  it("les étapes CONTOURNÉES par le plan courant sortent du dénominateur", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-contourne` });
    await etape(id, "a", { status: "DONE" });
    await etape(id, "b", { status: "PENDING", supersededAt: new Date() });
    await etape(id, "c", { status: "PENDING", supersededAt: new Date() });

    const c = await centreDeMissions(owner, { limite: 200 });
    const ligne = c.vivantes.find((l) => l.id === id);
    /**
     * CE QUI FERAIT TOMBER CE TEST : garder les étapes d'un plan périmé. La mission afficherait
     * 1/3 alors que le plan courant n'a qu'une étape et qu'elle est faite — l'avancement
     * RECULERAIT à chaque replanification, ce qui est exactement l'inverse de la vérité.
     */
    expect(ligne?.etapes).toEqual({ total: 1, faites: 1, echouees: 0 });
  });

  it("une mission à JALONS rend son avancement en jalons, pas en étapes du sous-plan", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-jalons` });
    for (const [i, statut] of ["DONE", "ACTIVE", "PENDING", "PENDING"].entries()) {
      await prisma.missionMilestone.create({
        data: { missionId: id, ordre: i + 1, titre: `j${i + 1}`, resultat: `r${i + 1}`, statut },
      });
    }
    await etape(id, "e1", { status: "DONE" });
    await etape(id, "e2", { status: "DONE" });

    const c = await centreDeMissions(owner, { limite: 200 });
    const ligne = c.vivantes.find((l) => l.id === id);
    expect(ligne?.jalons).toEqual({ franchis: 1, aboutis: 1, ecartes: 0, total: 4, part: 0.25, bloques: 0 });
    // Les étapes restent lisibles — mais ce sont celles du jalon COURANT, et l'écran le dit.
    expect(ligne?.etapes.faites).toBe(2);
  });

  it("un jalon ANNULÉ sort du dénominateur, un jalon ÉCARTÉ compte comme FRANCHI sans être abouti", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-annules` });
    for (const [i, statut] of ["DONE", "SKIPPED", "CANCELLED"].entries()) {
      await prisma.missionMilestone.create({
        data: { missionId: id, ordre: i + 1, titre: `j${i + 1}`, resultat: `r${i + 1}`, statut },
      });
    }
    const c = await centreDeMissions(owner, { limite: 200 });
    const ligne = c.vivantes.find((l) => l.id === id);
    /**
     * ÉCARTÉ n'est pas ANNULÉ. Le premier a été jugé sans objet par le plan — il compte comme
     * franchi. Le second a été retiré par une personne — il ne compte ni au numérateur ni au
     * dénominateur, sans quoi arrêter la moitié d'une mission ferait chuter son avancement.
     */
    expect(ligne?.jalons).toEqual({ franchis: 2, aboutis: 1, ecartes: 1, total: 3, part: 1, bloques: 0 });
  });

  it("ce qui ATTEND UNE PERSONNE passe devant tout le reste", async () => {
    const owner = await proprietaire();
    const calme = await mission(owner, { title: `${TAG}-calme` });
    await etape(calme, "x", { status: "RUNNING" });
    const bloquee = await mission(owner, { title: `${TAG}-bloquee`, status: "BLOCKED" });
    const attend = await mission(owner, { title: `${TAG}-attend` });
    await etape(attend, "acc", { status: "WAITING", nodeType: "APPROVAL", title: "Autoriser l'envoi" });

    const c = await centreDeMissions(owner, { limite: 200 });
    const rangs = c.vivantes.map((l) => l.id);
    /**
     * CE QUI FERAIT TOMBER CE TEST : un tri par date. Il mettrait en haut ce qui vient de bouger
     * TOUT SEUL — c'est-à-dire précisément ce dont personne n'a besoin de s'occuper — et
     * l'accord attendu depuis six jours se découvrirait en cherchant autre chose.
     */
    expect(rangs.indexOf(attend)).toBeLessThan(rangs.indexOf(bloquee));
    expect(rangs.indexOf(bloquee)).toBeLessThan(rangs.indexOf(calme));

    const ligne = c.vivantes.find((l) => l.id === attend);
    expect(ligne?.attend).toBe("ACCORD");
    expect(ligne?.attendQuoi).toBe("Autoriser l'envoi");
  });

  it("une mission dont le refus se répète est BLOQUÉE, même en statut RUNNING", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-replan`, replanBloque: true });
    const c = await centreDeMissions(owner, { limite: 200 });
    /**
     * `replanBloque` veut dire « un tour de plus rendrait la même réponse, plus chère ». La
     * mission est RUNNING en base et n'avancera pourtant plus : l'afficher « en cours » ferait
     * attendre pour rien (§118.42).
     */
    expect(c.vivantes.find((l) => l.id === id)?.bloquee).toBe(true);
  });

  it("les compteurs comptent TOUT, même ce que la limite n'affiche pas", async () => {
    const owner = await proprietaire();
    const a = await mission(owner, { title: `${TAG}-c1` });
    await etape(a, "acc", { status: "WAITING", nodeType: "APPROVAL" });
    const b = await mission(owner, { title: `${TAG}-c2` });
    await etape(b, "acc", { status: "WAITING", nodeType: "WAIT_INPUT" });

    const c = await centreDeMissions(owner, { limite: 1 });
    expect(c.vivantes).toHaveLength(1);
    /**
     * CE QUI FERAIT TOMBER CE TEST : compter sur la liste TRONQUÉE. « 1 en attente de vous »
     * alors qu'il y en a deux : le bandeau deviendrait faux le jour où le parc dépasse la
     * limite d'affichage, c'est-à-dire le jour où il compte vraiment.
     */
    expect(c.compteurs.attendentVous).toBeGreaterThanOrEqual(2);
  });

  it("les missions TERMINÉES sortent de la liste vivante sans disparaître", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-finie`, status: "COMPLETED" });
    const c = await centreDeMissions(owner, { limite: 200, closes: 50 });
    expect(c.vivantes.some((l) => l.id === id)).toBe(false);
    expect(c.closes.some((l) => l.id === id)).toBe(true);
  });

  it("le parc d'une personne ne contient QUE ses missions", async () => {
    const owner = await proprietaire();
    const autre = await prisma.user.findFirst({ where: { id: { not: owner } }, select: { id: true } });
    if (!autre) return;
    const id = await mission(owner, { title: `${TAG}-mienne` });
    const c = await centreDeMissions(autre.id, { limite: 200 });
    expect(c.vivantes.some((l) => l.id === id)).toBe(false);
    expect(c.closes.some((l) => l.id === id)).toBe(false);
  });
});

suite("le journal et les attentes", () => {
  afterAll(async () => {
    if (creees.length > 0) await prisma.mission.deleteMany({ where: { id: { in: creees } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: `${TAG}@t.dz` } }).catch(() => {});
    proprietaireDuBanc = null;
  });

  it("le journal ÉCARTE la comptabilité du moteur et DIT combien", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-journal` });
    for (let i = 0; i < 30; i++) {
      await prisma.missionEvent.create({
        data: { missionId: id, kind: "STATE_CHANGED", summary: "le moteur prend la main" },
      });
    }
    await prisma.missionEvent.create({
      data: { missionId: id, kind: "GAP_DECLARED", summary: "aucun modèle de bon de commande approuvé" },
    });

    const j = await journalDeMission(id, owner);
    /**
     * CE QUI FERAIT TOMBER CE TEST : afficher le journal brut. Trente lignes « le moteur prend
     * la main » noieraient la seule qui explique où la mission en est — et sur une vraie
     * mission ce n'est pas trente, c'est huit mille sept cent cinquante et une.
     */
    expect(j?.lignes.map((l) => l.genre)).toEqual(["GAP_DECLARED"]);
    expect(j?.lignes[0].gravite).toBe("probleme");
    expect(j?.bruitEcarte).toBe(30);
  });

  it("un genre INCONNU s'affiche — un filtre dont le défaut est « cacher » rend muet ce que le moteur apprendra à dire", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-inconnu` });
    await prisma.missionEvent.create({
      data: { missionId: id, kind: "GENRE_QUI_NEXISTE_PAS_ENCORE", summary: "quelque chose de neuf" },
    });
    const j = await journalDeMission(id, owner);
    expect(j?.lignes).toHaveLength(1);
    expect(j?.lignes[0].gravite).toBe("fait");
  });

  it("les répétitions CONSÉCUTIVES se replient en une ligne avec leur compte", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-repete` });
    for (let i = 0; i < 3; i++) {
      await prisma.missionEvent.create({
        data: { missionId: id, kind: "STEP_FAILED", summary: "l'annuaire ne répond pas" },
      });
    }
    const j = await journalDeMission(id, owner);
    expect(j?.lignes).toHaveLength(1);
    expect(j?.lignes[0].fois).toBe(3);
  });

  it("le journal d'autrui est INTROUVABLE, pas « vide »", async () => {
    const owner = await proprietaire();
    const autre = await prisma.user.findFirst({ where: { id: { not: owner } }, select: { id: true } });
    if (!autre) return;
    const id = await mission(owner, { title: `${TAG}-prive` });
    expect(await journalDeMission(id, autre.id)).toBeNull();
    expect(await attentesDeMission(id, autre.id)).toBeNull();
  });

  it("TOUTES les attentes ouvertes sont rendues, avec leur nature et de qui", async () => {
    const owner = await proprietaire();
    const id = await mission(owner, { title: `${TAG}-attentes` });
    await etape(id, "acc", { status: "WAITING", nodeType: "APPROVAL", title: "Autoriser" });
    await etape(id, "khaled", {
      status: "WAITING", nodeType: "WAIT_INPUT", title: "Prix de cession",
      waitFor: { type: "INPUT", from: "Khaled" },
    });
    await etape(id, "evt", {
      status: "WAITING", nodeType: "WAIT_EVENT", title: "Dépôt du dossier",
      waitFor: { type: "EVENT", until: "2026-10-01" },
    });
    await etape(id, "faite", { status: "DONE" });

    const a = await attentesDeMission(id, owner);
    /**
     * CE QUI FERAIT TOMBER CE TEST : n'en rendre qu'une, comme `vueMission`. Sur une mission
     * longue, « pourquoi ça n'avance pas ? » deviendrait une devinette alors que la réponse est
     * en base — trois attentes, et la plus ancienne dit laquelle relancer.
     */
    expect(a?.map((x) => x.nature).sort()).toEqual(["ACCORD", "ELEMENT", "EVENEMENT"]);
    expect(a?.find((x) => x.stepKey === "khaled")?.de).toBe("Khaled");
    expect(a?.find((x) => x.stepKey === "evt")?.jusqua).toBe("2026-10-01");
  });
});
