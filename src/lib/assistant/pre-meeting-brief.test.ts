import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { EXECUTIVE_BRIEF_TOOLS } from "./executive-brief-tools";

/**
 * PRE-MEETING BRIEF — arriver préparé, à TROIS NIVEAUX (mandat 4 §32) : la réunion + les points
 * OUVERTS avec chaque participant (LIGHT), + les notes et actions de la dernière réunion du même
 * sujet et les décisions liées (STANDARD), + les personnes, décisions à obtenir, engagements en
 * retard, questions ouvertes et suivi (CHIEF OF STAFF). Le niveau est APPRIS par une règle Teach
 * Adam (clé `niveauReunion`), sinon déduit du rôle. Goldens : contenu réel, cloisonnement (jamais
 * la réunion d'un autre), honnêteté quand il n'y a rien, et un niveau léger qui ne LIT pas plus.
 */

const userWith = (id: string, name: string, role: CurrentUser["role"] = "DIRECTION"): CurrentUser => ({
  id, name, email: `${id}@t.dz`, role,
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pmb__${Date.now()}`;
let pdgId = "";
let dafId = "";
let tiersId = "";

const tool = EXECUTIVE_BRIEF_TOOLS.find((t) => t.def.name === "pre_meeting_brief")!;
const brief = async (input: Record<string, unknown>, user: CurrentUser) => JSON.parse(await tool.run(input, user) as string);

suite("pre_meeting_brief — le brief avant réunion à trois niveaux", () => {
  beforeAll(async () => {
    const [pdg, daf, tiers] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Karim PDG`, email: `${TAG}p@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG} Lina DAF`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "DIRECTION", title: "Directrice administrative et financière" } }),
      prisma.user.create({ data: { name: `${TAG} Walid`, email: `${TAG}t@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    pdgId = pdg.id; dafId = daf.id; tiersId = tiers.id;

    // La réunion À VENIR (dans un jour), organisée par le PDG, la DAF invitée.
    await prisma.meeting.create({
      data: {
        title: `${TAG} Point budget T3`,
        description: "Arbitrer l'enveloppe congrès et la caisse d'avance.",
        slug: `${TAG}-slug`, publicToken: `${TAG}-tok`,
        status: "SCHEDULED", scheduledAt: new Date(Date.now() + 86_400_000),
        organizerId: pdg.id,
        participants: { create: [{ userId: daf.id, response: "ACCEPTED" }] },
      },
    });
    // La réunion PRÉCÉDENTE du même sujet, terminée il y a 30 jours : un compte rendu, une action acceptée devenue tâche FAITE.
    const tacheFaite = await prisma.task.create({
      data: { title: `${TAG} Envoyer le tableau des enveloppes`, status: "DONE", createdById: pdg.id, assignedToId: daf.id, completedAt: new Date(Date.now() - 20 * 86_400_000) },
    });
    await prisma.meeting.create({
      data: {
        title: `${TAG} Point budget T2`,
        slug: `${TAG}-slug2`, publicToken: `${TAG}-tok2`,
        status: "ENDED", scheduledAt: new Date(Date.now() - 30 * 86_400_000), endedAt: new Date(Date.now() - 30 * 86_400_000 + 3_600_000),
        organizerId: pdg.id,
        summary: "Décidé : geler la caisse d'avance jusqu'au T3. Action : Lina envoie le tableau des enveloppes.",
        participants: { create: [{ userId: daf.id, response: "ACCEPTED" }] },
        proposals: { create: [{ title: `${TAG} Envoyer le tableau des enveloppes`, status: "ACCEPTED", assigneeId: daf.id, createdTaskId: tacheFaite.id }] },
      },
    });
    await prisma.task.create({
      data: { title: `${TAG} Préparer l'état de la caisse`, status: "IN_PROGRESS", createdById: pdg.id, assignedToId: daf.id },
    });
    await prisma.executiveCommitment.create({
      data: { ownerId: pdg.id, who: `${TAG} Lina DAF`, what: "Envoyer le tableau des enveloppes avant jeudi", status: "OPEN" },
    });
    // Un engagement EN RETARD (échéance passée), suivi par le PDG.
    await prisma.executiveCommitment.create({
      data: { ownerId: pdg.id, who: `${TAG} Lina DAF`, what: "Transmettre le budget révisé congrès", status: "OPEN", dueAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    // Une décision récente liée au sujet.
    await prisma.executiveDecision.create({
      data: { ownerId: pdg.id, title: `${TAG} Geler la caisse d'avance`, decision: "Gel jusqu'au point budget T3", status: "DECIDED", decidedAt: new Date(Date.now() - 29 * 86_400_000) },
    });
    // Une validation qui ATTEND le PDG — une décision à obtenir.
    await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-VAL`, module: "FINANCES", title: `${TAG} Valider l'avance congrès`, requesterId: daf.id,
        steps: { create: [{ order: 1, validatorId: pdg.id }] },
      },
    });
  });
  afterAll(async () => {
    await prisma.adamRule.deleteMany({ where: { ownerId: pdgId } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.executiveDecision.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { who: { startsWith: TAG } } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("STANDARD par défaut pour la direction : la réunion, l'ordre du jour, les points OUVERTS par participant, les notes et actions de la dernière réunion, les décisions liées", async () => {
    const out = await brief({ title: `${TAG} Point budget` }, userWith(pdgId, `${TAG} Karim PDG`));
    expect(out.niveau).toBe("STANDARD");
    expect(out.niveauSource).toMatch(/défaut du rôle/);
    expect(out.reunion.titre).toBe(`${TAG} Point budget T3`);
    expect(out.reunion.ordreDuJour).toContain("enveloppe congrès");
    const lina = out.participants.find((p: { nom: string }) => p.nom.includes("Lina"));
    expect(lina).toBeDefined();
    expect(lina.reponse).toBe("ACCEPTED");
    expect(JSON.stringify(lina.tachesEntreNous)).toContain("Préparer l'état de la caisse");
    expect(JSON.stringify(lina.engagements)).toContain("tableau des enveloppes");
    // La dernière réunion du même sujet : ses notes, son action et le SORT de l'action (la tâche est faite).
    expect(out.derniereReunion.titre).toBe(`${TAG} Point budget T2`);
    expect(out.derniereReunion.notes).toContain("geler la caisse d'avance");
    expect(out.derniereReunion.actions[0]).toMatchObject({ sort: "faite" });
    expect(out.derniereReunion.actions[0].responsable).toContain("Lina");
    expect(out.decisions.map((d: { titre: string }) => d.titre)).toContain(`${TAG} Geler la caisse d'avance`);
    // Le niveau STANDARD ne lit pas ce qui appartient au chef de cabinet.
    expect(out.decisionsAObtenir).toBeUndefined();
    expect(lina.fonction).toBeUndefined();
    expect(out.rappel).toMatch(/rien n'est inventé/);
  });

  it("LIGHT imposé pour ce brief : la réunion et les tâches ouvertes, et RIEN de plus (pas de notes, pas d'engagements)", async () => {
    const out = await brief({ title: `${TAG} Point budget`, niveau: "LIGHT" }, userWith(pdgId, `${TAG} Karim PDG`));
    expect(out.niveau).toBe("LIGHT");
    expect(out.niveauSource).toMatch(/demandé/);
    const lina = out.participants.find((p: { nom: string }) => p.nom.includes("Lina"));
    expect(JSON.stringify(lina.tachesEntreNous)).toContain("Préparer l'état de la caisse");
    expect(lina.engagements).toBeUndefined();
    expect(out.derniereReunion).toBeUndefined();
    expect(out.decisions).toBeUndefined();
    expect(out.contenu).toHaveLength(3);
  });

  it("le niveau APPRIS par une règle Teach Adam (`niveauReunion`) gouverne : CHIEF OF STAFF lit les personnes, les décisions à obtenir, les engagements en retard, les questions ouvertes, le suivi", async () => {
    await prisma.adamRule.create({
      data: {
        kind: "PREFERENCE", scope: "PERSON", ownerId: pdgId, subjectUserId: pdgId, domain: "reunions",
        title: "Niveau du brief de réunion", statement: "Pour mes réunions, je veux un briefing de chef de cabinet.",
        params: { cle: "niveauReunion", valeur: "CHIEF_OF_STAFF" },
      },
    });
    try {
      const out = await brief({ title: `${TAG} Point budget` }, userWith(pdgId, `${TAG} Karim PDG`));
      expect(out.niveau).toBe("CHIEF_OF_STAFF");
      expect(out.niveauSource).toMatch(/règle enseignée/);
      const lina = out.participants.find((p: { nom: string }) => p.nom.includes("Lina"));
      expect(lina.fonction).toBe("Directrice administrative et financière");
      expect(out.derniereReunion.notes).toContain("geler la caisse");
      // Les décisions À OBTENIR : la validation qui attend le PDG.
      expect(out.decisionsAObtenir.map((d: { reference?: string }) => d.reference)).toContain(`${TAG}-VAL`);
      // L'engagement en retard, avec son retard compté.
      const retard = out.engagementsEnRetard.find((e: { quoi: string }) => e.quoi.includes("budget révisé"));
      expect(retard).toBeDefined();
      expect(retard.retardJours).toBeGreaterThanOrEqual(4);
      expect(Array.isArray(out.questionsOuvertes)).toBe(true);
      expect(Array.isArray(out.risques)).toBe(true);
      expect(Array.isArray(out.contradictions)).toBe(true);
      expect(out.suiviJusquaProchaine.aRapporter.join(" ")).toContain("Préparer l'état de la caisse");
      expect(out.contenu.length).toBeGreaterThan(10);
    } finally {
      await prisma.adamRule.deleteMany({ where: { ownerId: pdgId } });
    }
    // Règle supprimée : on retombe sur le défaut du rôle.
    const apres = await brief({ title: `${TAG} Point budget` }, userWith(pdgId, `${TAG} Karim PDG`));
    expect(apres.niveau).toBe("STANDARD");
  });

  it("un rôle hors direction lit LIGHT par défaut ; l'INVITÉ a le même brief (sa réunion aussi) ; un TIERS ne la voit jamais", async () => {
    const asDaf = await brief({ title: `${TAG} Point budget` }, userWith(dafId, `${TAG} Lina DAF`, "HEAD_OF_SALES"));
    expect(asDaf.reunion.titre).toBe(`${TAG} Point budget T3`);
    expect(asDaf.niveau).toBe("LIGHT");
    const asTiers = await tool.run({ title: `${TAG} Point budget` }, userWith(tiersId, `${TAG} Walid`));
    expect(String(asTiers)).toMatch(/Aucune réunion/);
  });

  it("sans réunion à venir : réponse honnête, jamais une réunion inventée", async () => {
    const out = await tool.run({ title: `${TAG} inexistante-xyz` }, userWith(pdgId, `${TAG} Karim PDG`));
    expect(String(out)).toMatch(/Aucune réunion/);
  });
});
