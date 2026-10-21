import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ORDRE_NON_ANNULE } from "@/lib/payments/authorization";
import { aiConfigured, sttConfigured, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { realtimeVoiceConfigured, canUseRealtimeVoice } from "@/lib/assistant/voice-realtime";
import { featureEnabled, FEATURES } from "@/lib/features";
import { getActionCenter } from "@/lib/queries/action-center";
import { ensurePrimaryThread, getThreadMessages } from "@/lib/assistant-memory";
import { inProcessPlatform, principalOf } from "@/platform/in-process/adapter";
import { composerInbox } from "@/platform/in-process/inbox/compose";
import { aTrancher } from "@/lib/assistant/inbox/model";
import { ChiefWorkspace } from "@/components/chief/chief-workspace";
import { BlockPreviewPlanche } from "@/components/chief/workspace/preview-planche";
// La feuille de style d'Adam était importée par le layout `(chief)`. Ce layout n'existe plus —
// Adam est un MODULE — donc elle est importée là où elle sert : sa page.
import "../../chief.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Adam — Chief of Staff" };

/**
 * LE BUREAU D'ADAM.
 *
 * Ce n'est PAS un second assistant : c'est le même moteur — mémoire, actions confirmées, voix,
 * pièces jointes — servi à quelqu'un qui pilote l'entreprise. Le mode exécutif s'active PAR LE
 * RÔLE, côté serveur ; cette page n'accorde rien, elle ouvre une porte.
 *
 * CE QUI A CHANGÉ DANS CETTE VERSION, et pourquoi.
 *
 * L'ancienne page vivait dans la coque de l'ERP et empilait, AU-DESSUS de la conversation :
 * une ligne de titre avec une phrase de présentation, un bandeau « Aujourd'hui » de quatre
 * pastilles chiffrées, et le point du matin. Trois bandeaux avant d'atteindre le champ de
 * saisie — plus le menu latéral, la barre supérieure et la barre d'onglets du layout ERP.
 *
 * Tout cela disparaît, et rien ne se perd :
 *
 *   • la PHRASE DE PRÉSENTATION est supprimée. Elle décrivait le produit à quelqu'un qui
 *     l'utilise tous les jours.
 *   • les COMPTEURS D'AUJOURD'HUI descendent dans l'écran d'accueil, sous « ce qui t'attend »,
 *     et ne s'affichent QUE s'il y a quelque chose. Un compteur à zéro n'informe personne.
 *   • le POINT DU MATIN n'est plus versé d'office : c'est une réponse, et une réponse se
 *     demande. L'amorce « Obtenir un résumé » le déclenche en un geste.
 *
 * Le résultat : en arrivant, le PDG voit une salutation, une question, et de la place.
 */
export default async function ChiefOfStaffPage({
  searchParams,
}: {
  searchParams?: { q?: string; ref?: string; call?: string; apercu?: string };
}) {
  const user = await requireModule("CHIEF_OF_STAFF");
  // Adam n'est visible que du Super Admin (§118.153) — la Direction garde le module, pas Adam.
  if (!peutVoirAdam(user)) notFound();

  // LA PLANCHE DE RENDU, le temps d'une revue visuelle — et jamais en production.
  //
  // Les blocs de l'espace de travail n'apparaissent qu'au bout d'un vrai tour de conversation,
  // donc d'un appel IA que la suite E2E s'interdit : sans planche, la revue exigée par la mission
  // ne porterait que sur l'écran d'accueil vide. `ADAM_BLOCK_PREVIEW` n'est posée que par la
  // configuration Playwright ; sans elle, ce paramètre ne fait rien du tout.
  //
  // Elle est branchée ICI, après la garde, plutôt que sur une route à elle : une page séparée
  // aurait dû refaire son propre contrôle de droits — donc importer l'ERP une fois de plus, ce
  // que le cliquet de frontière refuse. Adossée au bureau d'Adam, elle hérite de ses gardes.
  if (process.env.ADAM_BLOCK_PREVIEW === "1" && searchParams?.apercu === "blocs") {
    return <BlockPreviewPlanche />;
  }

  const memoryEnabled = user.impersonatedBy
    ? false
    : await featureEnabled(FEATURES.ASSISTANT_MEMORY.key, user.id);

  // LE FIL PRINCIPAL : une conversation CONTINUE par personne — elle s'ouvre d'office au lieu
  // de repartir de « chat n°47 ».
  const primaryThreadId = memoryEnabled ? await ensurePrimaryThread(user.id).catch(() => null) : null;
  /**
   * LES DERNIERS TOURS, RENDUS ICI — le retour n'est plus un rechargement.
   *
   * L'écran peignait l'accueil, puis un aller-retour client allait relire une conversation qui
   * était DÉJÀ en base, puis la remplaçait : trois états visibles pour rouvrir ce qu'on venait
   * de quitter. Chargés côté serveur, les tours sont là au premier octet. Le chargement client
   * reste, pour ouvrir un AUTRE fil depuis l'historique — c'est son seul emploi.
   */
  const primaryMessages = primaryThreadId
    // UNE FENÊTRE, PAS TOUT LE FIL. Le plafond de la mémoire est de 300 messages : les rendre
    // au premier octet ferait payer six mois de conversation pour revoir les trois derniers
    // échanges. Quarante suffisent à retrouver où l'on en était ; le passé lointain se retrouve
    // par l'historique et par `recall_conversation`, qui existent pour ça.
    // `avecWorkspace` : c'est ICI qu'on rend un écran, donc ici qu'on paie la colonne — la voix,
    // qui ne lit que le texte, ne la sélectionne pas.
    ? await getThreadMessages(user.id, primaryThreadId, 40, { avecWorkspace: true }).catch(() => null)
    : null;

  // CE QUI ATTEND UNE DÉCISION. Quatre compteurs bon marché ; le détail vit dans les outils.
  // Chacun devient une PHRASE qu'Adam peut traiter, pas un lien vers un autre écran : on ne
  // sort pas du bureau d'Adam pour savoir ce qu'Adam sait déjà.
  const now = new Date();
  const [toDecide, centreAwaiting, commitmentsLate, decisionsToReview, boite] = await Promise.all([
    getActionCenter(user).then((c) => c.items.length).catch(() => 0),
    prisma.expenseOrder.count({ where: { centralStatus: "AWAITING", ...ORDRE_NON_ANNULE } }).catch(() => 0),
    prisma.executiveCommitment.count({ where: { ownerId: user.id, status: "OPEN", dueAt: { lt: now } } }).catch(() => 0),
    prisma.executiveDecision.count({ where: { ownerId: user.id, status: { in: ["PROPOSED", "DECIDED"] }, reviewDate: { lte: now } } }).catch(() => 0),
    // LA BOÎTE DE DÉCISION, composée par le même code que sa page : le nombre affiché ici est
    // exactement le nombre de cartes qui attendent un geste là-bas (§21) — pas une seconde formule.
    composerInbox(user).then((v) => aTrancher(v.compte)).catch(() => 0),
  ]);
  const inbox = { count: boite, href: "/chief-of-staff/inbox" };

  const attention = [
    { count: toDecide, label: "décision(s) à prendre", prompt: "Sur quoi dois-je me concentrer ce matin ?" },
    { count: centreAwaiting, label: "paiement(s) au centre", prompt: "Quels paiements attendent au centre de paiement ?" },
    { count: commitmentsLate, label: "engagement(s) en retard", prompt: "Quels engagements sont en retard ?" },
    { count: decisionsToReview, label: "décision(s) à revoir", prompt: "Quelles décisions sont à revoir ?" },
  ];

  // ENTRÉE CONTEXTUELLE : « Demander à Adam » depuis une fiche arrive ici avec la question
  // (?q=…) ou la référence du dossier (?ref=…) — pré-remplie, jamais envoyée seule.
  const q = typeof searchParams?.q === "string" ? searchParams.q.slice(0, 500) : "";
  const ref = typeof searchParams?.ref === "string" ? searchParams.ref.slice(0, 120) : "";
  const realtimeVoice = realtimeVoiceConfigured() && canUseRealtimeVoice(user);
  const startCall = searchParams?.call === "1" && realtimeVoice;
  const initialPrompt = startCall
    ? null
    : q || (ref ? `Donne-moi toute l'histoire de ${ref} : statut, validateurs, blocages, prochaine étape.` : null);

  // L'ÉTAT DES DONNÉES, en un point et deux mots. Sans clé IA, Adam ne peut rien lire : le dire
  // franchement vaut mieux qu'un point vert qui ment.
  const configured = aiConfigured();
  const freshness = configured
    ? ({ label: "À jour", tone: "ok" } as const)
    : ({ label: "IA non configurée", tone: "off" } as const);

  return (
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ADAM EST UN MODULE — et il vit dans la coque de l'ERP.
     *
     * CE QUI CHANGE, ET POURQUOI. Le bureau d'Adam avait son propre groupe de routes,
     * `(chief)`, dont le layout retirait délibérément les neuf éléments de chrome de l'ERP :
     * menu latéral, barre supérieure, barre d'onglets mobile, palette de commandes, bandeaux.
     * L'intention était bonne — « entrer chez Adam, pas ouvrir un onglet de plus » — et le prix
     * était le suivant : il n'y avait AUCUNE façon d'aller dans un autre module. On en sortait
     * par une icône de 44 px repliée dans un coin, ou par le bouton « précédent » du navigateur.
     * Le dirigeant l'a tranché : Adam doit s'atteindre et se quitter comme n'importe quel
     * module, par le menu de gauche.
     *
     * CE QUI NE SE PERD PAS. `CHIEF_OF_STAFF` était déjà dans le catalogue de navigation
     * (`lib/labels.ts`) : le menu latéral le liste sans une ligne de plus, sous sa garde de
     * module. `UploadProvider` et `CallProvider` — les deux seules pièces que `(chief)` portait
     * en propre — vivent déjà dans le layout de l'ERP, au même niveau et pour la même raison :
     * naviguer pendant un appel ne démonte pas la session WebRTC.
     *
     * ET LA HAUTEUR. `app-viewport-flush` s'arrête au ras de la barre d'onglets à partir de
     * hauteurs MESURÉES (`chrome-metrics.tsx`), et les marges négatives neutralisent le padding
     * de la coque pour que la conversation touche les bords — exactement ce que fait la page
     * Assistant. Écrire une hauteur en dur mettrait le composeur derrière la barre sur
     * téléphone, ce qui est déjà arrivé.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    <div className="chief-root app-viewport-flush -mx-3 -mt-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 lg:-mx-8">
    <ChiefWorkspace
      userName={user.name}
      configured={configured}
      messageIaNonConfiguree={phraseIaNonConfiguree(cleModeleRequise(), "l'assistant")}
      voiceConfigured={sttConfigured()}
      realtimeVoice={realtimeVoice}
      memoryEnabled={memoryEnabled}
      initialPrompt={initialPrompt}
      initialThreadId={primaryThreadId}
      initialMessages={primaryMessages}
      initialCallRef={startCall ? ref || "" : null}
      settingsHref={hasGlobalView(user) ? "/chief-of-staff/reglages" : null}
      attention={attention}
      inbox={inbox}
      freshness={freshness}
    />
    </div>
  );
}
