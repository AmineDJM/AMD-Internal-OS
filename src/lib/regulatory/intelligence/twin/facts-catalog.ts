/**
 * CATALOGUE des faits réglementaires du jumeau numérique. Clé stable + libellé + groupe.
 * `extractable` = un extracteur déterministe existe (sinon : renseigné par revue humaine /
 * agents IA plus tard). Pur, sans dépendance.
 */
export interface FactDef {
  key: string;
  label: string;
  group: "Identité" | "Qualité" | "Fabrication" | "Clinique" | "Administratif";
  extractable: boolean;
}

export const FACT_CATALOG: FactDef[] = [
  // Identité produit
  { key: "PRODUCT_NAME", label: "Nom du produit", group: "Identité", extractable: true },
  { key: "INN", label: "DCI (substance active)", group: "Identité", extractable: true },
  { key: "STRENGTH", label: "Dosage / teneur", group: "Identité", extractable: true },
  { key: "DOSAGE_FORM", label: "Forme pharmaceutique", group: "Identité", extractable: true },
  { key: "ROUTE", label: "Voie d'administration", group: "Identité", extractable: true },
  { key: "COMPOSITION", label: "Composition", group: "Identité", extractable: false },
  { key: "PRESENTATION", label: "Présentation(s)", group: "Identité", extractable: false },
  // Administratif
  { key: "APPLICANT", label: "Demandeur", group: "Administratif", extractable: true },
  { key: "MAH", label: "Titulaire (détenteur)", group: "Administratif", extractable: true },
  { key: "OPERATOR", label: "Exploitant", group: "Administratif", extractable: true },
  { key: "CPP", label: "Certificat produit pharmaceutique (CPP)", group: "Administratif", extractable: true },
  { key: "GMP", label: "Certificat BPF / GMP", group: "Administratif", extractable: true },
  { key: "AUTHORIZATION", label: "Autorisation (AMM/établissement)", group: "Administratif", extractable: false },
  // Fabrication
  { key: "MANUFACTURER", label: "Fabricant(s)", group: "Fabrication", extractable: true },
  { key: "SITE_ADDRESS", label: "Adresse(s) de site", group: "Fabrication", extractable: false },
  { key: "PROCESS", label: "Procédé de fabrication", group: "Fabrication", extractable: false },
  { key: "BATCH_SIZE", label: "Taille de lot", group: "Fabrication", extractable: true },
  { key: "BATCHES", label: "Lots (études)", group: "Fabrication", extractable: false },
  // Qualité
  { key: "SPECIFICATIONS", label: "Spécifications", group: "Qualité", extractable: false },
  { key: "METHODS", label: "Méthodes analytiques", group: "Qualité", extractable: false },
  { key: "VALIDATION", label: "Validation", group: "Qualité", extractable: false },
  { key: "IMPURITIES", label: "Impuretés", group: "Qualité", extractable: false },
  { key: "STABILITY", label: "Données de stabilité", group: "Qualité", extractable: false },
  { key: "SHELF_LIFE", label: "Durée de conservation", group: "Qualité", extractable: true },
  { key: "STORAGE", label: "Conditions de conservation", group: "Qualité", extractable: true },
  { key: "PACKAGING", label: "Conditionnement", group: "Qualité", extractable: true },
  // Clinique
  { key: "INDICATION", label: "Indications", group: "Clinique", extractable: false },
  { key: "POSOLOGY", label: "Posologie", group: "Clinique", extractable: false },
  { key: "REFERENCE_PRODUCT", label: "Produit de référence", group: "Clinique", extractable: true },
  { key: "STUDIES", label: "Études", group: "Clinique", extractable: false },
];

const BY_KEY = new Map(FACT_CATALOG.map((f) => [f.key, f]));
export const factLabel = (key: string) => BY_KEY.get(key)?.label ?? key;
