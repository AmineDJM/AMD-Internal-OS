import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  createOutboundIntent,
  updateOutboundIntent,
  approveOutboundIntent,
  cancelOutboundIntent,
  sendOutboundIntent,
  pendingApprovals,
  type MailTransport,
} from "./outbound";
import { setMailSendPolicy, setOutboundPaused, setInboundPaused } from "./policy";

/**
 * LA FRONTIÈRE D'ENVOI — la règle qu'aucun chemin ne doit pouvoir contourner.
 *
 * Ces tests ne vérifient pas du texte : ils vérifient qu'un message NE PART PAS. Le transport
 * est un espion qui compte les envois réels — la seule preuve qui compte. Un test qui se
 * contenterait de lire un statut en base laisserait passer un envoi effectué avant l'écriture.
 *
 * Chaque cas correspond à une façon précise de perdre le contrôle de la boîte de la direction :
 * approuver A et expédier B, double-cliquer, laisser une mission de fond envoyer toute seule,
 * ou croire qu'on a remis le garde-fou alors que des intentions déjà « approuvées » restent
 * armées.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__outb__${Date.now()}`;

/** Un transport qui n'envoie rien mais COMPTE — c'est lui qui dit la vérité. */
function spyTransport() {
  const sent: { subject: string; recipients: string[] }[] = [];
  const transport: MailTransport = {
    async send(msg) {
      sent.push({ subject: msg.subject, recipients: msg.recipients });
      return { providerMessageId: `msg-${sent.length}`, providerThreadId: `thr-${sent.length}` };
    },
  };
  return { transport, sent };
}

let userId = "";
let connectionId = "";

const draft = (over: Partial<Parameters<typeof createOutboundIntent>[0]> = {}) => ({
  connectionId,
  userId,
  recipients: ["deepak@fournisseur.example"],
  subject: `${TAG} Besoins Regulatory`,
  bodyText: "Bonjour Deepak, voici ce que l'équipe attend.",
  ...over,
});

suite("frontière d'envoi — aucun message ne part sans accord", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    const c = await prisma.googleConnection.create({
      data: {
        userId: u.id,
        address: `${TAG}@gmail.com`,
        accessTokenEnc: "x",
        grantedScopes: "",
        status: "connected",
      },
    });
    connectionId = c.id;
  });

  afterEach(async () => {
    // Chaque cas repart de la politique de production : approbation requise, rien de suspendu.
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);
    await setOutboundPaused(false, userId);
    await setInboundPaused(false, userId);
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("préparer n'envoie rien : l'intention attend, le transport n'est jamais appelé", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());

    expect(intent.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(intent.approvedHash).toBeNull();

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    if (!r.ok && r.blocked) expect(r.decision.reason).toBe("approval-required");
    expect(sent).toHaveLength(0); // LA preuve

    // Et l'écran doit pouvoir la montrer au PDG.
    const waiting = await pendingApprovals(userId);
    expect(waiting.map((w) => w.id)).toContain(intent.id);
  });

  it("après accord, le message part une fois et rend son reçu", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerMessageId).toBe("msg-1");
    expect(sent).toHaveLength(1);

    const after = await prisma.outboundMailIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe(OutboundMailStatus.SENT);
    expect(after?.sentAt).toBeTruthy();
    expect(after?.providerMessageId).toBe("msg-1");
  });

  it("modifier après accord INVALIDE l'accord — on ne fait pas approuver A pour envoyer B", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    // Le PDG a validé un texte ; on en change un mot.
    const edited = await updateOutboundIntent(intent.id, { bodyText: "Bonjour Deepak, AUTRE contenu." });
    expect("error" in edited).toBe(false);

    const after = await prisma.outboundMailIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(after?.approvedHash).toBeNull();

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("changer un DESTINATAIRE invalide aussi l'accord", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    await updateOutboundIntent(intent.id, { recipients: ["quelquun.dautre@example.com"] });
    const r = await sendOutboundIntent(intent.id, transport);

    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("double approbation puis deux envois : EXACTEMENT un message part", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());

    await approveOutboundIntent(intent.id, userId);
    await approveOutboundIntent(intent.id, userId); // double clic

    const [a, b] = await Promise.all([
      sendOutboundIntent(intent.id, transport),
      sendOutboundIntent(intent.id, transport),
    ]);

    expect(sent).toHaveLength(1);
    // L'un des deux a gagné la course ; l'autre n'a rien envoyé.
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(1);
  });

  it("un rejeu APRÈS envoi rend le premier reçu sans réexpédier", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);
    await sendOutboundIntent(intent.id, transport);

    const replay = await sendOutboundIntent(intent.id, transport);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.alreadySent).toBe(true);
      expect(replay.providerMessageId).toBe("msg-1");
    }
    expect(sent).toHaveLength(1);
  });

  it("une mission de FOND ne contourne rien : elle atteint READY_TO_SEND, pas SENT", async () => {
    const { transport, sent } = spyTransport();
    // Exactement ce que produirait une relance préparée la nuit, sans personne devant l'écran.
    const intent = await createOutboundIntent(draft({ generatedBy: "mission", reason: "relance automatique" }));

    expect(intent.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("ENVOI AUTONOME : le même chemin part sans accord humain", async () => {
    const { transport, sent } = spyTransport();
    await setMailSendPolicy(MailSendPolicy.AUTO_SEND, userId);

    const intent = await createOutboundIntent(draft());
    expect(intent.status).toBe(OutboundMailStatus.APPROVED);

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("RETOUR à l'approbation obligatoire : les intentions déjà armées NE partent plus", async () => {
    // Le cas qui compte vraiment : le PDG a ouvert l'envoi autonome, Adam a préparé, puis le PDG
    // remet le garde-fou. Ce qui a été « approuvé » par la POLITIQUE — et non par lui — doit
    // cesser d'être valable à la seconde même, sinon la bascule ne protège de rien.
    const { transport, sent } = spyTransport();
    await setMailSendPolicy(MailSendPolicy.AUTO_SEND, userId);
    const intent = await createOutboundIntent(draft());
    expect(intent.status).toBe(OutboundMailStatus.APPROVED);

    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    if (!r.ok && r.blocked) expect(r.decision.reason).toBe("approval-required");
    expect(sent).toHaveLength(0);

    // Et l'état affiché redevient honnête : « attend votre accord ».
    const after = await prisma.outboundMailIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
  });

  it("BROUILLONS SEULEMENT : même approuvé, rien ne part", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    await setMailSendPolicy(MailSendPolicy.DRAFT_ONLY, userId);

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    if (!r.ok && r.blocked) expect(r.decision.reason).toBe("draft-only");
    expect(sent).toHaveLength(0);
  });

  it("le COUPE-CIRCUIT prime sur l'envoi autonome", async () => {
    const { transport, sent } = spyTransport();
    await setMailSendPolicy(MailSendPolicy.AUTO_SEND, userId);
    const intent = await createOutboundIntent(draft());

    await setOutboundPaused(true, userId);

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    if (!r.ok && r.blocked) expect(r.decision.reason).toBe("outbound-paused");
    expect(sent).toHaveLength(0);
  });

  it("une intention ANNULÉE ne part jamais, même approuvée avant", async () => {
    const { transport, sent } = spyTransport();
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);
    await cancelOutboundIntent(intent.id, userId, "finalement non");

    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("un échec de transport laisse une trace exploitable, pas un silence", async () => {
    const failing: MailTransport = {
      async send() { throw new Error("Gmail indisponible (503)"); },
    };
    const intent = await createOutboundIntent(draft());
    await approveOutboundIntent(intent.id, userId);

    const r = await sendOutboundIntent(intent.id, failing);
    expect(r.ok).toBe(false);

    const after = await prisma.outboundMailIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe(OutboundMailStatus.FAILED);
    expect(after?.failureReason).toContain("503");
    expect(after?.attempts).toBe(1);
  });
});
