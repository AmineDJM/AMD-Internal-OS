import { prisma } from "@/lib/prisma";
import { normaliserMoyen, type ExtractedBy, type IngestStage } from "./contract";
import { enqueue } from "./queue";
import { modeleDisponible } from "./disponibilite";
import { regrouperEchecs, type GroupeMort, type TravailMort } from "./boite-morte";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RATTRAPAGES DE LA COUCHE DE CONNAISSANCE — ce que l'ancienne file a laissé en plan.
 *
 * Trois défauts, constatés sur l'écran de production, et un geste pour chacun :
 *
 *   • DES DOCUMENTS « EN ÉCHEC » QU'ON TROUVAIT TRÈS BIEN. La mort d'un enrichissement (un
 *     vecteur, une relation) faisait passer l'élément en `FAILED` — 441 éléments sur 795, tous
 *     retrouvables par leur texte, comptés hors des « retrouvables ». La nouvelle règle ne fait
 *     plus reculer une étape ; `reparerEtapesEnEchec` rend aux anciens l'étape que leurs FAITS
 *     disent (un texte → recherchable ; une relation faite → relié ; rien → sans texte).
 *   • DES VECTEURS JAMAIS DEMANDÉS UNE SECONDE FOIS. Sans clé, l'étage `embed` rendait « rien à
 *     faire » : le travail était TERMINÉ et sa clé de dédoublonnage interdisait de le refaire.
 *     `rattraperVecteurs` remet en file, par petits lots, les documents dont la vectorisation
 *     avait été voulue et n'a pas eu lieu.
 *   • DES SCANS QUE LUNA N'A JAMAIS LUS. Même mécanisme pour la vision : `rattraperVisions`.
 *
 * Et la boîte morte, rendue ACTIONNABLE : regroupée par cause (`boite-morte.ts`) et relançable
 * par le Super Admin (`relancerTravauxMorts`).
 *
 * Tout ce qui appellerait un MODÈLE respecte la clé et l'interrupteur général (`modeleDisponible`) :
 * rien n'est mis en file que le worker refuserait ensuite de prendre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── L'étape que les faits disent ───────────────────────────────

/**
 * L'ÉTAPE D'UN ÉLÉMENT, DÉDUITE DE CE QU'IL PORTE — jamais d'un souvenir de l'ancienne file.
 * Pure : c'est elle que le banc fait parler cas par cas.
 */
export function etapeDepuisLesFaits(f: { texte: boolean; moyen: ExtractedBy | null; relie: boolean }): IngestStage {
  if (f.texte || f.moyen === "metadata") {
    if (f.relie) return "READY";
    return f.texte ? "INDEXED" : "RECEIVED";
  }
  // Sans texte : un scan routé vers la vision attend encore sa lecture ; un moyen inconnu ne
  // permet pas de conclure ; tout le reste a été LU, et il n'en est rien sorti.
  if (f.moyen === null || f.moyen === "luna") return "RECEIVED";
  return "EMPTY";
}

/** Combien d'éléments un passage répare — petit, idempotent, et le suivant reprend. */
export const REPARATIONS_PAR_PASSAGE = 50;

/**
 * RÉPARE LES ÉTAPES « EN ÉCHEC » laissées par l'ancienne règle. L'écriture est CONDITIONNELLE à
 * `FAILED` : un élément qu'un autre geste a déjà fait avancer n'est pas réécrit. Le motif
 * (`error`) est GARDÉ — c'est l'histoire de ce qui avait échoué.
 */
export async function reparerEtapesEnEchec(limit = REPARATIONS_PAR_PASSAGE, itemIds?: string[]): Promise<number> {
  const rows = await prisma.knowledgeItem.findMany({
    where: { stage: "FAILED", ...(itemIds ? { id: { in: itemIds } } : {}) },
    take: limit,
    select: { id: true, text: true, extractedBy: true },
  });
  if (!rows.length) return 0;
  const relies = await prisma.knowledgeJob.findMany({
    where: { itemId: { in: rows.map((r) => r.id) }, kind: "entities", status: "DONE" },
    select: { itemId: true },
  });
  const relie = new Set(relies.map((r) => r.itemId));
  let n = 0;
  for (const r of rows) {
    const stage = etapeDepuisLesFaits({
      texte: Boolean((r.text ?? "").trim()),
      moyen: normaliserMoyen(r.extractedBy),
      relie: relie.has(r.id),
    });
    const u = await prisma.knowledgeItem
      .updateMany({ where: { id: r.id, stage: "FAILED" }, data: { stage } })
      .catch(sansBloquer("rattrapage.reparerEtapesEnEchec.knowledgeItem", { count: 0 }));
    n += u.count;
  }
  return n;
}

// ─────────────────────────────── Les vecteurs ───────────────────────────────

/**
 * LE TARIF DE L'ENCODEUR (`text-embedding-3-small`, tarif public) en dollars par million de jetons.
 * Sert à l'ESTIMATION affichée — volontairement arrondie vers le haut, comme `lunaCostUsd`.
 */
export const PRIX_VECTEUR_PAR_M_JETONS = 0.02;
/** ~4 caractères par jeton : l'ordre de grandeur qu'emploie aussi `estimateTokens`. */
const CARACTERES_PAR_JETON = 4;

export function coutVectorisationUsd(caracteres: number): number {
  const jetons = Math.ceil(Math.max(0, caracteres) / CARACTERES_PAR_JETON);
  return Math.ceil((jetons / 1_000_000) * PRIX_VECTEUR_PAR_M_JETONS * 100) / 100; // au cent supérieur
}

/** Documents remis en file par passage. Chaque travail encode au plus 32 morceaux, puis se redemande. */
export const VECTEURS_PAR_PASSAGE = 10;

type Dispo = () => Promise<{ ok: boolean; raison: string | null }>;

/**
 * REMET EN FILE LES VECTORISATIONS VOULUES ET JAMAIS FAITES. Trois conditions : la vectorisation
 * a été DEMANDÉE un jour pour ce document (un travail `embed` existe — §18 : on ne vectorise pas
 * une tâche triviale qui n'en voulait pas) ; aucun n'est en file ni en cours ; aucun n'est en
 * boîte morte (celui-là se relance d'un clic, avec sa cause sous les yeux). Sans modèle
 * disponible, rien n'est mis en file.
 */
export async function rattraperVecteurs(limit = VECTEURS_PAR_PASSAGE, deps: { modele?: Dispo; itemIds?: string[] } = {}): Promise<number> {
  const m = await (deps.modele ?? modeleDisponible)();
  if (!m.ok) return 0;
  const filtre = deps.itemIds?.length ? deps.itemIds : null;
  const rows = await prisma.$queryRaw<{ itemId: string; restant: bigint }[]>`
    SELECT c."itemId", count(*)::bigint AS restant
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeItem" i ON i.id = c."itemId"
    WHERE c.embedding IS NULL
      AND i."isCurrent" = true
      AND (${filtre}::text[] IS NULL OR c."itemId" = ANY(${filtre}::text[]))
      AND EXISTS (SELECT 1 FROM "KnowledgeJob" j WHERE j."itemId" = c."itemId" AND j.kind = 'embed')
      AND NOT EXISTS (
        SELECT 1 FROM "KnowledgeJob" j
        WHERE j."itemId" = c."itemId" AND j.kind = 'embed' AND j.status IN ('QUEUED', 'RUNNING', 'DEAD')
      )
    GROUP BY c."itemId"
    ORDER BY max(i."updatedAt") DESC
    LIMIT ${limit}`;
  let n = 0;
  for (const r of rows) {
    const id = await enqueue({ kind: "embed", itemId: r.itemId, dedupeKey: `embed:${r.itemId}:rattrapage:${Number(r.restant)}` });
    if (id) n += 1;
  }
  return n;
}

/** Documents dont la lecture visuelle est rattrapée par passage — la vision coûte, on va doucement. */
export const VISIONS_PAR_PASSAGE = 3;

/**
 * LES SCANS QUE LUNA N'A JAMAIS LUS : routés vers la vision, toujours sans texte, leur travail
 * `vision` terminé « sans rien faire » (l'ancienne règle, sans clé). Une seule reprise par
 * document (clé de dédoublonnage fixe) : si elle ne lit rien, le document finit « sans texte
 * lisible », et ne repasse plus.
 */
export async function rattraperVisions(limit = VISIONS_PAR_PASSAGE, deps: { modele?: Dispo; itemIds?: string[] } = {}): Promise<number> {
  const m = await (deps.modele ?? modeleDisponible)();
  if (!m.ok) return 0;
  const filtre = deps.itemIds?.length ? deps.itemIds : null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM "KnowledgeItem" i
    WHERE i."isCurrent" = true
      AND i.text IS NULL
      AND i."sourceType" IN ('drive_file', 'attachment')
      AND i."extractedBy" IN ('luna', 'luna_vision')
      AND i.stage <> 'EMPTY'
      AND (${filtre}::text[] IS NULL OR i.id = ANY(${filtre}::text[]))
      AND EXISTS (SELECT 1 FROM "KnowledgeJob" j WHERE j."itemId" = i.id AND j.kind = 'vision')
      AND NOT EXISTS (
        SELECT 1 FROM "KnowledgeJob" j
        WHERE j."itemId" = i.id AND j.kind = 'vision' AND j.status IN ('QUEUED', 'RUNNING', 'DEAD')
      )
    ORDER BY i."updatedAt" DESC
    LIMIT ${limit}`;
  let n = 0;
  for (const r of rows) {
    const id = await enqueue({ kind: "vision", itemId: r.id, dedupeKey: `vision:${r.id}:rattrapage` });
    if (id) n += 1;
  }
  return n;
}

export interface EtatVectorisation {
  /** Morceaux des versions COURANTES pas encore vectorisés. */
  restants: number;
  /** Leur coût estimé (encodeur), en dollars — l'ordre de grandeur, pas une facture. */
  coutEstimeUsd: number;
}

export async function etatVectorisation(): Promise<EtatVectorisation> {
  const rows = await prisma.$queryRaw<{ n: bigint; car: bigint | null }[]>`
    SELECT count(*)::bigint AS n, sum(length(c.text))::bigint AS car
    FROM "KnowledgeChunk" c JOIN "KnowledgeItem" i ON i.id = c."itemId"
    WHERE c.embedding IS NULL AND i."isCurrent" = true`.catch(sansBloquer("rattrapage.etatVectorisation", [{ n: BigInt(0), car: BigInt(0) }]));
  const r = rows[0] ?? { n: BigInt(0), car: BigInt(0) };
  return { restants: Number(r.n), coutEstimeUsd: coutVectorisationUsd(Number(r.car ?? 0)) };
}

/**
 * pgvector EST-IL LÀ ? Une CONSTATATION, pas un texte en dur : l'écran affirmait « l'extension
 * n'est pas disponible sur cette infrastructure » sans l'avoir jamais demandé à la base. Trois
 * réponses : absente du serveur, disponible mais pas installée, installée.
 */
export type EtatPgvector = "absente" | "disponible" | "installee" | "inconnu";

export async function etatPgvector(): Promise<EtatPgvector> {
  try {
    const rows = await prisma.$queryRaw<{ installed_version: string | null }[]>`
      SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'`;
    if (!rows.length) return "absente";
    return rows[0].installed_version ? "installee" : "disponible";
  } catch {
    return "inconnu";
  }
}

// ─────────────────────────────── La boîte morte ───────────────────────────────

/** Combien de travaux morts on lit pour l'écran et pour une relance. Au-delà, la phrase le DIT. */
export const BOITE_MORTE_LUE = 2_000;
/** Combien de travaux une relance remet en file d'un clic — une limite opérationnelle, dite. */
export const RELANCE_MAX = 500;

export interface BoiteMorte {
  total: number;
  groupes: GroupeMort[];
  /** Vrai quand la boîte contient plus de travaux qu'on n'en a lus — les groupes sont alors partiels. */
  tronque: boolean;
}

export async function chargerBoiteMorte(limit = BOITE_MORTE_LUE): Promise<BoiteMorte> {
  const [total, jobs] = await Promise.all([
    prisma.knowledgeJob.count({ where: { status: "DEAD" } }),
    prisma.knowledgeJob.findMany({
      where: { status: "DEAD" },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: {
        id: true, kind: true, lastError: true, itemId: true, payload: true,
        item: { select: { title: true, sourceType: true, sourceId: true } },
      },
    }),
  ]);

  // Un travail `parse` n'a pas encore d'élément : sa source est dans sa charge utile, et le nom
  // du fichier se lit sur le nœud du Drive.
  const sourceDe = (p: unknown): { type: string | null; id: string | null } => {
    const o = (p && typeof p === "object" ? p : {}) as { sourceType?: unknown; sourceId?: unknown };
    return {
      type: typeof o.sourceType === "string" ? o.sourceType : null,
      id: typeof o.sourceId === "string" ? o.sourceId : null,
    };
  };
  const nodeIds = jobs
    .filter((j) => !j.item)
    .map((j) => sourceDe(j.payload))
    .filter((s) => s.type === "drive_file" && s.id)
    .map((s) => s.id as string);
  const nodes = nodeIds.length
    ? await prisma.driveNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } }).catch(sansBloquer("rattrapage.chargerBoiteMorte.driveNode", []))
    : [];
  const nomNoeud = new Map(nodes.map((n) => [n.id, n.name]));

  const travaux: TravailMort[] = jobs.map((j) => {
    const s = j.item ? { type: j.item.sourceType, id: j.item.sourceId } : sourceDe(j.payload);
    return {
      id: j.id,
      kind: j.kind,
      lastError: j.lastError,
      itemId: j.itemId,
      nom: j.item?.title ?? (s.id ? nomNoeud.get(s.id) ?? null : null),
      sourceType: s.type,
      sourceId: s.id,
    };
  });
  return { total, groupes: regrouperEchecs(travaux), tronque: total > jobs.length };
}

export interface ResultatRelance {
  relances: number;
  /** Éléments dont l'étape « en échec » a été réparée au passage. */
  etapesReparees: number;
  /** Ce qui reste en boîte morte après ce geste. */
  restants: number;
  /** Vrai quand le groupe dépassait `RELANCE_MAX` : un second clic reprend la suite. */
  borne: boolean;
}

/**
 * RELANCE DEPUIS LA BOÎTE MORTE — un groupe (par sa clé) ou tout.
 *
 * Les identifiants sont RECALCULÉS ici depuis la base : l'écran ne transmet qu'une clé de groupe,
 * jamais une liste qu'une requête forgée pourrait gonfler. Chaque travail repart PROPREMENT —
 * essais remis à zéro, reports effacés, dû tout de suite — et l'écriture est conditionnelle à
 * `DEAD` : deux clics simultanés ne relancent pas deux fois, et un second clic après le premier
 * ne trouve plus rien (idempotent). Le dernier motif est GARDÉ dans `lastError` : s'il échoue de
 * nouveau pour la même raison, on le saura.
 */
export async function relancerTravauxMorts(opts: { cle?: string | null; limite?: number } = {}): Promise<ResultatRelance> {
  const limite = Math.max(1, Math.min(opts.limite ?? RELANCE_MAX, RELANCE_MAX));
  const boite = await chargerBoiteMorte();
  const groupes = opts.cle ? boite.groupes.filter((g) => g.cle === opts.cle) : boite.groupes;
  const tous = groupes.flatMap((g) => g.ids);
  const ids = tous.slice(0, limite);
  if (!ids.length) return { relances: 0, etapesReparees: 0, restants: boite.total, borne: false };

  const relances = await prisma.$executeRaw`
    UPDATE "KnowledgeJob"
    SET status = 'QUEUED',
        attempts = 0,
        "runAfter" = now(),
        "claimedAt" = NULL,
        "finishedAt" = NULL,
        payload = CASE WHEN jsonb_typeof(payload) = 'object' THEN payload - '_reports' ELSE payload END,
        "lastError" = left('Relancé depuis la boîte morte — motif précédent : ' || coalesce("lastError", '—'), 500)
    WHERE id = ANY(${ids}::text[]) AND status = 'DEAD'`;

  const itemIds = await prisma.knowledgeJob
    .findMany({ where: { id: { in: ids }, itemId: { not: null } }, select: { itemId: true } })
    .then((r) => [...new Set(r.map((x) => x.itemId as string))]);
  const etapesReparees = itemIds.length ? await reparerEtapesEnEchec(itemIds.length, itemIds) : 0;
  const restants = await prisma.knowledgeJob.count({ where: { status: "DEAD" } });
  return { relances, etapesReparees, restants, borne: tous.length > ids.length };
}
