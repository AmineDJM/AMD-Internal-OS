import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PRÉ-LECTURES — le code lit AVANT que le modèle ne demande.
 *
 * ── LE DÉFAUT MESURÉ ─────────────────────────────────────────────────────────────────────
 *
 * Au banc (jeu semé, données connues), « Qu'avait promis Amel lors du dernier comité de
 * direction ? » a coûté sept appels de modèle, trente secondes, 395 000 jetons — et la réponse
 * fut « aucune trace », alors que `find_documents("promesse Amel comité de direction")` rendait
 * le procès-verbal en 27 ms, en tête de liste. Le modèle avait cherché ailleurs (boîte mail,
 * engagements), tour après tour, sans jamais ouvrir la porte évidente. Même schéma sur « qu'est-ce
 * qui bloque l'appel d'offres PCH en cours ? » : la recherche fédérée répond en 40 ms, le modèle
 * a formulé une requête trop longue, obtenu zéro, et conclu qu'il n'y avait rien.
 *
 * ── LE PRINCIPE ──────────────────────────────────────────────────────────────────────────
 *
 * Quand la route dit « la réponse est dans la base ou dans un document » (STRUCTURED_QUERY,
 * HYBRID_RETRIEVAL, DEEP_REASONING), les deux lectures les plus probables — la recherche fédérée
 * et la recherche documentaire — partent EN PARALLÈLE, par les mêmes outils et les mêmes droits
 * que si le modèle les avait demandées, et leur résultat est présenté au modèle comme des
 * appels d'outils déjà faits. Le modèle décide toujours QUOI faire ensuite ; il le décide avec
 * la preuve sous les yeux au lieu de la chercher à tâtons.
 *
 * Trois bornes : jamais sur une mutation (une action n'a pas besoin de lecture spéculative pour
 * être proposée), jamais au-delà d'un délai court (une pré-lecture qui traîne n'est pas une
 * pré-lecture), jamais au-delà d'une taille (le modèle reçoit un extrait, l'écran reçoit tout).
 * Ce module est PUR pour la décision (testable sans base) ; l'exécution reçoit l'exécuteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type OutilPreLecture = "search_everything" | "find_documents" | "inspect_record" | "read_document" | "read_calendar" | "executive_brief";

export interface PreLecture {
  tool: OutilPreLecture;
  input: Record<string, string>;
}

export interface PlanPreLecture {
  route: string;
  isMutation: boolean;
  entites?: readonly string[];
  /** Le domaine décidé par le routeur — certaines recettes en dépendent (préparation de réunion). */
  domain?: string;
}

/** Mots qui ne désignent rien qu'on puisse chercher — articles, pronoms, verbes d'appui. */
const MOTS_VIDES = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "au", "aux", "et", "ou", "en", "a", "y",
  "ce", "cet", "cette", "ces", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur", "leurs",
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "me", "te", "se", "moi", "toi", "lui", "eux",
  "qui", "que", "quoi", "dont", "ou", "quel", "quelle", "quels", "quelles", "quand", "comment", "pourquoi", "combien",
  "est", "sont", "etait", "etaient", "ete", "etre", "avait", "avoir", "ai", "as", "avons", "avez", "ont", "fait", "faire", "dois", "doit", "faut", "peux", "peut",
  "pour", "par", "sur", "sous", "dans", "avec", "sans", "vers", "chez", "entre", "depuis", "avant", "apres", "pendant",
  "pas", "ne", "non", "oui", "plus", "moins", "tres", "bien", "tout", "tous", "toute", "toutes", "encore", "aussi", "meme", "deja",
  "cours", "dernier", "derniere", "derniers", "dernieres", "prochain", "prochaine", "actuel", "actuelle", "situation", "point",
  "dis", "dit", "dites", "donne", "donnes", "montre", "explique", "resume", "retrouve", "cherche", "liste", "trouve", "regarde",
  "moi", "stp", "svp", "merci", "adam", "bonjour", "salut",
  "semaine", "aujourd", "hui", "demain", "hier", "matin", "soir", "jour", "jours", "mois", "annee", "cette",
  "promis", "promesse", "bloque", "bloquer", "retard", "manque", "reste", "attention", "necessitent", "besoin",
]);

/** Les mots qui portent l'identité de la question — ce qu'on peut effectivement chercher. */
export function motsSignificatifs(question: string, max = 6): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const brut of question.replace(/['’]/g, " ").split(/[\s,;:!?()«»"“”]+/)) {
    const mot = brut
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}/-]+$/gu, "")
      // L'enclitique interrogatif (« est-ce », « va-t-il », « peut-on ») n'est pas un mot.
      .replace(/-(?:t-)?(?:ce|je|tu|il|elle|on|nous|vous|ils|elles|y|en|moi|toi|le|la|les)$/iu, "");
    if (mot.length < 3) continue;
    const cle = plier(mot);
    if (MOTS_VIDES.has(cle) || vus.has(cle)) continue;
    vus.add(cle);
    out.push(mot);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * DÉCIDE les pré-lectures d'un tour — pure, sans base, sans modèle.
 *
 * Rend une liste vide dès qu'un doute existe : une pré-lecture inutile coûte des jetons à
 * chaque tour, une pré-lecture absente ne coûte qu'un tour de plus au modèle.
 */
export function planifierPreLectures(question: string, plan: PlanPreLecture): PreLecture[] {
  if (plan.isMutation) return [];
  if (!["STRUCTURED_QUERY", "HYBRID_RETRIEVAL", "DEEP_REASONING"].includes(plan.route)) return [];
  const q = (question ?? "").trim();
  if (q.length < 12) return [];
  const mots = motsSignificatifs(q);
  // LA RECETTE « PRÉPARER UNE RÉUNION » : l'agenda du jour visé, le point exécutif (ce qui
  // attend une décision, les risques, la finance, les réunions) et les documents qui en
  // parlent — les trois lectures que le modèle finissait par faire l'une après l'autre.
  if (plan.route === "DEEP_REASONING" && plan.domain === "CALENDAR") {
    const out: PreLecture[] = [{ tool: "read_calendar", input: {} }, { tool: "executive_brief", input: {} }];
    if (mots.length > 0) out.push({ tool: "find_documents", input: { query: mots.join(" ").slice(0, 120) } });
    return out;
  }
  if (mots.length === 0) return [];
  // La recherche fédérée préfère les ENTITÉS quand le plan en a extrait ; sinon les mots porteurs.
  const entites = (plan.entites ?? []).map((e) => e.trim()).filter((e) => e.length >= 3);
  const federee = (entites.length > 0 ? entites : mots).join(" ").slice(0, 120);
  // LES DEUX, TOUJOURS : une question « structurée » sur des réserves, un contrat ou une
  // pièce trouve souvent sa réponse dans un document (mesuré : « résume les réserves de
  // l'ANPP » partait en cinq appels sans la recherche documentaire). Elle coûte ~50 ms et un
  // extrait ; un tour de modèle en moins vaut cent fois cela.
  return [
    { tool: "search_everything", input: { query: federee } },
    { tool: "find_documents", input: { query: mots.join(" ").slice(0, 120) } },
  ];
}

export interface PreLectureFaite extends PreLecture {
  id: string;
  out: string;
  ms: number;
}

/** Les fiches que `inspect_record` sait reconstituer — par le chemin de leur lien interne. */
const LIENS_FICHE = ["/regulatory/", "/legal/", "/pch/", "/validations/paiements/", "/finances/", "/courrier/", "/demandes/", "/dossiers/"];

const idDuLien = (lien: string): string | null => {
  const seg = (lien ?? "").split(/[?#]/)[0].split("/").filter(Boolean);
  const dernier = seg[seg.length - 1] ?? "";
  return /^[a-z0-9_-]{8,}$/i.test(dernier) ? dernier : null;
};

/**
 * LA SECONDE VAGUE — ce que la première a rendu ÉVIDENT, on le lit tout de suite.
 *
 * Une recherche fédérée qui rend UN ou deux dossiers appelle leur fiche (`inspect_record`) ;
 * une recherche documentaire dont le premier résultat est de confiance HAUTE appelle sa
 * lecture (`read_document`). Le modèle aurait demandé exactement cela au tour suivant — quatre
 * secondes et un aller-retour complet de contexte pour une décision que le code sait prendre.
 * Pure : elle lit des JSON, elle ne touche à rien. Sur le moindre doute, elle ne suit pas.
 */
export function suiviPreLectures(faites: ReadonlyArray<{ tool: string; out: string }>): PreLecture[] {
  const suites: PreLecture[] = [];
  const dejaVus = new Set<string>();
  for (const f of faites) {
    let json: unknown;
    try { json = JSON.parse(f.out); } catch { continue; }
    if (!json || typeof json !== "object") continue;
    if (f.tool === "search_everything") {
      const r = json as { total?: number; resultats?: { famille?: string; reference?: string | null; lien?: string }[] };
      const hits = Array.isArray(r.resultats) ? r.resultats : [];
      // Résultat FOCALISÉ seulement : au-delà de trois fiches, choisir serait deviner.
      const fiches = hits.filter((h) => typeof h.lien === "string" && LIENS_FICHE.some((p) => h.lien!.startsWith(p)));
      if (fiches.length === 0 || fiches.length > 2 || (r.total ?? hits.length) > 4) continue;
      for (const h of fiches) {
        const ref = (h.reference && h.reference.trim()) || idDuLien(h.lien ?? "");
        if (!ref || dejaVus.has(`inspect:${ref}`)) continue;
        dejaVus.add(`inspect:${ref}`);
        suites.push({ tool: "inspect_record", input: { reference: ref } });
      }
    }
    if (f.tool === "find_documents") {
      const r = json as { resultats?: { driveNodeId?: string; confiance?: string }[] };
      const top = Array.isArray(r.resultats) ? r.resultats[0] : undefined;
      if (top?.driveNodeId && top.confiance === "HAUTE" && !dejaVus.has(`read:${top.driveNodeId}`)) {
        dejaVus.add(`read:${top.driveNodeId}`);
        suites.push({ tool: "read_document", input: { driveNodeId: top.driveNodeId } });
      }
    }
  }
  return suites.slice(0, 3);
}

/** Délai au-delà duquel une pré-lecture est abandonnée — elle n'est jamais attendue. */
export const PRE_LECTURE_TIMEOUT_MS = 1_800;
/** Ce que le modèle reçoit d'une pré-lecture — l'écran, lui, reçoit tout par ailleurs. */
export const PRE_LECTURE_MAX_CHARS = 6_000;

/**
 * EXÉCUTE les pré-lectures en parallèle, chacune sous délai. Une lecture qui échoue ou qui
 * traîne est simplement ABSENTE du résultat — jamais une erreur remontée, jamais une attente.
 */
export async function executerPreLectures(
  plans: PreLecture[],
  run: (tool: string, input: Record<string, string>) => Promise<string>,
  timeoutMs = PRE_LECTURE_TIMEOUT_MS,
  opts: { suivi?: boolean } = {},
): Promise<PreLectureFaite[]> {
  const vague = async (liste: PreLecture[], depart: number): Promise<PreLectureFaite[]> => {
    const faites = await Promise.all(liste.map(async (p, i) => {
      const t0 = Date.now();
      let timer: NodeJS.Timeout | null = null;
      try {
        const out = await Promise.race([
          run(p.tool, p.input),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        if (out == null || typeof out !== "string" || out.trim() === "") return null;
        return { ...p, id: `pre_${depart + i + 1}`, out, ms: Date.now() - t0 } satisfies PreLectureFaite;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    return faites.filter((f): f is PreLectureFaite => f != null);
  };
  const premiere = await vague(plans, 0);
  if (opts.suivi === false || premiere.length === 0) return premiere;
  const suites = suiviPreLectures(premiere);
  if (suites.length === 0) return premiere;
  const seconde = await vague(suites, premiere.length);
  return [...premiere, ...seconde];
}
