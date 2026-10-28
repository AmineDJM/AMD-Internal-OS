import { EntityType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import {
  DOMAINE_ENRICHISSEMENT, TYPE_PIECE_DEPOSEE,
  clesDeCharge, composerCharge, correlationPiece, planifierEmission, validerDepot,
  type PieceDeposeeInput, type Rattachement,
} from "./depot";

export {
  TYPE_PIECE_DEPOSEE, DOMAINE_ENRICHISSEMENT, SOURCES_DEPOT, CONFIDENTIALITES, lireChargePieceDeposee,
  type PieceDeposeeInput, type Rattachement, type SourceDepot, type ConfidentialitePiece, type ChargePieceDeposee,
} from "./depot";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `PIECE_DEPOSEE` AU REGISTRE — l'étape 1 du moteur d'enrichissement (§3-E).
 *
 * Tout point de dépôt (Drive, messagerie, e-mail, portail, poste Ad & Pro, RH, Legal…) appelle
 * `emettrePieceDeposee` APRÈS que l'écriture métier est acquise, hors transaction. Le fait passe
 * par `recordEvent` — la seule porte du registre — et hérite donc de sa règle : UN ÉVÉNEMENT NE
 * FAIT JAMAIS ÉCHOUER SON ÉMETTEUR. Ce helper ne lève pas : il rend un statut.
 *
 * ── IDEMPOTENCE ─────────────────────────────────────────────────────────────────────────────
 *
 * Tous les dépôts d'un même contenu partagent la corrélation `piece:<empreinte>` (indexée). Avant
 * d'émettre, on relit les clés déjà inscrites sous cette corrélation et l'on n'émet que les
 * rattachements nouveaux ; s'il n'y en a aucun, rien n'est écrit. Deux dépôts STRICTEMENT
 * simultanés du même fichier au même endroit peuvent encore émettre deux fois : le consommateur
 * reste donc idempotent de son côté (il retrouve la `Piece` par empreinte) — l'idempotence ici
 * évite le bruit, elle ne remplace pas celle de l'écrivain.
 *
 * ── BRANCHÉ AUX GOULOTS (lot V2-A) ──────────────────────────────────────────────────────────
 *
 * Les goulots de dépôt (`persistUploadedDocument`, `inscrireDocumentDirect`, `attachFiles`,
 * `enregistrerFichierDrive` — voir `docs/architecture/refonte-p4-points-de-depot.md` §2) l'appellent
 * par `signalement.ts`, qui pose aussi la tâche de la file persistante (`TacheEnrichissement`) ; le
 * passage `traitement.ts` est le consommateur (`ABONNEMENT_PIECE_DEPOSEE`). Interrupteur
 * `AppSetting.enrichissementActif`, fermé par défaut : ni fait ni file tant qu'il l'est.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatEmission =
  | { statut: "EMIS"; eventId: string; rattachements: Rattachement[]; dejaEmis: number }
  | { statut: "DEJA_EMIS"; dejaEmis: number }
  | { statut: "REJETE"; raison: string }
  | { statut: "ECHEC"; raison: string };

const ENTITY_TYPES: ReadonlySet<string> = new Set(Object.values(EntityType));
const estEntityType = (t: string): t is EntityType => ENTITY_TYPES.has(t);

/** Borne de relecture : au-delà, la même pièce aurait été rattachée à des centaines de sujets. */
const RELECTURE_MAX = 500;

export async function emettrePieceDeposee(input: PieceDeposeeInput): Promise<ResultatEmission> {
  const v = validerDepot(input);
  if (!v.ok) {
    console.warn("[enrichissement] dépôt non émis", v.raison);
    return { statut: "REJETE", raison: v.raison };
  }
  const depot = v.depot;
  const correlationId = correlationPiece(depot.empreinte);

  try {
    const precedents = await prisma.businessEvent.findMany({
      where: { correlationId, type: TYPE_PIECE_DEPOSEE },
      select: { payload: true },
      take: RELECTURE_MAX,
    });
    const plan = planifierEmission(depot, precedents.flatMap((e) => clesDeCharge(e.payload)));
    if (plan.nouveaux.length === 0) return { statut: "DEJA_EMIS", dejaEmis: plan.dejaEmis };

    // L'ENTITÉ PRINCIPALE : le premier rattachement qui est un `EntityType` du registre ; les
    // autres (et ceux hors enum : conversation, e-mail) vont dans `relatedRefs`, où la frise
    // (`timelineOf`) les retrouve aussi.
    const principal = plan.nouveaux.find((r) => estEntityType(r.type)) ?? null;
    const eventId = await recordEvent({
      type: TYPE_PIECE_DEPOSEE,
      sourceDomain: DOMAINE_ENRICHISSEMENT,
      actorId: depot.deposeParId,
      entityType: principal ? (principal.type as EntityType) : null,
      entityId: principal?.id ?? null,
      relatedRefs: plan.nouveaux.map((r) => `${r.type}:${r.id}`),
      payload: composerCharge(depot, plan) as unknown as Prisma.InputJsonValue,
      correlationId,
      ...(depot.deposeLe ? { occurredAt: depot.deposeLe } : {}),
    });
    if (!eventId) return { statut: "ECHEC", raison: "inscription au registre impossible" };
    return { statut: "EMIS", eventId, rattachements: plan.nouveaux, dejaEmis: plan.dejaEmis };
  } catch (err) {
    console.error("[enrichissement] émission impossible", err);
    return { statut: "ECHEC", raison: "relecture du registre impossible" };
  }
}

/**
 * L'ABONNEMENT — branché par une FILE PERSISTANTE (outbox), pas par `recordEvent`.
 *
 * Le goulot pose la tâche à côté du fait (`signalement.ts`) ; le passage (`traitement.ts`,
 * `traiterLaFile`), au battement aujourd'hui, au worker demain (V2-F), crée ou retrouve la `Piece`
 * par empreinte, écrit le `PieceLien`, classe, extrait et décide. Hors requête de la personne :
 * l'extraction est lourde et ne doit jamais retarder un téléversement.
 */
export const ABONNEMENT_PIECE_DEPOSEE = {
  type: TYPE_PIECE_DEPOSEE,
  consommateur: "enrichissement.classement",
  etapeSuivante: "CLASSEMENT",
  /** Hors requête : file du worker, pas `Promise.allSettled` dans `recordEvent`. */
  execution: "WORKER",
  /** Idempotent : la `Piece` se retrouve par empreinte, le `PieceLien` par (pièce, type, id, rôle). */
  idempotence: "empreinte+rattachement",
  /** Une pièce `CONFIDENTIAL`, ou d'une nature de `NATURES_LOCALES`, ne se lit que sur ce serveur. */
  localSeulementSi: ["CONFIDENTIAL"] as const,
  branche: true,
} as const;
