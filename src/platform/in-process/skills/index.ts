import type { Prisma } from "@prisma/client";
import { ecartDeContrat } from "@/lib/skills/contrat-sortie";
import { lignesDeclarees } from "@/lib/skills/affichage";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { recordPermissionRefusal } from "@/lib/models/telemetry";
import { MODULES, hasGlobalView, userCan, type Module } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { declarerDomaineDynamique } from "@/lib/assistant/context/tool-shortlist";
import type { Domain } from "@/lib/assistant/context/router";
import { EFFECT_RANK, declarerMetaDynamique } from "@/lib/missions/registry/capability-meta";
import { PLUGINS, CANAUX_MESSAGERIE, outilDeCanal, type CanalMessagerie } from "@/lib/skills/plugins";
import {
  IDENTIFIANTS_INTERDITS, OUTILS_INTERDITS_PLAYBOOK, SLUG_RE, disponibilite, exigeConfirmation, fiche, nomOutil, schemaOutil, validerManifest,
  type ExecuteurCode, type ExecuteurHttp, type ExecuteurPlaybook, type SkillManifest, type SourceSkill,
} from "@/lib/skills/manifest";
import { lireChemin, remplir, trous } from "@/lib/skills/gabarit";
import type { Attente, SchemaSortie } from "@/platform/ia/analyse/porte";
import { executerJs, executerPython, passerLaPorte, sonderPython } from "@/platform/in-process/sandbox";
import { reglesEnVigueurPour, sujetDe, type RegleVue } from "@/platform/ia/teach/store";
import { declarerProvenance, faitCalcule } from "@/platform/in-process/fabric/provenance";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RUNTIME DES SKILLS (mandat 5 §36), côté plateforme — la seule pièce qui connaît à la fois
 * les manifestes, la base, les droits et le bac à sable.
 *
 * ── CE QU'IL FAIT ────────────────────────────────────────────────────────────────────────
 *
 *   • CHARGE, pour UNE personne, les skills qu'elle peut voir : les connecteurs déclarés
 *     (`lib/skills/plugins/`), ses micro-outils (`AdamSkill`, temporaires ou promus dans son
 *     périmètre), les playbooks enseignés (règles WORKFLOW à part `playbook`) ; chacun validé,
 *     autorisé (module, action, vue globale, rôles), et marqué disponible ou non (configuration).
 *   • DÉCLARE au registre ce que le cœur doit savoir sans le connaître : la méta de mission
 *     (effet, latence, primitive, confirmation) et le domaine de la liste courte. C'est ce qui
 *     rend un connecteur DÉCOUVRABLE par le planificateur et la conversation sans une ligne de
 *     plus dans le cœur.
 *   • EXÉCUTE : HTTP déclaratif (gabarits, authentification par configuration, délai, taille),
 *     code dans le bac (porte de qualité), playbook (des LECTURES existantes, composées).
 *   • TIENT les règles qui ne se négocient pas : un effet qui écrit ou engage rend un APERÇU et
 *     n'exécute qu'avec `confirmer: true` (conversation) ou après l'accord de mission (le runner
 *     le pose lui-même, jamais le modèle) ; un connecteur non configuré dit sa RESSOURCE ; un
 *     débit déclaré est compté ; un secret n'apparaît ni dans un aperçu, ni dans un journal.
 *   • GARDE le cycle des micro-outils : créer (porte de qualité sur l'exemple, sinon rien),
 *     utiliser (compté), PROMOUVOIR (une personne, un périmètre — jamais l'agent : `policy/guard.ts`
 *     le refuse à la compilation), jeter.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SkillCharge {
  manifest: SkillManifest;
  source: SourceSkill;
  nom: string;
  dispo: { ok: boolean; manquantes: string[] };
  skillId?: string;
  regleId?: string;
  ownerId?: string;
  statut?: string;
  expiresAt?: Date | null;
  usageCount?: number;
}
interface CachePersonne { at: number; empreinte: string; skills: Map<string, SkillCharge>; outils: PowerTool[] }

const CACHE = new Map<string, CachePersonne>();
const NOMS_PLUGINS = new Set(PLUGINS.map((p) => nomOutil(p)));
const TTL_MS = 30_000;
const LABELS = new Map<string, string>();
const DEBIT = new Map<string, number[]>();
const PROFONDEUR = new Map<string, number>();
const TEMP_MS = 24 * 3600 * 1000;
const DELAI_HTTP_MS = 15_000;
const TAILLE_MAX = 200_000;

let CONFIG: Record<string, string | undefined> | null = null;
let FETCH: typeof fetch | null = null;

/** Pour les bancs : une configuration et un `fetch` injectés, et le cache vidé. Jamais appelé en production. */
export function __configurerPourTests(o: { config?: Record<string, string | undefined> | null; fetchImpl?: typeof fetch | null }): void {
  if (o.config !== undefined) CONFIG = o.config;
  if (o.fetchImpl !== undefined) FETCH = o.fetchImpl;
  CACHE.clear(); DEBIT.clear();
}
const config = (): Record<string, string | undefined> => CONFIG ?? process.env;

const DOMAINES_LISTE = new Set<string>(["MAIL", "CALENDAR", "REGULATORY", "FINANCE", "HR", "DRIVE", "LEGAL", "MISSION", "DIRECTORY", "ADMIN", "TEACH", "SOURCES", "QUALITE", "DATA", "GENERAL"]);
const domaineListe = (d: string | null | undefined): Domain => (d && DOMAINES_LISTE.has(d.toUpperCase()) ? (d.toUpperCase() as Domain) : "GENERAL");

const MODULE_ALIAS: Record<string, string> = { FINANCE: "FINANCES", HR: "RH", DOCUMENT: "DOCUMENTS", CONTRATS: "LEGAL", CONTRACTS: "LEGAL", JURIDIQUE: "LEGAL" };
function moduleDe(nom: string | undefined): Module | null {
  if (!nom) return null;
  const n = nom.toUpperCase();
  const m = MODULE_ALIAS[n] ?? n;
  return (MODULES as readonly string[]).includes(m) ? (m as Module) : null;
}

/** LE DROIT, tel que le manifeste le déclare — revérifié à CHAQUE exécution, jamais seulement à l'affichage. */
export function autorise(m: SkillManifest, user: CurrentUser): boolean {
  const p = m.permissions;
  const roles = [user.role, (user as { secondaryRole?: string | null }).secondaryRole].filter((r): r is string => Boolean(r));
  if (p.roles?.length && !p.roles.some((r) => roles.includes(r))) return false;
  if (p.vueGlobale && !hasGlobalView(user)) return false;
  if (p.module) {
    const mod = moduleDe(p.module);
    if (!mod) return false; // un module inconnu n'ouvre rien : le défaut penche du côté fermé
    if (!userCan(user, mod, p.action === "edit" ? "UPDATE" : "VIEW")) return false;
  }
  return true;
}

export function slugDe(texte: string): string {
  const s = texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return /^[a-z]/.test(s) ? s : `p_${s}`.slice(0, 48);
}

// ─────────────────────────────── LES MANIFESTES DÉRIVÉS ───────────────────────────────

/**
 * LES CLÉS QU'UNE CAPACITÉ REND — lues là où elles sont DÉJÀ déclarées.
 *
 * Les onze manifestes de connecteur écrivent `sorties.cles` à la main. Un micro-outil et un
 * playbook, eux, n'en avaient AUCUNE : leur `sorties` ne portait qu'une description. Rien ne
 * savait donc ce que rendait la capacité qu'Adam venait de créer — ni le contrat de sortie
 * (§118.58), ni la fiche envoyée au modèle, ni l'écran. Or la déclaration existe dans les deux
 * cas, ailleurs :
 *
 *   • un MICRO-OUTIL passe la porte de qualité avec un schéma de sortie. Quand ce schéma est un
 *     OBJET, ses clés sont les clés du résultat. Quand c'est une LISTE, ses clés sont celles de
 *     chaque ÉLÉMENT — les prendre pour des clés de racine ferait dire au contrat qu'une
 *     capacité n'a pas tenu ce qu'elle n'avait jamais promis là. La distinction n'est pas un
 *     détail de forme : c'est la différence entre lire et deviner (§118.95).
 *   • un PLAYBOOK dont la règle enseignée décrit sa `sortie` la décrit par un GABARIT dont les
 *     clés de premier rang SONT celles du résultat. Sans gabarit, la sortie est celle de la
 *     dernière étape et on ne la connaît pas : on ne déclare alors rien (§118.26 — dire son
 *     ignorance plutôt que produire une liste plausible).
 */
export function clesDeclareesDuSchema(schema: unknown): string[] | null {
  if (!isObj(schema)) return null;
  if (schema.forme !== "objet") return null;
  const cles = Array.isArray(schema.cles) ? schema.cles.filter((c): c is string => typeof c === "string" && c.trim().length > 0) : [];
  return cles.length ? cles.slice(0, 12) : null;
}

export function clesDeclareesDuGabarit(sortie: unknown): string[] | null {
  if (!isObj(sortie)) return null;
  const cles = Object.keys(sortie).filter((c) => c.trim().length > 0);
  return cles.length ? cles.slice(0, 12) : null;
}

type SkillRow = Prisma.AdamSkillGetPayload<Record<string, never>>;

function manifestDeSkill(r: SkillRow): SkillManifest | null {
  const v = validerManifest({
    id: r.slug, plugin: "adam", version: String(r.version), titre: r.title, description: r.description,
    primitive: "CALCUL", effect: "ANALYZE", domaine: r.domain,
    entrees: isObj(r.inputSchema) && r.inputSchema.type === "object" ? r.inputSchema : { type: "object", properties: {} },
    sorties: {
      description: "le résultat du code, validé par la porte de qualité",
      ...(clesDeclareesDuSchema(r.schemaSortie) ? { cles: clesDeclareesDuSchema(r.schemaSortie) as string[] } : {}),
    },
    permissions: {}, risques: { niveau: "FAIBLE", irreversible: false, externe: false },
    cout: { latence: "LOW" }, dependances: { config: [] },
    ...(r.schemaSortie || r.attentes ? { validations: { ...(Array.isArray(r.attentes) ? { attentes: r.attentes } : {}), ...(isObj(r.schemaSortie) ? { schema: r.schemaSortie } : {}) } } : {}),
    executeur: { type: "code", langage: r.langage, code: r.code, ...(r.exemple !== null && r.exemple !== undefined ? { exemple: r.exemple } : {}) },
  });
  if (!v.ok) { console.warn(`[skills] micro-outil ${r.slug} invalide : ${v.issues.join(" ; ")}`); return null; }
  return v.manifest;
}

function manifestDePlaybook(r: RegleVue): SkillManifest | null {
  const pb = isObj(r.params) && isObj(r.params.playbook) ? r.params.playbook : null;
  if (!pb) return null;
  const v = validerManifest({
    id: slugDe(typeof pb.id === "string" && pb.id ? pb.id : r.title), plugin: "teach", version: String(r.version), titre: r.title,
    description: (typeof pb.description === "string" && pb.description ? pb.description : r.statement).slice(0, 600),
    primitive: "ORCHESTRATION", effect: "READ", domaine: domaineListe(typeof pb.domaine === "string" ? pb.domaine : r.domain),
    entrees: isObj(pb.entrees) && pb.entrees.type === "object" ? pb.entrees : { type: "object", properties: {} },
    sorties: {
      description: typeof pb.sorties === "string" ? pb.sorties : "la composition des étapes du playbook",
      ...(clesDeclareesDuGabarit(pb.sortie) ? { cles: clesDeclareesDuGabarit(pb.sortie) as string[] } : {}),
    },
    permissions: {}, risques: { niveau: "FAIBLE", irreversible: false, externe: false },
    cout: { latence: "MEDIUM" }, dependances: { config: [] },
    executeur: { type: "playbook", etapes: pb.etapes, ...(isObj(pb.sortie) ? { sortie: pb.sortie } : {}) },
  });
  if (!v.ok) { console.warn(`[skills] playbook « ${r.title} » invalide : ${v.issues.join(" ; ")}`); return null; }
  return v.manifest;
}

const metaDe = (m: SkillManifest) => {
  const lecture = EFFECT_RANK[m.effect] <= EFFECT_RANK.ANALYZE;
  return {
    domain: m.domaine.toLowerCase(), effect: m.effect, idempotent: lecture, batchable: lecture,
    latency: m.cout.latence, confirmation: exigeConfirmation(m) ? ("POLICY_ENGINE" as const) : ("NEVER" as const),
    contrat: "LIBRE" as const, primitive: m.primitive,
  };
};

const sourceLisible = (s: SkillCharge): string =>
  s.source === "plugin" ? `connecteur ${s.manifest.plugin} · ${s.manifest.titre}` : s.source === "adam" ? `micro-outil « ${s.manifest.titre} » (code dans le bac à sable)` : `playbook enseigné « ${s.manifest.titre} »`;

// ─────────────────────────────── LE CHARGEMENT PAR PERSONNE ───────────────────────────────

async function chargerPour(user: CurrentUser): Promise<CachePersonne> {
  const skills = new Map<string, SkillCharge>();
  const ajouter = (m: SkillManifest, source: SourceSkill, extra: Partial<SkillCharge>) => {
    const nom = nomOutil(m);
    if (skills.has(nom)) { console.warn(`[skills] « ${nom} » déclaré deux fois : le second est ignoré`); return; }
    if (!autorise(m, user)) return;
    skills.set(nom, { manifest: m, source, nom, dispo: disponibilite(m, config()), ...extra });
  };

  for (const p of PLUGINS) {
    const v = validerManifest(p);
    if (!v.ok) { console.warn(`[skills] manifeste ${p.plugin}/${p.id} invalide : ${v.issues.join(" ; ")}`); continue; }
    ajouter(v.manifest, "plugin", {});
  }

  const sujet = await sujetDe(user.id).catch(sansBloquer("skills.chargerPour.sujetDe", null));
  const maintenant = new Date();
  const rows = await prisma.adamSkill.findMany({
    where: {
      OR: [
        { ownerId: user.id, status: { in: ["TEMP", "PROMOTED"] } },
        ...(sujet && sujet.companyIds.length ? [{ status: "PROMOTED", scope: "COMPANY", companyId: { in: [...sujet.companyIds] } }] : []),
        ...(sujet && sujet.departmentIds.length ? [{ status: "PROMOTED", scope: "GROUP", departmentId: { in: [...sujet.departmentIds] } }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
  }).catch(sansBloquer("skills.chargerPour.adamSkill", [] as SkillRow[]));
  for (const r of rows) {
    if (r.status === "TEMP" && r.expiresAt && r.expiresAt < maintenant) continue;
    const m = manifestDeSkill(r);
    if (m) ajouter(m, "adam", { skillId: r.id, ownerId: r.ownerId, statut: r.status, expiresAt: r.expiresAt, usageCount: r.usageCount });
  }

  const regles = await reglesEnVigueurPour(user.id).catch(sansBloquer("skills.chargerPour.reglesEnVigueurPour", null));
  for (const r of regles?.toutes ?? []) {
    if (r.kind !== "WORKFLOW" || r.status !== "ACTIVE") continue;
    const m = manifestDePlaybook(r);
    if (m) ajouter(m, "teach", { regleId: r.id });
  }

  for (const s of skills.values()) {
    LABELS.set(s.nom, s.manifest.titre);
    declarerMetaDynamique(s.nom, metaDe(s.manifest));
    declarerDomaineDynamique(s.nom, [domaineListe(s.manifest.domaine)]);
  }
  const outils = [...skills.values()].map((s) => outilDe(s, user));
  const c: CachePersonne = { at: Date.now(), empreinte: await empreinte(user.id), skills, outils };
  CACHE.set(user.id, c);
  return c;
}

/**
 * L'EMPREINTE de ce qui peut changer la carte d'une personne : ses règles WORKFLOW et les micro-outils
 * visibles (les siens, ceux promus à un périmètre). Deux agrégats indexés par tour — c'est ce qui rend
 * une règle enseignée à l'instant VISIBLE au tour suivant, sans attendre l'expiration d'un cache.
 */
async function empreinte(userId: string): Promise<string> {
  const [r, k] = await Promise.all([
    prisma.adamRule.aggregate({ where: { status: "ACTIVE", kind: "WORKFLOW", OR: [{ subjectUserId: userId }, { scope: { in: ["COMPANY", "GROUP"] } }] }, _count: { _all: true }, _max: { updatedAt: true } }).catch(sansBloquer("skills.empreinte.adamRule", null)),
    prisma.adamSkill.aggregate({ where: { status: { in: ["TEMP", "PROMOTED"] }, OR: [{ ownerId: userId }, { scope: { in: ["COMPANY", "GROUP"] } }] }, _count: { _all: true }, _max: { updatedAt: true } }).catch(sansBloquer("skills.empreinte.adamSkill", null)),
  ]);
  return `${r?._count._all ?? 0}|${r?._max.updatedAt?.getTime() ?? 0}|${k?._count._all ?? 0}|${k?._max.updatedAt?.getTime() ?? 0}`;
}

const outilDe = (s: SkillCharge, proprietaire: CurrentUser): PowerTool => ({
  def: { name: s.nom, description: fiche(s.manifest, s.dispo), input_schema: schemaOutil(s.manifest) },
  allowed: (u) => u.id === proprietaire.id && autorise(s.manifest, u),
  label: s.manifest.titre,
  run: (input, u) => executer(s, input, u),
});

/** À appeler au début d'un tour et d'une mission : la carte des skills de CETTE personne, fraîche. */
export async function prechargerCapacitesDynamiques(user: CurrentUser): Promise<number> {
  const c = CACHE.get(user.id);
  if (c && Date.now() - c.at < TTL_MS && c.empreinte === await empreinte(user.id)) return c.skills.size;
  return (await chargerPour(user)).skills.size;
}

/** Les outils dynamiques de la personne — synchrones, depuis le cache (vide tant que rien n'a préchargé). */
export function outilsDynamiquesPour(user: CurrentUser): PowerTool[] {
  return CACHE.get(user.id)?.outils ?? [];
}

export function labelsDynamiques(): Record<string, string> {
  return Object.fromEntries(LABELS);
}

export function skillsChargesPour(userId: string): SkillCharge[] {
  return [...(CACHE.get(userId)?.skills.values() ?? [])];
}

/**
 * Les connecteurs de MESSAGERIE réellement utilisables par cette personne : déclarés, configurés
 * ET ouverts à elle (§37 — la porte d'attention les lit pour choisir le canal préféré). Un canal
 * préféré non branché n'est pas une erreur : la porte le dit et garde la table du niveau.
 */
export async function connecteursMessagerie(user: CurrentUser): Promise<CanalMessagerie[]> {
  let c = CACHE.get(user.id);
  if (!c || Date.now() - c.at > TTL_MS) c = await chargerPour(user);
  const charge = c;
  return CANAUX_MESSAGERIE.filter((canal) => {
    const s = charge.skills.get(outilDeCanal(canal));
    return Boolean(s && s.dispo.ok && autorise(s.manifest, user));
  });
}

/** Exécute un outil dynamique — `null` si ce nom n'en est pas un pour cette personne. */
export async function executerOutilDynamique(name: string, input: Json, user: CurrentUser): Promise<string | null> {
  let c = CACHE.get(user.id);
  if (!c || Date.now() - c.at > TTL_MS) c = await chargerPour(user);
  const s = c.skills.get(name);
  if (!s) {
    // Un connecteur DÉCLARÉ que cette personne n'a pas le droit de voir : un refus de permission, compté (§33),
    // avec la même phrase que le cœur — jamais « outil inconnu », qui ferait croire à une absence.
    if (NOMS_PLUGINS.has(name)) { recordPermissionRefusal(name); return "Ce module ne vous est pas ouvert : je ne peux pas consulter cette information."; }
    return null;
  }
  if (!autorise(s.manifest, user)) { recordPermissionRefusal(name); return "Ce module ne vous est pas ouvert : je ne peux pas consulter cette information."; }
  return executer(s, input, user);
}

/**
 * LE PASSAGE DE MISSION : un skill qui écrit ou engage exige `confirmer: true`. Dans une mission, cet
 * accord a été donné par la porte d'approbation — le RUNNER le pose lui-même, jamais le modèle.
 */
export function preparerAppelMission(userId: string, name: string, input: Json): Json {
  const s = CACHE.get(userId)?.skills.get(name);
  if (!s || !exigeConfirmation(s.manifest)) return input;
  return { ...input, confirmer: true };
}

// ─────────────────────────────── L'EXÉCUTION ───────────────────────────────

function verifierDebit(userId: string, nom: string, limites: SkillManifest["limites"]): string | null {
  if (!limites?.parMinute && !limites?.parJour) return null;
  const cle = `${userId}|${nom}`;
  const maintenant = Date.now();
  const historique = (DEBIT.get(cle) ?? []).filter((t) => maintenant - t < 24 * 3600 * 1000);
  const minute = historique.filter((t) => maintenant - t < 60_000).length;
  if (limites.parMinute && minute >= limites.parMinute) return `limite de débit atteinte : ${limites.parMinute} appel(s) par minute pour cet outil — réessayer dans une minute`;
  if (limites.parJour && historique.length >= limites.parJour) return `limite de débit atteinte : ${limites.parJour} appel(s) par jour pour cet outil`;
  historique.push(maintenant);
  DEBIT.set(cle, historique);
  return null;
}

const requis = (m: SkillManifest, chemin: string): boolean => {
  if (!chemin.startsWith("entree.")) return false;
  const cle = chemin.slice("entree.".length).split(/[.[]/)[0] ?? "";
  return (m.entrees.required ?? []).includes(cle);
};

/** Le chemin HTTP : chaque valeur substituée est encodée — une entrée ne réécrit jamais l'URL. */
function remplirChemin(chemin: string, ctx: Json): { valeur: string; manquants: string[] } {
  const manquants: string[] = [];
  const valeur = chemin.replace(/\{\{\s*([a-zA-Z0-9_.\-[\]]+)\s*\}\}/g, (_, c: string) => {
    const v = lireChemin(ctx, c);
    if (v === undefined || v === null || v === "") { manquants.push(c); return ""; }
    return encodeURIComponent(typeof v === "object" ? JSON.stringify(v) : String(v));
  });
  return { valeur, manquants };
}

function apercuDe(s: SkillCharge, entree: Json): Json {
  const m = s.manifest;
  const base: Json = { outil: s.nom, titre: m.titre, effet: m.effect, risques: m.risques, source: sourceLisible(s), entree };
  if (m.executeur.type === "http") {
    const ex = m.executeur;
    const cfg = config();
    const ctx = { entree, config: Object.fromEntries(m.dependances.config.map((k) => [k, cfg[k] ?? ""])) };
    // JAMAIS les en-têtes ni l'authentification dans un aperçu : ce qui part se décrit par sa cible et son corps.
    return { ...base, requete: { methode: ex.methode, chemin: remplirChemin(ex.chemin, ctx).valeur, ...(ex.corps !== undefined ? { corps: remplir(ex.corps, ctx).valeur } : {}) } };
  }
  if (m.executeur.type === "playbook") return { ...base, etapes: m.executeur.etapes.map((e) => `${e.alias} : ${e.outil}`) };
  return base;
}

/** Un corps de formulaire : les valeurs simples telles quelles, les objets en JSON — jamais « [object Object] ». */
function corpsFormulaire(v: unknown): string {
  const p = new URLSearchParams();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || x === null) continue;
      p.set(k, typeof x === "object" ? JSON.stringify(x) : String(x));
    }
  }
  return p.toString();
}

async function executerHttp(s: SkillCharge, entree: Json): Promise<Json> {
  const m = s.manifest;
  const ex = m.executeur as ExecuteurHttp;
  const cfg = config();
  const base = (cfg[ex.base] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return { ok: false, limite: "RESSOURCE", erreur: `la configuration ${ex.base} ne porte pas une URL valide : connecteur « ${m.plugin} » non configuré` };
  const ctx = { entree, config: Object.fromEntries(m.dependances.config.map((k) => [k, cfg[k] ?? ""])) };
  const chemin = remplirChemin(ex.chemin, ctx);
  const corps = ex.corps !== undefined && ex.methode !== "GET" ? remplir(ex.corps, ctx) : null;
  const manquants = [...chemin.manquants, ...(corps?.manquants ?? [])].filter((c) => requis(m, c));
  if (manquants.length) return { ok: false, erreur: `entrée(s) obligatoire(s) manquante(s) : ${[...new Set(manquants.map((c) => c.replace(/^entree\./, "")))].join(", ")}` };
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [k, v] of Object.entries(ex.entetes ?? {})) headers[k] = String(remplir(v, ctx).valeur ?? "");
  if (ex.auth?.type === "bearer") headers.Authorization = `Bearer ${cfg[ex.auth.config] ?? ""}`;
  if (ex.auth?.type === "entete") headers[ex.auth.nom] = cfg[ex.auth.config] ?? "";
  if (ex.auth?.type === "basic") headers.Authorization = `Basic ${Buffer.from(`${cfg[ex.auth.utilisateur] ?? ""}:${cfg[ex.auth.motDePasse] ?? ""}`, "utf8").toString("base64")}`;
  const formulaire = ex.corpsForme === "formulaire";
  if (corps && !headers["Content-Type"]) headers["Content-Type"] = formulaire ? "application/x-www-form-urlencoded" : "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELAI_HTTP_MS);
  try {
    const res = await (FETCH ?? fetch)(`${base}${chemin.valeur}`, { method: ex.methode, headers, body: corps ? (formulaire ? corpsFormulaire(corps.valeur) : JSON.stringify(corps.valeur)) : undefined, signal: controller.signal });
    const texte = (await res.text()).slice(0, TAILLE_MAX);
    let data: unknown = texte;
    try { data = JSON.parse(texte); } catch { /* texte brut */ }
    if (!res.ok) return { ok: false, statut: res.status, erreur: `le service « ${m.plugin} » a répondu ${res.status}`, detail: typeof data === "string" ? data.slice(0, 500) : data };
    const utile = ex.reponse?.chemin ? (lireChemin(data, ex.reponse.chemin) ?? data) : data;
    return { ok: true, statut: res.status, resultat: utile };
  } catch (e) {
    return { ok: false, limite: "RESSOURCE", erreur: `service « ${m.plugin} » injoignable : ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

const executerDansLeBac = (langage: "js" | "python") => async (c: string, d: unknown) => {
  const x = langage === "python" ? await executerPython(c, d) : await executerJs(c, d);
  return { ok: x.ok, resultat: x.resultat, erreur: x.erreur, ms: x.ms, journal: x.journal };
};

/**
 * LE CODE D'UN MICRO-OUTIL passe la porte à CHAQUE appel — inspection, exécution, forme promise.
 * Les attentes closes, elles, appartiennent à l'EXEMPLE de création (« pour 125 000, le total
 * vaut 148 750 ») : les rejouer sur une autre entrée refuserait un résultat juste.
 */
async function executerCode(s: SkillCharge, entree: Json): Promise<Json> {
  const ex = s.manifest.executeur as ExecuteurCode;
  if (ex.langage === "python") {
    const dispo = sonderPython();
    if (!dispo.disponible) return { ok: false, limite: "RESSOURCE", erreur: `Python indisponible sur ce serveur : ${dispo.raison}` };
  }
  const porte = await passerLaPorte({ code: ex.code, langage: ex.langage, data: entree, attentes: [], schema: s.manifest.validations?.schema ?? null, executer: executerDansLeBac(ex.langage) });
  if (!porte.expose) return { ok: false, erreur: porte.correction ?? "le résultat n'a pas passé la porte de qualité", porte: { refusePar: porte.refusePar, etapes: porte.etapes.map((e) => `${e.etape} : ${e.ok ? "ok" : "REFUS"} — ${e.detail}`) } };
  return { ok: true, resultat: porte.resultat, porte: { etapes: porte.etapes.map((e) => e.etape).join(" → ") } };
}

async function executerPlaybook(s: SkillCharge, entree: Json, user: CurrentUser): Promise<Json> {
  const ex = s.manifest.executeur as ExecuteurPlaybook;
  const profondeur = PROFONDEUR.get(user.id) ?? 0;
  if (profondeur >= 3) return { ok: false, erreur: "un playbook n'en appelle pas un troisième : la profondeur est bornée à trois" };
  PROFONDEUR.set(user.id, profondeur + 1);
  try {
    // Import PARESSEUX : `assistant.ts` importe les outils de pouvoir, qui importent ce pont.
    const { executeReadTool, RESOLVER_WRITE_NAMES } = await import("@/lib/assistant");
    const etapes: Json = {};
    const journal: Json[] = [];
    for (const et of ex.etapes) {
      if (RESOLVER_WRITE_NAMES.has(et.outil) || OUTILS_INTERDITS_PLAYBOOK.test(et.outil)) {
        return { ok: false, erreur: `l'étape « ${et.alias} » appelle « ${et.outil} », qui n'est pas une lecture : un playbook compose des lectures ; une écriture passe par la proposition habituelle`, etapes: journal };
      }
      const args = remplir(et.args, { entree, etapes });
      const t0 = Date.now();
      const brut = await executeReadTool(et.outil, isObj(args.valeur) ? args.valeur : {}, user);
      let sortie: unknown = brut;
      try { sortie = JSON.parse(brut); } catch { /* texte */ }
      etapes[et.alias] = sortie;
      journal.push({ alias: et.alias, outil: et.outil, ms: Date.now() - t0, ...(args.manquants.length ? { gabaritsNonRemplis: args.manquants } : {}) });
    }
    const derniere = ex.etapes[ex.etapes.length - 1];
    const resultat = ex.sortie ? remplir(ex.sortie, { entree, etapes }).valeur : derniere ? etapes[derniere.alias] : null;
    return { ok: true, resultat, etapes: journal };
  } finally {
    PROFONDEUR.set(user.id, profondeur);
  }
}

const resumeDe = (v: unknown): string => {
  if (v === null || v === undefined) return "aucun résultat";
  if (Array.isArray(v)) return `${v.length} élément(s)`;
  if (typeof v === "object") return `${Object.keys(v as Json).length} champ(s)`;
  return String(v).slice(0, 80);
};

export async function executer(s: SkillCharge, input: Json, user: CurrentUser, opts: { approuve?: boolean } = {}): Promise<string> {
  const m = s.manifest;
  if (!s.dispo.ok) {
    return JSON.stringify({
      ok: false, outil: s.nom, limite: "RESSOURCE", manquantes: s.dispo.manquantes,
      erreur: `connecteur « ${m.plugin} » non configuré sur ce serveur : clé de configuration ${s.dispo.manquantes.join(", ")} non configurée. Dire cette limite (une ressource manque), ne pas la contourner.`,
    });
  }
  const debit = verifierDebit(user.id, s.nom, m.limites);
  if (debit) return JSON.stringify({ ok: false, outil: s.nom, limite: "DEBIT", erreur: debit });
  const { confirmer, ...entree } = input;
  if (exigeConfirmation(m) && !opts.approuve && confirmer !== true) {
    return JSON.stringify({
      ok: false, outil: s.nom, confirmationRequise: true, apercu: apercuDe(s, entree),
      consigne: "Montrer cet aperçu à la personne (ce qui part, où, avec quel effet), obtenir son accord EXPLICITE dans la conversation, puis rappeler le même outil avec confirmer: true. Sans accord, ne rien envoyer.",
    });
  }
  const t0 = Date.now();
  let sortie: Json;
  switch (m.executeur.type) {
    case "http": sortie = await executerHttp(s, entree); break;
    case "code": sortie = await executerCode(s, entree); break;
    case "playbook": sortie = await executerPlaybook(s, entree, user); break;
  }
  const ms = Date.now() - t0;
  if (s.source === "adam" && s.skillId) {
    // ATTENDU, pas lancé en l'air : sans `await`, le compteur pouvait encore valoir 0 quand la
    // fiche était relue juste après l'exécution — mesuré sous la suite complète (§118.132). Un
    // compteur qui dit 0 après un usage est un petit faux succès de comptabilité ; une ligne à
    // écrire coûte quelques millisecondes. L'échec de l'écriture, lui, ne fait toujours pas
    // échouer l'outil.
    await prisma.adamSkill.update({ where: { id: s.skillId }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(sansBloquer("skills.executer.adamSkill"));
  }
  if (exigeConfirmation(m)) {
    await recordAudit({ actorId: user.id, action: "EXPORT", module: "ASSISTANT", entityId: s.nom, summary: `Skill « ${m.titre} » (${m.plugin}, ${m.effect}) ${sortie.ok ? "exécuté" : "en échec"} sur accord de la personne.` }).catch(sansBloquer("skills.executer.recordAudit"));
  }
  /**
   * LE CONTRAT DÉCLARÉ, CONFRONTÉ À CE QUI SORT (§118.20 appliqué aux capacités qu'on n'a PAS
   * écrites). `sorties.cles` vit dans le manifeste depuis le début et servait à DÉCRIRE l'outil
   * au modèle ; personne ne le comparait à ce que l'exécution rendait vraiment. Un skill créé
   * par Adam — micro-outil promu, connecteur déclaré, playbook enseigné — pouvait donc annoncer
   * `{ montant, devise }` et livrer `{ erreur }`, et le cœur n'a aucun endroit où aller le
   * corriger : c'est précisément ce qui rend un runtime de skills extensible.
   *
   * On CONSTATE, on ne répare pas : combler avec des `null` fabriquerait une sortie que la
   * capacité n'a jamais produite, et le plan croirait tenir une valeur.
   */
  const ecart = ecartDeContrat({ outil: s.nom, clesDeclarees: m.sorties.cles, resultat: sortie.resultat, ok: Boolean(sortie.ok) });
  /**
   * ET CE QUE ÇA DONNE À L'ÉCRAN. Le même manifeste, lu pour une seconde question : « où sont
   * tes lignes ? ». La table de l'espace de travail nomme des outils écrits dans le cœur, où
   * une capacité dynamique n'entrera jamais — elle rendait donc `null`, en silence, sur
   * exactement ce que §36 existe pour rendre possible. On ne devine pas : c'est `sorties.cles`
   * qui autorise, et `tableFromRows` qui dessine (§118.5 : un seul traducteur).
   */
  const aff = lignesDeclarees({ titre: m.titre, clesDeclarees: m.sorties.cles, sortie });
  return JSON.stringify({
    ...sortie, outil: s.nom, source: sourceLisible(s), ms,
    ...(ecart ? { _contrat: ecart.phrase, _contratManquantes: ecart.manquantes } : {}),
    ...(aff.lignes ? { _lignes: aff.lignes } : {}),
    ...(aff.manque ? { _affichage: aff.manque } : {}),
    ...(sortie.ok && sortie.resultat !== undefined
      ? { _provenance: declarerProvenance([faitCalcule({ outil: s.nom, acteur: user.id, libelle: m.titre, valeur: resumeDe(sortie.resultat), entrees: [sourceLisible(s)], transformation: `skill ${s.source} · ${m.executeur.type}`, formule: JSON.stringify(entree).slice(0, 300) })]) }
      : {}),
  });
}

// ─────────────────────────────── LE CYCLE DES MICRO-OUTILS ───────────────────────────────

export interface DemandeSkill {
  nom: string; description: string; langage?: string | null; code: string;
  entrees?: unknown; exemple?: unknown; attentes?: unknown; schema?: unknown; domaine?: string | null;
}
export interface Provenance { threadId?: string | null; missionId?: string | null }

export type ResultatCreation =
  | {
      ok: true; outil: string; statut: string; version: number; expireLe: string | null;
      porte: { tests: string; etapes: string[] }; exemple: { entree: unknown; resultat: unknown };
      /** LE GESTE SUIVANT, en toutes lettres — voir le commentaire au point de retour (§118.19). */
      prochain: string;
    }
  | { ok: false; motif: string; issues?: string[]; porte?: { refusePar: string | null; etapes: string[] } };

/** CRÉER un micro-outil : rien n'est exposé sans être passé par la porte de qualité sur l'exemple. */
export async function creerMicroSkill(user: CurrentUser, d: DemandeSkill, provenance: Provenance = {}): Promise<ResultatCreation> {
  const slug = slugDe(d.nom ?? "");
  if (!SLUG_RE.test(slug)) return { ok: false, motif: `nom invalide « ${d.nom} » : lettres, chiffres, espaces ou tirets, 3 à 48 caractères` };
  const nom = nomOutil({ id: slug, plugin: "adam" });
  if (IDENTIFIANTS_INTERDITS.test(slug)) return { ok: false, motif: `« ${slug} » ressemble à une capacité de contrôle, d'enseignement ou de sécurité : refusé` };
  const { POWER_TOOLS } = await import("@/lib/assistant/power-tools");
  if (POWER_TOOLS.some((t) => t.def.name === nom)) return { ok: false, motif: `« ${nom} » est déjà un outil du cœur` };
  const langage = d.langage === "python" ? "python" : "js";
  if (typeof d.code !== "string" || !d.code.trim()) return { ok: false, motif: "code vide" };
  if (d.exemple === undefined) return { ok: false, motif: "donner un `exemple` d'entrée : la porte de qualité juge le code dessus AVANT de l'exposer" };
  const entrees = isObj(d.entrees) && d.entrees.type === "object" && isObj(d.entrees.properties) ? d.entrees : { type: "object", properties: {}, description: "les données passées au code comme `data`" };
  const attentes = (Array.isArray(d.attentes) ? d.attentes.filter(isObj) : []) as unknown as Attente[];
  const schema = (isObj(d.schema) ? d.schema : null) as SchemaSortie | null;
  const v = validerManifest({
    id: slug, plugin: "adam", version: "1", titre: d.nom.trim().slice(0, 80), description: (d.description ?? "").trim().slice(0, 600),
    primitive: "CALCUL", effect: "ANALYZE", domaine: domaineListe(d.domaine ?? "DATA"), entrees,
    sorties: { description: "le résultat du code" }, permissions: {}, risques: { niveau: "FAIBLE", irreversible: false, externe: false },
    cout: { latence: "LOW" }, dependances: { config: [] }, validations: { attentes, ...(schema ? { schema } : {}) },
    executeur: { type: "code", langage, code: d.code, exemple: d.exemple },
  });
  if (!v.ok) return { ok: false, motif: "manifeste invalide", issues: v.issues };
  if (langage === "python") {
    const dispo = sonderPython();
    if (!dispo.disponible) return { ok: false, motif: `Python indisponible sur ce serveur : ${dispo.raison}. Réécrire en JavaScript.` };
  }
  const porte = await passerLaPorte({ code: d.code, langage, data: d.exemple, attentes, schema, executer: executerDansLeBac(langage) });
  const etapes = porte.etapes.map((e) => `${e.etape} : ${e.ok ? "ok" : "REFUS"} — ${e.detail}`);
  if (!porte.expose) return { ok: false, motif: `le code ne passe pas la porte de qualité (${porte.refusePar}) : ${porte.correction ?? "corriger et réessayer"}`, porte: { refusePar: porte.refusePar, etapes } };

  const existant = await prisma.adamSkill.findUnique({ where: { ownerId_slug: { ownerId: user.id, slug } } });
  const garde = existant?.status === "PROMOTED";
  const data = {
    title: d.nom.trim().slice(0, 80), description: (d.description ?? "").trim().slice(0, 600), domain: domaineListe(d.domaine ?? "DATA"),
    langage, code: d.code, inputSchema: entrees as Prisma.InputJsonValue, exemple: d.exemple as Prisma.InputJsonValue,
    attentes: attentes as unknown as Prisma.InputJsonValue, schemaSortie: (schema ?? undefined) as Prisma.InputJsonValue | undefined,
    status: garde ? "PROMOTED" : "TEMP", expiresAt: garde ? null : new Date(Date.now() + TEMP_MS),
    provenance: { ...provenance, porte: { tests: `${porte.testsPasses}/${porte.testsTotal}`, etapes } } as Prisma.InputJsonValue,
  };
  const row = existant
    ? await prisma.adamSkill.update({ where: { id: existant.id }, data: { ...data, version: { increment: 1 } } })
    : await prisma.adamSkill.create({ data: { ...data, ownerId: user.id, slug } });
  CACHE.delete(user.id);
  await recordAudit({ actorId: user.id, action: existant ? "UPDATE" : "CREATE", module: "ASSISTANT", entityId: row.id, summary: `Micro-outil « ${row.title} » (${nom}, v${row.version}) ${existant ? "révisé" : "créé"} — porte ${porte.testsPasses}/${porte.testsTotal}.` }).catch(sansBloquer("skills.creerMicroSkill.recordAudit"));
  /**
   * ── LA SORTIE NOMME LE GESTE SUIVANT (§118.19) ──────────────────────────────────────────
   *
   * MESURÉ sur la campagne live (`defi-skill-micro-outil`) : Adam a créé `skill_tva_19`, la
   * porte de qualité l'a validé sur l'exemple, l'outil a bien été exposé DANS LE TOUR (le
   * mécanisme est en place et commenté dans `assistant.ts`)… et Adam a ensuite appliqué la règle
   * DE TÊTE au montant demandé. La réponse était juste, mais la consigne du tour dit « JAMAIS de
   * tête, même pour une multiplication » : un outil qu'on vient de bâtir et qu'on n'appelle pas
   * est une capacité sans appelant (§118.14), et son résultat n'a plus ni provenance ni reçu.
   *
   * Le retour disait le NOM, l'échéance et le rapport de porte — il ne disait pas quoi FAIRE
   * ensuite. Ce que le code rend possible, la sortie doit dire comment l'obtenir : c'est la même
   * règle que pour un refus qui nomme son remède, appliquée à un SUCCÈS.
   */
  const prochain = `Outil disponible IMMÉDIATEMENT dans ce tour : appelle « ${nom} » pour l'appliquer — `
    + "ne refais pas son calcul de tête, son résultat porte sa provenance et son reçu.";
  return { ok: true, outil: nom, statut: row.status, version: row.version, expireLe: row.expiresAt?.toISOString() ?? null, porte: { tests: `${porte.testsPasses}/${porte.testsTotal}`, etapes }, exemple: { entree: d.exemple, resultat: porte.resultat }, prochain };
}

export interface SkillVue {
  outil: string; titre: string; source: SourceSkill; plugin: string; effet: string; primitive: string; domaine: string;
  disponible: boolean; manquantes: string[]; confirmation: boolean; statut?: string; expireLe?: string | null; utilisations?: number; version: string;
}

export async function listerSkills(user: CurrentUser): Promise<SkillVue[]> {
  const c = await chargerPour(user);
  return [...c.skills.values()].map((s) => ({
    outil: s.nom, titre: s.manifest.titre, source: s.source, plugin: s.manifest.plugin, effet: s.manifest.effect, primitive: s.manifest.primitive,
    domaine: s.manifest.domaine, disponible: s.dispo.ok, manquantes: s.dispo.manquantes, confirmation: exigeConfirmation(s.manifest),
    ...(s.source === "adam" ? { statut: s.statut, expireLe: s.expiresAt?.toISOString() ?? null, utilisations: s.usageCount ?? 0 } : {}),
    version: s.manifest.version,
  }));
}

async function trouverSkill(user: CurrentUser, nom: string): Promise<{ row: SkillRow } | { erreur: string }> {
  const slug = slugDe(nom.replace(/^skill_/, ""));
  const propre = await prisma.adamSkill.findUnique({ where: { ownerId_slug: { ownerId: user.id, slug } } });
  if (propre && propre.status !== "DROPPED") return { row: propre };
  if (hasGlobalView(user)) {
    const autre = await prisma.adamSkill.findFirst({ where: { slug, status: { in: ["TEMP", "PROMOTED"] } }, orderBy: { updatedAt: "desc" } });
    if (autre) return { row: autre };
  }
  return { erreur: `aucun micro-outil « skill_${slug} » à vous (ou visible avec la vue globale)` };
}

/** PROMOUVOIR — un geste de personne : périmètre, droit, trace. Interdit à l'agent par `policy/guard.ts`. */
export async function promouvoirSkill(user: CurrentUser, d: { nom: string; scope?: string | null }): Promise<{ ok: true; outil: string; scope: string; visiblePour: string } | { ok: false; motif: string }> {
  const t = await trouverSkill(user, d.nom);
  if ("erreur" in t) return { ok: false, motif: t.erreur };
  const scope = (d.scope ?? "PERSON").toUpperCase();
  if (!["PERSON", "GROUP", "COMPANY"].includes(scope)) return { ok: false, motif: "périmètre : PERSON, GROUP ou COMPANY" };
  const sujet = await sujetDe(user.id);
  if (scope === "COMPANY" && !hasGlobalView(user)) return { ok: false, motif: "promouvoir pour toute la société est réservé à la direction (vue globale)" };
  if (scope === "COMPANY" && !sujet.companyIds.length) return { ok: false, motif: "aucune société rattachée à votre compte : impossible de promouvoir au périmètre société" };
  if (scope === "GROUP" && !sujet.departmentIds.length) return { ok: false, motif: "aucun département rattaché à votre compte : impossible de promouvoir au périmètre département" };
  const row = await prisma.adamSkill.update({
    where: { id: t.row.id },
    data: { status: "PROMOTED", scope, companyId: scope === "COMPANY" ? sujet.companyIds[0] : null, departmentId: scope === "GROUP" ? sujet.departmentIds[0] : null, expiresAt: null, promotedById: user.id, promotedAt: new Date() },
  });
  CACHE.clear();
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: "ASSISTANT", entityId: row.id, summary: `Micro-outil « ${row.title} » promu (${scope}) par ${user.name}.` }).catch(sansBloquer("skills.promouvoirSkill.recordAudit"));
  return { ok: true, outil: nomOutil({ id: row.slug, plugin: "adam" }), scope, visiblePour: scope === "PERSON" ? "vous seul" : scope === "GROUP" ? "votre département" : "toute la société" };
}

export async function supprimerSkill(user: CurrentUser, d: { nom: string }): Promise<{ ok: true; outil: string } | { ok: false; motif: string }> {
  const t = await trouverSkill(user, d.nom);
  if ("erreur" in t) return { ok: false, motif: t.erreur };
  const row = await prisma.adamSkill.update({ where: { id: t.row.id }, data: { status: "DROPPED" } });
  CACHE.clear();
  await recordAudit({ actorId: user.id, action: "DELETE", module: "ASSISTANT", entityId: row.id, summary: `Micro-outil « ${row.title} » jeté par ${user.name}.` }).catch(sansBloquer("skills.supprimerSkill.recordAudit"));
  return { ok: true, outil: nomOutil({ id: row.slug, plugin: "adam" }) };
}

/** Pour les bancs : ce qu'un manifeste HTTP attend comme trous — dit sans exécuter. */
export const trousDe = (m: SkillManifest): string[] => (m.executeur.type === "http" ? [...trous(m.executeur.chemin), ...trous(m.executeur.corps ?? null)] : []);
