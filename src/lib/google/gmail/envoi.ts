import { OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { noterEffetExterne } from "@/lib/effets/magasin";
import { differerSiFenetre, enregistrerExecuteur, type ExecuteurEffetSortant, type PlanCompensation } from "@/lib/effets/fenetre";
import { RECTIFICATIF } from "@/lib/effets/executeurs";
import { approveOutboundIntent, cancelOutboundIntent, checkRateLimits, createOutboundIntent, gmailTransport, rouvrirOutboundIntent, sendOutboundIntent } from "./transport";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CANAL MAIL D'ADAM POUR L'ASSISTANT IA (lot P1, décision 0047).
 *
 * Direction, 02/11 : « quand je parle de boîte mail, je parle de celle d'ADAM ». L'Assistant IA écrit par la MÊME
 * machine à états que l'écran d'Adam — l'intention d'envoi (`comms/outbound.ts`, `OutboundMailIntent`) :
 *
 *   préparer  → `createOutboundIntent` (identité vérifiée : la connexion Google d'Adam, connectée, non suspendue ;
 *               empreinte du contenu ; doublon de 24 h rendu tel quel ; état initial selon la politique d'envoi) ;
 *   confirmer → `approveOutboundIntent` au nom de la personne qui confirme (tracée : `approvedById`), puis l'envoi est
 *               DIFFÉRÉ dans la fenêtre d'annulation (K10b, effet `courriel.gmail`, charge = l'id de l'intention) ;
 *   échéance  → `sendOutboundIntent(id, gmailTransport)` : politique RELUE, identité RELUE, contenu = celui approuvé,
 *               verrou atomique APPROVED → SENDING → SENT (jamais deux envois), `mail.sent` émis ;
 *   annuler dans la fenêtre → l'intention passe à CANCELLED (rien n'est parti) ; rétablir → APPROVED de nouveau ;
 *   parti puis annulé → un RECTIFICATIF, lui-même une intention de la même machine, différé à son tour.
 *
 * Un BROUILLON (si la personne le demande) est une intention laissée en DRAFT : elle attend à l'écran d'Adam.
 * Les droits sont ceux des outils Gmail d'Adam (Direction, Super Admin) — jugés par l'appelant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MessageGmail { to: string[]; cc?: string[]; subject: string; text: string; /** Le rendu du gabarit (multipart text + html). */ html?: string | null }
type Charge = { outboundId: string };

/** LA BOÎTE GMAIL D'ADAM, telle qu'elle peut servir à ENVOYER — sans jeton. `null` : aucune connexion Google. */
export async function boiteGmailAdam(): Promise<{ connectionId: string; proprietaireId: string; address: string; envoi: boolean; raison: string | null } | null> {
  // L'IDENTITÉ D'ADAM : la connexion dont l'adresse est GOOGLE_ADAM_EMAIL quand elle est posée (la règle de la connexion
  // Google, `config.ts`) ; sinon la plus ancienne connectée (`reconcile.ts adamConnection`).
  const adam = process.env.GOOGLE_ADAM_EMAIL?.trim().toLowerCase();
  const c = await prisma.googleConnection.findFirst({
    where: { status: { in: ["connected", "needs-reconnect"] }, ...(adam ? { address: { equals: adam, mode: "insensitive" as const } } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: { id: true, userId: true, address: true, status: true, paused: true, grantedScopes: true },
  });
  if (!c) return null;
  const envoi = c.status === "connected" && !c.paused && /gmail\.(modify|send|compose)|mail\.google\.com/.test(c.grantedScopes ?? "");
  const raison = c.status !== "connected" ? "le compte Google d'Adam doit être reconnecté" : c.paused ? "la liaison Google d'Adam est suspendue (coupe-circuit)"
    : envoi ? null : "le consentement Google n'accorde pas l'envoi (gmail.modify)";
  return { connectionId: c.id, proprietaireId: c.userId, address: c.address, envoi, raison };
}

/** LES FREINS ANTI-BOUCLE D'ADAM (`comms/loop-safety.ts`) sur ses envois de la dernière heure : `null` = permis. */
export async function freinGmail(destinataires: readonly string[]): Promise<string | null> {
  const boite = await boiteGmailAdam();
  if (!boite) return null;
  const recent = await prisma.outboundMailIntent.findMany({
    where: { userId: boite.proprietaireId, status: { in: [OutboundMailStatus.SENT, OutboundMailStatus.SENDING] }, updatedAt: { gte: new Date(Date.now() - 3_600_000) } },
    select: { recipients: true, providerThreadId: true, sentAt: true, updatedAt: true },
  });
  const fenetre = recent.flatMap((r) => r.recipients.map((rec) => ({ recipient: rec.toLowerCase(), threadId: r.providerThreadId, at: (r.sentAt ?? r.updatedAt).getTime() })));
  const v = checkRateLimits({ recipients: destinataires.map((x) => x.toLowerCase()), threadId: null }, fenetre, Date.now());
  return v.allowed ? null : v.reason ?? "frein anti-boucle";
}

/** PRÉPARER — l'intention d'envoi d'Adam (état initial selon sa politique). Lève si la boîte ne peut pas envoyer. */
export async function preparerMailAdam(message: MessageGmail, preparePour: { id: string; name: string }): Promise<{ outboundId: string; statut: string; address: string }> {
  const boite = await boiteGmailAdam();
  if (!boite?.envoi) throw new Error(boite?.raison ?? "la boîte Gmail d'Adam n'est pas reliée");
  const i = await createOutboundIntent({
    connectionId: boite.connectionId, userId: boite.proprietaireId, recipients: message.to, cc: message.cc ?? [],
    subject: message.subject, bodyText: message.text, bodyHtml: message.html ?? null, generatedBy: "assistant-ia", reason: `Préparé par l'Assistant IA pour ${preparePour.name} (${preparePour.id})`,
  });
  return { outboundId: i.id, statut: i.status, address: boite.address };
}

/**
 * CONFIRMER — `brouillon` : l'intention reste en DRAFT (elle attend à l'écran d'Adam). Sinon : approuvée au nom de qui
 * confirme, puis différée (sous un geste confirmé) ; hors geste, envoyée tout de suite par la même machine.
 */
export async function confirmerMailAdam(outboundId: string, parId: string, opts: { brouillon?: boolean } = {}): Promise<{ differe: { id: string; executeLe: Date } | null; neutralise: boolean; brouillon: boolean }> {
  const i = await prisma.outboundMailIntent.findUnique({ where: { id: outboundId }, select: { status: true, recipients: true, subject: true } });
  if (!i) throw new Error("intention d'envoi introuvable");
  if (i.status === OutboundMailStatus.SENT) return { differe: null, neutralise: false, brouillon: false };
  if (opts.brouillon) {
    if (i.status !== OutboundMailStatus.DRAFT) await prisma.outboundMailIntent.update({ where: { id: outboundId }, data: { status: OutboundMailStatus.DRAFT, approvedHash: null } });
    return { differe: null, neutralise: false, brouillon: true };
  }
  const cible = i.recipients.join(", ") || "(sans destinataire)";
  if (noterEffetExterne({ acte: "COURRIEL", cible, apercu: `« ${i.subject} »`, origine: "gmail:confirmerMailAdam" })) return { differe: null, neutralise: true, brouillon: false };
  const a = await approveOutboundIntent(outboundId, parId);
  if ("error" in a) throw new Error(a.error);
  const p = await differerSiFenetre({ type: "courriel.gmail", acte: "COURRIEL", cible, apercu: `« ${i.subject} »`, charge: { outboundId } satisfies Charge });
  if (p) return { differe: { id: p.id, executeLe: p.executeLe }, neutralise: false, brouillon: false };
  const r = await sendOutboundIntent(outboundId, gmailTransport);
  if (!r.ok) throw new Error("blocked" in r && r.blocked ? r.message : (r as { error: string }).error);
  return { differe: null, neutralise: false, brouillon: false };
}

/** L'EXÉCUTEUR de la fenêtre : à l'échéance, la machine d'Adam envoie (tout est relu) ; annulé, l'intention l'est aussi. */
export const EXECUTEUR_GMAIL: ExecuteurEffetSortant = {
  executer: async (charge) => {
    const r = await sendOutboundIntent((charge as Charge).outboundId, gmailTransport);
    if (!r.ok) throw new Error("blocked" in r && r.blocked ? r.message : (r as { error: string }).error);
  },
  compensation: async (charge, ligne, motif): Promise<PlanCompensation> => {
    const o = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: (charge as Charge).outboundId }, select: { connectionId: true, userId: true, recipients: true, cc: true, subject: true } });
    const r = RECTIFICATIF(o.subject, motif);
    const rect = await createOutboundIntent({ connectionId: o.connectionId, userId: o.userId, recipients: o.recipients, cc: o.cc, subject: r.sujet, bodyText: r.texte, generatedBy: "assistant-ia", reason: "rectificatif (annulation après départ)" });
    if (ligne.principalId) await approveOutboundIntent(rect.id, ligne.principalId);
    return { charge: { outboundId: rect.id } satisfies Charge, apercu: `« ${r.sujet} »`, phrase: `un rectificatif part à ${o.recipients.join(", ")}` };
  },
  surAnnulation: async (charge, _l, parId) => { await cancelOutboundIntent((charge as Charge).outboundId, parId, "annulé dans la fenêtre d'annulation"); },
  surRetablissement: async (charge, _l, parId) => { await rouvrirOutboundIntent((charge as Charge).outboundId, parId); },
};

export function enregistrerExecuteurGmail(): void {
  enregistrerExecuteur("courriel.gmail", EXECUTEUR_GMAIL);
}
