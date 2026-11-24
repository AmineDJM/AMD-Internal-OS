import { describe, it, expect } from "vitest";
import type { UserRole } from "@prisma/client";
import { accesAttribue, PERMISSIONS, type LigneAccesAttribue } from "@/lib/rbac";
import { MODULE_LABELS } from "@/lib/labels";
import {
  STAND_IN_LABEL, isDelegatable, normalizeDelegated, isDelegationActive, inactiveReason,
  delegatedActions, delegationsFor, actsFor, delegationNotice,
  modulesPretables, modulesNonPretes, congeTermine, annonceDeValidation, bandeauInterim,
  type Detenteur, type StandInLeave, type StandInStatus,
} from "./stand-in";

/**
 * CE QUE L'ABSENT DÉTIENT (§118.196, lot E4 — audit 360°, M13) — calculé par la règle même de
 * `getAccess` (`accesAttribue`), sans base : son rôle, son « autre rôle », la console.
 */
const detenteur = (role: string, lignes: Partial<LigneAccesAttribue>[] = [], secondaryRole: string | null = null): Detenteur => ({
  role,
  detient: accesAttribue(
    role as UserRole,
    secondaryRole as UserRole | null,
    lignes.map((c) => ({
      canView: false, canCreate: false, canUpdate: false, canDelete: false, canValidate: false,
      canExport: false, canUpload: false, scope: "ASSIGNED", sections: [], ...c,
    }) as LigneAccesAttribue),
  ).modules,
});
const parRole = (role: string) => detenteur(role);

const leave = (over: Partial<StandInLeave> = {}): StandInLeave => ({
  leaveApproved: true,
  standInId: "remplacant",
  standInStatus: "APPROVED",
  standInModules: ["VALIDATIONS", "REGULATORY"],
  startDate: "2026-09-01",
  endDate: "2026-09-10",
  ...over,
});

const during = new Date("2026-09-05T09:00:00Z");

describe("modules délégables — remplacer quelqu'un n'est pas devenir lui", () => {
  it("un module métier se délègue", () => {
    expect(isDelegatable("VALIDATIONS")).toBe(true);
    expect(isDelegatable("REGULATORY")).toBe(true);
    expect(isDelegatable("FINANCES")).toBe(true);
  });

  // Remplacer quelqu'un, ce n'est pas lire son Drive privé ni sa messagerie.
  it("les espaces PERSONNELS et la console d'administration ne se délèguent jamais", () => {
    expect(isDelegatable("DRIVE")).toBe(false);
    expect(isDelegatable("MESSAGING")).toBe(false);
    expect(isDelegatable("WORKSPACE")).toBe(false);
    expect(isDelegatable("ADMIN")).toBe(false);
  });

  it("normalise une liste : garde le valide, écarte le reste, dédoublonne", () => {
    expect(normalizeDelegated(["VALIDATIONS", "ADMIN", "PAS_UN_MODULE", " VALIDATIONS "]))
      .toEqual(["VALIDATIONS"]);
    expect(normalizeDelegated([])).toEqual([]);
  });
});

describe("isDelegationActive — quatre conditions, aucune superflue", () => {
  it("congé accordé + intérimaire validé + dans la fenêtre = actif", () => {
    expect(isDelegationActive(leave(), during)).toBe(true);
  });

  // Sans la validation RH, chacun se choisirait un remplaçant complaisant et la délégation
  // deviendrait un moyen de contourner un circuit.
  it("tant que les RH n'ont pas validé, rien ne s'ouvre", () => {
    expect(isDelegationActive(leave({ standInStatus: "PENDING" }), during)).toBe(false);
    expect(isDelegationActive(leave({ standInStatus: "REJECTED" }), during)).toBe(false);
  });

  it("un congé pas encore accordé n'ouvre aucun intérim — la personne est là", () => {
    expect(isDelegationActive(leave({ leaveApproved: false }), during)).toBe(false);
  });

  it("sans intérimaire désigné, il n'y a rien à activer", () => {
    expect(isDelegationActive(leave({ standInId: null }), during)).toBe(false);
  });

  it("hors de la fenêtre, la délégation est fermée — avant comme après", () => {
    expect(isDelegationActive(leave(), new Date("2026-08-31T23:00:00Z"))).toBe(false);
    expect(isDelegationActive(leave(), new Date("2026-09-11T08:00:00Z"))).toBe(false);
  });

  // S'arrêter à minuit laisserait le dernier jour du congé sans personne.
  it("le PREMIER et le DERNIER jour du congé sont couverts en entier", () => {
    expect(isDelegationActive(leave(), new Date("2026-09-01T07:00:00Z"))).toBe(true);
    expect(isDelegationActive(leave(), new Date("2026-09-10T22:00:00Z"))).toBe(true);
  });

  it("des dates illisibles ferment la délégation plutôt que de l'ouvrir au hasard", () => {
    expect(isDelegationActive(leave({ startDate: "n'importe quoi" }), during)).toBe(false);
  });
});

describe("inactiveReason — un refus qui dit pourquoi", () => {
  it("nomme la condition qui manque", () => {
    expect(inactiveReason(leave({ standInId: null }), during)).toContain("Aucun intérimaire");
    expect(inactiveReason(leave({ standInStatus: "PENDING" }), during)).toContain("pas encore validé");
    expect(inactiveReason(leave({ standInStatus: "REJECTED" }), during)).toContain("refusé");
    expect(inactiveReason(leave({ leaveApproved: false }), during)).toContain("pas encore accordé");
  });

  it("distingue « pas encore commencé » de « déjà terminé »", () => {
    expect(inactiveReason(leave(), new Date("2026-08-20T09:00:00Z"))).toContain("commencera");
    expect(inactiveReason(leave(), new Date("2026-10-01T09:00:00Z"))).toContain("pris fin");
  });

  it("quand tout est réuni, il n'y a rien à expliquer", () => {
    expect(inactiveReason(leave(), during)).toBeNull();
  });
});

describe("délégation des droits — jamais plus que ce que l'absent DÉTIENT (§118.196)", () => {
  it("l'intérimaire reprend les droits que l'absent détient sur le module", () => {
    const actions = delegatedActions(parRole("HEAD_OF_REGULATORY"), "REGULATORY");
    expect(actions).toContain("VIEW");
    expect(actions).toContain("UPDATE");
  });

  // Un remplaçant ne détruit pas : c'est le genre de geste qui se découvre au retour et qui ne
  // se répare pas.
  it("la SUPPRESSION n'est jamais déléguée", () => {
    for (const role of ["DIRECTION", "GENERAL_MANAGER", "HEAD_OF_REGULATORY"]) {
      expect(PERMISSIONS[role as keyof typeof PERMISSIONS]?.REGULATORY, `PRÉMISSE : ${role} supprime`).toContain("DELETE");
      expect(delegatedActions(parRole(role), "REGULATORY"), role).not.toContain("DELETE");
    }
  });

  // Une délégation qui ajouterait des droits serait une promotion déguisée, et le retour du
  // titulaire ne la retirerait pas.
  it("un module que l'absent n'avait pas ne se délègue pas", () => {
    expect(delegatedActions(parRole("MEDICAL_DELEGATE"), "FINANCES")).toBeNull();
    expect(delegatedActions(parRole("RÔLE_INEXISTANT"), "REGULATORY")).toBeNull();
  });

  // La règle d'avant lisait la MATRICE du rôle : un HEAD_OF_SALES à qui la console ne laisse que la
  // LECTURE des marchés prêtait quand même créer, modifier, valider.
  it("un accès personnalisé PLUS ÉTROIT que le rôle borne ce qui se prête", () => {
    expect(PERMISSIONS.HEAD_OF_SALES.PCH, "PRÉMISSE : le rôle modifie les marchés").toContain("UPDATE");
    const a = detenteur("HEAD_OF_SALES", [{ module: "PCH", canView: true }]);
    expect(delegatedActions(a, "PCH")).toEqual(["VIEW"]);
  });

  it("un module BLOQUÉ dans la console ne se prête pas, même si le rôle l'accorde", () => {
    expect(PERMISSIONS.HEAD_OF_SALES.STOCKS, "PRÉMISSE : le rôle voit les stocks").toContain("VIEW");
    const a = detenteur("HEAD_OF_SALES", [{ module: "STOCKS", canView: false }]);
    expect(delegatedActions(a, "STOCKS")).toBeNull();
    expect(delegatedActions(parRole("HEAD_OF_SALES"), "STOCKS"), "sans le blocage, il se prête").toContain("VIEW");
  });

  it("un module RETIRÉ de la plateforme ne se prête pas, même si le rôle l'accorde", () => {
    expect(PERMISSIONS.HEAD_OF_SALES.SALES, "PRÉMISSE : le rôle porte encore les ventes").toContain("VIEW");
    expect(delegatedActions(parRole("HEAD_OF_SALES"), "SALES")).toBeNull();
    expect(delegatedActions(parRole("GENERAL_MANAGER"), "LOGISTICS")).toBeNull();
  });

  // Prêter ce que la console ou l'« autre rôle » AJOUTENT au rôle principal serait un élargissement
  // que la Direction n'a pas décidé (D-E4-b) : la matrice du rôle principal reste une borne.
  it("ce que la console ou l'autre rôle AJOUTENT au rôle ne se prête pas (décision de la Direction)", () => {
    expect(PERMISSIONS.REGULATORY_ASSISTANT.REGULATORY, "PRÉMISSE : le rôle ne valide pas").not.toContain("VALIDATE");
    const plusLarge = detenteur("REGULATORY_ASSISTANT", [{
      module: "REGULATORY", canView: true, canCreate: true, canUpdate: true, canUpload: true, canExport: true, canValidate: true,
    }]);
    expect(plusLarge.detient.get("REGULATORY")?.actions.has("VALIDATE"), "PRÉMISSE : la console l'ajoute").toBe(true);
    expect(delegatedActions(plusLarge, "REGULATORY")).not.toContain("VALIDATE");
    expect(delegatedActions(plusLarge, "REGULATORY")).toContain("UPDATE");
    const autreRole = detenteur("REGULATORY_ASSISTANT", [], "HEAD_OF_SALES");
    expect(autreRole.detient.get("PCH")?.actions.has("VIEW"), "PRÉMISSE : l'autre rôle ouvre les marchés").toBe(true);
    expect(delegatedActions(autreRole, "PCH")).toBeNull();
  });

  it("delegationsFor ne rend que ce qui est réellement transmis", () => {
    const d = delegationsFor(parRole("MEDICAL_DELEGATE"), ["FINANCES", "MEDICAL", "ADMIN"]);
    expect(d.map((x) => x.module)).toEqual(["MEDICAL"]);
  });

  it("une liste vide ne délègue rien", () => {
    expect(delegationsFor(parRole("DIRECTION"), [])).toEqual([]);
  });

  it("modulesPretables : la liste de l'écran — ni module retiré, ni espace personnel, ni siège", () => {
    const m = modulesPretables(parRole("DIRECTION"));
    expect(m, "ce que la Direction détient et qui se prête").toEqual(expect.arrayContaining(["FINANCES", "RH", "PCH", "VALIDATIONS"]));
    for (const jamais of ["SALES", "LOGISTICS", "BUSINESS_DEVELOPMENT", "DRIVE", "MESSAGING", "WORKSPACE", "NOTIFICATIONS", "PAYMENT_CENTRE", "MY_TEAM", "DIRECTORIES", "ADMIN"]) {
      expect(m, jamais).not.toContain(jamais);
    }
    // Le centre de paiement n'est plus dans la matrice de la Direction (24/11/2026) ; il reste un siège, jamais prêté — la
    // prémisse se lit sur le Directeur Général, qui le porte.
    expect(modulesPretables(parRole("GENERAL_MANAGER")), "un siège ne se prête pas").not.toContain("PAYMENT_CENTRE");
    expect(PERMISSIONS.GENERAL_MANAGER.PAYMENT_CENTRE, "PRÉMISSE : la matrice du DG porte le centre").toContain("VIEW");
  });

  // La souveraineté du Super Admin ne se prête pas, et un SIÈGE se donne par un rôle ou une
  // désignation, pas par une case : prêté, il ouvrait une entrée de menu menant à une page refusée.
  it("la souveraineté du Super Admin et les sièges ne se prêtent jamais — même par un Super Admin absent", () => {
    const sa = parRole("SUPER_ADMIN");
    for (const m of ["ADMIN", "ADVENTUM_BRAIN", "PROCESS_INTELLIGENCE", "PAYMENT_CENTRE", "VALIDATION_CENTRE", "AD_PRO_CENTRE", "CHIEF_OF_STAFF"] as const) {
      expect(isDelegatable(m), m).toBe(false);
      expect(delegatedActions(sa, m), m).toBeNull();
    }
    expect(sa.detient.get("ADVENTUM_BRAIN")?.actions.has("VIEW"), "PRÉMISSE : le Super Admin le détient").toBe(true);
  });

  it("modulesNonPretes nomme ce qui ne passerait pas", () => {
    const a = detenteur("HEAD_OF_SALES", [{ module: "PCH", canView: true }, { module: "STOCKS", canView: false }]);
    expect(modulesNonPretes(a, ["PCH", "STOCKS", "SALES", " PCH ", ""])).toEqual(["STOCKS", "SALES"]);
    expect(modulesNonPretes(a, ["PCH"])).toEqual([]);
  });
});

describe("congeTermine — le dernier jour reste ouvert", () => {
  it("le dernier jour est encore à tenir ; le lendemain, plus rien", () => {
    expect(congeTermine("2026-09-10", new Date("2026-09-10T22:00:00Z"))).toBe(false);
    expect(congeTermine("2026-09-10", new Date("2026-09-11T08:00:00Z"))).toBe(true);
    expect(congeTermine("2026-09-10", new Date("2026-09-01T08:00:00Z"))).toBe(false);
  });

  it("une date illisible ne déclare pas le congé terminé", () => {
    expect(congeTermine("n'importe quoi", new Date("2026-09-11T08:00:00Z"))).toBe(false);
  });
});

describe("actsFor — qui remplace qui, à cet instant", () => {
  const full = { ...leave(), absenteeUserId: "absent" };

  it("l'intérimaire validé agit pendant la fenêtre", () => {
    expect(actsFor(full, "remplacant", during)).toBe(true);
  });

  it("quelqu'un d'autre ne remplace personne", () => {
    expect(actsFor(full, "un-tiers", during)).toBe(false);
  });

  // Le cas naît tout seul le jour où quelqu'un se désigne par erreur — et ferait passer une
  // auto-validation pour une intérim.
  it("on ne se remplace pas soi-même", () => {
    expect(actsFor({ ...full, standInId: "absent" }, "absent", during)).toBe(false);
  });

  it("hors fenêtre, plus personne ne remplace", () => {
    expect(actsFor(full, "remplacant", new Date("2026-10-01T09:00:00Z"))).toBe(false);
  });
});

describe("messages", () => {
  it("chaque état porte un libellé", () => {
    for (const s of ["PENDING", "APPROVED", "REJECTED"] as StandInStatus[]) {
      expect(STAND_IN_LABEL[s]).toBeTruthy();
    }
  });

  it("le bandeau dit QUI l'on remplace et JUSQU'À QUAND", () => {
    const n = delegationNotice("Karim Saïdi", "2026-09-10");
    expect(n).toContain("Karim Saïdi");
    expect(n).toContain("septembre");
  });

  it("une date illisible ne produit pas « Invalid Date » à l'écran", () => {
    expect(delegationNotice("Karim", "???")).toContain("pendant son congé");
  });

  // Elle disait « Vous remplacez X : ses validations vous sont ouvertes » le jour de la validation RH —
  // souvent des semaines avant le congé, parfois avant qu'il soit accordé.
  it("l'annonce des RH dit QUAND l'intérim s'ouvrira — pas « vous remplacez » avant le congé", () => {
    const conge = { leaveApproved: true, startDate: "2026-09-01", endDate: "2026-09-10" };
    const avant = annonceDeValidation("Karim Saïdi", conge, ["Marchés PCH"], new Date("2026-08-20T09:00:00Z"));
    expect(avant).not.toContain("Vous remplacez");
    expect(avant).toContain("Karim Saïdi (congé du 1 septembre au 10 septembre)");
    expect(avant).toContain("L'intérim s'ouvrira de lui-même au premier jour du congé");
    expect(avant).toContain("« Mon espace »");
    expect(avant).toContain("Modules prêtés : Marchés PCH.");

    const pasAccorde = annonceDeValidation("Karim Saïdi", { ...conge, leaveApproved: false }, [], new Date("2026-08-20T09:00:00Z"));
    expect(pasAccorde).toContain("Le congé n'est pas encore accordé");
    expect(pasAccorde).not.toContain("Modules prêtés");

    const pendant = annonceDeValidation("Karim Saïdi", conge, ["Marchés PCH"], during);
    expect(pendant).toContain("Vous remplacez Karim Saïdi jusqu'au 10 septembre");
    expect(pendant).toContain("Elles sont réunies dans « Mon espace ».");
  });

  it("le bandeau dit qui, jusqu'à quand et ce qui est prêté", () => {
    const b = bandeauInterim({ absentNom: "Karim Saïdi", jusquau: "2026-10-12", modules: ["PCH", "VALIDATIONS"] }, MODULE_LABELS);
    expect(b).toBe("Intérim : vous remplacez Karim Saïdi jusqu'au 12 octobre (Marchés PCH, Demandes de validations) — ce que vous tranchez pour cette personne est enregistré à votre nom.");
    expect(bandeauInterim({ absentNom: "K", jusquau: "???", modules: [] }, MODULE_LABELS)).toBe(
      "Intérim : vous remplacez K pendant son congé — ce que vous tranchez pour cette personne est enregistré à votre nom.",
    );
  });
});
