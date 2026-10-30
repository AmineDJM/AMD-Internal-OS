/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARABE ET LE LATIN D'UN MÊME NOM (J9, décision 0021) — règle PURE.
 *
 * « محمد بن علي », « Mohamed Benali », « Mohammed Ben Ali » et « Med Benaly » désignent la même personne ; « مجمع صيدال »
 * et « Groupe Saidal » la même société. Deux outils, du plus fin au plus grossier :
 *
 *   1. LA TRANSLITTÉRATION : un mot arabe devient sa graphie latine d'usage en Algérie — par un LEXIQUE des prénoms et
 *      mots courants (محمد → mohamed), sinon lettre à lettre (ج → dj, ش → ch, ق → k, و → w en tête / ou ailleurs).
 *      Le résultat passe ensuite par les mêmes règles qu'un nom latin (`motsDuNom`, `motPhonetique` des référentiels).
 *   2. LE SQUELETTE CONSONANTIQUE : l'arabe n'écrit pas les voyelles brèves, le latin les écrit chacun à sa façon.
 *      On ne garde que les consonnes, normalisées (ch/sh → c, dj → j, kh → k, q → k, p → b…), la consonne d'attaque
 *      w/y gardée, l'article « el/al » de tête retiré. « Mohamed » et « محمد » donnent « mhmd ».
 *
 * Un squelette RAPPROCHE, il n'identifie pas : « Amine » et « Amina » ont le même. Il sert à trouver les candidats et à
 * relier les écritures ; la décision se prend sur l'ensemble des preuves (`resolution.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ARABE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const HARAKAT = /[ً-ٰٟۖ-ۭـ]/g;

export const contientArabe = (s: string | null | undefined): boolean => ARABE.test(s ?? "");

/** Les prénoms et mots courants : leur graphie latine d'usage (la plus fréquente à l'état civil algérien). */
const LEXIQUE: Record<string, string> = {
  "محمد": "mohamed", "أحمد": "ahmed", "احمد": "ahmed", "علي": "ali", "عمر": "omar", "عثمان": "othmane", "خالد": "khaled",
  "كريم": "karim", "كريمة": "karima", "سعيد": "said", "سعاد": "souad", "يوسف": "youcef", "مصطفى": "mustapha", "إبراهيم": "brahim",
  "ابراهيم": "brahim", "إسماعيل": "ismail", "اسماعيل": "ismail", "ياسين": "yacine", "حسين": "hocine", "حسن": "hassen",
  "رشيد": "rachid", "سليم": "salim", "سليمة": "salima", "فاطمة": "fatima", "عائشة": "aicha", "خديجة": "khadidja", "مريم": "meriem",
  "أمينة": "amina", "امينة": "amina", "أمين": "amine", "امين": "amine", "نادية": "nadia", "سميرة": "samira", "ليلى": "leila",
  "وهيبة": "ouahiba", "جمال": "djamel", "نور": "nour", "الهدى": "elhouda", "الزهراء": "ezzohra", "زهرة": "zohra", "نسيمة": "nassima",
  "رياض": "riad", "فريد": "farid", "مراد": "mourad", "نبيل": "nabil", "هشام": "hichem", "وليد": "walid", "صالح": "salah",
  "عبد": "abd", "بن": "ben", "ابن": "ben", "بنت": "bent", "بو": "bou", "آيت": "ait", "ايت": "ait", "أولاد": "ouled", "ولد": "ould",
  "القادر": "elkader", "الرحمن": "errahmane", "الله": "allah", "الحميد": "elhamid", "العزيز": "elaziz", "الكريم": "elkarim",
  // Les mots des organisations — ils se traduisent, ils ne se translittèrent pas.
  "شركة": "societe", "مجمع": "groupe", "مؤسسة": "entreprise", "مستشفى": "hopital", "المستشفى": "hopital", "الجامعي": "universitaire",
  "مخبر": "laboratoire", "مخابر": "laboratoires", "صيدلية": "pharmacie", "الوطنية": "nationale", "الوطني": "national",
  "مركز": "centre", "عيادة": "clinique", "الصيدلانية": "pharmaceutique", "للأدوية": "medicaments", "الأدوية": "medicaments",
  "وزارة": "ministere", "فارما": "pharma", "مطبعة": "imprimerie", "الصحة": "sante", "الجزائر": "algerie",
};

/** Lettre à lettre, quand le mot n'est pas au lexique. `و` et `ي` : consonnes en tête, voyelles ailleurs. */
const LETTRES: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a", "ب": "b", "ت": "t", "ث": "t", "ج": "dj", "ح": "h", "خ": "kh", "د": "d", "ذ": "d",
  "ر": "r", "ز": "z", "س": "s", "ش": "ch", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "k", "ك": "k",
  "ل": "l", "م": "m", "ن": "n", "ه": "h", "ى": "a", "ة": "a", "ء": "", "ئ": "", "ؤ": "", "ڤ": "v", "ڨ": "g", "پ": "p", "گ": "g",
};

const CHIFFRES_ARABES: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };

function motArabe(mot: string): string {
  const m = mot.replace(HARAKAT, "");
  if (!m) return "";
  if (LEXIQUE[m]) return LEXIQUE[m]!;
  // L'article collé à un mot du lexique : « الزهراء » est au lexique, « السعيد » se lit al + سعيد.
  if (m.startsWith("ال") && LEXIQUE[m.slice(2)]) return `el${LEXIQUE[m.slice(2)]}`;
  let out = "";
  [...m].forEach((c, i) => {
    if (c === "و") out += i === 0 ? "w" : "ou";
    else if (c === "ي") out += i === 0 ? "y" : "i";
    else out += LETTRES[c] ?? CHIFFRES_ARABES[c] ?? (/[a-z0-9]/i.test(c) ? c : "");
  });
  return out;
}

/**
 * LA GRAPHIE LATINE d'un texte qui contient de l'arabe (le latin, lui, passe tel quel). « محمد بن علي » → « mohamed ben ali ».
 * NFKC d'abord : les formes de présentation (ﻣﺤﻤﺪ, copiées d'un PDF) redeviennent des lettres.
 */
export function translitterer(texte: string | null | undefined): string {
  const t = (texte ?? "").normalize("NFKC");
  if (!contientArabe(t)) return t;
  return t.split(/\s+/).map((mot) => (contientArabe(mot) ? motArabe(mot) : mot)).filter(Boolean).join(" ");
}

const SOLAIRES = new Set(["t", "d", "r", "z", "s", "c", "n", "l"]);

/**
 * LE SQUELETTE CONSONANTIQUE d'un mot LATIN (déjà plié). Vide si le mot n'a pas de consonne.
 * Exemples : mohamed → mhmd ; benali → bnl ; abdelkader → bdlkdr ; abderrahmane → bdrhmn ; ouahiba → whb ; youcef → ysf.
 */
export function squelette(motLatin: string): string {
  let s = motLatin.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
  if (!s) return "";
  if (s.length > 4) s = s.replace(/^(el|al|ez|es|er|et|ed|en)(?=[^aeiou])/, (_, art: string) => (art === "el" || art === "al" ? "" : art.slice(1)));
  s = s
    .replace(/tch|sch|sh|ch/g, "C")
    .replace(/dj/g, "j").replace(/kh/g, "k").replace(/gh/g, "g").replace(/ph/g, "f").replace(/th/g, "t").replace(/dh/g, "d")
    .replace(/^ou(?=[aeiy])/, "w")
    .replace(/ck|q/g, "k").replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/C/g, "c")
    .replace(/x/g, "ks").replace(/p/g, "b").replace(/v/g, "f");
  const tete = /^[wy]/.test(s) ? s[0] : "";
  let corps = (tete ? s.slice(1) : s).replace(/[aeiouyw]/g, "");
  // « Abd el-Rahmane » s'écrit « Abderrahmane » : l'article s'assimile devant une lettre solaire.
  corps = corps.replace(/^(bd)l(?=(.))/, (m, bd: string, suite: string) => (SOLAIRES.has(suite) ? bd : m));
  return (tete + corps).replace(/([a-z])\1+/g, "$1");
}
