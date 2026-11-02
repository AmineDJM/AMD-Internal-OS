/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INGESTION UNIVERSELLE (mandat 5 §37), la part qui TOUCHE : autoriser → dédoublonner →
 * associer → inscrire → réveiller.
 *
 *   Event → identify → normalize → authorize → associate → trigger
 *
 * Le pur (`lib/events/ingestion.ts`) reconnaît la source, normalise la charge et DÉCIDE de
 * l'association à partir de scores. Ici, dans le pont :
 *
 *   1. AUTORISER — la signature HMAC du corps BRUT, sous le secret de la source
 *      (`EVENTS_WEBHOOK_SECRET_<SOURCE>`, sinon `EVENTS_WEBHOOK_SECRET`). Sans secret, la source
 *      est FERMÉE (503) : il n'existe pas de mode « ouvert par défaut ». Un fournisseur dont le
 *      schéma de signature diffère passe par un relais qui re-signe — le contrat est le nôtre.
 *   2. DÉDOUBLONNER — `IngestedEvent (source, externalId)` est unique : la ligne est RÉCLAMÉE avant
 *      toute conséquence, donc deux livraisons simultanées du même fait n'inscrivent qu'un
 *      `BusinessEvent` et ne réveillent qu'une fois. Sans identifiant fournisseur, l'empreinte
 *      SHA-256 du corps en tient lieu.
 *   3. ASSOCIER — les références sûres (« TYPE:id », données par nos champs personnalisés chez le
 *      fournisseur) rattachent ; les MENTIONS libres passent par la résolution d'entités (§24) et
 *      son verdict : CERTAIN rattache, PROBABLE et AMBIGU s'inscrivent « à vérifier » — jamais
 *      rattachés en silence —, INCONNU s'oublie. Une personne lève le doute (`rattacherEvenement`).
 *   4. INSCRIRE et RÉVEILLER — `recordEvent` (le registre canonique, §17 : pas de second registre)
 *      déclenche lui-même le réveil des missions WAIT_EVENT, la réconciliation des tâches et les
 *      engagements. Le fait « à vérifier » entre SANS ses références douteuses : une mission qui
 *      attend « une signature » se réveille, une mission qui attend « LA signature du contrat X »
 *      attend la levée du doute.
 *
 * Le contenu reçu est une DONNÉE : nettoyé de tout secret, borné, jamais interprété.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { createHash, createHmac } from "node:crypto";
import { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { recordEvent } from "@/lib/events/ledger";
import { verifyInboundSignature } from "@/lib/mail-smart";
import { resoudreMentions } from "@/lib/fabric/entites";
import type { TypeEntite } from "@/lib/fabric/entites-score";
import { reveillerMissions } from "@/lib/missions/events/router";
import { hasGlobalView } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import {
  SEUIL_DOUTE, SEUIL_SUR, SOURCES, decider, estRef, estSource, nettoyer, normaliserLot,
  type CandidatAssociation, type DecisionAssociation, type FaitNormalise, type Source,
} from "@/lib/events/ingestion";
import { sansBloquer } from "@/lib/journal";

export { SOURCES };
export type { Source };
// Le catalogue, pour les outils d'Adam : la frontière Adam ↔ ERP passe par le pont, jamais par `lib/events` en direct.
export { RESUME_POUR_PLANNER, CATALOGUE } from "@/lib/events/catalogue";

/** Les en-têtes où une signature peut arriver — le premier présent fait foi. */
export const EN_TETES_SIGNATURE = ["x-webhook-signature", "x-events-signature", "x-hub-signature-256", "x-hubspot-signature-v3", "x-docusign-signature-1", "svix-signature"] as const;

export type StatutIngestion = "RECEIVED" | "ACCEPTED" | "DUPLICATE" | "REJECTED" | "A_VERIFIER" | "SANS_ASSOCIATION";

export interface FaitIngere {
  externalId: string;
  type: string;
  statut: StatutIngestion;
  confiance: number | null;
  refs: string[];
  businessEventId: string | null;
  raison: string | null;
  aVerifier: CandidatAssociation[];
}

export interface ResultatIngestion {
  source: Source;
  recus: number;
  acceptes: number;
  doublons: number;
  rejetes: number;
  aVerifier: number;
  sansAssociation: number;
  faits: FaitIngere[];
}

// ─────────────────────────────── 1. AUTORISER ───────────────────────────────

/** Le secret d'une source : le sien d'abord, le commun sinon. `null` = source fermée. */
export function secretPour(source: string, env: Record<string, string | undefined> = process.env): string | null {
  const propre = (env[`EVENTS_WEBHOOK_SECRET_${source.toUpperCase()}`] ?? "").trim();
  const commun = (env.EVENTS_WEBHOOK_SECRET ?? "").trim();
  return propre || commun || null;
}

export type Autorisation = { ok: true; source: Source } | { ok: false; statut: 400 | 401 | 503; raison: string };

/** Identifier la source, exiger un secret, vérifier la signature du corps BRUT — dans cet ordre. */
export function autoriser(source: string, corpsBrut: string, signature: string | null, env: Record<string, string | undefined> = process.env): Autorisation {
  const s = source.trim().toLowerCase();
  if (!estSource(s)) return { ok: false, statut: 400, raison: `source inconnue « ${source} » — sources : ${SOURCES.join(", ")}` };
  const secret = secretPour(s, env);
  if (!secret) return { ok: false, statut: 503, raison: `aucun secret configuré pour « ${s} » (EVENTS_WEBHOOK_SECRET_${s.toUpperCase()} ou EVENTS_WEBHOOK_SECRET) : source fermée` };
  if (!verifyInboundSignature(corpsBrut, signature, secret)) return { ok: false, statut: 401, raison: "signature absente ou invalide" };
  return { ok: true, source: s };
}

/** La signature qu'un émetteur doit poser : HMAC-SHA256 hexadécimal du corps brut (préfixe « sha256= » accepté). */
export function signer(corpsBrut: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(corpsBrut, "utf8").digest("hex")}`;
}

// ─────────────────────────────── 3. ASSOCIER ───────────────────────────────

/** Le type d'entité du REGISTRE pour un type de la résolution d'entités — ceux qui n'y sont pas ne rattachent rien. */
const REF_TYPE: Partial<Record<TypeEntite, string>> = {
  PERSONNE: "USER", SOCIETE: "COMPANY", FOURNISSEUR: "SUPPLIER", PRODUIT: "REGULATORY_PRODUCT", MARQUE: "REGULATORY_PRODUCT", MEDECIN: "DOCTOR",
};
const TYPES_ENTITE_REGISTRE = new Set<string>(Object.values(EntityType));

export interface Association {
  decision: DecisionAssociation;
  confiance: number;
  refs: string[];
  candidats: CandidatAssociation[];
  aVerifier: CandidatAssociation[];
}

/**
 * Des mentions aux candidats : le VERDICT de la résolution borne le score. CERTAIN garde son
 * score (≥ seuil sûr) ; PROBABLE et AMBIGU plafonnent juste sous le seuil sûr — à vérifier, jamais
 * rattachés seuls ; INCONNU plafonne sous le seuil de doute — oublié. Deux candidats proches ne
 * font jamais un choix : c'est la règle du §24, et c'est ici qu'elle protège une mission.
 */
export async function associer(fait: FaitNormalise, resoudre: typeof resoudreMentions = resoudreMentions): Promise<Association> {
  const candidats: CandidatAssociation[] = [];
  if (fait.mentions.length) {
    const resolutions = await resoudre(fait.mentions.slice(0, 8)).catch(sansBloquer("ingestion.associer.resoudre", []));
    for (const r of resolutions) {
      for (const c of r.candidats.slice(0, 3)) {
        const type = REF_TYPE[c.type];
        if (!type) continue;
        const retenu = r.retenu?.id === c.id && r.retenu?.type === c.type;
        let confiance: number;
        if (r.verdict === "CERTAIN" && retenu) confiance = Math.max(c.score, SEUIL_SUR);
        else if ((r.verdict === "PROBABLE" && retenu) || r.verdict === "AMBIGU") confiance = Math.min(Math.max(c.score, SEUIL_DOUTE), SEUIL_SUR - 0.01);
        else confiance = Math.min(c.score, SEUIL_DOUTE - 0.01);
        candidats.push({ mention: r.requete, ref: `${type}:${c.id}`, libelle: c.libelle, confiance: Math.round(confiance * 100) / 100 });
      }
    }
  }
  return { ...decider(fait.refs, candidats), candidats };
}

/** La première référence dont le type est un type d'entité du registre : c'est elle qui porte `entityType/entityId`. */
function entitePrincipale(refs: readonly string[]): { entityType: EntityType | null; entityId: string | null } {
  for (const r of refs) {
    const [type, ...reste] = r.split(":");
    const id = reste.join(":");
    if (type && id && TYPES_ENTITE_REGISTRE.has(type)) return { entityType: type as EntityType, entityId: id };
  }
  return { entityType: null, entityId: null };
}

const empreinteDe = (v: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(v) ?? "null").digest("hex").slice(0, 40)}`;
const estDoublon = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ─────────────────────────────── 2 + 4. DÉDOUBLONNER, INSCRIRE, RÉVEILLER ───────────────────────────────

export interface OptionsIngestion {
  /** La résolution d'entités, injectable pour les bancs. Défaut : la vraie (§24). */
  resoudre?: typeof resoudreMentions;
}

/**
 * INGÈRE un corps déjà autorisé : un fait ou un lot. Rend le détail par fait — ce que la route
 * résume au fournisseur, et ce que l'outil `inbound_events` montre à la personne.
 */
export async function ingerer(source: Source, corps: unknown, opts: OptionsIngestion = {}): Promise<ResultatIngestion> {
  const items = Array.isArray(corps) ? corps : [corps];
  const normalisations = normaliserLot(source, corps);
  const faits: FaitIngere[] = [];

  for (let i = 0; i < normalisations.length; i += 1) {
    const n = normalisations[i]!;
    const brut = items[i];
    const externalId = ((n.ok ? n.fait.externalId : null) ?? empreinteDe(brut)).slice(0, 190);
    const typeInitial = n.ok ? n.fait.type : "REJETE";

    // ── LA RÉCLAMATION : la ligne d'abord, les conséquences ensuite (exactly-once) ──────
    let claim: { id: string } | null = null;
    try {
      claim = await prisma.ingestedEvent.create({
        data: { source, externalId, type: typeInitial, status: n.ok ? "RECEIVED" : "REJECTED", reason: n.ok ? null : n.rejet, payload: (n.ok ? n.fait.payload : nettoyer(brut)) as Prisma.InputJsonValue },
        select: { id: true },
      });
    } catch (e) {
      if (!estDoublon(e)) throw e;
      const deja = await prisma.ingestedEvent.findUnique({ where: { source_externalId: { source, externalId } } });
      faits.push({ externalId, type: deja?.type ?? typeInitial, statut: "DUPLICATE", confiance: deja?.confidence ?? null, refs: deja?.refs ?? [], businessEventId: deja?.businessEventId ?? null, raison: "déjà reçu", aVerifier: [] });
      continue;
    }
    if (!n.ok) { faits.push({ externalId, type: "REJETE", statut: "REJECTED", confiance: null, refs: [], businessEventId: null, raison: n.rejet, aVerifier: [] }); continue; }

    const fait = n.fait;
    const asso = await associer(fait, opts.resoudre);
    const { entityType, entityId } = entitePrincipale(asso.refs);
    const businessEventId = await recordEvent({
      type: fait.type,
      sourceDomain: fait.sourceDomain,
      actorId: null,
      entityType,
      entityId,
      relatedRefs: asso.refs,
      payload: {
        ...fait.payload,
        source, externalId, systeme: fait.emetteur.systeme,
        from: fait.emetteur.email, fromName: fait.emetteur.nom,
        mentions: fait.mentions,
        association: asso.decision, associationConfiance: asso.confiance,
        ...(asso.aVerifier.length ? { aVerifier: asso.aVerifier.map((c) => `${c.libelle} (${c.ref}, ${Math.round(c.confiance * 100)} %)`) } : {}),
        confidentiel: fait.confidentiel,
      } as Prisma.InputJsonValue,
      correlationId: `${source}:${externalId}`,
      ...(fait.occurredAt ? { occurredAt: fait.occurredAt } : {}),
    });
    const statut: StatutIngestion = asso.decision === "SURE" ? "ACCEPTED" : asso.decision;
    const raison = statut === "A_VERIFIER"
      ? `association incertaine : ${asso.aVerifier.slice(0, 3).map((c) => `« ${c.mention} » ≈ ${c.libelle} (${Math.round(c.confiance * 100)} %)`).join(" ; ")} — à rattacher par une personne`
      : statut === "SANS_ASSOCIATION" ? "aucune entité reconnue derrière les mentions" : null;
    await prisma.ingestedEvent.update({
      where: { id: claim.id },
      data: {
        status: statut, confidence: asso.confiance, businessEventId, refs: asso.refs, reason: raison,
        candidats: asso.candidats.length ? (asso.candidats as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    }).catch(sansBloquer("ingestion.ingerer.ingestedEvent"));
    faits.push({ externalId, type: fait.type, statut, confiance: asso.confiance, refs: asso.refs, businessEventId, raison, aVerifier: asso.aVerifier });
  }

  return {
    source, recus: faits.length,
    acceptes: faits.filter((f) => f.statut === "ACCEPTED").length,
    doublons: faits.filter((f) => f.statut === "DUPLICATE").length,
    rejetes: faits.filter((f) => f.statut === "REJECTED").length,
    aVerifier: faits.filter((f) => f.statut === "A_VERIFIER").length,
    sansAssociation: faits.filter((f) => f.statut === "SANS_ASSOCIATION").length,
    faits,
  };
}

// ─────────────────────────────── LA LECTURE ET LA LEVÉE DE DOUTE ───────────────────────────────

export interface EvenementRecu {
  id: string; source: string; externalId: string; type: string; statut: string; confiance: number | null;
  refs: string[]; candidats: CandidatAssociation[]; raison: string | null; recuLe: string; businessEventId: string | null;
  resume: Record<string, unknown>;
}

const CLES_RESUME = ["numero", "fournisseur", "subject", "titre", "reference", "montant", "devise", "statut", "from", "fromName", "objectId", "propriete", "periode", "typeBrut"];

/** Les faits reçus (vue globale) — les plus récents d'abord, avec ce qui reste à vérifier en tête si demandé. */
export async function listerEvenementsRecus(opts: { source?: string | null; statut?: string | null; depuis?: Date | null; limite?: number } = {}): Promise<EvenementRecu[]> {
  const rows = await prisma.ingestedEvent.findMany({
    where: {
      ...(opts.source ? { source: opts.source.toLowerCase() } : {}),
      ...(opts.statut ? { status: opts.statut.toUpperCase() } : {}),
      ...(opts.depuis ? { receivedAt: { gte: opts.depuis } } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: Math.min(Math.max(opts.limite ?? 30, 1), 100),
  });
  return rows.map((r) => {
    const p = (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload : {}) as Record<string, unknown>;
    const resume: Record<string, unknown> = {};
    for (const k of CLES_RESUME) if (p[k] !== undefined && p[k] !== null) resume[k] = p[k];
    return {
      id: r.id, source: r.source, externalId: r.externalId, type: r.type, statut: r.status, confiance: r.confidence,
      refs: r.refs, candidats: Array.isArray(r.candidats) ? (r.candidats as unknown as CandidatAssociation[]) : [],
      raison: r.reason, recuLe: r.receivedAt.toISOString(), businessEventId: r.businessEventId, resume,
    };
  });
}

/** Le décompte par statut depuis une date — la ligne de tête de l'outil. */
export async function resumeIngestion(depuis: Date): Promise<Record<string, number>> {
  const groupes = await prisma.ingestedEvent.groupBy({ by: ["status"], where: { receivedAt: { gte: depuis } }, _count: { _all: true } });
  return Object.fromEntries(groupes.map((g) => [g.status, g._count._all]));
}

export type ResultatRattachement =
  | { ok: true; id: string; refs: string[]; reveils: { missionId: string; stepKey: string }[] }
  | { ok: false; motif: string };

/**
 * UNE PERSONNE LÈVE LE DOUTE : elle rattache un fait « à vérifier » (ou sans association) à une
 * entité, en « TYPE:id » — l'une des candidates, ou une autre qu'elle connaît. Le registre est
 * complété et les missions qui attendaient CETTE entité sont réveillées. Vue globale exigée : le
 * fait touche à des dossiers qui ne sont pas forcément les siens. L'agent n'a pas cet outil
 * (`policy/guard.ts`) : un document lu ne rattache rien.
 */
export async function rattacherEvenement(user: CurrentUser, d: { id?: string | null; externalId?: string | null; ref: string }): Promise<ResultatRattachement> {
  if (!hasGlobalView(user)) return { ok: false, motif: "rattacher un fait externe exige la vue globale" };
  const ref = (d.ref ?? "").trim();
  if (!estRef(ref)) return { ok: false, motif: `référence invalide « ${d.ref} » : la forme est TYPE:id (par ex. LEGAL_DOCUMENT:ckx…)` };
  const row = d.id
    ? await prisma.ingestedEvent.findUnique({ where: { id: d.id } })
    : d.externalId ? await prisma.ingestedEvent.findFirst({ where: { externalId: d.externalId }, orderBy: { receivedAt: "desc" } }) : null;
  if (!row) return { ok: false, motif: "fait introuvable : donner son identifiant (inbound_events le montre)" };
  if (row.status === "REJECTED" || row.status === "DUPLICATE") return { ok: false, motif: `ce fait est ${row.status === "REJECTED" ? "rejeté" : "un doublon"} : rien à rattacher` };
  const refs = [...new Set([...row.refs, ref])];
  const { entityType, entityId } = entitePrincipale(refs);
  const evt = row.businessEventId
    ? await prisma.businessEvent.update({ where: { id: row.businessEventId }, data: { relatedRefs: refs, ...(entityType ? { entityType, entityId } : {}) }, select: { id: true, type: true, payload: true, actorId: true, entityType: true, entityId: true } }).catch(sansBloquer("ingestion.rattacherEvenement.businessEvent", null))
    : null;
  await prisma.ingestedEvent.update({ where: { id: row.id }, data: { status: "ACCEPTED", refs, confidence: 1, reason: `rattaché à ${ref} par ${user.name}` } });
  const reveils = evt
    ? await reveillerMissions({ type: evt.type, actorId: evt.actorId, entityType: evt.entityType, entityId: evt.entityId, relatedRefs: refs, payload: (evt.payload ?? undefined) as Prisma.InputJsonValue | undefined, missionId: null }).catch(sansBloquer("ingestion.rattacherEvenement.reveillerMissions", []))
    : [];
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "ASSISTANT", entityId: row.id, summary: `Fait externe ${row.source}/${row.type} rattaché à ${ref} (${reveils.length} mission(s) réveillée(s)).` }).catch(sansBloquer("ingestion.rattacherEvenement.recordAudit"));
  return { ok: true, id: row.id, refs, reveils };
}
