import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { COLONNES_MASQUEES, executerSqlLectureSeule, LIMITE_LIGNES, TABLES_AUTORISEES } from "@/platform/ia/analyse/sql";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { Ligne } from "@/platform/ia/analyse/analyse";
import { appliquerEtapes, MODE_EMPLOI_PIPELINE, OPS_PIPELINE, type ResultatPipeline } from "@/platform/ia/analyse/pipeline";
import { composerAnalyse, type DemandeGraphique, type ResumeAnalyse } from "@/platform/ia/analyse/bloc";
import { lireTableurDuDrive } from "@/platform/ia/analyse/drive";
import { executerJs } from "@/platform/ia/analyse/js";
import { executerPython, sonderPython } from "@/platform/ia/analyse/python";
import { passerLaPorte, type Attente, type SchemaSortie } from "@/platform/ia/analyse/porte";
import { GRAPHIQUES_ANALYSE } from "@/platform/ia/workspace/analyse";
import { JeuxDuTour, type JeuDeDonnees } from "../../domaine/analyse/jeux";
import { masquerColonnes } from "../../domaine/analyse/confidentialite";
import { nombresDe } from "../../domaine/ui/composants";
import { jetonnerSortie, MOTS_CLES_SENSIBLES, type CoffretDuTour } from "../../domaine/filtre-confidentialite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS D'ANALYSE DE L'ASSISTANT IA (lot K1, décision 0031) — il CALCULE, il n'affirme pas.
 *
 *   · `lire_tableur`      un Excel / CSV joint ou du Drive, lu TYPÉ (feuilles, en-têtes, types, formules → valeurs),
 *                         sous `canViewDrive` ; chaque feuille devient un jeu de données du tour ;
 *   · `analyser_donnees`  le pipeline FERMÉ du socle (filtrer, regrouper, croiser, série, croissance, tendance,
 *                         anomalies, cohortes, scénario…) sur un jeu du tour : une LECTURE de la personne, un
 *                         tableur, un résultat SQL ;
 *   · `calculer_code`     JavaScript isolé (toujours), Python s'il est présent (sondé) — la porte de qualité du socle
 *                         (inspecter → exécuter → tester → valider) ;
 *   · `requete_sql`       lecture seule, réservée à la VUE GLOBALE (la même règle qu'Adam : le SQL libre traverse le
 *                         cloisonnement par société), inscrite à l'audit.
 *
 * LES CHIFFRES SONT CEUX DU CODE. Le modèle nomme une source et des étapes ; le résultat devient un bloc « analyse »
 * (tableau typé, graphiques vérifiés, journal du calcul) composé par le socle et posé SOUS la réponse ; le modèle n'en
 * reçoit qu'un aperçu aux chiffres déjà formatés, qu'il cite. Les colonnes confidentielles (en-tête) sont masquées
 * AVANT le calcul, les valeurs sensibles d'une cellule deviennent des repères (coffret du tour).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'adresse de l'export Excel d'un clic (et du dépôt au Drive, sur le geste de la personne). */
export const ROUTE_CLASSEUR = "/api/assistant-ia/analyse/classeur";
export const OUTILS_ANALYSE = ["lire_tableur", "analyser_donnees", "calculer_code", "requete_sql"] as const;
const BLOCS_MAX = 3;

export interface ContexteAnalyse {
  jeux: JeuxDuTour;
  /** Les blocs CALCULÉS du tour — ajoutés sous la réponse, après les composants du modèle. */
  blocs: WorkspaceBlock[];
  /** Les pièces jointes du message (déjà revérifiées) : un tableur s'y désigne par son nom. */
  pieces: readonly { id: string; nom: string }[];
  /** La demande de la personne — l'intention du graphique, et la source des paramètres d'un calcul. */
  question: string;
  coffret?: CoffretDuTour | null;
  /** La famille « Drive & documents » est-elle ouverte (console) ? Sinon un fichier ne se lit pas. */
  driveOuvert: boolean;
}

/** Ce que le TOUR fournit (`fil/tour.ts`) ; le catalogue y ajoute le coffret et la famille Drive de la personne. */
export type ContexteAnalyseTour = Pick<ContexteAnalyse, "jeux" | "blocs" | "pieces" | "question">;

// ─── LES SCHÉMAS : chaque objet DÉCLARE ses champs — mesuré au banc K1, un objet sans propriétés arrivait VIDE (`etapes: [{}]`).
const S = { type: "string" } as const;
const N = { type: "number" } as const;
const LISTE_S = { type: "array", items: S } as const;
const MESURE = { type: "object", properties: { colonne: S, agregat: { type: "string", enum: ["sum", "avg", "count", "min", "max", "median", "p90", "distinct"] }, alias: S } } as const;
const SCHEMA_ETAPE = {
  type: "object",
  properties: {
    op: { type: "string", enum: [...OPS_PIPELINE] },
    filtres: { type: "array", items: { type: "object", properties: { colonne: S, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "contient", "vide", "non_vide", "dans"] }, valeur: S } } },
    garder: LISTE_S, par: LISTE_S, mesures: { type: "array", items: MESURE }, mesure: MESURE,
    ligne: S, colonne: S, sens: { type: "string", enum: ["asc", "desc"] }, n: N,
    colonneDate: S, pas: { type: "string", enum: ["jour", "semaine", "mois", "trimestre", "annee"] }, fenetre: N, alias: S, seuil: N, colonneEntite: S,
    variations: { type: "array", items: { type: "object", properties: { colonne: S, pourcent: N } } },
  },
  required: ["op"],
} as const;
const SCHEMA_GRAPHIQUES = { type: "array", items: { type: "object", properties: { type: { type: "string", enum: [...GRAPHIQUES_ANALYSE] }, x: S, y: LISTE_S, serie: S, titre: S } }, description: "Facultatif ; sans : choix automatique (une forme trompeuse est remplacée)." } as const;
const SCHEMA_FORMATS = { type: "array", items: { type: "object", properties: { colonne: S, format: { type: "string", enum: ["dzd", "pourcent", "entier", "nombre", "date", "texte"] } } }, description: "Facultatif." } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const json = (o: unknown): string => JSON.stringify(o);
const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const RE_FICHIER = /\.(xlsx|xlsm|csv|tsv)$/i;
const RE_ID = /^c[a-z0-9]{20,}$/;

/** Les lignes d'un fichier, d'une requête : MASQUÉES (en-têtes) puis JETONNÉES (cellules) — avant tout calcul. */
function proteger(lignes: readonly Ligne[], coffret: CoffretDuTour | null | undefined): { lignes: Ligne[]; masquees: string[] } {
  const m = masquerColonnes(lignes);
  try {
    const j = JSON.parse(jetonnerSortie(JSON.stringify(m.lignes), coffret)) as unknown;
    return { lignes: Array.isArray(j) ? (j.filter(isObj) as Ligne[]) : m.lignes, masquees: m.masquees };
  } catch {
    return m;
  }
}

/** LIRE un tableur (pièce jointe d'abord, sinon le Drive par nom ou identifiant) et inscrire chaque feuille. */
async function lireEtInscrire(user: CurrentUser, ctx: ContexteAnalyse, ref: string) {
  const voulu = plier(ref.replace(/#.*$/, ""));
  const piece = ctx.pieces.find((p) => p.id === ref || plier(p.nom) === voulu) ?? ctx.pieces.find((p) => plier(p.nom).includes(voulu) && RE_FICHIER.test(p.nom));
  const lu = await lireTableurDuDrive(user, piece?.id ?? ref.replace(/#.*$/, ""));
  if (!lu.ok) return lu;
  const jeux: JeuDeDonnees[] = lu.feuilles.map((f) => {
    const p = proteger(f.lignes, ctx.coffret);
    return { id: `${lu.nom}#${f.nom}`, origine: `fichier « ${lu.nom} » · feuille ${f.nom}${f.tronque ? ` (${f.lignes.length} lignes lues sur ${f.total})` : ""}`, lignes: p.lignes, masquees: p.masquees };
  });
  for (const j of jeux) ctx.jeux.inscrire(j);
  return { ok: true as const, lu, jeux };
}

/** CHARGER le jeu désigné : un jeu du tour, sinon un tableur joint ou du Drive (famille Drive ouverte). */
async function charger(user: CurrentUser, ctx: ContexteAnalyse, source: string, feuille: string): Promise<JeuDeDonnees | { erreur: string }> {
  const nom = feuille ? `${source.replace(/#.*$/, "")}#${feuille}` : source;
  const trouve = ctx.jeux.trouver(nom) ?? (feuille ? null : ctx.jeux.trouver(source));
  if (trouve) return trouve;
  const fichier = RE_FICHIER.test(source.replace(/#.*$/, "")) || RE_ID.test(source) || ctx.pieces.some((p) => plier(p.nom).includes(plier(source)));
  if (fichier) {
    if (!ctx.driveOuvert) return { erreur: "La famille « Drive & documents » est fermée pour vous par la Direction : un fichier ne se lit pas (console /admin/ai/acces)." };
    const r = await lireEtInscrire(user, ctx, source);
    if (!r.ok) return { erreur: `fichier : ${r.erreur}` };
    const j = ctx.jeux.trouver(nom) ?? (feuille ? null : r.jeux[0]);
    if (j) return j;
    return { erreur: `feuille « ${feuille} » introuvable — feuilles : ${r.lu.feuilles.map((f) => f.nom).join(", ")}` };
  }
  const dispo = ctx.jeux.lister();
  return {
    erreur: dispo.length
      ? `aucun jeu « ${source} » dans ce tour — jeux disponibles : ${dispo.map((d) => `${d.id} (${d.lignes} lignes : ${d.colonnes.join(", ")})`).join(" ; ")}`
      : `aucun jeu « ${source} » : appelle d'abord une LECTURE (read_budget, demandes…, la lecture qui donne les lignes) ou lire_tableur pour un fichier, puis donne son nom en source`,
  };
}

/** Une préférence de graphique, lue sans confiance : des NOMS de forme et de colonnes, jamais des chiffres. */
function graphiquesDe(v: unknown): DemandeGraphique[] {
  const brut = Array.isArray(v) ? v : isObj(v) ? [v] : typeof v === "string" ? [{ type: v }] : [];
  return brut.filter(isObj).slice(0, 2).map((g) => ({
    type: str(g.type, 30) || null, x: str(g.x, 80) || null, serie: str(g.serie, 80) || null, titre: str(g.titre, 120) || null,
    y: Array.isArray(g.y) ? g.y.map((x) => str(x, 80)).filter(Boolean) : str(g.y, 80) ? [str(g.y, 80)] : null,
  }));
}

/** Des MOTS par colonne (format, libellé) : `[{colonne, format}]` (le schéma) ou `{colonne: format}`. */
const motsDe = (v: unknown, cle = "format"): Record<string, string> => {
  const paires = Array.isArray(v) ? v.filter(isObj).map((x) => [str(x.colonne, 80), str(x[cle], 60)] as const) : isObj(v) ? Object.entries(v).map(([k, x]) => [k.slice(0, 80), str(x, 60)] as const) : [];
  return Object.fromEntries(paires.filter(([k, x]) => k && x));
};

/** POSER le bloc calculé sous la réponse ; inscrire le résultat comme jeu (une analyse s'enchaîne sur la précédente). */
function poser(ctx: ContexteAnalyse, titre: string, lignes: Ligne[], d: Omit<Parameters<typeof composerAnalyse>[0], "titre" | "lignes" | "question">, entree: Record<string, unknown>): { resume: ResumeAnalyse; jeu: string; affiche: boolean } {
  const { bloc, resume } = composerAnalyse({
    ...d, titre, lignes, question: str(entree.question, 400) || ctx.question,
    graphiques: graphiquesDe(entree.graphiques ?? entree.graphique), formats: motsDe(entree.formats), libelles: motsDe(entree.libelles),
  });
  // Le bloc montre 12 colonnes ; le modèle doit savoir TOUTES celles du résultat — mesuré au banc : un `SELECT *` de 30
  // colonnes, dont `paymentStatus` en 20e, lui faisait conclure « les ventes n'ont pas de statut de paiement ».
  const toutes = [...new Set(lignes.slice(0, 500).flatMap((l) => Object.keys(l)))];
  if (toutes.length > resume.colonnes.length) resume.colonnesDuResultat = toutes.slice(0, 80);
  const affiche = ctx.blocs.filter((b) => b.kind === "analyse").length < BLOCS_MAX;
  if (affiche) ctx.blocs.push({ ...bloc, exportExcel: ROUTE_CLASSEUR, provenance: "Calculé par le code" });
  const jeu = ctx.jeux.inscrire({ id: `analyse:${titre}`, origine: `analyse « ${titre} »`, lignes, masquees: d.masquees ? [...d.masquees] : [] });
  return { resume, jeu, affiche };
}

const CONSIGNE_SORTIE = "Ces chiffres sont CALCULÉS par le code : cite-les EXACTEMENT tels qu'écrits ici (déjà formatés), n'en calcule aucun toi-même. Le tableau, le graphique, « Comment c'est calculé » et l'export Excel sont affichés sous ta réponse : ne les recopie pas et ne fais pas de composant table/chart pour eux.";

function sortieAnalyse(ok: boolean, titre: string, source: string, r: { resume: ResumeAnalyse; jeu: string; affiche: boolean }, extra: Record<string, unknown> = {}): string {
  return json({
    ok, titre, source,
    rendu: r.affiche ? `affiché sous ta réponse : tableau (${r.resume.lignesTotal} ligne(s), tri, filtre, totaux)${r.resume.graphiques.length ? `, graphique ${r.resume.graphiques.map((g) => g.type).join(" + ")}` : ""}, « Comment c'est calculé », export Excel` : "trois analyses déjà affichées dans ce tour : celle-ci n'est pas dessinée",
    jeu: r.jeu, ...extra,
    colonnes: r.resume.colonnes, ...(r.resume.colonnesDuResultat ? { colonnesDuResultat: r.resume.colonnesDuResultat, noteColonnes: "le tableau affiché montre les 12 premières ; toutes celles-ci existent et se filtrent / regroupent" } : {}),
    lignesTotal: r.resume.lignesTotal, apercu: r.resume.apercu,
    ...(r.resume.lignesTotal > r.resume.apercu.length ? { note: `${r.resume.apercu.length} lignes montrées ici sur ${r.resume.lignesTotal} — agréger (regrouper, limiter) pour en parler` } : {}),
    ...(r.resume.totaux ? { totaux: r.resume.totaux } : {}),
    ...(r.resume.resultats ? { resultats: r.resume.resultats } : {}),
    graphiques: r.resume.graphiques,
    consigne: CONSIGNE_SORTIE,
  });
}

function outilLireTableur(user: CurrentUser, ctx: ContexteAnalyse): PowerTool {
  return {
    def: {
      name: "lire_tableur",
      description:
        "LIT UN TABLEUR (Excel .xlsx/.xlsm ou CSV) joint au message ou du Drive, TYPÉ : chaque feuille, sa ligne d'en-tête, ses colonnes et leur type "
        + "(nombre, date, texte), le nombre de lignes, ses formules (leur valeur calculée est prise). Chaque feuille devient un JEU (« Fichier.xlsx#Feuille ») "
        + "que analyser_donnees calcule ensuite. À appeler avant toute question chiffrée sur un fichier — jamais de lecture « à l'œil » d'un Excel.",
      input_schema: { type: "object", properties: { fichier: { type: "string", description: "Le nom du fichier joint ou du Drive (ou son identifiant)." } }, required: ["fichier"] },
    },
    allowed: (u) => u.id === user.id,
    label: "Tableur lu",
    run: async (entree) => {
      const ref = str(entree.fichier, 240) || ctx.pieces.find((p) => RE_FICHIER.test(p.nom))?.nom || "";
      if (!ref) return json({ ok: false, erreur: "Nommez le fichier (joint au message ou du Drive)." });
      if (!ctx.driveOuvert) return json({ statut: "REFUS", raison: "La famille « Drive & documents » est fermée pour vous par la Direction (console /admin/ai/acces)." });
      const r = await lireEtInscrire(user, ctx, ref);
      if (!r.ok) return json({ ok: false, erreur: r.erreur });
      return json({
        ok: true, fichier: r.lu.nom, format: r.lu.format,
        feuilles: r.lu.feuilles.map((f, i) => ({
          jeu: r.jeux[i]?.id, feuille: f.nom, ligneEntete: f.ligneEntete, lignes: f.total, ...(f.tronque ? { lues: f.lignes.length } : {}),
          colonnes: f.colonnes.map((c) => ({ nom: c.nom, type: (r.jeux[i]?.masquees ?? []).includes(c.nom) ? "confidentielle (masquée)" : c.type })),
          ...(f.formules ? { formules: f.formules, ...(f.formulesSansValeur ? { formulesSansValeur: `${f.formulesSansValeur} formule(s) sans valeur enregistrée : lues vides — le fichier n'a pas été recalculé par Excel` } : {}) } : {}),
          apercu: (r.jeux[i]?.lignes ?? []).slice(0, 8),
        })),
        consigne: "Pour tout chiffre (total, moyenne, part, classement, évolution) : analyser_donnees avec source = le jeu de la feuille. Ne calcule rien à partir de l'aperçu.",
      });
    },
  };
}

function outilAnalyser(user: CurrentUser, ctx: ContexteAnalyse): PowerTool {
  return {
    def: {
      name: "analyser_donnees",
      description:
        "CALCUL EXACT (le code calcule, jamais toi) sur un jeu du tour : `source` = le nom d'une LECTURE déjà appelée (« read_budget », « demandes_adpro »), "
        + "une feuille (« Fichier.xlsx#Feuille »), un fichier joint, « sql:<titre> » ou « analyse:<titre> ». `etapes` dans l'ordre : "
        + "filtrer{filtres:[{colonne,op,valeur}]} · regrouper{par:[…],mesures:[{colonne,agregat:sum|avg|count|min|max|median}]} · croiser{ligne,colonne,mesure} · "
        + "trier{colonne,sens} · limiter{n} · serie{colonneDate,mesure,pas:mois} · croissance{colonne} · cumul{colonne} · tendance{colonne} · anomalies{colonne} · scenario{variations:[{colonne,pourcent}],mesure}. "
        + "Affiche sous ta réponse le tableau (tri, filtre, totaux), le graphique vérifié, « Comment c'est calculé » et l'export Excel ; te rend les chiffres formatés à citer.",
      input_schema: {
        type: "object",
        properties: { source: S, feuille: S, etapes: { type: "array", items: SCHEMA_ETAPE }, titre: S, graphiques: SCHEMA_GRAPHIQUES, formats: SCHEMA_FORMATS },
        required: ["source", "etapes"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Analyse calculée",
    run: async (entree) => {
      const source = str(entree.source, 240);
      const titre = str(entree.titre, 120) || "Analyse";
      const etapes = Array.isArray(entree.etapes) ? entree.etapes : [];
      const jeu = await charger(user, ctx, source, str(entree.feuille, 80));
      if ("erreur" in jeu) return json({ ok: false, erreur: jeu.erreur });
      const p = masquerColonnes(jeu.lignes);
      const r: ResultatPipeline = appliquerEtapes(p.lignes, etapes);
      const masquees = [...new Set([...jeu.masquees, ...p.masquees])];
      const pose = poser(ctx, titre, r.lignes, {
        source: jeu.origine, sources: [jeu.origine], entree: p.lignes, moteur: "opérations fermées du socle (pipeline vérifié)",
        pipeline: { etapes, journal: r.journal, erreurs: r.erreurs, ignores: r.ignores, resultats: r.resultats }, masquees,
      }, entree);
      return sortieAnalyse(r.erreurs.length === 0 || r.journal.length > 0, titre, jeu.origine, pose, {
        lignesEntree: jeu.lignes.length,
        ...(r.erreurs.length ? { etapesRefusees: r.erreurs, modeEmploi: MODE_EMPLOI_PIPELINE } : {}),
        ...(r.ignores.length ? { ignores: r.ignores } : {}),
        ...(masquees.length ? { masquees: masquees.map((m) => `${m} (confidentielle : ni lue, ni calculée)`) } : {}),
      });
    },
  };
}

/** Les PARAMÈTRES d'un calcul (taux, horizon, montant) : chaque nombre doit venir de la demande — sinon le calcul est refusé. */
/** Les constantes d'un calcul qui ne sont pas des données (pourcent, mois, jours, milliers). */
const CONSTANTES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 30, 31, 52, 60, 100, 365, 1000, 0.5]);

function parametresProuves(v: unknown, question: string, code: string): { ok: true; parametres: Record<string, unknown> } | { ok: false; motif: string } {
  const connus = new Set(nombresDe(question));
  // UN NOMBRE ÉCRIT EN DUR DANS LE CODE est un paramètre comme un autre : il vient de la demande, ou c'est une constante.
  const sansChaines = code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ").replace(/\/\/.*$|#.*$/gm, " ");
  for (const m of sansChaines.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)) {
    const x = Number(m[0]);
    const puissanceDeDix = x >= 10 && Number.isInteger(Math.log10(x));
    if (!CONSTANTES.has(x) && !puissanceDeDix && !(Number.isInteger(x) && x <= 12) && !connus.has(x)) return { ok: false, motif: `le nombre ${m[0]} écrit dans le code ne vient pas de la demande : passe-le dans params (tiré de la demande) ou lis-le par un outil` };
  }
  const objet: Record<string, unknown> = Array.isArray(v) ? Object.fromEntries(v.filter(isObj).map((x) => [str(x.nom, 40), x.valeur]).filter(([k]) => k)) : isObj(v) ? v : {};
  if (!Object.keys(objet).length) return { ok: true, parametres: {} };
  for (const [k, x] of Object.entries(objet)) {
    const n = typeof x === "number" ? x : typeof x === "string" && /^-?\d+([.,]\d+)?$/.test(x.trim()) ? Number(x.replace(",", ".")) : null;
    if (n !== null && !(Number.isInteger(n) && Math.abs(n) <= 12) && !connus.has(n) && !connus.has(Math.abs(n))) {
      return { ok: false, motif: `le paramètre « ${k} » = ${n} ne vient ni de la demande ni d'une lecture : lis la valeur (outil) ou demande-la` };
    }
  }
  return { ok: true, parametres: objet };
}

/** Les paramètres (scalaires) en littéral Python — `true` n'est pas du Python. */
function litteralPython(p: Record<string, unknown>): string {
  const v = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? String(x) : typeof x === "boolean" ? (x ? "True" : "False") : typeof x === "string" ? JSON.stringify(x) : "None");
  return `{${Object.entries(p).map(([k, x]) => `${JSON.stringify(k)}: ${v(x)}`).join(", ")}}`;
}

function outilCalculer(user: CurrentUser, ctx: ContexteAnalyse): PowerTool {
  return {
    def: {
      name: "calculer_code",
      description:
        "CALCUL SUR MESURE EN CODE ISOLÉ, quand les étapes d'analyser_donnees ne suffisent pas (taux composé, projection, simulation, ratio croisé). "
        + "JavaScript (toujours) : `data` = les lignes du jeu `source`, `params` = les paramètres ; lib{sum,mean,median,min,max,round,groupBy,sortBy,uniq,countBy,pick,toNumber,month,daysBetween} ; "
        + "le code `return` un résultat JSON de NOMBRES BRUTS, jamais formatés (une liste d'objets devient un tableau ; un objet, une ligne). Python : si le serveur l'a (dit dans la réponse) — lit `data`/`params`, pose `result`. "
        + "Fil isolé, contexte vide, 5 s, 128 Mo, rien n'est écrit. Les nombres de `params` doivent venir de la DEMANDE. Déclare des `attentes` (assertions) : un résultat qui ne les tient pas n'est pas exposé.",
      input_schema: {
        type: "object",
        properties: {
          langage: { type: "string", enum: ["js", "python"] },
          code: S,
          source: { type: "string", description: "Facultatif — le jeu du tour qui devient `data`." },
          params: { type: "array", items: { type: "object", properties: { nom: S, valeur: N }, required: ["nom", "valeur"] }, description: "Les nombres TIRÉS DE LA DEMANDE, nommés : [{nom:'ca', valeur:12500000}] → params.ca." },
          titre: S,
          attentes: { type: "array", items: { type: "object", properties: { chemin: S, op: { type: "string", enum: ["egal", "different", "superieur", "inferieur", "entre", "contient", "longueur", "nonVide", "type"] }, valeur: N, bornes: { type: "array", items: N }, libelle: S } } },
          graphiques: SCHEMA_GRAPHIQUES,
        },
        required: ["code"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Calcul en code isolé",
    run: async (entree) => {
      const langage = str(entree.langage, 10).toLowerCase() === "python" ? "python" : "js";
      const code = typeof entree.code === "string" ? entree.code : "";
      const titre = str(entree.titre, 120) || "Résultat du calcul";
      const params = parametresProuves(entree.params, ctx.question, code);
      if (!params.ok) return json({ ok: false, erreur: params.motif });
      let data: unknown = [];
      let origine = "aucune donnée (paramètres de la demande seulement)";
      let masquees: string[] = [];
      const source = str(entree.source, 240);
      if (source) {
        const jeu = await charger(user, ctx, source, "");
        if ("erreur" in jeu) return json({ ok: false, erreur: jeu.erreur });
        const p = masquerColonnes(jeu.lignes);
        data = p.lignes; origine = jeu.origine; masquees = [...new Set([...jeu.masquees, ...p.masquees])];
      }
      if (langage === "python") {
        const dispo = sonderPython();
        if (!dispo.disponible) return json({ ok: false, langage, erreur: `Python indisponible sur ce serveur : ${dispo.raison}. Réécris en JavaScript (langage: "js").` });
      }
      const enveloppe = langage === "python" ? `params = ${litteralPython(params.parametres)}\n${code}` : `const params = ${JSON.stringify(params.parametres)};\n${code}`;
      const porte = await passerLaPorte({
        code: enveloppe, langage, data,
        attentes: (Array.isArray(entree.attentes) ? entree.attentes.filter(isObj) : []) as unknown as Attente[],
        schema: (isObj(entree.schema) ? entree.schema : null) as SchemaSortie | null,
        executer: async (c, d) => { const x = langage === "python" ? await executerPython(c, d) : await executerJs(c, d); return { ok: x.ok, resultat: x.resultat, erreur: x.erreur, ms: x.ms, journal: x.journal }; },
      });
      const etapesPorte = porte.etapes.map((e) => `${e.etape} : ${e.ok ? "ok" : "REFUS"} — ${e.detail}`);
      if (!porte.expose) return json({ ok: false, langage, refusePar: porte.refusePar, correction: porte.correction, etapes: etapesPorte, consigne: "Corrige le CODE (pas l'attente), puis rappelle l'outil." });
      const res = porte.resultat;
      // Une liste d'objets est un tableau ; un objet de scalaires est UNE ligne (ses clés sont des colonnes, leur nom dit le
      // format : `tcam_pct` en %, `ecart` en DZD) ; un objet imbriqué se lit indicateur par indicateur ; un scalaire seul aussi.
      const scalaire = (v: unknown) => v === null || ["number", "string", "boolean"].includes(typeof v);
      const lignes: Ligne[] = Array.isArray(res) && res.some(isObj)
        ? (res.filter(isObj) as Ligne[])
        : isObj(res) && Object.values(res).every(scalaire) ? [res as Ligne]
          : isObj(res) ? Object.entries(res).map(([indicateur, valeur]) => ({ indicateur, valeur: scalaire(valeur) ? valeur : JSON.stringify(valeur).slice(0, 200) }))
            : [{ [titre]: res as unknown }];
      const moteur = langage === "python" ? "Python isolé (processus aux limites noyau)" : "JavaScript isolé (fil séparé, contexte vide)";
      const pose = poser(ctx, titre, lignes, {
        source: origine, sources: [origine, ...(Object.keys(params.parametres).length ? [`paramètres de la demande : ${Object.entries(params.parametres).map(([k, v]) => `${k} = ${String(v)}`).join(", ")}`] : [])],
        moteur, masquees,
        pipeline: { etapes: [{ op: "code" }], journal: [{ op: "code", avant: Array.isArray(data) ? data.length : 0, apres: lignes.length, note: `${moteur} · tests ${porte.testsPasses}/${porte.testsTotal}` }], erreurs: [], ignores: [], resultats: {} },
      }, entree);
      // La formule d'une étape « code » est le code lui-même (borné) : la personne relit ce qui a tourné.
      const dernier = ctx.blocs[ctx.blocs.length - 1];
      if (pose.affiche && dernier?.kind === "analyse") dernier.journal.etapes = dernier.journal.etapes.map((e) => (e.op === "code" ? { ...e, formule: code.slice(0, 600) } : e));
      return sortieAnalyse(true, titre, origine, pose, { langage, porte: { tests: `${porte.testsPasses}/${porte.testsTotal}`, etapes: etapesPorte } });
    },
  };
}

function outilSql(user: CurrentUser, ctx: ContexteAnalyse): PowerTool {
  return {
    def: {
      name: "requete_sql",
      description:
        "REQUÊTE SQL EN LECTURE SEULE (PostgreSQL) — réservée à la VUE GLOBALE (direction) : jointures, agrégats par mois, comparaisons entre modules, gros volumes. "
        + "Un seul SELECT (ou WITH … SELECT), sans point-virgule ni commentaire, colonnes entre guillemets doubles (\"createdAt\") ; tables : "
        + [...TABLES_AUTORISEES].filter((t) => /^(Sale|Task|Employee|Department|BudgetEnvelope|BudgetCategoryLine|ExpenseOrder|PaymentRequest|FinanceTransaction|SponsoringRequest|Event|RegulatoryDossier|PchTender|PchOrder|Supplier|Company)$/.test(t)).join(", ")
        + "… Lecture seule, 500 lignes, 5 s, audit. Le résultat s'affiche (tableau + graphique) et devient le jeu « sql:<titre> ».",
      input_schema: {
        type: "object",
        properties: { sql: { type: "string" }, titre: { type: "string" }, question: { type: "string" }, graphiques: { type: "array", items: { type: "object" } }, formats: { type: "object" } },
        required: ["sql"],
      },
    },
    // LA VUE GLOBALE, et elle seule — la même règle qu'Adam (`sql_query`) : `executerSqlLectureSeule` la revérifie.
    allowed: (u) => u.id === user.id && hasGlobalView(u),
    refus: "Le SQL libre est réservé à la vue globale (direction, Super Admin).",
    label: "Requête SQL en lecture seule",
    run: async (entree, u) => {
      const sql = typeof entree.sql === "string" ? entree.sql.trim() : "";
      const titre = str(entree.titre, 120) || "Résultat SQL";
      // UNE COLONNE CONFIDENTIELLE NE SE NOMME PAS (décision 0012) : le bac masque par nom de SORTIE, et un alias
      // (`SELECT "baseSalary" AS x`) passerait — risque R3 de l'inventaire. L'Assistant IA refuse la requête avant de l'exécuter.
      const plat = sql.toLowerCase().replace(/[^a-z0-9]/g, "");
      const nommee = [...COLONNES_MASQUEES].find((c) => new RegExp(`(^|[^A-Za-z0-9_])${c}([^A-Za-z0-9_]|$)`, "i").test(sql))
        ?? MOTS_CLES_SENSIBLES.filter((m) => m.length >= 5).find((m) => plat.includes(m));
      if (nommee) return json({ ok: false, erreur: `Requête refusée : elle nomme une colonne confidentielle (« ${nommee} ») — rémunérations, coordonnées bancaires et pièces d'identité ne passent jamais par l'assistant.` });
      const r = await executerSqlLectureSeule(u, sql, { limite: LIMITE_LIGNES });
      await recordAudit({
        actorId: u.id, action: "EXPORT", module: "ASSISTANT",
        summary: `Assistant IA · SQL en lecture seule (${r.isolation ?? "refusé"}) · ${r.ok ? `${r.lignes.length} ligne(s)${r.tronque ? " (tronqué)" : ""} · ${r.relations.join(", ")}` : `refus : ${r.erreur}`} · ${sql.replace(/\s+/g, " ").slice(0, 160)}`,
      }).catch(sansBloquer("assistant-ia.analyse.sql.audit"));
      if (!r.ok) return json({ ok: false, erreur: r.erreur, regle: "un seul SELECT/WITH, sans point-virgule ni commentaire, colonnes entre guillemets doubles" });
      const p = proteger(r.lignes, ctx.coffret);
      const origine = `requête SQL en lecture seule (${r.relations.join(", ")})${r.tronque ? ` — tronquée à ${LIMITE_LIGNES} lignes` : ""}`;
      ctx.jeux.inscrire({ id: `sql:${titre}`, origine, lignes: p.lignes, masquees: p.masquees });
      const pose = poser(ctx, titre, p.lignes, {
        source: origine, sources: [origine, `SQL : ${sql.replace(/\s+/g, " ").slice(0, 400)}`], moteur: "PostgreSQL, transaction en lecture seule", masquees: p.masquees,
        pipeline: { etapes: [{ op: "sql" }], journal: [{ op: "sql", avant: 0, apres: p.lignes.length, note: `${r.ms} ms · ${r.isolation}` }], erreurs: [], ignores: [], resultats: {} },
      }, entree);
      const dernier = ctx.blocs[ctx.blocs.length - 1];
      if (pose.affiche && dernier?.kind === "analyse") dernier.journal.etapes = dernier.journal.etapes.map((e) => (e.op === "sql" ? { ...e, formule: sql.slice(0, 600) } : e));
      return sortieAnalyse(true, titre, origine, pose);
    },
  };
}

/** Les outils d'analyse de CE tour. */
export function outilsAnalyse(user: CurrentUser, ctx: ContexteAnalyse): PowerTool[] {
  return [outilLireTableur(user, ctx), outilAnalyser(user, ctx), outilCalculer(user, ctx), outilSql(user, ctx)];
}

export { JeuxDuTour };
