import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import AVANT from "./equivalents-avant-j6.json";
import { porteOuverte, registreDesCapacites } from "./infra/capacites";
import { outilsV1 } from "./infra/outils-v1";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUCUNE RÉGRESSION DE CAPACITÉ (décision 0020) — chaque geste que l'Assistant IA offrait AVANT J6 par Adam (114 ops
 * des cinq outils de domaine, neuf écritures) a son équivalent d'APRÈS. L'instantané `equivalents-avant-j6.json` est
 * écrit par `npm run capacites:inventaire` (qui, lui, lit Adam) ; ce test le rejoue sans Adam :
 *   · chaque équivalent existe et reste APPELABLE (une action retirée, rendue illisible ou refusée le fait échouer) ;
 *   · sa porte s'ouvre à chaque rôle que la porte d'Adam laissait passer (droits par défaut du rôle) ;
 *   · les outils propres nommés (`preparer_depot_piece`, `send_message`) et les lectures d'avant sont toujours là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LIGNES = Object.entries(AVANT as Record<string, { libelle: string; apres: string[]; roles: string[] }>);
/** Les lectures que l'Assistant IA empruntait avant J6 (`search_drive` : `search_everything` et `chercher_documents`). */
const LECTURES_AVANT = [
  "directory_lookup", "directory_list", "regulatory_portfolio", "regulatory_workload", "regulatory_knowledge",
  "list_my_tasks", "search_products", "read_workflow", "list_my_requests", "my_overview",
  "read_hr_overview", "search_everything", "read_calendar", "read_budget", "finance_totals", "list_pending_decisions",
  "chercher_documents",
];

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }

const personne = (role: string, access: CurrentUser["access"]): CurrentUser =>
  ({ id: `__avant_j6_${role}`, name: role, email: "", role, secondaryRole: null, access, mustChangePassword: false }) as unknown as CurrentUser;

describe("aucune régression de capacité — avant J6 → après", () => {
  const reg = registreDesCapacites();

  it("l'instantané couvre les 123 gestes empruntés", () => {
    expect(LIGNES.length).toBe(123);
    expect(LIGNES.map(([k]) => k)).toEqual(expect.arrayContaining(["update_task", "task_operation.refuse", "hr_operation.update_employee", "task_operation.upload_document"]));
  });

  it("chaque équivalent d'action existe et reste appelable", () => {
    for (const [avant, l] of LIGNES) {
      expect(l.apres.length, avant).toBeGreaterThan(0);
      for (const k of l.apres.filter((x) => !x.startsWith("outil:"))) {
        const c = reg.parId.get(k);
        expect(c, `${avant} → ${k}`).toBeTruthy();
        expect(c!.appelable, `${avant} → ${k} : ${c!.refus}`).toBe(true);
      }
    }
  });

  it("changer l'échéance ou la priorité d'une tâche se fait par une action d'écran", () => {
    const c = reg.parId.get("task-actions:modifierTache")!;
    expect(c.champs.map((ch) => ch.nom).sort()).toEqual(["assignedToId", "clearDueDate", "dueDate", "id", "priority"]);
    expect(c.champs.find((ch) => ch.nom === "assignedToId")?.modele).toBe("User");
  });

  it.skipIf(!dbOk)("les outils propres et les lectures d'avant J6 sont au catalogue du Super Admin", async () => {
    const sa = personne("SUPER_ADMIN", await getAccess("__avant_j6_SUPER_ADMIN", "SUPER_ADMIN"));
    const noms = new Set(outilsV1(sa, []).map((o) => o.def.name));
    const propres = LIGNES.flatMap(([, l]) => l.apres.filter((x) => x.startsWith("outil:")).map((x) => x.slice(6)));
    for (const n of [...new Set([...propres, ...LECTURES_AVANT])]) expect(noms.has(n), n).toBe(true);
  });

  it.skipIf(!dbOk)("la porte de chaque équivalent s'ouvre à chaque rôle que la porte d'Adam laissait passer", async () => {
    const roles = [...new Set(LIGNES.flatMap(([, l]) => l.roles))];
    const parRole = new Map(await Promise.all(roles.map(async (r) => [r, personne(r, await getAccess(`__avant_j6_${r}`, r as CurrentUser["role"]))] as const)));
    const fermees: string[] = [];
    for (const [avant, l] of LIGNES) {
      const caps = l.apres.filter((x) => !x.startsWith("outil:")).map((k) => reg.parId.get(k)!);
      if (!caps.length) continue;
      for (const r of l.roles) if (!caps.some((c) => porteOuverte(parRole.get(r)!, c))) fermees.push(`${avant} — ${r}`);
    }
    expect(fermees).toEqual([]);
  }, 60_000);
});
