import type { CompiledMission, CompiledStep } from "@/lib/missions/compiler/compile";
import type { StepCondition } from "@/lib/missions/planner/contract";
import type { RefDepot } from "@/lib/missions/chantiers/ports-moteur";
import { ressourceValide } from "@/lib/missions/equipe/ressources";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN D'UN CHANTIER DE DÉVELOPPEMENT (lot C1, décision 0042, docs/architecture/CHANTIERS-DEV.md § 3).
 * Module PUR : aucune base, aucun réseau — l'écran le lit comme le serveur.
 *
 * Un chantier n'est PAS un second moteur : c'est une `Mission` `kind = "CHANTIER"` dont le plan se compile en
 * étapes du Mission Runtime (`CompiledStep`), que `materialiser` écrit et `avancer` conduit — bail, idempotence,
 * reçus, reprise après coupure. Chaque étape est un nœud WORKER dont le gestionnaire (`etapes.ts`) appelle les
 * PORTS (Claude Code, GitHub, Render) ; une attente est un `WAITING` daté que le réveil remet en file.
 *
 *   DEV_LANCER       réserve, puis lance Claude Code (une session principale) sur la branche RÉSERVÉE
 *   DEV_ATTENDRE     attend un commit NEUF sur la branche (sondage à pas croissant, réveil par événement)
 *   DEV_VERIFIER     lit GitHub : périmètre, PR, checks du SHA de tête → { vert, sha, signature }
 *   DEV_CORRIGER     si rouge : renvoie le problème (commentaire @claude / relance), attend, revérifie — borné
 *   DEV_FUSIONNER    PR verte → carte « Fusionner la PR #n (titre) dans <base> » ; validée : fusion au SHA vérifié,
 *                    puis CI de la BASE sur le commit de fusion (compensation : une PR de revert, jamais un force-push)
 *   RENDER_DEPLOYER  déploie le SHA EXACT vérifié, sérialisé par service (ERP avant app et worker)
 *   RENDER_VERIFIER  santé (healthCheckPath 200), logs sans erreur nouvelle → { sain }
 *   RENDER_ROLLBACK  si malsain : rollback vers le dernier déploiement sain, autoDeploy coupé
 *   RAPPORT          rend compte, avec les PREUVES (SHA, checks, statut live, santé, coût)
 *
 * Le DAG ne boucle pas : la boucle de correction vit DANS `DEV_CORRIGER` (tours bornés, anti-boucle), et
 * le rollback est une étape CONDITIONNELLE (`si` sur `sain`). Hors de ce catalogue, rien ne compile.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_ETAPE_CHANTIER = [
  "DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "DEV_FUSIONNER", "RENDER_DEPLOYER", "RENDER_VERIFIER", "RENDER_ROLLBACK", "RAPPORT",
] as const;
export type TypeEtapeChantier = (typeof TYPES_ETAPE_CHANTIER)[number];

/** Les étapes qui visent un SERVICE Render (le plan doit le déclarer). */
const ETAPES_SERVICE: ReadonlySet<TypeEtapeChantier> = new Set(["RENDER_DEPLOYER", "RENDER_VERIFIER", "RENDER_ROLLBACK"]);

/** L'ordre de déploiement : l'ERP (et ses migrations) d'abord, l'app et le worker ensuite. */
export const ROLES_SERVICE = ["erp", "app", "worker"] as const;
export type RoleService = (typeof ROLES_SERVICE)[number];
export const RANG_ROLE: Record<RoleService, number> = { erp: 0, app: 1, worker: 1 };

export interface ServiceChantier {
  id: string;
  nom: string;
  role: RoleService;
  /** Production : déployer ET rollback passent par une carte de validation (§ 7). */
  production: boolean;
  /** La branche que le service déploie : celle du chantier (préproduction) ou `main` (fusion validée d'abord). */
  branche?: string;
  url?: string;
  healthCheckPath?: string;
}

export interface BudgetChantier {
  usd?: number;
  lancements?: number;
  deploiements?: number;
  tentatives?: number;
}

export interface EtapeChantier {
  cle: string;
  titre: string;
  type: TypeEtapeChantier;
  apres?: string[];
  /** RENDER_* : l'identifiant du service visé (déclaré dans `services`). */
  service?: string;
  /** Ne part que si la sortie de l'étape `etape` a `champ` à `vaut` (ex. corriger si `vert` = false). */
  si?: { etape: string; champ: string; vaut: boolean };
}

export interface PlanChantier {
  titre: string;
  objectif: string;
  depot: RefDepot;
  branche: string;
  brancheBase: string;
  /** Les globs que le chantier a le droit de toucher — réservés ; un recouvrement sérialise. */
  perimetre: string[];
  criteres: string[];
  commandesVerif: string[];
  /** Le chantier écrit une migration : réservation exclusive `MIGRATIONS:<dépôt>`. */
  migrations: boolean;
  services: ServiceChantier[];
  /** Les chantiers (identifiants) qui doivent être TERMINÉS avant celui-ci. */
  dependances: string[];
  budget: BudgetChantier;
  etapes: EtapeChantier[];
  /**
   * O2 (décision 0059 § 5) : les ressources nommées RÉSERVÉES (SCHEMA, CONTRAT, API, DEPENDANCES, GENERES, MODULE:<m>) —
   * posées par un programme. Présentes : réservées au lancement ET vérifiées au diff (une ressource touchée hors liste → rouge).
   */
  ressources?: string[];
  /** O2 : le travailleur voulu (absent : Claude Code cloud). */
  travailleur?: "managed-agents";
}

export const BORNES_CHANTIER = { etapes: 24, perimetre: 20, criteres: 12, commandes: 12, services: 6, tentativesMax: 5 } as const;

export const CLE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const NOM_DEPOT = /^[A-Za-z0-9_.-]{1,100}$/;
export const BRANCHE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,120}$/;

export const chaine = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const objet = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export const liste = (v: unknown, max: number, long = 300): string[] =>
  (Array.isArray(v) ? v : []).map((x) => chaine(x, long)).filter(Boolean).slice(0, max);
export const entierPositif = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
export const montant = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * LE PLAN TYPE — ce que Terra n'a pas à écrire étape par étape : lancer, attendre, vérifier, corriger si rouge,
 * puis pour chaque service (ERP d'abord) déployer, vérifier, rollback si malsain ; enfin le rapport.
 */
export function etapesParDefaut(services: readonly ServiceChantier[], fusion = true): EtapeChantier[] {
  const etapes: EtapeChantier[] = [
    { cle: "lancer", titre: "Lancer Claude Code sur la branche réservée", type: "DEV_LANCER" },
    { cle: "attendre", titre: "Attendre les commits de la session", type: "DEV_ATTENDRE", apres: ["lancer"] },
    { cle: "verifier", titre: "Vérifier périmètre, PR et checks", type: "DEV_VERIFIER", apres: ["attendre"] },
    { cle: "corriger", titre: "Faire corriger jusqu'au vert", type: "DEV_CORRIGER", apres: ["verifier"], si: { etape: "verifier", champ: "vert", vaut: false } },
  ];
  let precedente = "corriger";
  if (fusion) {
    etapes.push({ cle: "fusionner", titre: "Fusionner la PR dans la base (validation)", type: "DEV_FUSIONNER", apres: ["corriger"] });
    precedente = "fusionner";
  }
  const ordonnes = [...services].sort((a, b) => RANG_ROLE[a.role] - RANG_ROLE[b.role]);
  for (const s of ordonnes) {
    const k = s.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    etapes.push(
      { cle: `deployer-${k}`, titre: `Déployer ${s.nom}${s.production ? " (production)" : ""}`, type: "RENDER_DEPLOYER", service: s.id, apres: [precedente] },
      { cle: `sante-${k}`, titre: `Vérifier la santé de ${s.nom}`, type: "RENDER_VERIFIER", service: s.id, apres: [`deployer-${k}`] },
      { cle: `rollback-${k}`, titre: `Rollback de ${s.nom} si malsain`, type: "RENDER_ROLLBACK", service: s.id, apres: [`sante-${k}`], si: { etape: `sante-${k}`, champ: "sain", vaut: false } },
    );
    precedente = `rollback-${k}`;
  }
  etapes.push({ cle: "rapport", titre: "Rapport à la Direction, preuves à l'appui", type: "RAPPORT", apres: [precedente] });
  return etapes;
}

function lireServices(v: unknown, fautes: string[]): ServiceChantier[] {
  const out: ServiceChantier[] = [];
  for (const [i, b] of (Array.isArray(v) ? v : []).slice(0, BORNES_CHANTIER.services).entries()) {
    const s = objet(b);
    const id = chaine(s?.id, 80);
    const role = chaine(s?.role, 10).toLowerCase() as RoleService;
    if (!id) { fautes.push(`Service ${i + 1} : identifiant Render manquant.`); continue; }
    if (!(ROLES_SERVICE as readonly string[]).includes(role)) { fautes.push(`Service « ${id} » : rôle « ${role} » inconnu (${ROLES_SERVICE.join(", ")}).`); continue; }
    if (out.some((x) => x.id === id)) { fautes.push(`Service « ${id} » en double.`); continue; }
    out.push({
      id, nom: chaine(s?.nom, 80) || id, role, production: s?.production === true,
      ...(chaine(s?.branche, 120) ? { branche: chaine(s?.branche, 120) } : {}),
      ...(chaine(s?.url, 300) ? { url: chaine(s?.url, 300) } : {}),
      ...(chaine(s?.healthCheckPath, 200) ? { healthCheckPath: chaine(s?.healthCheckPath, 200) } : {}),
    });
  }
  return out;
}

function lireEtapes(v: unknown, services: ServiceChantier[], fautes: string[]): EtapeChantier[] {
  const vues = new Map<string, EtapeChantier>();
  const ids = new Set(services.map((s) => s.id));
  for (const [i, b] of (Array.isArray(v) ? v : []).slice(0, BORNES_CHANTIER.etapes).entries()) {
    const e = objet(b);
    const cle = chaine(e?.cle, 48).toLowerCase();
    const type = chaine(e?.type, 20).toUpperCase() as TypeEtapeChantier;
    const ou = `Étape ${i + 1} « ${cle || "?"} »`;
    if (!CLE.test(cle) || vues.has(cle)) { fautes.push(`${ou} : clé invalide ou en double.`); continue; }
    if (!(TYPES_ETAPE_CHANTIER as readonly string[]).includes(type)) { fautes.push(`${ou} : type « ${type} » hors catalogue (${TYPES_ETAPE_CHANTIER.join(", ")}).`); continue; }
    const apres = [...new Set(liste(e?.apres, 8, 48).map((x) => x.toLowerCase()))];
    for (const a of apres) if (!vues.has(a)) fautes.push(`${ou} : « apres » désigne « ${a} », qui n'est pas une étape précédente.`);
    const etape: EtapeChantier = { cle, titre: chaine(e?.titre, 160) || cle, type, ...(apres.length ? { apres } : {}) };
    if (ETAPES_SERVICE.has(type)) {
      const service = chaine(e?.service, 80);
      if (!ids.has(service)) fautes.push(`${ou} : service « ${service} » non déclaré dans « services ».`);
      etape.service = service;
    }
    const si = objet(e?.si);
    if (si) {
      const de = chaine(si.etape, 48).toLowerCase();
      if (!vues.has(de)) fautes.push(`${ou} : « si » désigne « ${de} », qui n'est pas une étape précédente.`);
      etape.si = { etape: de, champ: chaine(si.champ, 40) || "vert", vaut: si.vaut === true };
    }
    vues.set(cle, etape);
  }
  return [...vues.values()];
}

/** Les règles d'ENCHAÎNEMENT : ce qui rend un plan dangereux même quand chaque étape est bien formée. */
function controlerEnchainement(etapes: EtapeChantier[], services: ServiceChantier[], fautes: string[]): void {
  const index = new Map(etapes.map((e, i) => [e.cle, i]));
  const premier = (t: TypeEtapeChantier) => etapes.findIndex((e) => e.type === t);
  if (premier("DEV_LANCER") !== 0) fautes.push("La première étape doit être DEV_LANCER (réserver puis lancer).");
  if (etapes.at(-1)?.type !== "RAPPORT") fautes.push("La dernière étape doit être RAPPORT (preuves à l'appui).");
  const verif = premier("DEV_VERIFIER");
  if (verif < 0) fautes.push("Un chantier vérifie ce qu'il livre : une étape DEV_VERIFIER est obligatoire.");
  for (const [i, e] of etapes.entries()) {
    if (e.type === "DEV_CORRIGER" && (verif < 0 || i < verif)) fautes.push(`« ${e.cle} » : DEV_CORRIGER suit une étape DEV_VERIFIER.`);
    if (e.type === "RENDER_DEPLOYER" && (verif < 0 || i < verif)) fautes.push(`« ${e.cle} » : aucun déploiement avant la vérification (DEV_VERIFIER).`);
    if (e.type === "DEV_FUSIONNER" && (verif < 0 || i < verif)) fautes.push(`« ${e.cle} » : DEV_FUSIONNER suit une étape DEV_VERIFIER.`);
    // Un service qui suit une AUTRE branche que celle du chantier (main) ne se déploie qu'après la fusion validée.
    const sv = services.find((x) => x.id === e.service);
    if (e.type === "RENDER_DEPLOYER" && sv?.branche && !etapes.some((x, j) => j < i && x.type === "DEV_FUSIONNER")) {
      fautes.push(`« ${e.cle} » : ${sv.nom} suit ${sv.branche} — une étape DEV_FUSIONNER doit précéder son déploiement.`);
    }
    if ((e.type === "RENDER_VERIFIER" || e.type === "RENDER_ROLLBACK")) {
      const dep = etapes.findIndex((x, j) => j < i && x.type === "RENDER_DEPLOYER" && x.service === e.service);
      if (dep < 0) fautes.push(`« ${e.cle} » : ${e.type} sans déploiement préalable du même service.`);
    }
  }
  // ERP AVANT APP ET WORKER : un déploiement d'app ne précède jamais celui de l'ERP du même plan (migrations).
  const rang = (e: EtapeChantier) => RANG_ROLE[services.find((s) => s.id === e.service)?.role ?? "app"];
  const deploiements = etapes.filter((e) => e.type === "RENDER_DEPLOYER");
  for (const d of deploiements) {
    const avant = deploiements.find((x) => rang(x) < rang(d) && (index.get(x.cle) ?? 0) > (index.get(d.cle) ?? 0));
    if (avant) fautes.push(`« ${d.cle} » : l'ERP (« ${avant.cle} ») se déploie AVANT l'app et le worker.`);
  }
}

/**
 * LIT UN PLAN VENU DE TERRA (outil « lancer un chantier ») — retypé, jamais cru sur parole. Sans `etapes`, le plan
 * type est posé. Rend le plan propre ou ses fautes, en français (le modèle corrige, la carte les affiche).
 */
export function lirePlanChantier(brut: unknown): { ok: true; plan: PlanChantier } | { ok: false; fautes: string[] } {
  const o = objet(brut);
  if (!o) return { ok: false, fautes: ["Le plan doit être un objet { titre, objectif, depot, branche, perimetre, criteres, … }."] };
  const fautes: string[] = [];
  const titre = chaine(o.titre, 120);
  const objectif = chaine(o.objectif, 4000);
  const d = objet(o.depot);
  const depot: RefDepot = { proprietaire: chaine(d?.proprietaire, 100), nom: chaine(d?.nom, 100) };
  const branche = chaine(o.branche, 120);
  const brancheBase = chaine(o.brancheBase, 120) || "main";
  if (!titre) fautes.push("Titre manquant.");
  if (!objectif) fautes.push("Objectif manquant.");
  if (!NOM_DEPOT.test(depot.proprietaire) || !NOM_DEPOT.test(depot.nom)) fautes.push("Dépôt invalide : { proprietaire, nom } (ex. { proprietaire: \"aminedjm\", nom: \"amd-internal-os\" }).");
  if (!BRANCHE.test(branche)) fautes.push(`Branche « ${branche} » invalide.`);
  else if (branche === brancheBase || /^(main|master)$/.test(branche)) fautes.push("Un chantier travaille sur SA branche, jamais sur la branche de base ni sur main.");
  if (!BRANCHE.test(brancheBase)) fautes.push(`Branche de base « ${brancheBase} » invalide.`);
  const perimetre = liste(o.perimetre, BORNES_CHANTIER.perimetre, 200);
  if (perimetre.length === 0) fautes.push("Périmètre vide : déclarez les dossiers ou globs que le chantier touche (ils seront réservés).");
  if (perimetre.some((g) => g.startsWith("/") || g.includes(".."))) fautes.push("Un glob de périmètre est relatif à la racine du dépôt, sans « .. ».");
  const criteres = liste(o.criteres, BORNES_CHANTIER.criteres, 400);
  if (criteres.length === 0) fautes.push("Critères d'acceptation manquants (ce qui prouve que c'est fini).");
  const commandesVerif = liste(o.commandesVerif, BORNES_CHANTIER.commandes, 300);
  const services = lireServices(o.services, fautes);
  const b = objet(o.budget);
  const tentatives = entierPositif(b?.tentatives);
  if (tentatives && tentatives > BORNES_CHANTIER.tentativesMax) fautes.push(`Au plus ${BORNES_CHANTIER.tentativesMax} tentatives par étape.`);
  const budget: BudgetChantier = {
    ...(montant(b?.usd) ? { usd: montant(b?.usd) } : {}),
    ...(entierPositif(b?.lancements) ? { lancements: entierPositif(b?.lancements) } : {}),
    ...(entierPositif(b?.deploiements) ? { deploiements: entierPositif(b?.deploiements) } : {}),
    ...(tentatives ? { tentatives: Math.min(tentatives, BORNES_CHANTIER.tentativesMax) } : {}),
  };
  const etapes = Array.isArray(o.etapes) && o.etapes.length > 0 ? lireEtapes(o.etapes, services, fautes) : etapesParDefaut(services, o.fusion !== false);
  if (etapes.length > 0) controlerEnchainement(etapes, services, fautes);
  const ressources = Array.isArray(o.ressources) ? [...new Set(liste(o.ressources, 12, 80))] : null;
  for (const r of ressources ?? []) if (!ressourceValide(r)) fautes.push(`Ressource « ${r} » inconnue.`);
  if (fautes.length > 0) return { ok: false, fautes };
  return {
    ok: true,
    plan: {
      titre, objectif, depot, branche, brancheBase, perimetre, criteres, commandesVerif,
      migrations: o.migrations === true, services, dependances: liste(o.dependances, 10, 40), budget, etapes,
      ...(ressources ? { ressources } : {}), ...(o.travailleur === "managed-agents" ? { travailleur: "managed-agents" as const } : {}),
    },
  };
}

/** Le plan exige-t-il une carte de validation de la Direction (production, migration) ? Dit sur la carte d'approbation. */
export function gestesCritiques(plan: PlanChantier): string[] {
  const out: string[] = [];
  if (plan.etapes.some((e) => e.type === "DEV_FUSIONNER")) out.push(`Fusionner la PR dans ${plan.brancheBase} (carte écrite ou orale ; compensable par une PR de revert)`);
  for (const s of plan.services.filter((x) => x.production)) {
    out.push(`Déployer ${s.nom} en production`);
  }
  if (plan.services.some((s) => s.production) && plan.etapes.some((e) => e.type === "RENDER_ROLLBACK")) out.push("Rollback de production, si la santé l'exige");
  if (plan.migrations) out.push("Migration de base (additive, idempotente — destructive refusée sans validation)");
  return out;
}

/** LE PLAN APPROUVÉ → LE PROGRAMME DU MOTEUR. Un nœud WORKER par étape ; la condition `si` devient un `when` du moteur. */
/**
 * Chaque étape dépend AUSSI de la première (DEV_LANCER) : un amont abouti donne au nœud de synthèse le droit de
 * partir même quand une étape intermédiaire est morte — et c'est le GESTIONNAIRE qui se garde par les PREUVES
 * (aucun déploiement sans checks verts sur le SHA, aucune santé sans déploiement live). Ainsi le RAPPORT part
 * toujours, et dit honnêtement où le chantier s'est arrêté.
 */
export function compilerChantier(plan: PlanChantier): CompiledMission {
  const premiere = plan.etapes[0]?.cle;
  const steps: CompiledStep[] = plan.etapes.map((e) => {
    const when: StepCondition | null = e.si ? { step: e.si.etape, path: e.si.champ, op: "eq", value: String(e.si.vaut) } : null;
    const amonts = [...(e.apres ?? []), ...(e.si ? [e.si.etape] : []), ...(premiere && premiere !== e.cle ? [premiere] : [])];
    return {
      key: e.cle, title: e.titre, workstream: null, nodeType: "WORKER", capability: null,
      dependsOn: [...new Set(amonts)],
      input: { chantier: e.type, ...(e.service ? { service: e.service } : {}) },
      effect: e.type.startsWith("RENDER_") ? "EXTERNAL_COMMUNICATION" : "PREPARE",
      idempotent: false, needsIdempotencyKey: false, needsApproval: false, modelRole: null, wave: 0,
      // TROIS : la tentative normale, une reprise après coupure, une marge. Les essais MÉTIER (tentatives, délai
      // croissant) se comptent dans la sortie de l'étape, pas ici : un sondage n'use pas les tentatives du moteur.
      maxAttempts: 3, spec: when ? { when } : null, forEach: null, waitFor: null,
    } as CompiledStep;
  });
  // LA VAGUE d'une étape : un de plus que la plus haute de ses amonts (le journal du moteur s'en sert).
  const vagues = new Map<string, number>();
  for (const s of steps) {
    s.wave = s.dependsOn.reduce((haut, d) => Math.max(haut, (vagues.get(d) ?? -1) + 1), 0);
    vagues.set(s.key, s.wave);
  }
  return {
    objective: plan.objectif,
    acceptance: [...plan.criteres, "Checks verts sur le SHA exact livré ; déploiements live et sains, ou rollback dit."],
    complexity: "B", scale: "M", steps,
    maxEffect: "EXTERNAL_COMMUNICATION", requiresApproval: false,
    capabilities: [], depth: 1 + Math.max(0, ...vagues.values()), gaps: [],
    planMeta: { workstreams: [], expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: null },
  };
}
