import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EntityType } from "@prisma/client";
import {
  ENTITE_SANS, PORTEURS_D_ORIGINE, SECTIONS_CENTRE, SECTION_CENTRE_LABEL, SECTION_CENTRE_SLUG, SECTION_DU_TYPE,
  choisirEntite, choisirSection, classerOrdre, origineEffective, sectionDepuisSlug, sectionDuType,
  type SectionCentre,
} from "./domaine/sections-centre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TROIS SECTIONS DU CENTRE DE PAIEMENT (§118.211) — la règle pure, sur chaque type d'origine.
 *
 * « Chaque entité aura trois types de demandes de paiement : Regulatory / Sales & Marketing /
 * Autres. » La section se lit sur l'ORIGINE de l'ordre (jamais sur son libellé) ; la table est
 * exhaustive sur l'énumération du schéma, et « Autres » est le seul repli — qui se compte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const R: SectionCentre = "REGULATORY";
const S: SectionCentre = "SALES_MARKETING";
const A: SectionCentre = "AUTRES";

/**
 * Chaque type d'origine RÉELLEMENT écrit sur un ordre de dépense, avec la section que la Direction
 * en attend — écrit ICI, indépendamment de la table du module : si les deux divergent, le banc tombe.
 */
const ATTENDU: Partial<Record<EntityType, SectionCentre>> = {
  REGULATORY_PRODUCT: R,           // taxes ANPP, dépôts de dossiers
  MEDICAL_INFO_DECLARATION: R,     // pôle Regulatory depuis §118.118
  SPONSORING: S, CONGRESS_INTERNATIONAL: S, CONGRESS_NATIONAL: S, EVENT: S, PROMO_MATERIAL: S,
  AD_PRO_ITEM: S, AD_PRO_OTHER: S, CONSULTING_CONTRACT: S,
  PAYROLL: A, SALARY_ADVANCE: A, ADMIN_REQUEST: A, PAYMENT_REQUEST: A, LEGAL_DOCUMENT: A,
};

describe("la table des sections — exhaustive, et lue sur l'origine", () => {
  const types = Object.values(EntityType) as EntityType[];

  it("chaque valeur de l'énumération du schéma a une section, et une seule des trois", () => {
    expect(types.length).toBeGreaterThan(40);
    for (const t of types) {
      expect(SECTIONS_CENTRE, `« ${t} » doit être classé`).toContain(SECTION_DU_TYPE[t]);
    }
    // Et la table ne parle pas d'un type qui n'existe plus.
    expect(Object.keys(SECTION_DU_TYPE).sort()).toEqual([...types].sort());
  });

  it("chaque type d'origine réel tombe dans la section que la Direction attend", () => {
    for (const [type, attendu] of Object.entries(ATTENDU) as [EntityType, SectionCentre][]) {
      expect(sectionDuType(type), type).toBe(attendu);
      expect(classerOrdre({ sourceType: type }).section, `ordre direct ${type}`).toBe(
        PORTEURS_D_ORIGINE.has(type) ? A : attendu,
      );
    }
  });

  it("chaque `sourceType` littéral que le code écrit sur un ordre est décidé ICI (un circuit neuf force une décision)", () => {
    // `src/lib` ET `src/modules` : les demandes de paiement émettent leurs ordres depuis le module finances.
    const racines = ["src/lib", "src/modules"].map((r) => join(process.cwd(), r));
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const nom of readdirSync(dir)) {
        const chemin = join(dir, nom);
        if (statSync(chemin).isDirectory()) parcourir(chemin);
        else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) fichiers.push(chemin);
      }
    };
    for (const r of racines) parcourir(r);
    const trouves = new Set<string>();
    let lus = 0;
    for (const f of fichiers) {
      const src = readFileSync(f, "utf8");
      if (!/createExpenseOrder\(/.test(src)) continue;
      lus += 1;
      for (const m of src.matchAll(/createExpenseOrder\(\{[\s\S]{0,900}?sourceType:\s*"([A-Z_]+)"/g)) trouves.add(m[1]!);
    }
    expect(lus, "la garde lit bien les circuits qui émettent des ordres").toBeGreaterThanOrEqual(10);
    expect(trouves.size, "la lecture trouve les sources littérales (plancher mesuré)").toBeGreaterThanOrEqual(6);
    for (const t of trouves) {
      expect(ATTENDU[t as EntityType], `« ${t} » émet des ordres : sa section doit être écrite dans ce banc`).toBeDefined();
    }
  });
});

describe("le classement d'un ordre", () => {
  it("un ordre sans type d'origine (remise de caisse) est un REPLI dans « Autres » — et se compte comme tel", () => {
    expect(classerOrdre({ sourceType: null })).toEqual({ section: A, repli: true });
    expect(classerOrdre({ sourceType: undefined })).toEqual({ section: A, repli: true });
  });

  it("une origine DÉCIDÉE n'est pas un repli, même dans « Autres » (la paie est décidée Autres)", () => {
    expect(classerOrdre({ sourceType: "PAYROLL" })).toEqual({ section: A, repli: false });
    expect(classerOrdre({ sourceType: "SPONSORING" })).toEqual({ section: S, repli: false });
    expect(classerOrdre({ sourceType: "REGULATORY_PRODUCT" })).toEqual({ section: R, repli: false });
  });

  it("un PORTEUR se classe sur l'origine qu'il déclare — demande de paiement, secrétariat, pièce Legal", () => {
    for (const porteur of ["PAYMENT_REQUEST", "ADMIN_REQUEST", "LEGAL_DOCUMENT"] as const) {
      expect(classerOrdre({ sourceType: porteur, origineDuPorteur: "SPONSORING" }), porteur).toEqual({ section: S, repli: false });
      expect(classerOrdre({ sourceType: porteur, origineDuPorteur: "REGULATORY_PRODUCT" }), porteur).toEqual({ section: R, repli: false });
      expect(classerOrdre({ sourceType: porteur, origineDuPorteur: "PAYROLL" }), porteur).toEqual({ section: A, repli: false });
    }
  });

  it("un porteur MUET, ou dont l'origine est un autre porteur, retombe sur « Autres » comme REPLI (un seul niveau)", () => {
    expect(classerOrdre({ sourceType: "PAYMENT_REQUEST", origineDuPorteur: null })).toEqual({ section: A, repli: true });
    expect(classerOrdre({ sourceType: "PAYMENT_REQUEST" })).toEqual({ section: A, repli: true });
    expect(classerOrdre({ sourceType: "PAYMENT_REQUEST", origineDuPorteur: "LEGAL_DOCUMENT" }), "on ne suit pas la chaîne plus loin").toEqual({ section: A, repli: true });
  });

  it("l'origine d'un porteur n'est lue que pour un porteur : un ordre direct ignore ce qu'on lui prête", () => {
    expect(classerOrdre({ sourceType: "SPONSORING", origineDuPorteur: "REGULATORY_PRODUCT" }).section).toBe(S);
    expect(origineEffective("PAYROLL", "SPONSORING")).toBe("PAYROLL");
  });

  it("un contrat de consulting passé aux RH se paie dans « Autres » ; jamais d'effet sur un autre type", () => {
    expect(classerOrdre({ sourceType: "CONSULTING_CONTRACT", contratRH: false }).section).toBe(S);
    expect(classerOrdre({ sourceType: "CONSULTING_CONTRACT", contratRH: true }).section).toBe(A);
    expect(classerOrdre({ sourceType: "SPONSORING", contratRH: true }).section, "contratRH n'a de sens que pour un contrat").toBe(S);
    expect(classerOrdre({ sourceType: "PAYMENT_REQUEST", origineDuPorteur: "CONSULTING_CONTRACT", contratRH: true }).section).toBe(A);
    expect(sectionDuType("CONSULTING_CONTRACT", { contratRH: true })).toBe(A);
  });

});

describe("les libellés et les adresses", () => {
  it("trois sections, nommées comme la Direction les a nommées, et des adresses qui reviennent au même", () => {
    expect(SECTIONS_CENTRE.map((s) => SECTION_CENTRE_LABEL[s])).toEqual(["Regulatory", "Sales & Marketing", "Autres"]);
    for (const s of SECTIONS_CENTRE) expect(sectionDepuisSlug(SECTION_CENTRE_SLUG[s])).toBe(s);
    expect(sectionDepuisSlug("nimporte")).toBeNull();
    expect(sectionDepuisSlug(null)).toBeNull();
    expect(new Set(SECTIONS_CENTRE.map((s) => SECTION_CENTRE_SLUG[s])).size).toBe(3);
  });
});

describe("l'entité et la section affichées", () => {
  const entites = [
    { cle: "a", enAttente: 1 },
    { cle: "b", enAttente: 5 },
    { cle: ENTITE_SANS, enAttente: 0 },
  ];

  it("la demande de l'adresse l'emporte quand elle désigne une pastille PRÉSENTE", () => {
    expect(choisirEntite(entites, "a", "b")).toBe("a");
    expect(choisirEntite(entites, ENTITE_SANS, "b")).toBe(ENTITE_SANS);
  });

  it("une valeur forgée ou périmée ne désigne rien : retombée sur la préférence, puis sur l'entité qui attend le plus", () => {
    expect(choisirEntite(entites, "societe-d-un-autre", "a")).toBe("a");
    expect(choisirEntite(entites, "societe-d-un-autre", "autre-aussi")).toBe("b");
    expect(choisirEntite(entites, null, null)).toBe("b");
    expect(choisirEntite([{ cle: "x", enAttente: 0 }, { cle: "y", enAttente: 0 }], null, null), "à égalité, la première").toBe("x");
    expect(choisirEntite([], "a", "b")).toBeNull();
  });

  it("la section : la demandée, sinon la première qui attend, sinon la première qui porte quelque chose, sinon Regulatory", () => {
    const c = (r: [number, number], s: [number, number], a: [number, number]) => ({
      REGULATORY: { enAttente: r[0], total: r[1] }, SALES_MARKETING: { enAttente: s[0], total: s[1] }, AUTRES: { enAttente: a[0], total: a[1] },
    });
    expect(choisirSection("autres", c([2, 2], [0, 0], [0, 1]))).toBe("AUTRES");
    expect(choisirSection(null, c([0, 3], [2, 2], [1, 1]))).toBe("SALES_MARKETING");
    expect(choisirSection(undefined, c([0, 0], [0, 4], [0, 9]))).toBe("SALES_MARKETING");
    expect(choisirSection("bidon", c([0, 0], [0, 0], [0, 0]))).toBe("REGULATORY");
  });
});
