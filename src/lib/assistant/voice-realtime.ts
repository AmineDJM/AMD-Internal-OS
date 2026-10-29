import type { CurrentUser } from "@/lib/session";
import { accessibleModules, peutVoirAdam } from "@/lib/rbac";
import { buildChiefOfStaffContext, assistantIdentityContext, assistantToolsFor } from "@/lib/assistant";
import { capabilityDoctrine, voiceDirectNames } from "@/lib/assistant/capability-surface";
import { TRIAGE_RULE } from "@/lib/assistant/triage";
import { personalContext, getThreadMessages, ensurePrimaryThread } from "@/lib/assistant-memory";
import { conversationWorkingSet } from "@/lib/assistant/reasoning";
import { recentActionIntentsContext } from "@/platform/ia/intentions/action-intents";
import { screenActionsContext } from "@/lib/assistant/action-registry";
import { buildTurnDetection } from "@/lib/assistant/voice-tuning";
import { sansBloquer, attendu } from "@/lib/journal";

/**
 * VOIX TEMPS RÉEL — la couche SERVEUR de la conversation speech-to-speech.
 *
 * Le navigateur parle DIRECTEMENT à l'API Realtime d'OpenAI en WebRTC (média sans détour par
 * notre backend) ; notre serveur, lui, garde trois responsabilités que rien ne délègue :
 *   1. l'AUTORISATION — qui a le droit d'ouvrir une session vocale (siège exécutif + module
 *      CHIEF_OF_STAFF), vérifiée ICI, jamais côté client ;
 *   2. la CLÉ — `OPENAI_API_KEY` ne quitte jamais le serveur : le client ne reçoit qu'un
 *      SECRET ÉPHÉMÈRE (quelques minutes) créé via l'endpoint officiel de l'API ;
 *   3. les OUTILS — chaque appel d'outil déclenché par le modèle vocal revient sur notre
 *      backend authentifié, où `executePowerTool` re-vérifie le droit : le modèle propose,
 *      le serveur dispose. MÊMES outils, MÊMES permissions, MÊME conversation que le texte.
 *
 * Le modèle vocal est le SYSTÈME NERVEUX conversationnel — pas le cerveau : les analyses
 * profondes, les écritures et les livrables passent par `delegate_to_chief_of_staff`, qui
 * appelle l'orchestrateur texte existant (mêmes cartes de confirmation, même audit).
 */

/** Le modèle Realtime — surclassable par variable d'environnement, jamais codé en dur ailleurs. */
export const REALTIME_VOICE_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";

/** L'URL d'échange SDP (WebRTC) de l'API Realtime — le client la reçoit du serveur. */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/**
 * LA LANGUE DE LA SESSION — française, et STICKY.
 *
 * Elle est posée à DEUX endroits, et il faut les deux : sur le modèle de transcription (qui
 * sinon devine la langue à chaque segment et bascule sur une phrase courte ou mêlée d'anglais
 * métier) et dans les consignes (qui gouvernent ce que le modèle RÉPOND). Corriger l'un sans
 * l'autre laisse la dérive : le transcript anglais entraîne la réponse anglaise, quelle que
 * soit la consigne.
 *
 * Surchargeable par variable d'environnement — l'entreprise est algérienne, pas monolingue.
 */
export const VOICE_LANGUAGE = (process.env.ADAM_VOICE_LANGUAGE || "fr").trim();

/**
 * Les voix proposées ; « cedar » par défaut — la voix MASCULINE naturelle et posée introduite
 * avec `gpt-realtime` (mid-range chaleureux, professionnel), demandée pour l'appel exécutif.
 * « marin » (l'ancienne par défaut, plutôt féminine et claire) reste disponible. Liste blanche
 * stricte, surchargeable par `OPENAI_REALTIME_VOICE`.
 */
export const REALTIME_VOICES = ["cedar", "marin", "alloy", "echo", "sage", "shimmer", "verse", "ballad", "coral"] as const;

/** La voix par défaut de la session — masculine, réglable par environnement. */
export const DEFAULT_REALTIME_VOICE =
  (REALTIME_VOICES as readonly string[]).includes(process.env.OPENAI_REALTIME_VOICE ?? "")
    ? (process.env.OPENAI_REALTIME_VOICE as string)
    : REALTIME_VOICES[0];

export function realtimeVoiceConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Qui peut OUVRIR une session vocale temps réel : le siège exécutif (PDG + Super Admin) avec le
 * module CHIEF_OF_STAFF — la même porte que la page /chief-of-staff. La dictée (transcription
 * simple) reste ouverte plus largement ; l'appel temps réel est l'interface exécutive.
 */
export function canUseRealtimeVoice(user: CurrentUser): boolean {
  if (user.impersonatedBy) return false; // « Vue exacte » : l'assistant est désactivé
  // Adam n'est visible que du Super Admin (§118.153) : la voix EST Adam.
  if (!peutVoirAdam(user)) return false;
  return accessibleModules(user).includes("CHIEF_OF_STAFF");
}

// ─────────────────────────── Outils exposés à la session ───────────────────────────

/**
 * Les OUTILS DIRECTS de la session vocale.
 *
 * LA LISTE N'EST PLUS ÉCRITE ICI — elle est PROJETÉE depuis l'unique registre de capacités
 * (`capability-surface.ts`). C'était une liste blanche recopiée à la main, et elle avait
 * divergé : trente et un outils, tous en LECTURE, aucune écriture. Adam répondait donc, à
 * l'oral et en toute bonne foi, « la fonction d'envoi d'e-mail n'est pas disponible » — alors
 * que `send_email` existe et que le transport Gmail marche.
 *
 * Conservé comme ALIAS parce que des tests et le banc de mesure le nomment ; la vérité est
 * ailleurs, et c'est le point.
 */
export const VOICE_FAST_TOOL_NAMES: readonly string[] = voiceDirectNames();

/** Le format d'outil attendu par la session Realtime (function calling). */
export interface RealtimeToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** L'outil de DÉLÉGATION : tout ce qui n'est pas un fast path passe par l'orchestrateur. */
export const DELEGATE_TOOL_NAME = "delegate_to_chief_of_staff";

const DELEGATE_TOOL: RealtimeToolDef = {
  type: "function",
  name: DELEGATE_TOOL_NAME,
  description:
    "NIVEAU C — délègue à l'orchestrateur quand tu ne sais pas encore QUOI faire : il faut investiguer, croiser " +
    "plusieurs sources, comprendre une cause, ou inventer la marche à suivre. Délègue aussi ce que tes outils " +
    "rapides ne couvrent pas (livrables Word/Excel/présentation, simulations, études). " +
    "NE DÉLÈGUE PAS une demande dont tu connais déjà les gestes, même s'il y en a plusieurs : c'est un niveau B, " +
    "tu l'exécutes toi-même — déléguer là, c'est un silence payé pour rien. Le nombre d'actions ne fait pas la " +
    "complexité. Formuler `request` comme la demande complète, avec le contexte utile (références, noms). " +
    "Pendant le travail, continuer la conversation ; ne JAMAIS dire qu'une action est faite — dire qu'elle est proposée à l'écran.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "La demande complète, en français, avec le contexte (références, noms)." },
      reason: {
        type: "string",
        description:
          "Ce qu'il faut DÉCOUVRIR et que tu ne sais pas déjà (la cause à comprendre, les sources à croiser, " +
          "l'arbitrage à rendre). C'est ce qui justifie le niveau C plutôt qu'un B exécuté sur-le-champ.",
      },
    },
    required: ["request"],
  },
};

/**
 * LES OUTILS ANNONCÉS À LA SESSION — projetés depuis le registre unique.
 *
 * La source est `assistantToolsFor` : LE MÊME registre que le texte, borné par les MÊMES droits.
 * On n'y puise plus dans `POWER_TOOLS` seul — c'était l'erreur, puisque les écritures
 * (`send_email`, `create_task`…) n'y sont pas et disparaissaient donc de la voix sans que rien
 * ne le signale.
 *
 * L'ordre est significatif pour le modèle : les outils sont émis dans l'ordre de la projection
 * (lectures, puis écritures), la délégation en dernier — le recours, pas le réflexe.
 */
export function realtimeToolsFor(user: CurrentUser): RealtimeToolDef[] {
  const rang = new Map(voiceDirectNames().map((n, i) => [n, i]));
  const direct = assistantToolsFor(user)
    .filter((t) => rang.has(t.name))
    .sort((a, b) => (rang.get(a.name) ?? 0) - (rang.get(b.name) ?? 0))
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>,
    }));
  return [...direct, DELEGATE_TOOL];
}

// ─────────────────────────── Instructions de session ───────────────────────────

/** Les consignes PROPRES à la voix — le ton d'un appel, pas d'une page. */
const VOICE_ADDENDUM = `
CONSIGNES VOCALES — tu es EN LIGNE, à l'oral, avec ton interlocuteur :
- Réponds IMMÉDIATEMENT et BRIÈVEMENT : la réponse d'abord, 5 à 20 secondes de parole pour une
  question normale. Pas de listes récitées, pas de tableau lu à voix haute : résume à l'oral
  (« Il y en a trois ; le plus gros est Hikma, 14,8 millions, bloqué depuis six jours ») — le
  détail s'AFFICHE à l'écran via les outils, tu n'as pas à le dicter.
- Ne raconte JAMAIS tes appels d'outils (« je cherche dans la base… ») : réponds, simplement.
  Si un travail de fond démarre, dis-le en une phrase et CONTINUE — la session ne se fige pas.
- RÉPONSE PROGRESSIVE : donne D'ABORD le fait sûr déjà disponible (« le blocage immédiat est
  Regulatory, rien depuis neuf jours ; je vérifie la cause »), pendant que le reste continue en
  parallèle ; COMPLÈTE dès que ça arrive. Jamais de silence artificiel, jamais d'invention pour
  meubler : ce qui est dit avant la fin d'une analyse est SÛR, qualifié, et se révise.
- Ne dis JAMAIS qu'une action est faite tant que l'outil ne l'a pas confirmé. Une action passe
  par une carte de confirmation À L'ÉCRAN : dis « je te la propose à l'écran », jamais « c'est fait ».
- « C'est envoyé ? », « tu l'as fait ? », « je te l'avais déjà demandé ? » : appelle action_history
  (l'état CANONIQUE serveur) — PROPOSÉE = jamais exécutée ; seule EXÉCUTÉE avec son reçu vaut envoi
  réel. Ne réponds JAMAIS de mémoire à ces questions, ni « envoyé » ni « aucune trace ».
- Après une interruption, ne REDÉMARRE JAMAIS le même préambule (« d'accord, je regarde… ») :
  reprends directement au résultat, ou demande ce que veut l'utilisateur si l'intention a changé.
- Cherche EN SILENCE : pour une lecture rapide, aucun « je vais vérifier » — la réponse suffit,
  et elle TERMINE le tour (pas de « veux-tu que je… » de politesse).
- Si l'utilisateur t'interrompt : tais-toi et suis la nouvelle consigne, sans re-dérouler.
- Garde les références conversationnelles (« il », « elle », « ce paiement », « l'autre ») — la
  conversation est CONTINUE, y compris ce qui s'est dit en mode texte avant l'appel.
- Ne salue pas à chaque tour, ne te présente pas : la conversation est déjà engagée.
- Tu n'es PAS un assistant textuel : tu es l'interface VOCALE de My Chief of Staff — tu entends
  et tu parles.
- LANGUE : tu réponds en FRANÇAIS pour tout l'appel, même si l'arabe ou l'anglais s'y mêlent.
  Un résultat d'outil, un nom de champ ou une consigne interne en anglais sont des DONNÉES, pas
  la langue de la conversation. Tu n'en changes que si on te le demande explicitement.
- Un MONTANT dans une action se répète clairement avant confirmation (« 14 millions 800 mille
  dinars »). Un nom ambigu se lève en une question courte (« Nesrine B. ou Nesrine K. ? ») —
  seulement si le doute est réel.
- « Donne-moi juste la réponse » (ou tout signe d'impatience) : raccourcis IMMÉDIATEMENT — le
  chiffre ou le fait, une phrase, rien d'autre, et garde ce registre pour la suite de l'appel.
- CAPACITÉ ≠ EXÉCUTION : UNE suggestion utile est permise (« je peux préparer le comparatif en
  Excel »), puis tu ATTENDS « fais-le ». Jamais d'analyse, de livrable, de rappel ni d'action de
  ta propre initiative.
- « Qu'est-ce que je rate ? » / « où en est la boîte ? » : ceo_attention ou company_state en
  lecture directe. Une investigation ne part QUE si elle est demandée.
- « Où en était ce dossier au… ? » : l'outil time_travel reconstruit l'état PASSÉ depuis le
  journal d'audit — lecture seule, dis ce que le journal montre et ce qu'il ne capture pas.
- « Qu'est-ce qui a changé depuis… ? » / « remets-moi à niveau » : what_changed (changements
  tracés + qui a agi + état actuel). « On avait parlé de quoi / fait quoi cette semaine ? » :
  episodic_recall (actions, rappels, décisions, engagements, livrables — objets structurés).
- Ton : professionnel, calme, naturel — jamais robotique, jamais surjoué.

${TRIAGE_RULE}`;

const ymdhm = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/**
 * Les INSTRUCTIONS complètes de la session vocale : identité + contexte commun (la MÊME
 * fonction que le texte, en variante compacte), contexte personnel et mémoire (les mêmes
 * qu'en texte), les derniers échanges du fil (BORNÉS — jamais tout l'historique), et les
 * consignes vocales. Le reste du passé se retrouve par recall_conversation.
 *
 * `screenContext` (optionnel) : D'OÙ l'appel démarre — la fiche ou la page que l'utilisateur
 * regarde (« Appeler » depuis un paiement, un contrat…). Route + référence, JAMAIS une capture
 * d'écran : c'est ce qui rend « où ça bloque ? » résoluble dès la première seconde.
 */
export async function buildVoiceInstructions(
  user: CurrentUser,
  threadId: string | null,
  screenContext?: string | null,
): Promise<string> {
  const parts: string[] = [buildChiefOfStaffContext(user, { voice: true })];

  const personal = await personalContext(user.id).catch(sansBloquer("voice-realtime.buildVoiceInstructions.personalContext", null));
  if (personal) parts.push(`\nCONTEXTE PERSONNEL\n${personal}`);

  if (threadId) {
    // Une fenêtre LARGE (60) pour extraire les ENTITÉS ACTIVES (« et le fournisseur ? »,
    // « fais pareil pour Nivo » se résolvent au-delà des derniers tours), une fenêtre COURTE
    // (16) pour le verbatim — le budget de contexte temps réel se paie en latence.
    const wide = await getThreadMessages(user.id, threadId, 60).catch(sansBloquer("voice-realtime.buildVoiceInstructions.getThreadMessages", null));
    const recent = wide ? wide.slice(-16) : null;
    if (recent && recent.length > 0) {
      const lines = recent.map((m) =>
        `${m.role === "user" ? "PDG" : "Toi"} (${ymdhm(m.createdAt)}) : ${m.content.replace(/\s+/g, " ").slice(0, 280)}`,
      );
      parts.push(
        `\nCONVERSATION RÉCENTE (le même fil continue — résoudre « il », « ce paiement »… avec ceci) :\n${lines.join("\n")}`,
      );
    }
    const ws = wide ? conversationWorkingSet(wide) : null;
    if (ws) parts.push(`\n${ws}`);
  }

  // QUI IL EST ET DEPUIS QUELLE ADRESSE IL ÉCRIT. À la voix plus encore qu'au texte : on
  // demande son nom à quelqu'un qu'on entend, et une réponse inventée s'entend tout de suite.
  const identity = await assistantIdentityContext(user, { compact: true }).catch(sansBloquer("voice-realtime.buildVoiceInstructions.assistantIdentityContext", null));
  if (identity) parts.push(`\n${identity}`);

  // ACTIONS RÉCENTES — l'état CANONIQUE serveur : « je te l'avais déjà demandé ? » et
  // « c'est envoyé ? » se répondent d'ici (ou d'action_history), jamais de mémoire.
  const intents = await recentActionIntentsContext(user.id).catch(sansBloquer("voice-realtime.buildVoiceInstructions.recentActionIntentsContext", null));
  if (intents) parts.push(`\n${intents}`);

  const screen = typeof screenContext === "string" ? screenContext.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (screen) {
    parts.push(
      `\nCONTEXTE D'ÉCRAN (au moment de l'appel) : ${screen}\n« ça », « ce dossier », « cette fiche » s'y réfèrent, sauf indication contraire.`,
    );
    // Les BOUTONS NATIFS de cet écran, connus d'emblée : « valide-le », « relance »… se
    // résolvent vers l'action canonique du module sans détour par une demande générique.
    const available = screenActionsContext(user, screen);
    if (available) parts.push(`\n${available}`);
  }

  // CE QU'IL PEUT FAIRE, NOMMÉMENT. Placé APRÈS le contexte et AVANT le ton : c'est une règle
  // dure, pas une nuance de style. Sans elle, un modèle prudent retombe sur le refus — et le
  // refus qu'on vient de corriger n'était pas une hallucination mais une lecture honnête d'une
  // liste d'outils incomplète.
  parts.push(`\n${capabilityDoctrine(user)}`);

  parts.push(VOICE_ADDENDUM);
  return parts.join("\n");
}

// ─────────────────────────── Création du secret éphémère ───────────────────────────

export interface VoiceSessionGrant {
  ok: true;
  /** Secret ÉPHÉMÈRE (ek_…) — le seul credential que le navigateur voit. */
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  callUrl: string;
  voice: string;
  threadId: string | null;
}
export interface VoiceSessionRefusal { ok: false; error: string; reasonCode: string; status: number }

/**
 * Crée le secret éphémère via l'endpoint officiel `/v1/realtime/client_secrets` — la session
 * (modèle, instructions, outils, transcription, détection de tour) est configurée ICI, côté
 * serveur : le client ne peut ni élargir les outils ni réécrire les instructions.
 */
export async function createVoiceSessionGrant(
  user: CurrentUser,
  opts: { threadId?: string | null; voice?: string | null; screenContext?: string | null } = {},
): Promise<VoiceSessionGrant | VoiceSessionRefusal> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: "Le mode vocal temps réel n'est pas configuré (clé OPENAI_API_KEY absente).", reasonCode: "OPENAI_KEY_MISSING", status: 503 };

  // Le fil : celui demandé (s'il appartient au demandeur, getThreadMessages le re-vérifie),
  // sinon LE FIL PRINCIPAL — l'appel vocal continue la conversation, il n'en ouvre pas une autre.
  let threadId = typeof opts.threadId === "string" && opts.threadId ? opts.threadId : null;
  if (!threadId) threadId = await ensurePrimaryThread(user.id).catch(sansBloquer("voice-realtime.createVoiceSessionGrant.ensurePrimaryThread", null));

  const voice = (REALTIME_VOICES as readonly string[]).includes(opts.voice ?? "") ? (opts.voice as string) : DEFAULT_REALTIME_VOICE;
  const instructions = await buildVoiceInstructions(user, threadId, opts.screenContext ?? null);
  const tools = realtimeToolsFor(user);

  const body = {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: REALTIME_VOICE_MODEL,
      instructions,
      tools,
      tool_choice: "auto",
      audio: {
        input: {
          // Transcription PARALLÈLE de ce que dit l'utilisateur — l'UI et l'historique en vivent.
          //
          // ── `language: "fr"` — LA CORRECTION DÉTERMINISTE DE LA DÉRIVE EN ANGLAIS ────────
          //
          // Sans indication, le modèle de transcription DEVINE la langue à chaque segment. Sur
          // une phrase courte, bruitée, ou mêlée d'anglais métier (« le CTD », « le workflow »),
          // il bascule — et une fois le transcript anglais posé dans la conversation, le modèle
          // vocal répond en anglais. La dérive observée en production ne venait donc pas d'un
          // manque de consigne : elle venait de l'ÉTAGE EN DESSOUS de la consigne.
          //
          // Une consigne de prompt ne peut pas corriger cela — elle arrive trop tard, après que
          // le transcript a menti sur la langue. Le paramètre, lui, ferme la question.
          transcription: {
            model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
            language: VOICE_LANGUAGE,
          },
          // Détection de tour NATIVE (semantic_vad, eagerness « low » pour les hésitations
          // françaises ; server_vad tunable pour le benchmark). `interrupt_response` est VRAI
          // par défaut : le serveur coupe la génération dès qu'il entend la parole —
          // l'interruption est immédiate et naturelle, le client ne fait que vider le tampon
          // audio local. Repli `OPENAI_VOICE_INTERRUPT=client` si un écho réel coupait Adam.
          // Voir voice-tuning.ts.
          turn_detection: buildTurnDetection(),
        },
        output: { voice },
      },
    },
  };

  const t0 = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[voice] voice_session_error", { reasonCode: `OPENAI_${res.status}`, httpStatus: res.status, model: REALTIME_VOICE_MODEL, userId: user.id, detail: detail.slice(0, 500) });
      return {
        ok: false,
        error: "Le mode vocal temps réel est momentanément indisponible.",
        reasonCode: `OPENAI_${res.status}`,
        status: 502,
      };
    }
    const data = (await res.json()) as { value?: string; expires_at?: number };
    if (!data.value) {
      console.error("[voice] voice_session_error", { reasonCode: "NO_CLIENT_SECRET", userId: user.id });
      return { ok: false, error: "Le mode vocal temps réel est momentanément indisponible.", reasonCode: "NO_CLIENT_SECRET", status: 502 };
    }
    console.info("[voice] voice_session_created", {
      userId: user.id, model: REALTIME_VOICE_MODEL, voice, threadId,
      tools: tools.length, latencyMs: Date.now() - t0,
    });
    return {
      ok: true,
      clientSecret: data.value,
      expiresAt: data.expires_at ?? null,
      model: REALTIME_VOICE_MODEL,
      callUrl: REALTIME_CALLS_URL,
      voice,
      threadId,
    };
  } catch (err) {
    console.error("[voice] voice_session_error", { reasonCode: "NETWORK", userId: user.id, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Le mode vocal temps réel est momentanément indisponible (réseau).", reasonCode: "NETWORK", status: 502 };
  }
}

/** Un résultat d'outil renvoyé à la session : borné — le contexte temps réel se paie en latence. */
export function capToolOutput(out: string, max = 8_000): string {
  return out.length <= max ? out : `${out.slice(0, max)}… (tronqué pour la session vocale — le détail complet est à l'écran)`;
}
