/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AGENDA DE CONVERSATION — les RÈGLES (lot O1, décision 0046). Pur, navigateur compris.
 *
 * Pendant qu'un travail tourne, la conversation doit être UTILE (Direction : « pas des questions au hasard »). L'agenda
 * se DÉRIVE de la demande elle-même, sans appel de modèle :
 *   • (a) les PRÉCISIONS qui changent le résultat — format de rendu, période, niveau de détail — posées seulement si la
 *     demande ne les dit pas déjà, et seulement si elles comptent pour CE genre de demande ;
 *   • (c) l'ÉTAPE SUIVANTE à décider — « quand ce sera prêt, je l'envoie à quelqu'un ? » — pour un livrable ;
 *   • (b) les résultats PARTIELS (sous-missions finies) sont ajoutés par le serveur au fil du travail ;
 *   • (d) une AUTRE demande dite pendant le travail part en parallèle (`estNouvelleDemande`, `voieDuMessage`).
 * Au plus deux précisions et une étape suivante : on ne transforme pas l'attente en interrogatoire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe d'une précision ÉCRITE transmise au travail (la voix garde le sien, qui demande une réponse pour l'oreille). */
export const PREFIXE_PRECISION_ECRITE = "[Précision du travail en cours]";

export type CleAgenda = "format" | "periode" | "detail" | "destinataire";

export interface GabaritAgenda {
  cle: CleAgenda;
  nature: "precision" | "suite";
  question: string;
  choix: string[];
}

const sansAccents = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const LIVRABLE = /\b(rapport|export\w*|tableau|liste|fichier|document|synthese|bilan|recapitulatif|compte rendu|presentation|note de synthese|etat des)\b/;
const FORMAT_DIT = /\b(excel|xlsx|csv|pdf|word|docx|pptx|powerpoint|tableur)\b/;
const DONNEES_DATEES = /\b(ventes?|chiffre d'affaires|achats?|depenses?|stocks?|commandes?|factur\w*|encaissements?|recouvrements?|visites?|marges?|consommation|production|performances?|evolution|creances?|paiements?|livraisons?|absences?|conges?)\b/;
const PERIODE_DITE = /\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|20\d\d|aujourd'hui|hier|demain|semaine|mois|trimestre|t[1-4]|annee|an dernier|depuis|entre|du \d|cette|ce mois|derniers?|dernieres?|en cours|actuel\w*|a date|jour)\b/;
const ANALYSE = /\b(rapport|synthese|analyse|bilan|etude|recherche|veille|compare\w*|comparaison|audit)\b/;
const DETAIL_DIT = /\b(bref|court|resume|detaill\w*|complet|exhaustif|grandes lignes|en une phrase|rapide\w*|en gros|precis\w*)\b/;
const ENVOI_DIT = /\b(envoie|envoyer|transmets?|transmettre|partage|partager|mail|courriel|whatsapp|pour (le|la|les|mon|ma|mes) \w+|a l'equipe)\b/;

/**
 * L'AGENDA D'UNE DEMANDE — déterministe : la même demande donne toujours les mêmes questions, et aucune ne porte sur
 * ce que la demande dit déjà. Une demande courte et sans livrable (« combien de clients à Oran ? ») n'en a aucune.
 */
export function construireAgenda(demande: string): GabaritAgenda[] {
  const d = sansAccents(demande);
  const livrable = LIVRABLE.test(d);
  const out: GabaritAgenda[] = [];
  if (livrable && !FORMAT_DIT.test(d)) {
    out.push({ cle: "format", nature: "precision", question: "Tu préfères un rendu Excel ou PDF ?", choix: ["Excel", "PDF", "Peu importe"] });
  }
  if (DONNEES_DATEES.test(d) && !PERIODE_DITE.test(d)) {
    out.push({ cle: "periode", nature: "precision", question: "Sur quelle période : ce mois-ci, le trimestre ou l'année ?", choix: ["Ce mois-ci", "Le trimestre", "L'année"] });
  }
  if (out.length < 2 && ANALYSE.test(d) && !DETAIL_DIT.test(d)) {
    out.push({ cle: "detail", nature: "precision", question: "Tu veux les grandes lignes ou le détail complet ?", choix: ["Les grandes lignes", "Le détail"] });
  }
  if (livrable && !ENVOI_DIT.test(d)) {
    out.push({ cle: "destinataire", nature: "suite", question: "Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ?", choix: ["C'est pour moi"] });
  }
  return out.slice(0, 3);
}

/** « peu importe », « comme tu veux », « c'est pour moi », « non » : une réponse qui ne change rien au travail. */
const SANS_EFFET = /^(peu importe|comme tu veux|comme tu (le )?sens|n'importe|ca m'est egal|egal|pas d'importance|aucune importance|c'est pour moi|pour moi|personne|non|non merci|pas besoin|rien|laisse|garde[- ]le|je le garde|ok|d'accord|ca va|merci|super|parfait|top|cool|tres bien|bien recu)\b/;

export interface LectureReponse {
  /** La valeur retenue — le choix reconnu, sinon les mots de la personne (bornés). */
  valeur: string;
  /** La réponse ne change pas le travail (« peu importe ») : rien n'est transmis. */
  sansEffet: boolean;
}

/** LIRE la réponse à une question d'agenda. Un choix reconnu dans les mots de la personne l'emporte. */
export function lireReponseAgenda(g: { cle: string; choix: string[] }, texte: string): LectureReponse {
  const t = sansAccents(texte).replace(/[.!?,;]+/g, " ").replace(/\s+/g, " ").trim();
  const choix = g.choix.find((c) => c !== "Peu importe" && new RegExp(`\\b${sansAccents(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  if (choix) return { valeur: choix, sansEffet: choix === "C'est pour moi" };
  if (g.cle === "format") {
    const f = t.match(/\b(excel|xlsx|csv|pdf|word|docx|powerpoint|pptx)\b/);
    if (f) return { valeur: f[1] === "xlsx" || f[1] === "csv" ? "Excel" : f[1] === "docx" ? "Word" : f[1] === "pptx" ? "PowerPoint" : f[1][0].toUpperCase() + f[1].slice(1), sansEffet: false };
  }
  if (SANS_EFFET.test(t)) return { valeur: texte.trim().slice(0, 80), sansEffet: true };
  return { valeur: texte.trim().slice(0, 200), sansEffet: false };
}

const LIBELLE_CLE: Record<CleAgenda, string> = {
  format: "Format de rendu voulu", periode: "Période voulue", detail: "Niveau de détail voulu", destinataire: "Quand c'est prêt, à envoyer à",
};

/** La PRÉCISION transmise au travail — une ligne, ce que la personne a choisi. */
export function precisionDeLaReponse(cle: CleAgenda, valeur: string): string {
  if (cle === "destinataire") return `${LIBELLE_CLE.destinataire} : ${valeur} (prépare la carte d'envoi avec le résultat ; rien ne part sans confirmation).`;
  return `${LIBELLE_CLE[cle]} : ${valeur}.`;
}

/** L'ACCUSÉ de la réponse — court, la valeur redite : « Noté, PDF. » ; si le travail change, on le dit. */
export function accuseDeReponse(valeur: string, change: boolean): string {
  return change
    ? `Dis en quelques mots « Noté, ${valeur} » et que le travail en tient compte — sans résultat inventé.`
    : `Dis en trois mots « Noté${valeur ? `, ${valeur}` : ""} » — sans résultat inventé.`;
}

// ─── UNE AUTRE DEMANDE PENDANT LE TRAVAIL ─────────────────────────────────────────────────

const AMORCE_PRECISION = /^(plutot|et aussi|aussi|en fait|seulement|juste|uniquement|surtout|sauf|sans|avec|mais|non|enfin|precise|ajoute|rajoute|pour|sur|en|a partir|depuis|et pour|et sur|et en|et le|et la|et les)\b/;
const DEMANDE = /\b(donne|donne-moi|montre|affiche|dis-moi|combien|est-ce que|quel|quelle|quels|quelles|qui|ou en est|fais|fait|prepare|redige|envoie|cherche|trouve|calcule|compare|liste|cree|ajoute une?|programme|rappelle|planifie|ouvre|resume|explique|traduis|lance|verifie|regarde)\b/;

/**
 * Une NOUVELLE demande (à traiter en parallèle) ou une PRÉCISION du travail en cours ? Déterministe : une phrase qui
 * commence comme un complément (« plutôt sur 2025 », « et aussi Oran ») ou très courte (≤ 4 mots) précise ; une phrase
 * qui demande quelque chose (verbe d'action, question) est une autre demande.
 */
export function estNouvelleDemande(texte: string): boolean {
  const t = sansAccents(texte).replace(/[.!?,;]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (AMORCE_PRECISION.test(t)) return false;
  if (t.split(" ").length <= 4 && !t.includes("?") && !/\b(combien|quel|quelle|qui|ou en est)\b/.test(t)) return false;
  return DEMANDE.test(t) || /\?\s*$/.test(texte.trim());
}

/** Au-delà, un tour en cours est un « travail long » : la conversation ne l'attend plus (écrit). */
export const TRAVAIL_LONG_MS = 8_000;

/**
 * LA VOIE D'UN MESSAGE ÉCRIT déposé pendant qu'un tour tourne :
 *   • `reponse` — une question de l'agenda attend sa réponse et ce n'est pas une autre demande ;
 *   • `parallele` — un travail LONG tourne et c'est une autre demande : elle n'attend pas derrière lui ;
 *   • `suite` — sinon, la file habituelle (le deuxième message attend le premier et voit sa réponse).
 */
export function voieDuMessage(d: { texte: string; questionEnAttente: boolean; travailEnCoursDepuisMs: number | null }): "reponse" | "parallele" | "suite" {
  const autre = estNouvelleDemande(d.texte);
  if (d.questionEnAttente && !autre) return "reponse";
  if (d.travailEnCoursDepuisMs != null && d.travailEnCoursDepuisMs >= TRAVAIL_LONG_MS && autre) return "parallele";
  return "suite";
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
export function precisionAffichee(contenu: string): string | null {
  if (!contenu.startsWith(PREFIXE_PRECISION_ECRITE)) return null;
  return contenu.slice(PREFIXE_PRECISION_ECRITE.length).split("\n")[0].trim();
}
