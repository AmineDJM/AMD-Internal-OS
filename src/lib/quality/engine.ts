/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR — balayer, consigner, corriger ce qui est sûr, fermer ce qui a disparu (§23).
 *
 * Un balayage est IDEMPOTENT : le même défaut revu compte une occurrence de plus, jamais une
 * ligne de plus (signature unique en base). Un défaut écarté par une personne (DISMISSED) reste
 * écarté : le moteur n'a pas le droit de rouvrir une décision humaine. Un défaut corrigé (FIXED)
 * ou disparu (RESOLVED) qui réapparaît ROUVRE : la correction n'a pas tenu, il faut le savoir.
 *
 * Une règle qui échoue n'arrête pas les autres et ne ferme rien : on ne déclare pas « disparu »
 * ce qu'on n'a pas pu regarder. Chaque balayage laisse une ligne `DataQualitySweep` : quand,
 * quel mode, combien, en combien de temps, quelles erreurs — l'observabilité du moteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { REGLES, detecter } from "@/lib/quality/rules";
import { appliquerCorrection } from "@/lib/quality/fix";
import type { Constat } from "@/lib/quality/model";
import { sansBloquer } from "@/lib/journal";

export interface RapportRegle {
  id: string;
  constats: number;
  nouveaux: number;
  corriges: number;
  resolus: number;
  ms: number;
  erreur: string | null;
}

export interface RapportBalayage {
  mode: "FULL" | "LIGHT";
  sweepId: string | null;
  ms: number;
  regles: RapportRegle[];
  constats: number;
  nouveaux: number;
  corriges: number;
  resolus: number;
  erreurs: number;
  /** Le nombre de constats OUVERTS après le balayage — le chiffre que l'écran affiche. */
  ouverts: number;
}

const json = (x: unknown): Prisma.InputJsonValue => x as Prisma.InputJsonValue;

/**
 * BALAYER. `mode: "LIGHT"` = les règles marquées légères (risque financier immédiat), toutes les
 * heures ; `"FULL"` = tout, la nuit. `regles` restreint (tests, écran). `appliquerAuto` applique
 * les corrections AUTO — vrai par défaut : c'est le contrat de la résolution AUTO.
 */
export async function balayerQualite(opts: {
  mode?: "FULL" | "LIGHT"; regles?: readonly string[]; appliquerAuto?: boolean; now?: Date; journaliser?: boolean;
} = {}): Promise<RapportBalayage> {
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? "FULL";
  const appliquerAuto = opts.appliquerAuto ?? true;
  const cibles = REGLES.filter((r) => (opts.regles ? opts.regles.includes(r.id) : mode === "FULL" || r.legere === true));
  const debut = Date.now();
  const sweep = opts.journaliser === false ? null : await prisma.dataQualitySweep.create({ data: { mode, startedAt: now }, select: { id: true } }).catch(sansBloquer("quality-engine.balayerQualite.dataQualitySweep", null));
  const rapports: RapportRegle[] = [];

  for (const regle of cibles) {
    const t0 = Date.now();
    const rapport: RapportRegle = { id: regle.id, constats: 0, nouveaux: 0, corriges: 0, resolus: 0, ms: 0, erreur: null };
    try {
      const constats = await detecter(regle.id, now);
      rapport.constats = constats.length;
      const signatures = constats.map((c) => c.signature);
      const existants = signatures.length
        ? await prisma.dataQualityFinding.findMany({ where: { signature: { in: signatures } }, select: { id: true, signature: true, status: true } })
        : [];
      const parSignature = new Map(existants.map((e) => [e.signature, e]));

      for (const c of constats) {
        const ex = parSignature.get(c.signature);
        const champs = {
          regle: c.regle, famille: c.famille, criticite: c.criticite, confiance: c.confiance, resolution: c.resolution,
          entite: c.entite, entiteId: c.entiteId, module: c.module, titre: c.titre, detail: c.detail, href: c.href,
          correction: c.correction ? json(c.correction) : Prisma.JsonNull, montant: c.montant,
        };
        let id: string;
        if (!ex) {
          id = (await prisma.dataQualityFinding.create({ data: { ...champs, signature: c.signature, status: "OPEN", firstSeenAt: now, lastSeenAt: now }, select: { id: true } })).id;
          rapport.nouveaux += 1;
        } else if (ex.status === "DISMISSED") {
          // Une décision humaine : on compte, on ne rouvre pas.
          await prisma.dataQualityFinding.update({ where: { id: ex.id }, data: { lastSeenAt: now, occurrences: { increment: 1 } } });
          continue;
        } else if (ex.status === "OPEN") {
          await prisma.dataQualityFinding.update({ where: { id: ex.id }, data: { ...champs, lastSeenAt: now, occurrences: { increment: 1 } } });
          id = ex.id;
        } else {
          // FIXED ou RESOLVED qui réapparaît : la correction n'a pas tenu — rouvrir, et le dire.
          await prisma.dataQualityFinding.update({ where: { id: ex.id }, data: { ...champs, status: "OPEN", lastSeenAt: now, occurrences: { increment: 1 }, reopenCount: { increment: 1 }, resolvedAt: null, resolvedBy: null, resolvedById: null } });
          id = ex.id;
        }
        if (appliquerAuto && c.resolution === "AUTO" && c.correction) {
          const issue = await appliquerCorrection(c, { acteurId: null });
          await prisma.dataQualityFinding.update({
            where: { id },
            data: issue.ok
              ? { status: "FIXED", resolvedAt: new Date(), resolvedBy: "auto", fixLog: json({ at: new Date().toISOString(), avant: issue.avant ?? null, apres: issue.apres ?? null, par: "moteur" }) }
              : { fixLog: json({ at: new Date().toISOString(), echec: issue.message }) },
          });
          if (issue.ok) rapport.corriges += 1;
        }
      }
      // Ce qui n'est plus observé se ferme — seulement quand la règle a vraiment tourné.
      const fermes = await prisma.dataQualityFinding.updateMany({
        where: { regle: regle.id, status: "OPEN", ...(signatures.length ? { signature: { notIn: signatures } } : {}) },
        data: { status: "RESOLVED", resolvedAt: now, resolvedBy: "disparu" },
      });
      rapport.resolus = fermes.count;
    } catch (e) {
      rapport.erreur = e instanceof Error ? e.message : String(e);
      console.error("[qualite] règle en échec", regle.id, e);
    }
    rapport.ms = Date.now() - t0;
    rapports.push(rapport);
  }

  const ouverts = await prisma.dataQualityFinding.count({ where: { status: "OPEN" } }).catch(sansBloquer("quality-engine.balayerQualite.dataQualityFinding", 0));
  const total = (k: keyof Pick<RapportRegle, "constats" | "nouveaux" | "corriges" | "resolus">) => rapports.reduce((s, r) => s + r[k], 0);
  const rapportFinal: RapportBalayage = {
    mode, sweepId: sweep?.id ?? null, ms: Date.now() - debut, regles: rapports,
    constats: total("constats"), nouveaux: total("nouveaux"), corriges: total("corriges"), resolus: total("resolus"),
    erreurs: rapports.filter((r) => r.erreur).length, ouverts,
  };
  if (sweep) {
    await prisma.dataQualitySweep.update({
      where: { id: sweep.id },
      data: { finishedAt: new Date(), ms: rapportFinal.ms, regles: json(rapports), constats: rapportFinal.constats, nouveaux: rapportFinal.nouveaux, corriges: rapportFinal.corriges, resolus: rapportFinal.resolus, erreurs: rapportFinal.erreurs },
    }).catch(sansBloquer("quality-engine.balayerQualite.dataQualitySweep"));
  }
  return rapportFinal;
}

/** Le dernier balayage de chaque mode — pour l'écran et pour l'outil d'Adam (« ça date de quand ? »). */
export async function derniersBalayages(): Promise<{ mode: string; startedAt: Date; finishedAt: Date | null; ms: number | null; constats: number; nouveaux: number; corriges: number; resolus: number; erreurs: number }[]> {
  const rows = await prisma.dataQualitySweep.findMany({ orderBy: { startedAt: "desc" }, take: 20, select: { mode: true, startedAt: true, finishedAt: true, ms: true, constats: true, nouveaux: true, corriges: true, resolus: true, erreurs: true } });
  const vus = new Set<string>();
  return rows.filter((r) => (vus.has(r.mode) ? false : (vus.add(r.mode), true)));
}

// ─────────────────────────────── La cadence (battement) ───────────────────────────────

const HEURE_MS = 3_600_000;
let dernierLeger = 0;
let dernierComplet = 0;

/**
 * LE PAS DU BATTEMENT : les règles légères toutes les heures, tout la nuit (ou dès qu'un
 * balayage complet a plus de 24 h). L'instant du dernier passage se relit en base au premier
 * appel : un redémarrage ne provoque pas un balayage complet de plus.
 */
export async function balayageQualiteSiDu(now: Date = new Date()): Promise<RapportBalayage | null> {
  if (process.env.DATA_QUALITY_DISABLED === "1") return null;
  if (!dernierComplet || !dernierLeger) {
    const [f, l] = await Promise.all([
      prisma.dataQualitySweep.findFirst({ where: { mode: "FULL", finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }).catch(sansBloquer("quality-engine.balayageQualiteSiDu.dataQualitySweep", null)),
      prisma.dataQualitySweep.findFirst({ where: { mode: "LIGHT", finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }).catch(sansBloquer("quality-engine.balayageQualiteSiDu.dataQualitySweep", null)),
    ]);
    dernierComplet = dernierComplet || (f?.startedAt.getTime() ?? 0);
    dernierLeger = dernierLeger || (l?.startedAt.getTime() ?? 0);
  }
  const heure = now.getUTCHours();
  const nuit = heure >= 1 && heure <= 4;
  if (now.getTime() - dernierComplet > 24 * HEURE_MS && (nuit || !dernierComplet)) {
    dernierComplet = now.getTime(); dernierLeger = now.getTime();
    return balayerQualite({ mode: "FULL", now });
  }
  if (now.getTime() - dernierLeger > HEURE_MS) {
    dernierLeger = now.getTime();
    return balayerQualite({ mode: "LIGHT", now });
  }
  return null;
}

/** Pour les tests : oublier la cadence mémorisée. */
export function _reinitialiserCadence(): void { dernierLeger = 0; dernierComplet = 0; }

export type { Constat };
