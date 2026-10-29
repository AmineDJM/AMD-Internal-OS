/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE DE DEVIS EN LETTRE — ce que reçoit l'agence (Direction, 07/10).
 *
 * « Une demande générique (Word/PDF) en mode : bonjour, nous aimerions avoir un devis sur la conception, l'achat… de 500
 * pièces de lingettes ; document avec en-tête. » Luna la rédige (palier économique) ; ce module tient sa FORME et ses
 * GARDE-FOUS, sans rien importer :
 *
 *   • `lettreDeSecours` — la même lettre, écrite sans modèle : l'aperçu du formulaire, et le repli quand Luna se tait ;
 *   • `lettreValide` — ce qu'on accepte de Luna : une puce PAR article, chaque QUANTITÉ recopiée telle quelle. Un modèle
 *     qui « arrondit » 500 en 5 000, ou oublie un article, ne part pas chez l'agence : on prend la lettre de secours ;
 *   • `texteDeLaLettre` — la lettre à plat (aperçu, description de la demande au secrétariat).
 *
 * PUR : aucun import — l'aperçu du navigateur et le serveur lisent la même rédaction (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La clé d'étape (`Document.stepKey`) des lettres de demande de devis déposées sur un dossier ou un poste. */
export const ETAPE_DEMANDE_DEVIS = "DEMANDE_DEVIS";

export interface ArticleADeviser {
  /** « Cadeaux fin d'année », « Brochure Cardiomax A4 »… */
  designation: string;
  quantite: number | null;
  /** « pièce », « exemplaire »… */
  unite: string | null;
  /** Les prestations attendues, en libellés : « Conception », « Impression »… */
  prestations: string[];
  /** La précision du demandeur : « lingettes désinfectantes brandées Adventum en boîtes ». */
  precision: string | null;
  /** Les produits ou gammes promus. */
  produits: string[];
}

export interface LettreDevis {
  objet: string;
  introduction: string;
  /** Une puce par article, dans l'ordre. */
  puces: string[];
  /** Ce qu'on demande de préciser dans l'offre (prix HT, TVA, délai…). */
  precisions: string[];
  conclusion: string;
}

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 }).replace(/ | /g, " ");

/** « a », « a et b », « a, b et c ». */
export function enumerer(xs: readonly string[]): string {
  const v = xs.map((x) => x.trim()).filter(Boolean);
  if (v.length <= 1) return v[0] ?? "";
  return `${v.slice(0, -1).join(", ")} et ${v[v.length - 1]}`;
}

/** Ce qu'on demande à l'agence, dans les mots d'une lettre : « Achat » → « la fourniture ». */
const PRESTATION_EN_LETTRE: Record<string, string> = {
  conception: "la conception",
  impression: "l'impression",
  fabrication: "la fabrication",
  achat: "la fourniture",
  location: "la location",
  livraison: "la livraison",
  installation: "l'installation",
  "autre prestation": "la prestation",
};

const prestationEnLettre = (p: string): string => PRESTATION_EN_LETTRE[p.trim().toLowerCase()] ?? p.trim().toLowerCase();

const pluriel = (unite: string, n: number): string => (n > 1 && !/[sxz]$/i.test(unite) ? `${unite}s` : unite);

/** La quantité telle qu'elle doit figurer dans la puce : « 500 pièces ». `null` sans quantité. */
export function quantiteEnLettre(a: Pick<ArticleADeviser, "quantite" | "unite">): string | null {
  if (a.quantite == null) return null;
  return `${nombre(a.quantite)} ${pluriel((a.unite ?? "unité").trim() || "unité", a.quantite)}`;
}

/** Une puce sans modèle : « la conception, l'impression et la fourniture de 500 pièces « Cadeaux fin d'année » — … ». */
export function puceDeSecours(a: ArticleADeviser): string {
  const quoi = a.prestations.length ? enumerer(a.prestations.map(prestationEnLettre)) : "la fourniture";
  const qte = quantiteEnLettre(a);
  const precision = a.precision?.trim().replace(/^["«»“”\s]+|["«»“”\s]+$/g, "");
  return [
    `${quoi} de ${qte ? `${qte} « ${a.designation} »` : `« ${a.designation} »`}`,
    precision ? ` — ${precision}` : "",
    a.produits.length ? ` (produits promus : ${enumerer(a.produits)})` : "",
  ].join("");
}

export const PRECISIONS_STANDARD: readonly string[] = [
  "le prix unitaire et le montant total hors taxes, ainsi que la TVA applicable",
  "le délai de réalisation et de livraison",
  "la durée de validité de votre offre",
];

/** La lettre complète sans modèle — l'aperçu, et le repli quand Luna ne répond pas ou répond faux. */
export function lettreDeSecours(d: { titre: string; articles: readonly ArticleADeviser[]; brief?: string | null }): LettreDevis {
  const imprime = d.articles.some((a) => a.prestations.some((p) => /conception|impression/i.test(p)));
  return {
    objet: `Demande de devis — ${d.titre}`,
    introduction: d.articles.length > 1
      ? "Nous vous remercions de bien vouloir nous adresser votre meilleure offre pour les prestations suivantes :"
      : "Nous vous remercions de bien vouloir nous adresser votre meilleure offre pour la prestation suivante :",
    puces: d.articles.map(puceDeSecours),
    precisions: [...PRECISIONS_STANDARD, ...(imprime ? ["les délais de remise du bon à tirer (BAT)"] : [])],
    conclusion: d.brief?.trim()
      ? `Pour votre information : ${d.brief.trim()} Nous restons à votre disposition pour tout complément.`
      : "Nous restons à votre disposition pour tout complément d'information.",
  };
}

const texte = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/** Les chiffres d'une phrase, collés : « 1 500 pièces » → « 1500 ». */
const chiffres = (s: string): string => s.replace(/[\s  .]/g, "");

/** Les NOMBRES d'une phrase, entiers — « 5 000 boîtes » donne 5000, jamais 500. */
const nombresDe = (s: string): string[] => (s.match(/\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g) ?? []).map(chiffres);

/**
 * CE QU'ON ACCEPTE DE LUNA — sinon `null`, et la lettre de secours part à la place.
 * Une puce par article, dans l'ordre ; chaque quantité y figure telle quelle ; chaque champ a une longueur raisonnable.
 */
export function lettreValide(brut: unknown, articles: readonly ArticleADeviser[]): LettreDevis | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as Record<string, unknown>;
  const objet = texte(o.objet, 200);
  const introduction = texte(o.introduction, 600);
  const conclusion = texte(o.conclusion, 600);
  if (!objet || !introduction || !conclusion) return null;
  if (!Array.isArray(o.puces) || o.puces.length !== articles.length) return null;
  const puces = o.puces.map((p) => texte(p, 500));
  if (puces.some((p) => p === null)) return null;
  for (let i = 0; i < articles.length; i++) {
    const q = articles[i].quantite;
    if (q != null && !nombresDe(puces[i] as string).includes(chiffres(nombre(q)))) return null;
  }
  const precisions = Array.isArray(o.precisions) ? o.precisions.map((p) => texte(p, 300)).filter((p): p is string => p !== null).slice(0, 8) : [];
  return { objet, introduction, puces: puces as string[], precisions: precisions.length ? precisions : [...PRECISIONS_STANDARD], conclusion };
}

/** La lettre à plat — l'aperçu du formulaire, et la description de la demande au secrétariat. */
export function texteDeLaLettre(l: LettreDevis): string {
  return [
    `Objet : ${l.objet}`,
    "Madame, Monsieur,",
    l.introduction,
    l.puces.map((p) => `• ${p}`).join("\n"),
    l.precisions.length ? `Merci de préciser dans votre offre :\n${l.precisions.map((p) => `• ${p}`).join("\n")}` : null,
    l.conclusion,
    "Nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.",
  ].filter((x): x is string => Boolean(x)).join("\n\n");
}
