/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AGENDA DE CONVERSATION — les RÈGLES (lot O1, décision 0046). Pur, navigateur compris.
 *
 * Pendant qu'un travail tourne, la conversation reste FLUIDE et UTILE jusqu'au résultat (Direction : « pas des questions
 * au hasard » ; puis « au plus 2 précisions : bah ça dépend »). L'agenda se DÉRIVE de la demande, sans appel de modèle,
 * et n'a pas de plafond fixe : tout ce qui a une vraie valeur pour CE genre de demande, une chose à la fois —
 *   • les PRÉCISIONS qui changent le résultat (format, période, niveau de détail) — jamais ce que la demande dit déjà ;
 *   • les APPROFONDISSEMENTS que la personne voudra probablement (comparaison, ventilation, points de vigilance) ;
 *   • l'ÉTAPE SUIVANTE à décider (« je l'envoie à quelqu'un ? ») ;
 *   • les résultats PARTIELS (sous-missions finies), ajoutés par le serveur au fil du travail.
 * Chaque élément porte son IMPACT : MAJEUR (périmètre, période, données, raisonnement → réinjecté dans le travail) ou
 * MINEUR (forme, format, ton, longueur, destinataire → appliqué au rendu, sans relance).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe d'une précision ÉCRITE transmise au travail (la voix garde le sien, qui demande une réponse pour l'oreille). */
export const PREFIXE_PRECISION_ECRITE = "[Précision du travail en cours]";
/** Le préfixe d'un tour de MISE EN FORME : le résultat prêt, rendu autrement (fichier, carte d'envoi) — sans recherche. */
export const PREFIXE_MISE_EN_FORME = "[Mise en forme du résultat]";

export type CleAgenda = "format" | "periode" | "detail" | "comparaison" | "ventilation" | "vigilance" | "destinataire";

/** MAJEUR : change ce que le travail cherche ou raisonne. MINEUR : change seulement la façon de le rendre. */
export type Impact = "majeur" | "mineur";
/** Pour un mineur : `texte` (ton, longueur, présentation), `fichier` (PDF, Excel…), `destinataire` (à qui l'envoyer). */
export type Forme = "texte" | "fichier" | "destinataire";

export interface GabaritAgenda {
  cle: CleAgenda;
  nature: "precision" | "suite";
  question: string;
  choix: string[];
  impact: Impact;
  forme: Forme | null;
}

/**
 * LES RÉGLAGES DE L'ORCHESTRATION — des seuils de déclenchement, pas des plafonds de conversation (Direction : « ça
 * dépend »). Le serveur les relit de l'environnement (`ASSISTANT_O1_*`) ; ces valeurs sont les défauts.
 */
export const REGLAGES_ORCHESTRATION = {
  /** À l'écrit, l'agenda s'ouvre quand le travail tourne depuis ce temps (une réponse rapide n'a pas de question). */
  agendaEcritApresMs: 4_000,
  /** À l'écrit, au-delà, une autre demande ou une conversation n'attend plus le travail : voie parallèle. */
  travailLongMs: 8_000,
  /** À l'oral, une question sans réponse depuis ce temps n'est plus « en attente ». */
  questionExpireMs: 20_000,
} as const;

const sansAccents = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const LIVRABLE = /\b(rapport|export\w*|tableau|liste|fichier|document|synthese|bilan|recapitulatif|compte rendu|presentation|note de synthese|etat des)\b/;
const FORMAT_DIT = /\b(excel|xlsx|csv|pdf|word|docx|pptx|powerpoint|tableur)\b/;
const DONNEES_DATEES = /\b(ventes?|chiffre d'affaires|achats?|depenses?|stocks?|commandes?|factur\w*|encaissements?|recouvrements?|visites?|marges?|consommation|production|performances?|evolution|creances?|paiements?|livraisons?|absences?|conges?)\b/;
const PERIODE_DITE = /\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|20\d\d|aujourd'hui|hier|demain|semaine|mois|trimestre|t[1-4]|annee|an dernier|depuis|entre|du \d|cette|ce mois|derniers?|dernieres?|en cours|actuel\w*|a date|jour)\b/;
const ANALYSE = /\b(rapport|synthese|analyse|bilan|etude|recherche|veille|audit)\b/;
const DETAIL_DIT = /\b(bref|court|resume|detaill\w*|complet|exhaustif|grandes lignes|en une phrase|rapide\w*|en gros|precis\w*)\b/;
const ENVOI_DIT = /\b(envoie|envoyer|transmets?|transmettre|partage|partager|mail|courriel|whatsapp|pour (le|la|les|mon|ma|mes) \w+|a l'equipe)\b/;
/** P1 (décision 0047) : écrire un MAIL n'est pas un livrable à cadrer — la carte « Envoyer » part sans question (Direction, 02/11). */
const MAIL = /\b(e-?mails?|mails?|courriels?|gmail)\b/;
const COMPARAISON_DITE = /\b(compar\w*|evolution|vs|versus|par rapport|n-1|l'an dernier|annee derniere)\b/;
const VENTILATION_DITE = /\bpar (produit|produits|wilaya|wilayas|region|regions|client|clients|delegue|delegues|mois|gamme|famille|commercial|depot)\b/;
const VIGILANCE_DITE = /\b(risques?|vigilance|alertes?|anomalies?|ecarts?|problemes?)\b/;

/**
 * L'AGENDA D'UNE DEMANDE — déterministe : la même demande donne toujours les mêmes éléments, et aucun ne porte sur ce que
 * la demande dit déjà. Une demande courte et sans livrable (« combien de clients à Oran ? ») n'en a aucun. Sans plafond :
 * l'orchestrateur en dit UN à la fois, tant que le travail tourne ; un travail fini efface ce qui ne sert plus.
 */
export function construireAgenda(demande: string): GabaritAgenda[] {
  const d = sansAccents(demande);
  // « Envoie un mail à Redouane et Nesrine avec leur planning » : les mots du contenu (synthèse, planning) ne font pas une
  // demande de livrable — aucune question d'agenda, la carte d'envoi suffit (la personne corrige sur la carte).
  if (MAIL.test(d)) return [];
  const livrable = LIVRABLE.test(d);
  const datees = DONNEES_DATEES.test(d);
  const out: GabaritAgenda[] = [];
  if (livrable && !FORMAT_DIT.test(d)) {
    out.push({ cle: "format", nature: "precision", question: "Tu préfères un rendu Excel ou PDF ?", choix: ["Excel", "PDF", "Peu importe"], impact: "mineur", forme: "fichier" });
  }
  if (datees && !PERIODE_DITE.test(d)) {
    out.push({ cle: "periode", nature: "precision", question: "Sur quelle période : ce mois-ci, le trimestre ou l'année ?", choix: ["Ce mois-ci", "Le trimestre", "L'année"], impact: "majeur", forme: null });
  }
  if (ANALYSE.test(d) && !DETAIL_DIT.test(d)) {
    out.push({ cle: "detail", nature: "precision", question: "Tu veux les grandes lignes ou le détail complet ?", choix: ["Les grandes lignes", "Le détail"], impact: "mineur", forme: "texte" });
  }
  if (datees && (livrable || ANALYSE.test(d)) && !VENTILATION_DITE.test(d)) {
    out.push({ cle: "ventilation", nature: "precision", question: "Je le détaille par produit, par wilaya, ou le total suffit ?", choix: ["Par produit", "Par wilaya", "Le total suffit"], impact: "majeur", forme: null });
  }
  if (datees && !COMPARAISON_DITE.test(d)) {
    out.push({ cle: "comparaison", nature: "precision", question: "Tu veux que j'ajoute la comparaison avec la même période l'an dernier ?", choix: ["Oui, compare", "Non"], impact: "majeur", forme: null });
  }
  if (ANALYSE.test(d) && !VIGILANCE_DITE.test(d)) {
    out.push({ cle: "vigilance", nature: "precision", question: "Je signale aussi les points de vigilance — retards, ruptures, écarts ?", choix: ["Oui", "Non"], impact: "majeur", forme: null });
  }
  if (livrable && !ENVOI_DIT.test(d)) {
    out.push({ cle: "destinataire", nature: "suite", question: "Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ?", choix: ["C'est pour moi"], impact: "mineur", forme: "destinataire" });
  }
  return out;
}

/** « peu importe », « comme tu veux », « c'est pour moi », « non » : une réponse qui ne change rien au travail. */
const SANS_EFFET = /^(peu importe|comme tu veux|comme tu (le )?sens|n'importe|ca m'est egal|egal|pas d'importance|aucune importance|c'est pour moi|pour moi|personne|non|non merci|pas besoin|rien|laisse|garde[- ]le|je le garde|ok|d'accord|ca va|merci|super|parfait|top|cool|tres bien|bien recu|le total suffit)\b/;
const OUI = /^(oui|ouais|vas[- ]y|d'accord|ok|volontiers|bien sur|carrement|go|yallah|wakha|ih)\b/;

export interface LectureReponse {
  /** La valeur retenue — le choix reconnu, sinon les mots de la personne (bornés). */
  valeur: string;
  /** La réponse ne change pas le travail (« peu importe », « non ») : rien n'est transmis. */
  sansEffet: boolean;
}

/** LIRE la réponse à une question d'agenda. Un choix reconnu dans les mots de la personne l'emporte. */
export function lireReponseAgenda(g: { cle: string; choix: string[] }, texte: string): LectureReponse {
  const t = sansAccents(texte).replace(/[.!?,;]+/g, " ").replace(/\s+/g, " ").trim();
  // Une question oui / non (« Oui, compare » / « Non ») : un oui sans réserve choisit le premier.
  if (g.choix.length === 2 && /^oui/i.test(g.choix[0]) && g.choix[1] === "Non" && OUI.test(t)) return { valeur: g.choix[0], sansEffet: false };
  const choix = g.choix.find((c) => c !== "Peu importe" && new RegExp(`\\b${sansAccents(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  if (choix) return { valeur: choix, sansEffet: choix === "C'est pour moi" || choix === "Non" || choix === "Le total suffit" };
  if (g.cle === "format") {
    const f = t.match(/\b(excel|xlsx|csv|pdf|word|docx|powerpoint|pptx)\b/);
    if (f) return { valeur: f[1] === "xlsx" || f[1] === "csv" ? "Excel" : f[1] === "docx" ? "Word" : f[1] === "pptx" ? "PowerPoint" : f[1][0].toUpperCase() + f[1].slice(1), sansEffet: false };
  }
  if (SANS_EFFET.test(t)) return { valeur: texte.trim().slice(0, 80), sansEffet: true };
  return { valeur: texte.trim().slice(0, 200), sansEffet: false };
}

/** La PRÉCISION transmise au travail (majeur) ou portée sur son rendu (mineur) — une ligne, ce que la personne a choisi. */
export function precisionDeLaReponse(cle: string, valeur: string): string {
  switch (cle) {
    case "format": return `Format de rendu voulu : ${valeur}.`;
    case "periode": return `Période voulue : ${valeur}.`;
    case "detail": return `Niveau de détail voulu : ${valeur}.`;
    case "ventilation": return `Détail voulu : ${valeur.toLowerCase()}.`;
    case "comparaison": return "Ajoute la comparaison avec la même période l'an dernier.";
    case "vigilance": return "Signale aussi les points de vigilance (retards, ruptures, écarts).";
    case "destinataire": return `Quand c'est prêt, à envoyer à : ${valeur} (prépare la carte d'envoi avec le résultat ; rien ne part sans confirmation).`;
    default: return valeur.endsWith(".") ? valeur : `${valeur}.`;
  }
}

/** L'ACCUSÉ — court, la valeur redite : « Noté, PDF. » ; majeur : le travail en tient compte ; mineur : le rendu. */
export function accuseDeReponse(valeur: string, impact: Impact | null): string {
  if (impact === "majeur") return `Dis en quelques mots « Noté, ${valeur} » et que le travail en tient compte — sans résultat inventé.`;
  if (impact === "mineur") return `Dis en quelques mots « Noté, ${valeur} » : le résultat te sera rendu ainsi — sans résultat inventé.`;
  return `Dis en trois mots « Noté${valeur ? `, ${valeur}` : ""} » — sans résultat inventé.`;
}

// ─── L'AVANCEMENT ─────────────────────────────────────────────────────────────────────────

/** La médiane des durées passées (ms) — `null` sans historique. */
export function estimerDureeMs(durees: readonly number[]): number | null {
  const xs = durees.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < 3) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : Math.round((xs[m - 1] + xs[m]) / 2);
}

function dureeDite(ms: number): string {
  if (ms < 45_000) return `${Math.max(10, Math.round(ms / 10_000) * 10)} secondes`;
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m > 1 ? "s" : ""}`;
}

/**
 * OÙ ÇA EN EST — dit une fois quand l'agenda est vide : les étapes RÉELLES faites (« Annuaire consulté »), et la durée
 * estimée d'après les tours passés de la personne. Jamais une étape inventée, jamais un pourcentage fictif.
 */
export function phraseAvancement(d: { etapes: readonly string[]; ecouleMs: number; estimeMs: number | null; sousMissions?: { finies: number; total: number } | null }): string {
  const morceaux: string[] = [];
  if (d.etapes.length) morceaux.push(`${d.etapes.length} étape${d.etapes.length > 1 ? "s" : ""} faite${d.etapes.length > 1 ? "s" : ""} (dernière : ${d.etapes[d.etapes.length - 1].toLowerCase()})`);
  else morceaux.push("le travail a commencé");
  if (d.sousMissions && d.sousMissions.total) morceaux.push(`${d.sousMissions.finies} sous-mission${d.sousMissions.finies > 1 ? "s" : ""} finie${d.sousMissions.finies > 1 ? "s" : ""} sur ${d.sousMissions.total}`);
  if (d.estimeMs != null) {
    const reste = d.estimeMs - d.ecouleMs;
    morceaux.push(reste > 5_000 ? `d'habitude, encore environ ${dureeDite(reste)}` : "ça devrait arriver d'un instant à l'autre");
  }
  return `${morceaux.join(", ")}.`.replace(/^./, (c) => c.toUpperCase());
}

// ─── CE QUE L'ÉCRAN DU FIL LIT ─────────────────────────────────────────────────────────────

/** L'état d'orchestration d'un fil écrit, rendu à chaque lecture (`/api/assistant-ia/fil`). */
export interface OrchestrationFil {
  /** La question de l'agenda posée dans le fil, qui attend réponse. */
  question: { id: string; tourId: string; texte: string; choix: string[] } | null;
  /** Les réponses de l'assistant TENUES jusqu'à la réponse de la personne (identifiants de tours). */
  tenus: string[];
  /** Où en est le travail long (une phrase réelle), sous la réponse qui s'écrit. */
  avancement: { reponseId: string; texte: string } | null;
  /** Les réponses écrites AVANT une précision qui les change — la version ajustée suit. */
  ajustes: { reponseId: string; valeur: string }[];
}

/** Une précision transmise au travail, telle que l'écran la montre : sa première ligne, sans le préfixe. */
export function precisionAffichee(contenu: string): { quoi: string; texte: string } | null {
  for (const [prefixe, quoi] of [[PREFIXE_PRECISION_ECRITE, "Précision transmise au travail en cours"], [PREFIXE_MISE_EN_FORME, "Mise en forme demandée, d'après le résultat prêt"]] as const) {
    if (contenu.startsWith(prefixe)) return { quoi, texte: contenu.slice(prefixe.length).split("\n")[0].trim() };
  }
  return null;
}
