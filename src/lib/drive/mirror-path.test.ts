import { describe, it, expect } from "vitest";
import { EntityType } from "@prisma/client";
import { shouldMirrorToDrive, copieAuDriveAutorisee, COPIE_AU_DRIVE, safeFolderName, importFolderPath, IMPORT_DRIVE_ROOT } from "./mirror-path";

describe("Ce qui entre dans l'ERP entre aussi dans le Drive — sauf les pièces des personnes (F2)", () => {
  it("une pièce interne d'un objet d'entreprise part au Drive", () => {
    expect(shouldMirrorToDrive("SPONSORING", "INTERNAL")).toBe(true);
    expect(shouldMirrorToDrive("PCH_TENDER", "INTERNAL")).toBe(true);
    expect(shouldMirrorToDrive("PROMO_MATERIAL", "INTERNAL")).toBe(true);
  });

  it("une pièce non interne n'a JAMAIS de copie, quel que soit l'objet", () => {
    expect(shouldMirrorToDrive("SPONSORING", "CONFIDENTIAL")).toBe(false);
    expect(shouldMirrorToDrive("SPONSORING", "RESTRICTED")).toBe(false);
    expect(copieAuDriveAutorisee("REGULATORY_PRODUCT", "CONFIDENTIAL")).toBe(false);
  });

  it("RH, médical, pharmacovigilance et voyageurs : jamais, même internes", () => {
    for (const t of ["HR_REQUEST", "EMPLOYEE", "PAYROLL", "LEAVE_REQUEST", "MEDICAL_INFO_DECLARATION", "VISIT", "DOCTOR",
      "PHARMACOVIGILANCE_CASE", "MISSION_ASSIGNMENT", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "ADMIN_REQUEST", "AD_PRO_ITEM"]) {
      expect(copieAuDriveAutorisee(t, "INTERNAL"), t).toBe(false);
    }
  });

  it("un type que la table ne connaît pas ne se copie pas", () => {
    expect(shouldMirrorToDrive("UN_TYPE_AJOUTE_DEMAIN", "INTERNAL")).toBe(false);
    expect(shouldMirrorToDrive("", "INTERNAL")).toBe(false);
  });

  it("la table couvre EXACTEMENT les types d'objet du schéma — un type nouveau se range en connaissance de cause", () => {
    expect(Object.keys(COPIE_AU_DRIVE).sort()).toEqual(Object.values(EntityType).sort());
  });

  it("ce qui a déjà son miroir n'est pas recopié dans « Mes documents importés »", () => {
    expect(shouldMirrorToDrive("REGULATORY_PRODUCT", "INTERNAL")).toBe(false);
    expect(copieAuDriveAutorisee("REGULATORY_PRODUCT", "INTERNAL")).toBe(true);
    expect(shouldMirrorToDrive("DRIVE_NODE", "INTERNAL")).toBe(false);
  });
});

describe("Un nom de dossier qui ne casse pas l'arborescence", () => {
  it("une barre oblique ne fabrique pas un sous-dossier fantôme", () => {
    expect(safeFolderName("Devis 2026/2027")).toBe("Devis 2026-2027");
    expect(safeFolderName("Chemin\\Windows")).toBe("Chemin-Windows");
  });

  it("les caractères de contrôle et les espaces multiples disparaissent", () => {
    expect(safeFolderName("A\u0000B\u001FC")).toBe("A B C");
    expect(safeFolderName("  Trop   d'espaces  ")).toBe("Trop d'espaces");
  });

  it("un nom vide retombe sur le repli, jamais sur un dossier sans nom", () => {
    expect(safeFolderName("   ")).toBe("Sans nom");
    expect(safeFolderName("///", "Autres")).toBe("Autres");
  });

  it("un nom interminable est coupé — une liste reste lisible", () => {
    expect(safeFolderName("x".repeat(400)).length).toBe(120);
  });
});

describe("Où l'on retrouvera le fichier", () => {
  it("range par module puis par objet, sous une seule boîte", () => {
    expect(importFolderPath("SPONSORING", "SPO-2026-014", "ck1234567890")).toEqual([
      IMPORT_DRIVE_ROOT, "Sponsoring", "SPO-2026-014",
    ]);
  });

  it("le module est écrit dans les mots de l'ERP, pas en majuscules techniques", () => {
    expect(importFolderPath("PCH_TENDER", "AO-12", "id")[1]).toBe("Appel d'offres");
    expect(importFolderPath("HR_REQUEST", null, "id")[1]).toBe("Demande RH");
  });

  it("un type inconnu ne casse rien : il porte son propre nom", () => {
    expect(importFolderPath("TYPE_INCONNU", "REF-1", "id")[1]).toBe("TYPE_INCONNU");
  });

  it("sans référence, deux objets différents ne se mélangent pas", () => {
    const a = importFolderPath("EVENT", null, "aaaaaaaa1111");
    const b = importFolderPath("EVENT", "", "bbbbbbbb2222");
    expect(a[2]).not.toBe(b[2]);
    expect(a[2]).toBe("Dossier aaaaaaaa");
  });

  it("toujours trois niveaux — la boîte, le module, l'objet", () => {
    expect(importFolderPath("EVENT", "EVT-1", "id")).toHaveLength(3);
    expect(importFolderPath("EVENT", "EVT-1", "id")[0]).toBe(IMPORT_DRIVE_ROOT);
  });
});
