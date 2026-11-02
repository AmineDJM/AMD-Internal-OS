# Inventaire — l'ancien Adam face à l'Assistant IA (lot A2, « un seul assistant : Adam »)

> Décision de la Direction (02/11/2026) : l'Assistant IA de la plateforme **est** Adam ; le Super Admin garde
> **toutes** les fonctions de l'ancien Adam, dans le moteur de l'Assistant IA (`src/modules/assistant-ia`), et
> lui seul ; les employés gardent exactement leur assistant. Décision d'architecture : [0054](decisions/0054-adam-complet-super-admin.md).
>
> **Classes** — **(a)** déjà couvert par l'Assistant IA (même outil, ou équivalent nommé) · **(b)** à brancher
> comme outil du moteur **réservé au Super Admin** · **(c)** écran seulement : reste dans l'onglet « Bureau d'Adam »
> (posé par A1) tant qu'aucun équivalent n'est prouvé. Rien n'est supprimé.
>
> **La source de vérité de ce tableau est le code** : `src/platform/in-process/porte-assistant-ia.ts` classe CHAQUE
> outil du catalogue d'Adam (`POWER_TOOLS`) dans exactement une classe, et
> `src/modules/assistant-ia/adam-super-admin.test.ts` échoue si un outil n'est pas classé (un outil ajouté à Adam
> demain devra être classé ici). Ce document en est la lecture humaine.

## Comment une fonction (b) est branchée

| Étape | Où | Ce qui garantit |
|---|---|---|
| Le catalogue d'Adam est lu par **une seule porte** | `src/platform/in-process/porte-assistant-ia.ts` (`outilsAdamSuperAdmin`) | un seul franchissement Assistant IA → Adam, nommé dans `RESIDUS` (`src/platform/ia/frontieres.test.ts`) — Adam → IA et socle restent à zéro |
| L'Assistant IA les reçoit par **un seul fichier** | `src/modules/assistant-ia/infra/adam/outils-adam.ts` | `peutVoirAdam` (rôle **principal** Super Admin), hors Vue exacte ; refus serveur à l'exécution ; ni nom ni description donnés à un autre compte |
| **Lectures** (vague 1) | offertes dans la conversation, passées au filtre de confidentialité (`filtre` de `outils-v1.ts`) | droit relu à chaque appel (`allowed` + `run`) |
| **Écritures** (vague 2) | une **carte** (`kind: "adam_sa_op"`) ; l'outil d'Adam ne s'exécute qu'à la confirmation, sous `journaliserGeste` | confirmation par carte, arrêt d'urgence, **journal des effets K10** (valeur avant → « Ce que l'assistant a fait » → Annuler) |
| Sélection | `trouver_outil` / présélection par la demande (J4) | rien de plus n'est envoyé au modèle tant qu'il ne le cherche pas |

## Résumé

| Classe | Nombre | Détail |
|---|---|---|
| (a) déjà couvert | 37 outils + 6 fonctions | même outil (12), équivalent nommé (25), voix, mémoire, missions, chantiers, Gmail (envoi), Atelier |
| (b) → **branché** vague 1 (lectures SA) | 70 outils + boîte de réception | brief du matin, inbox, histoire d'un dossier, bilans, 360°, what-changed, signaux, Gmail/agenda/Drive Google d'Adam (lecture), surveillances et rappels (lecture), registres, corpus, calculs… |
| (b) → **branché** vague 2 (écritures SA par carte) | 36 outils | rappels, surveillances, Teach Adam, registres décisions/engagements, sollicitations, objectifs, livrables, Google Workspace, skills, rangement Gmail, annulation… |
| (c) écran seulement | 4 outils + 6 écrans | `render_view`, `show_document`, `show_table`, `composer_planche` ; palette, Bureau, inbox (boutons), réglages, Teach Adam (écran), voix d'Adam |

Après les deux vagues, **toutes** les fonctions (b) sont passées en (a) : il ne reste en (b) que ce qui est listé
sous « Reste à faire ».

## (a) Déjà couvert par l'Assistant IA

| Fonction d'Adam (outil) | Où elle vit | Équivalent dans l'Assistant IA | Preuve |
|---|---|---|---|
| `directory_list`, `directory_lookup`, `regulatory_*` (3), `web_research` | socle `platform/ia/lectures`, `web-research.ts` | **le même outil** (socle partagé) | `outils-v1.test.ts` |
| `read_budget`, `read_hr_overview`, `list_pending_decisions`, `search_everything`, `read_calendar`, `finance_totals` | `power-tools.ts`, `executive-read-tools.ts` | même nom, lecture propre au module (`lectures-erp.ts`, `lectures.ts`, `operations/budget.ts`) | `outils-v1.test.ts`, banc Q1 |
| `read_payroll`, `read_employee` | `executive-read-tools.ts` | `lire_paie`, `lire_fiche_rh`, `documents_rh` | banc Q1 (sondes RH) |
| `sql_query`, `run_analysis`, `run_code` (sandbox) | `sandbox-tools.ts` | `requete_sql`, `analyser_donnees`, `calculer_code` (moteur au socle `platform/ia/analyse`, K1) | `analyse.test.ts` |
| `remember`, `list_memories`, `forget_memory` | `memory-tools.ts` | mémoire de l'Assistant IA (`proposer_memoire`, mémoire automatique M1, écran « Ma mémoire ») | `memoire*.test.ts` |
| `recall_conversation` | `memory-tools.ts` | `mes_conversations` (conversations passées, décision 0027) | `conversations.test.ts` |
| `artifact_open`, `artifact_edit`, `artifact_control` | `office-capabilities.ts` | l'Atelier : `ouvrir_dans_l_atelier`, `modifier_document`, `convertir_document`, `enregistrer_document` (J3) | `atelier.test.ts` |
| `lancer_un_chantier`, `ou_en_est_chantier`, `valider_chantier`, `annuler_chantier` (chantiers C1/C2) | `platform/in-process/chantiers/outils-adam.ts` | `outilsChantierPour` (mêmes outils `lib/missions/chantiers`, décisions 0042-0043) | `chantiers*.test.ts` |
| `mission_status`, `mission_control`, `run_mission` (missions et leur pilotage) | `business-capabilities.ts` | `mes_missions`, `piloter_mission`, `lancer_un_travail` / demande de fond (P1, décision 0047) | `missions-mails.test.ts` |
| `gmail_prepare_mail` (envoi par le Gmail d'Adam) | `adam-tools/gmail.ts` | `envoyer_mail` par le canal Adam (SA seul, `canalAdamOuvert`), carte + fenêtre d'annulation | `missions-mails.test.ts`, ML-ADAM- |
| Voix temps réel | `voice-realtime.ts`, `components/chief/realtime-voice*` | la voix GPT-Live de l'Assistant IA (décisions 0038, 0039, 0046) | `voix*.test.ts` |
| Décisions du centre de paiement (exécution) | `platform/in-process/inbox/actions.ts` (`agirSurCarte`) | les **capacités** de l'ERP (visas, validations, paiements — J6) par carte ; la **lecture** de l'inbox est en (b) | `capacites.test.ts` |
| Écritures métier d'Adam (`ops/impl-*`, ~300 gestes) | `lib/assistant/ops/` | registre des capacités dérivé du contrat des actions (J6) + opérations de l'Assistant IA | `action-parity.test.ts`, `capacites.test.ts` |

## (b) Vague 1 — lectures réservées au Super Admin (branchées)

Toutes : `outilsAdamSuperAdmin` → `infra/adam/outils-adam.ts`, offertes à la conversation du seul Super Admin.

| Domaine | Outils d'Adam | Où ils vivent | Risque |
|---|---|---|---|
| **Brief du matin / pilotage** | `executive_brief`, `executive_alerts`, `pre_meeting_brief`, `ceo_attention`, `company_state`, `simulate_scenario`, `read_finances` | `executive-brief-tools.ts`, `what-if.ts`, `power-tools.ts` | lourd (assemblage parallèle) : sorties tronquées par le filtre |
| **Boîte de réception (Chief of Staff)** | `boite_de_reception` (nouveau nom d'outil, lit `composerInbox`) | `platform/in-process/inbox/compose.ts` | l'exécution des cartes reste aux capacités / au Bureau |
| **Histoire d'un dossier, bilans** | `inspect_record`, `person_report`, `business_story`, `investigate_event`, `what_changed`, `time_travel`, `monde_temporel`, `verite_reconcilier`, `verifier_avant_de_dire` | `executive-tools/`, `business-capabilities.ts`, `investigation.ts`, `what-changed.ts`, `time-travel.ts`, `monde-tools.ts`, `verite-tools.ts`, `verification-tools.ts` | lecture globale : SA seulement |
| **360° et signaux** | `employee_360`, `product_360`, `supplier_360`, `organization_insights`, `process_insights`, `product_economics`, `pch_market_status`, `regulatory_intelligence`, `legal_intelligence`, `finance_intelligence`, `data_quality`, `reseau_entreprise`, `carte_territoire` | `three-sixty.ts`, `intelligence-tools.ts`, `quality-tools.ts`, `reseau-tools.ts` | données nominatives : passées au filtre (repères) |
| **Lecture de documents** | `search_drive`, `read_document`, `find_documents`, `search_documents`, `inspect_drive_folder`, `drive_inventaire`, `sheet_audit`, `sheet_trace`, `sheet_diff`, `sheet_read`, `pdf_read`, `format_lire`, `format_convertir`, `media_transcript`, `list_artifacts` | `executive-tools/drive.ts`, `document-discovery.ts`, `investigation.ts`, `fichiers-tools.ts`, `office-capabilities.ts`, `media-tools.ts`, `deliverables.ts` | contenu tiers : encadré « non fiable » |
| **Fabric / connaissance** | `source_map`, `search_knowledge_corpus`, `read_corpus_document`, `list_corpus_sources`, `registre_capacites`, `inbound_events` | `source-map.ts`, `corpus-tools.ts`, `registre-tools.ts`, `inbound-tools.ts` | — |
| **Calculs, rendu** | `calcul_montecarlo`, `calcul_optimisation`, `calcul_ordonnancement`, `calcul_statistiques`, `chart_advice`, `read_stock`, `search_hospitals`, `search_courriers`, `find_free_slot` | `calcul-tools.ts`, `sandbox-tools.ts`, `executive-read-tools.ts` | CPU : bornes de l'outil d'origine |
| **Mémoire d'Adam (registres)** | `list_decisions`, `list_commitments`, `list_rules` (Teach Adam), `action_history`, `episodic_recall` | `memory-tools.ts`, `teach-tools.ts`, socle `intentions/action-intents.ts` | — |
| **Rappels, surveillances, skills** | `list_reminders`, `list_watches`, `list_skills` | `executive-tools/planification.ts`, `watch-tools.ts`, `skill-tools.ts` | — |
| **Missions de sollicitation** | `mission_participants`, `mission_consolidate`, `mission_nudge_candidates` | `adam-tools/missions.ts` | — |
| **Gmail / agenda / Drive Google d'Adam (lecture)** | `adam_status`, `gmail_search`, `gmail_read_thread`, `gmail_read_attachment`, `gmail_pending_mail`, `gcal_search`, `gcal_free_slots`, `gdrive_search`, `gdrive_read`, `resolve_person` | `adam-tools/` | canal Gmail d'Adam : SA seul (inchangé) |

## (b) Vague 2 — écritures réservées au Super Admin, par carte (branchées)

L'outil d'Adam ne s'exécute **qu'au clic « Confirmer »** (ou à l'oral, même garde), sous le journal des effets K10.

| Domaine | Outils d'Adam | Annulation (K10) |
|---|---|---|
| **Rappels planifiés** | `plan_reminder`, `cancel_reminder`, `snooze_reminder` | journal des effets (ligne avant / après) |
| **Surveillances (watches)** | `watch_entity`, `stop_watch` | journal des effets |
| **Teach Adam** | `teach_adam`, `update_rule`, `disable_rule`, `delete_rule` | journal des effets |
| **Registres d'Adam** | `record_decision`, `update_decision_outcome`, `record_commitment`, `close_commitment`, `objectif_durable` | journal des effets |
| **Missions** | `mission_create` (sollicitation) | journal des effets ; un message déjà parti est dit « non annulable » |
| **Livrables et bilans** | `create_report`, `draft_deliverable`, `deck_build`, `sheet_build`, `dossier_build`, `document_build`, `document_profile` | journal des effets (fichier créé → supprimé à l'annulation) |
| **Google Workspace d'Adam** | `gworkspace_create`, `gdoc_read_or_append`, `gdrive_put_internal_file`, `gmail_organize` | effet externe journalisé ; l'annulation dit ce qui ne se défait pas côté Google |
| **Fichiers, faits externes** | `drive_lot`, `attach_inbound_event` | journal des effets |
| **Skills** | `create_skill`, `promote_skill`, `drop_skill` | journal des effets |
| **Défaire** | `annuler_changements` | il est lui-même une annulation, journalisée |

## (c) Écran seulement — l'onglet « Bureau d'Adam »

| Fonction | Où | Pourquoi elle reste à l'écran |
|---|---|---|
| `render_view`, `show_document`, `show_table`, `composer_planche` | `view-tools.ts`, `show-tools.ts`, `planche-tools.ts` | ils composent la **planche** du Bureau (protocole `_blocs` d'Adam) ; l'Assistant IA a son UI générative (R5) et ses blocs (analyse, visuel) |
| Palette de commandes, Bureau (`chief-workspace`, planche) | `components/chief/` | écran |
| Boîte de réception — **boutons** (Approuver / Refuser / Choisir) | `components/chief/inbox`, `platform/in-process/inbox/actions.ts` | l'écran agit sur la carte ; l'Assistant IA lit l'inbox (b) et agit par les capacités (a) |
| Réglages d'Adam (Gmail, veille, voix) | `app/(app)/chief-of-staff/reglages` | écran (A1 : onglet « Réglages d'Adam ») |
| Teach Adam — écran des règles | `components/chief/` | écran ; les outils sont branchés (vague 2) |
| Skills **dynamiques** (connecteurs, micro-outils exécutés, §36) | `platform/in-process/skills` | exécution de code tiers : restent au Bureau tant qu'un banc ne prouve pas leur isolement dans le moteur IA |

Les tâches de fond d'Adam (`assistant.rappels`, `adam.boite-gmail`, `assistant.alertes-chaudes`, missions et
surveillances) **continuent de tourner** : elles ne dépendent pas de l'écran ; les outils branchés lisent et écrivent
les mêmes tables.

## Tests qui le prouvent

- `src/modules/assistant-ia/adam-super-admin.test.ts` (vraie base) : chaque outil du catalogue d'Adam est classé ;
  le Super Admin reçoit les outils (b) et un résultat réel ; une écriture ne fait rien avant la carte, puis s'exécute
  et entre au journal des effets ; **chaque persona du banc Q1** (et un Super Admin en secondaire, et une Vue exacte)
  ne les a pas, ne les voit pas nommés dans sa consigne, et ne peut pas les obtenir en se disant Super Admin (appel
  forcé, intention forgée).
- Banc d'audit Q1 : attaques `ADAM-SA-*` (`infra/testing/audit/attaques.ts`).
- Frontière : `src/platform/ia/frontieres.test.ts` (un résidu nommé, exact).

## Reste à faire

- Skills dynamiques (§36) : banc d'isolement avant de les offrir au moteur IA (classe (c) en attendant).
- La planche du Bureau (`render_view`, `show_*`, `composer_planche`) : à porter vers les blocs de l'Assistant IA si la
  Direction le demande.
