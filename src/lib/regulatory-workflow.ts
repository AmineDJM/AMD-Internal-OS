/**
 * Processus officiel d'enregistrement d'un médicament auprès de l'ANPP (Direction
 * Technique). Décrit en CODE (et non en base) pour rester simple à maintenir : pour
 * faire évoluer le processus, on édite ces listes. Le suivi par produit est stocké dans
 * deux champs JSON de `RegulatoryProduct` (workflow + checklist).
 *
 * Source : « Workflow du processus d'enregistrement des médicaments auprès de l'ANPP »
 * + « Checklist – Presubmission phase ». Pur (importable serveur et client).
 */

export type RegStepState = "TODO" | "DOING" | "DONE" | "BLOCKED";

export const REG_STEP_STATE: Record<RegStepState, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  TODO: { label: "À faire", tone: "neutral" },
  DOING: { label: "En cours", tone: "info" },
  DONE: { label: "Fait", tone: "success" },
  BLOCKED: { label: "Bloqué", tone: "danger" },
};

export interface RegPhase { key: string; label: string }
export interface RegStep { key: string; phase: string; n: number; label: string; responsible: string; expected: string }

/** Les 5 grandes phases du processus. */
export const REG_PHASES: RegPhase[] = [
  { key: "PREP", label: "Préparation du dossier" },
  { key: "ADMIN", label: "Constitution administrative" },
  { key: "DEPOT", label: "Dépôt ANPP" },
  { key: "EVAL", label: "Évaluation ANPP" },
  { key: "FINAL", label: "Finalisation" },
];

/**
 * Les 19 étapes officielles (numéro, libellé, responsable, résultat attendu).
 *
 * LE CYCLE DES RÉSERVES N'EST PLUS UNE SUITE DE CASES. Les anciennes étapes 16-20 (réception
 * des réserves, analyse, transmission au laboratoire, réception des réponses, vérification)
 * décrivaient UN tour d'un cycle qui, dans la vraie vie, se répète — trois lettres de réserves
 * ne tiennent pas dans cinq cases cochées une fois. Ce vécu-là est porté par la FRISE du
 * dossier (« Réserves ANPP 1 », réponses, versions redéposées…), rendue entre l'évaluation et
 * le dépôt des réponses. Les clés retirées restent LISIBLES sur les dossiers qui les avaient
 * cochées (voir `process-status.ts`) — on ne réécrit pas l'histoire, on arrête de la compter.
 */
export const REG_STEPS: RegStep[] = [
  // Le CTD initial SE DÉPOSE ICI (fichier, .zip pour une arborescence entière) : la réception
  // n'est pas qu'une case, c'est la pièce elle-même, rattachée à l'étape.
  { key: "ctd", phase: "PREP", n: 1, label: "Réception du CTD complet", responsible: "Fournisseur / RA", expected: "Dossier complet déposé sur l'étape (fichiers ou .zip)" },
  // La check-list de présoumission est une ÉTAPE À PART : constituer le Module 1 algérien est
  // un travail, pas une note de bas de page de la réception.
  { key: "presub_checklist", phase: "PREP", n: 2, label: "Check-list de présoumission", responsible: "RA", expected: "Documents du Module 1 réunis (la liste se déplie sous l'étape)" },
  { key: "sample", phase: "PREP", n: 3, label: "Réception de l'échantillon", responsible: "Fournisseur", expected: "Échantillon conforme (avant le démarrage de la procédure)" },
  { key: "bv25_req", phase: "PREP", n: 4, label: "Demande du BV 25 %", responsible: "RA", expected: "BV avec toutes les informations correctes du produit" },
  { key: "bv25_pay", phase: "PREP", n: 5, label: "Paiement du BV 25 %", responsible: "Finance", expected: "Paiement effectué" },
  { key: "presub_req", phase: "PREP", n: 6, label: "Demande de présoumission", responsible: "RA", expected: "Demande avec toutes les informations correctes" },
  { key: "presub_ans", phase: "PREP", n: 7, label: "Réponse de la présoumission", responsible: "ANPP", expected: "Favorable → continuer · Défavorable → corriger puis redemander" },
  // ÉTUDE DES MODULES 3-4-5 AVANT D'ENGAGER LE BV 75 %. Le BV 75 % est la dépense la plus
  // lourde du dossier : l'engager avant d'avoir lu la qualité, le préclinique et le clinique,
  // c'est payer pour découvrir ensuite qu'il manque une étude. L'étape existe pour que cette
  // lecture soit un passage, pas une bonne intention.
  { key: "modules345", phase: "ADMIN", n: 8, label: "Étude des modules 3, 4 et 5", responsible: "RA", expected: "Qualité, préclinique et clinique lus et jugés déposables — AVANT d'engager le BV 75 %" },
  { key: "bv75_req", phase: "ADMIN", n: 9, label: "Demande du BV 75 %", responsible: "RA", expected: "BV avec toutes les informations correctes" },
  { key: "module1", phase: "ADMIN", n: 10, label: "Collecte des documents du Module 1 (électroniques + légalisés)", responsible: "RA / Fournisseur", expected: "Documents valides et conformes (sans attendre obligatoirement la présoumission)" },
  { key: "docs_check", phase: "ADMIN", n: 11, label: "Vérification des documents", responsible: "RA", expected: "Contrôle des dates d'expiration et de la conformité" },
  { key: "bv75_pay", phase: "ADMIN", n: 12, label: "Paiement du BV 75 %", responsible: "Finance", expected: "Après constitution du dossier" },
  { key: "rdv", phase: "DEPOT", n: 13, label: "Prise de rendez-vous ANPP", responsible: "RA", expected: "Chaque mercredi à 10 h selon le calendrier ANPP (production / importation en alternance)" },
  { key: "depot", phase: "DEPOT", n: 14, label: "Dépôt du dossier", responsible: "RA", expected: "Dépôt officiel (physique) auprès de l'ANPP" },
  { key: "recevabilite", phase: "DEPOT", n: 15, label: "Notification de recevabilité", responsible: "ANPP", expected: "Recevable · Différé avec réserves (Module 1) · Irrecevable" },
  { key: "evaluation", phase: "EVAL", n: 16, label: "Évaluation ANPP", responsible: "ANPP", expected: "Technico-réglementaire, prix, évaluation scientifique — les allers-retours de réserves vivent dans la frise, juste après" },
  { key: "reponses_depot", phase: "EVAL", n: 17, label: "Dépôt des réponses auprès de l'ANPP", responsible: "RA", expected: "Transmission à l'ANPP" },
  { key: "commission", phase: "FINAL", n: 18, label: "Passage en commission", responsible: "ANPP", expected: "Après validation des réponses" },
  { key: "decision", phase: "FINAL", n: 19, label: "Décision d'enregistrement + attestation de prix", responsible: "ANPP", expected: "Clôture du processus" },
];

/**
 * LES TROIS ENDROITS OÙ LE PROCESSUS N'EST PLUS UNE SIMPLE CASE À COCHER.
 *
 * Le processus officiel est une liste ; le travail réel ne l'est pas. Trois de ses étapes
 * portent en vérité un objet vivant, et l'écran les ouvre sur place plutôt que de renvoyer
 * ailleurs — sortir du dossier pour y revenir est exactement ce qui faisait qu'on ne le
 * tenait pas à jour.
 */

/** L'étape qui PORTE la check-list de présoumission : la liste se déplie sous elle.
 *  Son statut reste manuel — certains documents sont « si applicable », un 100 % mécanique
 *  déclarerait inachevée une check-list en réalité complète. */
export const PRESUB_CHECKLIST_AFTER_STEP = "presub_checklist";

/** Les étapes qui DEMANDENT un bon de versement : cliquer dessus ouvre la demande. */
export const BV_REQUEST_STEPS: Record<string, string> = {
  bv25_req: "BV 25 %",
  bv75_req: "BV 75 %",
};

/** Les étapes de paiement correspondantes — utiles pour dire « demandé, pas encore payé ». */
export const BV_PAYMENT_STEPS: Record<string, string> = {
  bv25_req: "bv25_pay",
  bv75_req: "bv75_pay",
};

/**
 * LES ALLERS-RETOURS AVEC L'ANPP — la frise du dossier, rendue APRÈS cette étape.
 *
 * L'ANPP envoie des réserves, on les analyse, on les transmet, le laboratoire répond, on
 * vérifie, on redépose… puis elle en renvoie d'autres. Ce cycle vécu est porté par la FRISE
 * (« Réserves ANPP 1 », réponses, versions redéposées — avec leurs pièces), pas par des cases :
 * les anciennes étapes-jalons 16-20 ont été retirées du processus. L'étape officielle qui SUIT
 * les allers-retours est « Dépôt des réponses auprès de l'ANPP ».
 */
export const ANPP_EXCHANGE_AFTER_STEP = "evaluation";

export interface RegChecklistItem { key: string; label: string; hint?: string }
export interface RegChecklistGroup { key: string; label: string; items: RegChecklistItem[] }

/** Checklist des documents de présoumission (constitution du Module 1 algérien). */
export const REG_CHECKLIST: RegChecklistGroup[] = [
  {
    key: "LEGALIZED", label: "Documents légalisés",
    items: [
      { key: "gmp_fp", label: "Certificat GMP valide du fabricant du produit fini (PF)" },
      { key: "ml_fp", label: "Licence de fabrication valide du fabricant du PF" },
      { key: "gmp_api", label: "Certificat GMP valide du fabricant de la substance active (API)" },
      { key: "ml_api", label: "Licence de fabrication valide du fabricant de l'API" },
      { key: "cpp", label: "Certificat de produit pharmaceutique (CPP) — destiné à l'Algérie (ou l'incluant)" },
      { key: "sample", label: "Échantillon du produit (identique au produit commercialisé au pays d'origine)" },
      { key: "ma", label: "Autorisation de mise sur le marché (AMM) du produit" },
      { key: "fob", label: "Certificat de prix FOB attesté par la chambre de commerce", hint: "Document électronique fourni par Pharmagene" },
    ],
  },
  {
    key: "ELECTRONIC", label: "Documents électroniques",
    items: [
      { key: "batch_corr", label: "Certificat de corrélation de lot (lot de l'échantillon)" },
      { key: "batch_release", label: "Certificat de libération de lot (libération au pays d'origine)" },
      { key: "coa_api", label: "CoA de l'API (fabricant et recontrôle)" },
      { key: "coa_fp", label: "CoA du produit fini" },
      { key: "coa_exc", label: "CoA des excipients (fabricant et recontrôle)" },
      { key: "smpc", label: "SmPC approuvé" },
      { key: "leaflet", label: "Notice (leaflet)" },
      { key: "artworks", label: "Artworks (versions PDF et AI)" },
      { key: "decl_same", label: "Déclaration : produit identique à celui commercialisé au pays d'origine" },
      { key: "dmf_cep", label: "Lettre d'accès au DMF de l'API / Certificat de conformité (CEP) à la Pharmacopée européenne" },
      { key: "module2", label: "Module 2" },
      { key: "module3", label: "Module 3" },
      { key: "module4", label: "Module 4" },
      { key: "module5", label: "Module 5" },
      { key: "stability", label: "Lettre d'engagement à poursuivre les études de stabilité (si en cours)" },
      { key: "bioeq", label: "Justification d'exemption des études de bioéquivalence (si applicable)" },
    ],
  },
  {
    key: "PRESUBMISSION", label: "Documents de présoumission",
    items: [
      { key: "presub_module2", label: "Module 2" },
      { key: "form_te", label: "Formulaire thérapeutique et économique signé par le titulaire de l'AMM", hint: "Canevas fourni par Pharmagene — requis seulement si la molécule n'a jamais été enregistrée en Algérie" },
    ],
  },
];

// ───────────────────────── État stocké (JSON par produit) ─────────────────────────

/** Avis d'une réponse de présoumission (étape « presub_ans ») : favorable → le processus
 *  continue ; défavorable → à corriger et redemander ; en attente → réponse ANPP pendante. */
export type RegPresubOutcome = "FAVORABLE" | "DEFAVORABLE" | "EN_ATTENTE";

export interface RegStepEntry { status?: RegStepState; date?: string; note?: string; outcome?: RegPresubOutcome }
export type RegWorkflowState = Record<string, RegStepEntry>;
export interface RegChecklistEntry { checked?: boolean; note?: string }
export type RegChecklistState = Record<string, RegChecklistEntry>;

const VALID_STEP_KEYS = new Set(REG_STEPS.map((s) => s.key));
const VALID_ITEM_KEYS = new Set(REG_CHECKLIST.flatMap((g) => g.items.map((i) => i.key)));

export function isRegStepKey(k: string): boolean { return VALID_STEP_KEYS.has(k); }
export function isRegChecklistKey(k: string): boolean { return VALID_ITEM_KEYS.has(k); }
export function isRegStepState(s: string): s is RegStepState { return s === "TODO" || s === "DOING" || s === "DONE" || s === "BLOCKED"; }

export function regStepStatus(state: RegWorkflowState | null | undefined, key: string): RegStepState {
  return state?.[key]?.status ?? "TODO";
}

// ───────────────────────── Avis de présoumission (étape « presub_ans ») ─────────────────────────

/** Étape « Réponse de la présoumission » : elle porte un AVIS explicite. */
export const PRESUB_ANSWER_STEP = "presub_ans";

/** Avis de présoumission → libellé, ton et STATUT d'étape dérivé (favorable = le flux continue). */
export const REG_PRESUB_OUTCOME: Record<RegPresubOutcome, { label: string; tone: "success" | "danger" | "info"; status: RegStepState }> = {
  FAVORABLE: { label: "Avis favorable", tone: "success", status: "DONE" },
  DEFAVORABLE: { label: "Avis défavorable", tone: "danger", status: "BLOCKED" },
  EN_ATTENTE: { label: "En attente", tone: "info", status: "DOING" },
};
export const REG_PRESUB_OUTCOME_ORDER: RegPresubOutcome[] = ["FAVORABLE", "EN_ATTENTE", "DEFAVORABLE"];

export function isRegPresubOutcome(s: string): s is RegPresubOutcome {
  return s === "FAVORABLE" || s === "DEFAVORABLE" || s === "EN_ATTENTE";
}

/** Avis actuel de la réponse de présoumission (null si pas encore renseigné). */
export function presubOutcome(state: RegWorkflowState | null | undefined): RegPresubOutcome | null {
  return state?.[PRESUB_ANSWER_STEP]?.outcome ?? null;
}

export interface RegProgress { done: number; total: number; pct: number; current: RegStep | null }

/** Avancement global + étape « courante » (1re étape non terminée dans l'ordre officiel). */
/**
 * LA PRÉSOUMISSION EST UN VERROU, pas une formalité.
 *
 * Tant que l'ANPP n'a pas rendu un avis FAVORABLE, le dossier n'est pas engagé : il en est encore
 * à sa réception. Cocher les étapes suivantes en attendant donne une avance qui n'existe pas —
 * et sur un tableau de soixante-neuf dossiers, c'est ce chiffre-là qu'on regarde pour décider où
 * mettre les gens.
 *
 * On ne RÉÉCRIT rien : les étapes déjà cochées restent cochées (le travail a bien été fait). On
 * PLAFONNE l'avancement affiché à l'étape 1, « Réception du CTD complet » — le dossier reçu.
 */
export const PRESUB_GATE_STEP = "ctd";

/** L'avis de présoumission autorise-t-il le dossier à avancer au-delà de sa réception ? */
export function presubUnlocked(state: RegWorkflowState | null | undefined): boolean {
  return presubOutcome(state) === "FAVORABLE";
}

export function regProgress(state: RegWorkflowState | null | undefined): RegProgress {
  const total = REG_STEPS.length;
  let done = 0;
  let current: RegStep | null = null;
  for (const step of REG_STEPS) {
    const st = regStepStatus(state, step.key);
    if (st === "DONE") done += 1;
    else if (!current) current = step;
  }

  // INVARIANT LOGIQUE : un processus TERMINÉ (toutes les étapes faites) n'est « à » aucune
  // étape — jamais de « prochaine étape : 1. Réception du CTD » sur un dossier complet. Le
  // verrou de présoumission protège l'avancement AFFICHÉ d'un dossier en cours, pas la
  // cohérence d'un dossier fini.
  if (done === total) return { done, total, pct: 100, current: null };

  // VERROU DE PRÉSOUMISSION : sans avis favorable, le dossier EST ENCORE à sa réception, quoi
  // qu'on ait coché plus loin. On ne touche pas au décompte — le travail fait reste compté, ce
  // serait mentir dans l'autre sens — mais l'ÉTAPE OÙ SE TROUVE LE DOSSIER reste « Réception du
  // CTD complet » tant que l'ANPP n'a pas répondu favorablement.
  const gate = REG_STEPS.find((s) => s.key === PRESUB_GATE_STEP) ?? null;
  const at = presubUnlocked(state) ? current : (gate ?? current);

  return { done, total, pct: Math.round((done / total) * 100), current: at };
}

/** Avancement de la checklist (cochés / total). */
export function regChecklistProgress(state: RegChecklistState | null | undefined): { checked: number; total: number; pct: number } {
  const total = VALID_ITEM_KEYS.size;
  let checked = 0;
  for (const k of VALID_ITEM_KEYS) if (state?.[k]?.checked) checked += 1;
  return { checked, total, pct: total ? Math.round((checked / total) * 100) : 0 };
}

/**
 * JALON IMPLIQUÉ PAR UN STATUT du dossier — poser « Déposé » veut dire que tout ce qui précède
 * le dépôt est FAIT : plutôt que de laisser l'avancement à 0/22 (ou d'exiger 12 clics), le
 * changement de statut COMPTE automatiquement les étapes jusqu'à son jalon (incluses). Seuls les
 * statuts au jalon non ambigu sont mappés ; les étapes POSTÉRIEURES au jalon ne sont JAMAIS
 * touchées, et rien n'est jamais dé-coché.
 */
export const REG_STATUS_MILESTONE: Record<string, string> = {
  SUBMITTED: "depot", // Déposé → tout jusqu'au dépôt officiel est fait
  AWAITING_ANPP: "depot", // en attente ANPP → le dépôt est forcément fait
  RESPONDING_TO_QUERIES: "evaluation", // on répond aux réserves → l'évaluation les a produites
  DECISION_OBTAINED: "decision", // décision obtenue → tout le processus est fait
  CLOSED: "decision",
};

/**
 * Marque « Fait » toutes les étapes JUSQU'AU jalon (incluses) qui ne le sont pas déjà — sans
 * toucher aux étapes bloquées (le blocage est un signal humain) ni à celles d'après le jalon.
 * Pur : rend le nouvel état + le nombre d'étapes complétées (0 = rien à faire).
 */
export function completeStepsThrough(
  state: RegWorkflowState | null | undefined,
  milestoneKey: string,
  date?: string,
): { state: RegWorkflowState; changed: number } {
  const milestone = REG_STEPS.find((s) => s.key === milestoneKey);
  const base: RegWorkflowState = { ...(state ?? {}) };
  if (!milestone) return { state: base, changed: 0 };
  const day = date ?? new Date().toISOString().slice(0, 10);
  let changed = 0;
  for (const step of REG_STEPS) {
    if (step.n > milestone.n) break;
    const cur = base[step.key]?.status ?? "TODO";
    if (cur === "DONE" || cur === "BLOCKED") continue;
    base[step.key] = { ...base[step.key], status: "DONE", date: base[step.key]?.date ?? day };
    // COHÉRENCE DU VERROU : un jalon au-delà de la réponse de présoumission (déposé, décision
    // obtenue…) implique NÉCESSAIREMENT un avis favorable — on ne dépose pas sans lui. Sans
    // cet avis dérivé, le dossier restait « verrouillé à l'étape 1 » alors que ses 22 étapes
    // étaient faites (le bug « 22/22 mais prochaine étape : Réception du CTD »). Un avis
    // explicite déjà posé (favorable ou non) n'est JAMAIS réécrit.
    if (step.key === PRESUB_ANSWER_STEP && !base[step.key]?.outcome) {
      base[step.key] = { ...base[step.key], outcome: "FAVORABLE" };
    }
    changed++;
  }
  return { state: base, changed };
}

/**
 * LE CIRCUIT ANPP, VU COMME UNE SUITE D'ÉTAPES DATÉES — pour que le Chief of Staff lise ce que
 * l'écran affiche, et rien d'autre.
 *
 * LE BOGUE QUE CETTE FONCTION FERME. Le dossier Raltegravir montrait « Préparation 22/22 » à
 * l'écran, et le Chief répondait « Étape courante : Préparation dossier CTD (non démarrée) ».
 * Les deux disaient vrai — sur DEUX MAGASINS DIFFÉRENTS. L'écran écrit dans
 * `RegulatoryProduct.workflow` (le JSON coché par l'équipe) ; le Chief lisait la table
 * `RegulatoryStep`, un second registre que personne ne tient plus. Deux sources pour un même
 * fait, et la question « où en est ce dossier ? » recevait deux réponses contradictoires — celle
 * de l'écran, et celle qu'on répète en réunion.
 *
 * Il n'y a plus qu'une source : celle où le travail est réellement coché.
 */
export function workflowAsSteps(state: RegWorkflowState | null | undefined): {
  type: string;
  status: string;
  plannedDate: Date | null;
  actualDate: Date | null;
  missingDocs: string | null;
  responsible: string | null;
}[] {
  return REG_STEPS.map((s) => {
    const entry = state?.[s.key];
    const st = regStepStatus(state, s.key);
    const actual = entry?.date ? new Date(entry.date) : null;
    return {
      type: s.key,
      // Le vocabulaire de l'écran (`TODO`) et celui de l'état exécutif (`NOT_STARTED`) sont deux
      // dialectes du même fait : on traduit ici, une fois, plutôt que partout.
      status: st === "TODO" ? "NOT_STARTED" : st === "DOING" ? "IN_PROGRESS" : st,
      plannedDate: null,
      actualDate: actual && !Number.isNaN(actual.getTime()) ? actual : null,
      missingDocs: null,
      responsible: s.responsible,
    };
  });
}

/** Le circuit a-t-il seulement commencé à être tenu ? Un JSON vide = dossier jamais coché. */
export function hasWorkflowState(state: RegWorkflowState | null | undefined): boolean {
  return Boolean(state && Object.keys(state).length > 0);
}
