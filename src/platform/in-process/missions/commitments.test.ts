import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { assurerCompteAgent, idCompteAgent } from "@/lib/missions/agent/account";
import { relancerEngagements } from "@/platform/in-process/missions/commitments";
import { satisfaireEngagements } from "@/lib/missions/commitments/satisfy";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX MOITIÉS D'UN ENGAGEMENT (§29-32, §85-88).
 *
 *   LE FAIT ARRIVE      `satisfaireEngagements`, appelée par le registre d'événements. Elle
 *                       marchait déjà, et ce banc le revérifie parce que l'autre moitié en
 *                       dépend : relancer une promesse tenue serait la faute la plus visible.
 *
 *   LE FAIT N'ARRIVE PAS `relancerEngagements`, appelée par le battement. C'est la moitié qui
 *                       manquait : la promesse restait ouverte, et personne ne repassait.
 *
 * ── QUI EST RELANCÉ ─────────────────────────────────────────────────────────────────────
 *
 * La PERSONNE QUI A PROMIS, par un message interne signé Adam — pas le dirigeant. « Voulez-vous
 * relancer ? » lui transférait la micro-décision la plus évidente. Le dirigeant n'est prévenu
 * que lorsque l'échelle (personne, personne, hiérarchie) est épuisée, ou quand la promesse ne
 * désigne aucun compte interne.
 *
 * ── POURQUOI LE TEMPS EST FIXÉ EN 2020 ─────────────────────────────────────────────────
 *
 * Le balayage est GLOBAL, comme en production. Un banc qui l'appellerait « maintenant »
 * toucherait aux engagements laissés par d'autres suites — et mesurerait la propreté de la base
 * de test au lieu du comportement du code. En plaçant l'instant d'observation dans un passé où
 * seul CE banc a écrit, le balayage reste entier et le résultat, déterministe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eng${Date.now()}`;
/** L'échéance, et l'instant d'observation : très en amont de ce que toute autre suite écrit. */
const ECHEANCE = new Date("2020-01-01T09:00:00.000Z");
const OBSERVE = new Date("2020-01-20T09:00:00.000Z");

let ownerId = "";
let promettantId = "";
let agentId = "";

/**
 * `personId` PORTE LA CONFIANCE. Un engagement rattaché à une identité canonique se relance ;
 * un engagement qui ne porte qu'un nom libre se tait — voir l'en-tête du balayage.
 */
async function engagement(
  who: string, what: string,
  opts: { dueAt?: Date | null; personId?: string | null } = {},
) {
  const e = await prisma.executiveCommitment.create({
    data: {
      ownerId, who, what, status: "OPEN",
      dueAt: opts.dueAt === undefined ? ECHEANCE : opts.dueAt,
      promisedAt: ECHEANCE,
      personId: opts.personId === undefined ? promettantId : opts.personId,
    },
    select: { id: true },
  });
  return e.id;
}

/** Les messages qu'Adam a adressés au promettant pour CE banc. */
const relancesAdam = () => prisma.message.count({
  where: { senderId: agentId, body: { contains: TAG }, conversation: { members: { some: { userId: promettantId } } } },
});
/** Ce que le dirigeant a reçu pour CE banc. */
const notifsDirigeant = () => prisma.notification.count({ where: { userId: ownerId, body: { contains: TAG } } });

suite("ENGAGEMENTS — tenus tout seuls, relancés quand ils ne le sont pas", () => {
  beforeAll(async () => {
    await assurerCompteAgent();
    agentId = (await idCompteAgent()) ?? "";
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true },
    });
    ownerId = u.id;

    const p = await prisma.user.create({
      data: { name: `${TAG} Redouane`, email: `${TAG}red@amd.dz`, passwordHash: "x", role: "SALES_USER" },
      select: { id: true },
    });
    promettantId = p.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.executiveCommitment.deleteMany({ where: { ownerId } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversation: { members: { some: { userId: promettantId } } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { members: { some: { userId: promettantId } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [ownerId, promettantId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("§29-32 — une promesse en retard est RELANCÉE par Adam, auprès de la personne qui a promis", async () => {
    expect(agentId, "le compte d'Adam doit exister").toBeTruthy();
    const id = await engagement("Redouane Belkacem", `${TAG} envoyer le contrat signé`);

    const r = await relancerEngagements(OBSERVE);
    expect(r.candidats, "l'engagement échu devait être candidat").toBeGreaterThanOrEqual(1);
    expect(r.signales).toBeGreaterThanOrEqual(1);

    // LE MESSAGE EXISTE, il vient d'ADAM, il est adressé AU PROMETTANT, et il nomme la promesse.
    const msg = await prisma.message.findFirst({
      where: { senderId: agentId, body: { contains: TAG } },
      select: { body: true, conversation: { select: { members: { select: { userId: true } } } } },
    });
    expect(msg, "aucun message : la relance n'a rien produit d'utile").toBeTruthy();
    expect(msg!.conversation.members.map((m) => m.userId)).toContain(promettantId);
    expect(msg!.body).toContain("envoyer le contrat signé");
    expect(msg!.body).toMatch(/depuis \d+ jour\(s\)/);
    expect(msg!.body).toContain("— Adam");
    // Le promettant est prévenu qu'un message l'attend ; le DIRIGEANT, lui, n'est PAS dérangé.
    expect(await prisma.notification.count({ where: { userId: promettantId, title: "Relance d'Adam" } })).toBe(1);
    expect(await notifsDirigeant(), "le dirigeant ne doit pas être sollicité au premier barreau").toBe(0);

    // ET LE RAPPEL EST NOTÉ : sans cela, le battement suivant recommencerait dans la minute.
    const apres = await prisma.executiveCommitment.findUnique({
      where: { id }, select: { lastNudgeAt: true },
    });
    expect(apres!.lastNudgeAt).not.toBeNull();
  }, 120_000);

  it("§85-88 — on ne relance PAS deux fois le même jour (l'espacement croît), et l'échelle épuisée remonte au dirigeant", async () => {
    const avant = await relancesAdam();
    expect(avant).toBe(1);

    // Le même instant, immédiatement après : `doitRelancer` doit refuser.
    const r = await relancerEngagements(OBSERVE);
    expect(r.signales, "un second passage au même instant ne doit rien envoyer").toBe(0);
    expect(await relancesAdam()).toBe(avant);

    // Deux jours plus tard, ce n'est toujours pas assez : après un rappel, on attend trois jours.
    const deuxJours = new Date(OBSERVE.getTime() + 2 * 24 * 3600 * 1000);
    expect((await relancerEngagements(deuxJours)).signales).toBe(0);
    expect(await relancesAdam()).toBe(avant);

    // Dix jours plus tard, oui : à 19 jours d'écart le code déduit QUATRE rappels, donc un
    // espacement de neuf jours. (Avant la correction de `relancesDeduites`, il en déduisait dix
    // et exigeait quatorze jours — un engagement très en retard se serait tu deux semaines.)
    // Quatre rappels déduits, c'est aussi une ÉCHELLE ÉPUISÉE : ce rappel-là ne va plus au
    // promettant, il prévient le dirigeant — avec le retard et le nombre de relances passées.
    const dixJours = new Date(OBSERVE.getTime() + 10 * 24 * 3600 * 1000);
    expect((await relancerEngagements(dixJours)).signales).toBeGreaterThanOrEqual(1);
    expect(await relancesAdam(), "l'échelle est épuisée : plus de message au promettant").toBe(avant);
    const notif = await prisma.notification.findFirst({
      where: { userId: ownerId, body: { contains: TAG } }, select: { title: true, body: true },
    });
    expect(notif, "le dirigeant doit être prévenu quand l'échelle est épuisée").toBeTruthy();
    expect(notif!.title).toContain("Redouane Belkacem");
    expect(notif!.body).toMatch(/jour\(s\) de retard/);
    expect(notif!.body).toMatch(/rappel\(s\) déjà passé\(s\)/);
  }, 120_000);

  it("une promesse SANS ÉCHÉANCE ne se relance pas — il n'y a rien à réclamer", async () => {
    await prisma.executiveCommitment.deleteMany({ where: { ownerId } });
    await prisma.executiveCommitment.create({
      data: { ownerId, who: "Alla Atmani", what: `${TAG} y réfléchir`, status: "OPEN", dueAt: null, promisedAt: null },
    });
    const r = await relancerEngagements(OBSERVE);
    expect(r.candidats).toBe(0);
  }, 120_000);

  /**
   * §9 / §85-88 — LE SILENCE EST UNE ISSUE À PART ENTIÈRE.
   *
   * Sans identité canonique, on ne sait pas de QUEL Redouane on parle. Écrire à quelqu'un
   * « vous deviez envoyer votre contrat » quand ce n'était pas lui, ou annoncer au PDG « Redouane
   * n'a toujours pas envoyé son contrat » quand ce n'était pas celui-là, est pire que se taire.
   */
  it("§9 — une promesse SANS IDENTITÉ CANONIQUE est candidate mais reste TUE", async () => {
    await prisma.executiveCommitment.deleteMany({ where: { ownerId } });
    const messagesAvant = await relancesAdam();
    const notifsAvant = await notifsDirigeant();
    const id = await engagement("Redouane", `${TAG} un nom libre, sans compte`, { personId: null });

    const r = await relancerEngagements(OBSERVE);
    expect(r.candidats, "elle est bien échue").toBeGreaterThanOrEqual(1);
    expect(r.signales, "mais on ne la signale pas").toBe(0);
    expect(r.tus).toBeGreaterThanOrEqual(1);
    expect(await relancesAdam()).toBe(messagesAvant);
    expect(await notifsDirigeant()).toBe(notifsAvant);

    // ON NE NOTE PAS DE RAPPEL NON PLUS : rien n'a été envoyé, et prétendre le contraire
    // ferait ensuite attendre neuf jours avant un rappel qui n'a jamais eu lieu.
    const e = await prisma.executiveCommitment.findUnique({ where: { id }, select: { lastNudgeAt: true } });
    expect(e!.lastNudgeAt).toBeNull();
  }, 120_000);

  it("§29-32 — le FAIT qui arrive ferme l'engagement, et il n'est plus relancé", async () => {
    await prisma.executiveCommitment.deleteMany({ where: { ownerId } });
    const id = await engagement("Redouane Belkacem", `${TAG} envoyer le contrat signé`);

    // LE VRAI CHEMIN : un fait métier passe par le registre d'événements.
    const fermes = await satisfaireEngagements({
      type: "DOCUMENT_UPLOADED",
      sourceDomain: "DRIVE",
      // LE FAIT PORTE L'IDENTITÉ CANONIQUE, comme tout fait émis par l'ERP. C'est elle que
      // `tientLaPromesse` rapproche du `personId` de l'engagement — le nom libre n'est qu'un
      // repli, pour les partenaires qui n'ont pas de compte.
      payload: { personId: promettantId, from: "Redouane Belkacem" },
      occurredAt: new Date(OBSERVE.getTime() - 3600_000),
    } as never);
    expect(fermes, "le fait attendu devait fermer l'engagement").toContain(id);

    const e = await prisma.executiveCommitment.findUnique({ where: { id }, select: { status: true } });
    expect(e!.status).not.toBe("OPEN");

    // ET SURTOUT : une promesse tenue ne se relance plus. C'est la faute la plus visible.
    expect((await relancerEngagements(OBSERVE)).candidats).toBe(0);
  }, 120_000);
});
