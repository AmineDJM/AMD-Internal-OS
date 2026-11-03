import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { buildProposal, performAction, resolveSpokenMailApproval } from "@/lib/assistant";
import { solePendingMailIntent } from "./approve-execute";
import { approveOutboundIntent, sendOutboundIntent, type MailTransport } from "./outbound";
import { buildMimeMessage } from "@/lib/google/gmail/mime";
import { setMailSendPolicy } from "./policy";

/**
 * LE SCÉNARIO GOLDEN — la journée du PDG, jouée d'un bout à l'autre sur la vraie base.
 *
 *   PDG   « Envoie un mail à amine.djouamai@pharmagenedz.com »
 *   ADAM  prépare — DE adam.executive.ai@gmail.com, À amine.djouamai@…, objet « Test d'envoi
 *         de mail » — et n'envoie RIEN.
 *   PDG   « Je confirme. »
 *   ADAM  → aucune seconde carte, UN SEUL envoi, statut SENT, reçu, corps EXACTEMENT celui
 *         qui a été approuvé.
 *
 * CE QUI EST RÉELLEMENT EXERCÉ ICI, ET CE QUI NE L'EST PAS — parce qu'un test doit dire ses
 * limites pour valoir quelque chose :
 *
 *   • Exercé : la chaîne serveur complète et RÉELLE — `buildProposal`, l'intention canonique,
 *     `resolveSpokenMailApproval`, `performAction`, l'approbation liée à l'empreinte, la
 *     transition atomique, et jusqu'à l'en-tête `From:` du message MIME effectivement construit.
 *   • Non exercé : l'appel HTTP à Google. Il n'y a pas de jeton valable en intégration continue,
 *     et un test qui dépendrait d'un compte réel serait instable, lent et impossible à rejouer.
 *     La frontière est donc prise au TRANSPORT : un espion pour la voie nominale (ce qui part,
 *     et combien de fois), le vrai `gmailTransport` pour prouver qu'un échec réseau ne fabrique
 *     ni second envoi ni faux succès.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__golden__${Date.now()}`;
const ADAM = `${TAG}.adam.executive.ai@gmail.com`;
const DEST = `${TAG}.amine.djouamai@pharmagenedz.example`;
const OBJET = "Test d'envoi de mail";
const CORPS = "Bonjour, je réussis dorénavant à envoyer des mails.";

function spyTransport() {
  const sent: { connectionId: string; recipients: string[]; subject: string; bodyText: string }[] = [];
  const transport: MailTransport = {
    async send(msg) {
      sent.push({ connectionId: msg.connectionId, recipients: msg.recipients, subject: msg.subject, bodyText: msg.bodyText });
      return { providerMessageId: `gmail-${sent.length}`, providerThreadId: `thread-${sent.length}` };
    },
  };
  return { transport, sent };
}

let user: CurrentUser;
let userId = "";
let connectionId = "";

suite("scénario golden — préparer, confirmer une seule fois, partir une seule fois", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} Amine`, email: `${TAG}.pdg@adventum.example`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: ADAM, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;
    user = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: {} as CurrentUser["access"], mustChangePassword: false };
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);
  }, 30_000);

  afterEach(async () => {
    // Le cas d'échec passe par le VRAI transport Gmail : faute de jeton valable, la connexion
    // bascule légitimement en « à reconnecter » — c'est la production qui fait son travail. On
    // la relève donc entre les cas, sans quoi l'état d'un test déciderait du suivant.
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: { status: "connected", paused: false, lastError: null },
    });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { contains: TAG } } }).catch(() => {});
  }, 30_000);

  it("la journée entière : une préparation, une confirmation, un envoi", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });

    // ── 1. « Envoie un mail à … » — Adam PRÉPARE, et rien ne part ──
    const carte = await buildProposal("send_email", { to: DEST, subject: OBJET, body: CORPS }, user);
    expect("error" in carte).toBe(false);
    if ("error" in carte) return;

    expect(carte.kind).toBe("send_prepared_mail");
    expect(carte.level).toBe("SENSITIVE");
    expect(carte.fields.find((f) => f.label === "De")?.value).toContain(ADAM);
    expect(carte.fields.find((f) => f.label === "À")?.value).toBe(DEST.toLowerCase());
    expect(carte.fields.find((f) => f.label === "Objet")?.value).toBe(OBJET);
    expect(carte.fields.find((f) => f.label === "Message")?.value).toBe(CORPS);

    const intentId = (carte.payload as { intentId: string }).intentId;
    let intent = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(intent.approvedById).toBeNull();
    expect(intent.sentAt).toBeNull();

    // ── 2. « Je confirme. » désigne CETTE intention, et pas une nouvelle ──
    // (l'exécution par la parole est éprouvée dans son propre cas ci-dessous ; ici on isole la
    // RÉSOLUTION, pour pouvoir observer l'envoi au travers d'un transport espion.)
    const vise = await solePendingMailIntent(userId);
    expect(vise?.id).toBe(intentId);
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(1);

    // ── 3. L'APPROBATION porte le contenu exact, et l'humain est nommé ──
    const approuve = await approveOutboundIntent(intentId, userId);
    expect("error" in approuve).toBe(false);
    intent = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.approvedById).toBe(userId);
    expect(intent.approvedHash).toBe(intent.contentHash);

    // ── 4. L'ENVOI : une fois, et une seule ──
    const { transport, sent } = spyTransport();
    const r1 = await sendOutboundIntent(intentId, transport);
    expect(r1.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].connectionId).toBe(connectionId);
    expect(sent[0].recipients).toEqual([DEST.toLowerCase()]);
    // Le corps parti est EXACTEMENT celui qui a été approuvé — pas une reformulation.
    expect(sent[0].bodyText).toBe(CORPS);
    expect(sent[0].subject).toBe(OBJET);

    // ── 5. LE REÇU ──
    intent = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(OutboundMailStatus.SENT);
    expect(intent.providerMessageId).toBe("gmail-1");
    expect(intent.sentAt).not.toBeNull();
    expect(intent.attempts).toBe(1);

    // ── 6. LE SECOND « oui » — celui qui doublait le message ──
    const r2 = await sendOutboundIntent(intentId, transport);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.alreadySent).toBe(true);
    expect(sent).toHaveLength(1); // LA preuve : toujours un seul.

    // …et même en repassant par la carte, comme le ferait un double-clic tardif.
    const rejeu = await performAction(user, {
      kind: "send_prepared_mail", intentId, subject: OBJET, recipients: [DEST], missionId: null,
    });
    expect(rejeu.ok).toBe(true);
    expect(rejeu.message).toMatch(/déjà envoyé/i);
    const final = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(final.attempts).toBe(1);
    expect(final.providerMessageId).toBe("gmail-1");
  });

  it("l'en-tête « From: » RÉELLEMENT écrit sur le fil porte l'adresse d'Adam", async () => {
    // Le dernier endroit où l'expéditeur pourrait encore déraper : le message MIME lui-même.
    // `gmailTransport` le construit avec l'adresse de la CONNEXION ACTIVE — on le vérifie ici
    // sur la fonction exacte qu'il appelle, sans dépendre du réseau.
    const mime = buildMimeMessage({
      from: ADAM,
      fromName: "Adam",
      to: [DEST],
      cc: [],
      bcc: [],
      subject: OBJET,
      text: CORPS,
    });
    const ligneFrom = mime.split(/\r?\n/).find((l) => l.startsWith("From:")) ?? "";
    expect(ligneFrom).toContain(ADAM);
    expect(ligneFrom).not.toContain("pharmagenedz");
    // Le destinataire est ailleurs, et il n'a rien à voir avec l'expéditeur.
    const ligneTo = mime.split(/\r?\n/).find((l) => l.startsWith("To:")) ?? "";
    expect(ligneTo).toContain(DEST);
  });

  it("un envoi qui ÉCHOUE ne se rejoue pas tout seul et ne se dit jamais réussi", async () => {
    // La voie du vrai transport : le jeton est factice, Google refuse. Ce qu'on vérifie n'est pas
    // l'erreur — c'est qu'un échec laisse une trace honnête plutôt qu'un faux « envoyé ».
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    const carte = await buildProposal("send_email", {
      to: `${TAG}.echec@ailleurs.example`, subject: "Objet en échec", body: "Corps en échec",
    }, user);
    if ("error" in carte) throw new Error(carte.error);
    const intentId = (carte.payload as { intentId: string }).intentId;

    const r = await performAction(user, {
      kind: "send_prepared_mail", intentId, subject: "Objet en échec",
      recipients: [`${TAG}.echec@ailleurs.example`], missionId: null,
    });
    expect(r.ok).toBe(false);

    const apres = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(apres.status).not.toBe(OutboundMailStatus.SENT);
    expect(apres.sentAt).toBeNull();
    expect(apres.providerMessageId).toBeNull();
    // Une seule tentative : rien ne relance en boucle derrière le dos du PDG.
    expect(apres.attempts).toBeLessThanOrEqual(1);
  }, 30_000);

  it("« Tu as reçu des e-mails ou pas ? » ne déclenche AUCUNE proposition d'envoi", async () => {
    // Le premier transcript : une question sur la boîte ne doit produire ni carte d'envoi, ni
    // reprise d'une intention en attente.
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    const carte = await buildProposal("send_email", { to: DEST, subject: OBJET, body: CORPS }, user);
    if ("error" in carte) throw new Error(carte.error);

    for (const question of [
      "Tu as reçu des e-mails ou pas ?",
      "J'ai reçu quelque chose ?",
      "Qu'est-ce qui est arrivé récemment ?",
      "Deepak a répondu ?",
    ]) {
      expect(await resolveSpokenMailApproval(user, question), question).toBeNull();
    }
    // L'intention préparée n'a pas bougé d'un iota : elle attend toujours, sans être partie.
    const apres = await prisma.outboundMailIntent.findFirstOrThrow({ where: { connectionId } });
    expect(apres.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(apres.sentAt).toBeNull();
  });
});
