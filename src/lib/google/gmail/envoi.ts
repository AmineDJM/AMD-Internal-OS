import { prisma } from "@/lib/prisma";
import { noterEffetExterne } from "@/lib/effets/magasin";
import { differerSiFenetre, enregistrerExecuteur, type PlanCompensation } from "@/lib/effets/fenetre";
import { RECTIFICATIF } from "@/lib/effets/executeurs";
import { GMAIL_BASE } from "../config";
import { googleJson } from "../client";
import { getActiveGoogleConnection } from "../connection";
import { buildMimeMessage, toGmailRaw } from "./mime";
import { checkRateLimits } from "@/lib/comms/loop-safety";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ENVOYER UN MAIL PAR LA BOÎTE GMAIL D'ADAM (lot P1, décision 0047) — avec la FENÊTRE D'ANNULATION (K10b).
 *
 * « Tu as accès à ton Gmail ? » : la boîte, c'est CELLE D'ADAM — l'unique connexion Google de la plateforme, contrôlée
 * contre GOOGLE_ADAM_EMAIL (`reconcile.ts adamConnection`). Mêmes portes que les outils d'Adam : la Direction ou le Super
 * Admin (`EXEC`), les freins anti-boucle (`checkRateLimits`) ; l'appelant juge le rôle. Comme pour Microsoft
 * (`courriel.graph`) : sous le geste confirmé, le courriel ne part PAS — il entre dans la file des effets
 * sortants (`courriel.gmail`) et part à l'échéance (2 min par défaut), annulable jusque-là ; parti, sa compensation est
 * un rectificatif au même destinataire (différé lui aussi). Hors geste (le worker qui exécute l'échéance), il sort.
 *
 * Il vit dans le domaine `google` (le socle `effets/` ne lit aucun domaine) et s'enregistre à l'appel — la tâche
 * `effets.sortants` l'arme avant chaque passage, comme l'exécuteur Microsoft.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MessageGmail { to: string[]; cc?: string[]; subject: string; text: string }
type Charge = { proprietaireId: string; address: string; message: MessageGmail };

/** LA BOÎTE GMAIL D'ADAM, telle qu'elle peut servir à ENVOYER — sans jeton. `null` : aucune connexion Google. */
export async function boiteGmailAdam(): Promise<{ proprietaireId: string; address: string; envoi: boolean; raison: string | null } | null> {
  const c = await prisma.googleConnection.findFirst({
    where: { status: { in: ["connected", "needs-reconnect"] } }, orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: { userId: true, address: true, status: true, paused: true, grantedScopes: true },
  });
  if (!c) return null;
  const envoi = c.status === "connected" && !c.paused && /gmail\.(modify|send|compose)|mail\.google\.com/.test(c.grantedScopes ?? "");
  const raison = c.status !== "connected" ? "le compte Google d'Adam doit être reconnecté" : c.paused ? "la liaison Google d'Adam est suspendue (coupe-circuit)"
    : envoi ? null : "le consentement Google n'accorde pas l'envoi (gmail.modify)";
  return { proprietaireId: c.userId, address: c.address, envoi, raison };
}

/** LES FREINS ANTI-BOUCLE D'ADAM (`comms/loop-safety.ts`) sur les mails Gmail de la dernière heure : `null` = permis. */
export async function freinGmail(destinataires: readonly string[]): Promise<string | null> {
  const recent = await prisma.effetSortantDiffere.findMany({
    where: { type: "courriel.gmail", creeLe: { gte: new Date(Date.now() - 3_600_000) }, statut: { notIn: ["ANNULE", "ECHEC"] } },
    select: { cible: true, creeLe: true },
  });
  const fenetre = recent.flatMap((r) => r.cible.split(/,\s*/).map((rec) => ({ recipient: rec.toLowerCase(), threadId: null, at: r.creeLe.getTime() })));
  const v = checkRateLimits({ recipients: destinataires.map((x) => x.toLowerCase()), threadId: null }, fenetre, Date.now());
  return v.allowed ? null : v.reason ?? "frein anti-boucle";
}

async function envoyerMaintenant(c: Charge): Promise<void> {
  const active = await getActiveGoogleConnection(c.proprietaireId);
  if (!active || active.address.toLowerCase() !== c.address.toLowerCase()) throw new Error("la boîte Gmail d'Adam a été déconnectée depuis : le courriel ne part pas");
  const mime = buildMimeMessage({ from: active.address, fromName: active.displayName, to: c.message.to, cc: c.message.cc, subject: c.message.subject, text: c.message.text });
  const res = await googleJson<{ id?: string }>({ method: "POST", url: `${GMAIL_BASE}/users/me/messages/send`, accessToken: active.accessToken, body: { raw: toGmailRaw(mime) } });
  if (!res.id) throw new Error("Google n'a pas confirmé l'envoi.");
}

/**
 * ENVOYER par la boîte d'Adam — sous un geste confirmé, le courriel est DIFFÉRÉ (rend son échéance) ; en simulation il
 * est neutralisé ; hors geste, il part tout de suite.
 */
export async function envoyerGmail(message: MessageGmail): Promise<{ differe: { id: string; executeLe: Date } | null; neutralise: boolean; address: string }> {
  const boite = await boiteGmailAdam();
  if (!boite?.envoi) throw new Error(boite?.raison ?? "aucune boîte Gmail reliée (Adam)");
  const cible = message.to.join(", ") || "(sans destinataire)";
  if (noterEffetExterne({ acte: "COURRIEL", cible, apercu: `« ${message.subject} »`, origine: "gmail:envoyerGmail" })) return { differe: null, neutralise: true, address: boite.address };
  const charge: Charge = { proprietaireId: boite.proprietaireId, address: boite.address, message };
  const p = await differerSiFenetre({ type: "courriel.gmail", acte: "COURRIEL", cible, apercu: `« ${message.subject} »`, charge });
  if (p) return { differe: { id: p.id, executeLe: p.executeLe }, neutralise: false, address: boite.address };
  await envoyerMaintenant(charge);
  return { differe: null, neutralise: false, address: boite.address };
}

export function enregistrerExecuteurGmail(): void {
  enregistrerExecuteur("courriel.gmail", {
    executer: async (charge) => { await envoyerMaintenant(charge as Charge); },
    compensation: async (charge, _l, motif): Promise<PlanCompensation> => {
      const c = charge as Charge;
      const r = RECTIFICATIF(c.message.subject, motif);
      return { charge: { proprietaireId: c.proprietaireId, address: c.address, message: { to: c.message.to, cc: c.message.cc, subject: r.sujet, text: r.texte } }, apercu: `« ${r.sujet} »`, phrase: `un rectificatif part à ${c.message.to.join(", ")}` };
    },
  });
}
