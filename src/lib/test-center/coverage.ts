import { prisma } from "@/lib/prisma";
import { PERMISSIONS, MODULES, ACTIONS } from "@/lib/rbac";
import { STATE_MACHINES } from "./state-machines/registry";
import { sansBloquer } from "@/lib/journal";

type Matrix = Record<string, Record<string, string[]>>;

/**
 * Couverture (§27/§36). Deux dimensions mesurées réellement :
 * 1. **RBAC** — densité des droits accordés dans la matrice + modules réservés à l'admin.
 * 2. **Objets métier** — combien de machines à états déclarées ont effectivement des données.
 * (La couverture des *transitions* est mesurée par l'explorateur de machines à états.)
 */

export interface RbacCoverage {
  roles: number; modules: number; actions: number;
  totalGrants: number; maxGrants: number; grantDensity: number;
  adminOnlyModules: string[];
}

export function rbacCoverage(): RbacCoverage {
  const matrix = PERMISSIONS as unknown as Matrix;
  const roles = Object.keys(matrix);
  let totalGrants = 0;
  const viewers: Record<string, number> = {};
  for (const role of roles) {
    for (const m of MODULES as readonly string[]) {
      const acts = matrix[role]?.[m] ?? [];
      totalGrants += acts.length;
      if (acts.includes("VIEW") && role !== "SUPER_ADMIN") viewers[m] = (viewers[m] ?? 0) + 1;
    }
  }
  const adminOnlyModules = (MODULES as readonly string[]).filter((m) => !viewers[m]);
  const maxGrants = roles.length * MODULES.length * ACTIONS.length;
  return { roles: roles.length, modules: MODULES.length, actions: ACTIONS.length, totalGrants, maxGrants, grantDensity: maxGrants ? totalGrants / maxGrants : 0, adminOnlyModules };
}

export interface BusinessObjectCoverage {
  machines: number; withData: number; coverage: number;
  perMachine: { id: string; records: number }[];
}

export async function businessObjectCoverage(): Promise<BusinessObjectCoverage> {
  const perMachine: { id: string; records: number }[] = [];
  let withData = 0;
  for (const sm of STATE_MACHINES) {
    const del = (prisma as unknown as Record<string, { count?: (a: unknown) => Promise<number> }>)[sm.model];
    const n = del?.count ? await del.count({}).catch(sansBloquer("coverage.businessObjectCoverage.count", 0)) : 0;
    if (n > 0) withData++;
    perMachine.push({ id: sm.id, records: n });
  }
  return { machines: STATE_MACHINES.length, withData, coverage: STATE_MACHINES.length ? withData / STATE_MACHINES.length : 1, perMachine };
}
