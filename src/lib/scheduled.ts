import { prisma } from "@/lib/prisma";
import { clauseSalairesVersesANotifier } from "@/lib/hr/virement-paie";
import { instantDuCentreDePaie } from "@/lib/hr/paie-centre";
import { declencherRecurrencesStock } from "@/lib/stocks/recurrence-runner";
import { relancerReceptionsStock } from "@/lib/promo-stock-rappels";
import { alerterStock, declencherComptagesRecurrents } from "@/lib/promo-stock-comptages";
import { notifyUser } from "@/lib/notify";
import { performAiHealthCheck } from "@/lib/ai-health";
import { runDueRegulatoryJobs } from "@/lib/regulatory/intelligence/jobs/runner";
import { catchUpMissingAiReviews, catchUpStalledPipelines, expireStaleBatches } from "@/lib/regulatory/intelligence/jobs/catchup";
import { pruneStaleUploadSessions, purgeClosedSessionParts } from "@/lib/regulatory/intelligence/upload/session";
import { nettoyerDepotsDirectsPerimes } from "@/lib/drive/depot-direct";
import { runAnppWatchIfDue } from "@/lib/regulatory/intelligence/corpus/watch-schedule";
import { pollAiBatches } from "@/lib/regulatory/intelligence/cost/batch-runner";
import { embedBacklog } from "@/lib/regulatory/intelligence/corpus/semantic";
import { runIntelligencePulse } from "@/lib/adventum/pulse";
import { runBrainBriefingIfDue } from "@/lib/brain-briefing";
import { runPettyCashRechargeReminders } from "@/lib/actions/petty-cash-actions";
import { runLegalExpirySweep } from "@/lib/legal/expiry-sweep";
import { runPchDeadlineSweep } from "@/lib/pch/deadline-sweep";
import { runSfeFieldSweep } from "@/lib/sfe-sweep";
import { rafraichirKpiSiDu } from "@/lib/kpi/service";
import { analyserInfluenceSiDu } from "@/lib/influence-luna";
import { runAssistantReminders } from "@/lib/assistant/reminders";
import { runDriveIngestionSweep } from "@/lib/assistant/drive-ingestion";
import { balayerMentions } from "@/lib/fabric";
import { rechaufferAlertes } from "@/lib/assistant/hot-alerts";
import { balayageQualiteSiDu } from "@/lib/quality/engine";
import { mettreEnCacheClausesSiDu } from "@/platform/in-process/intelligence";
import { viderFile as viderFileSiteWeb } from "@/lib/site-web/file";
import { rapprocherSiteSiDu } from "@/lib/site-web/reconciliation";
import { entretenirLiaison as entretenirLiaisonSiteWeb } from "@/lib/site-web/liaison";
import { purgerAudienceSiDu } from "@/lib/site-web/audience-collecte";
import { runKnowledgeSweep, enqueueBacklogs, enqueueStalled, refreshEntityIndex } from "@/lib/knowledge/worker";
import { runScheduledWorkflows } from "@/lib/scheduler/runner";
import { registerBuiltinWorkflows } from "@/lib/scheduler/handlers";
import { runAdamInboxSweep } from "@/lib/google/gmail/reconcile";
import { balayerMissions } from "@/platform/in-process/missions/sweep";
import { balayerSurveillances } from "@/platform/in-process/missions/watch";
import { vieillirMemoire } from "@/platform/in-process/missions/memory";
import { relancerEngagements } from "@/platform/in-process/missions/commitments";
import { assurerProduitsDesDossiersAuDemarrage } from "@/lib/products/canonique";
import { etape } from "@/lib/scheduler/etape";

/**
 * Tâches périodiques **sans cron externe** : déclenchées (au plus une fois par minute,
 * grâce à un verrou de débounce) depuis un point chaud déjà sollicité régulièrement par
 * les clients connectés (le polling de la messagerie). Tant qu'au moins un utilisateur est
 * actif, ces tâches tournent ; les rappels arrivent en cloche **et en push** (donc même
 * sur le téléphone d'un destinataire hors-ligne). Zéro configuration côté hébergeur.
 */

const DEBOUNCE_MS = 60_000;
let lastRun = 0;
let running = false;

/**
 * BATTEMENT AUTONOME — l'analyse ne s'arrête plus quand l'utilisateur quitte l'application.
 *
 * Ces tâches n'étaient déclenchées que par les requêtes des clients connectés (polling de la
 * messagerie, écran de progression). C'était un choix « zéro configuration côté hébergeur », mais
 * il avait une conséquence que personne n'accepterait en la connaissant : **fermer l'onglet
 * arrêtait l'analyse en cours**. Un dossier déposé le soir attendait qu'un navigateur veuille bien
 * rouvrir la page le lendemain.
 *
 * Le processus Node bat donc tout seul, armé au PREMIER chargement de ce module — c'est-à-dire à
 * la première requête servie après un démarrage. Ensuite, plus personne n'a besoin d'être là.
 * (L'armement au démarrage via `instrumentation.ts` serait plus direct, mais ce fichier est aussi
 * compilé pour le runtime Edge, où la chaîne serveur — IMAP, agents HTTP — ne se résout pas.)
 *
 * Le verrou de débounce ci-dessus reste seul juge : un battement qui tombe pendant qu'un passage
 * déclenché par un clic travaille encore ne fait rien. `unref()` garantit que le minuteur
 * n'empêche jamais un arrêt propre du processus lors d'un déploiement.
 *
 * ⚠️ Un hébergeur qui met l'instance en veille faute de trafic suspend aussi ce battement : le
 * travail reprend au réveil (rien n'est perdu — les jobs vivent en base), mais il ne progresse pas
 * pendant la veille. C'est le seul cas où l'analyse marque une pause sans personne connecté.
 */
const TICK_MS = Math.max(15_000, Number(process.env.SCHEDULER_TICK_MS ?? 60_000));

function armHeartbeat(): void {
  if (process.env.SCHEDULER_DISABLED === "1") return; // soupape, sans redéploiement de code
  // Jamais pendant les TESTS (chaque fichier importerait ce module et lancerait le planificateur
  // complet sur la base de test), ni pendant la COMPILATION (le build importe les modules serveur
  // pour pré-rendre les pages : il n'a aucune tâche de fond à exécuter).
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const timer = setInterval(() => {
    void runScheduledJobs().catch((e) => console.error("[scheduler] battement échoué", e));
  }, TICK_MS);
  timer.unref?.();
}
armHeartbeat();

/**
 * CHAQUE BALAYAGE PORTE SON `.catch` (audit performance, PERF-03). Ils tournent EN SÉRIE : une
 * exception non rattrapée d'un des premiers (rappels de réunion, paie…) remontait au `try` global et
 * sautait TOUS les suivants — missions durables, file du site public, alertes de stock, Gmail d'Adam —
 * à chaque battement, tant que la cause durait. `scheduled-isolation.test.ts` le tient.
 */
const journal = (etape: string) => (e: unknown) => {
  console.error(`[scheduled] ${etape} a échoué`, e);
};

/** Durée d'un passage complet au-delà de laquelle il se signale : il retient le battement et le pool. */
const PASSAGE_LENT_MS = Math.max(1_000, Number(process.env.SCHEDULER_SLOW_RUN_MS ?? 30_000));

/** Lance les tâches dues, au plus une fois par minute (process-wide). Ne lève jamais. */
export async function runScheduledJobs(): Promise<void> {
  const now = Date.now();
  if (running || now - lastRun < DEBOUNCE_MS) return;
  running = true;
  lastRun = now;
  try {
    await etape("sendDueMeetingReminders", sendDueMeetingReminders);
    await etape("sendDueReminders", sendDueReminders);
    await etape("sendDuePayrollNotifications", sendDuePayrollNotifications);
    await etape("accrueMonthlyLeave", accrueMonthlyLeave); // +2,5 j/mois (idempotent)
    // PRODUIT = DOSSIER (Direction, 08/10) : UNE fois par processus, chaque dossier non verrouillé reçoit
    // son produit — l'existant rejoint la règle des nouveaux. Idempotent ; le bilan part au journal du serveur.
    await etape("assurerProduitsDesDossiersAuDemarrage", assurerProduitsDesDossiersAuDemarrage);
    await etape("performAiHealthCheck", performAiHealthCheck); // test IA 1×/jour + alerte Super Admin
    await etape("runDueRegulatoryJobs", runDueRegulatoryJobs);
    await etape("pruneStaleUploadSessions", pruneStaleUploadSessions); // nettoyage des sessions d'upload incomplètes
    await etape("purgeClosedSessionParts", purgeClosedSessionParts); // filet : octets d'envois clos qu'un redémarrage aurait laissés
    await etape("nettoyerDepotsDirectsPerimes", nettoyerDepotsDirectsPerimes); // envois directs au bucket jamais terminés : parties libérées
    await etape("runAnppWatchIfDue", runAnppWatchIfDue); // veille ANPP 1×/jour : une ligne directrice ne doit pas changer sans qu'on le sache
    await etape("pollAiBatches", pollAiBatches); // analyses différées (moitié prix) : récupère les lots terminés
    // Rattrapage de l'EXISTANT : les dossiers déjà en base profitent des mêmes règles que les
    // nouveaux — revue de fond jamais livrée, ou pipeline arrêté en chemin. Bornés par passage.
    await etape("expireStaleBatches", expireStaleBatches); // lots fantômes : sinon l'écran dit « sous 24 h » à vie
    await etape("catchUpStalledPipelines", catchUpStalledPipelines);
    await etape("catchUpMissingAiReviews", catchUpMissingAiReviews);
    await etape("embedBacklog", embedBacklog); // vecteurs sémantiques : un paquet par passage, jamais plus
    await etape("runIntelligencePulse", runIntelligencePulse); // Adventum Pulse : instantané horaire (Brain + Process Intelligence) + alerte proactive
    // LE BRIEFING DU MATIN d'Adventum Brain : une fois par jour, à 7 h (Alger), APRÈS la passe horaire qui vient de
    // réconcilier les risques — il les lit, il ne les recalcule pas.
    await etape("runBrainBriefingIfDue", runBrainBriefingIfDue);
    // LES ROUTINES DE L'ASSISTANT IA : celles que chaque personne a programmées (« un briefing chaque dimanche à 8 h »).
    // Lecture seule, sous ses droits relus au passage ; chargé à l'appel (la chaîne du modèle ne pèse que si elle sert).
    await etape("executerRoutinesDues", () => import("@/lib/agent/routines/service").then((m) => m.executerRoutinesDues()));
    // LE FIL GARDÉ DE L'ASSISTANT IA : un message resté en file, un tour coupé par un redémarrage — repris.
    await etape("reprendreLesFils", () => import("@/lib/agent/fil/service").then((m) => m.reprendreLesFils()));
    // Caisse d'avance : prévenir les RH 48 h AVANT le rechargement mensuel. Prévenir le jour
    // même ne sert à rien — sortir la somme demande une préparation. Idempotent par échéance.
    await etape("runPettyCashRechargeReminders", runPettyCashRechargeReminders);
    // Échéances des engagements (contrats, BC, assurances, baux) : aligne le statut d'un terme
    // passé, et prévient À L'ENTRÉE dans une zone d'urgence (90 j, 30 j, dépassement) — pas tous
    // les jours, sinon la personne coupe les notifications et rate la vraie.
    await etape("runLegalExpirySweep", runLegalExpirySweep);
    // RÉCURRENCES DE DEMANDE D'ÉTAT DE STOCK : le directeur des opérations pose une fois « le 1er
    // de chaque mois, Karim relève ses trois hôpitaux », et la demande repart seule. Elle est ICI
    // et non dans le registre des planifications, dont l'en-tête interdit toute écriture avec
    // raison (`mutates: false`) : là-bas la clé est choisie par un humain ou proposée par un
    // modèle, ici l'effet est écrit en revue de code et ne varie pas.
    await etape("declencherRecurrencesStock", declencherRecurrencesStock);
    // STOCK PROMOTIONNEL (§118.164) : une dotation n'entre chez le délégué qu'à SA confirmation.
    // Au troisième jour sans confirmation, une relance — une seule — part vers celui qui doit
    // confirmer. Ici pour la même raison que les récurrences : c'est un EFFET écrit en revue de code.
    await etape("relancerReceptionsStock", relancerReceptionsStock);
    // STOCK PROMOTIONNEL, ÉTAPE 5 (§118.168) : les comptages récurrents que le directeur des
    // opérations a posés (autorité de l'auteur RELUE à chaque déclenchement, jamais de rattrapage),
    // puis les alertes — une fois l'heure, à l'ENTRÉE dans un état (seuil, rupture, péremption à
    // trente jours, lot périmé en main, envoi non confirmé, comptage en retard), une notification
    // par personne. Ici pour la même raison : ce sont des EFFETS écrits en revue de code.
    await etape("declencherComptagesRecurrents", declencherComptagesRecurrents);
    await etape("alerterStock", alerterStock);
    // Échéances de DÉPÔT des marchés PCH : responsable + équipe prévenus à J-7, J-2 et au
    // dépassement — le rappel se tait dès que la soumission est déposée.
    await etape("runPchDeadlineSweep", runPchDeadlineSweep);
    // FORCE DE VENTE : alertes de supervision (silence, retard à mi-mois, couverture, KAM non
    // armé) — une par type et par mois, jamais une par nuit —, instantané mensuel de chaque KAM
    // (le mois clos ne se recalcule plus) et revue au passage du mois.
    await etape("runSfeFieldSweep", runSfeFieldSweep);
    // KPI & BILANS (KPI sans code, Direction 08/10 : « bilan en continu ») : une fois par jour, la période courante de
    // chacun est recalculée et mise en cache — le calcul à la demande reste là entre deux passages.
    await etape("rafraichirKpiSiDu", rafraichirKpiSiDu);
    // INTELLIGENCE TERRAIN (console d'administration, Super Admin seul) : une fois par jour, les liens structurels et les
    // scores d'influence se recalculent, et Luna lit les rapports NOUVEAUX depuis le filigrane (liens PROPOSÉS, jamais appliqués).
    await etape("analyserInfluenceSiDu", analyserInfluenceSiDu);
    // Rappels du Chief of Staff : « rappelle-moi mardi à 10 h », « tous les dimanches relance
    // Regulatory » — pop-up au propriétaire, relance du rôle cible s'il y en a un.
    await etape("runAssistantReminders", runAssistantReminders);
    // Ingestion Drive : un paquet de fichiers indexés (texte + classification) par passage —
    // un document mal nommé jamais ouvert devient trouvable par son CONTENU. L'ACL se
    // revérifie à la recherche, nœud par nœud. Débrayage : ASSISTANT_DRIVE_INGESTION=off.
    await etape("runDriveIngestionSweep", runDriveIngestionSweep);
    // Mentions d'entités (fabric F4) : le RATTRAPAGE des fichiers indexés AVANT que
    // l'extraction existe. Les nouveaux fichiers sont extraits à l'ingestion même ; ce
    // balayage borné vide le reste-à-faire (`mentionsAt: null`), un lot par passage.
    await etape("balayerMentions", balayerMentions);
    // États chauds (fabric F5) : les signaux exécutifs des dirigeants RÉCEMMENT ACTIFS se
    // recalculent ici, en avance — la question « qu'est-ce qui cloche ? » trouve un état
    // déjà payé, avec son instant de calcul et son coût mesurés.
    await etape("rechaufferAlertes", rechaufferAlertes);
    // QUALITÉ DES DONNÉES (mandat 4 §23) : les règles LÉGÈRES (doublons de factures, montants
    // contradictoires, statuts de paiement impossibles, comptes actifs de salariés partis) toutes
    // les heures ; le balayage COMPLET la nuit. Les corrections SÛRES s'appliquent seules et se
    // journalisent ; le reste attend une personne — dans la boîte de décision et l'écran d'admin.
    await etape("balayageQualiteSiDu", balayageQualiteSiDu);
    // INTELLIGENCE LEGAL (mandat 4 §27) : les clauses des engagements actifs dont le texte indexé a
    // changé sont relues une fois par jour et mises en réserve dans `custom.intelligence` — les
    // lectures du jour (Adam, boîte de décision) trouvent des clauses déjà lues au lieu de les relire.
    await etape("mettreEnCacheClausesSiDu", mettreEnCacheClausesSiDu);
    // SITE PUBLIC ADVENTUM (§118.158) : la file d'envoi des offres d'emploi et des articles, puis
    // la réconciliation quotidienne (`GET /jobs`, `GET /posts`). Ici et non dans le registre des
    // planifications, pour la raison des récurrences de stock : ce sont des EFFETS (des requêtes
    // qui publient sur un site public), écrits en revue de code, que le registre interdit à juste
    // titre (`mutates: false`). La file est le FILET : les délais courts du contrat (1 s, 5 s,
    // 30 s) sont tenus par un minuteur du processus, et c'est ce passage-ci qui reprend tout ce
    // qui est dû après un redémarrage. Les deux se taisent tant que le site n'est pas relié (clé
    // générée par l'ERP et reconnue par le site — §118.159 —, ou ADVENTUM_API_KEY en repli), et la
    // réconciliation se débraye par SITE_WEB_RECONCILIATION=off.
    // LA LIAISON D'ABORD (§118.159) : une clé en attente que le site vient de reconnaître est promue
    // ici, et la file qui suit part aussitôt avec elle. Puis la santé du site, une fois l'heure.
    await etape("entretenirLiaisonSiteWeb", entretenirLiaisonSiteWeb);
    await etape("viderFileSiteWeb", viderFileSiteWeb);
    await etape("rapprocherSiteSiDu", rapprocherSiteSiDu);
    // AUDIENCE DU SITE (Direction, 07/10) : les événements de plus de 13 mois s'effacent, une fois par jour.
    await etape("purgerAudienceSiDu", purgerAudienceSiDu);

    // LA COUCHE DE CONNAISSANCE — elle avance à son rythme, derrière tout le reste.
    //
    // Placée APRÈS les balayages existants et volontairement modeste : indexer plus vite au
    // prix du service rendu à ceux qui utilisent l'ERP serait un mauvais échange. Si un passage
    // ne finit pas son lot, le suivant reprend là où il en était — rien n'est perdu, et
    // personne n'attend.
    await etape("refreshEntityIndex", refreshEntityIndex);
    await etape("enqueueBacklogs", enqueueBacklogs);
    // Les documents restés muets repassent doucement : un parseur qui s'améliore doit pouvoir
    // rattraper ce qu'il n'avait pas su lire, sinon la correction n'atteint jamais l'existant.
    await etape("enqueueStalled", () => enqueueStalled(5));
    // LES PLANIFICATIONS DE L'UTILISATEUR (§9). Le catalogue est enregistré ici, une fois, plutôt
    // qu'en effet de bord d'import : sinon il dépendrait de l'ordre des imports, donc différerait
    // entre le test, le développement et la production.
    await etape("registerBuiltinWorkflows", registerBuiltinWorkflows);
    await etape("runScheduledWorkflows", runScheduledWorkflows);
    await etape("runKnowledgeSweep", runKnowledgeSweep);
    // LE BATTEMENT D'ADAM — sans navigateur ouvert, sans que le PDG demande quoi que ce soit.
    // Trois gestes : garder l'oreille (renouveler la veille Gmail AVANT expiration), rattraper
    // ce qui est arrivé (histoire incrémentale), et se rattraper soi-même (réconciliation
    // complète toutes les 30 min). C'est ce qui rend « qu'est-ce que j'ai raté ? » possible :
    // le push Pub/Sub est rapide mais fragile, et un message perdu est un SILENCE, pas une
    // erreur — personne ne s'en apercevrait. Sans connexion Google, c'est un no-op.
    // Débrayages : suspension du traitement entrant (réglages), ou connexion en pause.
    await etape("runAdamInboxSweep", runAdamInboxSweep);

    // LES MISSIONS DURABLES — le seul balayage de cette liste qui produise des EFFETS.
    //
    // Il est ici, et non parmi les traitements planifiés, parce que ceux-ci déclarent
    // `mutates: false` en toutes lettres : y ranger l'avancement d'une mission ferait du
    // planificateur un contournement de la politique d'approbation. Ici, chaque effet passe par
    // le chemin canonique — RBAC, intent, reçu, idempotence — et une mission qui attend un
    // accord n'avance pas d'un pouce tant que personne n'a cliqué.
    //
    // C'est CE balayage qui tient la promesse « la mission continue même si vous fermez
    // l'application ». Sans lui, elle s'arrêterait à la fin de la requête qui l'a lancée.
    // Débrayage : MISSIONS_SWEEP=off.
    await etape("balayerMissions", balayerMissions);

    // LES SURVEILLANCES DURABLES — « surveille ce dossier et préviens-moi seulement s'il y a un
    // problème ». Relues à leur cadence et dès qu'un fait les touche (le registre avance leur
    // prochain contrôle) ; seul un changement de signature parle. Même débrayage que les missions.
    await etape("balayerSurveillances", balayerSurveillances);

    // LE VIEILLISSEMENT DE LA MÉMOIRE — le seul des deux mouvements de la mémoire épisodique
    // qui n'ait pas de conversation pour le déclencher.
    //
    // Le DÉCOUPAGE se fait après un échange, quand la matière est fraîche. La DESCENTE de
    // fidélité, elle, dépend du CALENDRIER : un compte silencieux depuis six mois doit voir ses
    // souvenirs se réduire aux faits, sans quoi la compression ne profiterait qu'à ceux qui
    // parlent — c'est-à-dire à ceux dont la mémoire est déjà fraîche et légère.
    //
    // Sans clé de fournisseur, c'est un no-op immédiat : on ne compresse pas un souvenir sans
    // savoir ce qu'il contient, et il n'existe pas de repli déterministe honnête.
    await etape("vieillirMemoire", vieillirMemoire);

    // LES PROMESSES NON TENUES — l'exact inverse du chemin qui marchait déjà.
    //
    // Un engagement se satisfait tout seul quand le fait arrive : `satisfaireEngagements` est
    // appelée par le registre d'événements. Mais quand le fait N'ARRIVE PAS, personne ne
    // repassait : la promesse restait ouverte en silence, et c'est précisément le cas où l'on
    // attend quelque chose d'un assistant.
    //
    // Rien n'est envoyé À LA PERSONNE QUI A PROMIS : on prévient celle qui attend. Écrire à un
    // tiers depuis un battement serait une communication sortante que personne n'a relue.
    await etape("relancerEngagements", relancerEngagements);

  } catch (err) {
    console.error("[scheduled] run failed", err);
  } finally {
    running = false;
    const duree = Date.now() - now;
    if (duree > PASSAGE_LENT_MS) console.warn(`[scheduled] passage lent : ${duree} ms`);
  }
}

/** Année-mois « YYYY-MM » à l'heure d'Alger (UTC+1, sans changement d'heure). */
export function algiersYm(at: number = Date.now()): string {
  const alg = new Date(at + 3_600_000);
  return `${alg.getUTCFullYear()}-${String(alg.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Nombre de mois entiers écoulés de `a` (exclu) à `b` (inclus) au format « YYYY-MM ». */
export function monthsBetweenYm(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  if (!ay || !am || !by || !bm) return 0;
  const diff = (by - ay) * 12 + (bm - am);
  return diff > 0 ? diff : 0;
}

/**
 * Logique **pure** d'acquisition (barème algérien : +2,5 j / mois). Source de vérité unique,
 * réutilisée par le job réel ci-dessous ET par le moteur « Time Travel » du Test Center pour
 * prouver l'idempotence (once-and-only-once). `marker` = dernier mois crédité (« YYYY-MM ») ou
 * null (amorçage sans rétro-crédit) ; renvoie le nouveau marqueur et le crédit à appliquer.
 */
export function accrualStep(marker: string | null, ym: string): { marker: string; credit: number } {
  if (!marker) return { marker: ym, credit: 0 }; // amorçage : on fixe le marqueur, pas de rétro-crédit
  const months = monthsBetweenYm(marker, ym);
  return months <= 0 ? { marker, credit: 0 } : { marker: ym, credit: 2.5 * months };
}

/**
 * Acquisition automatique des congés : **+2,5 j / mois** par employé actif (barème algérien
 * de 30 j/an). Idempotent grâce au marqueur `leaveAccruedThrough` (le dernier mois crédité) :
 * la fonction peut tourner à chaque tick, elle ne crédite qu'au passage d'un nouveau mois.
 * Amorçage sans rétro-crédit : au premier passage on fixe seulement le marqueur au mois courant
 * (le solde manuel existant est préservé), l'acquisition démarre le mois suivant.
 */
async function accrueMonthlyLeave(): Promise<void> {
  const ym = algiersYm();
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: { id: true, leaveAccruedThrough: true },
  });
  for (const e of employees) {
    const { marker, credit } = accrualStep(e.leaveAccruedThrough, ym);
    if (credit === 0 && marker === e.leaveAccruedThrough) continue; // rien à faire (déjà à jour)
    await prisma.employee.update({
      where: { id: e.id },
      data: { leaveAccruedThrough: marker, ...(credit > 0 ? { leaveBalanceDays: { increment: credit } } : {}) },
    });
  }
}

/**
 * Rappels personnels « en un clic » échus : notifie le propriétaire (cloche + push) une seule fois,
 * puis passe le rappel en SENT (il reste dans « Mes rappels » jusqu'à ce que l'utilisateur le traite).
 */
async function sendDueReminders(): Promise<void> {
  const now = new Date();
  const due = await prisma.reminder.findMany({
    where: { status: "PENDING", remindAt: { lte: now } },
    select: { id: true, userId: true, title: true, link: true },
    take: 200,
  });
  for (const r of due) {
    // Verrou atomique : ne notifie qu'une fois même sous concurrence (PENDING → SENT).
    const claimed = await prisma.reminder.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "SENT", sentAt: now } });
    if (claimed.count === 0) continue;
    await notifyUser({ userId: r.userId, type: "GENERIC", title: "Rappel", body: r.title, link: r.link ?? "/mon-espace" }).catch(() => undefined);
  }
}

/**
 * Notifie chaque employé que sa paie a été versée — 24 h AU PLUS TÔT après la saisie par les RH
 * (marge d'annulation en cas d'erreur), et seulement une fois son VIREMENT réglé (§118.176) : la
 * paie passe désormais par le centre de paiement, et « votre salaire a été versé » avant que le
 * centre l'ait autorisé serait la promesse d'un argent qui n'est pas parti. Une seule fois par
 * bulletin. La règle vit dans `hr/virement-paie.ts` (`clauseSalairesVersesANotifier`).
 */
async function sendDuePayrollNotifications(): Promise<void> {
  const now = new Date();
  // Les salaires marqués payés AVANT la bascule ont été versés par l'ancien circuit : ils
  // s'annoncent comme avant, sans virement (§118.176).
  const depuisLeCentre = await instantDuCentreDePaie().catch(() => null);
  const due = await prisma.payrollEntry.findMany({
    where: clauseSalairesVersesANotifier(now, depuisLeCentre),
    include: { employee: { select: { userId: true, fullName: true } } },
    take: 100,
  });
  for (const e of due) {
    const claim = await prisma.payrollEntry.updateMany({
      where: { id: e.id, employeeNotifiedAt: null },
      data: { employeeNotifiedAt: now },
    });
    if (claim.count === 0 || !e.employee.userId) continue;
    await notifyUser({
      userId: e.employee.userId,
      type: "GENERIC",
      title: "Votre salaire a été versé",
      body: `Votre paie de ${String(e.month).padStart(2, "0")}/${e.year} a été versée. La fiche de paie est disponible dans Mon dossier RH.`,
      link: "/mon-dossier",
    }).catch(() => {});
  }
}

const REMINDER_LEAD_MS = 30 * 60_000; // 30 minutes avant le début

/**
 * Rappelle les réunions planifiées qui commencent dans ≤ 30 min (et pas encore passées),
 * une seule fois (reminderSentAt). Notifie l'organisateur + les participants.
 */
async function sendDueMeetingReminders(): Promise<void> {
  const now = new Date();
  const horizon = new Date(now.getTime() + REMINDER_LEAD_MS);

  const due = await prisma.meeting.findMany({
    where: {
      status: "SCHEDULED",
      reminderSentAt: null,
      scheduledAt: { not: null, gt: now, lte: horizon },
    },
    select: {
      id: true, title: true, scheduledAt: true, organizerId: true,
      participants: { select: { userId: true } },
    },
    take: 50,
  });
  if (due.length === 0) return;

  for (const m of due) {
    // Verrou anti-concurrence : seule la 1re mise à jour « gagne » le droit d'envoyer.
    const claim = await prisma.meeting.updateMany({
      where: { id: m.id, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) continue;

    const minutes = m.scheduledAt ? Math.max(1, Math.round((m.scheduledAt.getTime() - now.getTime()) / 60_000)) : 30;
    const recipients = [...new Set([m.organizerId, ...m.participants.map((p) => p.userId)])];
    await Promise.all(recipients.map((userId) =>
      notifyUser({
        userId, type: "DEADLINE_NEAR",
        title: `Réunion dans ${minutes} min`,
        body: m.title,
        link: `/meetings/${m.id}`,
      }),
    ));
  }
}
