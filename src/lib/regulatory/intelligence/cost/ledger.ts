import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { callLuna, lunaModel, type LunaCallInput, type LunaResult, type LunaUsage } from "@/lib/openai-luna";
import { sansBloquer } from "@/lib/journal";

/**
 * LE REGISTRE DES COÛTS — « combien coûte ce dossier, et à cause de quoi ? »
 *
 * Trois choses, indissociables :
 *   1. **Tracer** chaque appel au niveau du DOSSIER, de l'ÉTAPE et du FICHIER. Un total global
 *      ne sert à rien : ce qu'on veut savoir, c'est quel document ou quelle étape mange le
 *      budget, pour le corriger.
 *   2. **Ne jamais payer deux fois.** L'entrée d'un appel est réduite à une empreinte
 *      (`cacheKey`) ; si la même analyse a déjà été faite — typiquement un fichier INCHANGÉ
 *      entre la V1 et la V2 d'un dossier — on relit le résultat au lieu de le racheter.
 *   3. **S'arrêter** quand le budget du dossier est atteint, et le DIRE, plutôt que de laisser
 *      filer la facture en silence.
 *
 * Ne lève jamais : un problème de comptabilité ne doit pas faire échouer une analyse.
 */

export interface CallContext {
  dossierId?: string | null;
  dossierVersionId?: string | null;
  documentId?: string | null;
  /** « classify » | « review » | « facts » | « reserve-extract » | « reserve-similar »… */
  step: string;
}

/**
 * Empreinte de l'entrée d'un appel. Deux appels identiques (même modèle, même consigne, même
 * contenu, même schéma) donnent la même clé — et donc le même résultat sans repayer.
 * Les images comptent par leur propre empreinte : une page rastérisée identique se reconnaît.
 */
export function cacheKeyOf(step: string, model: string, input: LunaCallInput): string {
  const h = createHash("sha256");
  h.update(step).update("\u0000").update(model).update("\u0000");
  h.update(input.system ?? "").update("\u0000").update(input.user).update("\u0000");
  h.update(input.jsonSchema ? JSON.stringify(input.jsonSchema.schema) : "").update("\u0000");
  if (input.jsonObject) h.update("json_object"); // n'altère PAS les clés existantes (drapeau absent = octets identiques)
  for (const img of input.images ?? []) h.update(createHash("sha256").update(img.buffer).digest("hex"));
  return h.digest("hex");
}

const ZERO_USAGE: LunaUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

// ───────────────────────────── Budget ─────────────────────────────

export interface BudgetState {
  /** Dépensé à ce jour sur le dossier, en dollars. */
  spentUsd: number;
  /** Plafond applicable (dossier, sinon plafond global), ou null si aucun. */
  limitUsd: number | null;
  /** Le plafond est-il atteint ? */
  exhausted: boolean;
  remainingUsd: number | null;
}

/** Plafond global de repli, réglable sans toucher au code. */
function globalLimitUsd(): number | null {
  const raw = Number(process.env.CTD_BUDGET_USD_DEFAULT);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Où en est le budget d'un dossier ? */
export async function budgetState(dossierId: string): Promise<BudgetState> {
  try {
    const [dossier, agg] = await Promise.all([
      prisma.regulatoryDossier.findUnique({ where: { id: dossierId }, select: { aiBudgetUsd: true } }),
      prisma.regulatoryAiCall.aggregate({ where: { dossierId, fromCache: false }, _sum: { costUsd: true } }),
    ]);
    const spentUsd = toNumber(agg._sum.costUsd ?? 0);
    const limitUsd = dossier?.aiBudgetUsd != null ? toNumber(dossier.aiBudgetUsd) : globalLimitUsd();
    return {
      spentUsd,
      limitUsd,
      exhausted: limitUsd != null && spentUsd >= limitUsd,
      remainingUsd: limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null,
    };
  } catch (e) {
    console.error("[ctd-cost] lecture du budget impossible", e);
    // En cas de doute on N'ARRÊTE PAS l'analyse : une panne de comptabilité ne doit pas
    // bloquer le travail réglementaire. L'appel sera simplement mal tracé.
    return { spentUsd: 0, limitUsd: null, exhausted: false, remainingUsd: null };
  }
}

// ───────────────────────────── Appel tracé ─────────────────────────────

export interface TrackedResult<T = unknown> extends LunaResult<T> {
  /** Vrai si le résultat vient du cache (coût réel nul). */
  cached: boolean;
  /** Vrai si l'appel a été refusé faute de budget. */
  budgetExceeded?: boolean;
}

/**
 * Appelle le modèle économique en **traçant le coût** et en **réutilisant** tout résultat déjà
 * calculé pour la même entrée.
 *
 * Ordre des opérations, qui est aussi l'ordre des économies :
 *   1. cache → 0 $ ;
 *   2. budget épuisé → on refuse proprement, sans appeler ;
 *   3. appel réel → tracé jusqu'au fichier près.
 */
export async function trackedLuna<T = unknown>(ctx: CallContext, input: LunaCallInput): Promise<TrackedResult<T>> {
  const model = input.model ?? lunaModel();
  const key = cacheKeyOf(ctx.step, model, input);

  // 1) Déjà calculé ? On ne repaie pas.
  try {
    const hit = await prisma.regulatoryAiCache.findUnique({ where: { cacheKey: key } });
    if (hit) {
      await prisma.regulatoryAiCache.update({
        where: { id: hit.id },
        data: { hits: { increment: 1 }, lastHitAt: new Date() },
      }).catch(sansBloquer("cost-ledger.trackedLuna.regulatoryAiCache"));
      await record(ctx, { model, usage: ZERO_USAGE, ok: true, cacheKey: key, fromCache: true, latencyMs: 0 });
      let data: T | undefined;
      if (input.jsonSchema) { try { data = JSON.parse(hit.payload) as T; } catch { /* payload non JSON */ } }
      return { ok: true, configured: true, text: hit.payload, data, usage: ZERO_USAGE, cached: true };
    }
  } catch (e) {
    console.error("[ctd-cost] lecture du cache impossible", e);
  }

  // 2) Budget épuisé → on refuse AVANT de dépenser.
  if (ctx.dossierId) {
    const b = await budgetState(ctx.dossierId);
    if (b.exhausted) {
      await record(ctx, { model, usage: ZERO_USAGE, ok: false, errorCode: "budget_exceeded", cacheKey: key, fromCache: false });
      return {
        ok: false, configured: true, text: "", usage: ZERO_USAGE, cached: false, budgetExceeded: true,
        error: `Budget IA du dossier atteint (${b.spentUsd.toFixed(2)} $ sur ${b.limitUsd?.toFixed(2)} $). Augmentez-le pour poursuivre l'analyse.`,
      };
    }
  }

  // 3) Appel réel.
  const t0 = Date.now();
  const res = await callLuna<T>({ ...input, model });
  const latencyMs = Date.now() - t0;
  await record(ctx, {
    model, usage: res.usage, ok: res.ok, errorCode: res.ok ? null : res.error ?? "error",
    cacheKey: key, fromCache: false, latencyMs,
  });

  // Mémoriser le résultat pour ne plus jamais le repayer.
  if (res.ok && res.text) {
    await prisma.regulatoryAiCache.create({
      data: { cacheKey: key, step: ctx.step, model, payload: res.text },
    }).catch(sansBloquer("cost-ledger.trackedLuna.regulatoryAiCache"));
  }

  return { ...res, cached: false };
}

async function record(
  ctx: CallContext,
  d: { model: string; usage: LunaUsage; ok: boolean; errorCode?: string | null; cacheKey: string; fromCache: boolean; latencyMs?: number },
): Promise<void> {
  try {
    await prisma.regulatoryAiCall.create({
      data: {
        dossierId: ctx.dossierId ?? null,
        dossierVersionId: ctx.dossierVersionId ?? null,
        documentId: ctx.documentId ?? null,
        step: ctx.step,
        provider: "openai",
        model: d.model,
        inputTokens: d.usage.inputTokens,
        outputTokens: d.usage.outputTokens,
        cachedTokens: d.usage.cachedInputTokens,
        costUsd: d.usage.costUsd,
        latencyMs: d.latencyMs ?? null,
        ok: d.ok,
        errorCode: d.errorCode ?? null,
        cacheKey: d.cacheKey,
        fromCache: d.fromCache,
      },
    });
  } catch (e) {
    console.error("[ctd-cost] enregistrement du coût impossible", e);
  }
}

// ───────────────────────────── Restitution ─────────────────────────────

export interface CostBreakdownRow {
  key: string;
  label: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedCalls: number;
}

// ─────────────────── Vue TRANSVERSE : le coût de l'IA sur TOUS les dossiers ───────────────────

export interface DossierCostRow {
  dossierId: string;
  reference: string;
  title: string;
  status: string;
  calls: number;
  costUsd: number;
  budgetUsd: number | null;
  exhausted: boolean;
}

export interface RegulatoryAiSpend {
  totalUsd: number;
  calls: number;
  cachedCalls: number;
  savedUsd: number;
  byStep: CostBreakdownRow[];
  byModel: CostBreakdownRow[];
  byDossier: DossierCostRow[];
}

/**
 * Le coût de l'IA n'est pas une information de dossier : c'est une information de GESTION. Sur la
 * fiche d'un dossier, elle occupait une place que le pharmacien lit à chaque passage sans jamais
 * agir dessus, et surtout elle ne répondait pas à la seule question qui compte — « combien nous
 * coûte l'analyse CTD, en tout, et à cause de quoi ». Cette vue-là est transverse, donc elle vit
 * dans l'administration.
 *
 * `companyId` cloisonne par entité (Adventum / Pharmagène / …) ; absent, on regarde tout.
 */
export async function regulatoryAiSpend(companyId?: string | null): Promise<RegulatoryAiSpend> {
  // L'appel ne porte pas d'entité : c'est son DOSSIER qui la porte. On passe donc par la relation.
  const where = companyId ? { dossier: { is: { companyId } } } : {};
  const calls = await prisma.regulatoryAiCall.findMany({
    where,
    select: { step: true, model: true, dossierId: true, costUsd: true, inputTokens: true, outputTokens: true, fromCache: true },
  });

  const group = (pick: (c: (typeof calls)[number]) => string | null): CostBreakdownRow[] => {
    const m = new Map<string, CostBreakdownRow>();
    for (const c of calls) {
      const key = pick(c) ?? "—";
      const row = m.get(key) ?? { key, label: key, calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedCalls: 0 };
      row.calls += 1;
      row.costUsd += toNumber(c.costUsd);
      row.inputTokens += c.inputTokens;
      row.outputTokens += c.outputTokens;
      if (c.fromCache) row.cachedCalls += 1;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
  };

  const totalUsd = calls.reduce((s, c) => s + toNumber(c.costUsd), 0);
  const paid = calls.filter((c) => !c.fromCache);
  const cachedCalls = calls.length - paid.length;
  const avgPaid = paid.length > 0 ? totalUsd / paid.length : 0;

  // Un dossier par ligne, le plus cher en tête — avec son plafond, réglable ici même.
  const byDossierRaw = group((c) => c.dossierId);
  const ids = byDossierRaw.map((r) => r.key).filter((k) => k !== "—");
  const dossiers = ids.length
    ? await prisma.regulatoryDossier.findMany({
        where: { id: { in: ids } },
        select: { id: true, reference: true, title: true, status: true, aiBudgetUsd: true },
      }).catch(sansBloquer("cost-ledger.regulatoryAiSpend.regulatoryDossier", []))
    : [];
  const meta = new Map(dossiers.map((d) => [d.id, d]));
  const byDossier: DossierCostRow[] = byDossierRaw
    .filter((r) => meta.has(r.key))
    .map((r) => {
      const d = meta.get(r.key)!;
      const budgetUsd = d.aiBudgetUsd != null ? toNumber(d.aiBudgetUsd) : null;
      return {
        dossierId: d.id,
        reference: d.reference,
        title: d.title,
        status: d.status,
        calls: r.calls,
        costUsd: r.costUsd,
        budgetUsd,
        exhausted: budgetUsd != null && r.costUsd >= budgetUsd,
      };
    });

  return {
    totalUsd,
    calls: calls.length,
    cachedCalls,
    savedUsd: cachedCalls * avgPaid,
    byStep: group((c) => c.step),
    byModel: group((c) => c.model),
    byDossier,
  };
}
