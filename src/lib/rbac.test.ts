import { describe, expect, it } from "vitest";
import type { EntityType, UserRole } from "@prisma/client";
import {
  PERMISSIONS,
  accessibleModules,
  can,
  canManageEnvelope,
  canViewEnvelope,
  defaultScope,
  hasGlobalView,
  peutPiloterMissionsAdam,
  REFUS_MISSIONS_ADAM,
  scopeMedicalDoctors,
  clausePanelDuKam,
  seesWholeSecretariat,
  scopeRegulatory,
  regulatoryLockWhere,
  scopeSales,
  userCan,
  type Action,
  type EffectiveAccess,
  type Module,
  type SessionUser,
} from "./rbac";

/** Build an in-memory effective access (mirrors what getAccess resolves). */
function mkAccess(
  modules: Partial<Record<Module, { actions: Action[]; scope: "ALL" | "ASSIGNED" }>>,
  grants: Partial<Record<EntityType, string[]>> = {},
): EffectiveAccess {
  const m = new Map();
  for (const [k, v] of Object.entries(modules)) {
    m.set(k, { actions: new Set(v!.actions), scope: v!.scope });
  }
  const rg = new Map();
  for (const [k, v] of Object.entries(grants)) rg.set(k, new Set(v));
  return { modules: m, rowGrants: rg };
}

function mkUser(id: string, role: UserRole, access: EffectiveAccess): SessionUser {
  return { id, role, access };
}

/** Resolve role defaults the way getAccess would (for testing userCan/scope). */
function fromRole(role: UserRole): EffectiveAccess {
  const modules: Partial<Record<Module, { actions: Action[]; scope: "ALL" | "ASSIGNED" }>> = {};
  for (const [mod, actions] of Object.entries(PERMISSIONS[role])) {
    if (actions.includes("VIEW")) {
      modules[mod as Module] = { actions, scope: defaultScope(role, mod as Module) };
    }
  }
  return mkAccess(modules);
}

describe("role-default permissions (can)", () => {
  it("grants Super Admin everything", () => {
    expect(can("SUPER_ADMIN", "REGULATORY", "DELETE")).toBe(true);
    expect(can("SUPER_ADMIN", "ADMIN", "CREATE")).toBe(true);
  });
  it("restricts a Regulatory Assistant to contribute-level", () => {
    expect(can("REGULATORY_ASSISTANT", "REGULATORY", "UPDATE")).toBe(true);
    expect(can("REGULATORY_ASSISTANT", "REGULATORY", "DELETE")).toBe(false);
    expect(can("REGULATORY_ASSISTANT", "REGULATORY", "VALIDATE")).toBe(false);
  });
  it("prevents a Viewer from creating", () => {
    expect(can("VIEWER", "REGULATORY", "CREATE")).toBe(false);
    expect(can("VIEWER", "WORKSPACE", "VIEW")).toBe(true);
  });
  it("lets Direction validate every pôle (validate-everything)", () => {
    // Les BUDGETS (enveloppes) sont désormais une prérogative du Super Admin : la
    // Direction des opérations les consulte (selon les enveloppes ouvertes) mais ne
    // les gère/valide pas — voir #193 (gouvernance des enveloppes).
    const validatable: Module[] = [
      "REGULATORY", "SPONSORING", "FINANCES", "CONGRESS_INTERNATIONAL",
      "CONGRESS_NATIONAL", "SALES", "LOGISTICS", "PCH", "STOCKS", "MEDICAL",
      "BUSINESS_DEVELOPMENT", "VALIDATIONS", "MEDICAL_INFO",
    ];
    for (const m of validatable) {
      expect(can("DIRECTION", m, "VALIDATE")).toBe(true);
    }
    // Budgets : la Direction lit mais ne valide pas.
    expect(can("DIRECTION", "BUDGETS", "VIEW")).toBe(true);
    expect(can("DIRECTION", "BUDGETS", "VALIDATE")).toBe(false);
  });
  it("gives the medical-info pharmacist their module + read on event pôles", () => {
    expect(can("MEDICAL_INFO_PHARMACIST", "MEDICAL_INFO", "VALIDATE")).toBe(true);
    expect(can("MEDICAL_INFO_PHARMACIST", "MEDICAL_INFO", "CREATE")).toBe(true);
    expect(can("MEDICAL_INFO_PHARMACIST", "SPONSORING", "VIEW")).toBe(true);
    expect(can("MEDICAL_INFO_PHARMACIST", "SPONSORING", "VALIDATE")).toBe(false); // ne valide pas le sponsoring lui-même
    expect(can("MEDICAL_INFO_PHARMACIST", "CONGRESS_INTERNATIONAL", "VIEW")).toBe(true);
  });
  it("scopes MEDICAL_INFO to ALL for the pharmacist, ASSIGNED otherwise", () => {
    expect(defaultScope("MEDICAL_INFO_PHARMACIST", "MEDICAL_INFO")).toBe("ALL");
    expect(defaultScope("FINANCE_BUDGET_MANAGER", "MEDICAL_INFO")).toBe("ASSIGNED");
  });
  it("gives every role a baseline for Directives and Support (Direction manages)", () => {
    const roles: UserRole[] = ["DIRECTION", "MEDICAL_DELEGATE", "PRODUCT_MANAGER", "SALES_USER", "FINANCE_BUDGET_MANAGER", "VIEWER"];
    for (const r of roles) {
      expect(can(r, "DIRECTIVES", "VIEW")).toBe(true);
      expect(can(r, "SUPPORT", "VIEW")).toBe(true);
      expect(can(r, "SUPPORT", "CREATE")).toBe(true);
    }
    // Seule la Direction (et le Super Admin) émet une directive.
    expect(can("DIRECTION", "DIRECTIVES", "CREATE")).toBe(true);
    expect(can("MEDICAL_DELEGATE", "DIRECTIVES", "CREATE")).toBe(false);
    // Portées restreintes par défaut (chacun ne voit que ce qui le concerne).
    expect(defaultScope("MEDICAL_DELEGATE", "DIRECTIVES")).toBe("ASSIGNED");
    expect(defaultScope("PRODUCT_MANAGER", "SUPPORT")).toBe("ASSIGNED");
  });
  it("reserves Administration and Adventum Brain to the Super Admin only", () => {
    const others: UserRole[] = ["DIRECTION", "DIRECTION_ASSISTANT", "HEAD_OF_REGULATORY", "FINANCE_BUDGET_MANAGER", "MEDICAL_INFO_PHARMACIST", "MEDICAL_PROMOTION_MANAGER", "VIEWER"];
    for (const r of others) {
      expect(can(r, "ADMIN", "VIEW")).toBe(false);
      expect(can(r, "ADVENTUM_BRAIN", "VIEW")).toBe(false);
      expect(can(r, "PROCESS_INTELLIGENCE", "VIEW")).toBe(false);
    }
    expect(can("SUPER_ADMIN", "ADMIN", "VIEW")).toBe(true);
    expect(can("SUPER_ADMIN", "ADVENTUM_BRAIN", "VIEW")).toBe(true);
  });
  it("gives the Direction Assistant full admin-requests (ALL) but NO promo-material module access", () => {
    expect(can("DIRECTION_ASSISTANT", "ADMIN_REQUESTS", "VALIDATE")).toBe(true);
    expect(defaultScope("DIRECTION_ASSISTANT", "ADMIN_REQUESTS")).toBe("ALL");
    // Elle pilote le matériel promo depuis les Demandes administratives, sans accès au module.
    expect(can("DIRECTION_ASSISTANT", "PROMO_MATERIAL", "VIEW")).toBe(false);
    expect(can("DIRECTION_ASSISTANT", "ADMIN", "VIEW")).toBe(false);
  });
});

describe("effective access (userCan / accessibleModules)", () => {
  it("reflects role defaults when there is no override", () => {
    const u = mkUser("s1", "SALES_USER", fromRole("SALES_USER"));
    expect(userCan(u, "SALES", "VIEW")).toBe(true);
    expect(userCan(u, "REGULATORY", "VIEW")).toBe(false);
    const mods = accessibleModules(u);
    expect(mods).toContain("SALES");
    expect(mods).not.toContain("ADMIN");
  });

  it("honours an admin override that revokes an action", () => {
    // Admin grants VIEW only on REGULATORY (no UPDATE), scope ALL.
    const u = mkUser("a1", "REGULATORY_ASSISTANT", mkAccess({ REGULATORY: { actions: ["VIEW"], scope: "ALL" } }));
    expect(userCan(u, "REGULATORY", "VIEW")).toBe(true);
    expect(userCan(u, "REGULATORY", "UPDATE")).toBe(false);
  });

  it("honours an admin override that grants extra access beyond the role", () => {
    // A viewer explicitly granted SALES create.
    const u = mkUser("v1", "VIEWER", mkAccess({ SALES: { actions: ["VIEW", "CREATE"], scope: "ALL" } }));
    expect(userCan(u, "SALES", "CREATE")).toBe(true);
    expect(accessibleModules(u)).toContain("SALES");
  });
});

describe("row-level scoping", () => {
  it("ne restreint QUE le verrou sur une portée ALL", () => {
    const head = mkUser("h1", "HEAD_OF_REGULATORY", fromRole("HEAD_OF_REGULATORY"));
    expect(scopeRegulatory(head)).toEqual({ isLocked: false });
    expect(hasGlobalView("DIRECTION")).toBe(true);
  });

  it("limits ASSIGNED scope to owned + granted rows", () => {
    const asst = mkUser(
      "u-asst",
      "REGULATORY_ASSISTANT",
      mkAccess({ REGULATORY: { actions: ["VIEW"], scope: "ASSIGNED" } }, { REGULATORY_PRODUCT: ["row-123"] }),
    );
    const scope = scopeRegulatory(asst) as { AND: [{ OR: unknown[] }, unknown] };
    const json = JSON.stringify(scope.AND[0].OR);
    expect(json).toContain("u-asst"); // owner/assignee conditions
    expect(json).toContain("row-123"); // explicit grant
  });

  // LE VERROU passe avant tout le reste : c'est ce qui permet de charger un portefeuille
  // confidentiel dans l'outil sans le publier. Il est posé dans la PORTÉE et non dans l'écran,
  // pour qu'un dossier verrouillé ne ressorte ni par la recherche, ni par les stocks, ni par
  // l'assistant. Ces trois cas sont la garantie que la règle ne se contourne pas.
  it("cache les dossiers VERROUILLÉS, même à qui voit toutes les lignes", () => {
    const head = mkUser("h1", "HEAD_OF_REGULATORY", fromRole("HEAD_OF_REGULATORY"));
    expect(scopeRegulatory(head)).toMatchObject({ isLocked: false });
  });

  it("les cache AUSSI à qui en est nommément responsable", () => {
    const asst = mkUser(
      "u-asst",
      "REGULATORY_ASSISTANT",
      mkAccess({ REGULATORY: { actions: ["VIEW"], scope: "ASSIGNED" } }, { REGULATORY_PRODUCT: ["row-123"] }),
    );
    const scope = scopeRegulatory(asst) as { AND: unknown[] };
    expect(scope.AND).toContainEqual({ isLocked: false });
  });

  it("le SUPER ADMIN, lui, les voit — il est le seul à tenir le cadenas", () => {
    const boss = mkUser("boss", "SUPER_ADMIN", fromRole("SUPER_ADMIN"));
    expect(scopeRegulatory(boss)).toEqual({});
    expect(regulatoryLockWhere(boss)).toEqual({});
    expect(regulatoryLockWhere(mkUser("h1", "DIRECTION", fromRole("DIRECTION")))).toEqual({ isLocked: false });
    // Sans utilisateur (lecture anonyme, portail), on verrouille : le doute ne publie pas.
    expect(regulatoryLockWhere(null)).toEqual({ isLocked: false });
  });

  it("returns match-nothing when the module is not accessible", () => {
    const u = mkUser("x1", "SALES_USER", fromRole("SALES_USER"));
    expect(scopeRegulatory(u)).toEqual({ id: "__none__" });
  });

  it("scopes sales and medical by ownership", () => {
    const su = mkUser("s1", "SALES_USER", fromRole("SALES_USER"));
    expect(scopeSales(su)).toEqual({ OR: [{ salesUserId: "s1" }] });
    const del = mkUser("d1", "MEDICAL_DELEGATE", fromRole("MEDICAL_DELEGATE"));
    // LE PANEL DU KAM (§118.179) : ses rattachements directs ET ce que ses secteurs couvrent. La
    // forme de la clause est éprouvée ici ; ce qu'elle CHOISIT dans une vraie base l'est dans
    // `queries/panel-kam.test.ts`, branche par branche.
    expect(scopeMedicalDoctors(del)).toEqual({ OR: [clausePanelDuKam("d1")] });
    expect(clausePanelDuKam("d1").OR).toContainEqual({ delegateId: "d1" });
    const mgr = mkUser("m1", "MEDICAL_PROMOTION_MANAGER", fromRole("MEDICAL_PROMOTION_MANAGER"));
    expect(scopeMedicalDoctors(mgr)).toEqual({});
  });
});

describe("envelope access (canViewEnvelope / canManageEnvelope)", () => {
  const admin = mkUser("a1", "SUPER_ADMIN", fromRole("SUPER_ADMIN"));
  const del = mkUser("d1", "MEDICAL_DELEGATE", fromRole("MEDICAL_DELEGATE"));
  const empty = { accessRoles: [], accessUserIds: [], managerRoles: [], managerUserIds: [] };

  it("hides an envelope by default (encadrement strict)", () => {
    expect(canViewEnvelope(del, empty)).toBe(false);
    expect(canManageEnvelope(del, empty)).toBe(false);
  });

  it("un droit BUDGETS:DELETE (rôle Finance/Budget) ne rend PAS gouverneur global — strict par enveloppe", () => {
    // Régression fuite : DELETE fait partie du bundle MANAGE et suffisait à voir/gérer
    // TOUTES les enveloppes. Désormais seul le Super Admin gouverne globalement ; le
    // titulaire du module Budget ne voit une enveloppe que si l'admin la lui ouvre.
    const fin = mkUser("f1", "FINANCE_BUDGET_MANAGER", fromRole("FINANCE_BUDGET_MANAGER"));
    expect(userCan(fin, "BUDGETS", "DELETE")).toBe(true); // il a bien le droit module…
    expect(canViewEnvelope(fin, empty)).toBe(false); // …mais ne voit pas une enveloppe non partagée
    expect(canManageEnvelope(fin, empty)).toBe(false);
    expect(canViewEnvelope(fin, { ...empty, accessRoles: ["FINANCE_BUDGET_MANAGER"] })).toBe(true);
  });

  it("the global manager (Super Admin) always sees and manages", () => {
    expect(canViewEnvelope(admin, empty)).toBe(true);
    expect(canManageEnvelope(admin, empty)).toBe(true);
  });

  it("opening visualisation (role/person) grants VIEW but not MANAGE", () => {
    expect(canViewEnvelope(del, { ...empty, accessRoles: ["MEDICAL_DELEGATE"] })).toBe(true);
    expect(canManageEnvelope(del, { ...empty, accessRoles: ["MEDICAL_DELEGATE"] })).toBe(false);
    expect(canViewEnvelope(del, { ...empty, accessUserIds: ["d1"] })).toBe(true);
    expect(canManageEnvelope(del, { ...empty, accessUserIds: ["d1"] })).toBe(false);
  });

  it("delegating gestion (role/person) grants MANAGE and therefore VIEW", () => {
    expect(canManageEnvelope(del, { ...empty, managerUserIds: ["d1"] })).toBe(true);
    expect(canViewEnvelope(del, { ...empty, managerUserIds: ["d1"] })).toBe(true);
    expect(canManageEnvelope(del, { ...empty, managerRoles: ["MEDICAL_DELEGATE"] })).toBe(true);
  });

  it("another person's grant does not leak", () => {
    expect(canViewEnvelope(del, { ...empty, accessUserIds: ["someone-else"], managerUserIds: ["x"] })).toBe(false);
  });
});

describe("Moyens généraux — un module À PART, ouvert à celui qui achète", () => {
  it("l'assistante de direction l'a, sans avoir « Budgets »", () => {
    // Le point de la séparation : « Budgets » est l'écran de qui ALLOUE, « Moyens généraux »
    // celui de qui ACHÈTE. Enfermer le second dans le premier le rendait invisible à la seule
    // personne qui s'en sert tous les jours.
    const assistante = PERMISSIONS.DIRECTION_ASSISTANT;
    expect(assistante.GENERAL_MEANS).toBeDefined();
    expect(assistante.GENERAL_MEANS).toContain("VIEW");
    expect(assistante.GENERAL_MEANS).toContain("CREATE"); // saisir un achat
    expect(assistante.GENERAL_MEANS).toContain("UPLOAD"); // et scanner sa facture
    expect(assistante.BUDGETS).toBeUndefined();
  });

  it("l'administration et les finances l'ont aussi", () => {
    expect(PERMISSIONS.SUPER_ADMIN.GENERAL_MEANS).toBeDefined();
    expect(PERMISSIONS.DIRECTION.GENERAL_MEANS).toBeDefined();
    expect(PERMISSIONS.FINANCE_BUDGET_MANAGER.GENERAL_MEANS).toBeDefined();
  });

  it("n'est PAS distribué à tout le monde par défaut", () => {
    expect(PERMISSIONS.MEDICAL_DELEGATE.GENERAL_MEANS).toBeUndefined();
    expect(PERMISSIONS.VIEWER.GENERAL_MEANS).toBeUndefined();
    expect(PERMISSIONS.COORDINATOR.GENERAL_MEANS).toBeUndefined();
  });

  it("apparaît dans les modules accessibles de l'assistante", () => {
    const mods = accessibleModules({
      id: "u1", name: "Radia", email: "r@x.dz", role: "DIRECTION_ASSISTANT",
      access: {
        modules: new Map(
          Object.entries(PERMISSIONS.DIRECTION_ASSISTANT).map(([m, actions]) => [
            m, { actions: new Set(actions), scope: "ASSIGNED" },
          ]),
        ),
        rowGrants: new Map(),
      },
      mustChangePassword: false,
    } as Parameters<typeof accessibleModules>[0]);
    expect(mods).toContain("GENERAL_MEANS");
    expect(mods).not.toContain("BUDGETS");
  });
});

describe("Moyens généraux — les RH pilotent, l'assistante utilise", () => {
  it("le socle par rôle ne donne PAS le module aux RH : il leur vient du droit RH:UPDATE", () => {
    // « RH » est un droit de module, pas un rôle nommé — le pilotage des moyens généraux ne
    // pouvait donc pas être posé dans la matrice par rôle. Il est accordé par `getAccess`
    // (accès implicite) à quiconque tient les ressources humaines, sur TOUS les départements.
    // Ici on verrouille l'intention : aucune ligne de la matrice ne le distribue par erreur à
    // un rôle qui n'a rien à voir avec les achats.
    const holders = (Object.keys(PERMISSIONS) as UserRole[]).filter((r) => PERMISSIONS[r].GENERAL_MEANS);
    expect(new Set(holders)).toEqual(
      // Les deux directions s'y ajoutent volontairement : le Directeur Général parce qu'il a
      // tous les pouvoirs métier, le Directeur des Opérations parce que les moyens généraux
      // SONT son métier. Aucun rôle de terrain n'y figure.
      new Set<UserRole>([
        "SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR",
        "FINANCE_BUDGET_MANAGER", "DIRECTION_ASSISTANT",
      ]),
    );
  });

  it("l'assistante peut saisir un achat, sans pouvoir gérer le module", () => {
    const a = PERMISSIONS.DIRECTION_ASSISTANT.GENERAL_MEANS ?? [];
    expect(a).toContain("CREATE");
    expect(a).toContain("UPLOAD");
    // Elle n'ARBITRE pas : doter, valider une rallonge, ce n'est pas son rôle.
    expect(a).not.toContain("VALIDATE");
    expect(a).not.toContain("DELETE");
  });
});

describe("Directeur Général — tous les pouvoirs métier, sans la souveraineté du Super Admin", () => {
  it("gère les pôles opérationnels comme la Direction", () => {
    for (const m of ["REGULATORY", "SPONSORING", "FINANCES", "RH", "SALES", "LOGISTICS", "PCH", "STOCKS", "MEDICAL", "LEGAL", "MAIL_REGISTER"] as Module[]) {
      expect(can("GENERAL_MANAGER", m, "UPDATE"), m).toBe(true);
      expect(can("GENERAL_MANAGER", m, "DELETE"), m).toBe(true);
    }
  });

  it("NE SUPERVISE PAS les demandes de validation de tout le monde", () => {
    // C'est LA différence avec la Direction, et elle tient à un seul fait : le tableau de
    // supervision est réservé à la vue globale (`hasGlobalView`). Le Directeur Général voit et
    // tranche ce qu'on lui adresse nommément, pas les circuits de chacun.
    expect(hasGlobalView("DIRECTION")).toBe(true);
    expect(hasGlobalView("GENERAL_MANAGER")).toBe(false);
    expect(can("GENERAL_MANAGER", "VALIDATIONS", "VALIDATE")).toBe(false);
  });

  it("n'a NI l'Administration, NI l'IA, NI Process Intelligence — la souveraineté reste au Super Admin", () => {
    for (const m of ["ADMIN", "ADVENTUM_BRAIN", "PROCESS_INTELLIGENCE"] as Module[]) {
      expect(can("GENERAL_MANAGER", m, "VIEW"), m).toBe(false);
    }
  });

  it("le Drive et les fils personnels restent cloisonnés", () => {
    // « Tous les pouvoirs » ne veut pas dire lire le Drive privé de chacun : la portée par
    // défaut du Drive reste celle de tout le monde.
    expect(defaultScope("GENERAL_MANAGER", "DRIVE")).toBe("ASSIGNED");
    expect(defaultScope("GENERAL_MANAGER", "DIRECTIVES")).toBe("ASSIGNED");
    // En revanche il pilote le secrétariat : il voit TOUTES les demandes administratives.
    expect(defaultScope("GENERAL_MANAGER", "ADMIN_REQUESTS")).toBe("ALL");
  });
});

describe("Directeur des Opérations — un rôle À PART, pas une Direction au rabais", () => {
  it("pilote ce qui fait tourner la maison : approvisionnement, ventes, moyens généraux", () => {
    for (const m of ["LOGISTICS", "PCH", "STOCKS", "SALES", "GENERAL_MEANS", "ADMIN_REQUESTS"] as Module[]) {
      expect(can("OPERATIONS_DIRECTOR", m, "UPDATE"), m).toBe(true);
    }
  });

  it("LIT ce dont il dépend sans le piloter — réglementaire, budgets, finances", () => {
    for (const m of ["REGULATORY", "BUDGETS", "FINANCES", "RH"] as Module[]) {
      expect(can("OPERATIONS_DIRECTOR", m, "VIEW"), m).toBe(true);
      expect(can("OPERATIONS_DIRECTOR", m, "UPDATE"), m).toBe(false);
    }
  });

  it("n'est pas une vue globale, et n'a pas les pouvoirs du Directeur Général", () => {
    expect(hasGlobalView("OPERATIONS_DIRECTOR")).toBe(false);
    expect(can("OPERATIONS_DIRECTOR", "ADMIN", "UPDATE")).toBe(false);
  });

  it("tient l'étape « Directeur des opérations » des circuits Ad & Pro (Direction, 27/10/2026)", () => {
    // Toute demande qui ne vient pas d'un délégué lui arrive d'abord ; celle d'un délégué, après
    // le National Sales. Il valide, et ajoute des postes — sans tenir le budget ni le centre de paiement.
    for (const m of ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS", "AD_PRO_OTHER"] as Module[]) {
      expect(can("OPERATIONS_DIRECTOR", m, "VIEW"), m).toBe(true);
      expect(can("OPERATIONS_DIRECTOR", m, "VALIDATE"), m).toBe(true);
      expect(can("OPERATIONS_DIRECTOR", m, "DELETE"), m).toBe(false);
    }
  });
});

describe("seesWholeSecretariat — le DRH et les Finances voient tout le bureau", () => {
  it("celui qui TIENT les RH voit toutes les demandes", () => {
    expect(seesWholeSecretariat({ rhCanUpdate: true, financeCanUpdate: false })).toBe(true);
  });

  it("celui qui TIENT les Finances aussi — c'est lui qui paie", () => {
    expect(seesWholeSecretariat({ rhCanUpdate: false, financeCanUpdate: true })).toBe(true);
  });

  // Une lecture des RH accordée pour consulter un organigramme n'ouvre pas le courrier de
  // toute l'entreprise : il faut tenir le module, pas seulement le lire.
  it("une simple lecture ne suffit pas", () => {
    expect(seesWholeSecretariat({ rhCanUpdate: false, financeCanUpdate: false })).toBe(false);
  });
});

describe("peutPiloterMissionsAdam — les missions d'Adam sont réservées au Super Admin (§118.136)", () => {
  it("le Super Admin, et lui seul — rôle brut ou porteur de rôles", () => {
    expect(peutPiloterMissionsAdam("SUPER_ADMIN")).toBe(true);
    expect(peutPiloterMissionsAdam({ role: "SUPER_ADMIN" })).toBe(true);
    for (const role of ["DIRECTION", "GENERAL_MANAGER", "DIRECTION_ASSISTANT", "SALES_USER", "VIEWER"] as UserRole[]) {
      expect(peutPiloterMissionsAdam(role), role).toBe(false);
      expect(peutPiloterMissionsAdam({ role }), role).toBe(false);
    }
  });

  it("la vue globale ne suffit pas : la Direction voit tout, elle ne pilote pas de mission", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : réécrire le prédicat sur `hasGlobalView`. C'est la tentation
     * naturelle — c'était la porte d'hier pour les surveillances — et c'est exactement ce que la
     * Direction a demandé de fermer.
     */
    expect(hasGlobalView("DIRECTION")).toBe(true);
    expect(peutPiloterMissionsAdam("DIRECTION")).toBe(false);
  });

  it("une casquette secondaire n'ouvre pas les missions : le Super Admin est un COMPTE", () => {
    expect(peutPiloterMissionsAdam({ role: "DIRECTION", secondaryRole: "SUPER_ADMIN" })).toBe(false);
    expect(hasGlobalView({ role: "SALES_USER", secondaryRole: "DIRECTION" })).toBe(true); // la vue globale, elle, se prête
    expect(peutPiloterMissionsAdam({ role: "SALES_USER", secondaryRole: "DIRECTION" })).toBe(false);
  });

  it("le refus est écrit UNE fois, et il nomme la règle", () => {
    expect(REFUS_MISSIONS_ADAM).toMatch(/Super Admin/);
    expect(REFUS_MISSIONS_ADAM).toMatch(/missions et surveillances/);
  });
});
