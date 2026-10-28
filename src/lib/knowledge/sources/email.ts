import { prisma } from "@/lib/prisma";
import { recordHash, clip } from "../text";
import { chunkText } from "../chunk";
import { renumber } from "../chunk";
import type { IngestInput } from "../ingest";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'E-MAIL COMME SOURCE (§17) — un message est un document, et un fil est un dossier.
 *
 * ── CE QUI EST INGÉRÉ, ET CE QUI NE L'EST PAS ────────────────────────────────────────────
 *
 * L'EN-TÊTE et le RÉSUMÉ, jamais le corps complet : l'ERP ne stocke pas les corps de messages —
 * seulement `snippet`, ce que Gmail rend. Inventer un corps qu'on n'a pas serait la pire erreur
 * possible dans une couche dont le rôle est de dire la vérité sur ce qu'elle sait.
 *
 * Les PIÈCES JOINTES ont leur propre type de source (`attachment`) et repassent par le même
 * moteur : une facture jointe à un message est un document, pas une propriété du message.
 *
 * ── POURQUOI L'EMPREINTE PORTE SUR DES CHAMPS ET NON SUR UN FICHIER ──────────────────────
 *
 * Un message n'a pas d'octets à hacher : il a des champs. `recordHash` en fait une empreinte
 * STABLE (clés triées), pour que rejouer un balayage Gmail ne retraite rien. Sans elle, chaque
 * réconciliation — il y en a une toutes les trente minutes — réécrirait toute la boîte.
 *
 * ── LE CLOISONNEMENT ─────────────────────────────────────────────────────────────────────
 *
 * `senderCompanyId` est recopié quand l'ERP l'a RÉSOLU, jamais deviné depuis un domaine. Un
 * cloisonnement fondé sur une supposition est pire que pas de cloisonnement : il rassure.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on garde d'un message. Au-delà, ce n'est plus un e-mail mais un document joint. */
const EMAIL_TEXT_CAP = 8_000;

/**
 * PRÉPARE L'INGESTION D'UN MESSAGE. Rend `null` quand il n'y a rien à indexer — un message sans
 * sujet ni extrait ne contient aucune information retrouvable, et l'indexer créerait une entrée
 * vide qui polluerait chaque recherche.
 */
export async function draftFromEmail(recordId: string): Promise<IngestInput | null> {
  const m = await prisma.emailRecord
    .findUnique({
      where: { id: recordId },
      select: {
        id: true, direction: true, subject: true, snippet: true, sentAt: true,
        fromAddress: true, fromName: true, toAddresses: true, ccAddresses: true,
        senderCompanyId: true, threadId: true, hasAttachments: true, importance: true,
      },
    })
    .catch(sansBloquer("email.draftFromEmail.emailRecord", null));
  if (!m) return null;

  const subject = (m.subject ?? "").trim();
  const snippet = (m.snippet ?? "").trim();
  if (!subject && !snippet) return null;

  // LE TEXTE INDEXÉ inclut les correspondants : « qu'a écrit Raihana en mars ? » est une question
  // qui se pose, et elle ne trouve rien si seul le corps est indexé.
  const who = m.direction === "OUTBOUND"
    ? `À : ${m.toAddresses.join(", ")}`
    : `De : ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`;
  const cc = m.ccAddresses.length ? `\nCopie : ${m.ccAddresses.join(", ")}` : "";
  const text = clip([`Objet : ${subject || "(sans objet)"}`, who + cc, "", snippet].join("\n"), EMAIL_TEXT_CAP);

  return {
    sourceType: "email",
    sourceId: m.id,
    // Les champs qui, s'ils changent, changent le SENS du message. `importance` en fait partie :
    // elle est recalculée par l'ERP et vaut la peine d'être reprise. `processedAt` n'y est pas —
    // c'est un fait sur notre traitement, pas sur le message.
    contentHash: recordHash({
      subject, snippet, from: m.fromAddress, to: m.toAddresses, cc: m.ccAddresses,
      sentAt: m.sentAt?.toISOString() ?? null, importance: m.importance,
    }),
    title: subject || `Message de ${m.fromName ?? m.fromAddress}`,
    docType: "email",
    // Recopié SEULEMENT s'il a été résolu. Deviner depuis un domaine créerait une seconde vérité
    // d'accès, qui finirait par diverger de la vraie.
    companyId: m.senderCompanyId,
    documentDate: m.sentAt,
    text,
    chunks: renumber(chunkText(text)),
    extractedBy: "metadata",
    confidence: 1,
    meta: {
      documentType: "Message",
      domain: m.direction === "OUTBOUND" ? "sortant" : "entrant",
      tags: [
        ...(m.hasAttachments ? ["avec pièces jointes"] : []),
        ...(m.importance ? [`importance ${m.importance.toLowerCase()}`] : []),
      ],
      // Le FIL, pour retrouver la conversation entière depuis un seul message.
      projectId: m.threadId,
    },
    // Pas de `classify` : le type est connu (c'est un message), et le classifieur documentaire
    // n'apprendrait rien de plus. Pas d'`embed` non plus quand il n'y a qu'un objet — vectoriser
    // « Re: Fwd: point » coûterait un appel pour un texte qui ne veut rien dire.
    deepJobs: snippet.length >= 200 ? ["entities", "embed"] : ["entities"],
  };
}

/**
 * LE RATTRAPAGE DES MESSAGES — les plus récents d'abord.
 *
 * Contrairement au Drive, on borne DANS LE TEMPS : une boîte contient des dizaines de milliers de
 * messages dont l'immense majorité n'a aucune valeur documentaire. Remonter au-delà de quelques
 * mois coûterait beaucoup pour indexer des notifications automatiques de 2021.
 */
export const EMAIL_BACKLOG_DAYS = 180;

export async function enqueueEmailBacklog(limit = 20): Promise<number> {
  try {
    const since = new Date(Date.now() - EMAIL_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
    const known = await prisma.knowledgeItem.findMany({
      where: { sourceType: "email" },
      select: { sourceId: true },
      take: 20_000,
    });
    const seen = new Set(known.map((k) => k.sourceId));

    const rows = await prisma.emailRecord.findMany({
      where: { sentAt: { gte: since } },
      orderBy: { sentAt: "desc" },
      take: limit * 5,
      select: { id: true },
    });

    const { enqueue } = await import("../queue");
    let queued = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      const id = await enqueue({
        kind: "parse",
        payload: { sourceType: "email", sourceId: r.id },
        dedupeKey: `parse:email:${r.id}`,
      });
      if (id) queued += 1;
      if (queued >= limit) break;
    }
    return queued;
  } catch (err) {
    console.error("[knowledge] email backlog failed", err);
    return 0;
  }
}
