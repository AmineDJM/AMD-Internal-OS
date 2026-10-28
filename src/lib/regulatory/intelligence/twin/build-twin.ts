import type { RegProcedureType } from "@prisma/client";
import { requirementsFor, REGISTRATION_ADMIN_DOCS } from "../rules/requirements";
import { sectionByCode } from "../ctd/taxonomy";

/**
 * JUMEAU NUMÉRIQUE (vue) — Phase 4. Représentation structurée du dossier pour l'UI :
 *  - COUVERTURE CTD : pour la procédure, quelles sections requises/attendues sont présentes ;
 *  - REGROUPEMENT par module des documents réellement classés.
 * Déterministe, pur (ne touche pas la base).
 */

export interface CoverageRow {
  code: string;
  title: string;
  module: string;
  kind: "required" | "expected";
  present: boolean;
  docCount: number;
}

export interface TwinDocLite {
  id: string;
  originalFilename: string;
  ctdSection: string | null;
  ctdModule: string | null;
  containedSections?: string[]; // sections aussi présentes dans un PDF consolidé (Module X.pdf)
}

function coveredBy(code: string, docs: TwinDocLite[]): TwinDocLite[] {
  return docs.filter((d) =>
    [d.ctdSection, ...(d.containedSections ?? [])].some((s) => !!s && (s === code || s.startsWith(`${code}.`))),
  );
}

export function buildCoverage(procedureType: RegProcedureType, docs: TwinDocLite[]): CoverageRow[] {
  const req = requirementsFor(procedureType);
  const row = (code: string, kind: "required" | "expected"): CoverageRow => {
    const hits = coveredBy(code, docs);
    const sec = sectionByCode(code);
    return { code, title: sec?.title ?? code, module: sec?.module ?? "—", kind, present: hits.length > 0, docCount: hits.length };
  };
  return [...req.required.map((c) => row(c, "required")), ...req.expected.map((c) => row(c, "expected"))];
}

export interface RegistrationDocRow {
  code: string;
  label: string;
  present: boolean;
}

/**
 * Pièces administratives d'enregistrement (1.0 / 1.2 / 1.2.1) — fournies HORS dossier CTD, par nos
 * soins, en ligne sur le portail ANPP. Ce n'est PAS une exigence du dossier CTD : leur absence ne
 * pénalise jamais la complétude ; elles sont rappelées à part comme obligatoires à l'enregistrement.
 * Le « present » n'est qu'un indicateur si le fournisseur les a jointes malgré tout.
 */
export function buildRegistrationDocs(docs: TwinDocLite[]): RegistrationDocRow[] {
  return REGISTRATION_ADMIN_DOCS.map((d) => ({ code: d.code, label: d.label, present: coveredBy(d.code, docs).length > 0 }));
}

