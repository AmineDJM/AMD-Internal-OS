import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import {
  COUVERTS, ECRAN_SEUL, ECRITURES_SA, ECRITURES_SENSIBLES, executerEcritureAdam, LECTURES_SA, nomsDuCatalogueAdam, OUTIL_BOITE, outilsAdamSuperAdmin, REFUS_HORS_SA,
} from "./porte-assistant-ia";

/**
 * LA PORTE D'ADAM VERS L'ASSISTANT IA (lot A2, décision 0055) — l'inventaire est EXHAUSTIF et la porte se garde seule.
 *
 * Chaque outil du catalogue d'Adam est classé dans exactement une classe (a, b-lecture, b-écriture, c) : un outil ajouté
 * à Adam demain fait échouer ce test tant qu'il n'est pas classé (et l'inventaire `docs/assistant/adam-inventaire.md`
 * mis à jour). La porte ne rend rien, et n'exécute rien, pour qui n'est pas Super Admin en rôle principal hors Vue exacte.
 */
const compte = (role: string, extra: Partial<CurrentUser> = {}): CurrentUser =>
  ({ id: `porte-${role}`, name: role, email: `${role}@t.dz`, role, secondaryRole: null, access: { role, modules: new Map() }, mustChangePassword: false, ...extra }) as unknown as CurrentUser;

describe("porte d'Adam vers l'Assistant IA — l'inventaire exhaustif", () => {
  const classes = [Object.keys(COUVERTS), LECTURES_SA, ECRITURES_SA, Object.keys(ECRAN_SEUL)];

  it("chaque outil du catalogue d'Adam est classé, une seule fois", () => {
    const catalogue = nomsDuCatalogueAdam();
    expect(catalogue.length).toBeGreaterThan(100);
    const classes1 = classes.flat();
    expect(new Set(classes1).size, "un outil classé deux fois").toBe(classes1.length);
    expect(catalogue.filter((n) => !classes1.includes(n)), "outil(s) d'Adam non classé(s) : à ranger dans porte-assistant-ia.ts et l'inventaire").toEqual([]);
    expect(classes1.filter((n) => !catalogue.includes(n)), "classé mais absent du catalogue").toEqual([]);
  });

  it("les écritures sensibles sont des écritures ; l'outil de la boîte n'écrase aucun nom d'Adam", () => {
    for (const n of ECRITURES_SENSIBLES) expect(ECRITURES_SA).toContain(n);
    expect(nomsDuCatalogueAdam()).not.toContain(OUTIL_BOITE);
  });
});

describe("porte d'Adam — le Super Admin principal seulement", () => {
  it("le Super Admin reçoit les lectures (et la boîte) et les écritures classées — sous le droit propre de chaque outil", () => {
    // Compte sans base : les outils gardés par un MODULE (stocks, finances…) restent fermés ici ; la vraie matrice du Super
    // Admin les ouvre tous (`modules/assistant-ia/adam-super-admin.test.ts`, vraie base).
    const { lectures, ecritures } = outilsAdamSuperAdmin(compte("SUPER_ADMIN"));
    const l = lectures.map((o) => o.def.name), e = ecritures.map((o) => o.def.name);
    expect(l.filter((n) => ![...LECTURES_SA, OUTIL_BOITE].includes(n))).toEqual([]);
    expect(e.filter((n) => !ECRITURES_SA.includes(n))).toEqual([]);
    expect(l).toEqual(expect.arrayContaining([OUTIL_BOITE, "executive_brief", "inspect_record", "list_reminders", "gmail_search"]));
    expect(e).toEqual(expect.arrayContaining(["plan_reminder", "watch_entity", "teach_adam"]));
  });

  it("personne d'autre : ni rôle DIRECTION (siège exécutif d'Adam), ni Super Admin en secondaire, ni Vue exacte", async () => {
    const autres = [
      compte("DIRECTION"), compte("COMMERCIAL", { secondaryRole: "SUPER_ADMIN" } as never), compte("HR_MANAGER"),
      compte("SUPER_ADMIN", { impersonatedBy: { id: "sa", name: "SA" } } as never),
    ];
    for (const u of autres) {
      expect(outilsAdamSuperAdmin(u), u.role).toEqual({ lectures: [], ecritures: [] });
      // L'exécution d'une carte forgée : refusée, sans nommer la fonction.
      const r = await executerEcritureAdam("plan_reminder", { title: "x", quand: "demain à 10h" }, u);
      expect(r).toEqual({ ok: false, message: REFUS_HORS_SA });
      expect(REFUS_HORS_SA).not.toMatch(/adam|super admin|rappel/i);
    }
  });

  it("un outil offert au Super Admin refuse, appelé sous un autre compte (le droit est relu à l'exécution)", async () => {
    const { lectures } = outilsAdamSuperAdmin(compte("SUPER_ADMIN"));
    const o = lectures.find((x) => x.def.name === "list_reminders")!;
    expect(o.allowed(compte("DIRECTION"))).toBe(false);
    expect(await o.run({}, compte("DIRECTION"))).toBe(REFUS_HORS_SA);
  });

  it("une lecture n'est jamais exécutée comme écriture, ni l'inverse", async () => {
    expect((await executerEcritureAdam("list_reminders", {}, compte("SUPER_ADMIN"))).ok).toBe(false);
  });
});
