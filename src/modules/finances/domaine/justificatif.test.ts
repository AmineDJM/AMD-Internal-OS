import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  categorieDeNature, estRegularisation, JUSTIFICATIF_DE_SOURCE, KINDS_JUSTIFIANTS, NATURE_DE_CATEGORIE, natureAcceptee,
  ORIGINES_JUSTIFIEES, phraseJustificatifAttendu, REGLE_PAR_DEFAUT, refusDeDepotDePiece, regleDeJustificatif,
} from "./justificatif";
import {
  applyDecision, attendJustificatif, blockedReason, canDisburse, HORS_DU_CENTRE, initialCentralStatus, statutApresJustificatif,
  statutApresNouveauMontant, visibleToFinance,
} from "./authorization";
import { etatDuPaiement } from "./relance-paiement";
import { etatDeLOrdre } from "./reglement";

/**
 * LE JUSTIFICATIF OBLIGATOIRE (Super Admin, 24/11/2026) — la règle pure : la table, et l'état « en attente du
 * justificatif » qui tient l'ordre HORS du centre et des Finances.
 */

describe("la table JUSTIFICATIF_DE_SOURCE est exhaustive", () => {
  it("chaque sourceType littéral passé à createExpenseOrder a sa ligne — un circuit ajouté sans elle tombe ici", () => {
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) parcourir(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) fichiers.push(p);
      }
    };
    parcourir(path.join(process.cwd(), "src"));
    const utilises = new Set<string>();
    for (const f of fichiers) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("createExpenseOrder(") && !src.includes("ordreDeLaDemande") && !src.includes("ordreDeLApprobation")) continue;
      for (const m of src.matchAll(/sourceType:\s*"([A-Z_]+)"/g)) utilises.add(m[1]);
    }
    expect(utilises.size).toBeGreaterThan(3);
    // Les sources DYNAMIQUES (parent d'un poste, source d'une déclaration, prise en charge) : nommées ici.
    for (const t of ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "AD_PRO_OTHER", "PROMO_MATERIAL"]) utilises.add(t);
    const manquantes = [...utilises].filter((t) => !ORIGINES_JUSTIFIEES.includes(t as never));
    expect(manquantes).toEqual([]);
  });

  it("la remise de caisse (sans fiche d'origine) a la sienne : le bon de remise", () => {
    expect(regleDeJustificatif(null)).toBe(JUSTIFICATIF_DE_SOURCE.SANS_SOURCE);
    expect(JUSTIFICATIF_DE_SOURCE.SANS_SOURCE.natures).toContain("CASH_VOUCHER");
  });

  it("une origine inconnue n'est jamais exemptée : elle exige une pièce d'achat", () => {
    expect(regleDeJustificatif("DRIVER_MISSION")).toBe(REGLE_PAR_DEFAUT);
    expect(REGLE_PAR_DEFAUT.natures).toContain("INVOICE");
  });

  it("chaque origine nomme au moins une nature, un lieu et le service qui joint la pièce", () => {
    for (const o of ORIGINES_JUSTIFIEES) {
      const r = JUSTIFICATIF_DE_SOURCE[o];
      expect(r.natures.length, o).toBeGreaterThan(0);
      expect(r.lieux.length, o).toBeGreaterThan(0);
      expect(r.service.length, o).toBeGreaterThan(3);
    }
  });

  it("les natures par origine : la paie par son état de paie, l'avance par la demande signée, le BV par lui-même", () => {
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.PAYROLL, "PAYROLL_STATE")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.PAYROLL, "INVOICE")).toBe(false);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.SALARY_ADVANCE, "DEMANDE_SIGNEE")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.PAYMENT_REQUEST, "BON_DE_VERSEMENT")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.ADMIN_REQUEST, "PIECE_VALIDEE")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.SPONSORING, "PROFORMA")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.SPONSORING, "REQUEST_LETTER")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.CONGRESS_NATIONAL, "DECLARATION")).toBe(true);
    expect(natureAcceptee(JUSTIFICATIF_DE_SOURCE.LEGAL_DOCUMENT, "INVOICE")).toBe(true);
  });

  it("un bon de livraison, une photo, « autre pièce » ne justifient rien", () => {
    expect(KINDS_JUSTIFIANTS).not.toContain("DELIVERY_NOTE");
    expect(KINDS_JUSTIFIANTS).not.toContain("OTHER");
    expect(NATURE_DE_CATEGORIE.PHOTO).toBeUndefined();
    expect(NATURE_DE_CATEGORIE.OTHER).toBeUndefined();
  });

  it("un justificatif joint se range dans sa catégorie de document, ou en « pièce justificative »", () => {
    expect(categorieDeNature("INVOICE")).toBe("INVOICE");
    expect(categorieDeNature("PROFORMA")).toBe("PROFORMA");
    expect(categorieDeNature("PAYROLL_STATE")).toBe("SUPPORTING_DOC");
    expect(categorieDeNature("CASH_VOUCHER")).toBe("SUPPORTING_DOC");
  });

  it("la phrase dit ce qu'on attend, pas seulement ce qui manque", () => {
    expect(phraseJustificatifAttendu("PAYROLL")).toMatch(/état de paie/);
    expect(phraseJustificatifAttendu(null)).toMatch(/bon de remise/);
    expect(phraseJustificatifAttendu("SPONSORING")).toMatch(/centre de paiement/);
  });
});

describe("« en attente du justificatif » : hors du centre, hors des Finances", () => {
  it("un ordre sans justificatif naît AWAITING_PROOF ; justifié, il naît au centre", () => {
    expect(initialCentralStatus({ amount: 1000, justifie: false })).toBe("AWAITING_PROOF");
    expect(initialCentralStatus({ amount: 1000, justifie: true })).toBe("AWAITING");
    expect(attendJustificatif("AWAITING_PROOF")).toBe(true);
  });

  it("ni le centre (applyDecision), ni les Finances (visibleToFinance), ni le règlement (canDisburse) ne le prennent", () => {
    for (const d of ["APPROVE", "REFUSE", "REQUEST_CHANGES", "REQUEST_INFO"] as const) expect(applyDecision("AWAITING_PROOF", d)).toBeNull();
    expect(visibleToFinance("AWAITING_PROOF")).toBe(false);
    expect(canDisburse("AWAITING_PROOF")).toBe(false);
    expect(HORS_DU_CENTRE).toContain("AWAITING_PROOF");
    expect(blockedReason("AWAITING_PROOF")).toMatch(/justificatif/);
  });

  it("la pièce jointe le fait entrer au centre — et seulement depuis cet état", () => {
    expect(statutApresJustificatif("AWAITING_PROOF", true)).toBe("AWAITING");
    expect(statutApresJustificatif("AWAITING_PROOF", false)).toBeNull();
    expect(statutApresJustificatif("AWAITING", true)).toBeNull();
    expect(statutApresJustificatif("APPROVED", true)).toBeNull();
    expect(statutApresJustificatif("REFUSED", true)).toBeNull();
  });

  it("un montant relevé ne le fait pas entrer au centre sans sa pièce", () => {
    expect(statutApresNouveauMontant({ courant: "AWAITING_PROOF", avant: 10, apres: 100 })).toBe("AWAITING_PROOF");
  });

  it("la main est au demandeur ; le règlement le dit en attente du justificatif", () => {
    expect(etatDuPaiement({ ordre: { status: "PENDING", centralStatus: "AWAITING_PROOF" } })).toBe("DEMANDEUR");
    expect(etatDeLOrdre({ status: "PENDING", centralStatus: "AWAITING_PROOF" })).toBe("JUSTIFICATIF");
  });
});

describe("régulariser un paiement soldé : ajouter, jamais retirer", () => {
  it("un dossier compagnon soldé reçoit une pièce ajoutée, pas une pièce remplacée", () => {
    expect(refusDeDepotDePiece({ status: "APPROVED", origin: "EXPENSE_ORDER", remplace: false })).toBeNull();
    expect(refusDeDepotDePiece({ status: "APPROVED", origin: "EXPENSE_ORDER", remplace: true })).toMatch(/jamais en remplacer/);
    expect(estRegularisation("APPROVED", "EXPENSE_ORDER")).toBe(true);
  });

  it("une demande de paiement close (non compagnon), un dossier refusé ou annulé : rien", () => {
    expect(refusDeDepotDePiece({ status: "APPROVED", origin: "REQUEST", remplace: false })).toMatch(/clos/);
    expect(refusDeDepotDePiece({ status: "CANCELLED", origin: "EXPENSE_ORDER", remplace: false })).toMatch(/clos/);
    expect(refusDeDepotDePiece({ status: "SUBMITTED", origin: "EXPENSE_ORDER", remplace: false })).toBeNull();
  });
});
