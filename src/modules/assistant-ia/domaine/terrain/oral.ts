import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE (lot K9, décision 0038) — les RÈGLES, pures.
 *
 * Direction : « je marche, j'ai mes écouteurs, je ne vois pas mon écran : tout se passe à l'oral — mais simple, pas
 * trop long ». Ici ce que le serveur décide SANS le modèle :
 *
 *   • ce qu'un énoncé de la personne VEUT DIRE quand une carte attend (« vas-y », « go », « ih dirha » → confirmer ;
 *     « non », « laisse tomber » → refuser), et les commandes orales (annuler la dernière action, mettre en pause,
 *     reprendre, arrêter une mission, « stop », « plus court ») ;
 *   • le RÉSUMÉ ORAL d'une carte (titre, montant, bénéficiaire, relecture de la valeur critique), d'un tableau, d'une
 *     analyse, d'un graphique, d'un visuel — une phrase chacun, chiffres arrondis à l'oral ;
 *   • le CHAMP SUIVANT à demander (un obligatoire à la fois, puis au plus deux facultatifs utiles) et la lecture d'une
 *     valeur dite (nombre, date, choix, oui/non) ;
 *   • l'EMPREINTE d'une intention : la confirmation orale exige que la carte n'ait pas changé depuis son résumé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Minuscules, sans accents, ponctuation → espaces ; l'arabe est gardé tel quel. */
export function plier(texte: string): string {
  return ` ${(texte ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’'`´-]/g, " ").replace(/[.,;:!?«»"()[\]]/g, " ").replace(/\s+/g, " ").trim()} `;
}

const contient = (plie: string, expressions: readonly string[]) => expressions.some((e) => plie.includes(` ${e} `));

/** « Oui, vas-y » — en français parlé, en darja (lettres latines ou arabes). */
const AFFIRMATIONS = [
  "oui", "ouais", "ouep", "ok", "okay", "okey", "d accord", "dacc", "daccord", "vas y", "vasy", "go", "fais le", "fais la", "fait le",
  "c est bon", "cest bon", "valide", "je valide", "confirme", "je confirme", "lance", "lance le", "envoie", "envoie le", "parfait",
  "exactement", "allez", "allez y", "banco", "carrement", "tout a fait", "bien sur", "yes", "yep", "nickel", "impeccable",
  "ih", "iih", "iyeh", "eyh", "wah", "wakha", "ewa", "yallah", "yalla", "zid", "dir", "dirha", "dirou", "sahit", "mlih", "saha",
  "ايه", "إيه", "اه", "واه", "يالله", "يلا", "ديرها", "دير", "زيد", "صحيت", "مليح", "واخا", "اوكي",
];
/** Ce qui retient un « oui » : une négation, une attente, une correction (« oui mais mets 5 000 »). */
const RETENUES = [
  "non", "pas", "attends", "attend", "minute", "mais", "sauf", "plutot", "change", "modifie", "corrige", "lala", "la la", "machi",
  "mazal", "ma tdir", "matdir", "laisse", "annule", "stop", "arrete", "لا", "ماشي", "مازال", "ما تدير", "خليها", "حبس",
];
const REFUS = [
  "non", "non merci", "laisse tomber", "laisse", "annule", "oublie", "pas maintenant", "on arrete", "lala", "la la", "machi", "khaliha",
  "لا", "ماشي", "خليها", "بلاش", "blach",
];
const QUESTION = /\?|^\s*(c est quoi|combien|pourquoi|qui|quand|comment|quel|quelle|est ce que|wach|chhal|علاش|شحال|واش)\b/;

/** VRAI seulement pour un accord net : une affirmation, aucune retenue, pas une question, court (huit mots au plus). */
export function estAffirmatif(texte: string): boolean {
  // « Pas de souci », « sans problème » : des accords, malgré le « pas ».
  const p = plier(texte).replace(/ (pas de (souci|soucis|probleme)|sans probleme|aucun probleme) /g, " ok ");
  if (!p.trim() || QUESTION.test(texte.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/'/g, " "))) return false;
  if (p.trim().split(" ").length > 8) return false;
  return contient(p, AFFIRMATIONS) && !contient(p, RETENUES);
}

export function estRefus(texte: string): boolean {
  const p = plier(texte);
  return contient(p, REFUS) && !estAffirmatif(texte);
}

export type CommandeOrale =
  | "confirmer" | "refuser" | "attendre" | "annuler_derniere" | "pause_mission" | "reprendre_mission" | "arreter_mission" | "stop" | "plus_court";

const MOT_MISSION = /\b(mission|missions|travail|travaux|tache|taches|sous mission|recherche en cours|analyse en cours)\b/;
const STOP_SEUL = ["stop", "arrete", "tais toi", "chut", "silence", "ca suffit", "baraka", "sekt", "skout", "اسكت", "بركا", "باركا"];

/**
 * CE QUE L'ÉNONCÉ COMMANDE — ou `null` : une demande ordinaire (ou une valeur de champ). `carteEnAttente` : une carte a
 * été résumée dans cette session et attend la réponse de la personne.
 */
export function lireCommandeOrale(texte: string, ctx: { carteEnAttente: boolean }): CommandeOrale | null {
  const p = plier(texte);
  const brut = p.trim();
  if (!brut) return null;
  if (ctx.carteEnAttente) {
    if (estAffirmatif(texte)) return "confirmer";
    if (estRefus(texte) && brut.split(" ").length <= 6) return "refuser";
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

export interface CarteOrale {
  title: string;
  fields?: { label: string; value: string }[];
  confirmText?: string | null;
}

const RE_MONTANT = /montant|amount|total|prix|co[uû]t|somme|budget/i;
const RE_BENEFICIAIRE = /b[ée]n[ée]ficiaire|destinataire|fournisseur|pour|personne|responsable|assign|attribu|employ|m[ée]decin|client|[àa] qui|collaborateur/i;
const RE_OBJET = /^(titre|objet|sujet|nom|libell|intitul|title)/i;
const court = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };

/** LA CARTE EN UNE PHRASE : ce qui sera fait, le montant, pour qui ; puis la relecture de la valeur critique (R3/R4). */
export function resumeOralCarte(c: CarteOrale): string {
  const champs = c.fields ?? [];
  const montant = champs.find((f) => RE_MONTANT.test(f.label) && f.value.trim());
  const pour = champs.find((f) => f !== montant && RE_BENEFICIAIRE.test(f.label) && f.value.trim());
  // L'objet (le titre de la tâche, l'objet du message) quand le titre de la carte ne le dit pas déjà.
  const objet = champs.find((f) => RE_OBJET.test(f.label.trim()) && f.value.trim() && !c.title.includes(f.value.trim()));
  const morceaux = [`${court(c.title, 90)}${objet ? ` « ${court(objet.value, 70)} »` : ""}`];
  if (montant) morceaux.push(`${montant.label.toLowerCase()} ${court(montant.value, 40)}`);
  if (pour) morceaux.push(`${pour.label.toLowerCase()} ${court(pour.value, 50)}`);
  const phrase = `${morceaux.join(", ")}.`;
  return c.confirmText ? `${phrase} Je relis : ${court(c.confirmText, 80)}.` : phrase;
}

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

// ─── LES CHAMPS, UN PAR UN ─────────────────────────────────────────────────────────────────

export interface ChampOral {
  nom: string;
  libelle: string;
  widget: string;
  obligatoire: boolean;
  valeurs: string[] | null;
}

const vide = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Le prochain champ OBLIGATOIRE encore vide (une case n'est jamais « manquante » : non vaut une réponse). */
export function champSuivant(champs: readonly ChampOral[], entree: Readonly<Record<string, unknown>>): ChampOral | null {
  return champs.find((c) => c.obligatoire && c.widget !== "case" && vide(entree[c.nom])) ?? null;
}

/** Au plus deux champs FACULTATIFS utiles à proposer — jamais un identifiant technique ni une case. */
export function facultatifsUtiles(champs: readonly ChampOral[], entree: Readonly<Record<string, unknown>>, max = 2): ChampOral[] {
  const utile = (c: ChampOral) => !c.obligatoire && vide(entree[c.nom]) && !["case", "identifiant", "etiquettes"].includes(c.widget)
    && (c.widget === "reference" || c.widget === "references" || !/(^id$|Id$|_id$)/.test(c.nom));
  const rang = (c: ChampOral) => (c.widget === "date" ? 0 : c.widget === "choix" || c.widget === "reference" ? 1 : c.widget === "nombre" ? 2 : 3);
  return champs.filter(utile).sort((a, b) => rang(a) - rang(b)).slice(0, max);
}

/** La question d'UN champ, à dire : « Pour quelle date ? », « Quel montant ? », avec les choix possibles s'il y en a peu. */
export function questionDuChamp(c: ChampOral): string {
  const choix = c.valeurs?.length && c.valeurs.length <= 5 ? ` (${c.valeurs.join(", ")})` : "";
  return `Il manque ${c.libelle.toLowerCase()}${choix}.`;
}

const MOIS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Une date dite : « demain », « après-demain », « dans 3 jours », « le 12 novembre », « 12/11 », « 2026-11-12 ». */
export function lireDateDite(texte: string, maintenant = new Date()): string | null {
  const p = plier(texte);
  const jour = (n: number) => { const d = new Date(maintenant); d.setDate(d.getDate() + n); return iso(d); };
  if (/\b(\d{4})-(\d{2})-(\d{2})\b/.test(texte)) return texte.match(/\d{4}-\d{2}-\d{2}/)![0];
  if (p.includes(" apres demain ")) return jour(2);
  if (p.includes(" demain ") || p.includes(" ghodwa ")) return jour(1);
  if (p.includes(" aujourd hui ") || p.includes(" lyoum ")) return jour(0);
  const dans = p.match(/ dans (\d+) jours? /);
  if (dans) return jour(Number(dans[1]));
  const num = texte.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  const mois = MOIS.findIndex((m) => p.includes(` ${m} `));
  const quantieme = num ? Number(num[1]) : mois >= 0 ? Number(p.match(/ (\d{1,2}) [a-z]+ /)?.[1] ?? p.match(/ (\d{1,2}) /)?.[1] ?? Number.NaN) : Number.NaN;
  const m = num ? Number(num[2]) - 1 : mois;
  if (!Number.isFinite(quantieme) || m < 0 || m > 11 || quantieme < 1 || quantieme > 31) return null;
  let annee = num?.[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : maintenant.getFullYear();
  const d = new Date(annee, m, quantieme);
  if (!num?.[3] && d.getTime() < new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate()).getTime()) annee += 1;
  return iso(new Date(annee, m, quantieme));
}

export type ValeurDite = { ok: true; valeur: string | boolean | string[] } | { ok: false; raison: string } | { reference: string };

/** LA VALEUR D'UN CHAMP, DITE. Une référence (une fiche) se cherche ensuite par son nom, sous les droits de la personne. */
export function valeurDite(c: ChampOral, texte: string, maintenant = new Date()): ValeurDite {
  const t = (texte ?? "").replace(/^\s*(c'est|c est|mets|met|ce sera|alors|euh|bon)\s+/i, "").replace(/[.!]+$/, "").trim();
  if (!t) return { ok: false, raison: "Je n'ai rien entendu pour ce champ." };
  switch (c.widget) {
    case "nombre": {
      const n = lireNombreDit(t);
      return n == null ? { ok: false, raison: `Un nombre est attendu pour ${c.libelle.toLowerCase()}.` } : { ok: true, valeur: String(n) };
    }
    case "date": {
      const d = lireDateDite(t, maintenant);
      return d ? { ok: true, valeur: d } : { ok: false, raison: `Je n'ai pas compris la date. Dis par exemple « le 12 novembre » ou « demain ».` };
    }
    case "case":
      if (estAffirmatif(t)) return { ok: true, valeur: true };
      if (estRefus(t)) return { ok: true, valeur: false };
      return { ok: false, raison: "Oui ou non ?" };
    case "choix": case "choix-multiple": {
      const p = plier(t);
      const trouves = (c.valeurs ?? []).filter((v) => p.includes(` ${plier(v).trim()} `) || plier(v).includes(` ${p.trim()} `));
      if (c.widget === "choix" && trouves.length === 1) return { ok: true, valeur: trouves[0] };
      if (c.widget === "choix-multiple" && trouves.length) return { ok: true, valeur: trouves };
      return { ok: false, raison: `Les choix sont : ${(c.valeurs ?? []).slice(0, 6).join(", ")}.` };
    }
    case "reference": case "references":
      return { reference: t };
    case "etiquettes":
      return { ok: true, valeur: t.split(/\s*(?:,|\bet\b)\s*/).map((x) => x.trim()).filter(Boolean) };
    default:
      return { ok: true, valeur: t };
  }
}

// ─── L'EMPREINTE ───────────────────────────────────────────────────────────────────────────

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** L'EMPREINTE d'une intention (charge, titre, ressaisie) : deux FNV-1a 32 bits — un changement de champ la change. */
export function empreinteIntention(v: unknown): string {
  const s = stable(v);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
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
