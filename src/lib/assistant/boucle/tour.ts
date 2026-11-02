/**
 * LA BOUCLE AGENT NON DIFFUSÉE — un tour complet (lectures exécutées et réinjectées, écritures
 * interceptées en actions à confirmer), rendu d'un bloc.
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
import { callClaude, assistantConfigured as aiConfigured } from "@/lib/models/compat";
import { candidatsMontres, verdictCible, type Candidat } from "@/platform/ia/intentions/cible-designee";
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
import { stripDisplayPayload } from "@/lib/assistant/workspace/compose";
import { collecterLiensInternes, reparerLiensInternes } from "@/lib/assistant/link-repair";
import { runDiscovery, DISCOVERY_TOOL_NAME } from "@/lib/assistant/context/discovery";
import { powerToolLabels } from "@/lib/assistant/power-tools";
import { conversationWorkingSet, isHighStakesQuestion, queryPlan, queryPlanContext } from "@/lib/assistant/reasoning";
import { persistActionIntents, recentActionIntentsContext, retirerCaduquesAvantLeTour } from "@/platform/ia/intentions/action-intents";
import { verdictEmpreinte } from "@/lib/mutations/empreinte";
import { sansBloquer } from "@/lib/journal";
import type { ChatTurn, ProposedAction, AssistantResult } from "@/lib/assistant/coeur/contrat-actions";
import { WRITE_TOOL_NAMES, RESOLVER_WRITE_NAMES, assistantToolsFor } from "@/lib/assistant/outils/catalogue-ecriture";
import { assistantIdentityContext, systemPrompt } from "@/lib/assistant/coeur/prompt";
import { executeReadTool } from "@/lib/assistant/outils/lecture";
import { buildProposal } from "@/lib/assistant/propositions/construire";
import {
  fastReadSystem, observeRollout, READ_LABEL, MAX_TURNS, toMessages, textOf, CRITIQUE_LABEL, TEACH_GARDE_LABEL,
  DECOUVERTE_LABEL, ELARGISSEMENT_LABEL, PROMESSE_LABEL, PROVENANCE_LABEL, CRITIQUE_MIN_DRAFT, reviseHighStakes,
  effortPourNiveau, salutationSystem, outilsCreesParmi, avecOutilsDeclares,
} from "@/lib/assistant/boucle/commun";
import { extractSources, carteDuProchainGeste, resolveSpokenMailApproval } from "@/lib/assistant/boucle/sources";

/**
 * Exécute la boucle : Claude peut appeler des outils de lecture (exécutés et
 * réinjectés), puis répond. Si Claude appelle un outil d'écriture, on intercepte
 * et on renvoie une action à confirmer (rien n'est exécuté).
 */
export async function runAssistantImpl(
  user: CurrentUser,
  history: ChatTurn[],
  opts: { model?: string; personalContext?: string | null; origin?: "text" | "voice" | "nudge"; turnContext?: TurnContext } = {},
): Promise<AssistantResult> {
  if (!aiConfigured()) return { configured: false, ok: false, reply: "", trace: [] };

  const messages = toMessages(history);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return { configured: true, ok: false, reply: "", trace: [], error: "Message utilisateur manquant." };
  }

  // Contexte PERSONNEL (identité, rattachement, N+1, mémoire des échanges passés) — fourni
  // par l'appelant, qui l'a résolu pour CE compte uniquement. Voir lib/assistant-memory.ts.
  // + ENTITÉS ACTIVES : les références et termes cités récemment (« et le fournisseur ? »,
  // « fais pareil pour Nivo » se résolvent sans relancer toute la compréhension).
  // + ACTIONS RÉCENTES : l'état CANONIQUE serveur des dernières intentions — « est-ce que je
  // te l'avais déjà demandé ? » se répond depuis cet état, jamais de mémoire.
  const workingSet = conversationWorkingSet(history);
  /**
   * LES CARTES DÉPASSÉES PARTENT AVANT LE MODÈLE, PAS APRÈS.
   *
   * L'ordre compte : si le retrait venait après, Adam recevrait dans `intentsCtx` une
   * proposition « en attente » que la personne vient de corriger, et pourrait s'appuyer dessus
   * pour répondre. Mesuré au banc live : la carte « tâche pour Raihana, vendredi » a survécu à
   * « non, finalement Amel, et lundi », et le clic l'a exécutée telle quelle.
   */
  const perimees = await retirerCaduquesAvantLeTour(user.id, String(messages[messages.length - 1]?.content ?? ""));
  const [intentsCtx, identite] = await Promise.all([
    recentActionIntentsContext(user.id).catch(sansBloquer("assistant.runAssistantImpl.recentActionIntentsContext", null)),
    assistantIdentityContext(user).catch(sansBloquer("assistant.runAssistantImpl.assistantIdentityContext", null)),
  ]);
  // La question d'ORIGINE (avant que la boucle n'empile les résultats d'outils) — elle décide
  // de la PROFONDEUR : une décision demandée mérite la seconde passe critique.
  const question = String(messages[messages.length - 1]?.content ?? "");

  // UN ACCORD CONCLUT. « Vas-y, envoie » sur un message qui attend l'EXPÉDIE — même fonction que
  // le bouton de la carte, sans repasser par le modèle : pas de second message préparé, pas de
  // carte de plus à cliquer.
  const spoken = await resolveSpokenMailApproval(user, question).catch(sansBloquer("assistant.runAssistantImpl.resolveSpokenMailApproval", null));
  if (spoken) {
    const reply = spoken.ok ? (spoken.message ?? "Envoyé.") : (spoken.error ?? "Envoi impossible.");
    return { configured: true, ok: true, reply, trace: [] };
  }

  // « D'OÙ TU TIENS ÇA ? » — même règle qu'en flux : le code relit ses lectures, sans modèle (F8).
  if (routeVoiceUtterance(question).kind === "PROVENANCE") {
    const p = await repondreDouTuTiensCa(user.id, question, { threadId: opts.turnContext?.threadId ?? null });
    console.info("[assistant] provenance", { userId: user.id, ms: p.ms, faits: p.faits.length, cible: p.cible, toursLus: p.toursLus });
    return { configured: true, ok: true, reply: p.texte, trace: [PROVENANCE_LABEL], provenance: null };
  }

  const highStakes = isHighStakesQuestion(question);
  // PLAN DE LA QUESTION (déterministe) : domaine, intention, SUIVI ELLIPTIQUE (« et SD ? » =
  // même intention, entité substituée), investigation impliquée — la carte avant les outils.
  const tPlan = Date.now();
  const plan = queryPlan(question, history.filter((h) => h.role === "user").slice(0, -1).map((h) => h.content));
  addPhase("plan_question", Date.now() - tPlan);
  // LES ENTITÉS DE LA QUESTION, RÉSOLUES PAR LE CODE (fabric F9) : « Hetero » devient UNE ligne,
  // « Nadir » devient une question quand deux Nadir existent — le modèle reçoit des identifiants
  // certains et l'ordre de demander quand c'est ambigu, au lieu de deviner.
  const entitesResolues = plan.entites.length
    ? await timedPhase("entites", () => resoudreMentions(plan.entites).then(contexteEntitesResolues).catch(sansBloquer("assistant.runAssistantImpl.resoudreMentions", null)))
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
  // QUI IL EST ET DEPUIS QUELLE ADRESSE IL ÉCRIT — lu ci-dessus, avec les actions récentes.
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
  // Le Super Admin dispose d'outils exclusifs (vision globale de tous les comptes).
  // LES SKILLS DE LA PERSONNE (§36) — connecteurs, micro-outils, playbooks — sont chargés AVANT la liste :
  // sans ce préchargement, `assistantToolsFor` ne verrait que le cœur.
  await timedPhase("skills", () => prechargerCapacitesDynamiques(user).catch(sansBloquer("assistant.runAssistantImpl.prechargerCapacitesDynamiques", 0)));
  const tOutils = Date.now();
  let allTools = assistantToolsFor(user);
  addPhase("catalogue", Date.now() - tOutils);

  // ── LA DÉCISION D'AIGUILLAGE ──────────────────────────────────────────────────────────────
  // Elle ne décide QUE de la liste d'outils envoyée au modèle. Les droits, l'approbation,
  // l'audit et l'idempotence sont ailleurs et ne bougent pas d'un pouce.
  const turnStartedAt = Date.now();
  const tRoutage = Date.now();
  const rollout = decideRollout(question, { userId: user.id, ctx: { modality: opts.origin === "voice" ? "voice" : "text" }, outilsPermis: allTools.map((t) => t.name) });
  addPhase("routage", Date.now() - tRoutage);
  // `tools` est MUTABLE : la découverte (`list_more_tools`) peut rouvrir un domaine en cours de
  // boucle, et c'est ce qui rend la liste courte réversible plutôt qu'amputante.
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
  // Ce que la boucle appelle VRAIMENT — la seule vérité contre laquelle comparer la liste courte.
  const usedTools: string[] = [];
  // Les sorties brutes du tour, pour compléter les liens tronqués (même règle que la variante
  // en flux — voir link-repair.ts).
  const sortiesOutils: string[] = [];
  const reparerReponse = (brut: string): string =>
    reparerLiensInternes(brut, collecterLiensInternes(sortiesOutils)).texte;
  // LA PROVENANCE DU TOUR (F8) : chaque lecture est gardée avec son outil, et relue en faits typés
  // au moment de conclure — le résultat les porte, l'entrée les consigne.
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

  try {
  // ── LA SALUTATION NE PAIE PAS UN ORCHESTRATEUR (même règle qu'en flux) ─────────────────
  if (resolved.level === "AUCUN") {
    const res = await callClaude(
      [{ role: "user", content: question }],
      { role: "bulk", system: salutationSystem(user, identite), tools: [], maxTokens: 160, reasoning: "none", promptCacheKey: cacheKey, safetyIdentifier: surete },
    );
    const texte = res.ok && res.content ? textOf(res.content).trim() : "";
    if (texte) return avecProvenance({ configured: true, ok: true, reply: texte, trace });
  }

  // ── LE CHEMIN RAPIDE — la source canonique d'abord, le modèle ensuite ────────────────────
  // Un seul appel de modèle au lieu de deux (choisir l'outil, puis formuler), et ZÉRO schéma
  // d'outil envoyé. C'est là que se trouve l'essentiel du gain mesuré.
  if (rollout.mode === "FAST_READ" && rollout.route.tool) {
    const toolName = rollout.route.tool;
    const out = await executeReadTool(toolName, rollout.route.args, user).catch((e) => {
      console.error("[assistant] fast read failed", toolName, e);
      return null;
    });
    if (out !== null) {
      usedTools.push(toolName);
      sortiesOutils.push(out);
      lectures.push({ outil: toolName, sortie: out });
      const label = READ_LABEL[toolName] ?? powerToolLabels()[toolName];
      if (label) trace.push(label);
      const phraser = (role: "bulk" | "orchestrator") => callClaude(
        [{ role: "user", content: `DEMANDE : ${question}\n\nRÉSULTAT DE LA SOURCE CANONIQUE :\n${stripDisplayPayload(out)}` }],
        { role, system: fastReadSystem(user, extraireBlocRegles(opts.personalContext)), tools: [], maxTokens: 700, model: opts.model, reasoning: role === "bulk" ? "none" : "low", promptCacheKey: cacheKey, safetyIdentifier: surete },
      );
      let res = await phraser("bulk");
      if (!res.ok || !res.content || !textOf(res.content).trim()) res = await phraser("orchestrator");
      if (res.ok && res.content) {
        const reply = reparerReponse(textOf(res.content).trim());
        if (reply) return avecProvenance({ configured: true, ok: true, reply, trace });
      }
    }
    // ÉCHEC DU RACCOURCI = REPLI, jamais une réponse fausse (§4). On retombe sur la boucle
    // complète avec TOUS les outils : le tour coûte plus cher, il ne rate pas.
    tools = allTools;
    recordOutcome({ fallback: true });
  }

  // LES PRÉ-LECTURES — même règle qu'en flux (voir pre-lectures.ts) : la voix qui délègue et
  // le nudge en profitent autant que le texte.
  if (rollout.mode !== "FAST_READ") {
    const plansPre = planifierPreLectures(question, { route: rollout.route.route, isMutation: rollout.isMutation, entites: plan.entites, domain: rollout.route.domain });
    if (plansPre.length > 0) {
      const faites = await timedPhase("pre_lectures", () => executerPreLectures(plansPre, (tool, input) => executeReadTool(tool, input, user)));
      if (faites.length > 0) {
        for (const f of faites) {
          recordTool({ name: f.tool, ms: f.ms, ok: true, parallel: faites.length > 1 });
          usedTools.push(f.tool);
          sortiesOutils.push(f.out);
          lectures.push({ outil: f.tool, sortie: f.out });
          const label = READ_LABEL[f.tool] ?? powerToolLabels()[f.tool];
          if (label && !trace.includes(label)) trace.push(label);
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
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await callClaude(messages, { system, tools, maxTokens: 1400, model: opts.model, reasoning: effortPourNiveau(resolved.level), promptCacheKey: cacheKey, safetyIdentifier: surete });
    if (!res.ok || !res.content) {
      return { configured: res.configured, ok: false, reply: "", trace, error: res.error ?? "Réponse IA indisponible." };
    }

    const blocks = res.content;
    const toolUses = blocks.filter((b) => b.type === "tool_use") as Extract<ClaudeContentBlock, { type: "tool_use" }>[];

    // Pas d'outil → réponse finale. Question à fort enjeu + réponse substantielle → SECONDE
    // PASSE CRITIQUE avant remise (davantage de calcul quand ça compte ; jamais l'inverse).
    if (res.stopReason !== "tool_use" || toolUses.length === 0) {
      let brut = textOf(blocks) || "D'accord.";
      // LA GARANTIE D'ENSEIGNEMENT (§119) — même règle qu'en flux : un « règle enregistrée » se prouve par un outil.
      const verdictTeach = gardeEnseignement({
        question, reponse: brut, outilsUtilises: usedTools,
        outilsDisponibles: allTools.map((t) => t.name), dejaRappele: rappelEnseignement,
      });
      if (verdictTeach === "RAPPELER") {
        rappelEnseignement = true;
        trace.push(TEACH_GARDE_LABEL);
        tools = avecOutilsDeclares(tools, allTools, [...OUTILS_ENSEIGNEMENT]);
        messages.push({ role: "assistant", content: blocks });
        messages.push({ role: "user", content: RAPPEL_ENSEIGNEMENT });
        continue;
      }
      if (verdictTeach === "DEMENTIR") return avecProvenance({ configured: true, ok: true, reply: DEMENTI_ENSEIGNEMENT, trace });
      /**
       * ── NOT_FOUND N'EST PAS VERIFIED_ABSENT ──────────────────────────────────────────
       *
       * « Je n'ai rien trouvé » après UNE façon de chercher n'est pas une preuve d'absence,
       * et c'est pourtant ainsi que la personne va le lire. Le serveur rend l'échelle
       * d'élargissement et exige un second essai — une fois. (`limites.ts`)
       */
      if (gardeAbsence({ reponse: brut, outilsUtilises: usedTools, dejaElargi: elargi }) === "ELARGIR") {
        elargi = true;
        trace.push(ELARGISSEMENT_LABEL);
        const carteEl = runDiscovery({}, allTools);
        tools = avecOutilsDeclares(tools, allTools, carteEl.unlock);
        messages.push({ role: "assistant", content: blocks });
        messages.push({ role: "user", content: `${RAPPEL_ELARGISSEMENT}\n\n${carteEl.text}` });
        continue;
      }
      // ── LA DÉCOUVERTE AVANT L'IMPOSSIBLE (§34) — « je ne peux pas » sans un seul outil appelé n'est
      // pas une réponse : le serveur remet la carte complète et exige un second essai, une fois.
      /**
       * ── UNE PROMESSE SANS OBJET DURABLE ─────────────────────────────────────────────
       *
       * « Je te préviens dès qu'ils répondent » sans rappel, sans surveillance et sans
       * mission ne survit pas à la fin du tour — et la personne, elle, arrête d'y penser.
       * Le serveur exige l'objet, ou l'aveu. Une fois. (`limites.ts`)
       */
      if (gardePromesse({ reponse: brut, outilsUtilises: usedTools, dejaRappele: promesseRappelee }) === "SANS_OBJET") {
        promesseRappelee = true;
        trace.push(PROMESSE_LABEL);
        tools = avecOutilsDeclares(tools, allTools, [...OUTILS_DURABLES]);
        messages.push({ role: "assistant", content: blocks });
        messages.push({ role: "user", content: RAPPEL_PROMESSE });
        continue;
      }
      const verdictImp = gardeImpossibilite({ question, reponse: brut, outilsUtilises: usedTools, outilsDisponibles: allTools.map((t) => t.name), dejaRedecouvert: redecouvert });
      if (verdictImp === "REDECOUVRIR") {
        redecouvert = true;
        trace.push(DECOUVERTE_LABEL);
        const carte = runDiscovery({}, allTools);
        tools = avecOutilsDeclares(tools, allTools, carte.unlock);
        messages.push({ role: "assistant", content: blocks });
        messages.push({ role: "user", content: `${RAPPEL_DECOUVERTE}\n\n${carte.text}` });
        continue;
      }
      if (verdictImp === "ACCEPTER") { const c = complementDeLimite(brut, allTools.length); if (c) brut = `${brut}\n\n${c}`; }
      // La promesse a survécu au rappel : on ne la censure pas, on ajoute la phrase qui manque.
      { const p = avertirPromesseSansObjet(brut, usedTools, { surveillances: peutPiloterMissionsAdam(user) }); if (p) brut = `${brut}\n\n${p}`; }
      const reply = reparerReponse(brut);
      const gesteCartes = await carteDuProchainGeste(lectures, user, opts.origin ?? "text");
      if (highStakes && reply.length >= CRITIQUE_MIN_DRAFT) {
        const revised = await reviseHighStakes(systemComplet, question, reply, opts.model, cacheKey).catch(sansBloquer("assistant.runAssistantImpl.reviseHighStakes", null));
        trace.push(CRITIQUE_LABEL);
        return avecProvenance({ configured: true, ok: true, reply: revised ? reparerReponse(revised) : reply, trace, ...(gesteCartes ? { proposal: gesteCartes[0], proposals: gesteCartes } : {}) });
      }
      return avecProvenance({ configured: true, ok: true, reply, trace, ...(gesteCartes ? { proposal: gesteCartes[0], proposals: gesteCartes } : {}) });
    }

    // Actions d'écriture demandées → TOUTES interceptées et proposées (rien n'est exécuté) —
    // même logique de lot que la variante en flux.
    const writes = toolUses.filter((t) => WRITE_TOOL_NAMES.has(t.name));
    if (writes.length > 0) {
      const okProposals: ProposedAction[] = [];
      const failures: { id: string; error: string }[] = [];
      for (const w of writes) {
        const p = await buildProposal(w.name, w.input, user);
        if ("error" in p) { failures.push({ id: w.id, error: p.error }); continue; }
        // MÊME PORTE QUE LE CHEMIN EN FLUX (`cible-designee.ts`) : une cible ambiguë rend des
        // candidats. Deux chemins, une seule règle — sans quoi la protection dépendrait de
        // l'existence d'un flux, ce qui n'a rien à voir avec la sûreté d'une écriture.
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
      if (okProposals.length === 0) {
        // On réinjecte les erreurs pour laisser Claude se corriger.
        messages.push({ role: "assistant", content: blocks });
        messages.push({
          role: "user",
          content: failures.map((f) => ({ type: "tool_result" as const, tool_use_id: f.id, content: f.error, is_error: true })),
        });
        continue;
      }
      for (const f of failures) okProposals[0].warnings.push(`Autre action non préparée : ${f.error}`);
      // CHAQUE proposition devient un INTENT persistant (état canonique PROPOSED) : la mémoire
      // (« déjà demandé ? ») et la cohérence UI/voix (« envoyé ? ») se lisent LÀ, pas au transcript.
      const intentIds = await persistActionIntents(user.id, okProposals, opts.origin ?? "text");
      okProposals.forEach((p, i) => { const id = intentIds[i]; if (id) p.intentId = id; });
      const reply = textOf(blocks)
        || (okProposals.length === 1
          ? `Je propose : « ${okProposals[0].title} ». Confirmez-vous ?`
          : `Je propose ${okProposals.length} actions — confirmez-les une à une, ou toutes d'un coup.`);
      return avecProvenance({ configured: true, ok: true, reply, trace, proposal: okProposals[0], proposals: okProposals });
    }

    // Outils de lecture → exécutés EN PARALLÈLE (les sous-lectures d'une question complexe sont
    // indépendantes : trois lectures de 800 ms coûtent 800 ms, pas 2,4 s) puis réinjectés dans
    // l'ordre demandé par le modèle.
    const settled = await Promise.all(toolUses.map(async (tu) => {
      // LA DÉCOUVERTE — l'échappatoire qui empêche la liste courte d'être une amputation.
      // Elle ROUVRE le domaine demandé pour la suite de la boucle, et se compte comme un
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
        return { tu, out: found.text };
      }
      return {
        tu,
        out: await executeReadTool(tu.name, tu.input, user, question).catch((e) => {
          console.error("[assistant] read tool failed", tu.name, e);
          return "Erreur lors de la lecture des données.";
        }),
      };
    }));
    // UN MICRO-OUTIL CRÉÉ DANS LE TOUR EST UTILISABLE DANS LE TOUR (§36) : la liste complète est
    // recomposée et le nouvel outil exposé au modèle — sans cela, le modèle qui vient de le créer
    // ne peut pas l'appeler et retombe sur run_code (mesuré au banc : defi-skill-micro-outil).
    const nes = outilsCreesParmi(settled.map((s) => ({ name: s.tu.name, out: s.out })));
    if (nes.length) {
      await prechargerCapacitesDynamiques(user).catch(sansBloquer("assistant.runAssistantImpl.prechargerCapacitesDynamiques", 0));
      allTools = assistantToolsFor(user);
      tools = avecOutilsDeclares(tools, allTools, nes);
    }
    const results: ClaudeContentBlock[] = [];
    for (const { tu, out } of settled) {
      if (READ_LABEL[tu.name] && !trace.includes(READ_LABEL[tu.name])) trace.push(READ_LABEL[tu.name]);
      usedTools.push(tu.name);
      sortiesOutils.push(out);
      lectures.push({ outil: tu.name, sortie: out });
      // Même règle qu'en flux : la charge d'affichage et la lignée ne partent pas au modèle.
      results.push({ type: "tool_result", tool_use_id: tu.id, content: stripDisplayPayload(out) });
    }
    messages.push({ role: "assistant", content: blocks });
    messages.push({ role: "user", content: results });
  }

  return avecProvenance({ configured: true, ok: true, reply: "Je n'ai pas pu finaliser la demande en peu d'étapes. Reformulez en précisant l'objectif.", trace });
  } catch (err) {
    console.error("[assistant] runAssistant failed", err);
    return { configured: true, ok: false, reply: "", trace, error: "Une erreur est survenue côté assistant. Reformulez votre demande ou réessayez dans un instant." };
  } finally {
    // Dans le `finally` : le constat est déposé sur TOUS les chemins de sortie, y compris
    // l'erreur — un tour raté est justement celui qu'on veut pouvoir expliquer.
    recordShadow(question, allTools.length, usedTools);
    observeRollout(rollout, { user, allToolCount: allTools.length, exposed: tools.length, usedTools, discoveryCalls, startedAt: turnStartedAt });
  }
}
