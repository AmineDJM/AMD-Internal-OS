/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEMENT D'UNE PIÈCE — quelle est sa nature ? Par des RÈGLES, sur ce serveur, sans modèle.
 *
 * Étape 2 du moteur d'enrichissement (`docs/architecture/refonte-donnees-et-monolithe-modulaire.md`,
 * §3-E) : la pièce déposée reçoit une `NaturePiece`, et c'est elle qui choisit l'extracteur. Une
 * pièce d'identité ou un bulletin de paie se reconnaît ICI — avant qu'un modèle n'en voie une ligne.
 *
 * ── COMMENT ──────────────────────────────────────────────────────────────────────────────
 *
 * Chaque nature a ses INDICES (une zone MRZ, « Devis N° », un RIB à 20 chiffres, « Curriculum
 * vitae »…), en français, en anglais et en arabe. Un indice a un poids : 3 (décisif seul : une
 * MRZ, un titre numéroté), 2 (un titre, une formule propre à la nature), 1 (un appui : les totaux,
 * le nom du fichier). La nature qui totalise le plus l'emporte, et chaque indice retenu est DIT.
 *
 * ── CE QUI N'EST JAMAIS DEVINÉ ───────────────────────────────────────────────────────────
 *
 * - Un TITRE ne compte qu'en tête de pièce : « apportez votre passeport » dans un programme ne
 *   fait pas un passeport ; « RC : 16/00-… » au pied d'une facture ne fait pas un registre.
 * - Une pièce CITÉE n'est pas la pièce : « suivant devis N° 45 » sur une facture est une
 *   référence (suivant, selon, réf., sur, votre…), pas le numéro de la pièce.
 * - La forme lettre (« Objet : », « Veuillez agréer… ») n'est qu'un repli : une invitation ou une
 *   attestation écrite en lettre reste une invitation ou une attestation.
 * - Moins de deux points, ou deux natures à égalité : « AUTRE », jamais une supposition.
 *
 * ── LA CONFIANCE ─────────────────────────────────────────────────────────────────────────
 *
 * Calibrée sur le total des poids (2 → 0,55 … 8 → 0,95). Une nature n'est rendue AU-DESSUS DE
 * 0,8 qu'avec au moins deux indices concordants ; une nature serrée par une autre (un point
 * d'écart) est plafonnée à 0,6. « AUTRE » porte une confiance nulle.
 *
 * Module PUR : aucune base, aucun fichier, aucun réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { chiffreDeControle, lireMrz } from "@/lib/agent/operations/mrz";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { NATURES_LOCALES, type ClassementPiece, type NaturePiece } from "./types";

export interface PieceAClasser {
  nomFichier: string;
  mime: string;
  /** Le texte lu sur ce serveur (couche texte ou OCR local). */
  texte: string;
}

/** La pièce ne se lit QUE sur ce serveur : aucun modèle externe, aucun OCR distant. */
export function estNatureLocale(nature: NaturePiece): boolean {
  return NATURES_LOCALES.includes(nature);
}

interface Indice { nature: NaturePiece; libelle: string; poids: number }

/** Au-delà, le texte n'apporte plus rien au classement (et les expressions restent bornées). */
const TEXTE_MAX = 60_000;
const LIGNES_TETE = 10;
const TITRE_MAX = 90;

// ─────────────────────────────── Le pli ───────────────────────────────

/**
 * Minuscules, sans accents, apostrophes droites, espaces simples ; en arabe : sans voyelles ni
 * tatouïl, hamza portée ramenée à sa lettre (أ إ آ → ا), ة → ه, ى → ي, ئ → ي. Les motifs arabes de ce
 * fichier sont écrits DANS cette forme pliée.
 */
function plier(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯٓ-ًٕ-ٰٟـ]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[    \t]/g, " ")
    .replace(/ {2,}/g, " ");
}

// ─────────────────────────────── Les zones MRZ ───────────────────────────────

const normaliserMrz = (l: string) => l.toUpperCase().replace(/[«‹＜]/g, "<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, "");
const VERS_CHIFFRE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const chiffres = (s: string) => s.replace(/[OQDILZSBG]/g, (c) => VERS_CHIFFRE[c] ?? c);
const controle = (champ: string, c: string | undefined) => c !== undefined && String(chiffreDeControle(champ)) === chiffres(c);

/** TD1 (carte d'identité, ICAO 9303) : trois lignes de 30, la première ouvre sur I, A ou C. */
function lireTd1(lignesMrz: readonly string[]): { controlesBons: number } | null {
  for (let i = 0; i + 2 < lignesMrz.length; i++) {
    const [l1, l2, l3] = [lignesMrz[i]!, lignesMrz[i + 1]!, lignesMrz[i + 2]!];
    if (![l1, l2, l3].every((l) => l.length >= 28 && l.length <= 32)) continue;
    if (!/^[IAC][A-Z<][A-Z<]{3}/.test(l1) || !l3.includes("<<")) continue;
    let controlesBons = 0;
    if (controle(l1.slice(5, 14), l1[14])) controlesBons++;
    if (controle(chiffres(l2.slice(0, 6)), l2[6])) controlesBons++;
    if (controle(chiffres(l2.slice(8, 14)), l2[14])) controlesBons++;
    return { controlesBons };
  }
  return null;
}

/** MRV (vignette visa) : deux lignes de 44 ou 36, la première ouvre sur V. */
const estMrzVisa = (lignesMrz: readonly string[]) =>
  lignesMrz.some((l, i) => /^V[A-Z<][A-Z<]{3}/.test(l) && (l.match(/</g)?.length ?? 0) >= 3 && (lignesMrz[i + 1]?.length ?? 0) >= 34);

// ─────────────────────────────── Les pièces numérotées ───────────────────────────────

type Commerciale = "DEVIS" | "FACTURE" | "BON_DE_COMMANDE" | "AVOIR" | "BON_LIVRAISON";

/** « Facture N° 12 », « Invoice # 553 », « Devis : D-2026-08 » — le titre suivi d'un numéro. */
const RE_NUMEROTEE =
  /(?<![a-z])(facture\s+pro[\s-]?forma|facture\s+d'avoir|pro[\s-]?forma|devis|facture|invoice|quotation|quote|bon\s+de\s+commande|purchase\s+order|bon\s+de\s+livraison|bordereau\s+de\s+livraison|delivery\s+note|delivery\s+slip|note\s+de\s+credit|credit\s+note|avoir|bc|bl|po)(?![a-z])\s*(?:n\s*[°º]|no\.?|n°|num(?:ero)?\.?|#|number|ref(?:erence)?\.?)?\s*[:.-]?\s*(?=[a-z]{0,5}[\s/_-]?\d)/g;
/** Ce qui fait d'une mention une RÉFÉRENCE à une autre pièce, pas le numéro de celle-ci. */
const RE_AVANT_REFERENCE =
  /(?<![a-z])(?:suivant|selon|ref(?:erence)?s?|votre|notre|vos|nos|v\/|n\/|relati(?:f|ve)s?|conformement|sur|cf|vu|objet|total|montant|net|sous|dans|par|de\s+la|du|des|au|a\s+la|regle\w*|annul\w*|remplace\w*|related|regarding|against|concernant|correspond\w*|issued for|re)(?![a-z])\W*(?:\S+\s+){0,2}$/;
/** Une forme courte (« BC », « BL », « PO ») ne compte qu'en majuscules ET avec sa marque (« N° »). */
const RE_MARQUE = /^\s*(?:n\s*[°º]|no\.?|n°|num|#)/;

function commercialeDe(mot: string): Commerciale {
  const m = mot.replace(/\s+/g, " ");
  if (/pro[\s-]?forma|devis|quot/.test(m)) return "DEVIS";
  if (/avoir|credit/.test(m)) return "AVOIR";
  if (/livraison|delivery|^bl$/.test(m)) return "BON_LIVRAISON";
  if (/commande|purchase|^bc$|^po$/.test(m)) return "BON_DE_COMMANDE";
  return "FACTURE";
}

/** Les pièces numérotées lues : la première de chaque nature, et si ce n'est qu'une référence. */
function piecesNumerotees(lignes: readonly string[], plis: readonly string[]): { nature: Commerciale; reference: boolean; extrait: string }[] {
  const out: { nature: Commerciale; reference: boolean; extrait: string }[] = [];
  for (let i = 0; i < plis.length; i++) {
    const pli = plis[i]!;
    for (const m of pli.matchAll(RE_NUMEROTEE)) {
      const debut = m.index ?? 0;
      const mot = m[1]!;
      if (/^(?:bc|bl|po)$/.test(mot)) {
        const brut = lignes[i]!.slice(debut, debut + 2);
        if (brut !== brut.toUpperCase() || !RE_MARQUE.test(pli.slice(debut + 2))) continue;
      }
      const reference = RE_AVANT_REFERENCE.test(pli.slice(Math.max(0, debut - 40), debut));
      out.push({ nature: commercialeDe(mot), reference, extrait: lignes[i]!.trim().slice(0, 80) });
    }
  }
  return out;
}

// ─────────────────────────────── Les indices ───────────────────────────────

const RE_CHAMPS_IDENTITE = [
  /date d'expiration|date of expiry|expiry date/, /date de delivrance|date of issue/, /lieu de naissance|place of birth/,
  /nationalite|nationality/, /(?<![a-z])(?:surname|given names?)(?![a-z])/, /autorite|authority/, /تاريخ الميلاد|مكان الميلاد|تاريخ انتهاء/,
];
const RE_CONTRAT_CORPS: [RegExp, string][] = [
  [/entre les soussigne|between the undersigned|by and between|ci-apres (?:denomme|designe|appele)|hereinafter|الطرف الاول|الطرف الثاني/, "désignation des parties (« entre les soussignés »)"],
  [/article (?:1|premier|i)(?![0-9a-z])|article 1er|المادة (?:1|الاولي)/, "articles numérotés"],
  [/objet du contrat|objet de la convention|duree du contrat|duree de la convention|resiliation|termination|clause|fait en (?:deux|trois|\d) exemplaires|lu et approuve|in witness whereof|موضوع العقد|فسخ/, "clauses (objet, durée, résiliation)"],
];
const RE_CV_RUBRIQUES = [
  /experiences? professionnelles?|parcours professionnel|work experience|professional experience|الخبرات? المهني/, /(?<![a-z])formations?(?![a-z])|education|cursus|التكوين|المؤهلات/,
  /competences|skills|المهارات/, /(?<![a-z])langues(?![a-z])|languages|اللغات/, /centres? d'interet|loisirs|hobbies|interests|الهوايات/, /etat civil|informations personnelles|personal (?:details|information)/,
];
const RE_PAIE_CORPS: [RegExp, string, number][] = [
  [/salaire de base|base salary|basic salary|الاجر القاعدي|الراتب الاساسي/, "salaire de base", 2],
  [/cotisations?|retenue\s+(?:irg|ss|securite sociale)|(?<![a-z])(?:cnas|irg)(?![a-z])|social security|اشتراكات/, "cotisations / retenues", 2],
  [/periode de paie|pay period|mois de paie|(?<![a-z])matricule(?![a-z])/, "période de paie, matricule", 1],
];
const RE_PROGRAMME_RUBRIQUES = [
  /pause[\s-]cafe|coffee break|استراحه/, /dejeuner|lunch|diner de gala/, /(?<![a-z])sessions?(?![a-z])|pleniere|plenary/, /moderat(?:eur|rice|or)s?|chairs?(?:person)?(?![a-z])|منشط/,
  /orateurs?|speakers?|conferencier|intervenants?|محاضر/, /table[\s-]ronde|round[\s-]table|panel/, /ouverture|opening|cloture|closing|allocution|welcome address|افتتاح/, /inscription|registration|accueil des participants|تسجيل/,
];
const RE_HOTEL_RUBRIQUES = [
  /check[\s-]?in|date d'arrivee|arrival date/, /check[\s-]?out|date de depart|departure date/, /(?<![a-z])nuit(?:s|ees?)?(?![a-z])|(?<![a-z])nights?(?![a-z])|ليال/,
  /chambre|room type|(?<![a-z])rooms?(?![a-z])|غرفه/, /petit[\s-]dejeuner|breakfast|demi[\s-]pension|pension complete/, /adultes?|guests?|occupants?|personnes?/,
];
const RE_BILLET_RUBRIQUES = [
  /(?<![a-z])(?:depart|departure|from)(?![a-z])/, /(?<![a-z])(?:arrivee|arrival|to)(?![a-z])/, /terminal|(?<![a-z])gate(?![a-z])|porte d'embarquement|embarquement|boarding/,
  /bagages?|baggage|franchise/, /classe (?:economique|affaires)|economy|business class|cabin/, /(?<![a-z])(?:siege|seat)(?![a-z])/,
];
const RE_PV_RUBRIQUES = [
  /l'an deux mille|s'est reuni|se sont reunis|has met|met on|اجتمع/, /ordre du jour|agenda items|جدول الاعمال/, /etaient presents|presents\s*:|absents?(?: excuses?)?\s*:|attendees|الحاضرون/,
  /la seance est (?:ouverte|levee)|meeting (?:was )?(?:opened|closed|adjourned)|رفعت الجلسه/, /apres (?:deliberation|discussion)|decide|resolution|il a ete convenu|it was (?:agreed|resolved)|قرر/, /quorum/,
];
const RE_COURRIER = {
  objet: /^\s*(?:objet|subject|re|الموضوع)\s*:/m,
  appel: /^\s*(?:monsieur|madame|messieurs|mesdames|dear|cher|chere|السيد|سيدي)(?![a-z])/m,
  formule: /veuillez agreer|je vous prie d'agreer|recevez,? (?:madame|monsieur)|nos (?:sinceres|meilleures) salutations|sinceres salutations|yours (?:faithfully|sincerely)|sincerely|best regards|kind regards|تقبلوا|فايق الاحترام/,
  lieuDate: /^\s*[a-z' -]{3,30},\s*le\s+\d{1,2}(?:er)?[\s/.-]/m,
};

const compter = (res: readonly RegExp[], t: string) => res.filter((re) => re.test(t)).length;

/** Les mots du nom de fichier — une indication d'appoint (poids 1), jamais une preuve. */
const FICHIER: [RegExp, NaturePiece][] = [
  [/^(?:passeport|passport)$/, "PASSEPORT"], [/^(?:cni|cin|identite|id)$/, "CNI"], [/^permis$/, "PERMIS_CONDUIRE"], [/^visas?$/, "VISA"],
  [/^(?:devis|proforma|quotation|quote)$/, "DEVIS"], [/^(?:facture|invoice|fact)$/, "FACTURE"], [/^(?:bc|commande|po)$/, "BON_DE_COMMANDE"],
  [/^avoir$/, "AVOIR"], [/^(?:bl|livraison)$/, "BON_LIVRAISON"], [/^(?:contrat|contract|agreement)$/, "CONTRAT"], [/^convention$/, "CONVENTION"],
  [/^(?:rib|iban)$/, "RIB"], [/^(?:rc|registre|kbis)$/, "REGISTRE_COMMERCE"], [/^nif$/, "ATTESTATION_NIF"], [/^(?:cv|resume)$/, "CV"],
  [/^(?:diplome|diploma)$/, "DIPLOME"], [/^(?:vcard|vcf)$/, "CARTE_VISITE"], [/^(?:attestation|certificat|certificate)$/, "ATTESTATION"],
  [/^(?:paie|payslip|bulletin)$/, "BULLETIN_PAIE"], [/^(?:programme|program|agenda)$/, "PROGRAMME_CONGRES"], [/^invitation$/, "INVITATION"],
  [/^(?:billet|eticket|ticket|boarding)$/, "BILLET_TRANSPORT"], [/^(?:hotel|booking|reservation)$/, "RESERVATION_HOTEL"],
  [/^(?:pv|minutes)$/, "PROCES_VERBAL"], [/^(?:courrier|lettre|letter)$/, "COURRIER"],
];

function indicesDe({ nomFichier, mime, texte }: PieceAClasser): Indice[] {
  const out: Indice[] = [];
  const dit = (nature: NaturePiece, libelle: string, poids: number) => out.push({ nature, libelle, poids });

  const brut = String(texte ?? "").slice(0, TEXTE_MAX).replace(/\r\n?/g, "\n");
  const lignes = brut.split("\n");
  const plis = lignes.map(plier);
  const t = plis.join("\n");
  const tete = plis.filter((l) => l.trim()).slice(0, LIGNES_TETE).filter((l) => l.trim().length <= TITRE_MAX);
  /** Un titre : une ligne courte, en tête de pièce, qui OUVRE sur le motif. */
  const titre = (re: RegExp) => tete.some((l) => re.test(l.trim()));
  const court = brut.trim().length <= 600 && lignes.filter((l) => l.trim()).length <= 14;

  // ── Le nom de fichier et le type MIME ──
  const mots = plier(nomFichier ?? "").replace(/\.[a-z0-9]{1,5}$/, "").split(/[^a-z0-9؀-ۿ]+/).filter(Boolean);
  for (const [re, nature] of FICHIER) if (mots.some((m) => re.test(m))) dit(nature, `nom du fichier (« ${nomFichier.slice(0, 60)} »)`, 1);
  if (/^text\/(?:x-)?vcard$/i.test(mime ?? "") || /^begin:vcard/m.test(t)) dit("CARTE_VISITE", "fiche vCard", 3);

  // ── Les zones MRZ (ICAO 9303) ──
  const lignesMrz = lignes.map(normaliserMrz).filter((l) => l.length >= 28 && (l.match(/</g)?.length ?? 0) >= 2);
  const td3 = lireMrz(brut);
  if (td3) {
    dit("PASSEPORT", "zone MRZ TD3 (passeport)", 3);
    if (td3.controlesFaux.length === 0) dit("PASSEPORT", "chiffres de contrôle MRZ cohérents", 2);
  }
  const td1 = td3 ? null : lireTd1(lignesMrz);
  if (td1) {
    dit("CNI", "zone MRZ TD1 (carte d'identité)", 3);
    if (td1.controlesBons >= 2) dit("CNI", "chiffres de contrôle MRZ cohérents", 2);
  }
  if (!td3 && estMrzVisa(lignesMrz)) dit("VISA", "zone MRZ de visa (MRV)", 3);

  // ── Les pièces d'identité ──
  const champsIdentite = compter(RE_CHAMPS_IDENTITE, t);
  if (titre(/^(?:\S+\s+){0,6}(?:passeport|passport|جواز السفر|جواز سفر)\s*$/)) dit("PASSEPORT", "titre « Passeport »", 2);
  if (titre(/^(?:carte nationale d'identite|carte d'identite|national identity card|identity card|بطاقه التعريف الوطني)(?:\s+[^\s:]+){0,2}\s*$/)) dit("CNI", "titre « Carte nationale d'identité »", 2);
  if (titre(/^(?:permis de conduire|driving licen[cs]e|driver'?s licen[cs]e|رخصه السياقه)(?:\s+[^\s:]+){0,2}\s*$/)) dit("PERMIS_CONDUIRE", "titre « Permis de conduire »", 3);
  if (titre(/^(?:\S+\s+){0,3}(?:visa|تاشيره)\s*$/)) dit("VISA", "titre « Visa »", 2);
  if (/type de visa|visa type|nombre d'entrees|number of entries|duree (?:de|du) sejour|duration of stay|نوع التاشيره/.test(t)) dit("VISA", "rubriques de visa (type, entrées, séjour)", 2);
  if (/categor(?:ie|y)s?\s*:?\s*(?:a1|a|b|be|c|ce|d)(?![a-z0-9])|(?<![0-9])4a\.\s.*\n?.*4b\./.test(t)) dit("PERMIS_CONDUIRE", "catégories de permis", 1);
  if (champsIdentite >= 2) {
    const libelle = `champs d'identité (${champsIdentite})`;
    dit("PASSEPORT", libelle, 1);
    dit("CNI", libelle, 1);
  }
  if (/(?<![a-z])nin(?![a-z])|numero d'identification national|الرقم التعريفي الوطني/.test(t) && champsIdentite >= 1) dit("CNI", "NIN", 1);

  // ── Les pièces commerciales ──
  const numerotees = piecesNumerotees(lignes, plis);
  const vues = new Set<Commerciale>();
  // La PREMIÈRE pièce numérotée non citée est la pièce ; une autre, plus bas, n'est qu'un appui.
  let piece: Commerciale | null = null;
  for (const n of numerotees) {
    if (n.reference || vues.has(n.nature)) continue;
    vues.add(n.nature);
    piece ??= n.nature;
    dit(n.nature, `pièce numérotée (« ${n.extrait} »)`, n.nature === piece ? 3 : 1);
  }
  const ar: [RegExp, Commerciale, string][] = [
    [/فاتوره (?:رقم|ر)/, "FACTURE", "« فاتورة رقم »"], [/(?:عرض (?:اسعار|سعر)|فاتوره شكليه|فاتوره اوليه)/, "DEVIS", "« عرض أسعار »"],
    [/(?:امر شراء|سند طلب|طلب شراء|وصل طلب)/, "BON_DE_COMMANDE", "« أمر شراء »"], [/(?:سند (?:ال)?تسليم|وصل (?:ال)?تسليم|اذن (?:ال)?تسليم|وصل استلام)/, "BON_LIVRAISON", "« سند تسليم »"],
    [/(?:اشعار داين|فاتوره (?:ال)?مرتجع)/, "AVOIR", "« إشعار دائن »"],
  ];
  for (const [re, nature, libelle] of ar) {
    // « بخصوص الفاتورة رقم 77 » (au sujet de la facture n° 77) cite une autre pièce : l'article « ال » ou un mot de renvoi l'écarte.
    const citee = new RegExp(`(?:ال|(?:بخصوص|حسب|وفق|مرجع|المرجع)\\s+)(?:${re.source})`, "g");
    if (!vues.has(nature) && re.test(t.replace(citee, " "))) { vues.add(nature); dit(nature, libelle, 3); }
  }
  const titres: [RegExp, Commerciale, string][] = [
    [/^(?:devis|facture pro[\s-]?forma|pro[\s-]?forma|quotation|offre de prix)(?![a-z])/, "DEVIS", "titre « Devis »"],
    [/^(?:facture|invoice)(?![a-z])(?!\s+(?:pro[\s-]?forma|d'avoir))/, "FACTURE", "titre « Facture »"],
    [/^(?:bon de commande|purchase order)(?![a-z])/, "BON_DE_COMMANDE", "titre « Bon de commande »"],
    [/^(?:avoir|facture d'avoir|note de credit|credit note)(?![a-z])/, "AVOIR", "titre « Avoir »"],
    [/^(?:bon de livraison|bordereau de livraison|delivery note)(?![a-z])/, "BON_LIVRAISON", "titre « Bon de livraison »"],
  ];
  for (const [re, nature, libelle] of titres) if (!vues.has(nature) && titre(re)) dit(nature, libelle, 2);
  if (/validite de l'offre|offre valable|valable \d+ jours|validite\s*:\s*\d+|quote valid|valid for \d+ days|صالح لمده/.test(t)) dit("DEVIS", "validité de l'offre", 2);
  if (/arrete(?:e)? la presente facture|net a payer|amount due|timbre fiscal|date d'echeance|due date|المبلغ الواجب الدفع/.test(t) && !/salaire|cotisation/.test(t)) dit("FACTURE", "mentions de règlement (net à payer, échéance, timbre)", 1);
  if (/veuillez nous livrer|merci de (?:nous )?livrer|please (?:supply|deliver)|delai de livraison|adresse de livraison|lieu de livraison/.test(t)) dit("BON_DE_COMMANDE", "instructions de livraison", 1);
  if (/en votre faveur|a deduire|retour de marchandises?|marchandises? retournees?|remboursement|credit en votre faveur|in your favour/.test(t)) dit("AVOIR", "crédit en faveur du client (retour, remboursement)", 1);
  if (/quantites? livrees?|qte livree|recu par|receptionn(?:e|aire)|signature du (?:client|receptionnaire)|livreur|chauffeur|received by|delivered by|المستلم/.test(t)) dit("BON_LIVRAISON", "réception de la marchandise (livreur, reçu par)", 2);
  const e = repererEntetes(brut);
  if (e.totalHt || e.totalTtc || e.netAPayer) {
    for (const n of ["DEVIS", "FACTURE", "BON_DE_COMMANDE", "AVOIR"] as const) dit(n, "totaux HT / TTC", 1);
  }

  // ── Contrats et conventions ──
  if (titre(/^(?:contrat|contract|agreement|accord cadre|عقد)(?![a-z])/) || titre(/^(?:\S+\s+){1,3}(?:contract|agreement)\s*$/)) dit("CONTRAT", "titre « Contrat »", 2);
  if (titre(/^(?:convention|memorandum of understanding|اتفاقيه)(?![a-z])/)) dit("CONVENTION", "titre « Convention »", 2);
  for (const [re, libelle] of RE_CONTRAT_CORPS) {
    if (!re.test(t)) continue;
    dit("CONTRAT", libelle, 1);
    dit("CONVENTION", libelle, 1);
  }

  // ── Le RIB ──
  if (titre(/^(?:releve d'identite bancaire|bank (?:identity|account) (?:statement|details)|كشف الهويه البنكيه)/) || tete.some((l) => /^\s*r\.?i\.?b\.?\s*$/.test(l)))
    dit("RIB", "titre « Relevé d'identité bancaire »", 3);
  const rib20 = /(?<![\d])\d{3}[ .-]?\d{5}[ .-]?\d{10}[ .-]?\d{2}(?![\d])/.test(brut);
  if (rib20) dit("RIB", "RIB à 20 chiffres", 2);
  const intitulesBancaires = compter([/code banque|bank code/, /code (?:guichet|agence)|branch code/, /cle(?: rib)?\s*:|(?<![a-z])cle rib/, /domiciliation/, /titulaire du compte|account (?:holder|name)|صاحب الحساب/, /(?<![a-z])(?:bic|swift)(?![a-z])/, /(?<![a-z])iban(?![a-z])/], t);
  if (intitulesBancaires >= 2) dit("RIB", `intitulés bancaires (${intitulesBancaires})`, intitulesBancaires >= 4 ? 2 : 1);

  // ── Registre du commerce, NIF, carte fiscale ──
  if ((titre(/^(?:extrait du registre (?:du|de) commerce|مستخرج من السجل التجاري)/) || titre(/^(?:registre (?:du|de) commerce(?: et des societes)?|commercial register|السجل التجاري)\s*$/))) dit("REGISTRE_COMMERCE", "titre « Registre du commerce »", 3);
  if (/centre national du registre du commerce|(?<![a-z])cnrc(?![a-z])|المركز الوطني للسجل التجاري/.test(t)) dit("REGISTRE_COMMERCE", "CNRC", 2);
  const rubriquesRc = compter([/activites? (?:exercees?|principale)|code d'activite|nature de l'activite/, /forme juridique/, /date d'immatriculation|immatricule(?:e)? le/, /siege social/, /capital social/], t);
  if (rubriquesRc >= 3) dit("REGISTRE_COMMERCE", `rubriques d'un extrait (${rubriquesRc})`, 1);
  const titreNif = /(?:attestation|certificat) (?:d'immatriculation fiscale|de (?:numero d')?identification fiscale|nif)|شهاده (?:التسجيل|الترقيم|التعريف) الجبايي/;
  if (titre(new RegExp(`^${titreNif.source}`))) dit("ATTESTATION_NIF", "titre « Attestation d'immatriculation fiscale »", 3);
  if (titre(/^(?:carte (?:d'immatriculation|d'identification) fiscale|carte nif|بطاقه (?:التعريف|الترقيم) الجبايي)/)) dit("CARTE_IMMATRICULATION_FISCALE", "titre « Carte d'immatriculation fiscale »", 3);
  if (/direction (?:generale )?des impots|(?<![a-z])dgi(?![a-z])|ministere des finances|المديريه العامه للضرايب/.test(t)) {
    dit("ATTESTATION_NIF", "administration fiscale (DGI)", 1);
    dit("CARTE_IMMATRICULATION_FISCALE", "administration fiscale (DGI)", 1);
  }
  if (/(?<![a-z])n\.?\s?i\.?\s?f\.?(?![a-z])[^\d\n]{0,20}\d{15}(?!\d)/.test(t) && court) {
    dit("ATTESTATION_NIF", "NIF à 15 chiffres sur une pièce courte", 1);
    dit("CARTE_IMMATRICULATION_FISCALE", "NIF à 15 chiffres sur une pièce courte", 1);
  }

  // ── CV, diplôme, carte de visite ──
  if (titre(/^(?:curriculum vitae|resume|السيره الذاتيه)(?![a-z])/) || tete.some((l) => /^\s*c\.?v\.?\s*$/.test(l))) dit("CV", "titre « Curriculum vitae »", 3);
  const rubriquesCv = compter(RE_CV_RUBRIQUES, t);
  if (rubriquesCv >= 2) dit("CV", `rubriques de CV (${rubriquesCv})`, rubriquesCv >= 4 ? 3 : 2);
  if ((t.match(/(?<!\d)(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|aujourd'hui|ce jour|now|today)/g)?.length ?? 0) >= 2) dit("CV", "périodes datées (2015 – 2019)", 1);
  if (titre(/^(?:diplome|diploma|attestation de reussite|certificat de (?:fin d'etudes|scolarite)|(?:doctorat|master|licence|baccalaureat|bachelor)(?! en cours)|شهاده (?:الليسانس|الماستر|البكالوريا|الدكتوراه)|دبلوم)/)) dit("DIPLOME", "titre « Diplôme »", 2);
  if (/decerne a|delivre a|awarded to|conferred (?:upon|on)|has been conferred|a obtenu le (?:grade|diplome)|le grade de|degree of|mention\s*:?\s*(?:tres bien|bien|assez bien|passable)|with (?:honours|distinction)|بتقدير|منحت/.test(t)) dit("DIPLOME", "attribution d'un grade (« décerné à », mention)", 2);
  if (/(?<![a-z])(?:le recteur|le doyen|rector|dean|vice-chancellor)(?![a-z])|عميد|مدير الجامعه/.test(t) && /universit|faculte|ecole|institut|جامعه|كليه/.test(t)) dit("DIPLOME", "autorité universitaire (recteur, doyen)", 1);
  if (court) {
    const coord = compter([/(?:\+?\d[\d .-]{7,}\d)/, /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/, /(?:www\.|https?:\/\/)[a-z0-9.-]+/], t);
    if (coord >= 2) dit("CARTE_VISITE", `coordonnées sur un texte court (${coord})`, 2);
    if (coord >= 1 && /(?<![a-z])(?:directeur|directrice|director|manager|responsable|delegue|ingenieur|engineer|ceo|sales|commercial|gerant|pharmacien|dr\.?)(?![a-z])/.test(t)) dit("CARTE_VISITE", "fonction et coordonnées", 1);
  }

  // ── Attestations et paie ──
  const titreAttestation = /^(?:attestation|certificat|certificate|شهاده)(?![a-z])(?!\s+(?:d'immatriculation fiscale|de (?:numero d')?identification fiscale|nif|de reussite|de fin d'etudes|de scolarite|(?:التسجيل|الترقيم|التعريف) الجبايي|(?:الليسانس|الماستر|البكالوريا|الدكتوراه)))/;
  if (titre(titreAttestation)) dit("ATTESTATION", "titre « Attestation »", 2);
  if (/je soussigne|nous soussigne|(?:we|i) hereby certify|this is to certify|atteste(?:ns)? (?:par la presente )?que|certifie(?:ns)? que|يشهد|اشهد/.test(t)) dit("ATTESTATION", "formule « je soussigné… atteste que »", 2);
  if (/pour servir et valoir ce que de droit|en foi de quoi|for whatever purpose|سلمت هذه الشهاده/.test(t)) dit("ATTESTATION", "« pour servir et valoir ce que de droit »", 2);
  if (titre(/^(?:bulletin de (?:paie|salaire)|fiche de (?:paie|salaire)|pay ?slip|كشف (?:الراتب|الاجر)|قسيمه (?:الراتب|الاجر))/)) dit("BULLETIN_PAIE", "titre « Bulletin de paie »", 3);
  for (const [re, libelle, poids] of RE_PAIE_CORPS) if (re.test(t)) dit("BULLETIN_PAIE", libelle, poids);
  if (/net a payer|net pay|salaire net|net salary/.test(t) && /salaire|brut|cotisation|gross/.test(t)) dit("BULLETIN_PAIE", "salaire net", 1);

  // ── Congrès, invitation, voyage ──
  if (titre(/^(?:programme|program|agenda|برنامج)(?![a-z])/) || /programme (?:scientifique|preliminaire|du congres|des journees)|scientific program/.test(t)) dit("PROGRAMME_CONGRES", "titre « Programme »", 2);
  if (/congres|congress|symposium|journees? (?:nationales?|scientifiques?|medicales?|pharmaceutiques?)|conference|seminaire|seminar|workshop|webinai?re?|summit|colloque|مؤتمر|ملتقي/.test(t)) dit("PROGRAMME_CONGRES", "congrès / symposium", 1);
  if ((t.match(/(?<![\d])\d{1,2}\s?[h:]\s?\d{2}(?![\d])/g)?.length ?? 0) >= 3) dit("PROGRAMME_CONGRES", "créneaux horaires", 2);
  const rubriquesProgramme = compter(RE_PROGRAMME_RUBRIQUES, t);
  if (rubriquesProgramme >= 2) dit("PROGRAMME_CONGRES", `rubriques de programme (${rubriquesProgramme})`, rubriquesProgramme >= 4 ? 2 : 1);
  if (titre(/^(?:invitation|carton d'invitation|invitation letter|lettre d'invitation|دعوه)(?![a-z])/)) dit("INVITATION", "titre « Invitation »", 2);
  if (/(?:vous|you) (?:etes|are) (?:cordialement |kindly |cordially )?invite|(?:avons|a) (?:le plaisir|l'honneur) de vous inviter|(?:have|has) the (?:pleasure|honou?r) (?:of|to) invit|vous convie|we invite you|يتشرف|نتشرف بدعوتكم|يسرنا دعوتكم/.test(t)) dit("INVITATION", "formule d'invitation", 2);
  if (/(?<![a-z])r\.?s\.?v\.?p\.?(?![a-z])|confirmer votre (?:presence|participation)|please confirm your (?:attendance|participation)|tenue de soiree|dress code/.test(t)) dit("INVITATION", "confirmation de présence demandée (RSVP)", 1);
  if (/e-?ticket|electronic ticket|billet electronique|itinerary receipt|recu d'itineraire|boarding pass|carte d'embarquement|تذكره (?:الكترونيه|سفر)|بطاقه الصعود/.test(t)) dit("BILLET_TRANSPORT", "billet électronique / carte d'embarquement", 3);
  if (/ticket (?:number|no)|n° (?:de )?billet|numero de billet|(?<![\d])\d{3}[\s-]?\d{10}(?![\d])/.test(t)) dit("BILLET_TRANSPORT", "numéro de billet", 2);
  if (/(?:vol|flight)\s*(?:n°|no\.?|number|:)?\s*[a-z0-9]{2}\s?\d{3,4}(?![\d])|رحله رقم/.test(t)) dit("BILLET_TRANSPORT", "numéro de vol", 2);
  const rubriquesBillet = compter(RE_BILLET_RUBRIQUES, t);
  if (rubriquesBillet >= 3) dit("BILLET_TRANSPORT", `rubriques de voyage (${rubriquesBillet})`, 1);
  if (/(?<![a-z])pnr(?![a-z])|booking reference|reference de (?:la )?reservation|code de reservation|confirmation (?:number|no)|رقم الحجز/.test(t)) {
    dit("BILLET_TRANSPORT", "référence de réservation", 1);
    dit("RESERVATION_HOTEL", "référence de réservation", 1);
  }
  if (titre(/^(?:confirmation de (?:votre )?reservation|booking confirmation|reservation confirmation|reservation d'hotel|hotel (?:reservation|booking|voucher)|bon d'hebergement|تاكيد الحجز)/)) dit("RESERVATION_HOTEL", "titre « Confirmation de réservation »", 2);
  if (/(?<![a-z])(?:hotel|resort|hebergement|accommodation)(?![a-z])|فندق/.test(t)) dit("RESERVATION_HOTEL", "hôtel / hébergement", 1);
  const rubriquesHotel = compter(RE_HOTEL_RUBRIQUES, t);
  if (rubriquesHotel >= 2) dit("RESERVATION_HOTEL", `rubriques de séjour (${rubriquesHotel})`, rubriquesHotel >= 4 ? 3 : 2);

  // ── Procès-verbal et courrier ──
  if (titre(/^(?:proces[\s-]verbal|p\.?v\.? (?:de|d')|compte[\s-]rendu de (?:la )?reunion|minutes of (?:the )?meeting|meeting minutes|محضر)/)) dit("PROCES_VERBAL", "titre « Procès-verbal »", 3);
  else if (/proces[\s-]verbal|minutes of (?:the )?meeting|محضر/.test(t)) dit("PROCES_VERBAL", "mention « procès-verbal »", 1);
  const rubriquesPv = compter(RE_PV_RUBRIQUES, t);
  if (rubriquesPv >= 2) dit("PROCES_VERBAL", `rubriques de séance (${rubriquesPv})`, rubriquesPv >= 4 ? 3 : 2);
  if (RE_COURRIER.objet.test(t)) dit("COURRIER", "ligne « Objet : »", 1);
  if (RE_COURRIER.appel.test(t)) dit("COURRIER", "appel (« Monsieur, »)", 1);
  if (RE_COURRIER.formule.test(t)) dit("COURRIER", "formule de politesse", 2);
  if (RE_COURRIER.lieuDate.test(t)) dit("COURRIER", "lieu et date (« Alger, le … »)", 1);

  return out;
}

// ─────────────────────────────── La décision ───────────────────────────────

/** La forme lettre n'est qu'un repli : une nature précise à 3 points ou plus passe devant. */
const FORMES: ReadonlySet<NaturePiece> = new Set(["COURRIER"]);
const SEUIL_PRECIS = 3;

function confianceDe(score: number): number {
  if (score >= 8) return 0.95;
  return ([0, 0, 0.55, 0.68, 0.78, 0.85, 0.9, 0.93] as const)[score] ?? 0;
}

const NOMS: Partial<Record<NaturePiece, string>> = { BON_DE_COMMANDE: "bon de commande", BON_LIVRAISON: "bon de livraison", CARTE_IMMATRICULATION_FISCALE: "carte fiscale" };
const nom = (n: NaturePiece) => NOMS[n] ?? n.toLowerCase().replace(/_/g, " ");

export function classerPiece(piece: PieceAClasser): ClassementPiece {
  const indices = indicesDe(piece);
  if (!String(piece.texte ?? "").trim() && indices.length === 0) return { nature: "AUTRE", confiance: 0, indices: ["aucun texte lisible"] };

  const parNature = new Map<NaturePiece, Indice[]>();
  for (const i of indices) parNature.set(i.nature, [...(parNature.get(i.nature) ?? []), i]);
  const scores = [...parNature.entries()]
    .map(([nature, liste]) => ({ nature, liste, score: liste.reduce((s, i) => s + i.poids, 0) }))
    .sort((x, y) => y.score - x.score || x.liste.length - y.liste.length);

  const precis = scores.filter((s) => !FORMES.has(s.nature));
  const enLice = precis[0] && precis[0].score >= SEUIL_PRECIS ? precis : scores;
  const [premier, second] = enLice;
  if (!premier || premier.score < 2) {
    return { nature: "AUTRE", confiance: 0, indices: premier ? [`indice isolé : ${premier.liste.map((i) => i.libelle).join(", ")} (${nom(premier.nature)})`] : ["aucun indice de nature"] };
  }
  if (second && second.score >= premier.score) {
    return {
      nature: "AUTRE",
      confiance: 0,
      indices: [`hésitation entre ${nom(premier.nature)} et ${nom(second.nature)} (${premier.score} points chacun)`, ...premier.liste.map((i) => i.libelle), ...second.liste.map((i) => i.libelle)],
    };
  }

  const libelles = premier.liste.map((i) => i.libelle);
  let confiance = confianceDe(premier.score);
  if (premier.nature === "PASSEPORT" && libelles.includes("chiffres de contrôle MRZ cohérents")) confiance = Math.max(confiance, 0.97);
  if (premier.liste.length < 2) confiance = Math.min(confiance, 0.75);
  if (second && second.score >= 2 && second.score >= premier.score - 1) {
    confiance = Math.min(confiance, 0.6);
    libelles.push(`proche de : ${nom(second.nature)} (${second.score} points contre ${premier.score})`);
  }
  return { nature: premier.nature, confiance, indices: libelles };
}
