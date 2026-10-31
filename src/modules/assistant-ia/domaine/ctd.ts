/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEMENT CTD D'UN DOSSIER DÉPOSÉ (lot J11, décision 0030) — pur, zéro import.
 *
 * « Classe ces 300 fichiers par module CTD », « quelles pièces manquent » : l'assistant répond sur ce que la
 * Bibliothèque sait DÉJÀ de chaque pièce (chemin dans le dossier, titre, nature, premier passage lu) — sans relire
 * les fichiers un à un, sans un appel au modèle par fichier. Les règles :
 *
 *   1. un NUMÉRO DE SECTION dans le chemin ou le nom (« 3.2.P.5 », « 32p5 », « Module 3 », « m1 ») désigne la section ;
 *   2. sinon des MOTS (français et anglais, ceux des dossiers ANPP) pèsent — trois fois plus dans le chemin que dans le
 *      texte lu ; la substance active (S) et le produit fini (P) se départagent par leurs propres mots ;
 *   3. sous un seuil, la pièce reste « non classée » et l'est DITE (jamais rangée au hasard).
 *
 * Les PIÈCES ATTENDUES sont celles d'un dossier d'enregistrement d'un générique (ICH M4, exigences de l'ANPP) : une
 * section attendue sans aucune pièce est « manquante ». C'est une aide à la relecture, pas un avis réglementaire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SectionCtd {
  code: string;
  module: 1 | 2 | 3 | 4 | 5;
  libelle: string;
  /** Les mots qui la désignent (repliés : minuscules, sans accents). */
  mots: readonly string[];
  /** Attendue dans le dossier d'un générique. */
  attendue: boolean;
}

export const SECTIONS_CTD: readonly SectionCtd[] = [
  { code: "1.0", module: 1, libelle: "Lettre de demande", mots: ["lettre de demande", "cover letter", "lettre de couverture", "courrier de demande"], attendue: true },
  { code: "1.2", module: 1, libelle: "Formulaire de demande", mots: ["formulaire de demande", "application form", "formulaire anpp", "demande d'enregistrement", "demande d enregistrement"], attendue: true },
  { code: "1.3.1", module: 1, libelle: "RCP (résumé des caractéristiques du produit)", mots: ["rcp", "smpc", "spc", "resume des caracteristiques", "summary of product characteristics"], attendue: true },
  { code: "1.3.2", module: 1, libelle: "Notice", mots: ["notice", "pil", "patient information leaflet", "package leaflet", "leaflet"], attendue: true },
  { code: "1.3.3", module: 1, libelle: "Étiquetage et maquettes", mots: ["etiquetage", "labelling", "labeling", "maquette", "mock-up", "mockup", "artwork", "conditionnement exterieur", "etui"], attendue: true },
  { code: "1.4", module: 1, libelle: "Informations sur les experts", mots: ["expert", "cv expert", "information about the experts", "declaration expert"], attendue: false },
  { code: "1.5", module: 1, libelle: "Certificats (BPF/GMP, CPP, autorisation de fabrication)", mots: ["gmp", "bpf", "bonnes pratiques de fabrication", "cpp", "copp", "certificate of pharmaceutical product", "certificat de produit pharmaceutique", "autorisation de fabrication", "manufacturing authorisation", "manufacturing license", "licence de fabrication", "certificat"], attendue: true },
  { code: "1.6", module: 1, libelle: "Statut d'enregistrement dans les autres pays", mots: ["statut d'enregistrement", "registration status", "decision d'enregistrement", "marketing authorisation", "amm du pays", "liste des pays"], attendue: false },
  { code: "1.7", module: 1, libelle: "Procuration et lettres d'accès", mots: ["procuration", "power of attorney", "letter of access", "lettre d'acces", "mandat"], attendue: false },
  { code: "2.3", module: 2, libelle: "Résumé global de la qualité (QOS)", mots: ["qos", "quality overall summary", "resume global qualite", "resume global de la qualite"], attendue: true },
  { code: "2.4", module: 2, libelle: "Résumé non clinique (vue d'ensemble)", mots: ["nonclinical overview", "non-clinical overview", "apercu non clinique", "vue d'ensemble non clinique"], attendue: false },
  { code: "2.5", module: 2, libelle: "Résumé clinique (vue d'ensemble)", mots: ["clinical overview", "apercu clinique", "vue d'ensemble clinique"], attendue: true },
  { code: "2.6", module: 2, libelle: "Résumés écrits non cliniques", mots: ["nonclinical written summary", "nonclinical summary", "resume ecrit non clinique"], attendue: false },
  { code: "2.7", module: 2, libelle: "Résumés cliniques", mots: ["clinical summary", "resume clinique", "summary of clinical"], attendue: false },
  { code: "3.2.S.1", module: 3, libelle: "Substance active — informations générales", mots: ["nomenclature", "structure", "general information", "proprietes generales", "general properties", "informations generales"], attendue: true },
  { code: "3.2.S.2", module: 3, libelle: "Substance active — fabrication", mots: ["manufacturer", "fabricant", "synthese", "synthesis", "route of synthesis", "description of manufacturing process", "procede de fabrication"], attendue: true },
  { code: "3.2.S.3", module: 3, libelle: "Substance active — caractérisation", mots: ["characterisation", "characterization", "caracterisation", "elucidation", "impuretes", "impurities", "polymorph"], attendue: true },
  { code: "3.2.S.4", module: 3, libelle: "Substance active — contrôle", mots: ["specification", "specifications", "analytical procedure", "methode analytique", "validation analytique", "analytical validation", "batch analysis", "batch analyses", "analyse de lots", "certificat d'analyse", "certificate of analysis", "coa"], attendue: true },
  { code: "3.2.S.5", module: 3, libelle: "Substance active — étalons de référence", mots: ["reference standard", "etalon", "substance de reference", "working standard"], attendue: false },
  { code: "3.2.S.6", module: 3, libelle: "Substance active — conditionnement", mots: ["container closure", "conditionnement", "emballage", "packaging"], attendue: false },
  { code: "3.2.S.7", module: 3, libelle: "Substance active — stabilité", mots: ["stabilite", "stability", "retest", "recontrole"], attendue: true },
  { code: "3.2.P.1", module: 3, libelle: "Produit fini — description et composition", mots: ["composition", "description and composition", "formule unitaire", "unit formula", "description et composition"], attendue: true },
  { code: "3.2.P.2", module: 3, libelle: "Produit fini — développement pharmaceutique", mots: ["developpement pharmaceutique", "pharmaceutical development", "dissolution comparative", "comparative dissolution", "profil de dissolution", "dissolution profile", "qbd"], attendue: true },
  { code: "3.2.P.3", module: 3, libelle: "Produit fini — fabrication", mots: ["formule de fabrication", "batch formula", "manufacturing process", "procede de fabrication", "validation du procede", "process validation", "controle en cours", "in-process control", "dossier de lot", "batch record", "bmr"], attendue: true },
  { code: "3.2.P.4", module: 3, libelle: "Produit fini — contrôle des excipients", mots: ["excipient", "excipients", "control of excipients", "controle des excipients"], attendue: true },
  { code: "3.2.P.5", module: 3, libelle: "Produit fini — contrôle", mots: ["specification", "specifications", "analytical procedure", "methode analytique", "validation analytique", "analytical validation", "batch analysis", "batch analyses", "analyse de lots", "certificat d'analyse", "certificate of analysis", "coa", "dosage", "assay", "uniformite"], attendue: true },
  { code: "3.2.P.6", module: 3, libelle: "Produit fini — étalons de référence", mots: ["reference standard", "etalon", "substance de reference", "working standard"], attendue: false },
  { code: "3.2.P.7", module: 3, libelle: "Produit fini — conditionnement", mots: ["container closure", "conditionnement primaire", "blister", "flacon", "bottle", "emballage primaire", "packaging material", "article de conditionnement"], attendue: true },
  { code: "3.2.P.8", module: 3, libelle: "Produit fini — stabilité", mots: ["stabilite", "stability", "shelf life", "duree de vie", "etude de stabilite", "stability study", "zone iv", "zone ivb"], attendue: true },
  { code: "3.2.A", module: 3, libelle: "Annexes (installations, sécurité virale, excipients nouveaux)", mots: ["facilities and equipment", "adventitious agents", "novel excipient", "installations"], attendue: false },
  { code: "3.2.R", module: 3, libelle: "Informations régionales", mots: ["regional information", "informations regionales", "executed batch", "dossier de lot execute"], attendue: false },
  { code: "3.3", module: 3, libelle: "Références bibliographiques (qualité)", mots: ["pharmacopee", "pharmacopoeia", "monographie", "monograph", "usp", "ph. eur", "bp monograph"], attendue: false },
  { code: "4.2", module: 4, libelle: "Rapports d'études non cliniques", mots: ["toxicologie", "toxicology", "pharmacologie", "pharmacology", "genotox", "carcinogen", "nonclinical study", "etude non clinique", "toxicite"], attendue: false },
  { code: "4.3", module: 4, libelle: "Références bibliographiques (non clinique)", mots: ["nonclinical literature", "literature references nonclinical"], attendue: false },
  { code: "5.2", module: 5, libelle: "Liste des études cliniques", mots: ["tabular listing", "liste des etudes", "listing of clinical studies"], attendue: false },
  { code: "5.3.1", module: 5, libelle: "Bioéquivalence / biodisponibilité", mots: ["bioequivalence", "bioequivalence", "bioavailability", "biodisponibilite", "etude be", "be study", "pharmacocinetique", "pharmacokinetic", "cmax", "auc"], attendue: true },
  { code: "5.3.5", module: 5, libelle: "Rapports d'études cliniques (efficacité, sécurité)", mots: ["clinical study report", "rapport d'etude clinique", "csr", "essai clinique", "clinical trial", "efficacy", "efficacite"], attendue: false },
  { code: "5.4", module: 5, libelle: "Références bibliographiques (clinique)", mots: ["clinical literature", "references bibliographiques", "bibliographie", "literature references", "publication"], attendue: false },
];

const PAR_CODE = new Map(SECTIONS_CTD.map((s) => [s.code, s]));

/** Replié : minuscules, sans accents, séparateurs unifiés. */
export const replier = (t: string): string =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");

const MOTS_S = ["substance active", "drug substance", "principe actif", "matiere premiere", "api ", " api", "asmf", "dmf", "cep", "active substance", "3.2.s", "32s"];
const MOTS_P = ["produit fini", "finished product", "drug product", "comprime", "gelule", "sirop", "injectable", "formulation", "3.2.p", "32p", "medicament fini"];

/** Un numéro de section écrit dans un segment : « 3.2.P.5.1 », « 32p5 », « 3.2.S », « Module 3 », « m1 », « 1.3.1 ». */
function sectionEcrite(seg: string): { code: string; module: number } | null {
  const s = replier(seg);
  const p = /(?:^|[^0-9a-z])3[ .]?2[ .]?([sp])[ .]?([1-8])(?:[ .]?(\d))?/.exec(s);
  if (p) {
    const code = `3.2.${p[1]!.toUpperCase()}.${p[2]}`;
    return PAR_CODE.has(code) ? { code, module: 3 } : { code: `3.2.${p[1]!.toUpperCase()}`, module: 3 };
  }
  const ar = /(?:^|[^0-9a-z])3[ .]?2[ .]?([ar])(?:[^a-z]|$)/.exec(s);
  if (ar) return { code: `3.2.${ar[1]!.toUpperCase()}`, module: 3 };
  // Un dosage (« 2.5 mg ») ou une date ne sont pas des sections.
  const num = /(?:^|[^0-9.])([1-5])\.(\d)(?:\.(\d))?(?![0-9]|\s?(?:mg|ml|g|µg|mcg|ug|kg|l|%)(?![a-z]))/.exec(s);
  if (num) {
    const fin = `${num[1]}.${num[2]}${num[3] ? `.${num[3]}` : ""}`;
    const court = `${num[1]}.${num[2]}`;
    if (PAR_CODE.has(fin)) return { code: fin, module: Number(num[1]) };
    if (PAR_CODE.has(court)) return { code: court, module: Number(num[1]) };
    if (court === "5.3") return { code: "5.3.5", module: 5 };
    if (court === "1.3") return { code: "1.3.1", module: 1 };
  }
  const m = /(?:^|[^a-z0-9])(?:module|mod|m)[ .-]?([1-5])(?![0-9])/.exec(s);
  if (m) return { code: `M${m[1]}`, module: Number(m[1]) };
  return null;
}

export interface PieceAClasser {
  /** Chemin relatif dans le dossier déposé. */
  chemin: string;
  titre?: string | null;
  nature?: string | null;
  /** Le début du texte lu par la Bibliothèque — absent si la pièce n'est pas lue ou ne part pas au modèle. */
  extrait?: string | null;
}

export interface Classement {
  chemin: string;
  /** Le code de la section (« 3.2.P.5 »), « M3 » pour un module sans section, `null` : non classée. */
  section: string | null;
  module: number | null;
  /** « numero » (écrit dans le chemin), « mots », « aucun ». */
  par: "numero" | "mots" | "aucun";
}

const compte = (texte: string, mot: string): number => {
  let n = 0;
  let i = texte.indexOf(mot);
  while (i >= 0) { n++; i = texte.indexOf(mot, i + mot.length); }
  return n;
};

/** CLASSE une pièce : le numéro écrit d'abord (le plus profond du chemin gagne), puis les mots. */
export function classerPiece(p: PieceAClasser): Classement {
  const segs = p.chemin.split("/").filter(Boolean);
  let ecrite: { code: string; module: number } | null = null;
  // Le segment le plus PROFOND qui porte un numéro précis gagne (« Module 3/3.2.P/3.2.P.5/… » → 3.2.P.5).
  for (const seg of segs) {
    const e = sectionEcrite(seg);
    if (e && (!ecrite || e.code.length >= ecrite.code.length || ecrite.code.startsWith("M"))) ecrite = e;
  }
  if (ecrite && PAR_CODE.has(ecrite.code)) return { chemin: p.chemin, section: ecrite.code, module: ecrite.module, par: "numero" };

  const chemin = ` ${replier([...segs, p.titre ?? "", p.nature ?? ""].join(" "))} `;
  const texte = ` ${replier(p.extrait ?? "").slice(0, 2000)} `;
  const versS = MOTS_S.reduce((n, m) => n + compte(chemin, m) * 3 + compte(texte, m), 0);
  const versP = MOTS_P.reduce((n, m) => n + compte(chemin, m) * 3 + compte(texte, m), 0);
  let meilleur: SectionCtd | null = null;
  let score = 0;
  for (const s of SECTIONS_CTD) {
    // Un numéro écrit « Module 3 » ou « 3.2.P » borne la recherche à ce module / cette partie.
    if (ecrite && s.module !== ecrite.module) continue;
    if (ecrite && /^3\.2\.[SP]$/.test(ecrite.code) && !s.code.startsWith(ecrite.code)) continue;
    let n = 0;
    for (const m of s.mots) n += compte(chemin, m) * 3 + compte(texte, m);
    if (!n) continue;
    // La substance active et le produit fini partagent leurs mots (spécification, stabilité) : leurs indices tranchent.
    if (s.code.startsWith("3.2.S")) n += versS > versP ? 2 : versP > versS ? -2 : 0;
    if (s.code.startsWith("3.2.P")) n += versP >= versS ? 1 : -2;
    if (n > score) { score = n; meilleur = s; }
  }
  if (meilleur && score >= 3) return { chemin: p.chemin, section: meilleur.code, module: meilleur.module, par: "mots" };
  if (ecrite) return { chemin: p.chemin, section: ecrite.code.startsWith("M") ? ecrite.code : ecrite.code, module: ecrite.module, par: "numero" };
  return { chemin: p.chemin, section: null, module: null, par: "aucun" };
}

export interface BilanCtd {
  parModule: Record<string, number>;
  sections: { code: string; libelle: string; pieces: string[] }[];
  nonClassees: string[];
  manquantes: { code: string; libelle: string }[];
}

/** LE BILAN d'un dossier : les pièces par section (dans l'ordre du CTD), les non classées, les sections attendues vides. */
export function bilanCtd(pieces: readonly PieceAClasser[]): BilanCtd {
  const classes = pieces.map(classerPiece);
  const parModule: Record<string, number> = {};
  const parSection = new Map<string, string[]>();
  const nonClassees: string[] = [];
  for (const c of classes) {
    if (!c.section) { nonClassees.push(c.chemin); continue; }
    parModule[`Module ${c.module}`] = (parModule[`Module ${c.module}`] ?? 0) + 1;
    parSection.set(c.section, [...(parSection.get(c.section) ?? []), c.chemin]);
  }
  const ordre = (code: string) => { const i = SECTIONS_CTD.findIndex((s) => s.code === code); return i >= 0 ? i : 1000 + Number(code.replace(/\D/g, "") || 0); };
  const sections = [...parSection.entries()].sort((a, b) => ordre(a[0]) - ordre(b[0]))
    .map(([code, p]) => ({ code, libelle: PAR_CODE.get(code)?.libelle ?? (code.startsWith("M") ? `Module ${code.slice(1)} (section non précisée)` : code), pieces: p }));
  const presentes = new Set(parSection.keys());
  const manquantes = SECTIONS_CTD.filter((s) => s.attendue && !presentes.has(s.code)).map((s) => ({ code: s.code, libelle: s.libelle }));
  return { parModule, sections, nonClassees, manquantes };
}
