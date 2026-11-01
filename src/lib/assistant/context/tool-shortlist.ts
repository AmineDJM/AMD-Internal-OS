import type { Domain, QueryRoute } from "./router";
import { MAX_TOOLS_PER_CALL } from "@/lib/models/openai";
import { specialistesActifs } from "@/lib/assistant/specialists/registry";

/** §29 : la délégation aux spécialistes n'est exposée que si un spécialiste a un bénéfice mesuré. */
const SPECIALISTES_EXPOSES = specialistesActifs().length > 0;

/**
 * NE PAS DÉCRIRE 77 OUTILS POUR RÉPONDRE « OUI, TROIS MAILS » (§23, §24).
 *
 * LA MESURE QUI JUSTIFIE CE FICHIER. Sur le compte le plus puissant, chaque tour du mode texte
 * envoie 38 737 tokens estimés de contexte fixe — dont 23 316 rien qu'en SCHÉMAS D'OUTILS, soit
 * 60 %. Le PDG n'a pas encore ouvert la bouche que la moitié du budget est dépensée à expliquer
 * au modèle comment lire une fiche de paie, alors qu'il demande si Deepak a répondu.
 *
 * CE N'EST PAS QU'UNE QUESTION DE COÛT. Soixante-dix-sept descriptions d'outils, c'est aussi
 * soixante-dix-sept occasions de choisir le mauvais. Réduire la liste au domaine de la question
 * améliore la SÉLECTION autant que la facture — c'est l'argument principal, la facture n'est que
 * le bénéfice visible.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * LA PARITÉ EST NON NÉGOCIABLE, et elle est garantie par TROIS mécanismes, pas par une intention :
 *
 *   1. TOUT OUTIL EST CLASSÉ. `tool-shortlist.test.ts` échoue si un seul outil du registre
 *      n'apparaît pas ici. Un outil ajouté demain sans classement casse la CI — il ne disparaît
 *      pas en silence du champ de vision d'Adam.
 *   2. UN SOCLE EST TOUJOURS LÀ. Recherche universelle, lecture de fiche, résolution de personne,
 *      mémorisation : avec ces quatre-là, aucune question ne devient impossible, seulement plus lente.
 *   3. LA DÉCOUVERTE EXISTE. `list_more_tools` permet au modèle de réclamer le reste quand il ne
 *      trouve pas son compte. C'est l'échappatoire qui transforme une restriction en un ORDRE DE
 *      PRÉSENTATION : rien n'est retiré, tout est différé.
 *
 * Sans ces trois-là, raccourcir la liste serait exactement ce que la mission interdit : une perte
 * de capacité déguisée en optimisation.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Le classement. Un outil peut servir plusieurs domaines — « gmail_prepare_mail » en est un. */
export const TOOL_DOMAINS: Record<string, Domain[]> = {
  // ── Messagerie ──────────────────────────────────────────────────────────────────────────
  // La recherche DANS le contenu — transverse par nature : un contrat, une notice et un
  // courriel se lisent avec le même outil.
  search_documents: ["GENERAL"],

  gmail_search: ["MAIL"],
  gmail_read_thread: ["MAIL"],
  gmail_pending_mail: ["MAIL"],
  gmail_prepare_mail: ["MAIL"],
  gmail_organize: ["MAIL"],
  gmail_read_attachment: ["MAIL", "DRIVE"],

  // ── Agenda ──────────────────────────────────────────────────────────────────────────────
  read_calendar: ["CALENDAR"],
  gcal_search: ["CALENDAR"],
  gcal_free_slots: ["CALENDAR"],
  find_free_slot: ["CALENDAR"],
  pre_meeting_brief: ["CALENDAR"],

  // ── Réglementaire ───────────────────────────────────────────────────────────────────────
  regulatory_portfolio: ["REGULATORY"],
  regulatory_intelligence: ["REGULATORY"],
  // `consult_specialists` (§29) n'est classé que s'il est au registre — voir `SPECIALISTES_EXPOSES` plus bas.
  ...(SPECIALISTES_EXPOSES ? { consult_specialists: ["REGULATORY", "LEGAL", "FINANCE", "GENERAL"] as Domain[] } : {}),
  legal_intelligence: ["LEGAL"],
  finance_intelligence: ["FINANCE"],
  regulatory_workload: ["REGULATORY", "HR"],
  regulatory_knowledge: ["REGULATORY"],
  product_360: ["REGULATORY"],
  search_hospitals: ["REGULATORY"],
  read_stock: ["REGULATORY"],
  // LES CAPACITÉS MÉTIER touchent DEUX domaines à la fois, et c'est exactement pourquoi elles
  // existent : elles remplacent la séquence que le modèle devait mener entre eux. Les déclarer
  // sur les deux les rend joignables depuis « combien rapporte X ? » comme depuis
  // « où en est le dossier X ? ». (Le PCH est classé REGULATORY, comme `pch_operation`.)
  product_economics: ["REGULATORY", "FINANCE"],
  pch_market_status: ["REGULATORY", "FINANCE"],
  business_story: ["REGULATORY", "FINANCE"],

  // ── Finances ────────────────────────────────────────────────────────────────────────────
  read_budget: ["FINANCE"],
  read_finances: ["FINANCE"],
  finance_totals: ["FINANCE"],

  // ── Ressources humaines ─────────────────────────────────────────────────────────────────
  read_employee: ["HR"],
  read_hr_overview: ["HR"],
  read_payroll: ["HR"],
  employee_360: ["HR"],
  organization_insights: ["HR"],

  // ── Documents ───────────────────────────────────────────────────────────────────────────
  gdrive_search: ["DRIVE"],
  gdrive_read: ["DRIVE"],
  gdrive_put_internal_file: ["DRIVE"],
  inspect_drive_folder: ["DRIVE"],
  search_drive: ["DRIVE"],
  find_documents: ["DRIVE"],
  read_document: ["DRIVE"],
  gdoc_read_or_append: ["DRIVE"],
  // MONTRER un fichier vaut dans plusieurs pôles : un contrat est juridique, un export est
  // documentaire, une facture est financière. Le refus « je ne peux pas afficher ce fichier »
  // est arrivé DEUX fois dans le même échange de production — l'outil doit être là quand on
  // dit « montre-moi », pas une découverte plus tard.
  show_document: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  // LIVE OFFICE — les documents vivent dans le Drive, et les contrats sont le premier usage.
  // Les trois outils portent les MÊMES domaines : ouvrir sans pouvoir modifier, ou modifier
  // sans pouvoir enregistrer, laisserait la personne au milieu du gué.
  artifact_open: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  artifact_edit: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  artifact_control: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  // EXCEL GOD MODE — vérifier, expliquer, comparer, lire un classeur du Drive, et en construire un
  // vérifié. Un budget est financier, un tableau de suivi réglementaire est réglementaire, un
  // état de marché est commercial : les mêmes domaines que le Live Office.
  sheet_audit: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  sheet_trace: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  sheet_diff: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  sheet_read: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  sheet_build: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  // Les documents longs : lire un PDF de 500 pages, construire un deck vérifié.
  pdf_read: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  deck_build: ["DRIVE", "LEGAL", "REGULATORY", "FINANCE"],
  // La fabrique de documents : une pièce commerciale est un acte Legal / Finance qui finit dans le Drive.
  // Domaines VOLONTAIREMENT étroits : chaque domaine a un plafond d'outils par niveau, et une
  // écriture métier (créer une tâche, envoyer) ne doit pas en sortir parce qu'une fabrique y entre.
  document_build: ["LEGAL", "FINANCE"],
  // Le profil documentaire et le REGISTRE DE MARQUE (§26) : « règle la charte », « nos devis sont signés
  // par… » commencent souvent par le vocabulaire de Teach Adam — l'outil doit être là aussi.
  document_profile: ["LEGAL", "TEACH"],
  dossier_build: ["DRIVE", "FINANCE"],
  // « Dans un tableau », « avec la date et le responsable », « trie par échéance » : la demande
  // arrive APRÈS une lecture, dans n'importe quel domaine, et souvent en trois mots. Elle ne
  // survivrait pas à un tour de découverte.
  show_table: ["REGULATORY", "FINANCE", "HR", "LEGAL", "DIRECTORY", "GENERAL"],
  gworkspace_create: ["DRIVE"],
  list_artifacts: ["DRIVE"],
  draft_deliverable: ["DRIVE"],

  // ── Juridique & courriers ───────────────────────────────────────────────────────────────
  search_courriers: ["LEGAL"],

  // ── Missions, engagements, rappels ──────────────────────────────────────────────────────
  mission_status: ["MISSION"],
  // La sollicitation (« qui n'a pas répondu ? ») — distincte de l'avancement des étapes.
  mission_participants: ["MISSION"],
  run_mission: ["MISSION"],
  mission_control: ["MISSION"],
  mission_create: ["MISSION"],
  mission_consolidate: ["MISSION"],
  mission_nudge_candidates: ["MISSION"],
  // C1 (décision 0042) : les chantiers de développement — des missions du même moteur (Super Admin).
  lancer_un_chantier: ["MISSION"],
  ou_en_est_chantier: ["MISSION"],
  valider_chantier: ["MISSION"],
  annuler_chantier: ["MISSION"],
  list_commitments: ["MISSION"],
  record_commitment: ["MISSION"],
  close_commitment: ["MISSION"],
  plan_reminder: ["MISSION"],
  // Les surveillances durables : même domaine que les rappels et les missions.
  watch_entity: ["MISSION"],
  list_watches: ["MISSION"],
  stop_watch: ["MISSION"],
  list_reminders: ["MISSION"],
  cancel_reminder: ["MISSION"],
  snooze_reminder: ["MISSION"],

  // ── Le web — l'EXTÉRIEUR de l'entreprise ────────────────────────────────────────────────
  // « le prix public en France », « l'actualité de ce laboratoire » : une information externe
  // peut être demandée depuis n'importe quel sujet métier — la recherche web accompagne donc
  // les domaines où l'extérieur entre naturellement dans la conversation.
  web_research: ["REGULATORY", "GENERAL"],

  // ── Annuaire & personnes ────────────────────────────────────────────────────────────────
  // L'ANNUAIRE APPARTIENT AUSSI À LA MESSAGERIE. On n'écrit à personne sans son adresse : une
  // liste « messagerie » qui n'offre que la boîte condamne Adam à chercher le destinataire DANS
  // les messages reçus, puis à répondre « je n'ai pas son adresse » quand il n'y figure pas.
  // C'est arrivé en production sur « envoie un mail à Khaled ».
  directory_lookup: ["DIRECTORY", "MAIL"],
  directory_list: ["DIRECTORY"],
  person_report: ["DIRECTORY", "HR"],
  supplier_360: ["DIRECTORY"],

  // ── Administration & traçabilité ────────────────────────────────────────────────────────
  adam_status: ["ADMIN"],
  action_history: ["ADMIN"],
  list_decisions: ["ADMIN"],
  record_decision: ["ADMIN"],
  update_decision_outcome: ["ADMIN"],

  // ── Transverses : utiles partout, donc rattachés à GENERAL ──────────────────────────────
  search_everything: ["GENERAL"],
  inspect_record: ["GENERAL"],
  resolve_person: ["GENERAL"],
  company_state: ["GENERAL"],
  ceo_attention: ["GENERAL"],
  executive_brief: ["GENERAL"],
  executive_alerts: ["GENERAL"],
  list_pending_decisions: ["GENERAL"],
  what_changed: ["GENERAL"],
  // La carte des sources (fabric F3) : transverse par nature, comme la recherche fédérée.
  source_map: ["SOURCES"],
  data_quality: ["QUALITE"],
  // Le bac à sable (mandat 4 §25) : SQL en lecture seule, analyse par étapes, code isolé, conseil de graphique.
  sql_query: ["DATA"],
  run_analysis: ["DATA"],
  run_code: ["DATA"],
  chart_advice: ["DATA"],
  // La représentation générique (mandat 5 §35) : dix-sept formes et le mini-tableau de bord, composés par le code.
  render_view: ["DATA", "GENERAL"],
  // Les micro-outils et skills (mandat 5 §36) : créer et lister sont ouverts ; promouvoir et jeter sont des gestes de personne.
  create_skill: ["DATA", "GENERAL", "TEACH"],
  list_skills: ["TEACH", "GENERAL"],
  promote_skill: ["TEACH"],
  drop_skill: ["TEACH"],
  // Les faits externes (mandat 5 §37) : lecture sous la vue globale ; le rattachement est un geste de personne.
  inbound_events: ["GENERAL", "DATA", "SOURCES", "MAIL"],
  attach_inbound_event: ["GENERAL"],
  // L'audio et la vidéo (mandat 5 §38) : un enregistrement est un document du Drive, souvent une réunion.
  media_transcript: ["DRIVE", "CALENDAR", "GENERAL"],
  // Les moteurs de calcul (mandat 5 §39) : le chiffre est produit par le code. L'optimisation et
  // l'ordonnancement servent aussi une question de finance ou de planning, pas seulement de données.
  calcul_montecarlo: ["DATA", "FINANCE", "GENERAL"],
  calcul_optimisation: ["DATA", "FINANCE", "GENERAL"],
  calcul_ordonnancement: ["DATA", "MISSION", "CALENDAR", "GENERAL"],
  calcul_statistiques: ["DATA", "FINANCE", "GENERAL"],
  // Le réseau et la carte (mandat 5 §40) : « comment sommes-nous liés à X », « qui est le point de
  // passage », « où poser le dépôt » ne sont pas des questions de module — elles traversent tout.
  reseau_entreprise: ["DATA", "DIRECTORY", "GENERAL"],
  carte_territoire: ["DATA", "DIRECTORY", "GENERAL"],
  // Les fichiers et les formats (mandat 5 §41) : ranger, dédoublonner, importer, convertir.
  drive_inventaire: ["DRIVE", "DATA", "GENERAL"],
  // §44 : la question qu'on pose AVANT de dire « je ne peux pas ». Elle n'appartient à aucun
  // domaine parce qu'elle porte sur tous — et notamment sur ceux où Adam croit ne rien savoir faire.
  registre_capacites: ["GENERAL", "ADMIN", "DATA"],
  // §45 : l'histoire d'un dossier. Transverse par nature — une question temporelle arrive
  // aussi bien du Regulatory que du Legal ou de la Finance.
  monde_temporel: ["GENERAL", "REGULATORY", "LEGAL", "FINANCE"],
  // §46 : deux chiffres qui divergent arrivent surtout de la finance, mais pas seulement.
  verite_reconcilier: ["GENERAL", "FINANCE", "DATA", "LEGAL"],
  // Mandat 7 : agencer l'écran ne dépend d'AUCUN domaine — c'est la nature du résultat
  // (plusieurs blocs, plusieurs angles possibles) qui appelle cet outil, pas son sujet.
  composer_planche: ["GENERAL", "DATA", "FINANCE", "REGULATORY", "LEGAL"],
  // §49 : « combien vérifier avant de dire ça » se pose partout, et d'abord là où un chiffre
  // engage — la finance et le regulatory. C'est aussi un outil du socle, voir ALWAYS_ON.
  verifier_avant_de_dire: ["GENERAL", "FINANCE", "REGULATORY", "LEGAL", "DATA"],
  // §48 : « annule ce que tu as fait sur ce dossier » arrive de n'importe quel module —
  // c'est la nature du geste, pas le domaine du dossier, qui appelle cet outil.
  annuler_changements: ["GENERAL", "REGULATORY", "LEGAL", "FINANCE", "ADMIN"],
  // §47 : un objectif durable traverse tout — « prêts pour l'AO 2027 » tient du regulatory,
  // du legal et de la finance à la fois. C'est ce qui le distingue d'une mission.
  objectif_durable: ["GENERAL", "REGULATORY", "LEGAL", "FINANCE"],
  drive_lot: ["DRIVE", "GENERAL"],
  format_lire: ["DATA", "DRIVE", "GENERAL"],
  format_convertir: ["DATA", "DRIVE", "GENERAL"],
  time_travel: ["GENERAL"],
  investigate_event: ["GENERAL"],
  process_insights: ["GENERAL"],
  simulate_scenario: ["GENERAL"],
  create_report: ["GENERAL"],
  remember: ["GENERAL"],
  teach_adam: ["TEACH"],
  list_rules: ["TEACH"],
  update_rule: ["TEACH"],
  disable_rule: ["TEACH"],
  delete_rule: ["TEACH"],
  forget_memory: ["GENERAL"],
  list_memories: ["GENERAL"],
  recall_conversation: ["GENERAL"],
  episodic_recall: ["GENERAL"],
  search_knowledge_corpus: ["GENERAL"],
  read_corpus_document: ["GENERAL"],
  list_corpus_sources: ["GENERAL"],
};

/**
 * LE SOCLE — présent à CHAQUE appel de modèle, quel que soit le domaine.
 *
 * Quatre outils, choisis pour qu'aucune question ne devienne IMPOSSIBLE quand le domaine est mal
 * deviné : de quoi chercher partout, ouvrir n'importe quelle fiche, identifier une personne — et
 * RETENIR ce que le PDG vient de dire. Ce dernier n'est pas un confort : oublier une consigne
 * parce que la question portait sur la messagerie serait une régression franche, et c'est le seul
 * des transverses dont l'absence ne se rattrape pas au tour suivant.
 * Un mauvais aiguillage coûte alors un tour de plus, jamais un « je ne peux pas ».
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES 82 OUTILS QUI ÉCHAPPAIENT AU CLASSEMENT — et pourquoi la liste courte ne raccourcissait pas.
 *
 * Le classement ci-dessus ne couvrait que `POWER_TOOLS` (79). Les 82 autres — lectures de base,
 * écritures, outils super-admin, et les 30 schémas d'opérations par domaine — n'y figuraient pas.
 * Or la règle de sécurité est « un outil NON classé est CONSERVÉ » : ces 82 passaient donc
 * TOUJOURS, quelle que soit la question.
 *
 * D'où le chiffre qu'on a mesuré en corrigeant l'incident HTTP 400 : 161 outils réduits à 106.
 * La réduction ne portait que sur les 55 outils de pouvoir hors domaine ; les deux tiers de la
 * liste étaient intouchables par construction. « Bonjour » embarquait encore 106 schémas.
 *
 * La règle de sécurité était bonne — elle penche du bon côté, et elle reste. Ce qu'il manquait,
 * c'est de ne plus avoir besoin d'elle : un classement COMPLET rend l'échappatoire inutile au
 * lieu de la rendre dangereuse. Le test de parité, élargi, échoue désormais si un seul outil du
 * périmètre réel n'est pas classé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const TOOL_DOMAINS_RESTE: Record<string, Domain[]> = {
  // ── Lectures de base ────────────────────────────────────────────────────────────────────
  search_people: ["DIRECTORY", "HR"],
  search_doctors: ["DIRECTORY"],
  search_products: ["REGULATORY"],
  search_events: ["CALENDAR"],
  list_emails: ["MAIL"],
  read_email: ["MAIL"],
  read_workflow: ["ADMIN"],
  my_overview: ["GENERAL"],
  list_my_tasks: ["MISSION"],
  list_my_requests: ["MISSION"],
  find_available_actions: ["GENERAL"],
  export_excel: ["GENERAL"],

  // ── Administration de la plateforme ─────────────────────────────────────────────────────
  list_accounts: ["ADMIN"],
  read_platform_settings: ["ADMIN"],
  update_platform_setting: ["ADMIN"],
  set_account_active: ["ADMIN"],
  set_account_role: ["ADMIN"],
  configure_workflow: ["ADMIN"],
  manage_custom_field: ["ADMIN"],
  advance_workflow: ["ADMIN"],
  create_admin_request: ["ADMIN"],
  delete_record: ["ADMIN"],
  restore_record: ["ADMIN"],
  purge_record: ["ADMIN"],
  create_notification: ["GENERAL"],

  // ── Réglementaire ───────────────────────────────────────────────────────────────────────
  update_regulatory_product: ["REGULATORY"],
  assign_regulatory_responsible: ["REGULATORY", "HR"],
  set_regulatory_step: ["REGULATORY"],
  request_regulatory_status_update: ["REGULATORY"],
  set_products_company: ["REGULATORY", "ADMIN"],
  create_dossier: ["REGULATORY"],
  create_hospital: ["REGULATORY"],
  update_hospital: ["REGULATORY"],

  // ── Messagerie ──────────────────────────────────────────────────────────────────────────
  send_message: ["MAIL"],
  send_email: ["MAIL"],

  // ── Agenda et événements ────────────────────────────────────────────────────────────────
  create_calendar_event: ["CALENDAR"],
  update_calendar_event: ["CALENDAR"],
  create_event_request: ["CALENDAR", "MISSION"],
  create_congress_request: ["CALENDAR", "MISSION"],

  // ── Missions, tâches, demandes ──────────────────────────────────────────────────────────
  create_task: ["MISSION"],
  update_task: ["MISSION"],
  update_request: ["MISSION"],
  create_promo_material_request: ["MISSION"],

  // ── Finances ────────────────────────────────────────────────────────────────────────────
  decide_payment: ["FINANCE"],
  request_treasury_update: ["FINANCE"],
  create_sponsoring_request: ["FINANCE", "MISSION"],

  // ── RH ──────────────────────────────────────────────────────────────────────────────────
  create_hr_request: ["HR", "MISSION"],
  update_salary: ["HR"],

  // ── Juridique ───────────────────────────────────────────────────────────────────────────
  create_legal_document: ["LEGAL"],
  update_legal_document: ["LEGAL"],

  // ── Transverses assumés — ils ne relèvent d'aucun domaine et servent partout ────────────
  bulk_action: ["GENERAL"],
  action_plan: ["GENERAL"],
  // LE RATTRAPAGE GÉNÉRIQUE ne relève d'aucun domaine par construction : il atteint les 550
  // actions ouvertes de l'ERP, tous modules confondus. Le ranger dans un domaine le rendrait
  // invisible aux phrases des autres — c'est-à-dire précisément quand aucun outil dédié ne
  // couvre le geste, le seul cas où il sert (`ops/impl-capabilite.ts`).
  capability_operation: ["GENERAL"],

  // ── LES 30 SCHÉMAS D'OPÉRATIONS PAR DOMAINE ────────────────────────────────────────────
  // Leur nom porte le domaine, mais un classement DÉDUIT du nom serait faux le jour où l'un
  // d'eux sera renommé sans que la carte le suive. On l'écrit, et le test le vérifie.
  drive_operation: ["DRIVE"],
  task_operation: ["MISSION"],
  finance_operation: ["FINANCE"],
  regulatory_operation: ["REGULATORY"],
  hr_operation: ["HR"],
  messaging_operation: ["MAIL"],
  meeting_operation: ["CALENDAR"],
  mail_operation: ["MAIL"],
  legal_operation: ["LEGAL"],
  org_operation: ["ADMIN", "HR"],
  adpro_operation: ["MISSION"],
  event_operation: ["CALENDAR"],
  consulting_operation: ["MISSION"],
  care_operation: ["REGULATORY"],
  promo_operation: ["MISSION"],
  medical_info_operation: ["REGULATORY"],
  bd_operation: ["DIRECTORY"],
  dossier_operation: ["REGULATORY"],
  directive_operation: ["ADMIN"],
  support_operation: ["ADMIN"],
  validation_operation: ["MISSION"],
  field_report_operation: ["DIRECTORY"],
  supply_operation: ["REGULATORY"],
  planning_operation: ["CALENDAR"],
  request_operation: ["MISSION"],
  medical_operation: ["REGULATORY"],
  stock_operation: ["REGULATORY"],
  pch_operation: ["REGULATORY"],
  sales_operation: ["DIRECTORY"],
  logistics_operation: ["REGULATORY"],
};

/** Le classement COMPLET — c'est celui-ci que le résolveur consulte. */
export const TOOL_DOMAINS_ALL: Record<string, Domain[]> = { ...TOOL_DOMAINS, ...TOOL_DOMAINS_RESTE };

/**
 * LES DOMAINES DYNAMIQUES (§36) — ceux des connecteurs, micro-outils et playbooks, posés par le pont
 * des skills au chargement. Un outil dynamique classé entre dans la liste courte de son domaine comme
 * un outil du cœur ; non classé, il serait conservé (le défaut sûr) — mais il l'est toujours.
 */
const DOMAINES_DYNAMIQUES = new Map<string, Domain[]>();
export function declarerDomaineDynamique(name: string, domains: Domain[]): void { DOMAINES_DYNAMIQUES.set(name, domains); }
export const domainesDe = (name: string): Domain[] | undefined => TOOL_DOMAINS_ALL[name] ?? DOMAINES_DYNAMIQUES.get(name);

export const ALWAYS_ON = [
  "search_everything", "inspect_record", "resolve_person", "remember",
  // AJOUTÉ AU SOCLE, et ce n'est pas une facilité. `search_everything` trouve OÙ un document est
  // rangé ; elle ne lit rien dedans. Avoir l'une sans l'autre laissait la question « que dit le
  // contrat sur… ? » sans aucun moyen d'aboutir — quel que soit le domaine détecté, et alors
  // même que la réponse était indexée. Une asymétrie de ce genre ne se répare pas par domaine.
  "search_documents",
  // §44 — LA QUESTION QU'ON POSE AVANT DE DIRE « JE NE PEUX PAS ». Elle appartient au socle par
  // le même critère que les autres : « aucune question ne doit devenir IMPOSSIBLE quand le
  // domaine est mal deviné ». Un manque de capacité peut surgir dans n'importe quel domaine — la
  // signature électronique arrive par une question juridique, un format illisible par une
  // question de finance — et c'est justement quand le domaine est mal deviné qu'Adam risque de
  // conclure à l'impossible. Le registre coûte un schéma par appel et évite une phrase fausse.
  "registre_capacites",
] as const;

/**
 * LES OUTILS DE HAUTEUR — pour les questions qui traversent l'entreprise.
 *
 * Une question causale (« pourquoi on en est arrivé là ? ») ne tient dans aucun domaine : elle
 * demande l'état d'ensemble, la chronologie et les contradictions. Les restreindre à un domaine
 * serait l'erreur symétrique de celle qu'on corrige.
 */
export const EXECUTIVE = [
  "company_state", "ceo_attention", "executive_brief", "executive_alerts",
  "what_changed", "time_travel", "investigate_event", "process_insights", "simulate_scenario",
];

/**
 * LES CAPACITÉS MÉTIER — celles qui REMPLACENT une séquence, et qui passent donc AVANT les
 * outils de leur propre domaine.
 *
 * ── LA PANNE QUI A PRODUIT CETTE LISTE ───────────────────────────────────────────────────
 *
 * `pch_market_status` était déclarée, ouverte par les droits, annoncée à la voix… et JAMAIS
 * envoyée au modèle. Rang identique aux trente autres outils du domaine réglementaire, elle
 * tombait sous le plafond de quinze du niveau A — c'est-à-dire exactement quand le plafond
 * mord, donc exactement quand elle sert le plus.
 *
 * Le banc d'architecture l'a vu ; ni la lecture du code ni les tests d'unité ne l'auraient vu,
 * parce que chaque pièce était correcte séparément.
 *
 * ── POURQUOI CE RANG EST JUSTE, ET PAS UN PASSE-DROIT ────────────────────────────────────
 *
 * Une capacité de ce genre rend inutiles les outils qu'elle remplace. Lui donner le même rang
 * qu'eux, c'est décider à pile ou face entre « un appel » et « cinq » ; la couper en premier,
 * c'est garantir les cinq. Elle passe donc devant SON DOMAINE — jamais devant le socle, et
 * jamais hors de son domaine : une capacité produit n'a rien à faire dans une question de
 * congés, et le rang ne la sort pas de son domaine.
 */
// Les trois lectures d'intelligence métier (§27) sont des CAPACITÉS au même titre : « quels dossiers
// sont en retard ? » se répondait par une séquence d'`inspect_record` — et, au plafond du niveau A,
// l'outil qui remplace la séquence tombait le dernier parce qu'il est entré le dernier au registre.
export const CAPABILITIES = ["product_economics", "pch_market_status", "business_story", "regulatory_intelligence", "legal_intelligence", "finance_intelligence", ...(SPECIALISTES_EXPOSES ? ["consult_specialists"] : [])] as readonly string[];

/**
 * L'ÉCHAPPATOIRE QUI PRÉSERVE LA PARITÉ. Sans elle, la liste courte serait une amputation ; avec
 * elle, ce n'est qu'un ordre de présentation. Le modèle qui ne trouve pas son compte demande, et
 * reçoit — au prix d'un tour, pas d'une capacité.
 */
export const DISCOVERY_TOOL = {
  name: "list_more_tools",
  description:
    "LES AUTRES OUTILS. Cette conversation ne montre que les outils du domaine en cours. "
    + "Si ce que vous cherchez n'y est pas — un autre module, une lecture chiffrée, une action "
    + "d'un autre pôle — appelez ceci avec le domaine voulu pour obtenir la liste complète. "
    + "Ne répondez JAMAIS « je n'ai pas d'outil pour cela » sans avoir appelé ceci d'abord.",
  input_schema: {
    type: "object" as const,
    properties: {
      domain: {
        type: "string",
        description: "Domaine cherché : MAIL, CALENDAR, REGULATORY, FINANCE, HR, DRIVE, LEGAL, MISSION, DIRECTORY, ADMIN, TEACH (règles enseignées à Adam), SOURCES (carte des sources, fraîcheur), QUALITE (anomalies de données), DATA (analyse, SQL en lecture seule, code isolé, graphiques) — ou vide pour tout.",
      },
    },
  },
};

/**
 * LA DESCRIPTION DE LA DÉCOUVERTE, PAR TOUR — elle dit ce qui est DÉJÀ ouvert.
 *
 * La version fixe disait « cette conversation ne montre que les outils du domaine en cours » sans
 * dire lequel : sur une question de fond, un modèle consciencieux appelait la découverte « pour
 * voir », et le tour repartait avec cent schémas de plus (mesuré : un appel de plus et 60 000
 * jetons sur chaque question causale du banc). Nommer les domaines présentés lui donne
 * l'information qu'il n'avait pas ; le reste est une consigne de coût, pas de comportement.
 */
export function descriptionDecouverte(ouverts: readonly Domain[] | null, avecEcritures: boolean): string {
  const presentes = ouverts && ouverts.length ? ouverts.join(", ") : "tous les domaines";
  return `LES AUTRES OUTILS. Déjà présentés pour cette demande : ${presentes} — `
    + (avecEcritures ? "lectures et actions. " : "lectures seulement. ")
    + "Appelez ceci SEULEMENT si un outil précis vous manque — un autre module, une action d'un autre pôle — "
    + "en nommant le domaine voulu. Chaque appel coûte un aller-retour complet : n'explorez pas « pour voir ». "
    + "Ne répondez JAMAIS « je n'ai pas d'outil pour cela » sans avoir appelé ceci d'abord.";
}


/**
 * LES OUTILS QUE LE CONTEXTE DU TOUR **NOMME** — et que le tour doit donc OUVRIR.
 *
 * ── LE DÉFAUT, MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * `consigneSignaux` dit « l'état des dossiers se lit dans regulatory_intelligence /
 * legal_intelligence / finance_intelligence ». Sur « quels dossiers sont en retard ? » la liste
 * courte du domaine REGULATORY en expose UN sur trois ; sur « quels contrats arrivent à
 * échéance ? », un autre. `consignePeriode` nomme `what_changed` et trois compléments : trois
 * sont absents. Recensement : **15 noms d'outils cités par une consigne et absents de la liste
 * courte**, sur les deux consignes les plus exécutives du produit.
 *
 * Le modèle fait alors la seule chose honnête : il va les chercher. Mesuré sur « Résume-moi la
 * semaine » — six appels de `list_more_tools` (DATA, MISSION, ADMIN, SOURCES, QUALITE, puis
 * TOUT), la liste passe de 54 à 241 schémas, le plafond du fournisseur en écarte 113 — dont
 * `what_changed`, celui que la consigne nommait — et le prompt passe de 13 700 à 55 286 jetons
 * d'entrée avec **0 % de cache** : les schémas d'outils appartiennent au préfixe caché, les
 * changer invalide TOUT. Cet appel-là coûte 0,1133 $ pour 224 jetons de sortie, soit 45 % du
 * tour ; les huit suivants portent 58 000 jetons au lieu de 10 000. Total : 63 s et 0,2534 $
 * pour une question qu'un dirigeant pose chaque lundi.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * C'est §118.19 dans l'autre sens : ce que le code EXIGE, le prompt doit dire comment le
 * satisfaire — donc ce que le prompt NOMME, le tour doit l'EXPOSER. Une consigne qui nomme un
 * outil absent ne fait pas une suggestion, elle commande une découverte.
 *
 * ── POURQUOI UN FAIT DU TEXTE, ET PAS UNE TABLE ──────────────────────────────────────────
 *
 * Une liste « consigne → outils » écrite à la main est fausse le jour où quelqu'un ajoute une
 * phrase, EN SILENCE (§118.73). Un nom d'outil est un identifiant `snake_case` : cette forme
 * n'apparaît pas dans de la prose française, et c'est elle qu'on lit. Les backticks ne peuvent
 * pas servir de critère — `consigneSignaux`, la plus appelée, écrit ses trois noms sans eux.
 *
 * ── POURQUOI ÉPINGLER N'ACCORDE RIEN ─────────────────────────────────────────────────────
 *
 * On n'épingle que ce qui est DÉJÀ dans la liste reçue, elle-même filtrée par
 * `assistantToolsFor(user)` : un nom inconnu, interdit à cette personne, ou simplement absent
 * n'ouvre rien. Et la liste courte est une optimisation de COÛT, réversible par
 * `list_more_tools` : épingler ne fait qu'éviter l'aller-retour que le modèle aurait fait de
 * toute façon. La question se pose, donc elle est écrite ici.
 */
export function outilsNommes(texte: string | null | undefined): string[] {
  if (!texte) return [];
  const out = new Set<string>();
  for (const m of texte.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) {
    const n = m[0];
    if (n in TOOL_DOMAINS_ALL || DOMAINES_DYNAMIQUES.has(n)) out.add(n);
  }
  return [...out].sort();
}

/** Les noms d'outils que cette route mérite. Rendu séparément du filtrage, pour être testable. */
export function shortlistNames(route: Pick<QueryRoute, "route" | "domain" | "secondaires">): string[] {
  // Une route déterministe n'appelle aucun modèle : elle n'a besoin d'aucun schéma.
  if (route.route === "FAST_DETERMINISTIC") return [];

  const keep = new Set<string>(ALWAYS_ON);
  // LE DOMAINE SEUL — et surtout PAS « + GENERAL ».
  //
  // La première version ajoutait GENERAL à tous les domaines : les vingt-deux outils transverses
  // repartaient dans chaque liste, et la « liste courte » ne raccourcissait rien. Le test l'a
  // montré en une ligne (raisonnement profond et requête simple donnaient le MÊME nombre d'outils).
  // Ce qui est vraiment universel tient dans le socle ci-dessus ; le reste se découvre.
  // … plus les domaines SECONDAIRES que le routeur a ouverts (le bac à sable sur une question
  // de finance qui demande un calcul) : additifs, ils ne détrônent jamais le principal.
  const wanted: Domain[] = [route.domain, ...(route.secondaires ?? [])];

  for (const [name, domains] of Object.entries(TOOL_DOMAINS)) {
    if (domains.some((d) => wanted.includes(d))) keep.add(name);
  }
  for (const [name, domains] of DOMAINES_DYNAMIQUES) {
    if (domains.some((d) => wanted.includes(d))) keep.add(name);
  }
  // Le raisonnement profond voit large — c'est sa raison d'être.
  if (route.route === "DEEP_REASONING") for (const n of EXECUTIVE) keep.add(n);

  return [...keep].sort();
}

/**
 * Filtre une liste de définitions d'outils, en conservant l'ORDRE d'origine (le modèle y est
 * sensible) et en ajoutant toujours la découverte.
 *
 * Un outil absent du classement est CONSERVÉ, jamais écarté. C'est le comportement sûr : le
 * ratchet de test signalera l'oubli au développeur, mais en attendant, la production ne perd
 * aucune capacité à cause d'une ligne oubliée dans une table.
 */
export function shortlistTools<T extends { name: string }>(
  tools: T[],
  route: Pick<QueryRoute, "route" | "domain" | "secondaires">,
  epingles: readonly string[] = [],
): (T | typeof DISCOVERY_TOOL)[] {
  if (route.route === "FAST_DETERMINISTIC") return [];
  const names = new Set(shortlistNames(route));
  for (const n of epingles) names.add(n);
  const kept = tools.filter((t) => names.has(t.name) || (!(t.name in TOOL_DOMAINS) && !DOMAINES_DYNAMIQUES.has(t.name)));
  return [...kept, DISCOVERY_TOOL];
}

/**
 * FAIT ENTRER LA LISTE DANS LE PLAFOND DE L'API — sans amputer définitivement.
 *
 * ── LE DÉFAUT QUE CETTE FONCTION FERME ───────────────────────────────────────────────────
 *
 * La liste courte est un CANARY à 20 % : le reste des lectures, et la totalité des mutations,
 * partent sur LEGACY avec la liste complète. Or la liste complète d'un Super Admin compte 161
 * outils, et OpenAI en refuse plus de 128. Adam répondait donc « Erreur IA (HTTP 400) » à
 * « Hello » — pas dans un cas limite, dans le cas courant.
 *
 * ── POURQUOI ÇA N'EST PAS « FORCER LE CANARY » ───────────────────────────────────────────
 *
 * Le canary arbitre ce qu'on PRÉFÈRE ; le plafond dit ce qui est POSSIBLE. Quand la liste
 * complète est impossible, le choix n'est pas « liste courte ou liste complète » — il est
 * « liste courte ou 400 ». Un 400 ne retire pas quelques outils : il retire la réponse.
 *
 * L'autorisation citée dans `rollout.ts` porte sur le CHEMIN d'exécution (quel code décide,
 * quelles gardes s'appliquent) — et ce chemin n'est pas touché ici : le mode reste LEGACY, avec
 * ses droits, son approbation, son audit et son idempotence. Seule la liste de schémas envoyée
 * au modèle est réduite.
 *
 * ── POURQUOI LA LISTE COURTE PLUTÔT QU'UNE COUPE ─────────────────────────────────────────
 *
 * Parce qu'elle est RÉVERSIBLE : `list_more_tools` rouvre un domaine en cours de boucle. Couper
 * les 33 derniers outils les rendrait inatteignables pour le tour entier, sans que le modèle
 * puisse même savoir qu'ils existent. La coupe reste, à la frontière du fournisseur, en dernier
 * recours et en le disant (`capTools`).
 */
export function fitToolBudget<T extends { name: string }>(
  tools: T[],
  route: Pick<QueryRoute, "route" | "domain" | "secondaires">,
  max = MAX_TOOLS_PER_CALL,
  epingles: readonly string[] = [],
): (T | typeof DISCOVERY_TOOL)[] {
  if (tools.length <= max) return tools;
  const court = shortlistTools(tools, route, epingles);
  if (court.length <= max) {
    console.warn(
      `[assistant] ${tools.length} outils dépassent le plafond de ${max} — repli sur la liste `
      + `courte (${court.length}), réversible par découverte. Domaine : ${route.domain}.`,
    );
    return court;
  }

  // ── QUAND LA LISTE COURTE ELLE-MÊME NE TIENT PLUS ────────────────────────────────────
  //
  // Mesuré le 2026-09-06 : le catalogue a grossi (§44 à §49) et la liste courte d'un Super
  // Admin en raisonnement profond est passée à 129 pour un plafond de 128. Une fonction qui
  // s'appelle « fait entrer dans le plafond » et qui rend 129 ne protège de rien — elle
  // déplace le 400 d'un cran, là où plus aucun test ne le regarde.
  //
  // La coupe est donc ICI, et elle est ORDONNÉE, pas arbitraire :
  //   1. le SOCLE (`ALWAYS_ON`) ne se coupe jamais — c'est ce qui reste vrai dans tous les
  //      domaines, et l'amputer casserait la recherche elle-même ;
  //   2. la DÉCOUVERTE ne se coupe jamais — c'est elle qui rend la réduction réversible ;
  //   3. viennent ensuite les outils NON CLASSÉS : `list_more_tools` ne sait pas les rouvrir
  //      (il travaille par domaine), donc on les garde tant qu'on peut ;
  //   4. on coupe en dernier les outils CLASSÉS des domaines ouverts — les seuls que la
  //      découverte sait ramener dans la boucle.
  //
  // L'ordre à l'intérieur d'un rang est celui de la liste reçue, donc stable : deux appels
  // identiques envoient la même liste, sans quoi une régression deviendrait irreproductible.
  const socle = new Set<string>(ALWAYS_ON);
  // UN OUTIL QUE LA CONSIGNE NOMME NE SE COUPE PAS. Sans cette ligne, la coupe ordonnée
  // écarterait exactement l'outil qu'on vient d'épingler : la réparation serait défaite dans le
  // cas pour lequel elle existe. Mesuré avant : `what_changed`, nommé par la consigne, figurait
  // parmi les 113 écartés à la frontière du fournisseur.
  const epingle = new Set<string>(epingles);
  const rang = (t: { name: string }): number => {
    if (t.name === DISCOVERY_TOOL.name || socle.has(t.name) || epingle.has(t.name)) return 0;
    if (!(t.name in TOOL_DOMAINS) && !DOMAINES_DYNAMIQUES.has(t.name)) return 1;
    return 2;
  };
  const ordonnee = court
    .map((t, i) => ({ t, i, r: rang(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i);
  const garde = ordonnee.slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.t);
  console.warn(
    `[assistant] la liste COURTE elle-même dépasse le plafond (${court.length} > ${max}) : `
    + `coupe ordonnée à ${garde.length}, socle et découverte préservés. Domaine : ${route.domain}. `
    + `${court.length - garde.length} outil(s) de domaine restent atteignables par list_more_tools.`,
  );
  return garde;
}
