/**
 * LA BOUCLE AGENT DIFFUSÉE — le même tour que `boucle/tour.ts`, poussé au navigateur au fil de
 * l'eau (traces, texte, sources, espace de travail).
 */

import { peutPiloterMissionsAdam, type CurrentUser } from "@/lib/assistant/coeur/erp";
import {
  extraireBlocRegles, gardeEnseignement, OUTILS_ENSEIGNEMENT, RAPPEL_ENSEIGNEMENT, DEMENTI_ENSEIGNEMENT,
} from "@/platform/in-process/teach/bloc";
import { faitsDuTour, repondreDouTuTiensCa } from "@/platform/in-process/fabric/provenance";
import { routeVoiceUtterance } from "@/lib/assistant/voice/fast-path";
import {
  consigneCalcul, consignePeriode, consigneProchainGeste, consigneRepresentation, consigneSignaux,
} from "@/lib/assistant/context/router";
import { calibrerTour } from "@/lib/assistant/confidence/tour";
import { resoudreMentions, contexteEntitesResolues } from "@/platform/in-process/fabric/entites";
import type { ClaudeContentBlock } from "@/lib/models/compat";
/**
 * LE CERVEAU A CHANGÉ DE MAISON, PAS CE FICHIER.
 *
 * `callClaude` / `callClaudeStream` viennent désormais de la passerelle modèle : le texte part
 * sur le rôle `orchestrator` (Terra, raisonnement medium) au lieu de l'API Anthropic. Le pont
 * garde EXACTEMENT les signatures et la forme de blocs que la boucle ci-dessous manipule — c'est
 * ce qui permet de changer de fournisseur sans toucher aux 6 200 lignes qui, elles, marchent.
 *
 * Le nom « Claude » subsiste ici comme mémoire de ce qui reste à migrer : le jour où cette
 * boucle parlera la forme neutre, l'import et le pont disparaissent ensemble.
 */
import { callClaudeStream, assistantConfigured as aiConfigured } from "@/lib/models/compat";
import { apercuDesSources } from "@/lib/assistant/workspace/apercu";
import { candidatsMontres, verdictCible, type Candidat } from "@/lib/assistant/cible-designee";
import { recordTool, addPhase, timedPhase, type TurnContext } from "@/lib/models/telemetry";
import {
  avertirAbsenceNonProuvable, avertirPromesseSansObjet, complementDeLimite, OUTILS_DURABLES, gardeAbsence,
  gardeImpossibilite, gardePromesse, RAPPEL_DECOUVERTE, RAPPEL_ELARGISSEMENT, RAPPEL_PROMESSE,
} from "@/lib/assistant/limites";
import { prechargerCapacitesDynamiques } from "@/platform/in-process/skills";
import { planifierPreLectures, executerPreLectures, PRE_LECTURE_MAX_CHARS } from "@/lib/assistant/pre-lectures";
import { composerContexteTour } from "@/lib/assistant/context/tour";
import { safetyIdentifierFor } from "@/lib/models/openai-responses";
import { nativeActionHint } from "@/lib/assistant/action-registry";
// MODE OMBRE (§30) — le nouveau routeur tourne À CÔTÉ de la boucle actuelle, sans jamais
// l'influencer : il note ce que la liste courte AURAIT exposé et le compare à ce que la boucle
// a réellement appelé. C'est cette comparaison, et elle seule, qui autorisera la bascule.
import { recordShadow } from "@/lib/assistant/context/shadow";
// L'ACTIVATION BORNÉE (§1–§4, §26) : lectures canoniques sûres en direct, reste des lectures en
// canary, TOUTES les mutations sur le chemin prouvé. La politique vit dans `rollout.ts` ; ici on
// ne fait que l'appliquer.
import { decideRollout, recordOutcome } from "@/lib/assistant/context/rollout";
import { fitToolBudget, outilsNommes } from "@/lib/assistant/context/tool-shortlist";
import { resolveTools } from "@/lib/assistant/context/tool-resolver";
// L'ESPACE DE TRAVAIL GÉNÉRATIF : la sortie d'une source canonique traduite en blocs TYPÉS.
// Le modèle n'écrit aucun balisage — c'est ce qui empêche l'écran de redevenir un vidage de JSON.
import { composeWorkspace, stripDisplayPayload } from "@/lib/assistant/workspace/compose";
import { collecterLiensInternes, reparerLiensInternes } from "@/lib/assistant/link-repair";
import { runDiscovery, DISCOVERY_TOOL_NAME } from "@/lib/assistant/context/discovery";
import { powerToolLabels } from "@/lib/assistant/power-tools";
import { conversationWorkingSet, isHighStakesQuestion, queryPlan, queryPlanContext } from "@/lib/assistant/reasoning";
import { persistActionIntents, recentActionIntentsContext, retirerCaduquesAvantLeTour } from "@/lib/assistant/action-intents";
import { verdictEmpreinte } from "@/lib/mutations/empreinte";
import { sansBloquer } from "@/lib/journal";
import type { ChatTurn, ProposedAction, AssistantMetrics, AssistantResult } from "@/lib/assistant/coeur/contrat-actions";
import { WRITE_TOOL_NAMES, RESOLVER_WRITE_NAMES, assistantToolsFor } from "@/lib/assistant/outils/catalogue-ecriture";
import { assistantIdentityContext, systemPrompt } from "@/lib/assistant/coeur/prompt";
import { executeReadTool } from "@/lib/assistant/outils/lecture";
import { buildProposal } from "@/lib/assistant/propositions/construire";
import {
  fastReadSystem, observeRollout, READ_LABEL, MAX_TURNS, toMessages, textOf, CRITIQUE_LABEL, TEACH_GARDE_LABEL,
  DECOUVERTE_LABEL, ELARGISSEMENT_LABEL, PROMESSE_LABEL, PROVENANCE_LABEL, CRITIQUE_MIN_DRAFT, reviseHighStakes,
  effortPourNiveau, salutationSystem, outilsCreesParmi, avecOutilsDeclares,
} from "@/lib/assistant/boucle/commun";
import {
  type AssistantStreamEvent, extractSources, carteDuProchainGeste, sourcesDuResultat, resolveSpokenMailApproval,
} from "@/lib/assistant/boucle/sources";

export async function runAssistantStreamImpl(
  user: CurrentUser,
  history: ChatTurn[],
  emit: (e: AssistantStreamEvent) => void,
  opts: { model?: string; personalContext?: string | null; origin?: "text" | "voice" | "nudge"; turnContext?: TurnContext } = {},
): Promise<AssistantResult> {
  if (!aiConfigured()) return { configured: false, ok: false, reply: "", trace: [] };

  const messages = toMessages(history);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return { configured: true, ok: false, reply: "", trace: [], error: "Message utilisateur manquant." };
  }

  // Mêmes injections que la variante simple : contexte personnel + ENTITÉS ACTIVES du fil
  // + PLAN DE LA QUESTION (suivi elliptique compris) + ACTIONS RÉCENTES (état canonique).
  const workingSet = conversationWorkingSet(history);
  const question = String(messages[messages.length - 1]?.content ?? "");

  // LES TROIS LECTURES DE CONTEXTE PARTENT ENSEMBLE — actions récentes, accord en attente,
  // identité d'envoi. Elles étaient en file : trois allers-retours de base avant le premier
  // appel de modèle, c'est-à-dire avant le premier mot. Mesuré en phase « contexte ».
  const tCtx = Date.now();
  // Même règle qu'en non-streaming, et pour la même raison : le retrait précède le modèle.
  const perimees = await retirerCaduquesAvantLeTour(user.id, String(messages[messages.length - 1]?.content ?? ""));
  const [intentsCtx, spoken, identite] = await Promise.all([
    recentActionIntentsContext(user.id).catch(sansBloquer("assistant.runAssistantStreamImpl.recentActionIntentsContext", null)),
    // UN ACCORD CONCLUT — même règle qu'en variante non diffusée, et pour la même raison : c'est
    // le serveur qui sait quelle intention attend, et c'est lui qui l'expédie.
    resolveSpokenMailApproval(user, question).catch(sansBloquer("assistant.runAssistantStreamImpl.resolveSpokenMailApproval", null)),
    assistantIdentityContext(user).catch(sansBloquer("assistant.runAssistantStreamImpl.assistantIdentityContext", null)),
  ]);
  addPhase("contexte", Date.now() - tCtx);
  if (spoken) {
    const reply = spoken.ok ? (spoken.message ?? "Envoyé.") : (spoken.error ?? "Envoi impossible.");
    emit({ type: "delta", text: reply });
    return { configured: true, ok: true, reply, trace: [], metrics: { ttftMs: 0, turns: 0, toolCalls: 0, toolErrors: 0, toolLatencyMs: 0 } };
  }

  // ── « D'OÙ TU TIENS ÇA ? » — LE CODE RÉPOND, DEPUIS LE REGISTRE DES LECTURES (F8) ──────────
  // Une provenance paraphrasée par un modèle serait une provenance inventée à moitié : aucun
  // appel ici. La lecture est indexée et cloisonnée par personne ; ce tour ne consigne rien.
  if (routeVoiceUtterance(question).kind === "PROVENANCE") {
    const p = await repondreDouTuTiensCa(user.id, question, { threadId: opts.turnContext?.threadId ?? null });
    console.info("[assistant] provenance", { userId: user.id, ms: p.ms, faits: p.faits.length, cible: p.cible, toursLus: p.toursLus });
    emit({ type: "trace", label: PROVENANCE_LABEL });
    emit({ type: "delta", text: p.texte });
    return { configured: true, ok: true, reply: p.texte, trace: [PROVENANCE_LABEL], provenance: null, metrics: { ttftMs: p.ms, turns: 0, toolCalls: 0, toolErrors: 0, toolLatencyMs: p.ms } };
  }

  const highStakes = isHighStakesQuestion(question);
  const tPlan = Date.now();
  const plan = queryPlan(question, history.filter((h) => h.role === "user").slice(0, -1).map((h) => h.content));
  addPhase("plan_question", Date.now() - tPlan);
  // LES ENTITÉS DE LA QUESTION, RÉSOLUES PAR LE CODE (fabric F9) : « Hetero » devient UNE ligne,
  // « Nadir » devient une question quand deux Nadir existent — le modèle reçoit des identifiants
  // certains et l'ordre de demander quand c'est ambigu, au lieu de deviner.
  const entitesResolues = plan.entites.length
    ? await timedPhase("entites", () => resoudreMentions(plan.entites).then(contexteEntitesResolues).catch(sansBloquer("assistant.runAssistantStreamImpl.resoudreMentions", null)))
    : null;
  const planCtx = [queryPlanContext(plan), entitesResolues, consigneCalcul(question), consignePeriode(question), consigneRepresentation(question), consigneSignaux(question), consigneProchainGeste(question)].filter(Boolean).join("\n\n") || null;
  // ── CE QUE NOTRE CONSIGNE NOMME, LE TOUR L'OUVRE (§118.122) ──────────────────────────────
  // Mesuré : `consigneSignaux` et `consignePeriode` nomment 15 outils que la liste courte de
  // leurs propres questions n'expose pas. Le modèle va alors les chercher — six appels de
  // découverte, 54 schémas → 241, le prompt de 13 700 à 55 286 jetons avec 0 % de cache, et
  // `what_changed` (l'outil que la consigne nommait) écarté au plafond du fournisseur.
  //
  // On ne lit QUE ce que notre code ÉCRIT : `planCtx` (plan de requête, entités résolues,
  // consignes) et l'indice natif. Ni la question, ni le jeu de travail, ni le contexte personnel
  // — un document peut contenir un nom d'outil, et le contenu d'un document est une DONNÉE,
  // jamais une instruction (§118.7). La conséquence serait ici un simple surcoût, pas une
  // faille ; la frontière se tient quand même.
  const indiceNatif = nativeActionHint(question);
  const epingles = outilsNommes([planCtx, indiceNatif].filter(Boolean).join("\n"));
  // OBSERVABILITÉ du planner — domaine/intention/suivi UNIQUEMENT (jamais le texte de la
  // question) : le taux de résolution des suivis elliptiques se lit dans les logs.
  if (plan.domaine || plan.intention || plan.suiviElliptique) {
    console.info("[assistant] query_plan", {
      userId: user.id, domaine: plan.domaine, intention: plan.intention,
      suiviElliptique: plan.suiviElliptique, historique: plan.besoinHistorique, investigation: plan.besoinInvestigation,
    });
  }
  // QUI IL EST ET DEPUIS QUELLE ADRESSE IL ÉCRIT — lu ci-dessus, avec les autres lectures.
  // LE PRÉFIXE STABLE : consignes + identité. Tout ce qui change à chaque message part avec le
  // message (context/tour.ts) — c'est ce qui rend le cache de prompt effectif sur les outils et
  // l'historique, pas seulement sur le début des consignes.
  const tSys = Date.now();
  const system = [systemPrompt(user), identite].filter(Boolean).join("\n\n");
  addPhase("consignes", Date.now() - tSys);
  const contexteTour = composerContexteTour([
    opts.personalContext ? `CONTEXTE PERSONNEL\n${opts.personalContext}` : null,
    workingSet,
    planCtx,
    // PRIORITÉ AU NATIF : si la demande correspond à un bouton métier de l'ERP, l'indice le
    // nomme (outil + libellé d'écran) — le modèle ne fabrique pas un substitut plus faible.
    indiceNatif,
    intentsCtx,
  ]);
  if (contexteTour) messages[messages.length - 1] = { role: "user", content: `${question}${contexteTour}` };
  const systemComplet = contexteTour ? `${system}${contexteTour}` : system;
  const cacheKey = `adam:${user.id}`;
  const surete = safetyIdentifierFor(user.id);
  // LES SKILLS DE LA PERSONNE (§36) — connecteurs, micro-outils, playbooks — sont chargés AVANT la liste :
  // sans ce préchargement, `assistantToolsFor` ne verrait que le cœur.
  await timedPhase("skills", () => prechargerCapacitesDynamiques(user).catch(sansBloquer("assistant.runAssistantStreamImpl.prechargerCapacitesDynamiques", 0)));
  const tOutils = Date.now();
  let allTools = assistantToolsFor(user);
  addPhase("catalogue", Date.now() - tOutils);

  // ── LE MÊME AIGUILLAGE QU'EN VARIANTE NON DIFFUSÉE ────────────────────────────────────────
  // C'est ICI que passe la quasi-totalité du trafic réel : l'interface et la voix appellent le
  // flux, pas `runAssistant`. Un aiguillage branché d'un seul côté n'aurait rien activé du tout
  // (§22 : « Voice est une modalité, pas un deuxième cerveau »).
  const turnStartedAt = Date.now();
  const tRoutage = Date.now();
  const rollout = decideRollout(question, { userId: user.id, ctx: { modality: opts.origin === "voice" ? "voice" : "text" }, outilsPermis: allTools.map((t) => t.name) });
  addPhase("routage", Date.now() - tRoutage);
  // ── LE RÉSOLVEUR D'OUTILS ────────────────────────────────────────────────────────────────
  // On n'envoie plus « ce qui tient » mais « ce que la demande peut appeler » : niveau A/B/C et
  // domaines cités décident. Mesuré sur vingt demandes types : une salutation part avec 0 schéma
  // au lieu de 161, un A avec 10 à 14, un B avec 11 à 30, un C avec 39 à 40.
  //
  // Les deux garde-fous restent DERRIÈRE, et c'est volontaire : `fitToolBudget` puis `capTools`
  // ne se déclenchent plus en fonctionnement normal, mais un filet qu'on retire parce qu'il ne
  // sert plus est un filet qu'on regrettera au prochain lot d'outils.
  const tResolv = Date.now();
  const resolved = resolveTools(allTools, question, rollout.route, { ecritures: RESOLVER_WRITE_NAMES, epingles });
  let tools = fitToolBudget(resolved.tools, rollout.route, undefined, epingles) as typeof allTools;
  addPhase("resolveur", Date.now() - tResolv);
  const trace: string[] = [];
  const usedTools: string[] = [];
  // LES SORTIES BRUTES DU TOUR — la matière de la réparation des liens : un « [Ouvrir](/regulatory/) »
  // tronqué par le modèle est complété avec le lien EXACT que l'outil a rendu (link-repair.ts).
  const sortiesOutils: string[] = [];
  const reparerReponse = (brut: string): { texte: string; repares: number } =>
    reparerLiensInternes(brut, collecterLiensInternes(sortiesOutils));
  // LA PROVENANCE DU TOUR (F8) — même mécanisme qu'en variante non diffusée.
  const lectures: { outil: string; sortie: string }[] = [];
  const avecProvenance = <T extends AssistantResult>(r: T): T => {
    const faits = faitsDuTour(lectures, { acteur: user.id });
    // LA CALIBRATION DU TOUR (§29) : le code dit ce que le tour a établi et ce que ça commande.
    const { resultat, calibration } = calibrerTour(question, faits, r);
    // LES CARTES DEVENUES CADUQUES VOYAGENT AVEC LE TOUR — ici et nulle part ailleurs, parce que
    // c'est le seul passage commun à toutes les sorties de ce chemin. Les poser sur chaque
    // `return` aurait laissé passer celui qu'on oublie, et c'est toujours celui-là qui compte.
    /**
     * ── « FAIT VÉRIFIÉ : aucun X » (§118.57) ────────────────────────────────────────────
     *
     * La plus forte étiquette posée sur ce qu'on n'a PAS vu. Le socle sait déjà, source par
     * source, si une absence y est DÉMONTRABLE (`preuveNegative` : une table bornée oui, un
     * index de contenu non — « pas dans l'index » n'est pas « pas dans le Drive »). Aucun
     * fait du tour ne le permet ? Le mot est trop fort, et on le dit. Ici, dans le passage
     * commun : ailleurs, on manquerait la sortie qu'on oublie.
     */
    const prouvables = faits.filter((f) => f.preuveNegative === true).length;
    const nuance = typeof (resultat as { reply?: unknown }).reply === "string"
      ? avertirAbsenceNonProuvable({ reponse: (resultat as { reply: string }).reply, faitsProuvantUneAbsence: prouvables })
      : null;
    const final = nuance
      ? { ...resultat, reply: `${(resultat as { reply: string }).reply}\n\n${nuance}` }
      : resultat;
    return { ...final, provenance: faits, calibration, ...(perimees.length ? { perimees } : {}) };
  };
  let discoveryCalls = 0;
  const started = Date.now();
  const metrics: AssistantMetrics = { ttftMs: null, turns: 0, toolCalls: 0, toolErrors: 0, toolLatencyMs: 0 };

  try {
    // ── LA SALUTATION NE PAIE PAS UN ORCHESTRATEUR ──────────────────────────────────────────
    // « Bonjour Adam » partait sur le rôle le plus cher avec 13 000 jetons de consignes :
    // 0,027 $ et deux secondes pour un mot. Le rôle « bulk » avec une consigne de six lignes
    // répond mieux et dix fois moins cher ; s'il ne rend rien, la boucle normale reprend.
    if (resolved.level === "AUCUN") {
      /**
       * ── LE CHEMIN INSTANTANÉ : CE QUI NE DEMANDE RIEN NE PAIE PAS UN MODÈLE ────────────
       *
       * Mesuré : « Bonjour Adam » ne montrait rien pendant 1,08 s, rendait son premier mot à
       * 2,92 s et n'apportait AUCUNE information — soit presque deux fois le temps d'une vraie
       * question. La consigne donnée au modèle tenait pourtant en une ligne, et le code connaît
       * déjà le prénom et l'heure.
       *
       * `repondreSansDemande` rend `null` au moindre doute, et l'appel de modèle ci-dessous
       * reprend alors la main : le chemin rapide RETIRE une latence, il ne retire pas un filet.
       */
      let streamed = false;
      const res = await callClaudeStream(
        [{ role: "user", content: question }],
        (chunk) => { streamed = true; if (metrics.ttftMs == null) metrics.ttftMs = Date.now() - started; emit({ type: "delta", text: chunk }); },
        { role: "bulk", system: salutationSystem(user, identite), tools: [], maxTokens: 160, reasoning: "none", promptCacheKey: cacheKey, safetyIdentifier: surete },
      );
      metrics.turns = 1;
      const texte = res.ok && res.content ? textOf(res.content).trim() : "";
      if (texte) {
        if (!streamed) emit({ type: "delta", text: texte });
        return avecProvenance({ configured: true, ok: true, reply: texte, trace, metrics });
      }
      if (streamed) emit({ type: "reset" });
      metrics.ttftMs = null;
    }

    // ── LE CHEMIN RAPIDE ────────────────────────────────────────────────────────────────────
    // Source canonique d'abord, un seul appel de modèle ensuite, ZÉRO schéma d'outil envoyé.
    // La trace est émise AVANT la lecture : l'utilisateur voit « Annuaire » pendant l'attente,
    // pas après.
    if (rollout.mode === "FAST_READ" && rollout.route.tool) {
      const toolName = rollout.route.tool;
      const label = READ_LABEL[toolName] ?? powerToolLabels()[toolName];
      if (label) { trace.push(label); emit({ type: "trace", label }); }
      const t0 = Date.now();
      metrics.toolCalls += 1;
      const out = await executeReadTool(toolName, rollout.route.args, user).catch((e) => {
        console.error("[assistant] fast read failed", toolName, e);
        metrics.toolErrors += 1;
        return null;
      });
      metrics.toolLatencyMs += Date.now() - t0;
      recordTool({ name: toolName, ms: Date.now() - t0, ok: out !== null });
      if (out !== null) {
        usedTools.push(toolName);
        sortiesOutils.push(out);
        lectures.push({ outil: toolName, sortie: out });
        const sources = sourcesDuResultat(toolName, out, user.id);
        for (const s of sources) emit({ type: "source", ...s });
        // L'ESPACE DE TRAVAIL PART AVANT LE TEXTE. La donnée est déjà lue ; la faire attendre
        // la rédaction du modèle ferait patienter le PDG devant un écran vide alors que la
        // réponse est là. Il lit le tableau pendant qu'Adam formule.
        const composed = composeWorkspace(toolName, out) ?? apercuDesSources(toolName, sources, label);
        if (composed) emit({ type: "workspace", composition: composed });
        metrics.turns = 1;
        let streamed = false;
        // FORMULER UN RÉSULTAT DÉJÀ LU N'EST PAS DU RAISONNEMENT : le rôle « bulk » (Luna, sans
        // réflexion) le fait en moins d'une seconde, dix fois moins cher. S'il ne rend rien
        // d'exploitable, l'orchestrateur reprend la même consigne — jamais une réponse fausse.
        const phraser = (role: "bulk" | "orchestrator") => callClaudeStream(
          // LA CHARGE D'AFFICHAGE NE PART PAS AU MODÈLE. L'écran l'a déjà reçue ci-dessus ;
          // la lui faire lire serait payer un texte dont il ne tire rien.
          [{ role: "user", content: `DEMANDE : ${question}\n\nRÉSULTAT DE LA SOURCE CANONIQUE :\n${stripDisplayPayload(out)}` }],
          (chunk) => {
            streamed = true;
            if (metrics.ttftMs == null) metrics.ttftMs = Date.now() - started;
            emit({ type: "delta", text: chunk });
          },
          { role, system: fastReadSystem(user, extraireBlocRegles(opts.personalContext)), tools: [], maxTokens: 700, model: opts.model, reasoning: role === "bulk" ? "none" : "low", promptCacheKey: cacheKey, safetyIdentifier: surete },
        );
        let res = await phraser("bulk");
        if (!res.ok || !res.content || !textOf(res.content).trim()) {
          if (streamed) { emit({ type: "reset" }); streamed = false; metrics.ttftMs = null; }
          metrics.turns += 1;
          res = await phraser("orchestrator");
        }
        if (res.ok && res.content) {
          const reparation = reparerReponse(textOf(res.content).trim());
          const reply = reparation.texte;
          if (reply) {
            if (!streamed) emit({ type: "delta", text: reply });
            else if (reparation.repares > 0) {
              emit({ type: "reset" });
              emit({ type: "delta", text: reply });
            }
            return avecProvenance({ configured: true, ok: true, reply, trace, metrics });
          }
        }
        // Le raccourci a parlé pour rien : ce qui a été diffusé n'est pas la réponse.
        if (streamed) emit({ type: "reset" });
      }
      // ÉCHEC DU RACCOURCI = REPLI (§4), jamais une réponse fausse. La boucle complète reprend
      // avec TOUS les outils : le tour coûte plus cher, il ne rate pas.
      tools = allTools;
      trace.length = 0;
      metrics.ttftMs = null;
      recordOutcome({ fallback: true });
    }

    // ── LES PRÉ-LECTURES — le code lit avant que le modèle ne demande (pre-lectures.ts) ────
    // Présentées au modèle comme des appels d'outils déjà faits : il décide la suite avec la
    // preuve sous les yeux. Mêmes outils, mêmes droits, délai borné, extrait borné.
    if (rollout.mode !== "FAST_READ") {
      const plansPre = planifierPreLectures(question, { route: rollout.route.route, isMutation: rollout.isMutation, entites: plan.entites, domain: rollout.route.domain });
      if (plansPre.length > 0) {
        for (const p of plansPre) {
          const label = READ_LABEL[p.tool] ?? powerToolLabels()[p.tool];
          if (label && !trace.includes(label)) { trace.push(label); emit({ type: "trace", label }); }
        }
        const faites = await timedPhase("pre_lectures", () => executerPreLectures(plansPre, (tool, input) => executeReadTool(tool, input, user)));
        if (faites.length > 0) {
          metrics.toolCalls += faites.length;
          for (const f of faites) {
            metrics.toolLatencyMs += f.ms;
            recordTool({ name: f.tool, ms: f.ms, ok: true, parallel: faites.length > 1 });
            usedTools.push(f.tool);
            sortiesOutils.push(f.out);
            lectures.push({ outil: f.tool, sortie: f.out });
            const sources = sourcesDuResultat(f.tool, f.out, user.id);
            for (const src of sources) emit({ type: "source", ...src });
            const composed = composeWorkspace(f.tool, f.out)
              ?? apercuDesSources(f.tool, sources, READ_LABEL[f.tool] ?? powerToolLabels()[f.tool]);
            if (composed) emit({ type: "workspace", composition: composed });
          }
          tools = avecOutilsDeclares(tools, allTools, faites.map((f) => f.tool));
          messages.push({ role: "assistant", content: faites.map((f) => ({ type: "tool_use" as const, id: f.id, name: f.tool, input: f.input })) });
          messages.push({ role: "user", content: faites.map((f) => ({ type: "tool_result" as const, tool_use_id: f.id, content: stripDisplayPayload(f.out).slice(0, PRE_LECTURE_MAX_CHARS) })) });
        }
      }
    }

    // La garantie d'enseignement (§119) ne rappelle le modèle qu'UNE fois par tour.
    let rappelEnseignement = false;
    let redecouvert = false;
    let promesseRappelee = false;
    // Une absence ne s'affirme qu'une fois la recherche élargie — et l'élargissement n'a lieu qu'UNE fois.
    let elargi = false;
    /**
     * ── POURQUOI TOUTES LES RONDES PAIENT LE MÊME EFFORT — une hypothèse RÉFUTÉE ───────
     *
     * L'intuition était forte : sur une analyse, trois rondes sur cinq ne font que désigner la
     * lecture suivante (86, 113 et 176 jetons de sortie) et paient pourtant onze secondes de
     * raisonnement premium. Un « cliquet » a donc été construit — routage bon marché, rejeu à
     * l'étage de la demande dès qu'une ronde rend du texte — puis mesuré au banc À TÉMOIN
     * (`npm run bench:ab`, six demandes, chacune jouée éteint / éteint / allumé).
     *
     * LE RÉSULTAT A REFUSÉ L'HYPOTHÈSE : +36 % d'appels, +19 % de latence. Et pour une raison
     * qu'il fallait entendre — à effort réduit, le modèle n'appelle pas les mêmes outils moins
     * cher, il en appelle DAVANTAGE, en plus de rondes (« multi » : 3 appels → 7). Choisir la
     * lecture suivante N'EST PAS une tâche mécanique : c'est le raisonnement qui fait tenir le
     * plan d'outils en peu d'étapes. Le cliquet a été retiré ; ce commentaire reste pour que
     * l'intuition ne soit pas reconstruite une troisième fois sans banc.
     */
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      metrics.turns = turn + 1;
      // Le texte part AU FIL DE L'EAU. Si le tour se révèle finalement être un appel d'outil,
      // ce qui a été écrit n'était qu'un préambule : on demande alors au client de l'effacer
      // (`reset`) avant que la vraie réponse n'arrive. En pratique le modèle appelle ses outils
      // sans préambule, donc `reset` ne se déclenche presque jamais — mais l'affichage reste
      // juste dans tous les cas.
      let streamed = false;
      const res = await callClaudeStream(messages, (chunk) => {
        streamed = true;
        if (metrics.ttftMs == null) metrics.ttftMs = Date.now() - started;
        emit({ type: "delta", text: chunk });
      }, { system, tools, maxTokens: 1400, model: opts.model, reasoning: effortPourNiveau(resolved.level), promptCacheKey: cacheKey, safetyIdentifier: surete });
      if (!res.ok || !res.content) {
        return { configured: res.configured, ok: false, reply: "", trace, metrics, error: res.error ?? "Réponse IA indisponible." };
      }

      const blocks = res.content;
      const toolUses = blocks.filter((b) => b.type === "tool_use") as Extract<ClaudeContentBlock, { type: "tool_use" }>[];

      // Pas d'outil → c'est la réponse finale : on la diffuse d'un trait mesuré.
      if (res.stopReason !== "tool_use" || toolUses.length === 0) {
        // LES LIENS TRONQUÉS SONT COMPLÉTÉS AVANT DE CONCLURE : « [Ouvrir](/regulatory/) » alors
        // que le tour a lu /regulatory/<id> mène au tableau générique — mesuré en conversation
        // réelle sur trois modules. La réparation est déterministe (préfixe strict, candidat
        // UNIQUE) ; quand elle a corrigé un texte déjà diffusé, le client le remplace (`reset`),
        // exactement comme la passe critique.
        let redige = textOf(blocks) || "D'accord.";
        // ── LA GARANTIE D'ENSEIGNEMENT (§119) ─────────────────────────────────────────────
        // « Règle enregistrée » sans qu'aucun outil Teach n'ait tourné dans CE tour n'est pas une
        // réponse, c'est un faux succès (mesuré en suite live : l'historique portait la même
        // règle, supprimée depuis). Le modèle reçoit une fois l'ordre d'appeler l'outil ; s'il
        // ne le fait toujours pas, la réponse dit la vérité.
        const verdictTeach = gardeEnseignement({
          question, reponse: redige, outilsUtilises: usedTools,
          outilsDisponibles: allTools.map((t) => t.name), dejaRappele: rappelEnseignement,
        });
        if (verdictTeach === "RAPPELER") {
          rappelEnseignement = true;
          if (streamed) emit({ type: "reset" });
          if (!trace.includes(TEACH_GARDE_LABEL)) { trace.push(TEACH_GARDE_LABEL); emit({ type: "trace", label: TEACH_GARDE_LABEL }); }
          tools = avecOutilsDeclares(tools, allTools, [...OUTILS_ENSEIGNEMENT]);
          messages.push({ role: "assistant", content: blocks });
          messages.push({ role: "user", content: RAPPEL_ENSEIGNEMENT });
          continue;
        }
        if (verdictTeach === "DEMENTIR") {
          if (streamed) emit({ type: "reset" });
          emit({ type: "delta", text: DEMENTI_ENSEIGNEMENT });
          return avecProvenance({ configured: true, ok: true, reply: DEMENTI_ENSEIGNEMENT, trace, metrics });
        }
        /**
         * ── NOT_FOUND N'EST PAS VERIFIED_ABSENT ──────────────────────────────────────────
         *
         * « Je n'ai rien trouvé » après UNE façon de chercher n'est pas une preuve d'absence,
         * et c'est pourtant ainsi que la personne va le lire. Le serveur rend l'échelle
         * d'élargissement et exige un second essai — une fois. (`limites.ts`)
         */
        if (gardeAbsence({ reponse: redige, outilsUtilises: usedTools, dejaElargi: elargi }) === "ELARGIR") {
          elargi = true;
          // Le texte déjà diffusé annonçait une absence non vérifiée : le client l'efface (`reset`),
          // exactement comme pour un refus prématuré — sans quoi la personne lirait les deux.
          if (streamed) { emit({ type: "reset" }); streamed = false; }
          if (!trace.includes(ELARGISSEMENT_LABEL)) { trace.push(ELARGISSEMENT_LABEL); emit({ type: "trace", label: ELARGISSEMENT_LABEL }); }
          const carteEl = runDiscovery({}, allTools);
          tools = avecOutilsDeclares(tools, allTools, carteEl.unlock);
          messages.push({ role: "assistant", content: blocks });
          messages.push({ role: "user", content: `${RAPPEL_ELARGISSEMENT}\n\n${carteEl.text}` });
          continue;
        }
        // ── LA DÉCOUVERTE AVANT L'IMPOSSIBLE (§34) — même règle qu'hors flux : la carte complète est
        // remise une fois ; le texte déjà diffusé était un refus prématuré, le client l'efface (`reset`).
        // ── UNE PROMESSE SANS OBJET DURABLE — même règle qu'hors flux. Le texte déjà diffusé
        // promettait un suivi qui n'existe pas : le client l'efface (`reset`).
        if (gardePromesse({ reponse: redige, outilsUtilises: usedTools, dejaRappele: promesseRappelee }) === "SANS_OBJET") {
          promesseRappelee = true;
          if (streamed) { emit({ type: "reset" }); streamed = false; }
          if (!trace.includes(PROMESSE_LABEL)) { trace.push(PROMESSE_LABEL); emit({ type: "trace", label: PROMESSE_LABEL }); }
          tools = avecOutilsDeclares(tools, allTools, [...OUTILS_DURABLES]);
          messages.push({ role: "assistant", content: blocks });
          messages.push({ role: "user", content: RAPPEL_PROMESSE });
          continue;
        }
        const verdictImp = gardeImpossibilite({ question, reponse: redige, outilsUtilises: usedTools, outilsDisponibles: allTools.map((t) => t.name), dejaRedecouvert: redecouvert });
        if (verdictImp === "REDECOUVRIR") {
          redecouvert = true;
          if (streamed) emit({ type: "reset" });
          if (!trace.includes(DECOUVERTE_LABEL)) { trace.push(DECOUVERTE_LABEL); emit({ type: "trace", label: DECOUVERTE_LABEL }); }
          const carte = runDiscovery({}, allTools);
          tools = avecOutilsDeclares(tools, allTools, carte.unlock);
          messages.push({ role: "assistant", content: blocks });
          messages.push({ role: "user", content: `${RAPPEL_DECOUVERTE}\n\n${carte.text}` });
          continue;
        }
        if (verdictImp === "ACCEPTER") { const c = complementDeLimite(redige, allTools.length); if (c) { redige = `${redige}\n\n${c}`; if (streamed) { emit({ type: "reset" }); streamed = false; } } }
        { const p = avertirPromesseSansObjet(redige, usedTools, { surveillances: peutPiloterMissionsAdam(user) }); if (p) { redige = `${redige}\n\n${p}`; if (streamed) { emit({ type: "reset" }); streamed = false; } } }
        const reparation = reparerReponse(redige);
        const reply = reparation.texte;
        // Rien n'a été diffusé (réponse vide côté modèle) → on envoie le repli d'un trait.
        if (!streamed) emit({ type: "delta", text: reply });
        else if (reparation.repares > 0) {
          emit({ type: "reset" });
          emit({ type: "delta", text: reply });
        }
        const gesteCartes = await carteDuProchainGeste(lectures, user, opts.origin ?? "text");

        // Fort enjeu → SECONDE PASSE CRITIQUE. Le brouillon déjà diffusé était une vraie
        // réponse progressive (pas une invention) ; la version relue le remplace (`reset`),
        // et l'étape se DIT dans la trace — le travail en plus est visible, jamais caché.
        if (highStakes && reply.length >= CRITIQUE_MIN_DRAFT) {
          emit({ type: "trace", label: CRITIQUE_LABEL });
          trace.push(CRITIQUE_LABEL);
          metrics.turns += 1;
          const relu = await reviseHighStakes(systemComplet, question, reply, opts.model, cacheKey).catch(sansBloquer("assistant.runAssistantStreamImpl.reviseHighStakes", null));
          const revised = relu ? reparerReponse(relu).texte : null;
          if (revised && revised !== reply) {
            emit({ type: "reset" });
            emit({ type: "delta", text: revised });
            return avecProvenance({ configured: true, ok: true, reply: revised, trace, metrics, ...(gesteCartes ? { proposal: gesteCartes[0], proposals: gesteCartes } : {}) });
          }
        }
        return avecProvenance({ configured: true, ok: true, reply, trace, metrics, ...(gesteCartes ? { proposal: gesteCartes[0], proposals: gesteCartes } : {}) });
      }

      // Actions d'écriture → TOUTES interceptées et proposées (rien n'est exécuté). Plusieurs
      // écritures dans le même tour (« crée les trois tâches ») deviennent plusieurs cartes et
      // une confirmation groupée — pas trois allers-retours.
      const writes = toolUses.filter((t) => WRITE_TOOL_NAMES.has(t.name));
      if (writes.length > 0) {
        const okProposals: ProposedAction[] = [];
        const failures: { id: string; error: string }[] = [];
        for (const w of writes) {
          const p = await buildProposal(w.name, w.input, user);
          if ("error" in p) { failures.push({ id: w.id, error: p.error }); continue; }
          /**
           * ── UNE CIBLE AMBIGUË REND DES CANDIDATS (§104.7, étendu à TOUTE écriture) ──────
           *
           * Mesuré au banc des intentions courtes : « Corrige ça » après une liste de documents
           * rendait « Je propose : ANNULER le devis DEV-2026-0038 ». Le PDG n'avait nommé aucune
           * pièce ; Adam en a choisi une, et a transformé « corrige » en « annule ». Rien ne part
           * sans clic — mais un clic réflexe annulait un devis.
           *
           * La porte refuse la proposition et rend la QUESTION, avec les candidats nommés.
           */
          // LES CANDIDATS SONT CEUX QUE LA CONVERSATION A MONTRÉS, pas seulement ceux de ce
        // tour-ci. Mesuré : la liste est produite au tour PRÉCÉDENT, et au tour où l'écriture
        // se propose Adam n'a souvent rien relu — la règle voyait zéro candidat et s'ouvrait.
        const vus: Candidat[] = [...lectures.flatMap((l) => extractSources(l.sortie)), ...candidatsMontres(history)];
          const v = verdictCible(question, `${p.title} ${p.fields.map((f) => f.value).join(" ")}`, vus);
          if (!v.designee) { failures.push({ id: w.id, error: v.question }); continue; }
          /**
           * ── L'EMPREINTE RÉELLE NE DÉPASSE JAMAIS L'EMPREINTE DEMANDÉE ──────────────────
           *
           * Mesuré dans le vrai chat : « Retire l'adresse e-mail d'Allaeddine » a produit
           * « Je propose : SUPPRIMER DÉFINITIVEMENT l'employé Allaeddine ». Un champ demandé,
           * une personne proposée. `verdictCible` ne voit pas cette faute — la cible était la
           * BONNE ; c'est la PORTÉE qui était fausse. (`mutations/empreinte.ts`)
           */
          const emp = verdictEmpreinte(question, w.name, p.title, w.input);
          if (!emp.ok) { failures.push({ id: w.id, error: emp.refus }); continue; }
          okProposals.push(p);
        }
        // Tout a échoué → on réinjecte les erreurs pour laisser le modèle se corriger.
        if (okProposals.length === 0) {
          if (streamed) emit({ type: "reset" });
          messages.push({ role: "assistant", content: blocks });
          messages.push({
            role: "user",
            content: failures.map((f) => ({ type: "tool_result" as const, tool_use_id: f.id, content: f.error, is_error: true })),
          });
          continue;
        }
        // Des réussites ET des échecs : les échecs se DISENT sur la première carte — proposer
        // deux actions sur trois en taisant la troisième ferait croire qu'elle est prête.
        for (const f of failures) okProposals[0].warnings.push(`Autre action non préparée : ${f.error}`);
        // Chaque proposition devient un INTENT persistant (état canonique PROPOSED).
        const intentIds = await persistActionIntents(user.id, okProposals, opts.origin ?? "text");
        okProposals.forEach((p, i) => { const id = intentIds[i]; if (id) p.intentId = id; });
        const reply = textOf(blocks)
          || (okProposals.length === 1
            ? `Je propose : « ${okProposals[0].title} ». Confirmez-vous ?`
            : `Je propose ${okProposals.length} actions — confirmez-les une à une, ou toutes d'un coup.`);
        if (!streamed) emit({ type: "delta", text: reply });
        return avecProvenance({ configured: true, ok: true, reply, trace, proposal: okProposals[0], proposals: okProposals, metrics });
      }

      // Outils de lecture : le préambule éventuel est effacé, chaque étape est annoncée dès son
      // lancement, et les lectures s'exécutent EN PARALLÈLE (indépendantes par construction :
      // le modèle a décomposé, on n'ajoute pas la latence des unes aux autres). Le cumul
      // `toolLatencyMs` reste la somme des durées individuelles — le temps passé DANS les
      // outils, pas le temps d'horloge.
      if (streamed) emit({ type: "reset" });
      const settled = await Promise.all(toolUses.map(async (tu) => {
        const t0 = Date.now();
        metrics.toolCalls += 1;
        // LA DÉCOUVERTE — l'échappatoire qui empêche la liste courte d'être une amputation.
        // Elle rouvre le domaine demandé pour la suite de la boucle et se compte comme un
        // « outil manquant » : l'échappatoire répare le tour, le compteur répare le routeur.
        if (tu.name === DISCOVERY_TOOL_NAME) {
          discoveryCalls += 1;
          const found = runDiscovery(tu.input, allTools);
          console.info("[discovery]", {
            asked: typeof (tu.input as Record<string, unknown>).domain === "string" ? (tu.input as Record<string, unknown>).domain : null,
            served: found.domain, unlocked: found.unlock.length, exposed: tools.length,
          });
          const unlock = new Set(found.unlock);
          const known = new Set(tools.map((t) => t.name));
          tools = [...tools, ...allTools.filter((t) => unlock.has(t.name) && !known.has(t.name))];
          metrics.toolLatencyMs += Date.now() - t0;
          return { tu, out: found.text };
        }
        const label = READ_LABEL[tu.name];
        if (label && !trace.includes(label)) { trace.push(label); emit({ type: "trace", label }); }
        let okOutil = true;
        const out = await executeReadTool(tu.name, tu.input, user, question).catch((e) => {
          console.error("[assistant] read tool failed", tu.name, e);
          metrics.toolErrors += 1;
          okOutil = false;
          return "Erreur lors de la lecture des données.";
        });
        metrics.toolLatencyMs += Date.now() - t0;
        recordTool({ name: tu.name, ms: Date.now() - t0, ok: okOutil, parallel: toolUses.length > 1 });
        return { tu, out };
      }));
      // Même règle qu'en mode non flux : un micro-outil créé dans le tour est exposé dans le tour.
      const nes = outilsCreesParmi(settled.map((s) => ({ name: s.tu.name, out: s.out })));
      if (nes.length) {
        await prechargerCapacitesDynamiques(user).catch(sansBloquer("assistant.runAssistantStreamImpl.prechargerCapacitesDynamiques", 0));
        allTools = assistantToolsFor(user);
        tools = avecOutilsDeclares(tools, allTools, nes);
      }
      const results: ClaudeContentBlock[] = [];
      for (const { tu, out } of settled) { sortiesOutils.push(out); lectures.push({ outil: tu.name, sortie: out }); }
      for (const { tu, out } of settled) {
        // Les SOURCES consultées alimentent le panneau CONTEXTE : chaque dossier lu devient un
        // lien cliquable, au moment même où l'assistant le lit.
        const sources = sourcesDuResultat(tu.name, out, user.id);
        for (const s of sources) emit({ type: "source", ...s });
        // Le même espace de travail sur le chemin complet : que l'annuaire ait été choisi par
        // le code ou par le modèle, il s'affiche de la même façon. Une donnée canonique ne
        // change pas de nature selon le chemin qui l'a atteinte.
        const composed = composeWorkspace(tu.name, out)
          ?? apercuDesSources(tu.name, sources, READ_LABEL[tu.name] ?? powerToolLabels()[tu.name]);
        if (composed) emit({ type: "workspace", composition: composed });
        usedTools.push(tu.name);
        // Même règle sur le chemin outillé : l'espace de travail a la charge d'affichage, le
        // modèle reçoit les faits. Deux destinataires, deux besoins.
        results.push({ type: "tool_result", tool_use_id: tu.id, content: stripDisplayPayload(out) });
      }
      messages.push({ role: "assistant", content: blocks });
      messages.push({ role: "user", content: results });
    }

    return avecProvenance({ configured: true, ok: true, reply: "Je n'ai pas pu finaliser la demande en peu d'étapes. Reformulez en précisant l'objectif.", trace, metrics });
  } catch (err) {
    console.error("[assistant] runAssistantStream failed", err);
    return { configured: true, ok: false, reply: "", trace, metrics, error: "Une erreur est survenue côté assistant. Reformulez votre demande ou réessayez dans un instant." };
  } finally {
    // `allTools.length` et non `tools.length` : le mode ombre mesure ce que la liste COMPLÈTE
    // aurait coûté face à ce qui a réellement servi. Lui passer la liste déjà réduite lui ferait
    // mesurer sa propre sortie, et le gain se lirait comme nul.
    recordShadow(question, allTools.length, usedTools);
    observeRollout(rollout, { user, allToolCount: allTools.length, exposed: tools.length, usedTools, discoveryCalls, startedAt: turnStartedAt });
  }
}
