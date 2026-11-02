/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTILLAGE COMMUN DES EXTRACTEURS « PERSONNES » — passeport, CNI, CV, carte de visite.
 *
 * Module pur : il ne lit que le texte qu'on lui donne. Il fabrique des `FaitExtrait` conformes au
 * catalogue (un attribut inconnu est une erreur de programmation, pas une donnée), borne les valeurs
 * et les extraits de preuve, et normalise ce qui doit se comparer : dates ISO, téléphones E.164
 * (+213 par défaut), pays ISO-3166 alpha-3, e-mails en minuscules.
 *
 * Une normalisation qui échoue rend `null` : l'appelant n'invente rien, il le DIT dans ses notes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { ATTRIBUT_PAR_CLE, type FaitExtrait, type RoleSujet, type TypeSujet } from "../types";

/** Ce que reçoit un extracteur : le texte lu (OCR local ou couche texte) et, s'il est connu, le nom du fichier. */
export interface EntreeExtraction {
  texte: string;
  nomFichier?: string | null;
}

export const LONGUEUR_MAX_VALEUR = 200;
export const LONGUEUR_MAX_EXTRAIT = 120;

export const borner = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

export const sansAccents = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Pour comparer un texte libre : minuscules, sans accents, espaces resserrés. */
export const normaliserTexte = (s: string): string =>
  sansAccents(s).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

/** La page (1, 2…) d'une position (un saut de page À cette position compte : la ligne qui le porte ouvre la page) dans un texte dont les pages sont séparées par un saut de page (\f). */
export function pageDe(texte: string, index: number): number | null {
  if (index < 0) return null;
  let page = 1;
  for (let i = 0; i <= index && i < texte.length; i++) if (texte[i] === "\f") page++;
  return page;
}

export interface FaitBrut {
  sujetRef: string;
  sujetType: TypeSujet;
  role: RoleSujet;
  attribut: string;
  valeur: string;
  valeurNormalisee: string;
  confiance: number;
  page: number | null;
  extrait: string;
}

/** Le seul constructeur de fait : catalogue vérifié, `sensible` recopié, bornes appliquées. */
export function fait(f: FaitBrut): FaitExtrait {
  const attribut = ATTRIBUT_PAR_CLE.get(f.attribut);
  if (!attribut) throw new Error(`Attribut hors catalogue : ${f.attribut}`);
  if (attribut.sujet !== f.sujetType) throw new Error(`Attribut ${f.attribut} proposé pour un sujet ${f.sujetType}`);
  return {
    sujetRef: f.sujetRef,
    sujetType: f.sujetType,
    role: f.role,
    attribut: f.attribut,
    valeur: borner(f.valeur, LONGUEUR_MAX_VALEUR),
    valeurNormalisee: borner(f.valeurNormalisee, LONGUEUR_MAX_VALEUR),
    confiance: Math.round(Math.min(1, Math.max(0, f.confiance)) * 100) / 100,
    preuve: { page: f.page, extrait: borner(f.extrait, LONGUEUR_MAX_EXTRAIT) },
    sensible: attribut.sensible,
  };
}

/** Un même attribut, une même valeur normalisée, un même sujet : on garde la lecture la plus sûre. */
export function dedoublonner(faits: FaitExtrait[]): FaitExtrait[] {
  const vus = new Map<string, number>();
  const sortie: FaitExtrait[] = [];
  for (const f of faits) {
    const cle = `${f.sujetRef}|${f.attribut}|${f.valeurNormalisee}`;
    const i = vus.get(cle);
    if (i === undefined) {
      vus.set(cle, sortie.length);
      sortie.push(f);
    } else if (f.confiance > sortie[i]!.confiance) sortie[i] = f;
  }
  return sortie;
}

// ─── Dates ────────────────────────────────────────────────────────────────────────────────

const MOIS: Record<string, number> = {
  janvier: 1, janv: 1, january: 1, jan: 1,
  fevrier: 2, fevr: 2, fev: 2, february: 2, feb: 2,
  mars: 3, march: 3, mar: 3,
  avril: 4, avr: 4, april: 4, apr: 4,
  mai: 5, may: 5,
  juin: 6, june: 6, jun: 6,
  juillet: 7, juil: 7, july: 7, jul: 7,
  aout: 8, august: 8, aug: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  decembre: 12, dec: 12, december: 12,
};

export function dateIso(annee: number, mois: number, jour: number): string | null {
  if (annee < 1900 || annee > 2100 || mois < 1 || mois > 12 || jour < 1) return null;
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  if (d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null;
  return `${annee}-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`;
}

/** Motif d'une date complète, pour la REPÉRER dans un texte (la normalisation suit avec `normaliserDate`). */
export const MOTIF_DATE =
  /\b(?:\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}-\d{2}-\d{2}|(?:1er|\d{1,2})\s+[A-Za-zÀ-ÿ]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/;

/** « 12/03/1985 », « 1985-03-12 », « 12 mars 1985 », « 1er avril 1990 », « March 12, 1985 » → ISO ; sinon `null`. */
export function normaliserDate(s: string): string | null {
  const t = sansAccents(s).toLowerCase().trim();
  let m = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (m) return dateIso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return dateIso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(1er|\d{1,2})\s+([a-z]+)\.?\s+(\d{4})$/);
  if (m && MOIS[m[2]!]) return dateIso(Number(m[3]), MOIS[m[2]!]!, m[1] === "1er" ? 1 : Number(m[1]));
  m = t.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MOIS[m[1]!]) return dateIso(Number(m[3]), MOIS[m[1]!]!, Number(m[2]));
  return null;
}

// ─── Téléphones ───────────────────────────────────────────────────────────────────────────

/** Repère les suites qui ressemblent à un numéro (la normalisation tranche ensuite). */
export const MOTIF_TELEPHONE = /(?:\+|\b00)?\(?\d[\d\s.\-()]{6,}\d/g;

/**
 * Un numéro lu → E.164. Sans indicatif, c'est un numéro algérien : mobile 05/06/07 + 8 chiffres,
 * fixe 02/03/04 + 7 chiffres. Un indicatif étranger est gardé tel quel (8 à 15 chiffres).
 * Ce qui ne colle à aucune forme rend `null` (une plage d'années, un code postal…).
 */
export function normaliserTelephone(s: string): string | null {
  const brut = s.trim();
  const international = /^(\+|00)/.test(brut);
  let chiffres = brut.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (international) {
    if (brut.startsWith("00")) chiffres = chiffres.slice(2);
    if (chiffres.startsWith("213")) return numeroAlgerien(chiffres.slice(3).replace(/^0/, ""));
    return chiffres.length >= 8 && chiffres.length <= 15 ? `+${chiffres}` : null;
  }
  if (!chiffres.startsWith("0")) return null;
  return numeroAlgerien(chiffres.slice(1));
}

function numeroAlgerien(national: string): string | null {
  if (/^[567]\d{8}$/.test(national) || /^[234]\d{7}$/.test(national)) return `+213${national}`;
  return null;
}

export interface TelephoneLu {
  brut: string;
  e164: string;
  /** Position dans la chaîne fouillée. */
  index: number;
}

/**
 * Les numéros d'une ligne. Deux numéros collés (« 0550 12 34 56 - 0661 22 33 44 ») forment une seule
 * suite que la normalisation refuse : on la recoupe alors sur ses séparateurs.
 */
export function trouverTelephones(ligne: string): TelephoneLu[] {
  const sortie: TelephoneLu[] = [];
  for (const m of ligne.matchAll(MOTIF_TELEPHONE)) {
    const brut = m[0].trim();
    const e164 = normaliserTelephone(brut);
    if (e164) {
      sortie.push({ brut, e164, index: m.index ?? 0 });
      continue;
    }
    let decalage = 0;
    for (const morceau of brut.split(/(\s[-–|]\s|\s{2,})/)) {
      const n = /\d/.test(morceau) ? normaliserTelephone(morceau) : null;
      if (n) sortie.push({ brut: morceau.trim(), e164: n, index: (m.index ?? 0) + decalage });
      decalage += morceau.length;
    }
  }
  return sortie;
}

export const estMobileAlgerien = (e164: string): boolean => /^\+213[567]\d{8}$/.test(e164);

// ─── E-mails, sites ───────────────────────────────────────────────────────────────────────

export const MOTIF_EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

export const normaliserEmail = (s: string): string => s.trim().replace(/\.$/, "").toLowerCase();

/** Les boîtes d'un service, pas d'une personne. */
export const estEmailGenerique = (email: string): boolean =>
  /^(contact|info|infos|commercial|commandes?|sales|admin|accueil|direction|support|secretariat|rh|hr|office|marketing|service|export|achats?)[@.]/.test(
    email.toLowerCase(),
  );

const MESSAGERIES_PUBLIQUES = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton(mail)?|gmx|laposte|orange|free|wanadoo)\./;
export const estMessageriePublique = (email: string): boolean => MESSAGERIES_PUBLIQUES.test(email.split("@")[1] ?? "");

export const MOTIF_SITE = /\b(?:https?:\/\/)?(?:www\.)[a-z0-9\-]+(?:\.[a-z0-9\-]+)+(?:\/[^\s]*)?|\bhttps?:\/\/[a-z0-9\-]+(?:\.[a-z0-9\-]+)+(?:\/[^\s]*)?/gi;

/** « WWW.Exemple.DZ/ » → « exemple.dz » : l'hôte sans « www. » ni schéma, pour comparer. */
export function normaliserSite(s: string): string {
  return s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.,;]+$/, "");
}

// ─── Pays (ISO-3166 alpha-3) ──────────────────────────────────────────────────────────────

/** Noms, gentilés (FR/EN, m./f.) → alpha-3. Clés normalisées (sans accents, minuscules). */
const PAYS: Record<string, string> = {};
const declarer = (code: string, ...noms: string[]) => noms.forEach((n) => (PAYS[normaliserTexte(n)] = code));
declarer("DZA", "Algérie", "Algeria", "algérien", "algérienne", "algerian", "DZ");
declarer("FRA", "France", "français", "française", "french");
declarer("TUN", "Tunisie", "Tunisia", "tunisien", "tunisienne", "tunisian");
declarer("MAR", "Maroc", "Morocco", "marocain", "marocaine", "moroccan");
declarer("LBY", "Libye", "Libya", "libyen", "libyenne", "libyan");
declarer("EGY", "Égypte", "Egypt", "égyptien", "égyptienne", "egyptian");
declarer("MRT", "Mauritanie", "Mauritania", "mauritanien", "mauritanienne", "mauritanian");
declarer("ESP", "Espagne", "Spain", "espagnol", "espagnole", "spanish");
declarer("ITA", "Italie", "Italy", "italien", "italienne", "italian");
declarer("DEU", "Allemagne", "Germany", "allemand", "allemande", "german");
declarer("BEL", "Belgique", "Belgium", "belge", "belgian");
declarer("CHE", "Suisse", "Switzerland", "swiss");
declarer("PRT", "Portugal", "portugais", "portugaise", "portuguese");
declarer("NLD", "Pays-Bas", "Netherlands", "néerlandais", "néerlandaise", "dutch");
declarer("GBR", "Royaume-Uni", "United Kingdom", "UK", "britannique", "british");
declarer("USA", "États-Unis", "United States", "USA", "américain", "américaine", "american");
declarer("CAN", "Canada", "canadien", "canadienne", "canadian");
declarer("TUR", "Turquie", "Turkey", "Türkiye", "turc", "turque", "turkish");
declarer("CHN", "Chine", "China", "chinois", "chinoise", "chinese");
declarer("IND", "Inde", "India", "indien", "indienne", "indian");
declarer("JOR", "Jordanie", "Jordan", "jordanien", "jordanienne", "jordanian");
declarer("LBN", "Liban", "Lebanon", "libanais", "libanaise", "lebanese");
declarer("SYR", "Syrie", "Syria", "syrien", "syrienne", "syrian");
declarer("SAU", "Arabie saoudite", "Saudi Arabia", "saoudien", "saoudienne", "saudi");
declarer("ARE", "Émirats arabes unis", "United Arab Emirates", "UAE", "émirien", "émirienne", "emirati");
declarer("QAT", "Qatar", "qatari", "qatarien", "qatarienne");
declarer("SEN", "Sénégal", "Senegal", "sénégalais", "sénégalaise", "senegalese");
declarer("MLI", "Mali", "malien", "malienne", "malian");
declarer("NER", "Niger", "nigérien", "nigérienne", "nigerien");
declarer("CIV", "Côte d'Ivoire", "Ivory Coast", "ivoirien", "ivoirienne", "ivorian");
declarer("RUS", "Russie", "Russia", "russe", "russian");
declarer("KOR", "Corée du Sud", "South Korea", "coréen", "coréenne", "korean");
declarer("JPN", "Japon", "Japan", "japonais", "japonaise", "japanese");

/** Un nom de pays ou un gentilé (FR/EN) → alpha-3 ; sinon `null`. */
export function paysIso3(s: string): string | null {
  return PAYS[normaliserTexte(s).replace(/[.,;]+$/, "")] ?? null;
}

/**
 * Un code de MRZ → alpha-3. La 9303 suit l'ISO-3166 alpha-3, à une exception près : « D » pour
 * l'Allemagne. Les codes des organisations et spécimens (« UNO », « UTO ») sont rendus tels quels.
 */
export function paysMrz(code: string): string | null {
  const c = code.replace(/</g, "");
  if (c === "D") return "DEU";
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// ─── Champs étiquetés ─────────────────────────────────────────────────────────────────────

export interface ChampLu {
  valeur: string;
  index: number;
  ligne: string;
}

/**
 * La valeur qui suit une étiquette (« Lieu de naissance : Oran », ou la ligne d'après si l'étiquette est
 * seule sur la sienne). Les étiquettes bilingues sont tolérées (« Lieu de naissance / Place of birth »).
 */
export function champEtiquete(texte: string, etiquettes: RegExp): ChampLu | null {
  const lignes = texte.split("\n");
  let offset = 0;
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i]!;
    const m = ligne.match(etiquettes);
    if (m && m.index !== undefined) {
      const valeur = nettoyerValeur(ligne.slice(m.index + m[0].length));
      if (valeur && /[\p{L}\d]/u.test(valeur)) return { valeur, index: offset + m.index, ligne };
      const suivante = lignes.slice(i + 1).find((l) => l.trim());
      if (suivante) return { valeur: nettoyerValeur(suivante.trim()), index: offset + ligne.length + 1, ligne: `${ligne.trim()} ${suivante.trim()}` };
    }
    offset += ligne.length + 1;
  }
  return null;
}

/** Retire ce qu'un OCR colle souvent à une valeur : texte arabe, barres, deux-points en tête. */
const nettoyerValeur = (v: string): string =>
  v.replace(/[\u0600-\u06FF]+/g, " ").replace(/^[\s:/.\-–]+|[\s:/.\-–]+$/g, "").replace(/\s+/g, " ").trim();

// ─── Personnes : civilité, nom, fonction ─────────────────────────────────────────────────

/** Civilité en tête de nom → forme de la fiche. */
const CIVILITES: [RegExp, string][] = [
  [/^(dr|docteur|doctor)\.?\s+/i, "Dr"],
  [/^(pr|professeur|prof|professor)\.?\s+/i, "Pr"],
  [/^(mme|madame|mrs|ms)\.?\s+/i, "Mme"],
  [/^(mlle|mademoiselle|miss)\.?\s+/i, "Mlle"],
  [/^(m\.|monsieur|mr\.?)\s+/i, "M."],
];

export function separerCivilite(s: string): { civilite: string | null; reste: string } {
  const t = s.trim();
  for (const [motif, civilite] of CIVILITES) if (motif.test(t)) return { civilite, reste: t.replace(motif, "").trim() };
  return { civilite: null, reste: t };
}

const MOT_NOM = /^[\p{Lu}][\p{L}'’\-]*$|^[\p{Lu}]{1,2}\.$/u;

/** Une ligne qui a la forme d'un nom de personne : 2 à 4 mots, lettres seules, chacun en majuscule initiale. */
export function aFormeDeNom(ligne: string): boolean {
  const { reste } = separerCivilite(ligne);
  const mots = reste.split(/\s+/).filter(Boolean);
  return mots.length >= 2 && mots.length <= 4 && mots.every((m) => MOT_NOM.test(m)) && !/\d|@/.test(reste);
}

/**
 * « BENALI Mohamed Amine » / « Mohamed Amine BENALI » → nom et prénoms, par la casse : le mot (ou les mots
 * contigus) tout en capitales est le nom. Sans cet indice, l'adresse e-mail peut trancher
 * (« m.benali@… », « mohamed.benali@… » : la dernière partie est le nom). Sinon `null` — on ne devine pas.
 */
export function decouperNom(complet: string, email?: string | null): { nom: string; prenoms: string } | null {
  const mots = complet.split(/\s+/).filter(Boolean);
  if (mots.length < 2) return null;
  const capitales = mots.map((m) => m.length > 1 && m === m.toUpperCase() && /\p{Lu}/u.test(m));
  const nb = capitales.filter(Boolean).length;
  if (nb > 0 && nb < mots.length) {
    const premier = capitales.indexOf(true);
    const dernier = capitales.lastIndexOf(true);
    const contigus = capitales.slice(premier, dernier + 1).every(Boolean);
    if (contigus && (premier === 0 || dernier === mots.length - 1)) {
      return { nom: mots.slice(premier, dernier + 1).join(" "), prenoms: mots.filter((_, i) => i < premier || i > dernier).join(" ") };
    }
  }
  const local = email?.split("@")[0];
  if (local) {
    const parties = local.toLowerCase().split(/[._\-]/).filter(Boolean);
    const derniere = parties[parties.length - 1];
    const cles = mots.map((m) => normaliserTexte(m).replace(/[^a-z]/g, ""));
    const i = derniere ? cles.indexOf(derniere) : -1;
    if (parties.length >= 2 && i >= 0) {
      return { nom: mots[i]!, prenoms: mots.filter((_, j) => j !== i).join(" ") };
    }
  }
  return null;
}

/** Les mots d'un intitulé de poste (FR/EN, masculin et féminin). */
export const MOTIF_FONCTION =
  /(?<!\p{L})(directeur|directrice|director|dg|pdg|ceo|cfo|coo|cto|g[ée]rante?|pr[ée]sidente?|president|responsable|chef|cheffe|head|manager|managing|d[ée]l[ée]gu[ée]e?|repr[ée]sentante?|representative|pharmacien(ne)?|pharmacist|m[ée]decin|physician|chirurgien(ne)?|professeur|professor|ma[îi]tre[- ]assistante?|ing[ée]nieure?|engineer|technicien(ne)?|technician|commerciale?|charg[ée]e?|attach[ée]e?|assistante?|coordinat(eur|rice)|coordinator|superviseur|supervisor|consultante?|comptable|accountant|analyste|analyst|gestionnaire|officer|specialist|sp[ée]cialiste|key account|sales|marketing|fondat(eur|rice)|founder|secr[ée]taire|secretary|juriste|avocate?|lawyer)(?!\p{L})/iu;
