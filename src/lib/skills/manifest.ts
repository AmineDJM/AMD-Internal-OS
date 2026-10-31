import { EFFECTS, EFFECT_RANK, PRIMITIVES, type Effect, type LatencyClass, type Primitive } from "@/lib/missions/registry/capability-meta";
import type { Attente, SchemaSortie } from "@/platform/ia/analyse/porte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MANIFESTE D'UN SKILL (mandat 5 §36) — pur : des types, une validation, des dérivations.
 *
 * Un skill DÉCLARE ce qu'il sait faire, et la déclaration est la seule chose que le cœur lit :
 * entrées (schéma), sorties, permissions (un module, une action, la vue globale), risques
 * (niveau, irréversible, externe), coût (latence, estimation), dépendances (les clés de
 * configuration qui le rendent DISPONIBLE), événements, validations (les attentes closes de la
 * porte de qualité), limites (débit) et l'EXÉCUTEUR — HTTP déclaratif, code dans le bac, ou
 * playbook (une suite d'outils existants).
 *
 * Trois provenances, un seul format :
 *   • `plugin`  — un connecteur déclaré dans `plugins/` (DocuSign, SAP, HubSpot, IQVIA, PCH…) :
 *                 ajouter un connecteur = ajouter un manifeste, le cœur ne bouge pas ;
 *   • `adam`    — un micro-outil créé par Adam (code → porte de qualité → outil temporaire →
 *                 promu par une PERSONNE, ou jeté) ;
 *   • `teach`   — un playbook enseigné (Teach Adam, règle WORKFLOW à part structurée).
 *
 * Ce module ne connaît ni la base, ni la session, ni le réseau : le pont
 * (`platform/in-process/skills/`) charge, autorise, exécute et journalise.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NIVEAUX_RISQUE = ["FAIBLE", "MOYEN", "ELEVE"] as const;
export type NiveauRisque = (typeof NIVEAUX_RISQUE)[number];

export const SOURCES_SKILL = ["plugin", "adam", "teach"] as const;
export type SourceSkill = (typeof SOURCES_SKILL)[number];

export const METHODES_HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type MethodeHttp = (typeof METHODES_HTTP)[number];

export interface ExecuteurHttp {
  type: "http";
  /** Le NOM de la variable de configuration qui porte l'URL de base — jamais l'URL elle-même. */
  base: string;
  methode: MethodeHttp;
  /** Un chemin avec gabarits : `/envelopes/{{entree.envelopeId}}`, `{{config.COMPTE}}` — ou vide quand l'URL de base EST la cible (webhook). */
  chemin: string;
  entetes?: Record<string, string>;
  /** Le corps (POST/PUT/PATCH), avec gabarits — un objet, jamais une chaîne à concaténer. */
  corps?: unknown;
  /** La forme du corps : JSON (défaut) ou formulaire `application/x-www-form-urlencoded` (passerelles SMS). */
  corpsForme?: "json" | "formulaire";
  auth?: { type: "bearer"; config: string } | { type: "entete"; nom: string; config: string } | { type: "basic"; utilisateur: string; motDePasse: string };
  /** Où lire le résultat utile dans la réponse (`data.items`), vide = tout. */
  reponse?: { chemin?: string };
}

export interface ExecuteurCode {
  type: "code";
  langage: "js" | "python";
  code: string;
  /** Un exemple d'entrée : c'est sur lui que la porte de qualité juge le code AVANT de l'exposer. */
  exemple?: unknown;
}

export interface EtapePlaybook {
  /** Le nom sous lequel la sortie de l'étape est relue par les suivantes (`{{etapes.alias.champ}}`). */
  alias: string;
  /** Un OUTIL EXISTANT — une lecture. Un playbook compose, il n'invente pas d'effet. */
  outil: string;
  args: Record<string, unknown>;
}

export interface ExecuteurPlaybook {
  type: "playbook";
  etapes: EtapePlaybook[];
  /** La forme du résultat, avec gabarits sur les étapes ; vide = la sortie de la dernière étape. */
  sortie?: Record<string, unknown>;
}

export type Executeur = ExecuteurHttp | ExecuteurCode | ExecuteurPlaybook;

export interface SkillManifest {
  /** Un slug : `envoyer_pour_signature`. Le nom d'outil en dérive (`nomOutil`). */
  id: string;
  /** `docusign`, `sap`… pour un connecteur ; `adam` pour un micro-outil ; `teach` pour un playbook. */
  plugin: string;
  version: string;
  titre: string;
  /** Pour le modèle : quand l'appeler, ce qu'il rend. Six cents caractères au plus. */
  description: string;
  primitive: Primitive;
  effect: Effect;
  /** Le domaine de la liste courte : FINANCE, LEGAL, DATA, GENERAL… */
  domaine: string;
  entrees: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  sorties: { description: string; cles?: string[] };
  permissions: { module?: string; action?: "view" | "edit"; vueGlobale?: boolean; roles?: string[] };
  risques: { niveau: NiveauRisque; irreversible: boolean; externe: boolean; note?: string };
  cout: { latence: LatencyClass; estimeUsd?: number; note?: string };
  dependances: { config: string[]; services?: string[] };
  evenements?: { emet?: string[]; ecoute?: string[] };
  validations?: { attentes?: Attente[]; schema?: SchemaSortie };
  limites?: { parMinute?: number; parJour?: number; note?: string };
  executeur: Executeur;
}

export const SLUG_RE = /^[a-z][a-z0-9_]{2,47}$/;
const PLUGIN_RE = /^[a-z][a-z0-9]{1,23}$/;
const LATENCES: readonly LatencyClass[] = ["LOW", "MEDIUM", "HIGH"];

/**
 * LES NOMS QU'UN SKILL NE PEUT PAS PRENDRE. Un manifeste qui ressemblerait à une capacité de
 * contrôle, d'enseignement ou de sécurité serait une porte dérobée vers ce que `policy/guard.ts`
 * interdit à l'agent — le refus est ici, à la déclaration, pas dans une consigne.
 */
export const IDENTIFIANTS_INTERDITS = /(mission_?control|approv|approb|accord|teach|regle|rule|rbac|permission|role|password|mot_de_passe|token|secret|credential|admin|superadmin)/i;

/** Les outils qu'un playbook ne compose jamais : enseigner, promouvoir, contrôler — des gestes de personne. */
export const OUTILS_INTERDITS_PLAYBOOK = /^(teach_adam|update_rule|disable_rule|delete_rule|create_skill|promote_skill|drop_skill|list_more_tools|mission_control|approve_mission)$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** Le nom d'outil d'un manifeste — la seule dérivation que le cœur connaît. */
export function nomOutil(m: Pick<SkillManifest, "id" | "plugin">): string {
  if (m.plugin === "adam") return `skill_${m.id}`;
  if (m.plugin === "teach") return `playbook_${m.id}`;
  return `${m.plugin}_${m.id}`;
}

/** Un effet qui écrit, communique ou engage exige un accord explicite avant d'exécuter. */
export const exigeConfirmation = (m: Pick<SkillManifest, "effect">): boolean => EFFECT_RANK[m.effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE;

function validerExecuteur(e: unknown, issues: string[]): Executeur | null {
  if (!isObj(e)) { issues.push("executeur : objet attendu"); return null; }
  if (e.type === "http") {
    const base = str(e.base); const methode = str(e.methode)?.toUpperCase(); const chemin = typeof e.chemin === "string" ? e.chemin.trim() : null;
    if (!base || !/^[A-Z][A-Z0-9_]{2,63}$/.test(base)) issues.push("executeur.base : le NOM d'une variable de configuration (MAJUSCULES) est attendu, jamais une URL");
    if (!methode || !(METHODES_HTTP as readonly string[]).includes(methode)) issues.push(`executeur.methode : ${METHODES_HTTP.join(" | ")}`);
    if (chemin === null || (chemin !== "" && !chemin.startsWith("/"))) issues.push("executeur.chemin : un chemin commençant par « / » (ou vide quand la base est la cible)");
    if (/^https?:/i.test(chemin ?? "")) issues.push("executeur.chemin : pas d'URL absolue — la base vient de la configuration");
    const corpsForme = e.corpsForme === undefined ? undefined : e.corpsForme === "json" || e.corpsForme === "formulaire" ? e.corpsForme : null;
    if (corpsForme === null) issues.push("executeur.corpsForme : json | formulaire");
    const entetes = isObj(e.entetes) && Object.values(e.entetes).every((x) => typeof x === "string") ? (e.entetes as Record<string, string>) : undefined;
    let auth: ExecuteurHttp["auth"];
    if (e.auth !== undefined) {
      if (isObj(e.auth) && e.auth.type === "bearer" && str(e.auth.config)) auth = { type: "bearer", config: String(e.auth.config) };
      else if (isObj(e.auth) && e.auth.type === "entete" && str(e.auth.nom) && str(e.auth.config)) auth = { type: "entete", nom: String(e.auth.nom), config: String(e.auth.config) };
      else if (isObj(e.auth) && e.auth.type === "basic" && str(e.auth.utilisateur) && str(e.auth.motDePasse)) auth = { type: "basic", utilisateur: String(e.auth.utilisateur), motDePasse: String(e.auth.motDePasse) };
      else issues.push("executeur.auth : { type: bearer, config }, { type: entete, nom, config } ou { type: basic, utilisateur, motDePasse } (des NOMS de configuration)");
    }
    if (issues.length) return null;
    return { type: "http", base: base!, methode: methode as MethodeHttp, chemin: chemin!, ...(entetes ? { entetes } : {}), ...(e.corps !== undefined ? { corps: e.corps } : {}), ...(corpsForme ? { corpsForme } : {}), ...(auth ? { auth } : {}), ...(isObj(e.reponse) ? { reponse: { chemin: str(e.reponse.chemin) ?? undefined } } : {}) };
  }
  if (e.type === "code") {
    const langage = e.langage === "python" ? "python" : e.langage === "js" ? "js" : null;
    const code = str(e.code);
    if (!langage) issues.push("executeur.langage : js | python");
    if (!code) issues.push("executeur.code : vide");
    if (code && code.length > 40_000) issues.push("executeur.code : trop long (40 000 caractères au plus)");
    if (issues.length) return null;
    return { type: "code", langage: langage!, code: code!, ...(e.exemple !== undefined ? { exemple: e.exemple } : {}) };
  }
  if (e.type === "playbook") {
    const etapes: EtapePlaybook[] = [];
    if (!Array.isArray(e.etapes) || e.etapes.length === 0) issues.push("executeur.etapes : au moins une étape");
    else if (e.etapes.length > 12) issues.push("executeur.etapes : douze étapes au plus — au-delà, c'est une mission");
    else {
      const alias = new Set<string>();
      e.etapes.forEach((x, i) => {
        if (!isObj(x)) { issues.push(`etape ${i + 1} : objet attendu`); return; }
        const a = str(x.alias) ?? `etape${i + 1}`; const outil = str(x.outil);
        if (!SLUG_RE.test(a)) issues.push(`etape ${i + 1} : alias invalide « ${a} »`);
        if (alias.has(a)) issues.push(`etape ${i + 1} : alias « ${a} » en double`);
        alias.add(a);
        if (!outil || !/^[a-z][a-z0-9_]{2,63}$/.test(outil)) issues.push(`etape ${i + 1} : outil manquant ou invalide`);
        if (outil && OUTILS_INTERDITS_PLAYBOOK.test(outil)) issues.push(`etape ${i + 1} : « ${outil} » n'est pas un outil qu'un playbook peut appeler`);
        etapes.push({ alias: a, outil: outil ?? "", args: isObj(x.args) ? x.args : {} });
      });
    }
    if (issues.length) return null;
    return { type: "playbook", etapes, ...(isObj(e.sortie) ? { sortie: e.sortie } : {}) };
  }
  issues.push("executeur.type : http | code | playbook");
  return null;
}

/** VALIDER un manifeste — tout ce qui est faux est dit, rien n'est deviné. */
export function validerManifest(v: unknown): { ok: true; manifest: SkillManifest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(v)) return { ok: false, issues: ["manifeste : objet attendu"] };
  const id = str(v.id); const plugin = str(v.plugin)?.toLowerCase(); const version = str(v.version) ?? "1.0.0";
  const titre = str(v.titre); const description = str(v.description);
  if (!id || !SLUG_RE.test(id)) issues.push("id : un slug en minuscules (lettres, chiffres, _), 3 à 48 caractères");
  if (!plugin || !PLUGIN_RE.test(plugin)) issues.push("plugin : un nom court en minuscules");
  if (id && IDENTIFIANTS_INTERDITS.test(id)) issues.push(`id : « ${id} » ressemble à une capacité de contrôle, d'enseignement ou de sécurité — interdit`);
  if (!titre || titre.length > 80) issues.push("titre : 1 à 80 caractères");
  if (!description || description.length > 600) issues.push("description : 1 à 600 caractères");
  const primitive = str(v.primitive)?.toUpperCase();
  if (!primitive || !(PRIMITIVES as readonly string[]).includes(primitive)) issues.push(`primitive : ${PRIMITIVES.join(" | ")}`);
  const effect = str(v.effect)?.toUpperCase();
  if (!effect || !(EFFECTS as readonly string[]).includes(effect)) issues.push(`effect : ${EFFECTS.join(" | ")}`);
  if (effect === "SECURITY_ADMIN") issues.push("effect : SECURITY_ADMIN n'est pas déclarable par un skill");
  const domaine = str(v.domaine)?.toUpperCase() ?? "GENERAL";
  const entrees = isObj(v.entrees) && v.entrees.type === "object" && isObj(v.entrees.properties)
    ? { type: "object" as const, properties: v.entrees.properties as Record<string, unknown>, ...(strs(v.entrees.required) ? { required: strs(v.entrees.required)! } : {}) }
    : null;
  if (!entrees) issues.push("entrees : { type: 'object', properties: {…}, required?: [] }");
  const sorties = isObj(v.sorties) && str(v.sorties.description) ? { description: str(v.sorties.description)!, ...(strs(v.sorties.cles) ? { cles: strs(v.sorties.cles)! } : {}) } : null;
  if (!sorties) issues.push("sorties : { description, cles? }");
  const p = isObj(v.permissions) ? v.permissions : {};
  const permissions: SkillManifest["permissions"] = {
    ...(str(p.module) ? { module: str(p.module)! } : {}),
    ...(p.action === "edit" || p.action === "view" ? { action: p.action } : {}),
    ...(p.vueGlobale === true ? { vueGlobale: true } : {}),
    ...(strs(p.roles) ? { roles: strs(p.roles)! } : {}),
  };
  const r = isObj(v.risques) ? v.risques : null;
  const niveau = str(r?.niveau)?.toUpperCase();
  if (!r || !niveau || !(NIVEAUX_RISQUE as readonly string[]).includes(niveau) || typeof r.irreversible !== "boolean" || typeof r.externe !== "boolean") issues.push("risques : { niveau: FAIBLE|MOYEN|ELEVE, irreversible: bool, externe: bool }");
  const c = isObj(v.cout) ? v.cout : null;
  const latence = str(c?.latence)?.toUpperCase();
  if (!c || !latence || !LATENCES.includes(latence as LatencyClass)) issues.push("cout : { latence: LOW|MEDIUM|HIGH, estimeUsd?, note? }");
  const d = isObj(v.dependances) ? v.dependances : null;
  const config = strs(d?.config);
  if (!d || !config) issues.push("dependances : { config: string[] (variables de configuration), services? }");
  if (config?.some((k) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(k))) issues.push("dependances.config : des NOMS de variables (MAJUSCULES), jamais des valeurs");
  const validations = isObj(v.validations) ? { ...(Array.isArray(v.validations.attentes) ? { attentes: v.validations.attentes as Attente[] } : {}), ...(isObj(v.validations.schema) ? { schema: v.validations.schema as unknown as SchemaSortie } : {}) } : undefined;
  const l = isObj(v.limites) ? v.limites : null;
  const limites = l ? { ...(typeof l.parMinute === "number" && l.parMinute > 0 ? { parMinute: Math.floor(l.parMinute) } : {}), ...(typeof l.parJour === "number" && l.parJour > 0 ? { parJour: Math.floor(l.parJour) } : {}), ...(str(l.note) ? { note: str(l.note)! } : {}) } : undefined;
  const ev = isObj(v.evenements) ? { ...(strs(v.evenements.emet) ? { emet: strs(v.evenements.emet)! } : {}), ...(strs(v.evenements.ecoute) ? { ecoute: strs(v.evenements.ecoute)! } : {}) } : undefined;
  const executeur = validerExecuteur(v.executeur, issues);
  // Un code sans exemple ni attente n'a rien qui le juge : la porte de qualité n'aurait rien à tester.
  if (executeur?.type === "code" && executeur.exemple === undefined && !validations?.attentes?.length && !validations?.schema) issues.push("executeur.code : donner un `exemple` d'entrée ou des `validations` (attentes, schema) — sans eux, rien ne juge le code avant de l'exposer");
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    manifest: {
      id: id!, plugin: plugin!, version, titre: titre!, description: description!,
      primitive: primitive as Primitive, effect: effect as Effect, domaine,
      entrees: entrees!, sorties: sorties!, permissions,
      risques: { niveau: niveau as NiveauRisque, irreversible: Boolean(r!.irreversible), externe: Boolean(r!.externe), ...(str(r!.note) ? { note: str(r!.note)! } : {}) },
      cout: { latence: latence as LatencyClass, ...(typeof c!.estimeUsd === "number" ? { estimeUsd: c!.estimeUsd } : {}), ...(str(c!.note) ? { note: str(c!.note)! } : {}) },
      dependances: { config: config!, ...(strs(d!.services) ? { services: strs(d!.services)! } : {}) },
      ...(ev && (ev.emet || ev.ecoute) ? { evenements: ev } : {}),
      ...(validations && (validations.attentes || validations.schema) ? { validations } : {}),
      ...(limites && Object.keys(limites).length ? { limites } : {}),
      executeur: executeur!,
    },
  };
}

/** DISPONIBLE ? Un skill dont la configuration manque reste DÉCLARÉ (on sait qu'il existe) mais dit sa limite : une ressource, pas « pas prévu ». */
export function disponibilite(m: SkillManifest, config: Record<string, string | undefined>): { ok: boolean; manquantes: string[] } {
  const manquantes = m.dependances.config.filter((k) => !config[k] || String(config[k]).trim() === "");
  return { ok: manquantes.length === 0, manquantes };
}

/** LE SCHÉMA D'OUTIL montré au modèle : les entrées déclarées, plus `confirmer` quand l'effet l'exige. */
export function schemaOutil(m: SkillManifest): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  if (!exigeConfirmation(m)) return m.entrees;
  return {
    type: "object",
    properties: { ...m.entrees.properties, confirmer: { type: "boolean", description: "Vrai SEULEMENT après l'accord explicite de la personne sur l'aperçu rendu par le premier appel." } },
    ...(m.entrees.required ? { required: m.entrees.required } : {}),
  };
}

/** LA FICHE pour le modèle : description, effet, risques, coût, limites, confirmation — en une ligne de plus. */
export function fiche(m: SkillManifest, dispo: { ok: boolean; manquantes: string[] }): string {
  const parts = [
    m.description,
    `Effet : ${m.effect}${exigeConfirmation(m) ? " — un premier appel rend un APERÇU, l'exécution exige confirmer: true après l'accord de la personne" : ""}.`,
    `Risque ${m.risques.niveau.toLowerCase()}${m.risques.irreversible ? ", irréversible" : ""}${m.risques.externe ? ", système externe" : ""}.`,
    `Latence ${m.cout.latence.toLowerCase()}${typeof m.cout.estimeUsd === "number" ? `, ≈ ${m.cout.estimeUsd} USD par appel` : ""}.`,
    m.limites?.parMinute ? `Au plus ${m.limites.parMinute} appel(s) par minute.` : null,
    m.sorties.cles?.length ? `Rend : ${m.sorties.cles.join(", ")}.` : `Rend : ${m.sorties.description}.`,
    dispo.ok ? null : `NON CONFIGURÉ sur ce serveur (${dispo.manquantes.join(", ")}) : l'appel dira la ressource qui manque.`,
  ].filter(Boolean);
  return parts.join(" ").slice(0, 900);
}
