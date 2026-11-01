import { lireReponseAgenda, type Forme, type Impact } from "./agenda";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLASSER CE QUE LA PERSONNE DIT PENDANT UN TRAVAIL (lot O1, décision 0046) — les RÈGLES. Pur, navigateur compris.
 *
 * Direction : « Des fois il me pose une question, c'est une précision : là il doit vraiment la considérer comme une
 * précision. Des fois je dis des choses qui n'ont rien à voir : là oui, un travail en parallèle — mais ça dépend, c'est à
 * LUI d'orchestrer tout ça. » Trois natures :
 *   • `precision` — une réponse ou une précision du travail en cours, avec son IMPACT : MAJEUR (périmètre, période,
 *     données, raisonnement — réinjecté dans le travail) ou MINEUR (forme, format, ton, longueur, destinataire —
 *     appliqué au rendu, sans relance) ;
 *   • `autre_demande` — indépendante du travail : elle part EN PARALLÈLE ;
 *   • `conversation` — ce qui se dit en attendant (« merci », « c'est long ? ») : on répond, rien n'est lancé.
 *
 * DÉTERMINISTE QUAND C'EST ÉVIDENT (`classerSansModele`) : la réponse à la question posée, un choix proposé, une
 * consigne de forme, une politesse. SINON un classifieur bon marché (rôle `rapide`, sortie JSON stricte, entrée courte)
 * tranche — consigne et lecture ici, l'appel dans `infra/orchestration/classement.ts`. Jamais « précision par défaut » :
 * une phrase ambiguë va au classifieur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureEnonce = "precision" | "autre_demande" | "conversation";

export interface Classement {
  nature: NatureEnonce;
  /** Pour une précision ; `null` sinon. */
  impact: Impact | null;
  forme: Forme | null;
  /** La précision reformulée en une ligne (ce qui sera transmis ou appliqué). */
  consigne: string;
  /** D'où vient la décision : une règle, le classifieur, ou le repli quand le classifieur n'a pas répondu. */
  source: "regle" | "classifieur" | "repli";
  /** C'est la réponse à la question posée (son élément d'agenda). */
  repondA?: string;
}

const sansAccents = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const normaliser = (t: string) => sansAccents(t).replace(/[.!?,;]+/g, " ").replace(/\s+/g, " ").trim();

const POLITESSE = /^(merci( beaucoup)?|ok( merci)?|d'accord|super|parfait|top|cool|tres bien|bien recu|ca marche|nickel|genial|bravo|chokran|saha)$/;
const FICHIER = /\ben (pdf|excel|word|powerpoint|pptx|docx|xlsx|csv)\b/;
const FORME_TEXTE = /\b(plus court|plus courte|plus long|plus longue|en bref|resume|resumer|plus detaill\w*|en tableau|en liste|a puces|en points|ton (plus )?(formel|direct|simple)|plus formel|plus simple|en anglais|en arabe|en francais|vouvoie|tutoie|en une phrase|en quelques lignes)\b/;
const ENVOI = /^(envoie[- ]le|envoie[- ]la|transmets[- ]le|transmets[- ]la|partage[- ]le)\s+(a|au|aux)\s+\S+/;

/**
 * Les cas ÉVIDENTS, sans modèle. `null` : ambigu — au classifieur. `question` : l'élément d'agenda posé (s'il y en a un).
 */
export function classerSansModele(enonce: string, question: { id: string; cle: string; choix: string[]; impact: Impact; forme: Forme | null } | null): Classement | null {
  const t = normaliser(enonce);
  if (!t) return null;
  // LA RÉPONSE À LA QUESTION POSÉE : un choix proposé reconnu, ou un format dit pour la question du format.
  if (question) {
    const lu = lireReponseAgenda(question, enonce);
    const choisi = question.choix.includes(lu.valeur) || (question.cle === "format" && FICHIER.test(` en ${t}`) && t.split(" ").length <= 4);
    if (choisi || (lu.sansEffet && t.split(" ").length <= 4)) {
      return { nature: "precision", impact: question.impact, forme: question.forme, consigne: lu.valeur, source: "regle", repondA: question.id };
    }
  }
  if (POLITESSE.test(t)) return { nature: "conversation", impact: null, forme: null, consigne: enonce.trim(), source: "regle" };
  const court = t.split(" ").length <= 8;
  if (court && FICHIER.test(t)) return { nature: "precision", impact: "mineur", forme: "fichier", consigne: enonce.trim(), source: "regle" };
  if (court && FORME_TEXTE.test(t)) return { nature: "precision", impact: "mineur", forme: "texte", consigne: enonce.trim(), source: "regle" };
  if (court && ENVOI.test(t)) return { nature: "precision", impact: "mineur", forme: "destinataire", consigne: enonce.trim(), source: "regle" };
  return null;
}

/** La consigne du classifieur — courte : il ne voit que la demande en cours, la question posée et l'énoncé. */
export const CONSIGNE_CLASSEMENT = [
  "Tu classes UN énoncé dit par une personne pendant qu'un assistant travaille sur une demande. Réponds UNIQUEMENT par un objet JSON, sans texte autour :",
  '{"nature":"precision"|"autre_demande"|"conversation","impact":"majeur"|"mineur"|null,"forme":"texte"|"fichier"|"destinataire"|null,"consigne":"…"}',
  "- precision : l'énoncé précise, corrige ou complète la demande EN COURS (ou répond à la question posée).",
  "  impact majeur : il change le périmètre, la période, les données à chercher ou le raisonnement.",
  "  impact mineur : il change seulement la forme du rendu — format de fichier (forme fichier), ton, longueur, présentation (forme texte), à qui l'envoyer (forme destinataire).",
  "- autre_demande : une demande indépendante de la demande en cours (elle sera traitée en parallèle).",
  "- conversation : un échange qui ne demande rien (remerciement, impatience, question sur l'avancement).",
  "consigne : la précision reformulée en une phrase courte (pour une précision) ; sinon l'énoncé tel quel.",
].join("\n");

/** L'entrée du classifieur — bornée. */
export function entreeClassement(d: { demandeEnCours: string; question: string | null; enonce: string }): string {
  return JSON.stringify({ demande_en_cours: d.demandeEnCours.slice(0, 600), question_posee: d.question?.slice(0, 200) ?? null, enonce: d.enonce.slice(0, 400) });
}

/** LIRE la sortie du classifieur — JSON strict, valeurs connues ; sinon `null` (le repli décide, et c'est journalisé). */
export function lireClassement(sortie: string): Omit<Classement, "source"> | null {
  const brut = sortie.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let o: Record<string, unknown>;
  try { o = JSON.parse(brut) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const nature = o.nature;
  if (nature !== "precision" && nature !== "autre_demande" && nature !== "conversation") return null;
  const consigne = typeof o.consigne === "string" ? o.consigne.trim().slice(0, 300) : "";
  if (nature !== "precision") return { nature, impact: null, forme: null, consigne };
  const impact = o.impact === "mineur" ? "mineur" : o.impact === "majeur" ? "majeur" : null;
  if (!impact) return null;
  const forme = impact === "mineur" ? (o.forme === "fichier" || o.forme === "destinataire" ? o.forme : "texte") : null;
  return { nature, impact, forme, consigne: consigne || "" };
}

// ─── LE REPLI (classifieur muet ou illisible) ─────────────────────────────────────────────

const AMORCE_PRECISION = /^(plutot|et aussi|aussi|en fait|seulement|juste|uniquement|surtout|sauf|sans|avec|mais|non|enfin|precise|ajoute|rajoute|pour|sur|en|a partir|depuis|et pour|et sur|et en|et le|et la|et les)\b/;
const DEMANDE = /\b(donne|donne-moi|montre|affiche|dis-moi|combien|est-ce que|quel|quelle|quels|quelles|qui|ou en est|fais|fait|prepare|redige|envoie|cherche|trouve|calcule|compare|liste|cree|ajoute une?|programme|rappelle|planifie|ouvre|resume|explique|traduis|lance|verifie|regarde)\b/;

/**
 * LE REPLI — seulement quand le classifieur n'a pas répondu (panne, IA coupée, sortie illisible) : une règle de mots,
 * dite comme telle (`source: "repli"`). Un complément (« plutôt sur 2025 ») précise ; une demande (verbe d'action,
 * question) est une autre demande ; sinon, une précision majeure.
 */
export function classerParRepli(enonce: string): Classement {
  const t = normaliser(enonce);
  const autre = !AMORCE_PRECISION.test(t)
    && !(t.split(" ").length <= 4 && !enonce.includes("?") && !/\b(combien|quel|quelle|qui|ou en est)\b/.test(t))
    && (DEMANDE.test(t) || /\?\s*$/.test(enonce.trim()));
  return autre
    ? { nature: "autre_demande", impact: null, forme: null, consigne: enonce.trim(), source: "repli" }
    : { nature: "precision", impact: "majeur", forme: null, consigne: enonce.trim(), source: "repli" };
}

/**
 * LA VOIE D'UN MESSAGE ÉCRIT selon son classement : une précision ne part pas comme un nouveau tour (elle est gardée et
 * appliquée au travail) ; une autre demande ou une conversation pendant un travail LONG n'attend pas derrière lui ;
 * sinon la file habituelle (le deuxième message attend le premier et voit sa réponse).
 */
export function voieDuClassement(c: Classement, d: { travailEnCoursDepuisMs: number | null; questionEnAttente: boolean; travailLongMs: number }): "precision" | "parallele" | "suite" {
  if (c.nature === "precision" && (d.travailEnCoursDepuisMs != null || d.questionEnAttente)) return "precision";
  if (d.travailEnCoursDepuisMs != null && d.travailEnCoursDepuisMs >= d.travailLongMs) return "parallele";
  return "suite";
}
