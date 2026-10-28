import { requireUser } from "@/lib/session";
import { personalContext, getThreadMessages } from "@/lib/assistant-memory";
import { consignerProvenance } from "@/platform/in-process/fabric/provenance";
import {
  runAssistant, extractSources, executeReadTool, buildProposal, RESOLVER_WRITE_NAMES,
  type ChatTurn, type ProposedAction,
} from "@/lib/assistant";
import { isDirectOn } from "@/lib/assistant/capability-surface";
import { canUseRealtimeVoice, capToolOutput, DELEGATE_TOOL_NAME } from "@/lib/assistant/voice-realtime";
import { delegationLooksReflexive } from "@/lib/assistant/triage";
import { withTurn, markComplexity, markPreview, markFinal, logTurn, setTurnContext } from "@/lib/models/telemetry";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// La délégation peut faire tourner la boucle agent complète : on lui laisse la même marge
// que le flux texte. Les fast paths, eux, répondent en une à trois secondes.
export const maxDuration = 300;

/**
 * EXÉCUTION D'UN OUTIL DEMANDÉ PAR LA SESSION VOCALE.
 *
 * Le modèle temps réel n'exécute RIEN lui-même : chaque function call revient ici, sur le
 * backend AUTHENTIFIÉ, où le droit est re-vérifié à chaque appel (`executePowerTool` — la
 * liste d'outils envoyée au modèle n'est qu'une suggestion). Deux familles :
 *
 *   • FAST PATH — un PowerTool de lecture : exécuté tel quel, le MÊME outil que le texte ;
 *   • DÉLÉGATION (`delegate_to_chief_of_staff`) — l'orchestrateur texte complet tourne avec
 *     l'historique du fil : les ACTIONS reviennent en PROPOSITIONS (cartes de confirmation
 *     affichées à l'écran, rien d'exécuté), les analyses profondes en réponse structurée.
 *
 * La réponse porte deux canaux : `output` (ce que le modèle vocal reçoit, borné) et `ui`
 * (cartes d'action, sources, réponse détaillée) que l'écran affiche pendant que la voix parle.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!canUseRealtimeVoice(user)) {
    return Response.json({ error: "Non autorisé.", reasonCode: "FORBIDDEN" }, { status: 403 });
  }

  let body: { name?: string; input?: Record<string, unknown>; threadId?: string | null };
  try { body = (await req.json()) as typeof body; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name : "";
  const input = body.input && typeof body.input === "object" ? body.input : {};
  if (!name) return Response.json({ error: "Nom d'outil manquant." }, { status: 400 });

  const t0 = Date.now();
  console.info("[voice] voice_tool_called", { userId: user.id, tool: name });

  // LE TOUR EST MESURÉ, ET SA VOIE EST NOMMÉE. C'est ce qui permet de vérifier la règle du
  // triage sur des faits : un fast path ne doit produire AUCUN appel à l'orchestrateur, une
  // délégation en produit par construction. La ventilation par rôle le montre sans discussion.
  const delegating = name === DELEGATE_TOOL_NAME;
  return withTurn(delegating ? "voice-deep" : "voice-direct", async (trace) => {
  setTurnContext({ userId: user.id, feature: "voice", ...(typeof body.threadId === "string" && body.threadId ? { threadId: body.threadId } : {}) });
  try {
    if (name === DELEGATE_TOOL_NAME) {
      const request = typeof input.request === "string" ? input.request.trim() : "";
      if (!request) return Response.json({ output: "Demande vide — reformuler.", ui: null });

      // NIVEAU C ASSUMÉ. Le motif dit ce qu'il fallait DÉCOUVRIR ; un motif creux signale un
      // réflexe plutôt qu'un jugement. On le CONSIGNE sans bloquer : transformer une mesure en
      // panne ferait perdre une vraie demande pour une heuristique de texte.
      markComplexity("C");
      const reason = typeof input.reason === "string" ? input.reason : undefined;
      if (delegationLooksReflexive(reason)) {
        console.info("[voice] delegation_without_discovery", { userId: user.id, reason: (reason ?? "").slice(0, 160) });
      }

      // L'orchestrateur reçoit le MÊME fil que le texte : les derniers échanges + la demande.
      const threadId = typeof body.threadId === "string" ? body.threadId : null;
      const recent = threadId ? await getThreadMessages(user.id, threadId, 12).catch(sansBloquer("tool-route.POST.getThreadMessages", null)) : null;
      const history: ChatTurn[] = [
        ...(recent ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: request },
      ];
      const personal = await personalContext(user.id).catch(sansBloquer("tool-route.POST.personalContext", null));
      const result = await runAssistant(user, history, { personalContext: personal, origin: "voice", turnContext: { ...(threadId ? { threadId } : {}), feature: "assistant" } });
      // LA PROVENANCE DU TOUR (F8) — la voix consigne comme le texte : « d'où tu tiens ça ? » vaut à l'oral.
      if (result.provenance) await consignerProvenance({ userId: user.id, threadId, question: request, faits: result.provenance });

      const proposals: ProposedAction[] = result.proposals ?? (result.proposal ? [result.proposal] : []);
      const output = JSON.stringify({
        reponse: capToolOutput(result.ok ? result.reply : (result.error ?? "Le moteur n'a pas pu traiter la demande."), 5_000),
        actionsProposees: proposals.map((p) => ({ titre: p.title, niveau: p.level ?? "NORMAL" })),
        consigne: proposals.length
          ? "Les cartes de confirmation sont AFFICHÉES À L'ÉCRAN — inviter à confirmer là ; ne JAMAIS dire que c'est fait."
          : undefined,
      });
      console.info("[voice] voice_tool_completed", { userId: user.id, tool: name, latencyMs: Date.now() - t0, proposals: proposals.length });
      return Response.json({
        output,
        latencyMs: Date.now() - t0,
        ui: {
          reply: result.ok ? result.reply : null,
          proposals: proposals.length ? proposals : null,
          trace: result.trace,
          sources: [],
        },
      });
    }

    // ── ÉCRITURE EN FAST PATH — le correctif du « je ne peux pas envoyer d'e-mail » ────────
    //
    // La voix n'annonçait que des lectures. Elle pouvait donc TOUT lire et RIEN faire, alors que
    // `send_email` et `create_task` existent et fonctionnent en texte depuis toujours. Pire, la
    // consigne de délégation lui interdit (à raison) de déléguer un niveau B : « envoie un mail
    // à Alla en disant… » n'avait donc AUCUN chemin, et sortait en incapacité inventée.
    //
    // Le chemin est ici, et il est COURT : capability → `buildProposal` → carte à l'écran. Pas
    // d'orchestrateur, pas de Terra-medium, pas de second tour de modèle — la demande porte déjà
    // tous les gestes. UNE carte, UNE confirmation, et l'exécution reste sur le circuit canonique
    // (RBAC revérifié, intent persistant, reçu, idempotence) : c'est `buildProposal` qui la
    // construit, exactement comme en texte.
    if (isDirectOn(user, "voice", name) && RESOLVER_WRITE_NAMES.has(name)) {
      markComplexity("B");
      const proposal = await buildProposal(name, input, user);
      if ("error" in proposal) {
        console.info("[voice] voice_write_refused", { userId: user.id, tool: name, motif: proposal.error.slice(0, 120) });
        return Response.json({
          output: JSON.stringify({ refus: proposal.error, consigne: "Dire le motif tel quel, brièvement. Ne pas inventer une incapacité générale." }),
          latencyMs: Date.now() - t0,
          ui: null,
        });
      }
      console.info("[voice] voice_tool_completed", { userId: user.id, tool: name, latencyMs: Date.now() - t0, proposals: 1 });
      return Response.json({
        // Ce que la voix reçoit : de quoi ANNONCER la carte, jamais de quoi prétendre l'avoir faite.
        output: JSON.stringify({
          carteAffichee: proposal.title,
          champs: proposal.fields.map((f) => `${f.label} : ${f.value}`),
          avertissements: proposal.warnings.length ? proposal.warnings : undefined,
          consigne:
            "La carte de confirmation est AFFICHÉE À L'ÉCRAN. Annonce-la en une phrase avec l'essentiel "
            + "(destinataire, objet), puis attends la confirmation. Ne dis JAMAIS que c'est envoyé ni fait.",
        }),
        latencyMs: Date.now() - t0,
        ui: { reply: null, proposals: [proposal], trace: [], sources: [] },
      });
    }

    // FAST PATH — le même registre que le texte, le même garde, re-vérifié à chaque appel.
    // Niveau A du point de vue de CET appel : la session temps réel enchaîne elle-même les
    // lectures d'un niveau B, et chacune revient ici séparément.
    //
    // `executeReadTool` PLUTÔT QUE `executePowerTool` : le premier englobe le second puis couvre
    // les lectures du registre texte (`search_people`, `read_workflow`…). Passer par le second
    // seul limitait la voix aux « outils de pouvoir » — encore une frontière qui n'existait que
    // par accident d'implémentation, et qui aurait fait dire « outil inconnu » d'une capacité
    // annoncée deux secondes plus tôt au même modèle.
    markComplexity("A");
    const output = await executeReadTool(name, input, user);
    console.info("[voice] voice_tool_completed", { userId: user.id, tool: name, latencyMs: Date.now() - t0, ok: output.length > 0 });
    return Response.json({
      output: capToolOutput(output),
      latencyMs: Date.now() - t0,
      // Les liens internes du résultat nourrissent le panneau CONTEXTE pendant que la voix parle.
      ui: { sources: extractSources(output), reply: null, proposals: null, trace: [] },
    });
  } catch (err) {
    console.error("[voice] voice_tool_error", { userId: user.id, tool: name, err: err instanceof Error ? err.message : String(err) });
    // L'échec se DIT (« je n'arrive pas à récupérer… ») — jamais improvisé en réponse métier.
    return Response.json({
      output: "La lecture a échoué (donnée momentanément indisponible). Le dire simplement, ne rien inventer.",
      latencyMs: Date.now() - t0,
      ui: null,
    });
  } finally {
    markPreview();
    markFinal();
    logTurn(trace);
  }
  });
}
