/**
 * LIEUX — UN TEXTE LIBRE DEVIENT UN CODE DE WILAYA (et, sans ambiguïté, une commune).
 *
 * Les fiches portent la wilaya comme on l'a tapée : « ALGER », « Algiers », « الجزائر », « W.16 », « 16 - Alger »,
 * « 09000 Blida », « Bou Saada ». Ce module rend le CODE officiel (« 16 ») — la clé de la table `Wilaya` chargée par
 * la migration `20270130110000_lieux_reference` — ou `null` AVEC LA RAISON. Il ne devine jamais : une wilaya fausse
 * entre dans les comptages sans que personne ne la revérifie, une wilaya vide se voit.
 *
 * ── LE DÉCOUPAGE EN VIGUEUR ──────────────────────────────────────────────────────────────────────────────────────
 * 69 wilayas : loi n° 26-06 du 4 avril 2026 (JO n° 25), numéros 59 à 69 fixés par le décret présidentiel n° 26-206
 * du 25 mai 2026 (JO n° 40). Les onze nouvelles entrent en fonction le 1er janvier 2027 et ont chacune une wilaya
 * MÈRE. L'option `decoupage: "58"` ramène une nouvelle wilaya à sa mère — pour comparer avec des données saisies
 * sous l'ancien découpage ou avec les listes de l'application qui n'en connaissent que 58.
 *
 * ── CE QUI EST RECONNU ───────────────────────────────────────────────────────────────────────────────────────────
 *   1. le NOM, casse / accents / tirets / apostrophes indifférents, latin ou arabe (formes de présentation, harakat,
 *      alif hamza, tâ marbûta repliés) ;
 *   2. quelques VARIANTES réellement rencontrées (Algiers, El Djazaïr, Bougie, El Asnam, BBA, Ain Oussera…) ;
 *   3. le NUMÉRO seul ou préfixé (« 16 », « W.16 », « Wilaya n° 16 », « ولاية 16 », chiffres arabes) ;
 *   4. le CODE POSTAL à cinq chiffres (ses deux premiers chiffres = l'ancienne wilaya, cf. `prudence`).
 * Un texte qui nomme DEUX wilayas, ou dont le numéro contredit le nom, rend `null` — sauf le cas « commune nouvelle
 * + sa wilaya mère » (« Bou Saâda, M'Sila »), qui est la même chose écrite sous deux découpages.
 *
 * Les graphies arabes ci-dessous servent à RECONNAÎTRE une saisie ; elles ne sont pas la référence (la colonne
 * `Wilaya.nomAr` ne porte que ce qu'un texte officiel lisible donne).
 *
 * Module PUR : aucun import, ni base ni réseau — utilisable côté client comme côté serveur.
 */

export type CodeWilaya = string;

export interface WilayaRef {
  code: CodeWilaya;
  nom: string;
  /** La wilaya dont elle a été détachée en 2026 (59 à 69), sinon `null`. */
  mere: CodeWilaya | null;
}

/** Les 69 wilayas, dans l'ordre des codes (graphies de l'application, et du décret 26-206 pour 59 à 69). */
export const WILAYAS_69: readonly WilayaRef[] = [
  ["01", "Adrar"], ["02", "Chlef"], ["03", "Laghouat"], ["04", "Oum El Bouaghi"], ["05", "Batna"],
  ["06", "Béjaïa"], ["07", "Biskra"], ["08", "Béchar"], ["09", "Blida"], ["10", "Bouira"],
  ["11", "Tamanrasset"], ["12", "Tébessa"], ["13", "Tlemcen"], ["14", "Tiaret"], ["15", "Tizi Ouzou"],
  ["16", "Alger"], ["17", "Djelfa"], ["18", "Jijel"], ["19", "Sétif"], ["20", "Saïda"],
  ["21", "Skikda"], ["22", "Sidi Bel Abbès"], ["23", "Annaba"], ["24", "Guelma"], ["25", "Constantine"],
  ["26", "Médéa"], ["27", "Mostaganem"], ["28", "M'Sila"], ["29", "Mascara"], ["30", "Ouargla"],
  ["31", "Oran"], ["32", "El Bayadh"], ["33", "Illizi"], ["34", "Bordj Bou Arréridj"], ["35", "Boumerdès"],
  ["36", "El Tarf"], ["37", "Tindouf"], ["38", "Tissemsilt"], ["39", "El Oued"], ["40", "Khenchela"],
  ["41", "Souk Ahras"], ["42", "Tipaza"], ["43", "Mila"], ["44", "Aïn Defla"], ["45", "Naâma"],
  ["46", "Aïn Témouchent"], ["47", "Ghardaïa"], ["48", "Relizane"], ["49", "Timimoun"], ["50", "Bordj Badji Mokhtar"],
  ["51", "Ouled Djellal"], ["52", "Béni Abbès"], ["53", "In Salah"], ["54", "In Guezzam"], ["55", "Touggourt"],
  ["56", "Djanet"], ["57", "El M'Ghair"], ["58", "El Meniaa"],
  ["59", "Aflou", "03"], ["60", "Barika", "05"], ["61", "El Kantara", "07"], ["62", "Bir El Ater", "12"],
  ["63", "El Aricha", "13"], ["64", "Ksar Chellala", "14"], ["65", "Aïn Ouessara", "17"], ["66", "Messaad", "17"],
  ["67", "Ksar El Boukhari", "26"], ["68", "Bou Saâda", "28"], ["69", "El Abiodh Sidi Cheikh", "32"],
].map(([code, nom, mere]) => ({ code: code!, nom: nom!, mere: mere ?? null }));

const PAR_CODE = new Map(WILAYAS_69.map((w) => [w.code, w]));

/** Variantes latines (déjà repliées) → code. Courte et réelle : ce qui manque se voit dans l'inventaire. */
const VARIANTES: Record<string, CodeWilaya> = {
  "algiers": "16", "el djazair": "16", "al djazair": "16", "el djazaier": "16", "dzayer": "16", "alger centre": "16",
  "wahran": "31", "ksentina": "25", "qacentina": "25",
  "bone": "23", "bougie": "06", "bgayet": "06", "vgayet": "06", "el asnam": "02", "orleansville": "02",
  "philippeville": "21", "tamanghasset": "11", "tamenghest": "11", "oued souf": "39", "souf": "39",
  "bba": "34", "bordj bou arreridj": "34", "sba": "22", "sidi belabbes": "22", "bel abbes": "22",
  "tipasa": "42", "temouchent": "46", "oeb": "04", "m sila": "28", "khenchla": "40", "tbessa": "12",
  "ghilizane": "48", "djidjelli": "18", "mouaskar": "29", "warqla": "30",
  "el bayad": "32", "geryville": "32", "et tarf": "36", "el mghair": "57", "el mghaier": "57", "el meghaier": "57",
  "el menia": "58", "el menea": "58", "el golea": "58", "ain salah": "53", "ain guezzam": "54", "tuggurt": "55",
  "el qantara": "61", "bir el atir": "62", "ksar chellala": "64", "ksar challala": "64",
  "ain oussera": "65", "ain oussara": "65", "ain ouessara": "65", "messad": "66", "boghari": "67",
  "ksar boukhari": "67", "bousaada": "68", "bou saada": "68", "el abiod sidi cheikh": "69",
  "abiodh sidi cheikh": "69", "el abiodh sidi chikh": "69",
};

/** Graphies arabes de reconnaissance (repliées par `replier`) → code. */
const ARABE: Record<string, CodeWilaya> = Object.fromEntries(
  ([
    ["01", "أدرار"], ["02", "الشلف"], ["03", "الأغواط"], ["04", "أم البواقي"], ["05", "باتنة"], ["06", "بجاية"],
    ["07", "بسكرة"], ["08", "بشار"], ["09", "البليدة"], ["10", "البويرة"], ["11", "تمنراست"], ["12", "تبسة"],
    ["13", "تلمسان"], ["14", "تيارت"], ["15", "تيزي وزو"], ["16", "الجزائر"], ["17", "الجلفة"], ["18", "جيجل"],
    ["19", "سطيف"], ["20", "سعيدة"], ["21", "سكيكدة"], ["22", "سيدي بلعباس"], ["23", "عنابة"], ["24", "قالمة"],
    ["25", "قسنطينة"], ["26", "المدية"], ["27", "مستغانم"], ["28", "المسيلة"], ["29", "معسكر"], ["30", "ورقلة"],
    ["31", "وهران"], ["32", "البيض"], ["33", "إليزي"], ["34", "برج بوعريريج"], ["35", "بومرداس"], ["36", "الطارف"],
    ["37", "تندوف"], ["38", "تيسمسيلت"], ["39", "الوادي"], ["40", "خنشلة"], ["41", "سوق أهراس"], ["42", "تيبازة"],
    ["43", "ميلة"], ["44", "عين الدفلى"], ["45", "النعامة"], ["46", "عين تموشنت"], ["47", "غرداية"], ["48", "غليزان"],
    ["49", "تيميمون"], ["50", "برج باجي مختار"], ["51", "أولاد جلال"], ["52", "بني عباس"], ["53", "عين صالح"],
    ["54", "عين قزام"], ["55", "تقرت"], ["56", "جانت"], ["57", "المغير"], ["58", "المنيعة"],
    // 59 à 69 : graphies du décret présidentiel n° 26-206 (JO n° 40 du 3 juin 2026, version arabe).
    ["59", "أفلو"], ["60", "بريكة"], ["61", "القنطرة"], ["62", "بئر العاتر"], ["63", "العريشة"],
    ["64", "قصر الشلالة"], ["65", "عين وسارة"], ["66", "مسعد"], ["67", "قصر البخاري"], ["68", "بوسعادة"],
    ["69", "الأبيض سيدي الشيخ"],
    ["16", "الجزائر العاصمة"], ["68", "بو سعادة"],
  ] as const).map(([code, ar]) => [replier(ar), code]),
);

/** Mots qui entourent un numéro ou un nom sans rien dire du lieu (« Wilaya de », « W. », « رقم »). */
const MOTS_VIDES = new Set<string>([
  "w", "wil", "wilaya", "wilayas", "willaya", "de", "d", "du", "des", "la", "le", "n", "no", "num", "numero", "nr",
  "code", "province", "ville", "city", "region", "dz", "algerie", "algeria", "dza",
  "ولاية", "الولاية", "رقم", "مدينة", "الجزائرية",
].map((m) => replier(m)));

/**
 * LA FORME COMPARABLE d'un texte, latin ou arabe : NFKC (formes de présentation arabes), chiffres arabes → ASCII,
 * accents et harakat retirés, alif hamza → alif, tâ marbûta → hâ, alif maqsûra → yâ, apostrophes collées
 * (« M'Sila » = « MSila »), lettres et chiffres séparés (« W16 »), tout le reste → espace.
 */
export function replier(brut: unknown): string {
  return String(brut ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ـ/g, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/['’`ʼ]/g, "")
    .replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, "$1$2 ")
    .replace(/[^a-z0-9ء-ي]+/g, " ")
    .trim();
}

type Via = "nom" | "variante" | "arabe" | "numero" | "code_postal";

/** Toutes les formes reconnaissables, de la plus longue à la plus courte (« Bordj Bou Arréridj » avant « Bordj »). */
const FORMES: { mots: string[]; code: CodeWilaya; via: Via }[] = [
  ...WILAYAS_69.map((w) => ({ forme: replier(w.nom), code: w.code, via: "nom" as Via })),
  ...Object.entries(VARIANTES).map(([forme, code]) => ({ forme, code, via: "variante" as Via })),
  ...Object.entries(ARABE).map(([forme, code]) => ({ forme, code, via: "arabe" as Via })),
]
  .map(({ forme, code, via }) => ({ mots: forme.split(" "), code, via }))
  .sort((a, b) => b.mots.length - a.mots.length || b.mots.join(" ").length - a.mots.join(" ").length);

export type RaisonRejet =
  | "vide"
  | "inconnu"
  | "numero_hors_liste"
  | "contradiction"
  | "plusieurs_wilayas";

export type ResultatWilaya =
  | {
      code: CodeWilaya;
      nom: string;
      via: Via;
      /** Wilaya mère pour 59 à 69 (nulle sinon). */
      mere: CodeWilaya | null;
      /** Code d'origine quand l'option `decoupage: "58"` a ramené une nouvelle wilaya à sa mère. */
      rameneDe?: CodeWilaya;
      /** Ce qu'il faut savoir avant de s'y fier (code postal d'une wilaya mère, nouvelle wilaya pas encore en fonction…). */
      prudence?: string;
    }
  | { code: null; raison: RaisonRejet; detail: string };

export interface OptionsWilaya {
  /** « 69 » (défaut) : le découpage de 2026. « 58 » : une nouvelle wilaya est ramenée à sa mère. */
  decoupage?: "69" | "58";
}

const MERES = new Set(WILAYAS_69.filter((w) => w.mere).map((w) => w.mere!));

function rejet(raison: RaisonRejet, detail: string): ResultatWilaya {
  return { code: null, raison, detail };
}

function nomDe(code: CodeWilaya): string {
  return PAR_CODE.get(code)!.nom;
}

function code2(n: number): CodeWilaya {
  return String(n).padStart(2, "0");
}

/**
 * LE CODE DE WILAYA d'un texte libre — ou `null` et la raison.
 *
 * Ordre de confiance : un nom (ou sa variante) prime ; un numéro ou un code postal présent à côté doit CONCORDER,
 * sinon c'est une contradiction et on ne tranche pas. Un numéro seul n'est lu que si rien d'autre n'est écrit
 * (« Cité 1000 logements » ne devient pas la wilaya 10).
 */
export function normaliserWilaya(brut: unknown, options: OptionsWilaya = {}): ResultatWilaya {
  const r = reconnaitre(brut);
  if (r.code === null || options.decoupage !== "58") return r;
  const w = PAR_CODE.get(r.code)!;
  if (!w.mere) return r;
  return { ...r, code: w.mere, nom: nomDe(w.mere), mere: null, rameneDe: w.code };
}

function reconnaitre(brut: unknown): ResultatWilaya {
  const texte = replier(brut);
  if (!texte) return rejet("vide", "Aucun texte.");
  const mots = texte.split(" ");

  // 1. Les noms, du plus long au plus court, sans chevauchement.
  const pris = new Array<boolean>(mots.length).fill(false);
  const trouves: { code: CodeWilaya; via: Via }[] = [];
  for (const f of FORMES) {
    for (let i = 0; i + f.mots.length <= mots.length; i++) {
      let ok = true;
      for (let k = 0; k < f.mots.length && ok; k++) ok = !pris[i + k] && mots[i + k] === f.mots[k];
      if (!ok) continue;
      for (let k = 0; k < f.mots.length; k++) pris[i + k] = true;
      trouves.push({ code: f.code, via: f.via });
    }
  }

  // 2. Ce qui reste : numéros et code postal.
  const reste = mots.filter((m, i) => !pris[i] && !MOTS_VIDES.has(m));
  const postaux = reste.filter((m) => /^\d{5}$/.test(m));
  const courts = reste.filter((m) => /^\d{1,2}$/.test(m));
  // Un numéro n'est un numéro de wilaya que s'il est SEUL avec les mots vides (« W.16 », « 16 - Alger »).
  const numero = reste.length === 1 && courts.length === 1 ? Number(courts[0]) : null;
  const postal = postaux.length === 1 ? postaux[0] : null;

  const codes = [...new Set(trouves.map((t) => t.code))];

  if (codes.length > 1) {
    // « Bou Saâda, M'Sila » : la commune devenue wilaya, écrite avec sa wilaya mère — même lieu, deux découpages.
    if (codes.length === 2) {
      const [a, b] = codes.map((c) => PAR_CODE.get(c)!);
      const fille = a.mere === b.code ? a : b.mere === a.code ? b : null;
      if (fille) {
        return {
          code: fille.code,
          nom: fille.nom,
          via: trouves.find((t) => t.code === fille.code)!.via,
          mere: fille.mere,
          prudence: `Écrit avec sa wilaya mère (${nomDe(fille.mere!)}) : lieu de la wilaya ${fille.code} depuis la loi n° 26-06.`,
        };
      }
    }
    return rejet("plusieurs_wilayas", `Le texte nomme plusieurs wilayas : ${codes.map((c) => `${c} ${nomDe(c)}`).join(", ")}.`);
  }

  if (codes.length === 1) {
    const w = PAR_CODE.get(codes[0])!;
    if (numero !== null && code2(numero) !== w.code) {
      return rejet("contradiction", `Le numéro ${code2(numero)} contredit le nom ${w.nom} (${w.code}).`);
    }
    if (postal) {
      const p = postal.slice(0, 2);
      if (p !== w.code && p !== w.mere) {
        return rejet("contradiction", `Le code postal ${postal} (wilaya ${p}) contredit le nom ${w.nom} (${w.code}).`);
      }
    }
    return { code: w.code, nom: w.nom, via: trouves[0].via, mere: w.mere, ...prudenceNouvelle(w) };
  }

  if (numero !== null) {
    const w = PAR_CODE.get(code2(numero));
    if (!w) return rejet("numero_hors_liste", `Le numéro ${numero} n'est pas une wilaya (01 à 69).`);
    return { code: w.code, nom: w.nom, via: "numero", mere: w.mere, ...prudenceNouvelle(w) };
  }

  if (postal && reste.length === 1) {
    const w = PAR_CODE.get(postal.slice(0, 2));
    // Les codes postaux suivent encore l'ancien découpage : aucun n'est en 59-69 à ce jour.
    if (!w || w.mere) return rejet("numero_hors_liste", `Le code postal ${postal} ne correspond à aucune wilaya connue.`);
    return {
      code: w.code,
      nom: w.nom,
      via: "code_postal",
      mere: null,
      ...(MERES.has(w.code)
        ? { prudence: `Code postal de ${w.nom}, qui a cédé des communes à une wilaya créée en 2026 : la wilaya peut être une de ses filles.` }
        : {}),
    };
  }

  return rejet("inconnu", `Aucune wilaya reconnue dans « ${String(brut).trim().slice(0, 80)} ».`);
}

function prudenceNouvelle(w: WilayaRef): { prudence?: string } {
  return w.mere
    ? { prudence: `Wilaya créée par la loi n° 26-06 (en fonction au 1er janvier 2027) ; wilaya mère : ${w.mere} ${nomDe(w.mere)}.` }
    : {};
}

/* ── COMMUNES ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export interface CommuneRef {
  code: string;
  nom: string;
  nomAr?: string | null;
  wilayaCode: CodeWilaya;
}

export type ResultatCommune =
  | { code: string; nom: string; wilayaCode: CodeWilaya }
  | { code: null; raison: "vide" | "referentiel_vide" | "inconnue" | "homonymes"; detail: string; wilayas?: CodeWilaya[] };

const MOTS_VIDES_COMMUNE = new Set(["commune", "apc", "de", "d", "du", "la", "le", "ville", "بلدية", "مدينة"].map((m) => replier(m)));

function formeCommune(brut: unknown): string {
  return replier(brut).split(" ").filter((m) => m && !MOTS_VIDES_COMMUNE.has(m)).join(" ");
}

/**
 * LA COMMUNE d'une ville tapée à la main, parmi le référentiel fourni (la table `Commune`) — seulement si un seul
 * nom correspond (dans la wilaya donnée, quand on la connaît). Des homonymes dans plusieurs wilayas rendent `null`
 * avec leurs wilayas : c'est à l'appelant (ou à un humain) de choisir, pas au hasard de l'ordre de la liste.
 */
export function normaliserCommune(
  brut: unknown,
  communes: readonly CommuneRef[],
  options: { wilayaCode?: CodeWilaya | null } = {},
): ResultatCommune {
  const forme = formeCommune(brut);
  if (!forme) return { code: null, raison: "vide", detail: "Aucun texte." };
  if (communes.length === 0) {
    return { code: null, raison: "referentiel_vide", detail: "La table des communes est vide : rien à quoi rattacher." };
  }
  let candidats = communes.filter((c) => formeCommune(c.nom) === forme || (c.nomAr && formeCommune(c.nomAr) === forme));
  if (options.wilayaCode) candidats = candidats.filter((c) => c.wilayaCode === options.wilayaCode);
  if (candidats.length === 1) {
    const c = candidats[0];
    return { code: c.code, nom: c.nom, wilayaCode: c.wilayaCode };
  }
  if (candidats.length === 0) {
    return { code: null, raison: "inconnue", detail: `Aucune commune « ${String(brut).trim().slice(0, 80)} »${options.wilayaCode ? ` dans la wilaya ${options.wilayaCode}` : ""}.` };
  }
  const wilayas = [...new Set(candidats.map((c) => c.wilayaCode))].sort();
  return { code: null, raison: "homonymes", detail: `${candidats.length} communes portent ce nom (wilayas ${wilayas.join(", ")}).`, wilayas };
}

/**
 * UNE FICHE ENTIÈRE : la colonne wilaya prime ; à défaut, la ville (ou la région) porte souvent la wilaya (« Oran »,
 * « Blida ») ; la commune n'est cherchée que dans la wilaya trouvée, pour ne pas confondre deux homonymes.
 */
export function normaliserLieu(
  champs: { wilaya?: unknown; ville?: unknown; region?: unknown },
  communes: readonly CommuneRef[] = [],
  options: OptionsWilaya = {},
): { wilaya: ResultatWilaya; commune: ResultatCommune | null } {
  let wilaya = normaliserWilaya(champs.wilaya, options);
  // Une colonne wilaya vide ou illisible laisse parler la ville, puis la région ; une contradiction, non.
  if (wilaya.code === null && (wilaya.raison === "vide" || wilaya.raison === "inconnu")) {
    for (const champ of [champs.ville, champs.region]) {
      const r = normaliserWilaya(champ, options);
      if (r.code !== null) { wilaya = r; break; }
      if (wilaya.code === null && wilaya.raison === "vide" && r.raison !== "vide") wilaya = r;
    }
  }
  const ville = String(champs.ville ?? "").trim();
  const commune = ville ? normaliserCommune(ville, communes, { wilayaCode: wilaya.code }) : null;
  return { wilaya, commune };
}
