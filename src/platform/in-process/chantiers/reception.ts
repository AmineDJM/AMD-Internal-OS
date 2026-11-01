import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configGithub, configRender, type Env } from "@/platform/dev/config";
import type { FaitDev, Hebergeur } from "@/platform/dev/ports";
import { faitsGithub, faitsRender, verifierSignatureGithub, verifierSignatureRender } from "@/platform/dev/webhooks";

/**
 * LA RÉCEPTION DES FAITS DES CHANTIERS (lot C2) — webhook ou sondage, même chemin :
 *
 *   1. AUTORISER (webhook) — signature du corps BRUT ; sans secret configuré la source est FERMÉE (503), signature
 *      fausse → 401. Rien n'est lu avant.
 *   2. DÉDOUBLONNER — `IngestedEvent (source, externalId)` est unique : la ligne est RÉCLAMÉE sous la clé SÉMANTIQUE du
 *      fait avant toute conséquence. Une relivraison GitHub (même `X-GitHub-Delivery`), un réessai Render (même
 *      `webhook-id`), ou le même fait vu par le sondage n'inscrivent qu'UN `BusinessEvent`.
 *   3. INSCRIRE — par le port `inscrire` (la route passe `recordEvent`, le registre canonique qui réveille les missions
 *      `WAIT_EVENT`). Le socle ne connaît pas le registre : c'est la route qui l'injecte.
 */

/** Le port vers le registre d'événements : `recordEvent` de `lib/events/ledger.ts`, injecté par l'appelant. */
export type Inscrire = (e: {
  type: string;
  sourceDomain: string;
  relatedRefs: string[];
  payload: Prisma.InputJsonValue;
  occurredAt?: Date;
}) => Promise<string | null>;

export const SOURCE_DOMAINE = "DEV";

/** Les références du fait, en « TYPE:valeur » (lues par `WAIT_EVENT` : `entity: "BRANCHE:proprio/depot:claude/x"`). */
export function referencesDe(f: FaitDev): string[] {
  const r: string[] = [];
  if (f.depot) r.push(`DEPOT:${f.depot}`);
  if (f.depot && f.branche) r.push(`BRANCHE:${f.depot}:${f.branche}`);
  if (f.sha) r.push(`SHA:${f.sha}`);
  if (f.depot && f.numeroPr) r.push(`PR:${f.depot}#${f.numeroPr}`);
  if (f.serviceId) r.push(`SERVICE:${f.serviceId}`);
  if (f.deployId) r.push(`DEPLOIEMENT:${f.deployId}`);
  return r;
}

export interface BilanReception { recus: number; nouveaux: number; doublons: number; evenements: string[] }

/** Inscrit des faits déjà vérifiés (webhook) ou constatés (sondage) — exactement une fois chacun. */
export async function inscrireFaits(faits: readonly FaitDev[], inscrire: Inscrire, origine: "webhook" | "sondage"): Promise<BilanReception> {
  const bilan: BilanReception = { recus: faits.length, nouveaux: 0, doublons: 0, evenements: [] };
  for (const f of faits) {
    const source = `dev-${f.fournisseur}`;
    const externalId = f.cle.slice(0, 190);
    // La réclamation : `skipDuplicates` (ON CONFLICT DO NOTHING) — un seul gagnant, sans erreur journalisée par Prisma.
    const pris = await prisma.ingestedEvent.createMany({ data: [{ source, externalId, type: f.type, status: "RECEIVED", payload: { ...f, origine } as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
    if (pris.count === 0) { bilan.doublons += 1; continue; }
    const claim = { id: (await prisma.ingestedEvent.findUniqueOrThrow({ where: { source_externalId: { source, externalId } }, select: { id: true } })).id };
    const occurredAt = f.survenuLe && Number.isFinite(Date.parse(f.survenuLe)) ? new Date(f.survenuLe) : undefined;
    const id = await inscrire({ type: f.type, sourceDomain: SOURCE_DOMAINE, relatedRefs: referencesDe(f), payload: { ...f, origine } as unknown as Prisma.InputJsonValue, occurredAt });
    await prisma.ingestedEvent.update({ where: { id: claim.id }, data: { status: id ? "ACCEPTED" : "REJECTED", businessEventId: id, refs: referencesDe(f).slice(0, 10), reason: id ? null : "inscription au registre impossible" } });
    bilan.nouveaux += 1;
    if (id) bilan.evenements.push(id);
  }
  return bilan;
}

export type IssueWebhook = { statut: 200 | 400 | 401 | 404 | 503; bilan: BilanReception | null };

const VIDE: BilanReception = { recus: 0, nouveaux: 0, doublons: 0, evenements: [] };

function lireJson(brut: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(brut) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * UN WEBHOOK, de bout en bout : `fournisseur` = `github` | `render`. Rend le statut HTTP à répondre — laconique, le
 * détail d'un refus ne sort pas.
 */
export async function recevoirWebhook(
  fournisseur: string,
  corpsBrut: string,
  entetes: Headers,
  deps: { inscrire: Inscrire; hebergeur?: Hebergeur | null; env?: Env },
): Promise<IssueWebhook> {
  const env = deps.env ?? process.env;
  if (fournisseur === "github") {
    const secret = configGithub(env).secretWebhook;
    if (!secret) return { statut: 503, bilan: null };
    if (!verifierSignatureGithub(corpsBrut, entetes.get("x-hub-signature-256"), secret)) return { statut: 401, bilan: null };
    const corps = lireJson(corpsBrut);
    if (!corps) return { statut: 400, bilan: null };
    const faits = faitsGithub(entetes.get("x-github-event") ?? "", corps);
    return { statut: 200, bilan: faits.length ? await inscrireFaits(faits, deps.inscrire, "webhook") : VIDE };
  }
  if (fournisseur === "render") {
    const secret = configRender(env).secretWebhook;
    if (!secret) return { statut: 503, bilan: null };
    const h = { id: entetes.get("webhook-id"), horodatage: entetes.get("webhook-timestamp"), signature: entetes.get("webhook-signature") };
    if (!verifierSignatureRender(corpsBrut, h, secret)) return { statut: 401, bilan: null };
    const corps = lireJson(corpsBrut);
    if (!corps) return { statut: 400, bilan: null };
    // La charge est « mince » : le `deployId` se lit par `GET /events/{id}` — au mieux, sans bloquer la réception.
    let detail: { deployId: string | null } | null = null;
    const type = typeof corps.type === "string" ? corps.type : "";
    const evt = typeof (corps.data as { id?: unknown } | undefined)?.id === "string" ? (corps.data as { id: string }).id : null;
    if (deps.hebergeur && evt && /^(deploy|build|pre_deploy)_ended$/.test(type)) {
      const r = await deps.hebergeur.evenement(evt);
      if (r.ok) detail = { deployId: r.valeur.deployId };
    }
    const faits = faitsRender(corps, detail);
    return { statut: 200, bilan: faits.length ? await inscrireFaits(faits, deps.inscrire, "webhook") : VIDE };
  }
  return { statut: 404, bilan: null };
}
