/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE RUNTIME DOIT SAVOIR D'UNE CAPACITÉ — au-delà de son schéma d'entrée.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────────────────
 *
 * Un outil déclare aujourd'hui son nom, sa description, son schéma et son droit d'accès. C'est
 * assez pour qu'un modèle l'appelle dans une conversation. Ce n'est pas assez pour qu'un MOTEUR
 * le planifie : celui-ci doit savoir, sans demander à personne, si l'appel écrit ou lit, s'il
 * peut être rejoué sans dommage, s'il se groupe, s'il exige une confirmation, et combien de
 * temps il prend.
 *
 * ── POURQUOI PAS UNE RÉÉCRITURE DES 165 OUTILS ──────────────────────────────────────────
 *
 * Parce qu'une métadonnée recopiée à la main 165 fois est une métadonnée fausse à 160
 * endroits six mois plus tard. Le registre procède donc en trois temps :
 *
 *   1. ce qu'une capacité DÉCLARE explicitement fait foi ;
 *   2. à défaut, on DÉRIVE des sources de vérité qui existent déjà — la liste des écritures du
 *      résolveur, le registre d'actions natives, la politique de confirmation ;
 *   3. et si rien ne dit, le défaut est le plus PRUDENT possible : effet inconnu ⇒ traité comme
 *      une écriture externe, donc non rejouable et sous confirmation.
 *
 * Le défaut prudent est le point important. Un outil ajouté demain par quelqu'un qui n'a pas lu
 * ce fichier ne devient pas automatiquement rejouable en masse sans confirmation — il devient
 * inutilisable en masse tant que personne ne l'a qualifié, ce qui est le bon sens inverse.
 *
 * ── §8 : AJOUTER UN DOMAINE DOIT AUGMENTER ADAM ─────────────────────────────────────────
 *
 * Un nouveau domaine publie ses capacités avec leurs métadonnées. Le planner les voit, le
 * compiler les valide, le moteur les exécute. Aucun paragraphe n'est ajouté au prompt d'Adam.
 * C'est l'invariant que ce fichier existe pour rendre vrai.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Contrat } from "@/lib/missions/registry/result-contract";

/**
 * L'EFFET D'UNE CAPACITÉ — la seule métadonnée dont tout le reste découle.
 *
 * L'ordre est celui de la gravité croissante, et il est utilisé : une mission dont l'effet
 * maximal est `READ` n'a besoin d'aucune approbation, une mission qui atteint
 * `EXTERNAL_COMMUNICATION` en demande une.
 */
export const EFFECTS = [
  "READ",
  "ANALYZE",
  "PREPARE",
  "INTERNAL_REVERSIBLE_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_COMMITMENT",
  "HR_SENSITIVE",
  "DESTRUCTIVE",
  "SECURITY_ADMIN",
] as const;
export type Effect = (typeof EFFECTS)[number];

/** La gravité, pour comparer deux effets. Plus haut = plus irréversible. */
export const EFFECT_RANK: Record<Effect, number> = {
  READ: 0,
  ANALYZE: 1,
  PREPARE: 2,
  INTERNAL_REVERSIBLE_WRITE: 3,
  EXTERNAL_COMMUNICATION: 4,
  FINANCIAL_COMMITMENT: 5,
  HR_SENSITIVE: 6,
  DESTRUCTIVE: 7,
  SECURITY_ADMIN: 8,
};

/** L'ordre de grandeur de la latence — sert au pool, pas à l'affichage. */
export type LatencyClass = "LOW" | "MEDIUM" | "HIGH";

/**
 * LES SIX PRIMITIVES (mandat 5 §34) — « primitives > features ». Une capacité EST d'abord l'une
 * de ces six choses ; c'est à ce niveau que le planificateur compose, et c'est ce qui rend une
 * demande jamais vue planifiable : il ne cherche pas la fonctionnalité qui porte le nom de la
 * demande, il assemble information + calcul + document + représentation + action + orchestration.
 */
export const PRIMITIVES = ["INFORMATION", "CALCUL", "DOCUMENT", "REPRESENTATION", "ACTION", "ORCHESTRATION"] as const;
export type Primitive = (typeof PRIMITIVES)[number];

/** La primitive d'une capacité, déduite de son nom et de son effet — jamais « autre ». */
export function primitiveDeduite(name: string, effect: Effect): Primitive {
  const n = name.toLowerCase();
  if (/mission|watch|schedule|planifi|orchestr|delegate|consult_specialists|workflow/.test(n)) return "ORCHESTRATION";
  if (/chart|graph|visual|dashboard|render|show_|display|timeline/.test(n)) return "REPRESENTATION";
  if (/run_code|run_analysis|sql_query|calcul|compute|simulat|forecast|statist|product_economics|_intelligence$|business_story|totals?/.test(n)) return "CALCUL";
  if (/report|export|docx|pptx|xlsx|pdf|document_profile|create_document|generate_|draft|deliverable|office_|edit_document|artifact/.test(n)) return "DOCUMENT";
  if (EFFECT_RANK[effect] >= EFFECT_RANK.PREPARE) return "ACTION";
  return "INFORMATION";
}

export interface CapabilityMeta {
  id: string;
  domain: string;
  effect: Effect;
  /**
   * PEUT-ON LA REJOUER SANS DOMMAGE ?
   *
   * Attention au sens exact : `idempotent: true` signifie que DEUX appels identiques
   * produisent le même état final — pas qu'ils sont gratuits. Une lecture l'est toujours ; un
   * envoi d'e-mail ne l'est JAMAIS par lui-même, il le devient par la clé d'idempotence que le
   * moteur pose autour de lui.
   */
  idempotent: boolean;
  /** Peut-on la déployer en éventail sur une collection ? */
  batchable: boolean;
  latency: LatencyClass;
  /** POLICY_ENGINE = c'est la politique qui tranche ; ALWAYS = toujours ; NEVER = jamais. */
  confirmation: "POLICY_ENGINE" | "ALWAYS" | "NEVER";
  /**
   * CE QU'ELLE PROMET DE RENDRE — et donc ce qui distingue « l'appel a réussi » de « elle a
   * répondu ». Voir `result-contract.ts` : sans contrat déclaré (`LIBRE`), rien n'est vérifié,
   * et une capacité peut rendre « Pièce introuvable » en passant pour un succès.
   *
   * Le défaut est `LIBRE` et non un contrat prudent : ici, se tromper ne peut que faire ÉCHOUER
   * une mission valide. L'ignorance choisit, comme partout, le côté qui ne ment pas.
   */
  contrat: Contrat;
  /** Vrai quand la métadonnée a été DÉCLARÉE ; faux quand elle a été dérivée ou devinée. */
  declared: boolean;
  /** L'une des six primitives (§34) — le niveau où le planificateur compose. */
  primitive: Primitive;
}

/**
 * LES CAPACITÉS DÉCLARÉES.
 *
 * On ne déclare pas les 165 outils : on déclare celles que le runtime dispatche réellement,
 * plus celles dont le défaut prudent serait faux au point de gêner (les grandes lectures).
 * Le reste est dérivé, et le test d'architecture exige qu'une capacité UTILISÉE par une
 * mission soit déclarée — c'est là que la rigueur est nécessaire, pas partout.
 */
export const DECLARED: Record<string, Omit<CapabilityMeta, "id" | "declared" | "contrat" | "primitive"> & { contrat?: Contrat }> = {
  // ─────────── Lectures canoniques ───────────
  /**
   * ── LES CONTRATS DÉCLARÉS ICI ONT TOUS ÉTÉ LUS DANS LE CODE DE L'OUTIL ─────────────────
   *
   * Pas déduits d'un nom, pas supposés d'une famille : le fichier de l'outil a été ouvert et sa
   * forme de sortie vérifiée sur les DEUX chemins — celui qui trouve et celui qui ne trouve
   * rien. C'est la seule façon d'ajouter un contrôle sans fabriquer des échecs.
   *
   * Les autres capacités restent `LIBRE` jusqu'à ce que quelqu'un fasse la même vérification.
   * Une liste courte et vraie vaut mieux qu'une liste complète et fausse.
   */
  directory_lookup: { domain: "directory", effect: "READ", idempotent: true, batchable: true, latency: "LOW", confirmation: "NEVER", contrat: "COLLECTION" },
  directory_list: { domain: "directory", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  inspect_record: { domain: "platform", effect: "READ", idempotent: true, batchable: true, latency: "LOW", confirmation: "NEVER" },
  search_everything: { domain: "platform", effect: "READ", idempotent: true, batchable: false, latency: "MEDIUM", confirmation: "NEVER" },
  read_hr_overview: { domain: "hr", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  employee_360: { domain: "hr", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  product_economics: { domain: "regulatory", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  pch_market_status: { domain: "pch", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  business_story: { domain: "pch", effect: "READ", idempotent: true, batchable: true, latency: "HIGH", confirmation: "NEVER" },
  regulatory_portfolio: { domain: "regulatory", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  read_finances: { domain: "finance", effect: "READ", idempotent: true, batchable: false, latency: "MEDIUM", confirmation: "NEVER" },
  gmail_search: { domain: "mail", effect: "READ", idempotent: true, batchable: false, latency: "MEDIUM", confirmation: "NEVER" },
  read_calendar: { domain: "calendar", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  list_pending_decisions: { domain: "tasks", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER", contrat: "COLLECTION" },
  /**
   * LA RECHERCHE WEB (`web-research.ts`) — une LECTURE, mais de l'EXTÉRIEUR. Idempotente et
   * groupable (dix requêtes en éventail pour une veille), lente (le fournisseur cherche et
   * lit), jamais sous confirmation : elle n'écrit rien et n'engage rien. Son coût, lui, est
   * compté à la recherche (usage.webSearchCalls) et plafonné par le budget de mission.
   */
  web_research: { domain: "web", effect: "READ", idempotent: true, batchable: true, latency: "HIGH", confirmation: "NEVER" },

  // ─────────── Communications et écritures ───────────
  //
  // ── CES NOMS SONT CEUX DU REGISTRE RÉEL, ET C'EST UNE CORRECTION ───────────────────────
  //
  // La première version de cette table nommait `prepare_mail`, `send_erp_message`,
  // `notify_person` et `create_task_request` : des noms PLAUSIBLES, écrits d'après l'intention,
  // et qui n'existaient nulle part. Rien ne tombait — `capabilityMeta` dérive prudemment un nom
  // inconnu — mais la dérivation prudente rend `batchable: false`, ce qui aurait fait REFUSER
  // par le compilateur le déploiement en éventail de la mission la plus banale du produit
  // (« écris à chaque salarié »), avec un message parlant d'une capacité qui n'existe pas.
  //
  // `catalog.test.ts` interdit désormais qu'une capacité déclarée ici n'ait pas d'outil réel.
  //
  // `idempotent: false` est la VÉRITÉ de ces outils : rappeler `send_message` deux fois envoie
  // deux messages. C'est le MOTEUR qui rend l'ÉTAPE idempotente, en posant une clé unique autour
  // de l'appel. Confondre les deux ferait croire qu'un rejeu est sans danger.
  // UNE FICHE : l'intent préparé (`intentId`, destinataires, objet). Mesuré sur le banc : « le compte
  // Google n'est pas connecté » revenait en PHRASE, l'étape passait DONE, et seul le juge final
  // relevait la contradiction — après dix étapes. Sous contrat, la phrase est un échec ICI.
  gmail_prepare_mail: { domain: "mail", effect: "PREPARE", idempotent: false, batchable: true, latency: "MEDIUM", confirmation: "NEVER", contrat: "FICHE" },
  send_email: { domain: "mail", effect: "EXTERNAL_COMMUNICATION", idempotent: false, batchable: true, latency: "MEDIUM", confirmation: "POLICY_ENGINE" },
  send_message: { domain: "messaging", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "POLICY_ENGINE" },
  create_task: { domain: "tasks", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "POLICY_ENGINE" },
  create_admin_request: { domain: "tasks", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "POLICY_ENGINE" },
  create_calendar_event: { domain: "calendar", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "POLICY_ENGINE" },
  /**
   * ── LES ÉCRITURES AUTONOMES DÉCLARÉES — répétables, et SANS accord ───────────────────
   *
   * Elles ne figuraient qu'au tableau `AUTONOMES` (l'effet seul) : la dérivation prudente les
   * rendait `batchable: false` et `confirmation: POLICY_ENGINE`. Deux défauts MESURÉS sur le
   * banc de missions inédites : « un rappel par échéance critique » refusé NOT_BATCHABLE, et
   * « surveille cet appel d'offres » qui demandait un ACCORD au dirigeant pour poser la
   * surveillance qu'il venait de demander — puis le notifiait d'être « partiellement faite ».
   *
   * La conversation exécute ces capacités sans carte de confirmation ; §7 dit « même politique
   * de confirmation que l'écran », et « un accord, pas 99 confirmations » (§8) interdit de
   * demander l'accord pour un export ou un rappel. Elles restent des écritures : clé
   * d'idempotence, reçu, non-rejeu après panne (autonomous-dedup.test.ts).
   */
  plan_reminder: { domain: "tasks", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  cancel_reminder: { domain: "tasks", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  snooze_reminder: { domain: "tasks", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  remember: { domain: "memory", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  record_decision: { domain: "governance", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  record_commitment: { domain: "governance", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  close_commitment: { domain: "governance", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  export_excel: { domain: "drive", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  // LA FABRIQUE DE DOCUMENTS. `document_build` : une pièce du registre Legal + un fichier du Drive
  // par appel ; rejouable (même contenu → même pièce, reconnue par empreinte), groupable (25 bons
  // de commande = 25 appels d'un éventail), sous la politique de confirmation — une facture émise
  // au nom de la société n'est pas un rappel. `dossier_build` : trois fichiers du Drive personnel.
  document_build: { domain: "legal", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "POLICY_ENGINE" },
  document_profile: { domain: "legal", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: true, batchable: false, latency: "LOW", confirmation: "POLICY_ENGINE" },
  dossier_build: { domain: "drive", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: false, latency: "HIGH", confirmation: "NEVER" },
  // TEACH ADAM : des écritures internes, réversibles (désactiver, supprimer = un statut), jamais
  // groupées — une règle s'enseigne une par une. L'AGENT n'y a pas droit (policy/guard.ts) : une
  // règle est une attestation d'une personne.
  teach_adam: { domain: "adam", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: false, latency: "LOW", confirmation: "NEVER" },
  list_rules: { domain: "adam", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  update_rule: { domain: "adam", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: false, latency: "LOW", confirmation: "NEVER" },
  disable_rule: { domain: "adam", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  delete_rule: { domain: "adam", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER" },
  gdrive_put_internal_file: { domain: "drive", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "MEDIUM", confirmation: "NEVER" },
  watch_entity: { domain: "missions", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  stop_watch: { domain: "missions", effect: "INTERNAL_REVERSIBLE_WRITE", idempotent: false, batchable: true, latency: "LOW", confirmation: "NEVER" },
  search_people: { domain: "directory", effect: "READ", idempotent: true, batchable: true, latency: "LOW", confirmation: "NEVER", contrat: "COLLECTION" },
  search_drive: { domain: "drive", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER", contrat: "COLLECTION" },
  read_document: { domain: "drive", effect: "READ", idempotent: true, batchable: true, latency: "MEDIUM", confirmation: "NEVER", contrat: "CONTENU" },
  create_report: { domain: "office", effect: "PREPARE", idempotent: false, batchable: false, latency: "HIGH", confirmation: "NEVER" },
  list_artifacts: { domain: "office", effect: "READ", idempotent: true, batchable: false, latency: "LOW", confirmation: "NEVER", contrat: "COLLECTION" },
};

/**
 * LES ÉCRITURES CONNUES, PAR PRÉFIXE.
 *
 * Une dérivation grossière mais HONNÊTE : elle classe du côté prudent. `delete_*` est
 * destructif, `send_*` communique, `create_*` / `update_*` écrivent. Elle n'est utilisée que
 * lorsque rien n'a été déclaré, et elle ne peut que RENFORCER la garde, jamais l'affaiblir.
 */
/**
 * LE DOMAINE D'UNE CAPACITÉ NON DÉCLARÉE, DÉDUIT DE SON NOM.
 *
 * ── POURQUOI « inconnu » NE POUVAIT PAS RESTER ──────────────────────────────────────────
 *
 * Le résolveur (§3) sélectionne les capacités en TOURNIQUET entre domaines, pour garantir qu'un
 * domaine pertinent soit représenté. Tant que les cent quarante capacités non déclarées
 * partageaient le domaine « inconnu », ce domaine unique raflait une part entière du tourniquet
 * et y déversait n'importe quoi — `update_hospital` et `update_salary` se retrouvaient devant le
 * planner d'une mission de messagerie.
 *
 * La déduction ci-dessous est grossière et le restera : elle sert à REGROUPER, pas à décider.
 * Aucune garde ne s'appuie dessus — l'effet, lui, continue d'être dérivé prudemment.
 */
export function domaineDeduit(name: string): string {
  const n = name.toLowerCase();
  const table: [RegExp, string][] = [
    [/mail|email|gmail|courriel/, "mail"],
    [/message|messaging|notification|notify/, "messaging"],
    [/drive|document|file|folder|piece/, "drive"],
    [/employee|employe|hr|rh|salary|salaire|paie|payroll|conge|leave|recruit/, "hr"],
    [/task|tache|request|demande|todo|reminder|rappel|workflow|validation/, "tasks"],
    [/regulatory|dossier|ctd|anpp|product|produit|molecule/, "regulatory"],
    [/pch|tender|marche|hospital|hopital|stock/, "pch"],
    [/finance|payment|paiement|invoice|facture|budget|treasury|tresorerie|expense/, "finance"],
    [/legal|contract|contrat|courrier/, "legal"],
    [/calendar|agenda|meeting|reunion|slot/, "calendar"],
    [/directory|annuaire|person|people|contact|medecin|doctor/, "directory"],
    [/promo|adpro|ad_pro|event|sponsor|congress/, "adpro"],
    [/report|export|excel|docx|pptx|pdf|deliverable|livrable/, "office"],
    [/account|user|role|permission|admin|setting|parametre/, "platform"],
    [/search|inspect|find|read|list|show/, "platform"],
  ];
  for (const [motif, domaine] of table) if (motif.test(n)) return domaine;
  return "autre";
}

const PREFIXES: { test: (n: string) => boolean; effect: Effect }[] = [
  { test: (n) => n.startsWith("delete_") || n.includes("_delete") || n.startsWith("purge_"), effect: "DESTRUCTIVE" },
  { test: (n) => n.startsWith("send_") || n.startsWith("email_") || n.startsWith("mail_"), effect: "EXTERNAL_COMMUNICATION" },
  { test: (n) => n.includes("permission") || n.includes("role") || n.includes("account"), effect: "SECURITY_ADMIN" },
  { test: (n) => n.includes("salary") || n.includes("paie") || n.includes("payroll") || n.includes("contract"), effect: "HR_SENSITIVE" },
  { test: (n) => n.includes("payment") || n.includes("invoice") || n.includes("facture"), effect: "FINANCIAL_COMMITMENT" },
  { test: (n) => n.startsWith("prepare_") || n.startsWith("draft_"), effect: "PREPARE" },
  { test: (n) => n.startsWith("read_") || n.startsWith("list_") || n.startsWith("get_") || n.startsWith("search_") || n.startsWith("inspect_"), effect: "READ" },
];

/**
 * LA MÉTADONNÉE D'UNE CAPACITÉ — déclarée, dérivée, ou prudente.
 *
 * `estEcriture` vient de l'appelant : c'est la liste que le résolveur d'outils tient déjà
 * (`RESOLVER_WRITE_NAMES`). On la CONSULTE plutôt que de la recopier — deux listes d'écritures
 * divergent, et celle qui diverge est toujours celle qui gardait.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCRITURES AUTONOMES — ce que la conversation fait SANS carte de confirmation.
 *
 * Un rappel, un souvenir, une décision consignée, un engagement noté, un fichier déposé dans le
 * Drive interne, un export Excel : la conversation les exécute par le chemin des lectures
 * (`executeReadTool`), sans intent, parce qu'ils sont internes et réversibles. Mais ils LAISSENT
 * UNE TRACE — deux rappels valent une erreur, pas un rappel plus sûr.
 *
 * Le Mission Runtime doit donc les connaître pour deux raisons contraires : les exécuter par le
 * même chemin que la conversation (le chemin des intents ne les connaît pas), ET ne jamais les
 * rejouer sans garde (la reprise après panne rejoue les étapes sans reçu). Ce tableau les nomme ;
 * l'exécutant s'en sert pour poser une garde d'idempotence sur le chemin des lectures.
 *
 * Mesuré avant ce tableau : 62 des 107 capacités « non écriture » du catalogue partaient en
 * EXTERNAL_COMMUNICATION par défaut prudent — `resolve_person`, `find_documents`, `product_360`,
 * `what_changed`… — donc une approbation SENSITIVE demandée pour une lecture, puis
 * « Action non prise en charge » sur le chemin des intents. La première mission inédite du banc
 * s'est bloquée exactement là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const AUTONOMES: Record<string, Effect> = {
  plan_reminder: "INTERNAL_REVERSIBLE_WRITE",
  // Les gestes sur les micro-outils (§36) : une ligne en base, réversible ; promouvoir et jeter sont
  // en plus interdits à l'agent (`policy/guard.ts`).
  create_skill: "INTERNAL_REVERSIBLE_WRITE",
  promote_skill: "INTERNAL_REVERSIBLE_WRITE",
  drop_skill: "INTERNAL_REVERSIBLE_WRITE",
  // Le rattachement d'un fait externe (§37) : une ligne du registre complétée, réversible ; interdit à l'agent (`policy/guard.ts`).
  attach_inbound_event: "INTERNAL_REVERSIBLE_WRITE",
  cancel_reminder: "INTERNAL_REVERSIBLE_WRITE",
  snooze_reminder: "INTERNAL_REVERSIBLE_WRITE",
  remember: "INTERNAL_REVERSIBLE_WRITE",
  forget_memory: "INTERNAL_REVERSIBLE_WRITE",
  record_decision: "INTERNAL_REVERSIBLE_WRITE",
  update_decision_outcome: "INTERNAL_REVERSIBLE_WRITE",
  record_commitment: "INTERNAL_REVERSIBLE_WRITE",
  close_commitment: "INTERNAL_REVERSIBLE_WRITE",
  gmail_organize: "INTERNAL_REVERSIBLE_WRITE",
  gdrive_put_internal_file: "INTERNAL_REVERSIBLE_WRITE",
  gworkspace_create: "INTERNAL_REVERSIBLE_WRITE",
  gdoc_read_or_append: "INTERNAL_REVERSIBLE_WRITE",
  export_excel: "INTERNAL_REVERSIBLE_WRITE",
  artifact_edit: "INTERNAL_REVERSIBLE_WRITE",
  artifact_control: "INTERNAL_REVERSIBLE_WRITE",
  // Un classeur VÉRIFIÉ construit dans le Drive personnel : un fichier de plus, supprimable.
  sheet_build: "INTERNAL_REVERSIBLE_WRITE",
  deck_build: "INTERNAL_REVERSIBLE_WRITE",
  // La fabrique : pièces émises au registre Legal (rejouables par empreinte) et dossiers à trois formats.
  document_build: "INTERNAL_REVERSIBLE_WRITE",
  document_profile: "INTERNAL_REVERSIBLE_WRITE",
  dossier_build: "INTERNAL_REVERSIBLE_WRITE",
  teach_adam: "INTERNAL_REVERSIBLE_WRITE",
  update_rule: "INTERNAL_REVERSIBLE_WRITE",
  disable_rule: "INTERNAL_REVERSIBLE_WRITE",
  delete_rule: "INTERNAL_REVERSIBLE_WRITE",
  mission_create: "INTERNAL_REVERSIBLE_WRITE",
  run_mission: "INTERNAL_REVERSIBLE_WRITE",
  mission_consolidate: "INTERNAL_REVERSIBLE_WRITE",
  // La conduite d'une mission par l'agent est déjà refusée à la compilation (policy/guard.ts) ;
  // l'effet ne fait que dire ce que c'est si quelqu'un la rencontre ailleurs.
  mission_control: "INTERNAL_REVERSIBLE_WRITE",
  // Les surveillances durables : créer / arrêter sont des écritures internes, réversibles, sans carte.
  watch_entity: "INTERNAL_REVERSIBLE_WRITE",
  stop_watch: "INTERNAL_REVERSIBLE_WRITE",
};

/** Une écriture autonome : exécutée par le chemin des lectures, gardée par une clé d'idempotence. */
export const estAutonome = (name: string): boolean => Object.prototype.hasOwnProperty.call(AUTONOMES, name);

/**
 * LA MÉTA DÉCLARÉE PAR UN SKILL (§36) — ce que le registre apprend d'un connecteur, d'un micro-outil ou
 * d'un playbook sans le connaître par son nom. Le pont des skills la pose au chargement ; ici on ne
 * fait que la servir, avant toute dérivation par préfixe : un manifeste qui dit « FINANCIAL_COMMITMENT »
 * ne sera jamais pris pour une lecture parce que son nom commence par « lire_ ».
 */
const DYNAMIQUES = new Map<string, CapabilityMeta>();
export function declarerMetaDynamique(name: string, meta: Omit<CapabilityMeta, "id" | "declared">): void {
  DYNAMIQUES.set(name, { id: name, declared: true, ...meta });
}

export function capabilityMeta(name: string, estEcriture?: (n: string) => boolean): CapabilityMeta {
  const dyn = DYNAMIQUES.get(name);
  if (dyn) return dyn;
  const declared = Object.prototype.hasOwnProperty.call(DECLARED, name) ? DECLARED[name] : null;
  // L'ORDRE DU SPREAD COMPTE : `contrat` vient APRÈS, sinon un `contrat: undefined` absent de la
  // déclaration écraserait le défaut et rendrait le champ non défini là où le type promet une
  // valeur. Le genre d'inversion qui ne casse rien au typecheck et tout à l'exécution.
  if (declared) return { id: name, declared: true, ...declared, contrat: declared.contrat ?? "LIBRE", primitive: primitiveDeduite(name, declared.effect) };

  // Dérivation. L'ordre compte : la liste d'écritures du résolveur l'emporte sur le préfixe,
  // parce qu'elle est tenue par le code qui exécute, et non par une convention de nommage.
  const ecrit = estEcriture?.(name);
  const parPrefixe = PREFIXES.find((p) => p.test(name))?.effect;
  let effect: Effect;
  if (ecrit === true) {
    effect = parPrefixe && EFFECT_RANK[parPrefixe] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE
      ? parPrefixe
      : "INTERNAL_REVERSIBLE_WRITE";
  } else if (ecrit === false) {
    // LA LISTE DES ÉCRITURES FAIT FOI DANS LES DEUX SENS. Elle est tenue par le code qui exécute :
    // ce qui n'y est pas part par le chemin des lectures en conversation. Une écriture autonome
    // garde son effet d'écriture (approbation, non-rejeu) ; un nom de sécurité garde le sien
    // (le garde-fou de compilation en dépend) ; tout le reste est une LECTURE — pas une
    // communication externe imaginaire qui réclame un accord puis échoue.
    effect = AUTONOMES[name]
      ?? (parPrefixe === "SECURITY_ADMIN" ? "SECURITY_ADMIN"
        : parPrefixe && EFFECT_RANK[parPrefixe] <= EFFECT_RANK.PREPARE ? parPrefixe
        : "READ");
  } else {
    // PAS DE LISTE ET AUCUN PRÉFIXE RECONNU ⇒ on ne sait pas. Le défaut prudent est
    // `EXTERNAL_COMMUNICATION` : non rejouable, sous confirmation, non groupable. Une capacité
    // inconnue ne part donc jamais en masse sans que quelqu'un l'ait qualifiée.
    effect = parPrefixe ?? "EXTERNAL_COMMUNICATION";
  }

  const lecture = EFFECT_RANK[effect] <= EFFECT_RANK.ANALYZE;
  // UNE ÉCRITURE AUTONOME NON DÉCLARÉE garde la politique de la conversation : pas de carte,
  // donc pas d'accord de mission (§7). Elle reste prudente sur le reste : non rejouable, non
  // groupable tant que personne ne l'a qualifiée.
  const autonome = ecrit === false && Boolean(AUTONOMES[name]);
  return {
    id: name,
    domain: domaineDeduit(name),
    effect,
    idempotent: lecture,
    batchable: lecture,
    latency: "MEDIUM",
    confirmation: lecture || autonome ? "NEVER" : "POLICY_ENGINE",
    // AUCUN CONTRAT DÉRIVÉ. Deviner la forme de sortie d'une capacité inconnue ferait échouer
    // des missions valides pour un défaut imaginaire — l'exact inverse de ce que le contrôle
    // sémantique existe pour empêcher.
    contrat: "LIBRE",
    declared: false,
    primitive: primitiveDeduite(name, effect),
  };
}

/** L'effet le plus grave d'un ensemble — ce qui décide du niveau d'approbation d'une mission. */
export function effetMaximal(effets: readonly Effect[]): Effect {
  return effets.reduce<Effect>((max, e) => (EFFECT_RANK[e] > EFFECT_RANK[max] ? e : max), "READ");
}
