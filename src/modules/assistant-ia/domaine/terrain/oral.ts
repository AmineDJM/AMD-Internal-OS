import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE (lot K9, décision 0039) — les RÈGLES, pures.
 *
 * Direction : « je marche, j'ai mes écouteurs, je ne vois pas mon écran : tout se passe à l'oral — mais simple, pas
 * trop long ». La carte orale (accord, refus, récit) est celle de K4 (`voix-orale.ts`). Ici, ce que le serveur décide
 * EN PLUS, sans le modèle :
 *
 *   • les commandes orales : annuler la dernière action, mettre en pause / reprendre / arrêter une mission, « stop »,
 *     « plus court », et « attends » face à une carte ;
 *   • les tableaux, analyses, graphiques et visuels dits en UNE phrase chacun, chiffres arrondis à l'oral ;
 *   • la mission désignée par son nom ; la consigne qui fait RÉDIGER l'assistant pour l'oreille.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Minuscules, sans accents, ponctuation → espaces ; l'arabe est gardé tel quel. */
export function plier(texte: string): string {
  return ` ${(texte ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’'`´-]/g, " ").replace(/[.,;:!?«»"()[\]]/g, " ").replace(/\s+/g, " ").trim()} `;
}

const contient = (plie: string, expressions: readonly string[]) => expressions.some((e) => plie.includes(` ${e} `));

export type CommandeOrale =
  | "attendre" | "annuler_derniere" | "pause_mission" | "reprendre_mission" | "arreter_mission" | "stop" | "plus_court";

const MOT_MISSION = /\b(mission|missions|travail|travaux|tache|taches|sous mission|recherche en cours|analyse en cours)\b/;
const STOP_SEUL = ["stop", "arrete", "tais toi", "chut", "silence", "ca suffit", "baraka", "sekt", "skout", "اسكت", "بركا", "باركا"];

/**
 * CE QUE L'ÉNONCÉ COMMANDE — ou `null` : une demande ordinaire, ou une réponse à la carte orale (jugée par K4).
 * `carteEnAttente` : une carte orale attend la réponse de la personne — « annule » est alors un refus de la carte (K4).
 */
export function lireCommandeOrale(texte: string, ctx: { carteEnAttente: boolean }): CommandeOrale | null {
  const p = plier(texte);
  const brut = p.trim();
  if (!brut) return null;
  if (ctx.carteEnAttente) {
    // « Attends », « une minute », « pas encore » : la carte attend, rien ne part à l'assistant.
    if (brut.split(" ").length <= 6 && contient(p, ["attends", "attend", "minute", "pas encore", "mazal", "مازال", "je reflechis"])) return "attendre";
  }
  if (MOT_MISSION.test(brut)) {
    if (/\b(pause|suspend\w*|bloque\w*|en attente)\b/.test(brut)) return "pause_mission";
    if (/\b(reprend\w*|relance\w*|continue\w*|redemarre\w*)\b/.test(brut)) return "reprendre_mission";
    if (/\b(arrete\w*|stoppe\w*|annule\w*|abandonne\w*|coupe\w*)\b/.test(brut)) return "arreter_mission";
  }
  if (!ctx.carteEnAttente && /^(annule|annuler|defais|defaire)\b|\b(annule|defais|reviens sur) (ca|la derniere|le dernier|ce que tu (as|viens de) fait|l action)\b/.test(brut)) return "annuler_derniere";
  if (STOP_SEUL.includes(brut)) return "stop";
  if (/\b(plus court|en bref|abrege|resume|va a l essentiel|plus vite|ikhtasar|khtasar)\b|اختصر/.test(brut)) return "plus_court";
  return null;
}

// ─── LES CHIFFRES À L'ORAL ─────────────────────────────────────────────────────────────────

const virgule = (n: number, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toString().replace(".", ",");
const milliers = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Un nombre tel qu'on le dit : « environ 46 mille », « 1,2 million », « 350 ». */
export function nombreOral(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  const signe = n < 0 ? "moins " : "";
  const environ = (arrondi: number, dit: string) => `${Math.round(arrondi * 10) !== Math.round(a * 10) ? "environ " : ""}${signe}${dit}`;
  if (a >= 1e9) return environ(Math.round(a / 1e8) * 1e8, `${virgule(a / 1e9)} milliard${a >= 2e9 ? "s" : ""}`);
  if (a >= 1e6) return environ(Math.round(a / 1e5) * 1e5, `${virgule(a / 1e6)} million${a >= 2e6 ? "s" : ""}`);
  if (a >= 10_000) { const k = Math.round(a / 1000); return environ(k * 1000, `${k} mille`); }
  if (a >= 1_000) { const c = Math.round(a / 100) * 100; return environ(c, milliers(c)); }
  return environ(Math.round(a * 10) / 10, virgule(a));
}

/** Lit un nombre écrit par la transcription : « 12 500 », « 12,5 », « 50 mille », « 1,5 million ». `null` : aucun. */
export function lireNombreDit(texte: string): number | null {
  const t = (texte ?? "").toLowerCase().replace(/[  ]/g, " ");
  const m = t.match(/(-?\d{1,3}(?:[ .]\d{3})+|-?\d+)(?:[,.](\d+))?\s*(milliards?|millions?|mille|k)?/);
  if (!m) return null;
  const entier = Number(m[1].replace(/[ .]/g, ""));
  const v = m[2] ? Number(`${entier}.${m[2]}`) : entier;
  const mult = !m[3] ? 1 : m[3].startsWith("milliard") ? 1e9 : m[3].startsWith("million") ? 1e6 : 1e3;
  return Number.isFinite(v) ? Math.round(v * mult * 100) / 100 : null;
}

// ─── LES RÉSUMÉS ORAUX ─────────────────────────────────────────────────────────────────────

const court = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };

type Bloc = WorkspaceBlock | { kind: string; title?: string; [k: string]: unknown };

/** Une série de graphique : la plus haute catégorie, dite. */
function sommetDe(donnees: { categories?: string[]; series?: { label: string; valeurs: (number | null)[] }[] } | undefined): string | null {
  const s = donnees?.series?.[0];
  const cats = donnees?.categories ?? [];
  if (!s || !cats.length) return null;
  let i = -1;
  s.valeurs.forEach((v, j) => { if (typeof v === "number" && (i < 0 || v > (s.valeurs[i] as number))) i = j; });
  return i >= 0 && cats[i] ? `le plus haut : ${cats[i]}, ${nombreOral(s.valeurs[i] as number)}` : null;
}

function phraseDuBloc(b: Bloc): string | null {
  const titre = typeof b.title === "string" && b.title.trim() ? `« ${court(b.title, 60)} »` : "";
  const x = b as Record<string, unknown>;
  switch (b.kind) {
    case "table": {
      const n = typeof x.total === "number" ? x.total : Array.isArray(x.rows) ? x.rows.length : 0;
      return `Un tableau ${titre} de ${nombreOral(n)} ligne${n > 1 ? "s" : ""}.`;
    }
    case "viz": {
      const sommet = sommetDe(x.donnees as Parameters<typeof sommetDe>[0]);
      return `Un graphique ${titre}${sommet ? ` — ${sommet}` : ""}.`;
    }
    case "analyse": {
      const n = typeof x.total === "number" ? x.total : 0;
      const r = (x.journal as { resultats?: { libelle: string; valeur: string }[] } | undefined)?.resultats?.[0];
      const dit = r ? ` ${r.libelle} : ${(() => { const v = lireNombreDit(r.valeur); return v != null && /^[\s\d.,-]+$/.test(r.valeur.replace(/[A-Za-z%]+/g, "")) ? nombreOral(v) : court(r.valeur, 40); })()}.` : "";
      return `Une analyse ${titre} sur ${nombreOral(n)} ligne${n > 1 ? "s" : ""}.${dit}`;
    }
    case "visuel": {
      const pret = x.etat === "pret";
      return `${x.nature === "image" ? "Une image" : "Une vidéo"} ${titre} ${pret ? "est prête" : "est en préparation"}.`;
    }
    case "dashboard": return `Un tableau de bord ${titre}.`;
    case "timeline": return `Une chronologie ${titre}.`;
    default: return null;
  }
}

/** TABLEAUX, ANALYSES, GRAPHIQUES ET VISUELS EN UNE PHRASE CHACUN (trois au plus) — le détail reste dans la conversation. */
export function resumeOralBlocs(blocs: readonly Bloc[] | null | undefined, max = 3): string {
  const phrases = (blocs ?? []).map(phraseDuBloc).filter((p): p is string => !!p);
  if (!phrases.length) return "";
  const dites = phrases.slice(0, max).map((p) => p.replace(/\s+/g, " ").replace(/ \./g, "."));
  return `${dites.join(" ")}${phrases.length > max ? ` Et ${phrases.length - max} autre${phrases.length - max > 1 ? "s" : ""}.` : ""} Le détail est dans la conversation.`;
}

// ─── LA RÉDACTION POUR L'OREILLE ───────────────────────────────────────────────────────────

/** Le préfixe d'un tour délégué par la voix (le fil le reconnaît pour rédiger pour l'oreille). */
export const PREFIXE_VOCAL = "[Conversation vocale]";
export const PREFIXE_PRECISION = "[Conversation vocale — précision]";

/** La consigne de l'assistant de l'ERP quand le tour vient de la voix : il RÉDIGE pour l'oral, pas un texte qu'on tronque. */
export const CONSIGNE_ORALE = [
  "RÉPONSE POUR L'OREILLE : ce tour vient de la conversation VOCALE. La personne marche, écouteurs aux oreilles, et ne voit PAS son écran.",
  "Rédige ta réponse pour être DITE : la réponse d'abord, en une ou deux phrases ; une idée par phrase ; chiffres arrondis comme on les dit",
  "(« environ 1,2 million de dinars », « à peu près 40 % ») ; aucun tableau, aucune liste à puces, aucun Markdown, aucune adresse web.",
  "Termine par une ouverture courte (« je te détaille ? », « tu veux le détail par région ? »). Ne dis JAMAIS « affiché à l'écran » ni",
  "« voir ci-dessus » : le détail (tableau, graphique) reste dans la conversation, la voix le résume elle-même en une phrase.",
  "Une action préparée (carte) se conclut à l'oral : la voix la résume et la personne confirme de vive voix.",
].join("\n");

/**
 * CELUI QU'ON DÉSIGNE PAR SON NOM, parmi des candidats (missions, fiches) : les mots de quatre lettres ou plus de
 * l'énoncé qui apparaissent dans le titre. Un seul candidat : c'est lui, sans qu'on ait à le nommer.
 */
export function designesParNom<T extends { titre: string }>(candidats: readonly T[], texte: string): T[] {
  if (candidats.length <= 1) return [...candidats];
  const mots = plier(texte).trim().split(" ").filter((m) => m.length >= 4 && !["mission", "missions", "travail", "pause", "reprends", "reprendre", "arrete", "arreter", "celle", "cette"].includes(m));
  const vises = candidats.filter((c) => mots.some((m) => plier(c.titre).includes(m)));
  return vises.length ? vises : [...candidats];
}
