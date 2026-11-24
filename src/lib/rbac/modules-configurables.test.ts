import { describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import {
  accesAttribue, MODULES, PERMISSIONS, userCan, ouvreLeBureauAdam, hasRole, type LigneAccesAttribue, type Module, type SessionUser,
} from "@/lib/rbac";
import { MODULE_LABELS } from "@/lib/labels";
import { sitsOnPaymentCentre } from "@/modules/finances/partage";
import { siegeAuCentreAdPro } from "@/modules/ad-pro/partage";
import { ouvreLeCentreDeValidations } from "@/lib/validations/centre";
import { estDirecteurDesOperations } from "@/lib/suppression/delegation";
import { isRetiredModule } from "@/lib/modules-retired";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TOUS LES MODULES AFFICHÉS SE RÈGLENT DEPUIS LA CONSOLE — ET LE JOUR DU DÉPLOIEMENT, PERSONNE NE GAGNE NI NE PERD UN
 * ACCÈS (Super Admin, 24/11/2026).
 *
 * Le cas est joué rôle par rôle, et pour CHAQUE couple rôle principal × « autre rôle » : la règle d'hier (recopiée ici telle
 * qu'elle était écrite dans le code — listes de rôles, `FINANCES`, `RH` Modifier) contre la règle d'aujourd'hui (la clé de
 * chaque écran, lue sur l'accès résolu, plus les blocages que la migration `modules_configurables` pose aux « autres rôles »
 * qui tenaient un module sans qu'il les ouvre). Une seule différence admise doit se lire ici : aucune.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ROLES = Object.keys(PERMISSIONS) as UserRole[];
const R_PAIEMENT = ["SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER"];
const R_CENTRE = ["SUPER_ADMIN", "GENERAL_MANAGER"];

/** Les lignes que la migration pose sans qu'aucune console ne les ait réglées : les « autres rôles » neutralisés. */
function lignesDeLaMigration(role: UserRole, second: UserRole | null): LigneAccesAttribue[] {
  const bloque = (module: string): LigneAccesAttribue => ({
    module, canView: false, canCreate: false, canUpdate: false, canDelete: false, canValidate: false, canExport: false,
    canUpload: false, scope: "ASSIGNED", sections: [],
  });
  const lignes: LigneAccesAttribue[] = [];
  if (!R_CENTRE.includes(role) && second && R_CENTRE.includes(second)) lignes.push(bloque("VALIDATION_CENTRE"));
  if (role !== "SUPER_ADMIN" && second === "SUPER_ADMIN") lignes.push(bloque("CHIEF_OF_STAFF"));
  if (!["SUPER_ADMIN", "DIRECTION", "OPERATIONS_DIRECTOR"].includes(role) && second === "SUPER_ADMIN") lignes.push(bloque("CORBEILLE"));
  return lignes;
}

function personne(role: UserRole, second: UserRole | null, lignes: LigneAccesAttribue[] = []): SessionUser {
  const { modules } = accesAttribue(role, second, lignes);
  return { id: `${role}/${second}`, role, secondaryRole: second, access: { modules, rowGrants: new Map() } } as SessionUser;
}

/** La matrice d'HIER, route par route — la règle telle que le code l'écrivait avant le 24/11/2026. */
function hier(u: SessionUser): Record<string, boolean> {
  const roles = [u.role, u.secondaryRole].filter(Boolean) as string[];
  const siegeAdPro = roles.some((r) => R_CENTRE.includes(r));
  return {
    "/finances/paiements-a-faire": userCan(u, "FINANCES", "VIEW"),
    "/finances/paiements-a-faire › régler": userCan(u, "FINANCES", "UPDATE"),
    "/finances/comptabilite": userCan(u, "FINANCES", "VIEW"),
    "/finances/comptabilite › saisir": userCan(u, "FINANCES", "CREATE"),
    "/finances/comptabilite › modifier": userCan(u, "FINANCES", "UPDATE"),
    "/finances/comptabilite › supprimer": userCan(u, "FINANCES", "DELETE"),
    "/finances/doublons-factures": userCan(u, "FINANCES", "VIEW"),
    "/finances/doublons-factures › examiner": userCan(u, "FINANCES", "VIEW") && (userCan(u, "FINANCES", "UPDATE") || ["SUPER_ADMIN", "DIRECTION"].includes(u.role)),
    // Impôts & cotisations (24/11/2026) : un écran neuf, ouvert par défaut à qui tenait FINANCES, avec ses gestes.
    "/finances/impots-cotisations": userCan(u, "FINANCES", "VIEW"),
    "/finances/impots-cotisations › préparer, envoyer": userCan(u, "FINANCES", "UPDATE"),
    "/finances/impots-cotisations › paiement ponctuel": userCan(u, "FINANCES", "CREATE"),
    "/centre-de-paiement › siéger": roles.some((r) => R_PAIEMENT.includes(r)),
    "/centre-de-validations": userCan(u, "VALIDATION_CENTRE", "VIEW") && R_CENTRE.includes(u.role),
    "/centre-ad-pro": userCan(u, "AD_PRO_CENTRE", "VIEW") && siegeAdPro,
    "/centre-ad-pro › arbitrer, viser un BC": siegeAdPro,
    "/agences": hasRole(u, "DIRECTION_ASSISTANT") || hasRole(u, "PRODUCT_MANAGER") || hasRole(u, "SUPER_ADMIN"),
    "/information-medicale/conformite": hasRole(u, "MEDICAL_INFO_PHARMACIST") || hasRole(u, "SUPER_ADMIN") || hasRole(u, "PRODUCT_MANAGER"),
    "/rh/paie": userCan(u, "RH", "UPDATE"),
    "/corbeille": u.role !== "SUPER_ADMIN" && estDirecteurDesOperations(u),
    // `CHIEF_OF_STAFF` ET le rôle principal Super Admin (qui a toujours le module par défaut).
    "/adam/boite, /adam/reglages, /adam/bureau": u.role === "SUPER_ADMIN",
  };
}

/** La matrice d'AUJOURD'HUI — la clé de chaque écran, et la règle nommée qui la lit. */
function aujourdhui(u: SessionUser): Record<string, boolean> {
  return {
    "/finances/paiements-a-faire": userCan(u, "FINANCES_BANQUE", "VIEW"),
    "/finances/paiements-a-faire › régler": userCan(u, "FINANCES_BANQUE", "UPDATE"),
    "/finances/comptabilite": userCan(u, "FINANCES_COMPTABILITE", "VIEW"),
    "/finances/comptabilite › saisir": userCan(u, "FINANCES_COMPTABILITE", "CREATE"),
    "/finances/comptabilite › modifier": userCan(u, "FINANCES_COMPTABILITE", "UPDATE"),
    "/finances/comptabilite › supprimer": userCan(u, "FINANCES_COMPTABILITE", "DELETE"),
    "/finances/doublons-factures": userCan(u, "FINANCES_DOUBLONS", "VIEW"),
    "/finances/doublons-factures › examiner": userCan(u, "FINANCES_DOUBLONS", "UPDATE"),
    "/finances/impots-cotisations": userCan(u, "FINANCES_IMPOTS", "VIEW"),
    "/finances/impots-cotisations › préparer, envoyer": userCan(u, "FINANCES_IMPOTS", "UPDATE"),
    "/finances/impots-cotisations › paiement ponctuel": userCan(u, "FINANCES_IMPOTS", "CREATE"),
    "/centre-de-paiement › siéger": sitsOnPaymentCentre(u),
    "/centre-de-validations": ouvreLeCentreDeValidations(u),
    "/centre-ad-pro": userCan(u, "AD_PRO_CENTRE", "VIEW") && siegeAuCentreAdPro(u),
    "/centre-ad-pro › arbitrer, viser un BC": siegeAuCentreAdPro(u),
    "/agences": userCan(u, "PROSPECTION_AGENCES", "VIEW"),
    "/information-medicale/conformite": userCan(u, "CONTROLES_CONFORMITE", "VIEW"),
    "/rh/paie": userCan(u, "PAIE", "VIEW"),
    "/corbeille": u.role !== "SUPER_ADMIN" && userCan(u, "CORBEILLE", "VIEW"),
    "/adam/boite, /adam/reglages, /adam/bureau": ouvreLeBureauAdam(u),
  };
}

describe("l'état par défaut de chaque rôle est IDENTIQUE avant et après (24/11/2026)", () => {
  it("rôle par rôle, sans « autre rôle » : la même matrice d'accès sur toutes les routes concernées", () => {
    const ecarts: string[] = [];
    for (const role of ROLES) {
      const u = personne(role, null, lignesDeLaMigration(role, null));
      const avant = hier(u);
      const apres = aujourdhui(u);
      for (const route of Object.keys(avant)) if (avant[route] !== apres[route]) ecarts.push(`${role} · ${route} : ${avant[route]} → ${apres[route]}`);
    }
    expect(ecarts).toEqual([]);
  });

  it("chaque couple rôle principal × « autre rôle » — la migration bloque ce qu'un autre rôle tenait sans l'ouvrir", () => {
    const ecarts: string[] = [];
    for (const role of ROLES) {
      for (const second of ROLES) {
        if (second === role) continue;
        const u = personne(role, second, lignesDeLaMigration(role, second));
        const avant = hier(u);
        const apres = aujourdhui(u);
        for (const route of Object.keys(avant)) if (avant[route] !== apres[route]) ecarts.push(`${role}+${second} · ${route} : ${avant[route]} → ${apres[route]}`);
      }
    }
    expect(ecarts).toEqual([]);
  });

  it("PRÉMISSE : la matrice n'est pas vide — les routes s'ouvrent à quelqu'un et se ferment à quelqu'un d'autre", () => {
    const sa = aujourdhui(personne("SUPER_ADMIN", null));
    const viewer = aujourdhui(personne("VIEWER", null));
    for (const route of Object.keys(sa)) {
      if (route === "/corbeille") continue; // le Super Admin a la sienne dans la Console d'Administration
      expect(sa[route], route).toBe(true);
      expect(viewer[route], route).toBe(false);
    }
  });
});

describe("chaque écran a sa clé, réglable dans la console", () => {
  it("les nouvelles clés existent, sont nommées comme le menu, et aucun module retiré n'en fait partie", () => {
    const attendus: Record<string, string> = {
      FINANCES_BANQUE: "Banque & paiements", FINANCES_COMPTABILITE: "Comptabilité", FINANCES_DOUBLONS: "Doublons de factures",
      FINANCES_IMPOTS: "Impôts & cotisations",
      PROSPECTION_AGENCES: "Prospection d'agences", CONTROLES_CONFORMITE: "Contrôles de conformité", PAIE: "Paie", CORBEILLE: "Corbeille",
    };
    for (const [cle, libelle] of Object.entries(attendus)) {
      expect(MODULES as readonly string[], cle).toContain(cle);
      expect(MODULE_LABELS[cle as Module]).toBe(libelle);
      expect(isRetiredModule(cle)).toBe(false);
    }
  });

  it("BLOQUÉ sur Doublons de factures : la personne ne les voit plus, et voit toujours Banque & paiements et la Comptabilité", () => {
    const bloque: LigneAccesAttribue = {
      module: "FINANCES_DOUBLONS", canView: false, canCreate: false, canUpdate: false, canDelete: false, canValidate: false,
      canExport: false, canUpload: false, scope: "ASSIGNED", sections: [],
    };
    const u = personne("FINANCE_BUDGET_MANAGER", null, [bloque]);
    expect(userCan(u, "FINANCES_DOUBLONS", "VIEW")).toBe(false);
    expect(userCan(u, "FINANCES_BANQUE", "UPDATE")).toBe(true);
    expect(userCan(u, "FINANCES_COMPTABILITE", "VIEW")).toBe(true);
    expect(userCan(u, "FINANCES_IMPOTS", "UPDATE")).toBe(true);
  });

  it("BLOQUÉ sur Impôts & cotisations : la personne ne les voit plus, et garde Banque & paiements", () => {
    const bloque: LigneAccesAttribue = {
      module: "FINANCES_IMPOTS", canView: false, canCreate: false, canUpdate: false, canDelete: false, canValidate: false,
      canExport: false, canUpload: false, scope: "ASSIGNED", sections: [],
    };
    const u = personne("FINANCE_BUDGET_MANAGER", null, [bloque]);
    expect(userCan(u, "FINANCES_IMPOTS", "VIEW")).toBe(false);
    expect(userCan(u, "FINANCES_BANQUE", "UPDATE")).toBe(true);
  });

  it("le Centre de paiement : accordé, il fait siéger ; bloqué, il retire le siège — au Super Admin près, qui ne s'exclut pas", () => {
    const ligne = (canView: boolean): LigneAccesAttribue => ({
      module: "PAYMENT_CENTRE", canView, canCreate: false, canUpdate: false, canDelete: false, canValidate: canView,
      canExport: false, canUpload: false, scope: "ALL", sections: [],
    });
    expect(sitsOnPaymentCentre(personne("COORDINATOR", null, [ligne(true)]))).toBe(true);
    expect(sitsOnPaymentCentre(personne("DIRECTION", null, [ligne(false)]))).toBe(false);
    expect(sitsOnPaymentCentre(personne("SUPER_ADMIN", null, [ligne(false)]))).toBe(true);
  });

  it("le Centre Ad & Pro et le bureau d'Adam : accorder ouvre, bloquer ferme", () => {
    const ligne = (module: string, canView: boolean): LigneAccesAttribue => ({
      module, canView, canCreate: false, canUpdate: false, canDelete: false, canValidate: false,
      canExport: false, canUpload: false, scope: "ALL", sections: [],
    });
    expect(siegeAuCentreAdPro(personne("PRODUCT_MANAGER", null, [ligne("AD_PRO_CENTRE", true)]))).toBe(true);
    expect(siegeAuCentreAdPro(personne("GENERAL_MANAGER", null, [ligne("AD_PRO_CENTRE", false)]))).toBe(false);
    expect(ouvreLeBureauAdam(personne("DIRECTION", null, [ligne("CHIEF_OF_STAFF", true)]))).toBe(true);
    expect(ouvreLeBureauAdam(personne("DIRECTION", null))).toBe(false);
  });
});
