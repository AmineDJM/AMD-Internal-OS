import type { WorkspaceBlock } from "@/lib/assistant/workspace/protocol";
import { readVizBlock } from "@/lib/assistant/workspace/viz-block";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'UI GÉNÉRATIVE DE L'ASSISTANT IA — R5 (décision 0006, C7 révisée).
 *
 * Le modèle répond `{ "message": "…", "components": [ … ] }` et CHOISIT ses composants dans la
 * liste que l'interface sait dessiner. Le serveur ne lui fait pas confiance pour autant :
 *
 *   • un type inconnu est retiré (« Only use components supported by the front end ») ;
 *   • un CHIFFRE n'est gardé que s'il figure dans les résultats d'outils du tour, dans la question
 *     ou dans le contexte (« Never fabricate data ») — sinon le composant entier est retiré ;
 *   • un tableau ou un graphique sans aucun outil appelé dans le tour n'a pas de source : retiré ;
 *     chaque ligne d'un tableau doit être retrouvée dans ces résultats.
 *
 * Ce qui reste devient des blocs du protocole de l'espace de travail, dessinés par
 * `WorkspaceBlocks` (C9). Un composant retiré ne laisse que le `message` : on n'affiche jamais
 * une donnée qu'on ne peut pas rattacher à une lecture.
 *
 * Module PUR (aucun accès base, aucun réseau) : testé seul, utilisable des deux côtés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les composants que l'interface dessine — la liste montrée au modèle, et rien d'autre. */
export const COMPOSANTS_PRIS_EN_CHARGE = ["text", "card", "list", "table", "chart", "alert", "steps"] as const;
export type TypeComposant = (typeof COMPOSANTS_PRIS_EN_CHARGE)[number];

/** Ce que le modèle lit : la forme de chaque composant, en une ligne. */
export const CONSIGNE_COMPOSANTS = [
  "FORMAT DE SORTIE — réponds TOUJOURS par un seul objet JSON valide, sans texte autour :",
  '{"message": "…", "components": [ … ]}',
  "- message : la réponse elle-même, en Markdown sobre (gras pour les repères, listes, petits tableaux). La première phrase répond.",
  "- components : facultatif ([] le plus souvent). Un composant seulement s'il apporte quelque chose. Ce qu'un composant montre, le message ne le répète PAS : il dit l'essentiel en une ou deux phrases et laisse le composant porter le détail.",
  "Composants disponibles (aucun autre) :",
  '- {"type":"card","title":"…","content":"…","fields":[{"label":"…","value":"…"}]} — une fiche (un dossier, une personne, un produit).',
  '- {"type":"table","title":"…","columns":["…"],"rows":[["…"]]} — des lignes LUES par tes outils dans ce tour, recopiées telles quelles.',
  '- {"type":"chart","title":"…","chartType":"barres|courbe|secteurs","labels":["…"],"series":[{"name":"…","values":[1]}]} — seulement des nombres rendus par tes outils.',
  '- {"type":"alert","level":"info|attention|critique","title":"…","content":"…"} — un point qui demande une action ou une vigilance.',
  '- {"type":"steps","title":"…","steps":[{"label":"…","detail":"…"}]} — un circuit ou une procédure, étape par étape : PRIVILÉGIE-LE pour expliquer un processus. Un circuit de validation se LIT d\'abord (read_workflow) ; jamais de mémoire.',
  '- {"type":"list","title":"…","items":["…"]} — une liste à retenir.',
  "Un chiffre ou une ligne qui ne vient pas de tes outils est retiré par l'application : n'en invente aucun.",
].join("\n");

export interface ReponseLue {
  message: string;
  composants: unknown[];
}

/**
 * LIRE CE QUE LE MODÈLE A RENDU — avec indulgence. Un objet JSON (éventuellement dans un bloc
 * ```json, ou précédé d'une phrase) donne `message` + `components` ; tout le reste est lu comme
 * un simple message. On ne jette jamais une réponse parce que son enveloppe est imparfaite.
 */
export function lireReponseModele(texte: string): ReponseLue {
  const brut = (texte ?? "").trim();
  const candidats = [brut];
  const cloture = brut.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cloture?.[1]) candidats.push(cloture[1].trim());
  const debut = brut.indexOf("{");
  const fin = brut.lastIndexOf("}");
  if (debut >= 0 && fin > debut) candidats.push(brut.slice(debut, fin + 1));
  for (const c of candidats) {
    try {
      const o = JSON.parse(c) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o) && typeof (o as { message?: unknown }).message === "string") {
        const comps = (o as { components?: unknown }).components;
        return { message: ((o as { message: string }).message).trim(), composants: Array.isArray(comps) ? comps : [] };
      }
    } catch {
      /* candidat suivant */
    }
  }
  return { message: brut, composants: [] };
}

// ─────────────────────────────── LE GARDE-FOU DES DONNÉES ───────────────────────────────

const replier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Les nombres d'un texte, normalisés : « 80 000 » → 80000, « 2,5 » → 2.5, « 07 » → 7. */
export function nombresDe(texte: string): number[] {
  const out: number[] = [];
  const re = /\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
  for (const m of texte.matchAll(re)) {
    const v = Number(m[0].replace(/[   ]/g, "").replace(",", "."));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Les sources d'un tour : ce que les outils ont rendu, la question, le contexte. */
export interface SourcesTour {
  /** Les sorties d'outils du tour (texte ou JSON), telles que l'application les a reçues. */
  sorties: string[];
  /** La question et ce que l'utilisateur a écrit : un chiffre qu'il donne peut être repris. */
  question: string;
  /** Les chiffres du contexte (date du jour…). */
  contexte?: string;
}

class Corpus {
  readonly outils: boolean;
  private readonly texte: string;
  private readonly nombres: Set<number>;
  constructor(s: SourcesTour) {
    this.outils = s.sorties.length > 0;
    const tout = [...s.sorties, s.question, s.contexte ?? ""].join("\n");
    this.texte = replier(s.sorties.join("\n"));
    this.nombres = new Set(nombresDe(tout));
  }
  /** Un petit entier (un rang, un compte, un numéro d'étape) n'est pas une donnée à prouver. */
  nombreConnu(v: number): boolean {
    return (Number.isInteger(v) && Math.abs(v) <= 12) || this.nombres.has(v);
  }
  chiffresProuves(texte: string): boolean {
    return nombresDe(texte).every((v) => this.nombreConnu(v));
  }
  /**
   * Une cellule se retrouve-t-elle dans ce que les outils ont rendu ? Telle quelle, ou mot à mot :
   * mesuré, le modèle recompose (« Validation du Directeur Général » → « Directeur Général ») ;
   * chaque mot porteur (4 lettres et plus) doit alors figurer dans les sorties.
   */
  retrouve(cellule: string): boolean {
    const c = replier(cellule);
    if (c.length < 2) return false;
    if (this.texte.includes(c)) return true;
    const mots = c.split(/[^a-z0-9]+/).filter((m) => m.length >= 4);
    return mots.length > 0 && mots.every((m) => this.texte.includes(m));
  }
}

const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const tab = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX_LIGNES = 30;

export interface ComposantRetire {
  type: string;
  raison: "inconnu" | "vide" | "chiffre-non-source" | "sans-outil" | "ligne-non-source";
}

export interface ResultatComposants {
  /** Le message, complété des listes (une liste se lit mieux dans le texte qu'en bloc). */
  message: string;
  blocs: WorkspaceBlock[];
  retires: ComposantRetire[];
}

/**
 * TRIER, PROUVER, CONVERTIR. Chaque composant accepté devient un bloc du protocole ; chaque
 * composant refusé est compté avec sa raison (journal), jamais affiché.
 */
export function composantsEnBlocs(lu: ReponseLue, sources: SourcesTour): ResultatComposants {
  const corpus = new Corpus(sources);
  const blocs: WorkspaceBlock[] = [];
  const retires: ComposantRetire[] = [];
  const ajoutsMessage: string[] = [];
  const retirer = (type: string, raison: ComposantRetire["raison"]) => retires.push({ type, raison });

  for (const brut of lu.composants.slice(0, 6)) {
    if (!brut || typeof brut !== "object") { retirer("?", "inconnu"); continue; }
    const c = brut as Record<string, unknown>;
    const type = str(c.type, 20) as TypeComposant;
    if (!(COMPOSANTS_PRIS_EN_CHARGE as readonly string[]).includes(type)) { retirer(String(c.type ?? "?"), "inconnu"); continue; }
    const titre = str(c.title, 120);

    switch (type) {
      case "text": {
        const t = str(c.content ?? c.text, 4000);
        if (!t) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves(t)) { retirer(type, "chiffre-non-source"); break; }
        ajoutsMessage.push(t);
        break;
      }
      case "list": {
        const items = tab(c.items).map((x) => str(x, 300)).filter(Boolean).slice(0, 20);
        if (!items.length) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves([titre, ...items].join("\n"))) { retirer(type, "chiffre-non-source"); break; }
        ajoutsMessage.push(`${titre ? `**${titre}**\n` : ""}${items.map((i) => `- ${i}`).join("\n")}`);
        break;
      }
      case "card": {
        const contenu = str(c.content, 1200);
        const champs = tab(c.fields)
          .map((f) => (f && typeof f === "object" ? { label: str((f as Record<string, unknown>).label, 60), value: str((f as Record<string, unknown>).value, 300) } : null))
          .filter((f): f is { label: string; value: string } => !!f && !!f.label && !!f.value)
          .slice(0, 12);
        if (!titre || (!contenu && !champs.length)) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves([titre, contenu, ...champs.map((f) => f.value)].join("\n"))) { retirer(type, "chiffre-non-source"); break; }
        blocs.push({ kind: "record", title: titre, subtitle: contenu || null, fields: champs });
        break;
      }
      case "alert": {
        const contenu = str(c.content, 800);
        if (!contenu) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves(`${titre}\n${contenu}`)) { retirer(type, "chiffre-non-source"); break; }
        const niveau = str(c.level, 20);
        const ton = niveau === "critique" ? "alerte" : niveau === "attention" ? "attention" : "info";
        blocs.push({ kind: "alerte", title: titre || "À noter", ton, message: contenu });
        break;
      }
      case "steps": {
        const etapes = tab(c.steps)
          .map((e) => (typeof e === "string" ? { label: str(e, 160), detail: null } : e && typeof e === "object" ? { label: str((e as Record<string, unknown>).label, 160), detail: str((e as Record<string, unknown>).detail, 300) || null } : null))
          .filter((e): e is { label: string; detail: string | null } => !!e && !!e.label)
          .slice(0, 15);
        if (etapes.length < 2) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves([titre, ...etapes.flatMap((e) => [e.label, e.detail ?? ""])].join("\n"))) { retirer(type, "chiffre-non-source"); break; }
        blocs.push({ kind: "timeline", title: titre || "Étapes", steps: etapes });
        break;
      }
      case "table": {
        if (!corpus.outils) { retirer(type, "sans-outil"); break; }
        const colonnes = tab(c.columns).map((x) => str(x, 60)).filter(Boolean).slice(0, 8);
        const lignes = tab(c.rows).map((r) => tab(r).map((x) => str(x, 200))).filter((r) => r.some(Boolean)).slice(0, MAX_LIGNES);
        if (!colonnes.length || !lignes.length) { retirer(type, "vide"); break; }
        if (!corpus.chiffresProuves(lignes.flat().join("\n"))) { retirer(type, "chiffre-non-source"); break; }
        // Une ligne inventée n'a AUCUNE cellule dans ce que les outils ont rendu.
        if (!lignes.every((r) => r.some((cell) => corpus.retrouve(cell)))) { retirer(type, "ligne-non-source"); break; }
        const numerique = colonnes.map((_, j) => lignes.every((r) => !r[j] || /^[-+]?[\d\s  .,%]+(?:\s?[A-Za-z€%]{0,4})?$/.test(r[j]!)));
        blocs.push({
          kind: "table",
          title: titre || "Tableau",
          columns: colonnes.map((label, j) => ({ key: `c${j}`, label, numeric: numerique[j] })),
          rows: lignes.map((r) => ({ cells: Object.fromEntries(colonnes.map((_, j) => [`c${j}`, r[j] ?? ""])) })),
        });
        break;
      }
      case "chart": {
        if (!corpus.outils) { retirer(type, "sans-outil"); break; }
        const libelles = tab(c.labels).map((x) => str(x, 40)).filter(Boolean).slice(0, 24);
        const series = tab(c.series).map((s) => (s && typeof s === "object" ? s as Record<string, unknown> : null)).filter(Boolean) as Record<string, unknown>[];
        const valeurs = series.flatMap((s) => tab(s.values ?? s.valeurs)).filter((v): v is number => typeof v === "number");
        if (!libelles.length || !valeurs.length) { retirer(type, "vide"); break; }
        if (!valeurs.every((v) => corpus.nombreConnu(v))) { retirer(type, "chiffre-non-source"); break; }
        const forme = str(c.chartType, 20);
        const vizType = forme === "courbe" || forme === "line" ? "courbe" : forme === "secteurs" || forme === "pie" ? "secteurs" : "barres";
        const b = readVizBlock({ type: vizType, donnees: { categories: libelles, series: series.map((s) => ({ label: str(s.name ?? s.label, 40), valeurs: tab(s.values ?? s.valeurs) })) } }, titre || "Graphique");
        if (b) blocs.push(b); else retirer(type, "vide");
        break;
      }
    }
  }

  // Le texte annonçait peut-être « voici un tableau » : on dit pourquoi il n'est pas là, plutôt
  // que de laisser une promesse sans objet.
  const nonVerifies = retires.filter((r) => r.type === "table" || r.type === "chart");
  if (nonVerifies.length === 1) {
    const quoi = nonVerifies[0]!.type === "chart" ? "Le graphique proposé" : "Le tableau proposé";
    ajoutsMessage.push(`_${quoi} n'a pas pu être rapproché des données lues : il n'est pas affiché._`);
  } else if (nonVerifies.length > 1) {
    ajoutsMessage.push("_Les éléments proposés n'ont pas pu être rapprochés des données lues : ils ne sont pas affichés._");
  }
  const message = [lu.message, ...ajoutsMessage].filter(Boolean).join("\n\n");
  return { message, blocs, retires };
}
