import { requireUser } from "@/lib/session";
import { userCan, peutVoirAdam } from "@/lib/rbac";
import { aiModel } from "@/lib/ai";
import { bindingFor } from "@/lib/models/registry";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { featureEnabled, FEATURES } from "@/lib/features";
import { personalContext, contexteReglesSeules } from "@/lib/assistant-memory";
import { runAssistantStream, type ChatTurn, type AssistantStreamEvent } from "@/lib/assistant";
import { rememberExchange } from "@/lib/memoire-echange";
import { consignerProvenance } from "@/platform/in-process/fabric/provenance";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// La boucle agent peut enchaîner plusieurs appels au modèle : on laisse de la marge.
export const maxDuration = 300;

/**
 * ASSISTANT EN FLUX — la réponse s'écrit sous les yeux au lieu de tomber d'un bloc.
 *
 * Le navigateur ouvre ce flux (Server-Sent Events) et reçoit, dans l'ordre réel des
 * événements : les étapes de lecture (« je consulte vos validations… »), puis le texte mot à
 * mot, puis le résultat complet (proposition d'action à confirmer, fil de conversation).
 *
 * Les garanties de l'assistant sont inchangées : identité issue de la SESSION (jamais du
 * client), assistant désactivé en « Vue exacte », toute action d'écriture interceptée et
 * soumise à confirmation.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  // Adam n'est visible que du Super Admin (§118.153) : l'écran caché, la porte d'API aussi.
  if (!userCan(user, "WORKSPACE", "VIEW") || !peutVoirAdam(user)) return new Response("Non autorisé.", { status: 403 });

  let body: { history?: ChatTurn[]; threadId?: string | null };
  try { body = (await req.json()) as typeof body; } catch { return new Response("Requête invalide.", { status: 400 }); }
  const history = Array.isArray(body.history) ? body.history : [];
  const threadId = typeof body.threadId === "string" ? body.threadId : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      /**
       * CE QU'ADAM CONSTRUIT PASSE ICI — on le RAMASSE au vol.
       *
       * Les blocs de l'espace de travail traversaient ce flux vers le navigateur et n'étaient
       * écrits nulle part : en revenant, la personne retrouvait le texte du tour et perdait
       * l'écran. Les collecter au passage ne coûte rien et ne change pas ce qui est envoyé —
       * c'est le même objet, simplement retenu pour la mémoire du fil.
       */
      const construits: unknown[] = [];
      const send = (e: AssistantStreamEvent) => {
        if (e.type === "workspace") construits.push(e.composition);
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { closed = true; }
      };

      try {
        // CLOISONNEMENT : en « Vue exacte », l'assistant est désactivé — sa mémoire est
        // strictement personnelle et ne s'ouvre à personne, pas même à un administrateur.
        if (user.impersonatedBy) {
          send({ type: "done", result: { configured: true, ok: false, reply: "", trace: [], error: "L'assistant est désactivé en « Vue exacte » : sa mémoire est strictement personnelle." } });
          return;
        }
        // LES TROIS LECTURES D'OUVERTURE PARTENT ENSEMBLE : l'interrupteur IA, le drapeau
        // mémoire et le contexte personnel n'ont aucune dépendance entre eux — en file, elles
        // ajoutaient trois allers-retours de base avant le premier mot.
        const [enabled, memoryOn, personalBrut] = await Promise.all([
          aiFeatureEnabled("assistant"),
          featureEnabled(FEATURES.ASSISTANT_MEMORY.key, user.id),
          personalContext(user.id).catch(sansBloquer("stream-route.start.personalContext", null)),
        ]);
        if (!enabled) {
          send({ type: "done", result: { configured: true, ok: false, reply: "", trace: [], error: "L'assistant IA est actuellement désactivé par l'administrateur." } });
          return;
        }
        // Les RÈGLES enseignées ne dépendent pas du drapeau mémoire : une attestation s'applique toujours.
        const personal = memoryOn ? personalBrut : await contexteReglesSeules(user.id);

        const t0 = Date.now();
        const result = await runAssistantStream(user, history, send, {
          personalContext: personal,
          turnContext: { ...(threadId ? { threadId } : {}), feature: "assistant" },
        });
        const tour = result.turn;
        await logAiUsage({
          feature: "assistant", userId: user.id,
          // LE MODÈLE RÉELLEMENT SERVI, pas un nom de configuration : le premier appel du tour.
          model: tour?.llmCalls ? (Object.entries(tour.callsByRole).find(([, n]) => n > 0)?.[0] ?? aiModel()) : aiModel(),
          // LE FOURNISSEUR RÉELLEMENT SERVI (IA-ASSISTANT-12) : sous ADAM_MODEL_PROVIDER=anthropic, « openai »
          // gravé ici attribuait le coût au mauvais fournisseur.
          provider: bindingFor("worker").provider,
          ok: result.ok, latencyMs: Date.now() - t0, errorCode: result.ok ? null : result.error ?? "error",
          // Le détail de la boucle : ressenti (1er mot), tours, outils, erreurs, temps outils.
          ttftMs: result.metrics?.ttftMs ?? null,
          turns: result.metrics?.turns ?? null,
          toolCalls: result.metrics?.toolCalls ?? null,
          toolErrors: result.metrics?.toolErrors ?? null,
          toolLatencyMs: result.metrics?.toolLatencyMs ?? null,
          // LE COÛT DU TOUR — jetons, cache, réflexion, recherches web, dollars (ou INCONNU).
          turnId: tour?.turnId ?? null,
          route: tour?.route ?? null,
          complexity: tour?.complexity ?? null,
          threadId,
          llmCalls: tour?.llmCalls ?? null,
          inputTokens: tour?.inputTokens ?? null,
          outputTokens: tour?.outputTokens ?? null,
          cachedInputTokens: tour?.cachedInputTokens ?? null,
          reasoningTokens: tour?.reasoningTokens ?? null,
          webSearchCalls: tour?.webSearchCalls ?? null,
          costUsd: tour?.costUsd ?? null,
        });

        const lastUser = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
        // Mémorisation du fil (helpers scopés par userId) — jamais bloquante.
        if (memoryOn && result.ok && result.reply) {
          result.threadId = await rememberExchange(
            user.id, threadId, lastUser, result.reply,
            construits.length ? construits : undefined,
          );
        }
        // LA PROVENANCE DU TOUR (F8) — consignée quel que soit le drapeau mémoire : « d'où tu tiens
        // ça ? » doit avoir une réponse même pour un compte sans mémoire personnelle.
        if (result.provenance) {
          await consignerProvenance({
            userId: user.id, threadId: result.threadId ?? threadId, turnId: tour?.turnId ?? null,
            question: lastUser, faits: result.provenance,
          });
        }
        send({ type: "done", result });
      } catch (err) {
        console.error("[assistant] stream route failed", err);
        send({ type: "done", result: { configured: true, ok: false, reply: "", trace: [], error: "L'assistant a rencontré un problème. Réessayez dans un instant." } });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* déjà fermé */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Empêche la mise en tampon par un proxy : sans cela, le flux arrive… d'un bloc.
      "X-Accel-Buffering": "no",
    },
  });
}
