import type { Module } from "@/lib/rbac";
import type { ClaudeToolDef } from "@/lib/ai";
import { OPS_BY_TOOL, type OpMeta } from "../catalog";
import type { OpImpl } from "../types";

/**
 * L'ASSEMBLAGE d'un outil de domaine : sa forme (`DomainToolSpec`) et les trois aides qui le
 * dérivent du catalogue — `zipOps` (catalogue × implémentations, refus d'une op orpheline),
 * `opsSummary` (la description lue par l'IA) et `opEnum` (l'énumération `op`).
 */

export interface DomainToolSpec {
  /** Module RBAC affiché sur la carte de confirmation. */
  module: Module;
  ops: Record<string, { meta: OpMeta; impl: OpImpl }>;
  def: ClaudeToolDef;
}

export function zipOps(tool: string, impls: Record<string, OpImpl>): Record<string, { meta: OpMeta; impl: OpImpl }> {
  const metas = OPS_BY_TOOL[tool] ?? {};
  const out: Record<string, { meta: OpMeta; impl: OpImpl }> = {};
  for (const [op, meta] of Object.entries(metas)) {
    const impl = impls[op];
    if (!impl) throw new Error(`Op « ${tool}/${op} » déclarée au catalogue sans implémentation.`);
    out[op] = { meta, impl };
  }
  for (const op of Object.keys(impls)) {
    if (!metas[op]) throw new Error(`Implémentation « ${tool}/${op} » absente du catalogue (découverte/classification cassées).`);
  }
  return out;
}

export function opsSummary(tool: string): string {
  return Object.values(OPS_BY_TOOL[tool] ?? {})
    .map((o) => `${o.op} = ${o.uiLabel}${o.risk === "CRITICAL" ? " [CRITIQUE]" : ""}`)
    .join(" ; ");
}

export const opEnum = (tool: string): string[] => Object.keys(OPS_BY_TOOL[tool] ?? {});
