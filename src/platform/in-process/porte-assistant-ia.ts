import type { PowerTool, UtilisateurOutil } from "@/platform/ia/outil";
import { POWER_TOOLS } from "@/lib/assistant/power-tools";
import { composerInbox } from "./inbox/compose";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'ADAM VERS L'ASSISTANT IA (lot A2, décision 0055 — « un seul assistant : Adam »).
 *
 * La Direction (02/11/2026) : l'Assistant IA de la plateforme EST Adam ; le Super Admin garde TOUTES les fonctions de
 * l'ancien Adam, dans le moteur de l'Assistant IA, et lui seul. Ce fichier est le SEUL endroit par lequel le moteur de
 * l'Assistant IA lit le catalogue d'Adam (`POWER_TOOLS`) — un seul franchissement, nommé dans `RESIDUS`
 * (`platform/ia/frontieres.test.ts`) ; Adam n'importe toujours rien de l'Assistant IA, le socle rien des deux.
 *
 * CHAQUE outil du catalogue est CLASSÉ ci-dessous, dans exactement une classe (le test l'exige) :
 *   • `COUVERTS` (a) — l'Assistant IA a déjà l'outil, ou son équivalent nommé : rien n'est dupliqué ;
 *   • `LECTURES_SA` (b → vague 1) — offerts au seul Super Admin, exécutés tels quels ;
 *   • `ECRITURES_SA` (b → vague 2) — offerts au seul Super Admin, mais JAMAIS exécutés pendant le tour : le moteur de
 *     l'Assistant IA en fait une CARTE, et l'outil ne s'exécute qu'à la confirmation, sous le journal des effets (K10) ;
 *   • `ECRAN_SEUL` (c) — restent dans l'onglet « Bureau d'Adam ».
 *
 * LA RÉSERVE EST ARCHITECTURALE, PAS UNE CONSIGNE : `allowed` et `run` exigent le Super Admin en rôle PRINCIPAL, hors
 * Vue exacte — en plus du droit propre de l'outil. Un compte qui n'est pas Super Admin ne reçoit ni l'outil, ni son nom,
 * ni sa description ; un appel forcé est refusé sans nommer la fonction.
 * Inventaire lisible : `docs/assistant/adam-inventaire.md`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** (a) — l'outil d'Adam et son équivalent dans l'Assistant IA. */
export const COUVERTS: Readonly<Record<string, string>> = {
  directory_list: "directory_list (socle)", directory_lookup: "directory_lookup (socle)",
  regulatory_knowledge: "regulatory_knowledge (socle)", regulatory_portfolio: "regulatory_portfolio (socle)", regulatory_workload: "regulatory_workload (socle)",
  web_research: "web_research (socle)", read_budget: "read_budget", read_hr_overview: "read_hr_overview", list_pending_decisions: "list_pending_decisions",
  search_everything: "search_everything", read_calendar: "read_calendar", finance_totals: "finance_totals",
  read_payroll: "lire_paie", read_employee: "lire_fiche_rh",
  sql_query: "requete_sql", run_analysis: "analyser_donnees", run_code: "calculer_code",
  remember: "mémoire de l'Assistant IA (proposer_memoire, mémoire automatique)", list_memories: "mémoire de l'Assistant IA (contexte, écran « Ma mémoire »)",
  forget_memory: "écran « Ma mémoire »", recall_conversation: "mes_conversations",
  artifact_open: "ouvrir_dans_l_atelier", artifact_edit: "modifier_document", artifact_control: "enregistrer_document / convertir_document",
  lancer_un_chantier: "lancer_un_chantier (outilsChantierPour)", ou_en_est_chantier: "ou_en_est_chantier (outilsChantierPour)",
  valider_chantier: "valider_chantier (outilsChantierPour)", annuler_chantier: "annuler_chantier (outilsChantierPour)",
  mission_status: "mes_missions", mission_control: "piloter_mission", run_mission: "lancer_un_travail / demande de fond",
  gmail_prepare_mail: "envoyer_mail par le canal Adam (Super Admin)",
};

/** (b) vague 1 — lectures offertes au seul Super Admin. */
export const LECTURES_SA: readonly string[] = [
  // Brief du matin, pilotage
  "executive_brief", "executive_alerts", "pre_meeting_brief", "ceo_attention", "company_state", "simulate_scenario", "read_finances",
  // Histoire d'un dossier, bilans
  "inspect_record", "person_report", "business_story", "investigate_event", "what_changed", "time_travel", "monde_temporel", "verite_reconcilier", "verifier_avant_de_dire",
  // 360° et signaux
  "employee_360", "product_360", "supplier_360", "organization_insights", "process_insights", "product_economics", "pch_market_status",
  "regulatory_intelligence", "legal_intelligence", "finance_intelligence", "data_quality", "reseau_entreprise", "carte_territoire",
  // Lecture de documents
  "search_drive", "read_document", "find_documents", "search_documents", "inspect_drive_folder", "drive_inventaire", "sheet_audit", "sheet_trace", "sheet_diff",
  "sheet_read", "pdf_read", "format_lire", "format_convertir", "media_transcript", "list_artifacts",
  // Fabric, connaissance
  "source_map", "search_knowledge_corpus", "read_corpus_document", "list_corpus_sources", "registre_capacites", "inbound_events",
  // Calculs
  "calcul_montecarlo", "calcul_optimisation", "calcul_ordonnancement", "calcul_statistiques", "chart_advice", "read_stock", "search_hospitals", "search_courriers", "find_free_slot",
  // Mémoire d'Adam (registres), historique
  "list_decisions", "list_commitments", "list_rules", "action_history", "episodic_recall",
  // Rappels, surveillances, skills
  "list_reminders", "list_watches", "list_skills",
  // Missions de sollicitation
  "mission_participants", "mission_consolidate", "mission_nudge_candidates",
  // Gmail, agenda, Drive Google d'Adam
  "adam_status", "gmail_search", "gmail_read_thread", "gmail_read_attachment", "gmail_pending_mail", "gcal_search", "gcal_free_slots", "gdrive_search", "gdrive_read", "resolve_person",
];

/** (b) vague 2 — écritures : une carte, puis l'exécution à la confirmation, journalisée (K10). */
export const ECRITURES_SA: readonly string[] = [
  "plan_reminder", "cancel_reminder", "snooze_reminder",
  "watch_entity", "stop_watch",
  "teach_adam", "update_rule", "disable_rule", "delete_rule",
  "record_decision", "update_decision_outcome", "record_commitment", "close_commitment", "objectif_durable",
  "mission_create",
  "create_report", "draft_deliverable", "deck_build", "sheet_build", "dossier_build", "document_build", "document_profile",
  "gworkspace_create", "gdoc_read_or_append", "gdrive_put_internal_file", "gmail_organize",
  "drive_lot", "attach_inbound_event",
  "create_skill", "promote_skill", "drop_skill",
  "annuler_changements",
];

/** Les écritures qui retirent ou défont : la carte le signale (niveau « sensible »). */
export const ECRITURES_SENSIBLES: ReadonlySet<string> = new Set([
  "cancel_reminder", "stop_watch", "delete_rule", "disable_rule", "drop_skill", "gmail_organize", "annuler_changements", "drive_lot", "document_build",
]);

/** (c) — restent dans l'onglet « Bureau d'Adam » : ils composent sa planche (protocole `_blocs`). */
export const ECRAN_SEUL: Readonly<Record<string, string>> = {
  render_view: "compose la planche du Bureau d'Adam",
  show_document: "met un document sous les yeux dans la planche du Bureau",
  show_table: "compose un tableau dans la planche du Bureau",
  composer_planche: "agence la planche du Bureau",
};

/** L'outil d'Adam qui n'existait pas comme outil : la boîte de réception du Chief of Staff, lue (`composerInbox`). */
export const OUTIL_BOITE = "boite_de_reception";

/**
 * LE SUPER ADMIN, EN RÔLE PRINCIPAL, HORS VUE EXACTE — la même règle que `peutVoirAdam` (`lib/rbac/roles.ts`), relue
 * ici pour que la porte se garde elle-même : un Super Admin en rôle SECONDAIRE n'est pas Adam ; un Super Admin qui
 * regarde l'écran d'un autre compte (Vue exacte) voit ce compte, pas Adam.
 */
export const estAdamSuperAdmin = (u: UtilisateurOutil): boolean => u.role === "SUPER_ADMIN" && !u.impersonatedBy;

/** Le refus d'un appel hors Super Admin — sans nommer la fonction ni Adam. */
export const REFUS_HORS_SA = "Cette fonction n'est pas ouverte à votre compte.";

const PAR_NOM = new Map(POWER_TOOLS.map((t) => [t.def.name, t]));

/** Réservé : le droit de l'outil d'origine ET le Super Admin principal, relus à chaque appel. */
function reserve(o: PowerTool): PowerTool {
  return {
    ...o,
    allowed: (u) => estAdamSuperAdmin(u) && o.allowed(u),
    refus: REFUS_HORS_SA,
    run: async (entree, u) => {
      if (!estAdamSuperAdmin(u) || !o.allowed(u)) return REFUS_HORS_SA;
      try {
        return await o.run(entree, u);
      } catch (err) {
        console.error(`[adam→assistant-ia] ${o.def.name}`, err);
        const cause = err instanceof Error && err.message.trim() ? ` Cause technique : ${err.message.slice(0, 220)}` : "";
        return `La lecture a échoué (donnée indisponible). Je préfère ne rien avancer plutôt que d'inventer.${cause}`;
      }
    },
  };
}

const tronque = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** La boîte de réception du Chief of Staff, en lecture : ce qui attend une décision du Super Admin, trié par urgence. */
const BOITE: PowerTool = {
  def: {
    name: OUTIL_BOITE,
    description:
      "LA BOÎTE DE RÉCEPTION DU CHIEF OF STAFF : tout ce qui attend une DÉCISION du Super Admin, en cartes triées par urgence — validations, "
      + "paiements au centre de paiement, accords, attentes de missions, décisions et engagements à trancher, signaux qualité et métier. "
      + "Pour « qu'est-ce qui m'attend ? », « ma boîte de réception », « qu'ai-je à décider ? ». Lecture seule : une décision se prend ensuite par l'action de l'écran (carte).",
    input_schema: {
      type: "object",
      properties: {
        genre: { type: "string", enum: ["APPROVE", "CHOOSE", "REVIEW", "FYI", "REJECT"], description: "Ne garder qu'un genre de carte." },
        limite: { type: "number", description: "Nombre de cartes (défaut 25, max 60)." },
      },
    },
  },
  allowed: () => true,
  label: "Boîte de réception lue",
  run: async (entree, u) => {
    const vue = await composerInbox(u as Parameters<typeof composerInbox>[0]);
    const genre = typeof entree.genre === "string" ? entree.genre : "";
    const n = Math.min(Math.max(Number(entree.limite) || 25, 1), 60);
    const cartes = vue.cartes.filter((c) => !genre || c.genre === genre).slice(0, n).map((c) => ({
      genre: c.genre, urgence: c.urgence, sujet: c.sujet, contexte: tronque(c.contexte, 240), raison: c.raison, echeance: c.echeance,
      impact: c.impact, recommandation: c.recommandation ? `${c.options.find((x) => x.id === c.recommandation!.optionId)?.libelle ?? c.recommandation.optionId} — ${c.recommandation.pourquoi}` : null,
      options: c.options.map((x) => x.libelle), source: c.source.libelle, lien: c.source.href, depuis: c.depuis,
    }));
    return JSON.stringify({ total: vue.cartes.length, compte: vue.compte, cartes, ...(vue.cartes.length > cartes.length ? { note: `${vue.cartes.length - cartes.length} carte(s) de plus — préciser un genre ou une limite.` } : {}) });
  },
};

/** Les outils d'Adam offerts au moteur de l'Assistant IA pour CE compte — vides pour tout autre que le Super Admin principal. */
export function outilsAdamSuperAdmin(user: UtilisateurOutil): { lectures: PowerTool[]; ecritures: PowerTool[] } {
  if (!estAdamSuperAdmin(user)) return { lectures: [], ecritures: [] };
  const pris = (noms: readonly string[]) => noms.map((n) => PAR_NOM.get(n)).filter((o): o is PowerTool => !!o).map(reserve).filter((o) => o.allowed(user));
  return { lectures: [...pris(LECTURES_SA), reserve(BOITE)], ecritures: pris(ECRITURES_SA) };
}

/** L'écriture d'Adam, exécutée à la CONFIRMATION de sa carte — revérifie tout (Super Admin principal, droit de l'outil). */
export async function executerEcritureAdam(nom: string, entree: Record<string, unknown>, user: UtilisateurOutil): Promise<{ ok: boolean; message: string }> {
  if (!ECRITURES_SA.includes(nom)) return { ok: false, message: "Action inconnue." };
  const o = PAR_NOM.get(nom);
  if (!o) return { ok: false, message: "Cette action n'existe plus." };
  const r = reserve(o);
  if (!r.allowed(user)) return { ok: false, message: REFUS_HORS_SA };
  return { ok: true, message: await r.run(entree, user) };
}

/** Le libellé d'un outil d'Adam (la carte, le journal). */
export const libelleAdam = (nom: string): string => (nom === OUTIL_BOITE ? BOITE.label : PAR_NOM.get(nom)?.label ?? nom);

/** Tous les noms du catalogue d'Adam — pour le test qui exige que chacun soit classé. */
export const nomsDuCatalogueAdam = (): string[] => POWER_TOOLS.map((t) => t.def.name);
