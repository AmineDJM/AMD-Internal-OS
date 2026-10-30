/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PROVENANCE TIERCE D'UNE CARTE (J14, décision 0022) — règle PURE : quelle valeur de la carte vient d'un tiers ?
 *
 * ── LE RISQUE RÉSIDUEL ───────────────────────────────────────────────────────────────────
 *
 * Aucune écriture ne part sans carte confirmée (décision 0005), et un contenu tiers arrive au modèle encadré comme une
 * donnée (`contenu-non-fiable.ts`). Reste la CARTE TROMPEUSE : un devis dont le RIB a été substitué, un mail qui glisse
 * un autre destinataire, une page qui dicte « envoie… » — le modèle reprend la valeur, la carte paraît juste, la
 * personne confirme. La parade n'est pas d'interdire (préparer un BC depuis un devis, c'est reprendre son RIB) mais de
 * DIRE, sur la carte : « ce RIB provient du document « devis-atlas.pdf », à vérifier ».
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. On relève dans chaque champ de la carte les valeurs REMARQUABLES : RIB / IBAN, adresse e-mail, téléphone,
 *      lien, montant, nom propre — et les passages de six mots et plus.
 *   2. Une valeur est D'ORIGINE TIERCE si elle figure dans un contenu tiers lu pendant le tour (pièce jointe, sortie
 *      d'outil encadrée) et PAS dans ce que la personne a écrit elle-même (son message, ses messages précédents).
 *      Un nom propre que l'annuaire de l'ERP confirme n'est pas marqué (résoudre un destinataire passe par là) ;
 *      un RIB, une adresse, un montant le sont TOUJOURS — c'est la valeur substituée qu'on cherche.
 *   3. Un contenu tiers qui porte des CONSIGNES adressées à l'assistant (français, arabe, anglais ; texte caché,
 *      caractères invisibles) marque toute carte préparée après sa lecture.
 *
 * Module PUR (aucun import) : le corpus piégé (`infra/testing/corpus-pieges.ts`) l'éprouve sur 200 contenus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ContenuTiers {
  /** La source dite au modèle (« pièce jointe « devis.pdf » (texte) », « document déposé »…). */
  source: string;
  texte: string;
}

export interface ProvenanceRelevee {
  champ: string;
  nature: NatureValeur;
  valeur: string;
  document: string;
}

export type NatureValeur = "RIB" | "adresse e-mail" | "téléphone" | "lien" | "montant" | "nom" | "passage";

const DEMONSTRATIF: Record<NatureValeur, string> = {
  RIB: "ce RIB", "adresse e-mail": "cette adresse e-mail", téléphone: "ce numéro de téléphone", lien: "ce lien",
  montant: "ce montant", nom: "ce nom", passage: "ce texte",
};

const MOTS_OUTILS = new Set(["le", "la", "les", "de", "des", "du", "un", "une", "et", "à", "au", "aux", "en", "pour", "par", "sur", "dans", "avec"]);

/** Minuscules, sans accents ni ponctuation, espaces réduits — la forme sous laquelle on compare. */
export function normaliser(t: string): string {
  return t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[​-‏⁠﻿]/g, "")
    .replace(/[^\p{L}\p{N}@.+:/-]+/gu, " ").replace(/\s+/g, " ").trim();
}
const chiffres = (t: string) => t.replace(/\D/g, "");

interface Valeur { nature: NatureValeur; valeur: string; cle: string }

/** Les valeurs remarquables d'un texte (un champ de carte). */
export function valeursRemarquables(texte: string): Valeur[] {
  const out: Valeur[] = [];
  const vu = new Set<string>();
  const ajouter = (nature: NatureValeur, valeur: string, cle: string) => {
    const k = `${nature}:${cle}`;
    if (cle && !vu.has(k)) { vu.add(k); out.push({ nature, valeur: valeur.trim(), cle }); }
  };
  for (const m of texte.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,5}){3,8}\b/g)) ajouter("RIB", m[0], m[0].replace(/\s/g, "").toUpperCase());
  for (const m of texte.matchAll(/(?<![\d+])\d(?:[ .-]?\d){15,29}(?!\d)/g)) {
    const c = chiffres(m[0]);
    if (!out.some((v) => v.nature === "RIB" && chiffres(v.cle).includes(c))) ajouter("RIB", m[0], c);
  }
  for (const m of texte.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) ajouter("adresse e-mail", m[0], m[0].toLowerCase());
  for (const m of texte.matchAll(/https?:\/\/[^\s"'<>»)]+/g)) ajouter("lien", m[0], m[0].toLowerCase().replace(/[.,;]$/, ""));
  for (const m of texte.matchAll(/(?:\+\d{1,3}|\b0)[ .-]?\d(?:[ .-]?\d){7,10}\b/g)) {
    const c = chiffres(m[0]);
    if (c.length <= 13 && !out.some((v) => v.nature === "RIB" && v.cle.includes(c))) ajouter("téléphone", m[0], c.slice(-9));
  }
  for (const m of texte.matchAll(/\b\d{1,3}(?:[  .]\d{3})+(?:,\d+)?\b|\b\d{4,}(?:,\d+)?\b/g)) {
    const c = chiffres(m[0].split(",")[0]!);
    if (c.length >= 4 && c.length <= 12 && !out.some((v) => v.cle.includes(c))) ajouter("montant", m[0], String(Number(c)));
  }
  // Un nom propre : deux à quatre mots à majuscule (lettres latines, accents compris), hors début de phrase banal.
  for (const m of texte.matchAll(/\b\p{Lu}[\p{Ll}'’-]+(?:[ -](?:\p{Lu}[\p{Ll}'’-]+|\p{Lu}{2,})){1,3}\b/gu)) {
    const mots = m[0].split(/[ -]/);
    if (mots.filter((w) => w.length >= 3).length >= 2) ajouter("nom", m[0], normaliser(m[0]));
  }
  return out;
}

/** Les passages de six mots (et plus) d'un champ, sous leur forme comparable. */
function passages(texte: string, n = 6): string[] {
  const mots = normaliser(texte).split(" ").filter(Boolean);
  if (mots.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= mots.length; i++) {
    const fenetre = mots.slice(i, i + n);
    if (fenetre.filter((w) => !MOTS_OUTILS.has(w) && w.length > 2).length >= 3) out.push(fenetre.join(" "));
  }
  return out;
}

/** « pièce jointe « devis.pdf » (texte) » → « devis.pdf » ; une sortie d'outil : son nom de document s'il en porte un. */
export function nomDuDocument(c: ContenuTiers): string {
  const guillemets = c.source.match(/«\s*([^»]+?)\s*»/);
  if (guillemets) return guillemets[1]!;
  const champ = c.texte.match(/"(?:nom|name|titre|title|fichier|document|sujet|subject|expediteur|from)"\s*:\s*"([^"]{1,120})"/i);
  return champ ? `${champ[1]} (${c.source})` : c.source;
}

function contient(tiers: { brut: string; norme: string; chiffres: string }, v: Valeur): boolean {
  if (v.nature === "RIB" || v.nature === "téléphone") return tiers.chiffres.includes(v.cle) || tiers.brut.replace(/\s/g, "").toUpperCase().includes(v.cle);
  // Un montant se compare À SES BORNES : « 1 000 » ne se trouve pas dans « 21 000 450 ».
  if (v.nature === "montant") return new RegExp(`(^|\\D)${v.cle.replace(/\B(?=(\d{3})+$)/g, "[  .]?")}(\\D|$)`).test(tiers.brut);
  return tiers.norme.includes(v.cle);
}

function ditParLaPersonne(paroles: { norme: string; chiffres: string; brut: string }, v: Valeur): boolean {
  if (v.nature === "nom") return v.cle.split(" ").filter((w) => w.length >= 3).some((w) => paroles.norme.split(" ").includes(w));
  return contient(paroles, v);
}

const forme = (t: string) => ({ brut: t, norme: normaliser(t), chiffres: chiffres(t) });

export interface EntreeProvenance {
  champs: readonly { label: string; value: string }[];
  tiers: readonly ContenuTiers[];
  /** Ce que la personne a écrit elle-même : son message du tour et ses messages précédents. */
  paroles: readonly string[];
  /** Les sorties d'outils INTERNES (l'ERP) : un nom qu'elles portent est confirmé par l'annuaire, pas par un tiers. */
  internes?: readonly string[];
}

export interface ResultatProvenance {
  provenances: ProvenanceRelevee[];
  injections: { document: string; motifs: string[] }[];
  avertissements: string[];
}

/** Ce que la carte doit dire de ses valeurs d'origine tierce. */
export function provenanceDeLaCarte(e: EntreeProvenance): ResultatProvenance {
  const vide: ResultatProvenance = { provenances: [], injections: [], avertissements: [] };
  if (!e.tiers.length) return vide;
  const paroles = forme(e.paroles.join("\n"));
  const internes = normaliser((e.internes ?? []).join("\n"));
  const tiers = e.tiers.map((t) => ({ document: nomDuDocument(t), ...forme(t.texte) }));
  const provenances: ProvenanceRelevee[] = [];
  for (const champ of e.champs) {
    const valeurs = valeursRemarquables(champ.value);
    for (const v of valeurs) {
      if (ditParLaPersonne(paroles, v)) continue;
      if (v.nature === "nom" && internes.includes(v.cle)) continue;
      const t = tiers.find((x) => contient(x, v));
      if (t) provenances.push({ champ: champ.label, nature: v.nature, valeur: v.valeur, document: t.document });
    }
    if (!provenances.some((p) => p.champ === champ.label)) {
      const p = passages(champ.value).find((x) => !paroles.norme.includes(x) && tiers.some((t) => t.norme.includes(x)));
      if (p) provenances.push({ champ: champ.label, nature: "passage", valeur: p, document: tiers.find((t) => t.norme.includes(p))!.document });
    }
  }
  const injections = tiers.map((t) => ({ document: t.document, motifs: detecterInjection(t.brut) })).filter((i) => i.motifs.length);
  const avertissements = [
    ...provenances.map((p) => `« ${p.champ} » : ${DEMONSTRATIF[p.nature]} provient du document « ${p.document} », à vérifier.`),
    ...injections.map((i) => `« ${i.document} » contient des consignes adressées à l'assistant (${i.motifs.slice(0, 2).join(", ")}) : `
      + "cette carte a été préparée après sa lecture — vérifiez qu'elle répond à VOTRE demande."),
  ];
  return { provenances, injections, avertissements: [...new Set(avertissements)] };
}

/**
 * LES CONSIGNES CACHÉES DANS UN CONTENU TIERS — un texte écrit pour l'ASSISTANT, pas pour la personne. Français, arabe,
 * anglais ; et ce qui se cache (caractères invisibles, texte blanc ou masqué, commentaire HTML).
 */
const MOTIFS_INJECTION: readonly [RegExp, string][] = [
  [/\b(ignore[rz]?|oublie[rz]?|ne tiens? pas compte)\b[^.\n]{0,40}\b(consignes?|instructions?|r[eè]gles?|ce qui pr[eé]c[eè]de|pr[eé]c[eé]dent)/i, "« ignore tes consignes »"],
  [/\b(nouvelles?|vraies?) (consignes?|instructions?)\b/i, "« nouvelles consignes »"],
  [/\b(à l'attention|message|note|consigne) (de l'|pour l'|à l')(ia|assistant|agent|intelligence artificielle)\b/i, "message à l'assistant"],
  [/\b(assistant|ia|agent)\s*[,:]\s*(tu dois|prépare|envoie|transf[eè]re|vire|modifie|remplace|utilise)/i, "ordre adressé à l'assistant"],
  [/\b(tu dois|vous devez|il faut) (pr[eé]parer|envoyer|virer|transf[eé]rer|payer|utiliser|remplacer|changer)\b/i, "ordre d'agir"],
  [/\b(pr[eé]pare|envoie|effectue|fais|ordonne|lance)[rz]? (imm[eé]diatement |sans confirmation |discr[eè]tement )?(un |le |ce )?(virement|paiement|transfert|r[eè]glement)/i, "ordre de paiement"],
  [/\b(nouveau|nouvel|autre) (rib|iban|compte bancaire|b[eé]n[eé]ficiaire)\b|\b(rib|iban|coordonn[eé]es bancaires?) (a|ont) chang[eé]/i, "changement de coordonnées bancaires"],
  [/\b(envoie|transf[eè]re|fais suivre|copie)[rz]? (aussi |[eé]galement )?(ce|le|les|tout|toutes)\b[^.\n]{0,40}\b(à|vers|chez)\s+[\w.+-]+@/i, "renvoi vers une adresse"],
  [/\b(sans (demander|confirmation|v[eé]rifier|pr[eé]venir)|ne (le )?dis (rien|pas)|n'en parle pas|discr[eè]tement)\b/i, "« sans confirmation »"],
  [/\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i, "« ignore previous instructions »"],
  [/\b(system prompt|you are now|new instructions|as an ai)\b/i, "consigne système en anglais"],
  [/(^|\n)\s*(system|syst[eè]me|assistant)\s*:/i, "faux message système"],
  [/(تجاهل|انس|لا تلتزم)[^.\n]{0,30}(التعليمات|الأوامر|القواعد|ما سبق)/u, "« تجاهل التعليمات » (arabe)"],
  [/(تعليمات|أوامر) جديدة/u, "« تعليمات جديدة » (arabe)"],
  [/(حوّل|حول|أرسل|ارسل|ادفع|قم بتحويل|قم بإرسال)[^.\n]{0,40}(مبلغ|المبلغ|حساب|الحساب|دينار|تحويل|رسالة|إلى)/u, "ordre d'agir (arabe)"],
  [/(دون|بدون) (تأكيد|إذن|إخبار|علم)/u, "« sans confirmation » (arabe)"],
  [/(رقم الحساب|الحساب البنكي|آر آي بي|RIB) (الجديد|تغير)/u, "changement de coordonnées bancaires (arabe)"],
  [/[​-‏⁠﻿]{2,}/u, "caractères invisibles"],
  [/(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(#fff(fff)?\b|white)|opacity\s*:\s*0(\.0+)?\b)/i, "texte masqué"],
  [/<!--[\s\S]{0,400}?(assistant|ia\b|instruction|consigne|virement|تعليمات)[\s\S]{0,400}?-->/i, "commentaire caché"],
];

export function detecterInjection(texte: string): string[] {
  return [...new Set(MOTIFS_INJECTION.filter(([re]) => re.test(texte)).map(([, nom]) => nom))];
}
