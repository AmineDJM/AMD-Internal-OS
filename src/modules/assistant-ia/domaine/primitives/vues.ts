/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — LA PRIMITIVE `lire` : LES VUES DÉCLARÉES (décision 0065, audit AU2 §6.1 (a), étape M0). Règle PURE, zéro import.
 *
 * Une VUE est une déclaration : ses champs (nom, type, description, valeurs permises, mots naturels), d'où vient chaque
 * valeur (une colonne de la base, ou une RÈGLE de l'ERP — « commercialisé », « étape du cycle »), le lien de l'écran qui
 * la montre, et le DROIT qui l'ouvre. Le modèle lit le SCHÉMA et formule son filtre sur des champs qu'il connaît ; le
 * serveur NORMALISE ce qu'il reçoit (« octobre 2026 » → 2026-10, « infectieux » trouve « Infectiologie », accents,
 * casse, libellés d'écran ↔ codes) : la robustesse ne dépend pas de la force du modèle.
 *
 * Ce fichier ne lit rien. La portée (la fonction `where` de l'écran, OBLIGATOIRE) et la lecture vivent dans
 * `infra/primitives/vues/` ; ici : le schéma, la validation d'une déclaration (les colonnes du coffre ne se déclarent
 * pas), la normalisation des filtres, le filtrage, le tri et la projection des lignes déjà lues sous la portée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TypeChamp = "texte" | "nombre" | "date" | "booleen" | "liste" | "choix" | "lien";

/** D'où vient la valeur d'un champ : une colonne de la base, ou une règle de l'ERP (calculée, jamais par le modèle). */
export type SourceChamp = { modele: string; champ: string } | { regle: string };

export interface ChampVue {
  nom: string;
  type: TypeChamp;
  description: string;
  source: SourceChamp;
  /** `choix` (et `liste` de choix) : les valeurs canoniques, avec leurs libellés d'écran et les mots naturels qui y mènent. */
  valeurs?: Readonly<Record<string, readonly string[]>>;
  /** D'autres noms par lesquels on désigne ce champ (« statut » pour `etat`). */
  alias?: readonly string[];
}

export interface DeclarationVue {
  nom: string;
  description: string;
  /** L'écran de l'ERP qui montre ces lignes (lien relatif). */
  ecran: string;
  /** Le droit qui ouvre la vue, en clair — dit tel quel quand la vue est fermée. */
  droit: string;
  champs: readonly ChampVue[];
  /** Les champs rendus quand le modèle n'en demande aucun. */
  parDefaut: readonly string[];
}

export const OPERATEURS = ["=", "!=", "contient", "ne_contient_pas", "commence_par", ">", ">=", "<", "<=", "entre", "parmi", "vide", "renseigne"] as const;
export type Operateur = (typeof OPERATEURS)[number];

export type Ligne = Record<string, unknown>;

/** Bornes : ce qu'une lecture rend au plus au modèle (le jeu complet reste au serveur, pour `produire`). */
export const LIGNES_RENDUES_MAX = 60;
export const LIGNES_JEU_MAX = 5_000;

// ─── Les mots ───────────────────────────────────────────────────────────────────────────────

/** Minuscules, sans accents, espaces et ponctuation réduits. */
export const plier = (t: unknown): string =>
  String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’'`]/g, " ").replace(/[^a-z0-9@.+#/-]+/g, " ").trim();

const SUFFIXES = ["iologiques", "iologique", "iologie", "ologie", "ieuses", "ieuse", "ieux", "iques", "ique", "ites", "ite", "aires", "aire", "es", "s", "e"];
/** La RACINE d'un mot (« infectieux » → « infect », « cardiologie » → « cardi ») — pour qu'un mot dit trouve le mot écrit. */
export function racine(mot: string): string {
  const m = plier(mot);
  for (const s of SUFFIXES) if (m.length - s.length >= 5 && m.endsWith(s)) return m.slice(0, -s.length);
  return m;
}

/** « contient », tolérant : le texte plié, ou chaque mot par sa racine (« infectieux » ⊂ « Infectiologie & Réanimation »). */
export function contientTolerant(texte: unknown, cherche: unknown): boolean {
  const t = plier(texte);
  const c = plier(cherche);
  if (!c) return true;
  if (t.includes(c)) return true;
  const mots = c.split(" ").filter((m) => m.length >= 3);
  return mots.length > 0 && mots.every((m) => t.includes(m.length >= 6 ? racine(m) : m));
}

// ─── Les dates dites en français ────────────────────────────────────────────────────────────

const MOIS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, mar: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  aout: 8, septembre: 9, sept: 9, sep: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
};
const deux = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${deux(d.getUTCMonth() + 1)}-${deux(d.getUTCDate())}`;

/** Une période lue : un jour (AAAA-MM-JJ) ou un mois (AAAA-MM). `null` si la valeur n'est pas une date. */
export type Periode = { jour: string } | { mois: string };

/** « octobre 2026 », « oct. 2026 », « 10/2026 », « 2026-10 », « octobre » (l'année en cours), « 3 novembre 2026 », « 03/11/2026 », « aujourd'hui »… */
export function lirePeriode(valeur: unknown, maintenant: Date): Periode | null {
  if (valeur instanceof Date && !Number.isNaN(valeur.getTime())) return { jour: ymd(valeur) };
  const v = plier(valeur).replace(/\.(?=\s|$)/g, "");
  if (!v) return null;
  const annee = maintenant.getUTCFullYear();
  const relatif: Record<string, number> = { "aujourd hui": 0, aujourdhui: 0, demain: 1, hier: -1, "apres demain": 2, "avant hier": -2 };
  if (v in relatif) return { jour: ymd(new Date(maintenant.getTime() + relatif[v]! * 86_400_000)) };
  if (v === "ce mois" || v === "ce mois ci" || v === "mois en cours") return { mois: `${annee}-${deux(maintenant.getUTCMonth() + 1)}` };
  if (v === "mois dernier" || v === "le mois dernier") {
    const d = new Date(Date.UTC(annee, maintenant.getUTCMonth() - 1, 1));
    return { mois: `${d.getUTCFullYear()}-${deux(d.getUTCMonth() + 1)}` };
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return { jour: `${m[1]}-${deux(+m[2]!)}-${deux(+m[3]!)}` };
  m = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return { mois: `${m[1]}-${deux(+m[2]!)}` };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return { jour: `${m[3]}-${deux(+m[2]!)}-${deux(+m[1]!)}` };
  m = /^(\d{1,2})\/(\d{4})$/.exec(v);
  if (m && +m[1]! >= 1 && +m[1]! <= 12) return { mois: `${m[2]}-${deux(+m[1]!)}` };
  m = /^(?:le )?(\d{1,2}|1er) ([a-z]+) ?(\d{4})?$/.exec(v);
  if (m && MOIS[m[2]!]) return { jour: `${m[3] ?? annee}-${deux(MOIS[m[2]!]!)}-${deux(m[1] === "1er" ? 1 : +m[1]!)}` };
  m = /^(?:en |mois de |mois d )?([a-z]+) ?(\d{4})?$/.exec(v);
  if (m && MOIS[m[1]!]) return { mois: `${m[2] ?? annee}-${deux(MOIS[m[1]!]!)}` };
  return null;
}

/** La forme canonique d'une date ou d'un mois dit naturellement : « octobre 2026 » → « 2026-10 ». `null` : illisible. */
export function normaliserDate(valeur: unknown, maintenant = new Date()): string | null {
  const p = lirePeriode(valeur, maintenant);
  return p ? ("jour" in p ? p.jour : p.mois) : null;
}

/** « 1 200,50 », « 1.200 », « 12 k » → nombre. */
export function lireNombre(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[\s  ]/g, "").replace(/(da|dzd|€|\$)$/i, "");
  const k = /^(-?[\d.,]+)k$/i.exec(s);
  const brut = (k ? k[1]! : s).replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(brut);
  return Number.isFinite(n) && brut !== "" ? (k ? n * 1000 : n) : null;
}

const OUI = new Set(["oui", "vrai", "true", "1", "yes", "actif", "active"]);
const NON = new Set(["non", "faux", "false", "0", "no", "inactif", "inactive"]);

// ─── Le champ visé, la valeur normalisée ────────────────────────────────────────────────────

/** Le champ que le modèle a nommé — son nom, un alias, plié (« Statut » → `etat`). */
export function trouverChamp(vue: DeclarationVue, nom: unknown): ChampVue | null {
  const p = plier(nom).replace(/[ _-]+/g, "");
  if (!p) return null;
  return vue.champs.find((c) => plier(c.nom).replace(/[ _-]+/g, "") === p || (c.alias ?? []).some((a) => plier(a).replace(/[ _-]+/g, "") === p)) ?? null;
}

/** La valeur canonique d'un choix : le code, son libellé, ou un mot naturel qui y mène. `null` : aucune. */
export function lireChoix(champ: ChampVue, valeur: unknown): string | null {
  const p = plier(valeur);
  if (!p || !champ.valeurs) return null;
  for (const [code, mots] of Object.entries(champ.valeurs)) {
    if (plier(code) === p || mots.some((m) => plier(m) === p)) return code;
  }
  for (const [code, mots] of Object.entries(champ.valeurs)) {
    if ([code, ...mots].some((m) => racine(m) === racine(p))) return code;
  }
  return null;
}

/** Les valeurs permises d'un choix, en clair — dites au modèle quand il se trompe. */
const permises = (c: ChampVue) => Object.entries(c.valeurs ?? {}).map(([code, mots]) => (mots[0] ? `${code} (${mots[0]})` : code)).join(", ");

export type FiltreNormalise = { champ: ChampVue; op: Operateur; valeur: unknown };

/** Normalise UN filtre : champ connu, opérateur permis, valeur lue (date, nombre, choix, oui/non). Rend l'erreur, nommée. */
export function normaliserFiltre(vue: DeclarationVue, f: { champ?: unknown; op?: unknown; valeur?: unknown }, maintenant = new Date()): FiltreNormalise | { erreur: string } {
  const champ = trouverChamp(vue, f.champ);
  if (!champ) return { erreur: `champ « ${String(f.champ ?? "")} » inconnu de la vue ${vue.nom} ; champs : ${vue.champs.map((c) => c.nom).join(", ")}` };
  const dit = String(f.op ?? "=").trim() || "=";
  const brut = (OPERATEURS as readonly string[]).includes(dit) ? dit : plier(dit).replace(/ /g, "_");
  const synonymes: Record<string, Operateur> = {
    egal: "=", "==": "=", est: "=", different: "!=", "<>": "!=", contains: "contient", inclut: "contient", commence: "commence_par",
    superieur: ">", inferieur: "<", apres: ">", avant: "<", dans: "parmi", in: "parmi", est_vide: "vide", non_vide: "renseigne", existe: "renseigne",
  };
  const op = (OPERATEURS as readonly string[]).includes(brut) ? (brut as Operateur) : synonymes[brut] ?? ((OPERATEURS as readonly string[]).includes(String(f.op)) ? (f.op as Operateur) : null);
  if (!op) return { erreur: `opérateur « ${String(f.op)} » inconnu ; opérateurs : ${OPERATEURS.join(", ")}` };
  if (op === "vide" || op === "renseigne") return { champ, op, valeur: null };
  const une = (v: unknown): { ok: unknown } | { erreur: string } => {
    if (champ.type === "date") {
      const p = lirePeriode(v, maintenant);
      return p ? { ok: p } : { erreur: `« ${String(v)} » n'est pas une date lisible pour ${champ.nom} (ex. 2026-10, octobre 2026, 03/11/2026)` };
    }
    if (champ.type === "nombre") {
      const n = lireNombre(v);
      return n === null ? { erreur: `« ${String(v)} » n'est pas un nombre pour ${champ.nom}` } : { ok: n };
    }
    if (champ.type === "booleen") {
      const p = plier(v);
      return OUI.has(p) ? { ok: true } : NON.has(p) ? { ok: false } : { erreur: `${champ.nom} se filtre par oui / non` };
    }
    if (champ.valeurs && (op === "=" || op === "!=" || op === "parmi")) {
      const c = lireChoix(champ, v);
      return c ? { ok: c } : { erreur: `« ${String(v)} » n'est pas une valeur de ${champ.nom} ; valeurs : ${permises(champ)}` };
    }
    return { ok: String(v ?? "") };
  };
  if (op === "entre" || op === "parmi") {
    const liste = Array.isArray(f.valeur) ? f.valeur : String(f.valeur ?? "").split(/\s*(?:,|;|\bet\b|\bou\b|\.\.)\s*/).filter(Boolean);
    if (op === "entre" && liste.length !== 2) return { erreur: `« entre » attend deux bornes pour ${champ.nom}` };
    const lues = liste.map(une);
    const e = lues.find((x) => "erreur" in x);
    if (e && "erreur" in e) return e;
    return { champ, op, valeur: lues.map((x) => (x as { ok: unknown }).ok) };
  }
  const u = une(f.valeur);
  return "erreur" in u ? u : { champ, op, valeur: u.ok };
}

// ─── Comparer ───────────────────────────────────────────────────────────────────────────────

const valeursDe = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const estVide = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Le jour (AAAA-MM-JJ) d'une valeur de date stockée. */
const jourDe = (v: unknown): string | null => (v instanceof Date ? ymd(v) : typeof v === "string" && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 10) : null);
/** Une période comparée à un jour : bornes [début, fin] en AAAA-MM-JJ. */
const bornes = (p: Periode): [string, string] => ("jour" in p ? [p.jour, p.jour] : [`${p.mois}-01`, `${p.mois}-31`]);

function compareUne(f: FiltreNormalise, v: unknown, cible: unknown): boolean {
  const { champ, op } = f;
  if (champ.type === "date") {
    const j = jourDe(v);
    if (!j) return false;
    const [a, b] = bornes(cible as Periode);
    if (op === "=") return j >= a && j <= b;
    if (op === "!=") return j < a || j > b;
    if (op === ">") return j > b;
    if (op === ">=") return j >= a;
    if (op === "<") return j < a;
    if (op === "<=") return j <= b;
    return false;
  }
  if (champ.type === "nombre") {
    const n = typeof v === "number" ? v : lireNombre(v);
    if (n === null) return false;
    const c = cible as number;
    return op === "=" ? n === c : op === "!=" ? n !== c : op === ">" ? n > c : op === ">=" ? n >= c : op === "<" ? n < c : op === "<=" ? n <= c : false;
  }
  if (champ.type === "booleen") return op === "!=" ? Boolean(v) !== cible : Boolean(v) === cible;
  if (op === "=") return champ.valeurs ? plier(v) === plier(cible) : plier(v) === plier(cible);
  if (op === "!=") return plier(v) !== plier(cible);
  if (op === "contient") return contientTolerant(v, cible);
  if (op === "ne_contient_pas") return !contientTolerant(v, cible);
  if (op === "commence_par") return plier(v).startsWith(plier(cible));
  const a = plier(v);
  const b = plier(cible);
  return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : false;
}

/** Une ligne satisfait-elle le filtre ? Un champ LISTE : une valeur suffit (« contient »), aucune ne doit (« != »). */
export function satisfait(ligne: Ligne, f: FiltreNormalise): boolean {
  const v = ligne[f.champ.nom];
  if (f.op === "vide") return estVide(v);
  if (f.op === "renseigne") return !estVide(v);
  const vs = valeursDe(v);
  if (f.op === "parmi") return (f.valeur as unknown[]).some((c) => vs.some((x) => compareUne({ ...f, op: "=" }, x, c)));
  if (f.op === "entre") {
    const [a, b] = f.valeur as unknown[];
    return vs.some((x) => compareUne({ ...f, op: ">=" }, x, a) && compareUne({ ...f, op: "<=" }, x, b));
  }
  if (f.op === "!=" || f.op === "ne_contient_pas") return vs.every((x) => compareUne(f, x, f.valeur));
  return vs.some((x) => compareUne(f, x, f.valeur));
}

export function filtrer(lignes: readonly Ligne[], filtres: readonly FiltreNormalise[]): Ligne[] {
  return lignes.filter((l) => filtres.every((f) => satisfait(l, f)));
}

/** Trier par un champ (texte plié, nombres, dates) ; les valeurs vides en dernier. */
export function trier(lignes: readonly Ligne[], champ: ChampVue | null, sens: "asc" | "desc" = "asc"): Ligne[] {
  if (!champ) return [...lignes];
  const k = (l: Ligne): string | number | null => {
    const v = l[champ.nom];
    if (estVide(v)) return null;
    if (champ.type === "nombre") return typeof v === "number" ? v : lireNombre(v);
    if (champ.type === "date") return jourDe(v);
    return plier(Array.isArray(v) ? v.join(" ") : v);
  };
  const s = sens === "desc" ? -1 : 1;
  return [...lignes].sort((a, b) => {
    const x = k(a);
    const y = k(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return x < y ? -s : x > y ? s : 0;
  });
}

/** Ne garder que les champs demandés (dans cet ordre) ; une date sort en AAAA-MM-JJ. */
export function projeter(lignes: readonly Ligne[], champs: readonly ChampVue[]): Ligne[] {
  return lignes.map((l) => Object.fromEntries(champs.map((c) => {
    const v = l[c.nom];
    return [c.nom, v instanceof Date ? ymd(v) : v ?? null];
  })));
}

/** Les champs demandés (noms, alias tolérés) ; aucun → ceux par défaut. Un nom inconnu revient nommé. */
export function champsDemandes(vue: DeclarationVue, noms: unknown): { champs: ChampVue[] } | { erreur: string } {
  const liste = Array.isArray(noms) ? noms.map(String).filter(Boolean) : [];
  const lien = vue.champs.find((c) => c.type === "lien");
  if (!liste.length) {
    const champs = vue.parDefaut.map((n) => vue.champs.find((c) => c.nom === n)!).filter(Boolean);
    return { champs: lien && !champs.includes(lien) ? [...champs, lien] : champs };
  }
  const champs: ChampVue[] = [];
  const inconnus: string[] = [];
  for (const n of liste) {
    const c = trouverChamp(vue, n);
    if (c) { if (!champs.includes(c)) champs.push(c); } else inconnus.push(n);
  }
  if (inconnus.length) return { erreur: `champ(s) inconnu(s) : ${inconnus.join(", ")} ; champs de ${vue.nom} : ${vue.champs.map((c) => c.nom).join(", ")}` };
  // Le lien d'écran suit toujours : la réponse reste cliquable sans consigne.
  if (lien && !champs.includes(lien)) champs.push(lien);
  return { champs };
}

// ─── Le schéma exposé au modèle ─────────────────────────────────────────────────────────────

const decrireChamp = (c: ChampVue): string => {
  const origine = "regle" in c.source ? `, calculé par la règle de l'ERP « ${c.source.regle} »` : "";
  const valeurs = c.valeurs ? ` ; valeurs : ${permises(c)}` : "";
  return `${c.nom} (${c.type}${origine}) — ${c.description}${valeurs}`;
};

/**
 * Le schéma COURT d'une vue — ce qui part à CHAQUE étape (budget de jetons fixes, J4) : les noms des champs, les valeurs
 * des choix, les champs calculés marqués « * ». Le schéma long (`schemaDeVue`) revient à la première erreur de filtre.
 */
export function schemaCourt(vue: DeclarationVue): string {
  const c = (x: ChampVue) => `${x.nom}${"regle" in x.source ? "*" : ""}${x.valeurs ? `[${Object.keys(x.valeurs).join("|")}]` : ""}`;
  return `${vue.nom}(${vue.champs.filter((x) => x.type !== "lien" && x.nom !== "id").map(c).join(", ")})`;
}

/** Le schéma d'une vue, en clair : ce que le modèle lit pour formuler son filtre. */
export function schemaDeVue(vue: DeclarationVue): string {
  return `VUE ${vue.nom} — ${vue.description} Écran : ${vue.ecran}. Champs : ${vue.champs.map(decrireChamp).join(" ; ")}.`;
}

// ─── La déclaration elle-même : ce qui ne se déclare pas ───────────────────────────────────

/** Les mots d'une donnée du COFFRE (rémunération, coordonnée bancaire, pièce d'identité) : aucun champ ne les porte. */
const MOTS_DU_COFFRE = /(salaire|salary|remunerat|paie|payroll|brut|net_?a_?payer|nettopay|cout_?employeur|employercost|iban|rib\b|^rib|bancaire|nationalid|\bnin\b|^nin$|passeport|passport|cnas)/i;

/**
 * Les problèmes d'une déclaration — vide si elle est saine. `estSensible(modele, champ)` est la règle du COFFRE
 * (`champSensible` du module coffre) : une colonne copiée au coffre ne se déclare jamais, ni par sa source, ni par son nom.
 */
export function problemesDeDeclaration(vue: DeclarationVue, estSensible: (modele: string, champ: string) => boolean): string[] {
  const p: string[] = [];
  if (!vue.champs.length) p.push(`${vue.nom} : aucun champ`);
  if (!vue.droit.trim()) p.push(`${vue.nom} : le droit qui l'ouvre n'est pas dit`);
  if (!vue.ecran.startsWith("/")) p.push(`${vue.nom} : l'écran n'est pas un lien de l'ERP`);
  const noms = new Set<string>();
  for (const c of vue.champs) {
    if (noms.has(c.nom)) p.push(`${vue.nom}.${c.nom} : champ en double`);
    noms.add(c.nom);
    if ("modele" in c.source && estSensible(c.source.modele, c.source.champ)) p.push(`${vue.nom}.${c.nom} : colonne du coffre (${c.source.modele}.${c.source.champ})`);
    const source = "modele" in c.source ? c.source.champ : "";
    if (MOTS_DU_COFFRE.test(c.nom) || MOTS_DU_COFFRE.test(source)) p.push(`${vue.nom}.${c.nom} : donnée du coffre`);
    if ((c.type === "choix") !== Boolean(c.valeurs) && c.type !== "liste") p.push(`${vue.nom}.${c.nom} : un choix déclare ses valeurs`);
  }
  for (const d of vue.parDefaut) if (!noms.has(d)) p.push(`${vue.nom} : champ par défaut inconnu ${d}`);
  return p;
}
