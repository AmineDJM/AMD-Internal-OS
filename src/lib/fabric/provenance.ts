/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PROVENANCE AU NIVEAU DU FAIT — « d'où tu tiens ça ? » a toujours une réponse (F8).
 *
 * ── CE QUE C'EST ─────────────────────────────────────────────────────────────────────────
 *
 * Chaque fait qu'Adam SERT dans un tour — une fiche lue, une page d'un PDF, un message, un
 * total calculé — laisse une trace typée : sa source (ERP, document, e-mail, page, cellule,
 * pièce, réunion, personne, externe, calcul), son horodatage PROPRE (la date de la donnée,
 * pas celle de la lecture), l'instant de lecture, la confiance et son fondement (donnée
 * structurée, texte extrait par le code, OCR, modèle), la FRAÎCHEUR de la source (table
 * vivante ou index daté), qui fait autorité, si une absence y est démontrable, et sous quels
 * droits elle a été lue. Une donnée CALCULÉE porte ses entrées, la transformation, la formule
 * et la date du calcul — un total n'est pas un fait de plus, c'est un fait DÉRIVÉ.
 *
 * ── LES TROIS DÉCISIONS ──────────────────────────────────────────────────────────────────
 *
 * 1. LE REGISTRE DES SOURCES EST LA SEULE CARTE. La famille, l'autorité, la preuve négative et
 *    la nature de fraîcheur viennent de `registry.ts` par la capacité qui a lu (§17 : pas de
 *    second registre). Un outil absent du registre donne un fait de famille inconnue — dit
 *    comme tel, jamais maquillé.
 * 2. L'EXTRACTION EST DÉTERMINISTE ET BORNÉE. Elle relit la sortie JSON des outils — la même
 *    matière que le panneau « Sources » — sans appel de modèle. Un lien externe glissé dans un
 *    résultat ne devient JAMAIS un lien cliquable (même règle que `extractSources`) : il reste
 *    une adresse citée, marquée EXTERNE.
 * 3. UN OUTIL PEUT DÉCLARER SES FAITS (`_provenance`), comme il déclare ses blocs (`_blocs`) :
 *    c'est ainsi qu'un agrégat expose ses entrées et sa formule. Chaque entrée déclarée est
 *    REVALIDÉE champ par champ — un outil ne peut pas faire dire au registre ce qu'il n'a pas.
 *
 * Fichier sans Prisma : la persistance et la relecture vivent dans `provenance-store.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { SOURCES, type DescripteurSource } from "@/lib/fabric/registry";

export type NatureSource =
  | "ERP" | "DOCUMENT" | "EMAIL" | "FIL" | "PAGE_PDF" | "CELLULE" | "PIECE"
  | "REUNION" | "PERSONNE" | "DATE" | "EXTERNE" | "CALCUL";
export const NATURES_SOURCE: readonly NatureSource[] = [
  "ERP", "DOCUMENT", "EMAIL", "FIL", "PAGE_PDF", "CELLULE", "PIECE", "REUNION", "PERSONNE", "DATE", "EXTERNE", "CALCUL",
] as const;

/** Sur quoi repose la confiance : `metadata` = structuré dans l'ERP ; `declare` = posé par un outil qui l'a mesuré. */
/**
 * `calcul` et `estimation` se distinguent, et c'est la distinction qui compte le plus ici :
 * un CALCUL rend ce que les données CONTIENNENT (une somme de douze écritures réglées), une
 * ESTIMATION rend ce qu'elles SUGGÈRENT sous des hypothèses déclarées (un P90 tiré de lois
 * choisies, une prévision extrapolée). Les deux sortent d'un moteur déterministe et sont
 * rejouables ; une seule décrit quelque chose qui a eu lieu.
 */
export type BaseConfiance = "metadata" | "native" | "ocr" | "luna" | "terra" | "calcul" | "estimation" | "externe" | "declare";
const BASES: readonly BaseConfiance[] = ["metadata", "native", "ocr", "luna", "terra", "calcul", "estimation", "externe", "declare"];

export type NatureFraicheur = "TEMPS_REEL" | "INDEXEE" | "INCONNUE";

export interface CalculFait {
  /** Les identifiants des faits d'entrée (ou une description bornée quand ils ne sont pas des faits servis). */
  entrees: string[];
  transformation: string;
  formule: string;
  calculeLe: string;
}

export interface FaitSource {
  id: string;
  libelle: string;
  valeur: string | null;
  nature: NatureSource;
  famille: string | null;
  /** La capacité qui a lu : c'est elle qui a vérifié les droits de la personne. */
  outil: string;
  href: string | null;
  /** Page, diapositive, feuille!cellule, rang de message, adresse externe citée. */
  locator: string | null;
  /** La date PROPRE de la donnée (mise à jour, émission, envoi) — jamais la date de lecture. */
  horodatage: string | null;
  observeLe: string;
  confiance: number;
  base: BaseConfiance;
  fraicheur: NatureFraicheur;
  autorite: string | null;
  preuveNegative: boolean | null;
  /** La personne sous les droits de laquelle le fait a été lu. */
  acteur: string;
  calcul: CalculFait | null;
}

export const LIMITE_FAITS_PAR_OUTIL = 12;
export const LIMITE_FAITS_PAR_TOUR = 40;

// ─────────────────────────────── Le registre, relu ───────────────────────────────

export function familleDe(outil: string): DescripteurSource | null {
  return SOURCES.find((s) => s.capacites.includes(outil)) ?? null;
}

/** Les familles DÉRIVÉES (copies indexées) — leur fraîcheur se mesure ; les autres sont vivantes. */
const FAMILLES_INDEXEES: ReadonlySet<string> = new Set(["DRIVE_CONTENU_INDEXE", "CORPUS"]);

function fraicheurDeFamille(famille: string | null): NatureFraicheur {
  if (!famille) return "INCONNUE";
  return FAMILLES_INDEXEES.has(famille) ? "INDEXEE" : "TEMPS_REEL";
}

export const LIBELLE_FAMILLE: Record<string, string> = {
  DRIVE: "Drive", DRIVE_CONTENU_INDEXE: "index de contenu du Drive", REGULATORY: "Regulatory", CORPUS: "corpus de référence",
  LEGAL: "Legal", FINANCE: "Finances", COURRIERS: "Courriers", ANNUAIRE: "Annuaire", TACHES: "Tâches",
  ARTEFACTS: "livrables d'Adam", JOURNAL: "journal d'audit",
};

/** Les capacités hors registre dont la nature se connaît par leur nom. */
const NATURE_PAR_OUTIL: Record<string, NatureSource> = {
  gmail_search: "EMAIL", gmail_read: "EMAIL", gmail_thread: "FIL", read_calendar: "REUNION", web_research: "EXTERNE",
  read_document: "DOCUMENT", read_corpus_document: "DOCUMENT", find_documents: "DOCUMENT", search_drive: "DOCUMENT",
  directory_lookup: "PERSONNE", directory_list: "PERSONNE", search_people: "PERSONNE",
};

const NATURE_PAR_FAMILLE: Record<string, NatureSource> = {
  DRIVE: "DOCUMENT", DRIVE_CONTENU_INDEXE: "DOCUMENT", CORPUS: "DOCUMENT", ARTEFACTS: "DOCUMENT", ANNUAIRE: "PERSONNE",
  COURRIERS: "PIECE",
};

// ─────────────────────────────── Lire une sortie d'outil ───────────────────────────────

type Obj = Record<string, unknown>;
const estObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

const CLES_LIBELLE = ["reference", "nom", "name", "titre", "title", "objet", "sujet", "rappel", "fichier", "dossier", "produit", "libelle", "label", "type", "famille"] as const;
const CLES_HORODATAGE = [
  "misAJour", "mis_a_jour", "updatedAt", "modifieLe", "dateMaj", "derniereMaj", "date", "le", "envoyeLe", "recuLe", "emisLe",
  "createdAt", "creeLe", "dernierMouvement", "derniereActivite", "at",
] as const;
const CLES_IGNOREES = new Set<string>([
  ...CLES_LIBELLE, ...CLES_HORODATAGE, "lien", "liens", "id", "url", "href", "_blocs", "_provenance", "_blocsDecoratifs",
  "page", "pages", "feuille", "cellule", "diapositive", "extrait", "texte", "contenu", "corps", "body", "html",
]);

/** La référence ET le nom quand les deux existent (« PRD-014 — Lenvatinib ») : c'est ainsi qu'une personne cite un fait. */
function libelleDe(o: Obj): string {
  const parts: string[] = [];
  for (const k of CLES_LIBELLE) {
    const v = o[k];
    if (typeof v === "string" && v.trim() && !parts.includes(v.trim())) parts.push(v.trim().slice(0, 80));
    if (parts.length >= 2) break;
  }
  return parts.length ? parts.join(" — ") : "Élément";
}

/** ISO (date ou date-heure) ou JJ/MM/AAAA → ISO ; sinon null. Ne devine jamais une année. */
export function normaliserDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    const d = new Date(m[4] ? s.replace(" ", "T") : `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
    if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[1])) return null;
    return d.toISOString();
  }
  return null;
}

function horodatageDe(o: Obj): string | null {
  for (const k of CLES_HORODATAGE) {
    const iso = normaliserDate(o[k]);
    if (iso) return iso;
  }
  return null;
}

/** Les trois premiers scalaires « parlants » d'un enregistrement — ce que la personne a lu. */
function valeurDe(o: Obj): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (CLES_IGNOREES.has(k) || k.startsWith("_")) continue;
    if (typeof v === "string" && v.trim() && v.length <= 80) parts.push(`${k} : ${v.trim()}`);
    else if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k} : ${v}`);
    else if (typeof v === "boolean") parts.push(`${k} : ${v ? "oui" : "non"}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

function locatorDe(o: Obj): { locator: string | null; nature: NatureSource | null } {
  if (typeof o.feuille === "string" && typeof o.cellule === "string") return { locator: `${o.feuille}!${o.cellule}`, nature: "CELLULE" };
  if (typeof o.cellule === "string") return { locator: `cellule ${o.cellule}`, nature: "CELLULE" };
  if (typeof o.page === "number" && Number.isFinite(o.page)) return { locator: `page ${o.page}`, nature: "PAGE_PDF" };
  if (typeof o.diapositive === "number") return { locator: `diapositive ${o.diapositive}`, nature: "DOCUMENT" };
  if (typeof o.messageId === "string" || typeof o.expediteur === "string" || typeof o.de === "string") {
    return { locator: typeof o.messageId === "string" ? `message ${o.messageId.slice(0, 24)}` : null, nature: "EMAIL" };
  }
  if (typeof o.url === "string" && /^https?:\/\//i.test(o.url)) {
    try { return { locator: new URL(o.url).hostname, nature: "EXTERNE" }; } catch { return { locator: "adresse externe", nature: "EXTERNE" }; }
  }
  return { locator: null, nature: null };
}

function borne(s: unknown, n: number): string | null {
  return typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null;
}

/** Un fait DÉCLARÉ par un outil, revalidé champ par champ. `null` = refusé. */
function validerDeclare(x: unknown, outil: string, acteur: string, observeLe: string, n: number): FaitSource | null {
  if (!estObj(x)) return null;
  const nature = NATURES_SOURCE.includes(x.nature as NatureSource) ? (x.nature as NatureSource) : null;
  const libelle = borne(x.libelle, 120);
  if (!nature || !libelle) return null;
  const confiance = typeof x.confiance === "number" && x.confiance >= 0 && x.confiance <= 1 ? x.confiance : null;
  if (confiance === null) return null;
  const base = BASES.includes(x.base as BaseConfiance) ? (x.base as BaseConfiance) : "declare";
  const href = typeof x.href === "string" && x.href.startsWith("/") ? x.href.slice(0, 200) : null;
  let calcul: CalculFait | null = null;
  if (estObj(x.calcul)) {
    const c = x.calcul;
    const entrees = Array.isArray(c.entrees) ? c.entrees.filter((e): e is string => typeof e === "string").slice(0, 200).map((e) => e.slice(0, 80)) : [];
    const transformation = borne(c.transformation, 120);
    const formule = borne(c.formule, 200);
    if (!transformation || !formule) return null;
    calcul = { entrees, transformation, formule, calculeLe: normaliserDate(c.calculeLe) ?? observeLe };
  }
  if (nature === "CALCUL" && !calcul) return null;
  const desc = familleDe(outil);
  const famille = borne(x.famille, 40) ?? desc?.famille ?? null;
  return {
    id: `${outil}:decl:${n}`,
    libelle,
    valeur: typeof x.valeur === "number" ? String(x.valeur) : borne(x.valeur, 160),
    nature, famille, outil, href,
    locator: borne(x.locator, 120),
    horodatage: normaliserDate(x.horodatage),
    observeLe,
    confiance, base,
    fraicheur: fraicheurDeFamille(famille),
    autorite: desc?.autorite ?? null,
    preuveNegative: desc?.preuveNegative ?? null,
    acteur, calcul,
  };
}

/**
 * LES FAITS D'UNE SORTIE D'OUTIL. Parcours déterministe et borné : un enregistrement = un objet
 * qui porte un lien interne (`lien`/`liens`), comme dans le panneau « Sources » — plus ce que
 * l'outil a déclaré lui-même dans `_provenance`. Rien n'est inventé : un champ absent reste nul.
 */
export function extraireFaits(
  outil: string,
  sortie: string,
  ctx: { acteur: string; observeLe?: Date; max?: number },
): FaitSource[] {
  const max = Math.max(1, Math.min(ctx.max ?? LIMITE_FAITS_PAR_OUTIL, LIMITE_FAITS_PAR_TOUR));
  const observeLe = (ctx.observeLe ?? new Date()).toISOString();
  let data: unknown;
  try { data = JSON.parse(sortie); } catch { return []; }
  const out: FaitSource[] = [];
  const vus = new Set<string>();
  const desc = familleDe(outil);
  const famille = desc?.famille ?? null;

  // 1. Les faits DÉCLARÉS par l'outil, en tête : ils portent leur lignée.
  if (estObj(data) && Array.isArray(data._provenance)) {
    data._provenance.slice(0, max).forEach((x, i) => {
      const f = validerDeclare(x, outil, ctx.acteur, observeLe, i);
      if (f && out.length < max) out.push(f);
    });
  }

  const natureParDefaut: NatureSource = NATURE_PAR_OUTIL[outil] ?? (famille ? NATURE_PAR_FAMILLE[famille] : undefined) ?? "ERP";
  const confianceParDefaut = natureParDefaut === "EXTERNE" ? 0.6 : famille && FAMILLES_INDEXEES.has(famille) ? 0.9 : 1;
  const baseParDefaut: BaseConfiance = natureParDefaut === "EXTERNE" ? "externe" : famille && FAMILLES_INDEXEES.has(famille) ? "native" : "metadata";

  const pousser = (o: Obj, href: string | null): void => {
    if (out.length >= max) return;
    const { locator, nature: natureLocale } = locatorDe(o);
    const cle = href ?? `${libelleDe(o)}|${locator ?? ""}`;
    if (vus.has(cle)) return;
    vus.add(cle);
    // Une extraction MESURÉE par l'outil (OCR, vision) prime sur la valeur par défaut.
    const confianceDeclaree = typeof o.confiance === "number" && o.confiance >= 0 && o.confiance <= 1 ? o.confiance
      : typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : null;
    const baseDeclaree = BASES.includes(o.extractedBy as BaseConfiance) ? (o.extractedBy as BaseConfiance) : null;
    const nature = natureLocale ?? natureParDefaut;
    out.push({
      id: `${outil}:${href ?? cle}`,
      libelle: libelleDe(o),
      valeur: valeurDe(o),
      nature, famille, outil,
      href,
      locator,
      horodatage: horodatageDe(o),
      observeLe,
      confiance: confianceDeclaree ?? (nature === "EXTERNE" ? 0.6 : confianceParDefaut),
      base: baseDeclaree ?? (nature === "EXTERNE" ? "externe" : baseParDefaut),
      fraicheur: fraicheurDeFamille(famille),
      autorite: desc?.autorite ?? null,
      preuveNegative: desc?.preuveNegative ?? null,
      acteur: ctx.acteur,
      calcul: null,
    });
  };

  const marcher = (node: unknown, profondeur: number): void => {
    if (out.length >= max || profondeur > 3 || node == null) return;
    if (Array.isArray(node)) { for (const item of node.slice(0, 30)) marcher(item, profondeur + 1); return; }
    if (!estObj(node)) return;
    const lien = node.lien;
    if (typeof lien === "string" && lien.startsWith("/")) pousser(node, lien);
    else if (Array.isArray(node.liens) && node.liens.some((l) => typeof l === "string" && l.startsWith("/"))) {
      pousser(node, node.liens.find((l): l is string => typeof l === "string" && l.startsWith("/")) ?? null);
    } else if (typeof node.url === "string" && /^https?:\/\//i.test(node.url)) {
      // Une adresse externe est CITÉE, jamais suivie : `href` reste nul, le domaine va dans `locator`.
      pousser(node, null);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "_provenance") continue;
      if (v && typeof v === "object") marcher(v, profondeur + 1);
    }
  };
  marcher(data, 0);

  // 3. RIEN DE LIÉ ? LA LECTURE ELLE-MÊME EST UN FAIT. L'annuaire rend une fiche sans lien, une
  // recherche rend « aucun résultat » : dans les deux cas Adam a interrogé une source précise, à
  // un instant précis, avec des droits précis — et « d'où tu tiens ça ? » doit pouvoir le dire.
  // Le fait porte le premier objet parlant (celui qui a un libellé), sinon la racine, et prend le
  // nom de l'outil quand rien ne le nomme. Une sortie d'erreur n'est pas une lecture : rien.
  if (out.length === 0 && estObj(data) && Object.keys(data).length > 0 && !("error" in data) && !("erreur" in data)) {
    const parlant = premierObjetParlant(data) ?? data;
    pousser(parlant, null);
    const dernier = out[out.length - 1];
    if (dernier && dernier.libelle === "Élément") dernier.libelle = LIBELLE_OUTIL[outil] ?? outil;
    if (dernier && !dernier.valeur && typeof data.message === "string") dernier.valeur = `message : ${data.message.slice(0, 120)}`;
  }
  return out;
}

/** Les capacités dont la lecture, sans enregistrement lié, se nomme par elle-même. */
const LIBELLE_OUTIL: Record<string, string> = {
  directory_lookup: "Annuaire — fiche consultée", directory_list: "Annuaire — registre des personnes", search_people: "Annuaire — recherche",
  gmail_search: "Messagerie — recherche", read_calendar: "Agenda", list_pending_decisions: "File des décisions", inspect_record: "Fiche consultée",
  search_products: "Regulatory — recherche de produits", regulatory_portfolio: "Regulatory — portefeuille", finance_totals: "Finances — agrégat",
  read_finances: "Finances — écritures", search_everything: "Recherche fédérée", find_documents: "Index de contenu du Drive",
};

/** Le premier objet (racine comprise, profondeur ≤ 2) qui porte un libellé — celui dont on parle. */
function premierObjetParlant(data: Obj): Obj | null {
  const aUnLibelle = (o: Obj): boolean => CLES_LIBELLE.some((k) => typeof o[k] === "string" && (o[k] as string).trim().length > 0);
  if (aUnLibelle(data)) return data;
  const file: { o: Obj; p: number }[] = [{ o: data, p: 0 }];
  while (file.length) {
    const { o, p } = file.shift()!;
    for (const v of Object.values(o)) {
      if (estObj(v)) { if (aUnLibelle(v)) return v; if (p < 2) file.push({ o: v, p: p + 1 }); }
      else if (Array.isArray(v)) for (const it of v.slice(0, 5)) if (estObj(it)) { if (aUnLibelle(it)) return it; if (p < 2) file.push({ o: it, p: p + 1 }); }
    }
  }
  return null;
}

/**
 * UN FAIT CALCULÉ — le total, l'écart, la moyenne. Il n'est pas « un chiffre de plus » : il porte
 * ses entrées, la transformation, la formule et l'instant du calcul, et sa confiance est celle
 * de sa PIRE entrée — un total de lignes sûres et d'une ligne OCR n'est pas plus sûr que l'OCR.
 * TROIS propriétés suivent la pire entrée, et il fallait les trois : la confiance, la DATE (la
 * donnée la plus ancienne date le calcul) et la FRAÎCHEUR. Les deux premières étaient là ; la
 * troisième manquait, et un total bâti sur une copie de mars se déclarait « temps réel ».
 */
export function faitCalcule(args: {
  outil: string; acteur: string; libelle: string; valeur: number | string;
  entrees: readonly (FaitSource | string)[]; transformation: string; formule: string;
  href?: string | null; famille?: string | null; observeLe?: Date;
  /**
   * VRAI quand la valeur porte sur ce qui N'A PAS ENCORE EU LIEU, ou sur ce qu'on n'a pas
   * observé : un tirage de Monte-Carlo, une prévision, une probabilité. C'est l'appelant qui
   * le sait — le moteur, lui, ne voit qu'un nombre. Le laisser deviner ferait passer un P90
   * pour une somme.
   */
  estimation?: boolean;
}): FaitSource {
  const observeLe = (args.observeLe ?? new Date()).toISOString();
  const faits = args.entrees.filter((e): e is FaitSource => typeof e !== "string");
  const confiance = faits.length ? Math.min(...faits.map((f) => f.confiance)) : 1;
  const desc = familleDe(args.outil);
  const famille = args.famille ?? desc?.famille ?? null;
  const horodatages = faits.map((f) => f.horodatage).filter((h): h is string => Boolean(h)).sort();
  // LA FRAÎCHEUR SUIT LA MÊME RÈGLE QUE LA CONFIANCE ET LA DATE : la pire entrée gouverne. Un
  // total calculé sur une COPIE indexée est lui-même une copie indexée — la source a pu bouger
  // depuis, et le total ne le sait pas plus que la ligne dont il vient. Sans entrée qui le dise,
  // on ne suppose rien : c'est la famille de l'outil qui parle, comme avant.
  const fraicheur: NatureFraicheur = faits.some((f) => f.fraicheur === "INDEXEE")
    ? "INDEXEE"
    : fraicheurDeFamille(famille);
  return {
    id: `${args.outil}:calcul:${args.libelle.slice(0, 40)}`,
    libelle: args.libelle.slice(0, 120),
    valeur: String(args.valeur).slice(0, 160),
    nature: "CALCUL", famille, outil: args.outil,
    href: args.href && args.href.startsWith("/") ? args.href : null,
    locator: null,
    // La date propre d'un calcul est celle de sa donnée la plus ANCIENNE : c'est elle qui le date.
    horodatage: horodatages[0] ?? null,
    observeLe, confiance, base: args.estimation ? "estimation" : "calcul",
    fraicheur,
    autorite: desc?.autorite ?? null,
    preuveNegative: desc?.preuveNegative ?? null,
    acteur: args.acteur,
    calcul: {
      entrees: args.entrees.slice(0, 200).map((e) => (typeof e === "string" ? e.slice(0, 80) : e.id.slice(0, 80))),
      transformation: args.transformation.slice(0, 120),
      formule: args.formule.slice(0, 200),
      calculeLe: observeLe,
    },
  };
}

/** Ce qu'un outil met dans `_provenance` pour déclarer ses faits — la forme est celle du fait lui-même. */
export function declarerProvenance(faits: readonly FaitSource[]): FaitSource[] {
  return faits.slice(0, LIMITE_FAITS_PAR_OUTIL);
}

/** TOUS les faits d'un tour, dédoublonnés par identifiant, bornés — dans l'ordre des lectures. */
export function faitsDuTour(
  lectures: readonly { outil: string; sortie: string }[],
  ctx: { acteur: string; observeLe?: Date },
): FaitSource[] {
  const out: FaitSource[] = [];
  const vus = new Set<string>();
  for (const l of lectures) {
    for (const f of extraireFaits(l.outil, l.sortie, ctx)) {
      if (vus.has(f.id) || out.length >= LIMITE_FAITS_PAR_TOUR) continue;
      vus.add(f.id);
      out.push(f);
    }
  }
  return out;
}

// ─────────────────────────────── Dire la provenance ───────────────────────────────

const DATE = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" });
const DATE_HEURE = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

function dateHumaine(iso: string | null, avecHeure = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const minuit = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  return avecHeure && !minuit ? DATE_HEURE.format(d) : DATE.format(d);
}

const LIBELLE_BASE: Record<BaseConfiance, string> = {
  metadata: "donnée structurée de l'ERP", native: "texte extrait par le code", ocr: "reconnaissance de caractères",
  luna: "lecture par un modèle de vision", terra: "lecture par un modèle avancé", calcul: "calcul du serveur",
  estimation: "estimation du serveur, sous les hypothèses déclarées", externe: "source externe", declare: "mesuré par l'outil",
};

const LIBELLE_NATURE: Record<NatureSource, string> = {
  ERP: "ERP", DOCUMENT: "document", EMAIL: "e-mail", FIL: "fil de messages", PAGE_PDF: "page de PDF", CELLULE: "cellule de classeur",
  PIECE: "pièce", REUNION: "réunion", PERSONNE: "fiche personne", DATE: "date", EXTERNE: "source externe", CALCUL: "calcul",
};

/** UNE LIGNE par fait : quoi, d'où, de quand, lu quand, à quel point on y croit. */
export function expliquerFait(f: FaitSource): string {
  const famille = f.famille ? (LIBELLE_FAMILLE[f.famille] ?? f.famille) : null;
  const morceaux: string[] = [];
  if (f.nature === "CALCUL" && f.calcul) {
    const quoi = f.base === "estimation" ? "estimation du serveur" : "calcul du serveur";
    morceaux.push(`${quoi} : ${f.calcul.transformation} sur ${f.calcul.entrees.length} entrée(s)`);
    morceaux.push(`formule ${f.calcul.formule}`);
    morceaux.push(`calculé le ${dateHumaine(f.calcul.calculeLe, true) ?? "—"}`);
    if (f.horodatage) morceaux.push(`donnée la plus ancienne du ${dateHumaine(f.horodatage)}`);
  } else {
    const ou = [LIBELLE_NATURE[f.nature], famille ? `· ${famille}` : null, f.locator ? `(${f.locator})` : null].filter(Boolean).join(" ");
    morceaux.push(ou);
    morceaux.push(f.horodatage ? `donnée du ${dateHumaine(f.horodatage, true)}` : "sans date propre");
    morceaux.push(`lue le ${dateHumaine(f.observeLe, true) ?? "—"} avec vos droits (${f.outil})`);
  }
  const confiance = `${Math.round(f.confiance * 100)} % — ${LIBELLE_BASE[f.base]}`;
  morceaux.push(`confiance ${confiance}`);
  if (f.fraicheur === "INDEXEE") morceaux.push("copie indexée, datée");
  if (f.autorite && f.nature !== "CALCUL") morceaux.push(`autorité : ${f.autorite.replace(/\.$/, "")}`);
  const tete = f.valeur ? `${f.libelle} — ${f.valeur}` : f.libelle;
  return `• ${tete} : ${morceaux.join(" · ")}${f.href ? ` → ${f.href}` : ""}`;
}

const plier = (s: string): string => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** LE DÉTAIL COMPACT d'une source, pour le panneau « Sources consultées » : famille · date propre · fraîcheur · confiance. */
export function resumerFait(f: FaitSource): string {
  const famille = f.famille ? (LIBELLE_FAMILLE[f.famille] ?? f.famille) : LIBELLE_NATURE[f.nature];
  const morceaux = [
    famille,
    f.locator,
    f.horodatage ? `donnée du ${dateHumaine(f.horodatage)}` : null,
    f.fraicheur === "TEMPS_REEL" ? "temps réel" : f.fraicheur === "INDEXEE" ? "copie indexée" : null,
    f.confiance < 1 ? `confiance ${Math.round(f.confiance * 100)} %` : null,
  ].filter(Boolean);
  return morceaux.join(" · ");
}

/** Les nombres d'une question, en chiffres seuls (« 142 800 » et « 142.800 » → « 142800 »), trois chiffres au moins. */
export function ancresNumeriques(question: string): string[] {
  const out = new Set<string>();
  for (const m of question.matchAll(/\d(?:[\d   .,]*\d)?/g)) {
    const chiffres = m[0].replace(/[^\d]/g, "");
    if (chiffres.length >= 3) out.add(chiffres);
  }
  return [...out];
}

/** Les mots « propres » d'une question — noms, références — pliés, de quatre lettres au moins. */
export function ancresNominales(question: string): string[] {
  const out = new Set<string>();
  for (const m of question.matchAll(/\b([A-ZÀ-Ý][\p{L}\d-]{3,}|[A-Z]{2,}-?\d{2,})\b/gu)) {
    const mot = plier(m[1]);
    if (!MOTS_VIDES.has(mot)) out.add(mot);
  }
  return [...out];
}
const MOTS_VIDES = new Set(["adam", "d'ou", "pourquoi", "comment", "quelle", "quelles", "quel", "quels", "tiens", "vient", "source", "sources"]);

function faitCorrespond(f: FaitSource, nombres: string[], noms: string[]): boolean {
  const texte = plier(`${f.libelle} ${f.valeur ?? ""} ${f.locator ?? ""}`);
  const chiffresDuFait = texte.replace(/[^\d]/g, " ");
  if (nombres.some((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(chiffresDuFait) || texte.replace(/[\s .,  ]/g, "").includes(n))) return true;
  return noms.some((n) => texte.includes(n));
}

export interface TourProvenance {
  faits: FaitSource[];
  question: string | null;
  createdAt: Date;
}

/**
 * LA RÉPONSE À « D'OÙ TU TIENS ÇA ? » — composée par le code, jamais par un modèle : une
 * provenance paraphrasée serait une provenance inventée à moitié.
 *
 * Un nombre ou un nom dans la question cible les faits qui le portent, sur les tours récents ;
 * sans ancre, ce sont les faits du DERNIER tour qui a lu quelque chose. Quand rien n'a été lu,
 * on le dit : « je n'ai servi aucun fait sourcé » vaut mieux qu'une source de complaisance.
 */
export function repondreProvenance(args: { question: string; tours: readonly TourProvenance[]; now?: Date }): {
  texte: string; faits: FaitSource[]; trouve: boolean; cible: "ancre" | "dernier_tour" | "aucun";
} {
  const tours = [...args.tours].filter((t) => t.faits.length > 0).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (tours.length === 0) {
    return {
      texte: "Je n'ai servi aucun fait sourcé dans nos derniers échanges : ma dernière réponse ne venait d'aucune lecture de l'ERP, du Drive ou de la messagerie — une formulation générale, ou une action. Reposez la question de fond et je citerai chacune de mes lectures.",
      faits: [], trouve: false, cible: "aucun",
    };
  }
  const nombres = ancresNumeriques(args.question);
  const noms = ancresNominales(args.question);
  let cible: "ancre" | "dernier_tour" = "dernier_tour";
  let retenus: FaitSource[] = [];
  if (nombres.length || noms.length) {
    for (const t of tours) {
      const c = t.faits.filter((f) => faitCorrespond(f, nombres, noms));
      if (c.length) { retenus = c; cible = "ancre"; break; }
    }
  }
  if (!retenus.length) retenus = tours[0].faits.slice(0, 12);

  const lignes = retenus.map(expliquerFait);
  const tete = cible === "ancre"
    ? "Voici d'où je tiens précisément ce que vous citez :"
    : nombres.length || noms.length
      ? "Je n'ai pas retrouvé exactement ce que vous citez dans mes lectures ; voici ce que j'ai lu au dernier tour qui a consulté des données :"
      : "Voici d'où je tiens ce que je viens de dire :";
  const pied: string[] = [];
  if (retenus.some((f) => f.fraicheur === "TEMPS_REEL")) pied.push("Les sources ERP sont des tables vivantes : ce que j'ai lu était l'état exact au moment de la lecture.");
  if (retenus.some((f) => f.fraicheur === "INDEXEE")) pied.push("L'index de contenu est une copie datée : « pas dans l'index » ne prouve pas l'absence dans le Drive.");
  if (retenus.some((f) => f.nature === "EXTERNE")) pied.push("Une source externe est citée, pas garantie : vérifiez avant d'agir dessus.");
  if (retenus.some((f) => f.confiance < 0.85 && f.nature !== "EXTERNE")) pied.push("Une confiance sous 85 % vient d'une extraction (OCR, vision) : à contrôler contre l'original.");
  const dateTour = dateHumaine(tours[0].createdAt.toISOString(), true);
  const quand = cible === "dernier_tour" && dateTour ? ` (tour du ${dateTour})` : "";
  return {
    texte: `${tete}${quand}\n${lignes.join("\n")}${pied.length ? `\n\n${pied.join(" ")}` : ""}`,
    faits: retenus, trouve: true, cible,
  };
}
