import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { recordEvent } from "@/lib/events/ledger";
import { extractAttachmentText } from "@/platform/ia/media/assistant-files";
import { analyzeEmail, deservesAttention, stripQuotedReply, type EmailIntelligence } from "@/lib/comms/email-intelligence";
import { scanForInjection } from "@/lib/comms/untrusted";
import { isAutomatedSender, isBounce } from "@/lib/comms/loop-safety";
import { findMissionForInbound, recordMissionReply } from "@/lib/comms/missions";
import { getCommunicationPolicy } from "@/lib/comms/policy";
import { getActiveGoogleConnection, touchGoogleSync } from "../connection";
import { getMessage, getAttachmentBytes, type GmailMessage } from "./messages";
import { sansBloquer } from "@/lib/journal";

/**
 * CE QUI SE PASSE QUAND UN MESSAGE ARRIVE — le pipeline d'entrée d'Adam.
 *
 * Lire, comprendre, relier, se souvenir : rien de tout cela ne demande la permission de qui que
 * ce soit. L'approbation du PDG concerne la SORTIE, jamais l'entrée — un chef de cabinet qui
 * demanderait l'autorisation d'ouvrir le courrier ne servirait à rien.
 *
 * Le pipeline est IDEMPOTENT par construction : la clé `(connexion, identifiant Gmail)` est
 * unique en base. Un push rejoué, une réconciliation qui repasse sur les mêmes messages, un
 * redémarrage au mauvais moment — rien ne crée de doublon, rien ne re-notifie.
 *
 * Il est aussi SILENCIEUX par défaut : ingérer n'est pas notifier. Ne remonte au PDG que ce qui
 * répond à une attente (une mission), ce qui engage, ou ce qui tente de manipuler l'assistant.
 */

/** Bornes : on lit tout, mais on n'extrait pas 40 Mo de vidéo pour « comprendre » un message. */
const MAX_ATTACHMENT_EXTRACT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_EXTRACTED = 5;
const EXTRACTABLE = /\.(pdf|docx?|xlsx?|xlsm|csv|pptx?|txt|md|json|xml|html?|png|jpe?g|webp|tiff?)$/i;

export interface IngestResult {
  status: "ingested" | "duplicate" | "skipped";
  emailRecordId?: string;
  importance?: string;
  missionId?: string | null;
  surfaced?: boolean;
  reason?: string;
}

/** Les domaines de l'entreprise — ce qui distingue un collègue d'un tiers. Calculé, jamais codé. */
export async function internalDomains(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { email: true }, take: 500 });
  const counts = new Map<string, number>();
  for (const u of users) {
    const d = (u.email.split("@")[1] ?? "").toLowerCase();
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  // Un domaine partagé par au moins deux comptes est un domaine d'entreprise ; une adresse
  // personnelle isolée (gmail.com du PDG) n'en fait pas un domaine interne pour autant.
  return [...counts.entries()].filter(([d, n]) => n >= 2 && !["gmail.com", "outlook.com", "hotmail.com", "yahoo.fr", "yahoo.com"].includes(d)).map(([d]) => d);
}

interface SenderResolution {
  userId: string | null;
  companyId: string | null;
  label: string;
  isKnownUser: boolean;
}

/**
 * QUI a écrit — résolu vers l'ERP quand les preuves le permettent.
 *
 * Ordre : compte interne (le plus fort), contact d'entreprise, fournisseur. On ne devine pas par
 * le nom : deux « Karim » existent, et se tromper de personne dans une mission fausse tout ce qui
 * suit.
 */
async function resolveSender(address: string): Promise<SenderResolution> {
  const email = address.toLowerCase();
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (user) return { userId: user.id, companyId: null, label: user.name, isKnownUser: true };

  const contact = await prisma.companyContact.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, name: true, companyId: true },
  });
  if (contact) return { userId: null, companyId: contact.companyId, label: contact.name, isKnownUser: false };

  const supplier = await prisma.supplier.findFirst({
    where: { contactEmail: { equals: email, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (supplier) return { userId: null, companyId: null, label: supplier.name, isKnownUser: false };

  return { userId: null, companyId: null, label: email, isKnownUser: false };
}

/** Le texte des pièces jointes — borné, tolérant : une pièce illisible ne bloque pas le message. */
async function ingestAttachments(
  accessToken: string,
  msg: GmailMessage,
  emailRecordId: string,
): Promise<{ extractedCount: number }> {
  let extracted = 0;
  for (const att of msg.attachments.slice(0, 12)) {
    let text = "";
    let note: string | null = null;
    const extractable =
      extracted < MAX_ATTACHMENTS_EXTRACTED &&
      att.sizeBytes > 0 &&
      att.sizeBytes <= MAX_ATTACHMENT_EXTRACT_BYTES &&
      EXTRACTABLE.test(att.filename);

    if (extractable && att.attachmentId) {
      try {
        const bytes = await getAttachmentBytes(accessToken, msg.id, att.attachmentId);
        const res = await extractAttachmentText(att.filename, bytes);
        text = res.text;
        note = res.note;
        if (text) extracted += 1;
      } catch {
        note = "Pièce non téléchargeable au moment de l'ingestion.";
      }
    } else if (!extractable) {
      note = att.sizeBytes > MAX_ATTACHMENT_EXTRACT_BYTES
        ? "Pièce trop volumineuse pour une lecture automatique — ouvrable à la demande."
        : "Format non extractible automatiquement — ouvrable à la demande.";
    }

    await prisma.emailAttachmentRecord.create({
      data: {
        emailRecordId,
        providerAttachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        extractedText: text ? text.slice(0, 60_000) : null,
        extractionNote: note,
      },
    });
  }
  return { extractedCount: extracted };
}

/**
 * INGÈRE un message : de l'identifiant Gmail à la conscience d'Adam.
 *
 * `force` sert à la réingestion volontaire (diagnostic) ; par défaut, un message déjà connu est
 * ignoré sans bruit — c'est ce qui rend les rejeux de webhook inoffensifs.
 */
export async function ingestMessage(
  connectionId: string,
  providerMessageId: string,
  opts: { force?: boolean; domains?: string[] } = {},
): Promise<IngestResult> {
  const existing = await prisma.emailRecord.findUnique({
    where: { connectionId_providerMessageId: { connectionId, providerMessageId } },
    select: { id: true },
  });
  if (existing && !opts.force) return { status: "duplicate", emailRecordId: existing.id };

  const conn = await prisma.googleConnection.findUnique({
    where: { id: connectionId },
    select: { userId: true, address: true, paused: true },
  });
  if (!conn) return { status: "skipped", reason: "connexion introuvable" };
  if (conn.paused) return { status: "skipped", reason: "intégration Google suspendue" };

  const policy = await getCommunicationPolicy();
  if (policy.inboundPaused) return { status: "skipped", reason: "traitement de la boîte suspendu" };

  const active = await getActiveGoogleConnection(conn.userId);
  if (!active) return { status: "skipped", reason: "compte Google non connecté" };

  const msg = await getMessage(active.accessToken, providerMessageId);
  const outgoing = msg.from.address === conn.address.toLowerCase();

  const sender = await resolveSender(msg.from.address);
  const cleanBody = stripQuotedReply(msg.bodyText);
  const injection = scanForInjection(`${msg.subject}\n${cleanBody}`);
  const domains = opts.domains ?? (await internalDomains());

  const intel: EmailIntelligence = analyzeEmail({
    subject: msg.subject,
    body: msg.bodyText,
    fromAddress: msg.from.address,
    internalDomains: domains,
    senderIsKnownUser: sender.isKnownUser,
    hasAttachments: msg.attachments.length > 0,
    injectionFlags: injection.flags,
  });

  // Une machine (auto-répondeur, liste, rejet de remise) est ENREGISTRÉE — elle fait partie de
  // l'histoire du fil — mais ne remonte jamais au PDG et ne compte pas comme une réponse.
  const automated = isAutomatedSender({ from: msg.from.address, subject: msg.subject, headers: msg.headers });
  const bounce = isBounce({ from: msg.from.address, subject: msg.subject, headers: msg.headers });

  const mission = outgoing || automated || bounce
    ? null
    : await findMissionForInbound({
        ownerId: conn.userId,
        threadId: msg.threadId,
        fromAddress: msg.from.address,
        senderUserId: sender.userId,
      });

  const record = await prisma.emailRecord.upsert({
    where: { connectionId_providerMessageId: { connectionId, providerMessageId } },
    create: {
      connectionId,
      providerMessageId,
      threadId: msg.threadId,
      rfcMessageId: msg.rfcMessageId,
      inReplyTo: msg.inReplyTo,
      referencesHeader: msg.references,
      direction: outgoing ? "OUTBOUND" : "INBOUND",
      fromAddress: msg.from.address,
      fromName: msg.from.name ?? sender.label,
      toAddresses: msg.to.map((a) => a.address),
      ccAddresses: msg.cc.map((a) => a.address),
      subject: msg.subject,
      snippet: (cleanBody || msg.snippet).slice(0, 4000),
      sentAt: msg.sentAt,
      labels: msg.labelIds,
      hasAttachments: msg.attachments.length > 0,
      senderUserId: sender.userId,
      senderCompanyId: sender.companyId,
      semantics: intel as never,
      importance: intel.importance,
      missionId: mission?.missionId ?? null,
      processedAt: new Date(),
    },
    update: {
      semantics: intel as never,
      importance: intel.importance,
      missionId: mission?.missionId ?? null,
      processedAt: new Date(),
    },
    select: { id: true },
  });

  if (msg.attachments.length > 0) {
    await prisma.emailAttachmentRecord.deleteMany({ where: { emailRecordId: record.id } });
    await ingestAttachments(active.accessToken, msg, record.id).catch(sansBloquer("ingest.ingestMessage.ingestAttachments", { extractedCount: 0 }));
  }

  if (mission && !outgoing) {
    await recordMissionReply({
      missionId: mission.missionId,
      fromAddress: msg.from.address,
      senderUserId: sender.userId,
      note: cleanBody.slice(0, 1500),
      emailRecordId: record.id,
    }).catch(sansBloquer("ingest.ingestMessage.recordMissionReply"));
  }

  /**
   * LE FAIT « UN E-MAIL EST ARRIVÉ » ENTRE AU REGISTRE (§17 : un seul registre) — et c'est ce
   * fait qui RÉVEILLE les missions RUNTIME en attente (« continue quand Sarah répond avec le
   * contrat ») : `recordEvent` → `reveillerMissions` → le battement fait avancer. La charge
   * utile porte le FIL, l'OBJET et les NOMS DE PIÈCES : c'est sur eux que l'attente typée se
   * décide — « je te l'envoie demain » SANS pièce ne règle pas une attente qui exige la pièce.
   *
   * L'EXACTLY-ONCE est structurel : un webhook rejoué sort en « duplicate » AVANT ce point
   * (clé unique connexion+message), donc le fait ne s'inscrit qu'une fois par message. Les
   * machines (auto-répondeurs, rejets) n'émettent pas : une mission ne se réveille pas sur un
   * accusé automatique.
   */
  if (!outgoing && !automated && !bounce) {
    await recordEvent({
      type: "EMAIL_RECEIVED",
      sourceDomain: "comms",
      actorId: sender.userId,
      entityType: null,
      entityId: null,
      relatedRefs: [`EMAIL:${record.id}`, ...(msg.threadId ? [`EMAIL_THREAD:${msg.threadId}`] : [])],
      payload: {
        from: msg.from.address,
        fromName: msg.from.name ?? sender.label,
        subject: msg.subject,
        threadId: msg.threadId,
        rfcMessageId: msg.rfcMessageId,
        inReplyTo: msg.inReplyTo,
        hasAttachments: msg.attachments.length > 0,
        attachments: msg.attachments.map((a) => a.filename).filter(Boolean).slice(0, 24),
        emailRecordId: record.id,
        linkedMissionId: mission?.missionId ?? null,
      },
      // JAMAIS cadré à une mission : un e-mail est un fait GLOBAL — la mission de coordination
      // qui suit ce fil n'est pas forcément celle, RUNTIME, qui attend cette réponse pour
      // continuer. Cadrer ici empêcherait l'une de se réveiller parce que l'autre existe.
      missionId: null,
    }).catch(sansBloquer("ingest.ingestMessage.recordEvent", null));
  }

  let surfaced = false;
  if (!outgoing && !automated && !bounce) {
    const attention = deservesAttention(intel, { awaitedInMission: Boolean(mission) });
    if (attention) {
      const who = sender.label || msg.from.address;
      const why = mission ? "réponse attendue dans une mission" : intel.reasons[0] ?? "message important";
      await notifyUser({
        userId: conn.userId,
        type: "GENERIC",
        title: `Courriel : ${who}`,
        body: `${msg.subject || "(sans objet)"} — ${why}`,
        link: "/chief-of-staff",
      }).catch(sansBloquer("ingest.ingestMessage.notifyUser"));
      await prisma.emailRecord.update({ where: { id: record.id }, data: { surfacedAt: new Date() } });
      surfaced = true;
    }
  }

  await prisma.gmailIngestionState.updateMany({
    where: { connectionId },
    data: { ingestedCount: { increment: 1 } },
  });
  await touchGoogleSync(connectionId);

  return {
    status: "ingested",
    emailRecordId: record.id,
    importance: intel.importance,
    missionId: mission?.missionId ?? null,
    surfaced,
  };
}

/** Ingère une liste d'identifiants, sans jamais laisser un message fautif arrêter les autres. */
export async function ingestMessages(connectionId: string, ids: string[]): Promise<{ ingested: number; duplicates: number; failed: number }> {
  const domains = await internalDomains();
  let ingested = 0;
  let duplicates = 0;
  let failed = 0;
  for (const id of ids.slice(0, 100)) {
    try {
      const res = await ingestMessage(connectionId, id, { domains });
      if (res.status === "ingested") ingested += 1;
      else if (res.status === "duplicate") duplicates += 1;
    } catch (err) {
      failed += 1;
      console.error("[adam][ingest] message ignoré", { id, error: err instanceof Error ? err.message.slice(0, 120) : "inconnu" });
    }
  }
  return { ingested, duplicates, failed };
}
