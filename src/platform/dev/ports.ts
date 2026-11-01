/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PORTS DES CHANTIERS DE DÉVELOPPEMENT (lot C2, architecture `docs/architecture/CHANTIERS-DEV.md`).
 *
 * Trois ports, un par fournisseur, et les faits qu'ils produisent. Le moteur des chantiers (lot C1) code CONTRE ce
 * fichier ; les adaptateurs `fetch` (`agent-routines.ts`, `forge-github.ts`, `hebergeur-render.ts`) le remplissent.
 *
 *   AgentDeveloppeur  Claude Code Cloud — lancer une session (Routines API, abonnement de la Direction), relancer dans
 *                     le fil d'une PR (commentaire `@claude`, GitHub Action). On ne LIT jamais une session : la vérité
 *                     d'un chantier est sur GitHub et Render (§ 1 de l'architecture).
 *   ForgeGit          GitHub REST v3 — branches, commits, comparaisons, PR, checks, journaux de jobs, commentaires.
 *   Hebergeur         Render API v1 — services, déploiements, annulation, rollback, journaux, NOMS des variables,
 *                     `autoDeployTrigger`. La synchro Blueprint ne se déclenche PAS par API (seulement listée).
 *
 * ZÉRO IMPORT : ce fichier est lu partout (moteur, écrans, tests), navigateur compris.
 *
 * Toutes les méthodes rendent un `Resultat<T>` : jamais d'exception pour un refus du fournisseur. Une erreur dit si
 * elle est réessayable et quand (`Retry-After`) — c'est le moteur qui décide d'attendre, pas l'adaptateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── LE COMMUN ───────────────────────────────

export type CodeErreur =
  | "NON_CONFIGURE" // la variable d'environnement manque : rien n'a été tenté
  | "AUTH" // 401 — jeton absent, invalide ou révoqué
  | "INTERDIT" // 403 hors quota — droit insuffisant (jeton fine-grained trop étroit, compte sans accès)
  | "INTROUVABLE" // 404
  | "QUOTA" // 429, ou 403 de quota GitHub (primaire ou secondaire) — `reessayerApresMs` dit quand
  | "INVALIDE" // 400 / 422 — la demande est mal formée ou refusée (routine en pause, texte trop long…)
  | "CONFLIT" // 409 — un déploiement déjà en cours, une branche qui a bougé
  | "INDISPONIBLE" // 5xx — le fournisseur ne répond pas correctement
  | "RESEAU" // la requête n'est PAS partie (DNS, connexion refusée)
  | "INCERTAIN" // la requête a pu partir (délai dépassé, connexion coupée) : ne JAMAIS relancer à l'aveugle
  | "SIMULE" // geste en simulation (J7) : l'écriture a été neutralisée, rien n'est sorti
  | "INCONNU";

export interface ErreurConnecteur {
  code: CodeErreur;
  /** Phrase en français, sans aucun secret (les jetons sont masqués avant de construire ce texte). */
  message: string;
  /** Statut HTTP quand il y en a un. */
  statut?: number;
  /** Vrai si recommencer la MÊME demande plus tard a un sens (quota, panne passagère, réseau avant envoi). */
  reessayable: boolean;
  /** Quand recommencer, d'après `Retry-After` / `x-ratelimit-reset` (millisecondes depuis maintenant). */
  reessayerApresMs?: number;
  /** Identifiant de requête du fournisseur, utile au support (jamais un secret). */
  requeteId?: string;
}

export type Resultat<T> = { ok: true; valeur: T } | { ok: false; erreur: ErreurConnecteur };

/** Un dépôt GitHub, toujours « propriétaire/nom ». */
export type NomDepot = `${string}/${string}`;

/** L'état d'un connecteur, tel que l'écran Administration › Développement l'affiche. Aucune valeur secrète. */
export interface EtatConnecteur {
  connecteur: "claude-code" | "github" | "render" | "mimo";
  configure: boolean;
  /** `null` = non sondé (pas de sonde sans effet documentée, ou non configuré). */
  joignable: boolean | null;
  /** Les NOMS des variables lues (jamais leurs valeurs) et celles qui manquent. */
  variables: { nom: string; posee: boolean }[];
  /** Quotas restants quand le fournisseur les dit (GitHub `x-ratelimit-remaining`, Render `RateLimit-Remaining`) ou
   *  quand Adventum les compte (Routines : 30/h/routine, 100/h/compte). */
  quotas: { libelle: string; restant: number | null; limite: number | null; reinitialiseA?: string | null }[];
  /** Ce que la sonde a vu (compte, dépôts, services, modèles), en lignes courtes. */
  details: string[];
  erreur?: string | null;
}

// ─────────────────────────────── AGENT DÉVELOPPEUR (Claude Code) ───────────────────────────────

/** Les moyens OFFICIELS de faire travailler Claude Code depuis un serveur (décision 0041). */
export type MoyenAgent =
  | "ROUTINE" // Routines API : nouvelle session cloud sur l'abonnement de la Direction
  | "COMMENTAIRE_PR" // commentaire `@claude` sur une PR, traité par la GitHub Action `anthropics/claude-code-action`
  | "MANAGED_AGENTS"; // option API (clé Console, facturation API) — interface seulement, désactivée par défaut

/** Ce qu'Adam demande à Claude Code. Le texte final est construit par `consigne.ts` (borné à 65 536 caractères). */
export interface ConsigneDev {
  depot: NomDepot;
  /** La branche RÉSERVÉE au chantier (C1 : `ChantierReservation`). Claude Code pousse là et nulle part ailleurs. */
  branche: string;
  objectif: string;
  /** Les chemins (globs) que le chantier a le droit de toucher. */
  perimetre: string[];
  criteres: string[];
  /** Les commandes de vérification du dépôt (lues dans CLAUDE.md / package.json, mémoire technique). */
  commandes: string[];
  /** Extraits de mémoire technique, erreur CI résumée… — déjà bornés par l'appelant. */
  contexte?: string | null;
  /** La PR à reprendre, si elle existe déjà. */
  numeroPr?: number | null;
}

export interface DemandeLancement {
  /** L'alias de la routine (`CLAUDE_ROUTINE_<ALIAS>_ID/_TOKEN`), en minuscules ou majuscules. */
  alias: string;
  texte: string;
  /** Clé d'idempotence ADVENTUM (l'API n'en a pas) : la même clé ne lance jamais deux sessions. */
  cleIdempotence: string;
  missionId?: string | null;
}

export interface SessionLancee {
  moyen: MoyenAgent;
  sessionId: string | null;
  sessionUrl: string | null;
  /** Pour un commentaire de PR : son identifiant et son lien. */
  commentaireId?: number | null;
  commentaireUrl?: string | null;
  /** VRAI si la clé avait déjà abouti : rien n'a été relancé, on rend le premier résultat. */
  deja: boolean;
  cleIdempotence: string;
}

export interface DemandeRelancePr {
  depot: NomDepot;
  numeroPr: number;
  /** Le texte SANS la mention : l'adaptateur préfixe `@claude` (déclencheur par défaut de l'Action). */
  texte: string;
  cleIdempotence: string;
  missionId?: string | null;
}

export interface AgentDeveloppeur {
  /** Nouvelle session Claude Code (Routines API). Un délai dépassé rend `INCERTAIN` et la clé reste bloquée. */
  lancer(d: DemandeLancement): Promise<Resultat<SessionLancee>>;
  /** Suivi dans le fil d'une PR : commentaire `@claude` posté avec le jeton GitHub de la Direction (compte humain). */
  relancerDansPr(d: DemandeRelancePr): Promise<Resultat<SessionLancee>>;
  /** Les alias de routine configurés (noms seulement). */
  routines(): string[];
}

// ─────────────────────────────── FORGE GIT (GitHub) ───────────────────────────────

export interface CompteForge { login: string; type: "User" | "Bot" | "Organization" | string; nom: string | null }

export interface InfoDepot { nom: NomDepot; brancheParDefaut: string; prive: boolean; peutPousser: boolean | null; archive: boolean }

export interface Commit { sha: string; message: string; auteur: string | null; date: string | null; url: string | null }

export interface Comparaison {
  statut: "ahead" | "behind" | "identical" | "diverged" | string;
  enAvance: number;
  enRetard: number;
  commits: Commit[];
  fichiers: { chemin: string; statut: string; ajouts: number; suppressions: number }[];
}

export interface PullRequest {
  numero: number;
  titre: string;
  etat: "open" | "closed";
  fusionnee: boolean;
  brouillon: boolean;
  /** `null` = GitHub n'a pas encore calculé (il faut relire). */
  fusionnable: boolean | null;
  etatFusion: string | null;
  branche: string;
  base: string;
  shaTete: string;
  url: string;
  auteur: string | null;
}

export type ConclusionCheck = "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | null;

export interface CheckRun {
  id: number;
  nom: string;
  statut: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending" | string;
  conclusion: ConclusionCheck;
  url: string | null;
  /** Le job GitHub Actions derrière, quand c'en est un (pour lire son journal). */
  jobId: number | null;
}

/** Le verdict déterministe sur un SHA : tous terminés et verts, ou ce qui manque. */
export interface EtatChecks {
  sha: string;
  global: "VERT" | "ROUGE" | "EN_COURS" | "AUCUN";
  runs: CheckRun[];
  /** Les runs en échec (conclusion failure, timed_out, cancelled, action_required). */
  echecs: CheckRun[];
}

export interface ForgeGit {
  moi(): Promise<Resultat<CompteForge>>;
  depot(depot: NomDepot): Promise<Resultat<InfoDepot>>;
  /** Le SHA de tête d'une branche ; `null` si elle n'existe pas (404 n'est pas une erreur ici). */
  teteDeBranche(depot: NomDepot, branche: string): Promise<Resultat<string | null>>;
  commits(depot: NomDepot, opts: { branche: string; depuis?: string | null; limite?: number }): Promise<Resultat<Commit[]>>;
  comparer(depot: NomDepot, base: string, tete: string): Promise<Resultat<Comparaison>>;
  /** La PR ouverte (ou la plus récente) dont la tête est cette branche. */
  prDeBranche(depot: NomDepot, branche: string): Promise<Resultat<PullRequest | null>>;
  pr(depot: NomDepot, numero: number): Promise<Resultat<PullRequest>>;
  checks(depot: NomDepot, sha: string): Promise<Resultat<EtatChecks>>;
  /** Le journal brut d'un job Actions, tronqué à `maxOctets` (la fin, là où est l'erreur). */
  journalDeJob(depot: NomDepot, jobId: number, maxOctets?: number): Promise<Resultat<string>>;
  commenterPr(depot: NomDepot, numero: number, texte: string): Promise<Resultat<{ id: number; url: string }>>;
  /** Relance les jobs en échec d'un run Actions (geste autonome autorisé, § 7). */
  relancerEchecs(depot: NomDepot, runId: number): Promise<Resultat<true>>;
}

// ─────────────────────────────── HÉBERGEUR (Render) ───────────────────────────────

export type StatutDeploiement =
  | "created" | "queued" | "build_in_progress" | "update_in_progress" | "live" | "deactivated"
  | "build_failed" | "update_failed" | "canceled" | "pre_deploy_in_progress" | "pre_deploy_failed";

export const STATUTS_DEPLOIEMENT_FINAUX: readonly StatutDeploiement[] = ["live", "deactivated", "build_failed", "update_failed", "canceled", "pre_deploy_failed"];
export const STATUTS_DEPLOIEMENT_ECHEC: readonly StatutDeploiement[] = ["build_failed", "update_failed", "canceled", "pre_deploy_failed"];

export type DeclencheurAutoDeploy = "commit" | "checksPass" | "off";

export interface ServiceHeberge {
  id: string;
  nom: string;
  type: string;
  depot: string | null;
  branche: string | null;
  autoDeploy: DeclencheurAutoDeploy | null;
  suspendu: boolean;
  url: string | null;
  tableauDeBord: string | null;
  proprietaireId: string | null;
  cheminSante: string | null;
}

export interface Deploiement {
  id: string;
  statut: StatutDeploiement | string;
  sha: string | null;
  messageCommit: string | null;
  declencheur: string | null;
  creeLe: string | null;
  termineLe: string | null;
}

export interface LigneJournal { id: string; date: string; message: string; niveau: string | null; type: string | null }

export interface PageJournal { lignes: LigneJournal[]; encore: boolean; suivantDebut: string | null; suivantFin: string | null }

export interface Hebergeur {
  services(): Promise<Resultat<ServiceHeberge[]>>;
  service(serviceId: string): Promise<Resultat<ServiceHeberge>>;
  deploiements(serviceId: string, opts?: { limite?: number }): Promise<Resultat<Deploiement[]>>;
  deploiement(serviceId: string, deployId: string): Promise<Resultat<Deploiement>>;
  /** Déclenche un déploiement (un commit donné, sinon la tête de la branche liée). 202 « en file » → `null`. */
  deployer(serviceId: string, opts?: { commitId?: string | null; viderCache?: boolean }): Promise<Resultat<Deploiement | null>>;
  annuler(serviceId: string, deployId: string): Promise<Resultat<Deploiement>>;
  /** `POST /services/{id}/rollback {deployId}` — ne coupe PAS l'auto-déploiement : `reglerAutoDeploy(…, "off")` à part. */
  rollback(serviceId: string, deployId: string): Promise<Resultat<Deploiement>>;
  /** `GET /logs` (le propriétaire est exigé par l'API). */
  journaux(opts: { proprietaireId: string; serviceId: string; debut?: string | null; fin?: string | null; niveaux?: string[]; texte?: string[]; limite?: number }): Promise<Resultat<PageJournal>>;
  /** Les NOMS des variables d'environnement — la valeur n'est jamais lue hors de l'adaptateur, jamais rendue. */
  nomsDesVariables(serviceId: string): Promise<Resultat<string[]>>;
  reglerAutoDeploy(serviceId: string, declencheur: DeclencheurAutoDeploy): Promise<Resultat<ServiceHeberge>>;
}

// ─────────────────────────────── LES FAITS (webhooks et sondage) ───────────────────────────────

/** Les types de `BusinessEvent` produits par les connecteurs (catalogue `lib/events/catalogue.ts`). */
export const TYPES_FAITS_DEV = [
  "DEV_PUSH", // un push sur une branche (webhook `push`, ou sondage de la tête)
  "DEV_PR", // une PR ouverte, mise à jour, fermée, fusionnée
  "DEV_CHECKS", // une suite de checks / un check terminé sur un SHA
  "DEV_WORKFLOW", // un run GitHub Actions terminé
  "DEV_COMMENTAIRE", // un commentaire sur une PR / issue (réponse de Claude Code)
  "RENDER_DEPLOIEMENT", // un déploiement Render terminé (ou commencé)
  "RENDER_SERVICE", // un service Render tombé / revenu
] as const;
export type TypeFaitDev = (typeof TYPES_FAITS_DEV)[number];

/** UN fait normalisé, quelle que soit sa source (webhook GitHub, webhook Render, sondage). */
export interface FaitDev {
  type: TypeFaitDev;
  fournisseur: "github" | "render";
  /** La clé SÉMANTIQUE du fait : identique qu'il arrive par webhook ou par sondage → un seul `BusinessEvent`. */
  cle: string;
  /** Le nom brut du fournisseur (`push`, `check_suite.completed`, `deploy_ended`…). */
  brut: string;
  depot: NomDepot | null;
  branche: string | null;
  sha: string | null;
  numeroPr: number | null;
  serviceId: string | null;
  deployId: string | null;
  /** `success`, `failure`, `succeeded`, `failed`, `opened`, `merged`… selon le fait. */
  statut: string | null;
  auteur: string | null;
  url: string | null;
  survenuLe: string | null;
}

/** Le pas croissant du sondage de secours quand un webhook manque (millisecondes). */
export interface PasDeSondage { premierMs: number; facteur: number; maxMs: number }
