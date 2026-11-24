/**
 * LE DOSSIER DRIVE D'UN PRODUIT REGULATORY — l'arborescence modèle, et OÙ chaque dépôt s'y range.
 *
 * « Chaque dossier produit créé depuis Regulatory › Suivi de dossiers crée un dossier dans la
 * catégorie Drive “Regulatory”, nommé simplement molécule + dosage, organisé EXACTEMENT comme le
 * dossier vierge. Le CTD initial va dans le CTD initial, les réserves dans les réserves : tout ce
 * qu'on dépose dans Regulatory doit être visible ici. » (Direction, 06/10)
 *
 * ── CE QUI EST TENU ICI ─────────────────────────────────────────────────────────────────────
 *
 *   1. **L'arborescence est RECOPIÉE du modèle remis par la Direction**, noms compris — fautes,
 *      tirets et parenthèse manquante de « Depot 3 (Reponses aux reserves 2 » inclus. Ce sont les
 *      noms que l'équipe connaît : les « corriger » ferait deux arborescences dans le même Drive.
 *   2. **Un dépôt se range d'après ce qu'il EST** — l'étape qui le porte (processus ANPP ou frise
 *      des réserves), sa catégorie, le dossier d'origine d'un dépôt de dossier — jamais d'après
 *      l'écran d'où il vient. Ce qu'on ne sait pas ranger va à la racine du dossier produit :
 *      visible, plutôt que perdu dans un sous-dossier deviné.
 *   3. **L'arborescence d'un dépôt de dossier se garde** sous la destination (« Module 3/3.2.P »
 *      reste « Module 3/3.2.P ») ; le segment « Module n » d'une CTD rejoint le « Module n » du
 *      modèle au lieu d'en créer un second.
 *
 * Module PUR : ni base, ni import. Testé (`arborescence-dossier.test.ts`).
 */

/** Le fichier modèle déposé dans chaque « 2- Draft » des réponses aux réserves. */
export const MODELE_COURRIER_RESERVES = "Courrier de reponse aux reserves.docx";

const ENR = "2- Enregistrement";
const DEPOT0 = `${ENR}/Depot 0 -dossier recu (dirty file)`;
const DEPOT1 = `${ENR}/Depot 1 initial`;
const ANPP1 = `${DEPOT1}/ANPP`;
const DRAFT1 = `${DEPOT1}/Draft`;
const ADMIN1 = `${DRAFT1}/Documents administratifs`;
const PRESOUMISSION = "1- Pre-soumission";
const DE_PRIX = "3-DE et attestation de prix";

/**
 * L'ARBORESCENCE MODÈLE, dossier par dossier, dans l'ordre du modèle (relative au dossier produit).
 * Chaque chemin parent précède ses enfants : créée dans cet ordre, elle se descend sans détour.
 */
export const ARBORESCENCE_DOSSIER: readonly string[] = [
  PRESOUMISSION,
  `${PRESOUMISSION}/Draft`,
  `${PRESOUMISSION}/Soumission`,
  ENR,
  DEPOT0,
  `${DEPOT0}/Audit CTD-deficiencies`,
  `${DEPOT0}/Audit CTD-deficiencies/Query 1`,
  `${DEPOT0}/Audit CTD-deficiencies/Query 2`,
  `${DEPOT0}/Trackers`,
  DEPOT1,
  ANPP1,
  `${ANPP1}/Module 1`,
  `${ANPP1}/Module 2`,
  `${ANPP1}/Module 3`,
  `${ANPP1}/Module 4`,
  `${ANPP1}/Module 5`,
  DRAFT1,
  ADMIN1,
  `${ADMIN1}/Detenteur`,
  `${ADMIN1}/Exploitant`,
  `${ADMIN1}/Fabricant API-PF`,
  `${DRAFT1}/Draft courriers`,
  `${DRAFT1}/Formulaires et fiches`,
  `${DRAFT1}/RCP et maquettes`,
  `${DRAFT1}/RCP et maquettes/1- Pays d'origine`,
  `${DRAFT1}/RCP et maquettes/2- Algerie`,
  `${ENR}/${nomDepotReponses(1)}`,
  ...blocReponses(1, "SCIENTIFIQUE", 3),
  ...blocReponses(1, "TECHNICO", 1),
  `${ENR}/${nomDepotReponses(1)}/Reponses prix`,
  `${ENR}/${nomDepotReponses(1)}/Reponses prix/Demande de baisse de prix`,
  `${ENR}/${nomDepotReponses(1)}/Reponses prix/Reponse`,
  `${ENR}/${nomDepotReponses(2)}`,
  ...blocReponses(2, "SCIENTIFIQUE", 3),
  DE_PRIX,
];

/** Les fichiers modèles de l'arborescence : chemin du dossier → nom du fichier. */
export const FICHIERS_MODELES: readonly { dossier: string; nom: string }[] = [
  { dossier: `${ENR}/${nomDepotReponses(1)}/${nomNature("SCIENTIFIQUE")}/2- Draft`, nom: MODELE_COURRIER_RESERVES },
  { dossier: `${ENR}/${nomDepotReponses(1)}/${nomNature("TECHNICO")}/2- Draft`, nom: MODELE_COURRIER_RESERVES },
  { dossier: `${ENR}/${nomDepotReponses(2)}/${nomNature("SCIENTIFIQUE")}/2- Draft`, nom: MODELE_COURRIER_RESERVES },
];

// ─── Les réserves ────────────────────────────────────────────────────────────────────────────
// Des DÉCLARATIONS de fonction (hissées) : les constantes du haut les appellent à l'initialisation.

export type NatureReserves = "SCIENTIFIQUE" | "TECHNICO" | "PRIX";

/** Le dossier d'une nature de réserves, au nom exact du modèle. */
function nomNature(nature: Exclude<NatureReserves, "PRIX">): string {
  return nature === "TECHNICO" ? "Reponses aux reserves technico-reglementaires" : "Reponses aux reserves scientifiques";
}

/**
 * Le dossier du cycle de réserves `cycle` (1 = premières réserves → « Depot 2 »). Les deux premiers
 * portent EXACTEMENT les noms du modèle ; au-delà, le motif du premier est prolongé.
 */
export function nomDepotReponses(cycle: number): string {
  const k = Math.max(1, Math.floor(cycle));
  if (k === 1) return "Depot 2 (reponses aux reserves 1)";
  if (k === 2) return "Depot 3 (Reponses aux reserves 2"; // sic — le modèle n'a pas de parenthèse fermante
  return `Depot ${k + 1} (reponses aux reserves ${k})`;
}

/** Les sous-dossiers du traitement des réserves — le modèle les écrit sans espace côté technico. */
function sousDossiersTraitement(nature: Exclude<NatureReserves, "PRIX">): { recues: string; retour: string } {
  return nature === "TECHNICO"
    ? { recues: "1-Reserves recues ANPP", retour: "2-Retour Detenteur-Fabricant" }
    : { recues: "1- Reserves recues ANPP", retour: "2- Retour Detenteur-Fabricant" };
}

/** Le bloc « Reponses aux reserves … » d'un cycle, tel que le modèle le dessine. */
function blocReponses(cycle: number, nature: Exclude<NatureReserves, "PRIX">, nbQueries: number): string[] {
  const base = `${ENR}/${nomDepotReponses(cycle)}/${nomNature(nature)}`;
  const t = `${base}/1- Traitement des reserves`;
  const s = sousDossiersTraitement(nature);
  const queries = Array.from({ length: nbQueries }, (_, i) => `${t}/${s.retour}/Query ${i + 1}`);
  const modules = nature === "TECHNICO" ? ["Module 1"] : ["Module 3", "Module 5"];
  return [
    base,
    t,
    `${t}/${s.recues}`,
    `${t}/${s.retour}`,
    ...queries,
    ...(nature === "SCIENTIFIQUE" ? [`${t}/${s.retour}/Tracker`] : []),
    `${t}/Tracker`,
    `${base}/2- Draft`,
    `${base}/3- Depot ANPP`,
    ...modules.map((m) => `${base}/3- Depot ANPP/${m}`),
  ];
}

/**
 * LA NATURE d'une réserve, lue dans ce qu'on en sait (libellé de l'étape, dossier, nom, catégorie).
 * Le prix et le technico-réglementaire se DISENT ; tout le reste est l'évaluation scientifique —
 * c'est le cas courant, et celui que le modèle détaille le plus.
 */
export function natureDesReserves(...indices: (string | null | undefined)[]): NatureReserves {
  const t = sansAccents(indices.filter(Boolean).join(" ")).toLowerCase();
  if (/\bprix\b|baisse de prix|\bprice\b/.test(t)) return "PRIX";
  if (/technico|reglementaire|administrati|module[\s_-]*1(?![0-9])|\bm1\b/.test(t)) return "TECHNICO";
  return "SCIENTIFIQUE";
}

// ─── Le nom du dossier produit ───────────────────────────────────────────────────────────────

function sansAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Un segment de chemin acceptable : sans séparateur, sans caractère de contrôle, borné. */
export function segmentSur(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120).trim();
}

/** « ACIDE ACÉTYLSALICYLIQUE + VITAMINE B12 » → « Acide acétylsalicylique + Vitamine B12 ». */
function moleculeLisible(dci: string): string {
  return dci
    .split("+")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => m
      .split(/\s+/)
      // Un mot qui porte un chiffre (« B12 », « D3 ») garde sa casse : en minuscules il ne se lit plus.
      .map((w, i) => (/\d/.test(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
      .join(" "))
    .join(" + ");
}

/**
 * LE NOM DU DOSSIER PRODUIT : la molécule, puis le dosage — « Etanercept 50 mg ». Rien d'autre :
 * c'est le nom que l'équipe cherche. L'unité n'est pas répétée quand le dosage la porte déjà.
 */
export function nomDossierDrive(molecule: string | null | undefined, dosage?: string | null, unite?: string | null): string {
  const mol = moleculeLisible((molecule ?? "").trim());
  const d = (dosage ?? "").trim();
  const u = (unite ?? "").trim();
  const dose = d && u && !sansAccents(d).toLowerCase().replace(/\s+/g, "").endsWith(sansAccents(u).toLowerCase().replace(/\s+/g, ""))
    ? `${d} ${u}`
    : d;
  return segmentSur([mol, dose].filter(Boolean).join(" ")) || "Produit sans nom";
}

// ─── Où se range un dépôt ────────────────────────────────────────────────────────────────────

/** L'étape de la frise (réserves & réponses) qui porte la pièce, quand `stepKey` en désigne une. */
export interface EtapeFriseRangement {
  kind: string; // CTD_INITIAL | ANPP_RESERVES | ANPP_RESPONSE | CTD_VERSION | DECISION | OTHER
  label: string;
  /** Le cycle de réserves auquel l'étape appartient (1 = premières réserves). */
  cycle: number;
}

export interface DepotARanger {
  stepKey: string | null;
  category: string;
  /** Dossier d'origine d'un dépôt de dossier (« CTD/Module 3/3.2.P »). */
  folder?: string | null;
  name?: string | null;
  frise?: EtapeFriseRangement | null;
  /** Nombre de cycles de réserves ouverts sur le dossier — pour une pièce de réserves sans étape. */
  cycles?: number;
}

/** Segments nettoyés d'un chemin. */
function segments(chemin: string | null | undefined): string[] {
  return (chemin ?? "").replace(/\\/g, "/").split("/").map((s) => segmentSur(s)).filter((s) => s && s !== "." && s !== "..");
}

const RE_MODULE = /^(?:module|mod|m)[\s_.-]*([1-5])(?![0-9])/i;

/**
 * LE MODULE CTD d'une pièce : sa catégorie (« Module 3 »), sinon le premier dossier d'origine nommé
 * « Module n » / « m3 ». Rend aussi ce qui suit ce dossier : « CTD/Module 3/3.2.P » → (3, « 3.2.P »).
 */
export function moduleDuDepot(category: string, folder: string | null | undefined): { module: number | null; suite: string[] } {
  const segs = segments(folder);
  const i = segs.findIndex((s) => RE_MODULE.test(s));
  if (i >= 0) return { module: Number(RE_MODULE.exec(segs[i])![1]), suite: segs.slice(i + 1) };
  const cat = /^MODULE_([1-5])$/.exec(category);
  return { module: cat ? Number(cat[1]) : null, suite: segs };
}

/** Le chemin d'une pièce de la CTD déposée à l'ANPP (dépôt initial), module retrouvé. */
function versAnpp(base: string, d: DepotARanger, moduleParDefaut: number | null = null): string[] {
  const { module, suite } = moduleDuDepot(d.category, d.folder);
  const m = module ?? moduleParDefaut;
  return [...segments(base), ...(m ? [`Module ${m}`] : []), ...suite];
}

/** Les pièces des réserves : reçues (« 1- Reserves recues ANPP ») ou déposées en réponse (« 3- Depot ANPP »). */
function versReserves(d: DepotARanger, cycle: number, sens: "RECUES" | "REPONSE", libelle?: string | null): string[] {
  const nature = natureDesReserves(libelle, d.folder, d.name, d.category === "MODULE_1" ? "module 1" : null);
  const depot = `${ENR}/${nomDepotReponses(cycle)}`;
  if (nature === "PRIX") {
    return [...segments(`${depot}/Reponses prix/${sens === "RECUES" ? "Demande de baisse de prix" : "Reponse"}`), ...segments(d.folder)];
  }
  const base = `${depot}/${nomNature(nature)}`;
  if (sens === "RECUES") {
    return [...segments(`${base}/1- Traitement des reserves/${sousDossiersTraitement(nature).recues}`), ...segments(d.folder)];
  }
  // Une réponse technico-réglementaire porte sur le Module 1 : c'est le seul module du modèle à cet endroit.
  return versAnpp(`${base}/3- Depot ANPP`, d, nature === "TECHNICO" ? 1 : null);
}

/** Les étapes du processus officiel → leur dossier (hors CTD, réserves et dépôt, traités à part). */
const ETAPES_FIXES: Record<string, string> = {
  presub_checklist: `${PRESOUMISSION}/Draft`,
  sample: `${PRESOUMISSION}/Draft`,
  bv25_req: `${PRESOUMISSION}/Soumission`,
  bv25_pay: `${PRESOUMISSION}/Soumission`,
  presub_req: `${PRESOUMISSION}/Soumission`,
  presub_ans: `${PRESOUMISSION}/Soumission`,
  modules345: `${DEPOT0}/Audit CTD-deficiencies`,
  docs_check: `${DEPOT0}/Trackers`,
  bv75_req: `${DRAFT1}/Formulaires et fiches`,
  bv75_pay: `${DRAFT1}/Formulaires et fiches`,
  module1: ADMIN1,
  rdv: `${DRAFT1}/Draft courriers`,
  recevabilite: ANPP1,
  commission: DE_PRIX,
  decision: DE_PRIX,
};

/** Les catégories qui disent d'elles-mêmes où elles vont (pièce sans étape, ou étape muette). */
function parCategorie(d: DepotARanger): string[] | null {
  const cycle = Math.max(1, d.cycles ?? 0);
  switch (d.category) {
    case "CTD_FULL":
    case "MODULE_1": case "MODULE_2": case "MODULE_3": case "MODULE_4": case "MODULE_5":
      return versAnpp(ANPP1, d);
    case "SUBMISSION_LETTER": return versAnpp(ANPP1, d, 1);
    case "GMP_CERTIFICATE": return [...segments(`${ADMIN1}/Fabricant API-PF`), ...segments(d.folder)];
    case "CPP":
    case "ORIGIN_AMM": return [...segments(`${ADMIN1}/Detenteur`), ...segments(d.folder)];
    case "BV_RECEIPT": return [...segments(`${DRAFT1}/Formulaires et fiches`), ...segments(d.folder)];
    case "REGISTRATION_DECISION":
    case "PRICE_ATTESTATION": return [...segments(DE_PRIX), ...segments(d.folder)];
    case "QUERY_RECEIVED": return versReserves(d, cycle, "RECUES");
    case "QUERY_RESPONSE": return versReserves(d, cycle, "REPONSE");
    default: return null;
  }
}

/**
 * OÙ VA CE DÉPÔT, dans le dossier produit — un chemin RELATIF (segments), sous-dossiers d'origine
 * compris. Tableau vide = la racine du dossier produit (ce qu'on ne sait pas ranger).
 */
export function cheminDrivePourDepot(d: DepotARanger): string[] {
  // 1. Une étape de la FRISE des réserves : son type et son cycle disent tout.
  if (d.frise) {
    const f = d.frise;
    const cycle = Math.max(1, f.cycle);
    if (d.category === "QUERY_RECEIVED") return versReserves(d, cycle, "RECUES", f.label);
    if (d.category === "QUERY_RESPONSE") return versReserves(d, cycle, "REPONSE", f.label);
    switch (f.kind) {
      case "ANPP_RESERVES": return versReserves(d, cycle, "RECUES", f.label);
      case "ANPP_RESPONSE":
      case "CTD_VERSION": return versReserves(d, cycle, "REPONSE", f.label);
      case "DECISION": return [...segments(DE_PRIX), ...segments(d.folder)];
      case "CTD_INITIAL": return versAnpp(ANPP1, d);
      default:
        if (natureDesReserves(f.label) === "PRIX") return versReserves(d, cycle, "REPONSE", f.label);
        return [...segments(f.cycle >= 1 ? `${ENR}/${nomDepotReponses(cycle)}` : ENR), ...segments(d.folder)];
    }
  }

  // 2. Une étape du PROCESSUS OFFICIEL.
  switch (d.stepKey) {
    case "ctd":
      // La CTD initiale et ses modules → le dépôt initial à l'ANPP ; les autres pièces de l'étape
      // (« Réception du CTD complet ») → le dossier reçu.
      if (d.category === "CTD_FULL" || /^MODULE_[1-5]$/.test(d.category)) return versAnpp(ANPP1, d);
      return [...segments(DEPOT0), ...segments(d.folder)];
    case "depot":
      return parCategorie(d) ?? versAnpp(ANPP1, d);
    case "evaluation":
      return versReserves(d, 1, d.category === "QUERY_RESPONSE" ? "REPONSE" : "RECUES");
    case "reponses_depot":
      return versReserves(d, Math.max(1, d.cycles ?? 0), "REPONSE");
    case "module1": {
      const cat = parCategorie(d);
      if (cat && ["GMP_CERTIFICATE", "CPP", "ORIGIN_AMM"].includes(d.category)) return cat;
      return [...segments(ADMIN1), ...segments(d.folder)];
    }
    default:
      if (d.stepKey && ETAPES_FIXES[d.stepKey]) return [...segments(ETAPES_FIXES[d.stepKey]), ...segments(d.folder)];
  }

  // 3. Sans étape (ou étape inconnue) : la catégorie, sinon la racine du dossier produit.
  return parCategorie(d) ?? segments(d.folder);
}

/**
 * LE CYCLE DE RÉSERVES de chaque étape de la frise, dans son ordre : une étape « Réserves » ouvre le
 * cycle suivant ; une réponse, une version ou une décision appartient au dernier cycle ouvert.
 */
export function cyclesDeLaFrise(steps: readonly { id: string; kind: string; order: number }[]): { parEtape: Map<string, number>; total: number } {
  const parEtape = new Map<string, number>();
  let cycle = 0;
  for (const s of [...steps].sort((a, b) => a.order - b.order)) {
    if (s.kind === "ANPP_RESERVES") cycle += 1;
    parEtape.set(s.id, cycle);
  }
  return { parEtape, total: cycle };
}
