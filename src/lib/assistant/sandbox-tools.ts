/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DU BAC À SABLE (mandat 4 §25) — Adam CALCULE, il n'affirme pas.
 *
 * Quatre outils, une frontière : RIEN ICI N'ÉCRIT.
 *
 *   · `sql_query`     lit la base en LECTURE SEULE (transaction read-only, liste blanche relue dans
 *                     le plan d'exécution, délai, volume borné), sous la VUE GLOBALE seulement —
 *                     le SQL libre traverse le cloisonnement par société que les outils appliquent
 *                     ligne à ligne : c'est un pouvoir de direction, et il s'inscrit à l'audit.
 *   · `run_analysis`  enchaîne des opérations FERMÉES (filtrer, regrouper, croiser, série,
 *                     tendance, cohortes, anomalies, scénario…) sur des lignes qui viennent d'une
 *                     lecture canonique (droit revérifié par `executePowerTool`), d'un fichier du
 *                     Drive (droit du nœud) ou d'une requête SQL (vue globale).
 *   · `run_code`      exécute du JavaScript (fil isolé, contexte vide) ou du Python (processus
 *                     isolé, limites noyau — déclaré absent quand il l'est) sur ces mêmes lignes,
 *                     quand les opérations ne suffisent pas.
 *   · `chart_advice`  recommande LE graphique pour la question et dit ce qui TROMPERAIT.
 *
 * Le modèle écrit la SPEC ou le CODE ; ce fichier décide ce qui tourne, avec quels droits, dans
 * quelles limites, et ce qui s'affiche — `_blocs` est un tableau composé par le code à partir
 * des lignes calculées, jamais une paraphrase du modèle. Chaque résultat porte sa PROVENANCE
 * (F8) : entrées, transformation, formule, date.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { construireViz } from "@/platform/ia/workspace/viz-block";
import { TABLE_SOURCES, rowsOf } from "@/lib/assistant/show-tools";
import { faitCalcule, declarerProvenance } from "@/platform/in-process/fabric/provenance";
import {
  executerSqlLectureSeule, TABLES_AUTORISEES, LIMITE_LIGNES, journaliserSql,
  executerJs, executerPython, sonderPython,
  appliquerEtapes, OPS_PIPELINE, MODE_EMPLOI_PIPELINE,
  recommanderGraphique, verifierGraphique, decrire,
  lireLignesDrive, aVueGlobale,
  passerLaPorte, type Attente, type SchemaSortie,
  type Ligne, type SpecGraphique,
} from "@/platform/in-process/sandbox";

/** L'acteur d'un outil — le même type que `PowerTool.run`, sans importer la session (frontière Adam ↔ ERP). */
type Acteur = Parameters<PowerTool["run"]>[1];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Lignes montrées AU MODÈLE : au-delà, il raisonne mal et le contexte explose — le tableau affiché en montre 50, le total est dit. */
const LIGNES_MODELE = 60;
const COLONNES_BLOC = 8;

/**
 * LES LECTURES QU'UNE ANALYSE PEUT PRENDRE POUR SOURCE — des LECTURES, jamais un geste. Un modèle
 * qui nommerait `teach_adam` ou `run_mission` comme « source » verrait son analyse refusée : le
 * bac à sable calcule sur ce qui a été lu, il ne fait rien arriver.
 */
const LECTURES_AUTORISEES = /^(read_|list_|search_|regulatory_|finance_|directory_list$|data_quality$|company_state$|executive_alerts$|what_changed$|inspect_record$|employee_360$|supplier_360$|partner_360$|product_360$|market_)/;

interface Chargement { lignes: Ligne[]; origine: string; note?: string; provenance: string[] }

/** Les lignes d'une sortie d'outil quelconque : le plus grand tableau d'objets, à trois niveaux au plus. */
function lignesDeSortie(raw: string): Ligne[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  let meilleur: Ligne[] = [];
  const visiter = (v: unknown, prof: number) => {
    if (prof > 3 || !v) return;
    if (Array.isArray(v)) {
      const objets = v.filter(isObj);
      if (objets.length > meilleur.length) meilleur = objets;
      return;
    }
    if (isObj(v)) for (const x of Object.values(v)) visiter(x, prof + 1);
  };
  visiter(data, 0);
  return meilleur;
}

/** CHARGER les lignes depuis la source déclarée — chaque chemin porte SON droit. */
export async function chargerLignes(input: Record<string, unknown>, user: Acteur): Promise<Chargement | { erreur: string }> {
  const src = isObj(input.source) ? input.source : input;
  if (Array.isArray(src.lignes) || Array.isArray(input.lignes)) {
    const lignes = ((Array.isArray(src.lignes) ? src.lignes : input.lignes) as unknown[]).filter(isObj).slice(0, 20_000);
    if (!lignes.length) return { erreur: "« lignes » ne contient aucun objet" };
    return { lignes, origine: "lignes fournies dans la conversation (non relues à une source)", provenance: ["lignes fournies par la conversation"], note: "ces lignes viennent du modèle, pas d'une lecture : les chiffres ne sont pas vérifiés à la source" };
  }
  const drive = typeof src.drive === "string" ? src.drive.trim() : "";
  if (drive) {
    const r = await lireLignesDrive(user, drive, { feuille: typeof src.feuille === "string" ? src.feuille : null });
    if (!r.ok) return { erreur: `fichier Drive : ${r.erreur}${r.candidats ? " — candidats : " + r.candidats.map((c) => `${c.nom} (${c.id})`).join(", ") : ""}` };
    return {
      lignes: r.lignes, provenance: [`fichier Drive « ${r.nom} »${r.feuille ? ` · feuille ${r.feuille}` : ""}`],
      origine: `fichier Drive « ${r.nom} »${r.feuille ? ` (feuille ${r.feuille})` : ""} · ${r.total} ligne(s)${r.tronque ? `, ${r.lignes.length} lues` : ""}`,
      ...(r.tronque ? { note: `fichier tronqué à ${r.lignes.length} lignes` } : {}),
    };
  }
  const sql = typeof src.sql === "string" ? src.sql.trim() : "";
  if (sql) {
    const r = await executerSqlLectureSeule(user, sql, { limite: LIMITE_LIGNES });
    await journaliserSql(user, sql, r);
    if (!r.ok) return { erreur: `SQL : ${r.erreur}` };
    return { lignes: r.lignes, origine: `requête SQL en lecture seule (${r.relations.join(", ")}) · ${r.lignes.length} ligne(s)${r.tronque ? " (tronqué)" : ""}`, provenance: r.relations.map((t) => `table ${t}`), ...(r.tronque ? { note: `résultat SQL tronqué à ${LIMITE_LIGNES} lignes` } : {}) };
  }
  const cle = typeof src.source === "string" ? src.source.trim() : "";
  const outilDirect = typeof src.outil === "string" ? src.outil.trim() : "";
  const source = cle ? Object.entries(TABLE_SOURCES).find(([k]) => fold(k) === fold(cle))?.[1] ?? null : null;
  const outil = source?.tool ?? outilDirect ?? "";
  if (!outil) return { erreur: `aucune source : donner « source » (${Object.keys(TABLE_SOURCES).join(", ")}), « outil » (une lecture), « drive » (fichier), « sql » (vue globale) ou « lignes »` };
  if (!source && !LECTURES_AUTORISEES.test(outil)) return { erreur: `« ${outil} » n'est pas une lecture : le bac à sable n'analyse que ce qui a été LU` };
  // Import PARESSEUX : `power-tools` importe ce fichier, un import statique ferait un cycle.
  const { executePowerTool } = await import("@/lib/assistant/power-tools");
  const args: Record<string, unknown> = isObj(src.args) ? { ...src.args } : {};
  if (source) for (const a of source.args ?? []) if (src[a] !== undefined && args[a] === undefined) args[a] = src[a];
  const raw = await executePowerTool(outil, args, user);
  if (raw === null) return { erreur: `lecture « ${outil} » inconnue` };
  const lignes = source ? rowsOf(raw, source.keys) : lignesDeSortie(raw);
  if (!lignes.length) return { erreur: `la lecture « ${outil} » n'a rendu aucune ligne : ${raw.slice(0, 240)}` };
  return { lignes, origine: `${source?.titre ?? outil} (lecture ${outil}) · ${lignes.length} ligne(s)`, provenance: [`lecture ${outil}`] };
}

/** LE TABLEAU AFFICHÉ — composé par le code depuis les lignes calculées. */
export function blocTableau(titre: string, lignes: readonly Ligne[]): Record<string, unknown> | null {
  if (!lignes.length) return null;
  const compte = new Map<string, number>();
  for (const l of lignes) for (const k of Object.keys(l)) compte.set(k, (compte.get(k) ?? 0) + 1);
  const cles = [...compte.keys()].slice(0, COLONNES_BLOC);
  if (!cles.length) return null;
  const columns = cles.map((k) => ({ key: k, label: k.replace(/_/g, " "), numeric: lignes.every((l) => l[k] === null || l[k] === undefined || typeof l[k] === "number") }));
  const rows = lignes.slice(0, 50).map((l) => ({ cells: Object.fromEntries(cles.map((k) => [k, formaterCellule(l[k])])) }));
  return { kind: "table", title: titre, columns, rows, total: lignes.length };
}

function formaterCellule(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("fr-FR") : v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function graphiqueEtAlertes(lignes: readonly Ligne[], question: string, titre: string): { graphique: Pick<SpecGraphique, "type" | "x" | "y" | "serie" | "axeYdepartZero" | "raison">; alertes: string[]; blocViz: Record<string, unknown> | null } {
  const spec = recommanderGraphique(lignes, question, titre);
  const alertes = verifierGraphique(spec, lignes).map((a) => `${a.gravite} · ${a.message}`);
  // LE GRAPHIQUE RECOMMANDÉ EST RENDU (§35), pas seulement conseillé : le même bloc `viz` que
  // `render_view`, composé par le code depuis les lignes calculées — le modèle n'a rien à dessiner.
  let blocViz: Record<string, unknown> | null = null;
  if (spec.type !== "tableau") {
    const c = construireViz({ type: spec.type, x: spec.x, y: spec.y, serie: spec.serie ?? null }, lignes);
    if (!("erreur" in c)) blocViz = { kind: "viz", title: titre, type: spec.type, donnees: c.donnees, axeYdepartZero: spec.axeYdepartZero, raison: spec.raison, alertes, note: c.notes.join(" · ") || null };
  }
  return { graphique: { type: spec.type, x: spec.x, y: spec.y, serie: spec.serie ?? null, axeYdepartZero: spec.axeYdepartZero, raison: spec.raison }, alertes, blocViz };
}

function provenanceCalcul(user: Acteur, outil: string, libelle: string, valeur: number | string, entrees: readonly string[], transformation: string, formule: string) {
  return declarerProvenance([faitCalcule({ outil, acteur: user.id, libelle, valeur, entrees, transformation, formule: formule.slice(0, 300) })]);
}

export const SANDBOX_TOOLS: PowerTool[] = [
  {
    def: {
      name: "sql_query",
      description:
        "REQUÊTE SQL EN LECTURE SEULE sur la base de l'ERP (PostgreSQL) — pour ce qu'aucune lecture canonique ne donne : jointures, "
        + "fenêtres (OVER), CTE (WITH), agrégats par mois, comparaisons entre modules, gros volumes. Un seul SELECT (ou WITH … SELECT), "
        + "sans point-virgule ni commentaire ; tables autorisées seulement (Company, Employee, Supplier, RegulatoryProduct, RegulatoryDossier, "
        + "Product, LegalDocument, FinanceTransaction, ExpenseOrder, PaymentRequest, Task, MedicalDoctor, MedicalInstitution, PchTender, PchOrder, "
        + "Meeting, DriveNode, Mission, DataQualityFinding, BudgetEnvelope, Sale…), noms de colonnes entre guillemets doubles (\"createdAt\"). "
        + "Aucune écriture possible : transaction en lecture seule, plan d'exécution vérifié, 500 lignes et 5 s au plus. Réservé à la vue globale. "
        + "À préférer quand l'analyse demande de croiser ou d'agréger à la source plutôt que de charger des milliers de lignes.",
      input_schema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "La requête SELECT / WITH." },
          titre: { type: "string", description: "Titre du résultat (affiché)." },
          question: { type: "string", description: "La question posée, pour choisir le graphique." },
          limite: { type: "number", description: "Lignes au plus (défaut 500, max 500)." },
        },
        required: ["sql"],
      },
    },
    // La VUE GLOBALE, et elle seule : le SQL libre ignore le cloisonnement par société que chaque
    // lecture applique ligne à ligne. `executerSqlLectureSeule` le revérifie ; ici on ne montre
    // même pas l'outil à qui ne l'a pas.
    allowed: (u) => aVueGlobale(u),
    label: "Requête SQL en lecture seule",
    run: async (input, user) => {
      const sql = str(input, "sql");
      const titre = str(input, "titre") || "Résultat SQL";
      const limite = typeof input.limite === "number" ? input.limite : LIMITE_LIGNES;
      const r = await executerSqlLectureSeule(user, sql, { limite });
      await journaliserSql(user, sql, r);
      if (!r.ok) return JSON.stringify({ ok: false, erreur: r.erreur, ms: r.ms, tablesAutorisees: [...TABLES_AUTORISEES], regle: "un seul SELECT/WITH, sans point-virgule ni commentaire, colonnes entre guillemets doubles" });
      const { graphique, alertes, blocViz } = graphiqueEtAlertes(r.lignes, str(input, "question"), titre);
      const bloc = blocTableau(titre, r.lignes);
      const blocs = [bloc, blocViz].filter((b): b is Record<string, unknown> => Boolean(b));
      return JSON.stringify({
        ok: true, titre, source: "base ERP, lecture seule", isolation: r.isolation, relations: r.relations, ms: r.ms,
        rendu: blocs.length ? `à l'écran sous la réponse : ${[bloc ? "le tableau" : null, blocViz ? `le graphique (${graphique.type})` : null].filter(Boolean).join(" et ")} — ne pas les recopier` : undefined,
        // ── UN TABLEAU PAR REQUÊTE N'EST PAS UN TABLEAU DE BORD ────────────────────────────
        //
        // DÉFAUT MESURÉ (2 échecs sur 4 passes du défi « mini tableau de bord »). La ligne
        // `rendu` ci-dessus est utile pour UNE requête : elle évite de recopier en texte ce que
        // l'écran montre déjà. Sur une demande COMPOSÉE — « les tâches par statut, les réunions
        // par mois, les dossiers par statut » — elle produit l'effet inverse : après sept
        // requêtes, Adam lit « l'écran montre déjà » et conclut en prose. Sept tableaux empilés
        // ne sont pas un tableau de bord, et `render_view` est précisément ce qui en compose un.
        //
        // On le dit dans le RÉSULTAT plutôt que dans le prompt, comme le sommaire de réseau dit
        // qu'il ne cherche aucun chemin : c'est au moment où l'on tient les lignes que le rappel
        // sert, et il ne coûte rien aux tours qui n'en ont pas besoin.
        ...(blocs.length ? { composer: "Ce tableau vaut pour CETTE requête. Si la demande porte sur un tableau de bord, une comparaison ou plusieurs angles à la fois, des tableaux séparés n'y répondent pas : compose la vue avec `render_view`." } : {}),
        colonnes: r.colonnes, lignesTotal: r.lignes.length, tronque: r.tronque,
        lignes: r.lignes.slice(0, LIGNES_MODELE),
        ...(r.lignes.length > LIGNES_MODELE ? { note: `${LIGNES_MODELE} lignes montrées sur ${r.lignes.length} ; le tableau affiché en montre 50 — agréger dans la requête pour tout voir` } : {}),
        profil: decrire(r.lignes).colonnes.map((c) => ({ nom: c.nom, type: c.type, distincts: c.distincts })),
        graphique, alertes,
        ...(blocs.length ? { _blocs: blocs, _blocsDecoratifs: true } : {}),
        _provenance: provenanceCalcul(user, "sql_query", titre, `${r.lignes.length} ligne(s)`, r.relations.map((t) => `table ${t}`), "requête SQL en lecture seule", sql),
      });
    },
  },

  {
    def: {
      name: "run_analysis",
      description:
        "ANALYSE DE DONNÉES par étapes VÉRIFIÉES (le code exécute, jamais le modèle) : filtrer, regrouper (count/sum/avg/min/max/median/p90/distinct), "
        + "croiser (tableau croisé), trier, série temporelle par jour/semaine/mois/trimestre/an (mois vides comblés), moyenne mobile, croissance, cumul, "
        + "tendance (pente, R²), rang, anomalies (z-score robuste), cohortes (rétention), scénario (variations en %, hypothèses dites). "
        + "SOURCE au choix : « source » = " + Object.keys(TABLE_SOURCES).join(" | ") + " (avec ses arguments) ; « outil » = n'importe quelle LECTURE (read_*, list_*, search_*, regulatory_*, finance_*…) avec « args » ; "
        + "« drive » = identifiant ou nom d'un fichier CSV/XLSX du Drive (+ « feuille ») ; « sql » = requête en lecture seule (vue globale) ; « lignes » = lignes déjà obtenues. "
        + "Les colonnes disponibles sont rendues dans la réponse : en cas de doute, appeler d'abord avec etapes: [{op:'decrire'}]. "
        + "Étapes : " + MODE_EMPLOI_PIPELINE + ". Rend les lignes calculées, le journal des étapes, les étapes refusées, le graphique recommandé et ses alertes.",
      input_schema: {
        type: "object",
        properties: {
          source: { type: "object", description: "{ source | outil+args | drive(+feuille) | sql | lignes }" },
          etapes: { type: "array", items: { type: "object" }, description: `Opérations dans l'ordre : ${OPS_PIPELINE.join(", ")}.` },
          titre: { type: "string" },
          question: { type: "string", description: "La question posée, pour choisir le graphique." },
        },
        required: ["source", "etapes"],
      },
    },
    // Aucun droit propre : la SOURCE porte le sien (lecture revérifiée par `executePowerTool`,
    // fichier sous `canViewDrive`, SQL sous la vue globale). Les opérations sont pures.
    allowed: () => true,
    label: "Analyse de données",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Analyse";
      const etapes = Array.isArray(input.etapes) ? input.etapes : [];
      const charge = await chargerLignes(input, user);
      if ("erreur" in charge) return JSON.stringify({ ok: false, erreur: charge.erreur });
      const r = appliquerEtapes(charge.lignes, etapes);
      const { graphique, alertes, blocViz } = graphiqueEtAlertes(r.lignes, str(input, "question"), titre);
      const bloc = blocTableau(titre, r.lignes);
      const blocs = [bloc, blocViz].filter((b): b is Record<string, unknown> => Boolean(b));
      return JSON.stringify({
        ok: r.erreurs.length === 0 || r.journal.length > 0,
        titre, source: charge.origine, ...(charge.note ? { avertissement: charge.note } : {}),
        rendu: blocs.length ? `à l'écran sous la réponse : ${[bloc ? "le tableau" : null, blocViz ? `le graphique (${graphique.type})` : null].filter(Boolean).join(" et ")} — ne pas les recopier` : undefined,
        lignesEntree: charge.lignes.length, colonnesEntree: Object.keys(charge.lignes[0] ?? {}).slice(0, 40),
        etapes: r.journal, etapesRefusees: r.erreurs, ignores: r.ignores,
        resultats: r.resultats,
        lignesTotal: r.lignes.length, lignes: r.lignes.slice(0, LIGNES_MODELE),
        ...(r.lignes.length > LIGNES_MODELE ? { note: `${LIGNES_MODELE} lignes montrées sur ${r.lignes.length} ; le tableau affiché en montre 50` } : {}),
        graphique, alertes,
        ...(blocs.length ? { _blocs: blocs, _blocsDecoratifs: true } : {}),
        _provenance: provenanceCalcul(user, "run_analysis", titre, `${r.lignes.length} ligne(s)`, charge.provenance, r.journal.map((j) => j.op).join(" → ") || "aucune étape", JSON.stringify(etapes)),
      });
    },
  },

  {
    def: {
      name: "run_code",
      description:
        "EXÉCUTE DU CODE ISOLÉ sur des données — quand les étapes de run_analysis ne suffisent pas (calcul sur mesure, simulation, transformation). "
        + "JavaScript : fil isolé, contexte vide (data, lib{sum,mean,median,min,max,round,groupBy,sortBy,uniq,countBy,pick,toNumber,month,daysBetween}, console.log), 5 s, 128 Mo, "
        + "le code doit `return` un résultat JSON. Python : processus isolé aux limites noyau (pas de fichiers, pas de réseau, pas de sous-processus), 8 s ; "
        + "le code lit `data` et pose `result` ; disponible seulement si le serveur a python3 (dit dans la réponse). "
        + "PORTE DE QUALITÉ : déclare des `attentes` (assertions closes sur le résultat) et un `schema` (forme promise) — le serveur inspecte, exécute, teste, valide, et n'EXPOSE le résultat que si tout tient ; sinon il dit l'étape qui a refusé et la correction à faire, et tu corriges le code (pas l'attente). "
        + "Données : même « source » que run_analysis (lecture, drive, sql, lignes) ou « donnees » libres. Rien n'est écrit nulle part.",
      input_schema: {
        type: "object",
        properties: {
          langage: { type: "string", enum: ["js", "python"], description: "js (défaut) ou python." },
          code: { type: "string" },
          source: { type: "object", description: "{ source | outil+args | drive(+feuille) | sql | lignes } — devient `data`." },
          donnees: { description: "Données libres si aucune source — devient `data`." },
          titre: { type: "string" },
          attentes: { type: "array", description: "LA PORTE DE QUALITÉ : des assertions closes sur le résultat, lues par le serveur — [{ chemin: 'total', op: 'egal'|'different'|'superieur'|'inferieur'|'entre'|'contient'|'longueur'|'nonVide'|'type', valeur?, bornes?: [min,max], libelle? }]. Une attente non tenue = résultat NON exposé, avec la correction à faire.", items: { type: "object" } },
          schema: { type: "object", description: "La FORME promise du résultat : { forme: 'objet'|'liste'|'nombre'|'texte'|'quelconque', cles?: [...], max? }. Une forme fausse = résultat non exposé." },
        },
        required: ["code"],
      },
    },
    // Aucun droit propre : le code ne touche à rien d'autre que `data`, et `data` vient d'une
    // source qui porte SON droit. Les limites (délai, mémoire, isolation) sont dans le bac.
    allowed: () => true,
    label: "Code exécuté dans le bac à sable",
    run: async (input, user) => {
      const langage = str(input, "langage").toLowerCase() === "python" ? "python" : "js";
      const code = str(input, "code");
      const titre = str(input, "titre") || "Résultat du code";
      let data: unknown = input.donnees ?? null;
      let origine = data === null ? "aucune donnée" : "données fournies dans la conversation";
      let provenance: string[] = data === null ? [] : ["données fournies par la conversation"];
      if (isObj(input.source) || Array.isArray(input.lignes)) {
        const charge = await chargerLignes(input, user);
        if ("erreur" in charge) return JSON.stringify({ ok: false, erreur: charge.erreur });
        data = charge.lignes; origine = charge.origine; provenance = charge.provenance;
      }
      if (langage === "python") {
        const dispo = sonderPython();
        if (!dispo.disponible) return JSON.stringify({ ok: false, langage, erreur: `Python indisponible sur ce serveur : ${dispo.raison}. Réécrire en JavaScript (langage: "js").` });
      }
      // LA PORTE DE QUALITÉ (§34) : inspecter → exécuter → tester → valider → exposer. Un résultat
      // qui ne passe pas n'est pas rendu ; l'étape qui a refusé et la correction le sont.
      const attentes = (Array.isArray(input.attentes) ? input.attentes.filter(isObj) : []) as unknown as Attente[];
      const schema = (isObj(input.schema) ? input.schema : null) as SchemaSortie | null;
      const porte = await passerLaPorte({
        code, langage, data, attentes, schema,
        executer: async (c, d) => { const x = langage === "python" ? await executerPython(c, d) : await executerJs(c, d); return { ok: x.ok, resultat: x.resultat, erreur: x.erreur, ms: x.ms, journal: x.journal }; },
      });
      const r = { ok: porte.expose, resultat: porte.expose ? porte.resultat : undefined, ms: porte.etapes.find((e) => e.etape === "execution")?.ms ?? 0, erreur: porte.expose ? undefined : porte.correction ?? porte.etapes[porte.etapes.length - 1]?.detail, journal: [] as string[], notes: [] as string[] };
      const lignes = Array.isArray(r.resultat) ? (r.resultat as unknown[]).filter(isObj) : [];
      const bloc = lignes.length >= 2 ? blocTableau(titre, lignes) : null;
      const brut = JSON.stringify(r.resultat ?? null);
      return JSON.stringify({
        ok: r.ok, langage, titre, source: origine, ms: r.ms,
        isolation: langage === "python" ? "processus isolé, limites noyau" : "fil isolé, contexte vide, mémoire et délai bornés",
        porte: { expose: porte.expose, refusePar: porte.refusePar, correction: porte.correction, tests: `${porte.testsPasses}/${porte.testsTotal}`, etapes: porte.etapes.map((e) => `${e.etape} : ${e.ok ? "ok" : "REFUS"} — ${e.detail}`) },
        ...(langage === "python" ? { python: { version: sonderPython().version, modules: sonderPython().modules } } : {}),
        ...(r.erreur ? { erreur: r.erreur } : {}),
        journal: r.journal, notes: r.notes,
        resultat: brut.length > 30_000 ? `${brut.slice(0, 30_000)}… (tronqué : ${brut.length} caractères)` : r.resultat,
        ...(bloc ? { _blocs: [bloc], _blocsDecoratifs: true } : {}),
        ...(r.ok ? { _provenance: provenanceCalcul(user, "run_code", titre, lignes.length ? `${lignes.length} ligne(s)` : brut.slice(0, 80), provenance, `code ${langage} exécuté dans le bac à sable`, code) } : {}),
      });
    },
  },

  {
    def: {
      name: "chart_advice",
      description:
        "LE BON GRAPHIQUE pour la question, et ce qui TROMPERAIT : à partir de lignes (ou d'une spec proposée), recommande courbe / barres / barres empilées / "
        + "secteurs (≤ 6 parts) / nuage / histogramme / cascade / tableau, avec la raison ; et signale les pièges : axe qui ne part pas de zéro sur des barres, "
        + "camembert à trop de parts ou dont les parts ne font pas un tout, double axe, 3D, échelle log non dite, cumul présenté comme une période, trop de séries, "
        + "courbe sans axe de temps. À appeler avant de décrire ou de produire un graphique, ou pour juger un graphique reçu.",
      input_schema: {
        type: "object",
        properties: {
          lignes: { type: "array", items: { type: "object" }, description: "Les lignes à représenter (résultat d'une analyse)." },
          question: { type: "string" },
          titre: { type: "string" },
          spec: { type: "object", description: "Une spec à JUGER : {type, x, y[], serie?, axeYdepartZero, echelle?, cumul?, doubleAxe?, troisD?, titre}." },
        },
      },
    },
    // Pur : ne lit aucune donnée de l'ERP — il juge ce qu'on lui donne.
    allowed: () => true,
    label: "Conseil de visualisation",
    run: async (input) => {
      const lignes = Array.isArray(input.lignes) ? (input.lignes as unknown[]).filter(isObj).slice(0, 5_000) : [];
      const titre = str(input, "titre") || "Graphique";
      const reco = recommanderGraphique(lignes, str(input, "question"), titre);
      const alertesReco = verifierGraphique(reco, lignes);
      let jugement: Record<string, unknown> | null = null;
      if (isObj(input.spec)) {
        const sp = input.spec;
        const spec: SpecGraphique = {
          type: (["courbe", "barres", "barres_empilees", "secteurs", "nuage", "histogramme", "tableau", "cascade"].includes(String(sp.type)) ? sp.type : "tableau") as SpecGraphique["type"],
          titre: typeof sp.titre === "string" ? sp.titre : titre, x: typeof sp.x === "string" ? sp.x : null,
          y: Array.isArray(sp.y) ? sp.y.filter((v): v is string => typeof v === "string") : typeof sp.y === "string" ? [sp.y] : [],
          serie: typeof sp.serie === "string" ? sp.serie : null, axeYdepartZero: sp.axeYdepartZero !== false,
          echelle: sp.echelle === "log" ? "log" : "lineaire", cumul: sp.cumul === true, doubleAxe: sp.doubleAxe === true, troisD: sp.troisD === true, raison: "spec fournie",
        };
        const alertes = verifierGraphique(spec, lignes);
        jugement = { spec: { type: spec.type, x: spec.x, y: spec.y }, trompeur: alertes.some((a) => a.gravite === "TROMPEUR"), alertes: alertes.map((a) => `${a.gravite} · ${a.code} · ${a.message}`) };
      }
      return JSON.stringify({
        recommandation: { type: reco.type, x: reco.x, y: reco.y, serie: reco.serie ?? null, axeYdepartZero: reco.axeYdepartZero, raison: reco.raison },
        alertes: alertesReco.map((a) => `${a.gravite} · ${a.code} · ${a.message}`),
        ...(jugement ? { jugementDeLaSpec: jugement } : {}),
        profil: decrire(lignes).colonnes.map((c) => ({ nom: c.nom, type: c.type, distincts: c.distincts })),
      });
    },
  },
];
