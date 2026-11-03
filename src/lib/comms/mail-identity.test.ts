import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  createOutboundIntent,
  approveOutboundIntent,
  sendOutboundIntent,
  computeContentHash,
  type MailTransport,
} from "./outbound";
import { authorizeIdentity, resolveOutboundIdentity, isIdentity } from "./identity";
import { setMailSendPolicy, setOutboundPaused } from "./policy";

/**
 * L'EXPÉDITEUR — la question « d'où part ce message ? », posée au code plutôt qu'à l'écran.
 *
 * Le bogue rejoué ici est celui d'une carte qui annonçait « De : amine.djouamai@pharmagenedz.com »
 * alors qu'Adam a une adresse à lui. Les cas ci-dessous ne vérifient pas un libellé : ils
 * vérifient que rien — ni le destinataire, ni l'adresse ERP de la personne, ni un payload
 * fabriqué — ne peut décider à la place de la connexion canonique.
 *
 * Le transport est un espion. C'est lui qui dit ce qui est réellement parti, et depuis quoi.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ident__${Date.now()}`;
/** L'adresse d'Adam — l'expéditeur attendu, dans tous les cas. */
const ADAM = `${TAG}.adam@gmail.com`;
/** L'adresse ERP du PDG — un DESTINATAIRE possible, jamais un expéditeur. */
const PDG = `${TAG}.pdg@pharmagenedz.example`;

function spyTransport() {
  const sent: { connectionId: string; recipients: string[]; subject: string }[] = [];
  const transport: MailTransport = {
    async send(msg) {
      sent.push({ connectionId: msg.connectionId, recipients: msg.recipients, subject: msg.subject });
      return { providerMessageId: `msg-${sent.length}`, providerThreadId: null };
    },
  };
  return { transport, sent };
}

let userId = "";
let connectionId = "";
/** Un SECOND compte, avec sa propre connexion : de quoi tenter l'usurpation. */
let autreUserId = "";
let autreConnectionId = "";

const draft = (over: Partial<Parameters<typeof createOutboundIntent>[0]> = {}) => ({
  connectionId,
  userId,
  recipients: ["deepak@fournisseur.example"],
  subject: `${TAG} Test d'envoi`,
  bodyText: "Bonjour, ceci est un message préparé.",
  ...over,
});

suite("identité d'envoi — l'expéditeur ne se devine jamais", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: PDG, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: ADAM, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;

    const autre = await prisma.user.create({
      data: { name: `${TAG} Autre`, email: `${TAG}.autre@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    autreUserId = autre.id;
    const autreConn = await prisma.googleConnection.create({
      data: { userId: autre.id, address: `${TAG}.autre@gmail.com`, accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    autreConnectionId = autreConn.id;
  }, 30_000);

  afterEach(async () => {
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);
    await setOutboundPaused(false, userId);
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId: { in: [connectionId, autreConnectionId] } } });
    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: false, status: "connected" } });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId: { in: [connectionId, autreConnectionId] } } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId: { in: [userId, autreUserId] } } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { contains: TAG } } }).catch(() => {});
  }, 30_000);

  // ─────────────────── 1. L'expéditeur est celui d'Adam ───────────────────

  it("l'expéditeur est l'adresse Google connectée d'Adam — pas celle du compte ERP", async () => {
    const identity = await resolveOutboundIdentity(userId);
    expect(isIdentity(identity)).toBe(true);
    if (!isIdentity(identity)) return;
    expect(identity.address).toBe(ADAM);
    expect(identity.address).not.toBe(PDG);

    const intent = await createOutboundIntent(draft());
    expect(intent.connectionId).toBe(connectionId);

    const { transport, sent } = spyTransport();
    await approveOutboundIntent(intent.id, userId);
    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(true);
    // Ce qui est RÉELLEMENT parti est parti de la connexion d'Adam.
    expect(sent[0].connectionId).toBe(connectionId);
  });

  // ─────────────────── 2. Le destinataire ne contamine rien ───────────────────

  it("le DESTINATAIRE est différent de l'expéditeur — et ne le change pas", async () => {
    const intent = await createOutboundIntent(draft({ recipients: ["deepak@fournisseur.example"] }));
    const conn = await prisma.googleConnection.findUniqueOrThrow({ where: { id: intent.connectionId }, select: { address: true } });
    expect(conn.address).toBe(ADAM);
    expect(intent.recipients).toEqual(["deepak@fournisseur.example"]);
  });

  it("écrire AU PDG LUI-MÊME est autorisé — et n'en fait pas l'expéditeur", async () => {
    // C'est exactement la scène du bogue : « De : … / À : … » avec la même adresse des deux
    // côtés. Le destinataire peut légitimement être le PDG ; l'expéditeur reste Adam.
    const intent = await createOutboundIntent(draft({ recipients: [PDG] }));
    const conn = await prisma.googleConnection.findUniqueOrThrow({ where: { id: intent.connectionId }, select: { address: true } });
    expect(intent.recipients).toEqual([PDG.toLowerCase()]);
    expect(conn.address).toBe(ADAM);
    expect(conn.address).not.toBe(intent.recipients[0]);
  });

  it("le destinataire n'écrase JAMAIS l'expéditeur, quel qu'il soit", async () => {
    // Trois destinataires très différents ; une seule et même connexion d'envoi.
    for (const dest of ["a@x.example", PDG, "contact@pch.dz"]) {
      const intent = await createOutboundIntent(draft({ recipients: [dest], subject: `${TAG} ${dest}` }));
      expect(intent.connectionId, dest).toBe(connectionId);
    }
  });

  // ─────────────────── 3. Un payload trafiqué ne peut pas usurper ───────────────────

  it("un payload qui désigne la connexion de QUELQU'UN D'AUTRE est REFUSÉ", async () => {
    // L'attaque la plus simple : poser le connectionId du voisin pour écrire depuis sa boîte.
    await expect(
      createOutboundIntent(draft({ connectionId: autreConnectionId })),
    ).rejects.toThrow(/pas celle de ce compte|n'est pas la vôtre/i);

    // Et rien n'a été écrit : le contrôle passe AVANT la création.
    const count = await prisma.outboundMailIntent.count({ where: { connectionId: autreConnectionId } });
    expect(count).toBe(0);
  });

  it("une connexion INEXISTANTE est refusée — pas d'intention orpheline", async () => {
    await expect(createOutboundIntent(draft({ connectionId: "connexion-imaginaire" }))).rejects.toThrow();
  });

  it("authorizeIdentity distingue les quatre refus possibles", async () => {
    const bonne = await authorizeIdentity(connectionId, userId);
    expect(isIdentity(bonne)).toBe(true);

    const pasLaMienne = await authorizeIdentity(autreConnectionId, userId);
    expect(isIdentity(pasLaMienne)).toBe(false);
    if (!isIdentity(pasLaMienne)) expect(pasLaMienne.error).toBe("not-yours");

    const inexistante = await authorizeIdentity("nope", userId);
    if (!isIdentity(inexistante)) expect(inexistante.error).toBe("not-connected");

    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: true } });
    const suspendue = await authorizeIdentity(connectionId, userId);
    if (!isIdentity(suspendue)) expect(suspendue.error).toBe("paused");

    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: false, status: "needs-reconnect" } });
    const aReconnecter = await authorizeIdentity(connectionId, userId);
    if (!isIdentity(aReconnecter)) expect(aReconnecter.error).toBe("needs-reconnect");
  });

  // ─────────────────── 4. Sans identité valable, rien ne part ───────────────────

  it("SANS identité d'envoi valable, le message NE PART PAS — même approuvé", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    // Entre l'accord et le clic, la connexion est suspendue. L'identité est RELUE à l'envoi.
    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: true } });

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0); // LA preuve
    if (!r.ok && !r.blocked) expect(r.error).toMatch(/SUSPENDUE/i);
  });

  it("une reconnexion sur une AUTRE adresse ne fait pas partir le message en douce", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);
    await prisma.googleConnection.update({ where: { id: connectionId }, data: { status: "needs-reconnect" } });

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // ─────────────────── 5. L'identité fait partie de l'accord ───────────────────

  it("l'identité entre dans l'EMPREINTE du contenu approuvé", async () => {
    // Deux intentions identiques en tout sauf l'expéditeur ne portent pas la même empreinte :
    // un accord donné pour l'une ne vaut donc rien pour l'autre.
    const commun = {
      recipients: ["deepak@fournisseur.example"],
      subject: "Objet",
      bodyText: "Corps",
    };
    const h1 = computeContentHash({ ...commun, connectionId });
    const h2 = computeContentHash({ ...commun, connectionId: autreConnectionId });
    expect(h1).not.toBe(h2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────

suite("un seul envoi par contenu — la double confirmation ne fabrique pas de doublon", () => {
  let u2 = "";
  let c2 = "";
  const T2 = `__once__${Date.now()}`;

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${T2}`, email: `${T2}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    u2 = u.id;
    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: `${T2}@gmail.com`, accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    c2 = c.id;
  }, 30_000);

  afterEach(async () => {
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, u2);
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId: c2 } });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId: c2 } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId: u2 } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: u2 } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: T2 } } }).catch(() => {});
  }, 30_000);

  const same = () => ({
    connectionId: c2,
    userId: u2,
    recipients: ["amine.djouamai@pharmagenedz.example"],
    subject: "Test d'envoi de mail",
    bodyText: "Je réussis dorénavant à envoyer des mails.",
  });

  it("préparer DEUX FOIS le même message rend la MÊME intention", async () => {
    // Le PDG répète « oui » ; le modèle reprépare. Ce sont deux façons de décrire un seul envoi.
    const a = await createOutboundIntent(same());
    const b = await createOutboundIntent(same());
    expect(b.id).toBe(a.id);
    expect(await prisma.outboundMailIntent.count({ where: { connectionId: c2 } })).toBe(1);
  });

  it("un contenu DIFFÉRENT crée bien une nouvelle intention — la déduplication ne bâillonne pas", async () => {
    const a = await createOutboundIntent(same());
    const b = await createOutboundIntent({ ...same(), bodyText: "Autre message, autre envoi." });
    expect(b.id).not.toBe(a.id);
  });

  it("DEUX « oui » de suite = UN SEUL courriel", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(same());
    await approveOutboundIntent(intent.id, u2);

    // Deux clics, deux envois demandés — un seul part réellement.
    const r1 = await sendOutboundIntent(intent.id, transport);
    const r2 = await sendOutboundIntent(intent.id, transport);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.alreadySent).toBe(true);
    expect(sent).toHaveLength(1); // LA preuve

    // …et la reprépararation qui suivrait retombe sur l'intention DÉJÀ partie, sans en refaire une.
    const encore = await createOutboundIntent(same());
    expect(encore.id).toBe(intent.id);
    expect(encore.status).toBe(OutboundMailStatus.SENT);
    expect(sent).toHaveLength(1);
  });
});
