/**
 * TAXONOMIE CTD (ICH M1–M5) avec les spécificités **Module 1 Algérie / ANPP**.
 * Sert à la classification déterministe (Phase 3) et à la complétude (Phase 4).
 * Chaque section porte : code, module, titre, alias de code (variantes de chemin/nom),
 * et mots-clés (fr/en) pour l'appariement par contenu. Données statiques, pures.
 */

export type CtdModule = "M1" | "M2" | "M3" | "M4" | "M5";

export interface CtdSection {
  code: string; // ex. "3.2.P.8"
  module: CtdModule;
  title: string;
  aliases: string[]; // variantes de code trouvées dans un chemin/nom de fichier
  keywords: string[]; // fr/en, sur nom + contenu extrait
  algeria?: boolean; // spécifique ANPP / Module 1 Algérie
}

export const CTD_SECTIONS: CtdSection[] = [
  // ── Module 1 (Algérie / ANPP) ──
  { code: "1.0", module: "M1", title: "Lettre d'accompagnement", aliases: ["1.0"], keywords: ["lettre d'accompagnement", "cover letter", "courrier de soumission", "lettre de demande"], algeria: true },
  { code: "1.2", module: "M1", title: "Formulaire de demande", aliases: ["1.2"], keywords: ["formulaire de demande", "application form", "demande d'enregistrement", "formulaire de pré-soumission", "presoumission", "pré-soumission"], algeria: true },
  { code: "1.2.1", module: "M1", title: "Bordereau de versement (droits)", aliases: ["1.2.1"], keywords: ["bordereau de versement", "e-tasdjil", "droits d'enregistrement", "quittance", "reçu de paiement", "preuve de paiement"], algeria: true },
  { code: "1.3", module: "M1", title: "Informations sur le produit (RCP/Notice/Étiquetage)", aliases: ["1.3", "1.3.1", "1.3.2"], keywords: ["rcp", "résumé des caractéristiques", "smpc", "summary of product characteristics", "notice", "leaflet", "étiquetage", "labelling", "conditionnement", "mock-up", "maquette"], algeria: true },
  { code: "1.4", module: "M1", title: "Certificat de produit pharmaceutique (CPP) / vente libre", aliases: ["1.4"], keywords: ["cpp", "certificat de produit pharmaceutique", "certificate of pharmaceutical product", "vente libre", "free sale", "certificate of free sale"], algeria: true },
  { code: "1.5", module: "M1", title: "Certificat BPF / GMP", aliases: ["1.5"], keywords: ["bpf", "gmp", "bonnes pratiques de fabrication", "good manufacturing practice", "certificat bpf", "gmp certificate"], algeria: true },
  { code: "1.6", module: "M1", title: "Autorisation de fabrication / d'établissement", aliases: ["1.6"], keywords: ["autorisation de fabrication", "manufacturing authorization", "autorisation d'exploitation", "établissement pharmaceutique", "manufacturing licence"], algeria: true },
  { code: "1.7", module: "M1", title: "Dossier de prix", aliases: ["1.7"], keywords: ["prix", "price", "structure de prix", "tarification", "pricing"], algeria: true },

  // ── Module 2 (Résumés) ──
  { code: "2.1", module: "M2", title: "Table des matières générale", aliases: ["2.1"], keywords: ["table des matières", "table of contents", "toc"] },
  { code: "2.2", module: "M2", title: "Introduction", aliases: ["2.2"], keywords: ["introduction générale", "introduction ctd"] },
  { code: "2.3", module: "M2", title: "Résumé global de la qualité (QOS)", aliases: ["2.3", "qos"], keywords: ["quality overall summary", "résumé global de la qualité", "qos"] },
  { code: "2.4", module: "M2", title: "Aperçu non clinique", aliases: ["2.4"], keywords: ["nonclinical overview", "aperçu non clinique", "non-clinical overview"] },
  { code: "2.5", module: "M2", title: "Aperçu clinique", aliases: ["2.5"], keywords: ["clinical overview", "aperçu clinique"] },
  { code: "2.6", module: "M2", title: "Résumés non cliniques", aliases: ["2.6"], keywords: ["nonclinical summary", "résumé non clinique", "nonclinical written summary"] },
  { code: "2.7", module: "M2", title: "Résumés cliniques", aliases: ["2.7"], keywords: ["clinical summary", "résumé clinique"] },

  // ── Module 3 (Qualité) ──
  { code: "3.2.S", module: "M3", title: "Substance active", aliases: ["3.2.s", "s.1", "s.2", "s.3"], keywords: ["drug substance", "substance active", "principe actif", "active substance", "dmf", "drug master file"] },
  { code: "3.2.S.4", module: "M3", title: "Contrôle de la substance active", aliases: ["3.2.s.4", "s.4"], keywords: ["contrôle de la substance", "control of drug substance", "spécifications substance"] },
  { code: "3.2.P", module: "M3", title: "Produit fini", aliases: ["3.2.p", "p.1", "p.2"], keywords: ["drug product", "produit fini", "finished product", "composition"] },
  { code: "3.2.P.3", module: "M3", title: "Fabrication du produit fini", aliases: ["3.2.p.3", "p.3"], keywords: ["manufacturing process", "procédé de fabrication", "process validation", "validation du procédé"] },
  { code: "3.2.P.5", module: "M3", title: "Contrôle du produit fini", aliases: ["3.2.p.5", "p.5"], keywords: ["contrôle du produit fini", "control of drug product", "finished product specification", "spécifications produit fini", "méthodes analytiques"] },
  { code: "3.2.P.8", module: "M3", title: "Stabilité", aliases: ["3.2.p.8", "p.8"], keywords: ["stability", "stabilité", "shelf life", "durée de conservation", "études de stabilité", "stability study", "zone iva", "zone ivb"] },
  { code: "3.2.A", module: "M3", title: "Annexes (installations, adventices, excipients)", aliases: ["3.2.a"], keywords: ["appendices", "annexes qualité", "adventitious agents", "facilities and equipment"] },
  { code: "3.2.R", module: "M3", title: "Informations régionales", aliases: ["3.2.r"], keywords: ["regional information", "informations régionales", "process validation scheme", "medical device"] },

  // ── Module 4 (Non clinique) ──
  { code: "4.2", module: "M4", title: "Rapports d'études non cliniques", aliases: ["4.2"], keywords: ["pharmacology", "toxicology", "pharmacologie", "toxicologie", "pharmacocinétique", "nonclinical study report", "étude non clinique"] },
  { code: "4.3", module: "M4", title: "Références bibliographiques (non clinique)", aliases: ["4.3"], keywords: ["références non cliniques", "literature references"] },

  // ── Module 5 (Clinique) ──
  { code: "5.2", module: "M5", title: "Tableau des études cliniques", aliases: ["5.2"], keywords: ["tabular listing", "liste des études cliniques"] },
  { code: "5.3", module: "M5", title: "Rapports d'études cliniques (CSR)", aliases: ["5.3", "5.3.1"], keywords: ["clinical study report", "csr", "étude clinique", "bioéquivalence", "bioequivalence", "bioavailability", "biodisponibilité", "essai clinique"] },
  { code: "5.4", module: "M5", title: "Références bibliographiques (clinique)", aliases: ["5.4"], keywords: ["références cliniques", "clinical literature references"] },
];

/** Recherche d'une section par code exact. */
export function sectionByCode(code: string): CtdSection | undefined {
  return CTD_SECTIONS.find((s) => s.code.toLowerCase() === code.toLowerCase());
}

/** Détecte un module CTD explicite ("m3", "module 3") dans un texte normalisé. */
export function detectModule(normalized: string): CtdModule | null {
  for (const m of [1, 2, 3, 4, 5]) {
    if (new RegExp(`(^|[^a-z0-9])(m${m}|module ${m})([^0-9]|$)`).test(normalized)) return `M${m}` as CtdModule;
  }
  return null;
}
