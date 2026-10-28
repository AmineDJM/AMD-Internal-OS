"use client";

/**
 * COUCHE TRANSPORT DE L'APPEL VOCAL — l'abstraction `VoiceRealtimeProvider` et son
 * implémentation actuelle `OpenAIGptRealtime21Provider` (API Realtime OpenAI, WebRTC).
 *
 * Pourquoi une abstraction : le moteur vocal ÉVOLUERA (gpt-realtime-2.1 aujourd'hui, un
 * successeur type gpt-live demain). Toute la logique métier du Chief of Staff vit AILLEURS
 * (outils côté serveur, conversation persistée, cartes de confirmation) : remplacer le moteur
 * = réimplémenter CETTE interface, rien d'autre.
 *
 * Ce que fait l'implémentation WebRTC :
 *   • micro → piste WebRTC directe vers l'API Realtime (le média ne transite PAS par notre
 *     backend) ; la réponse revient en piste audio distante, jouée en continu (streaming) ;
 *   • un data channel (« oai-events ») porte les événements : transcriptions (utilisateur et
 *     assistant), débuts/fins de parole, appels d'outils, erreurs ;
 *   • chaque function call est exécuté par NOTRE backend authentifié (callTool) — jamais ici.
 *
 * Les deux invariants de FIABILITÉ de cette couche (pannes réelles de production) :
 *
 *   1. PROPRIÉTÉ DE LA RÉPONSE — « je vais analyser » puis silence infini. Chaque résultat
 *      d'outil crée une OBLIGATION DE RESTITUTION (`PendingDelivery`) qui ne s'éteint que
 *      lorsqu'une réponse a réellement PARLÉ. Poser le function_call_output dans la
 *      conversation ne suffit JAMAIS : la complétion RÉVEILLE la conversation
 *      (`requestResponse`), les collisions avec les réponses auto-créées par la VAD serveur
 *      (`conversation_already_has_active_response`) replanifient au lieu de perdre
 *      l'intention, un WATCHDOG déterministe rattrape tout create perdu (« dépendances
 *      complètes && aucune réponse en cours && l'utilisateur ne parle pas » — jamais un
 *      setTimeout aveugle), une réponse « muette » (complétée sans un mot) est détectée et
 *      relancée, et un résultat arrivé après la fin de session est PERSISTÉ dans le fil.
 *      Livraison EXACTLY-ONCE : l'obligation est portée par UNE réponse identifiée — jamais
 *      deux restitutions du même résultat.
 *
 *   2. ÉVÉNEMENTS PÉRIMÉS & BARGE-IN NATIF — les interruptions fantômes « (intervention
 *      vocale) ». Chaque événement de contenu est LIÉ à la réponse (`response_id`) et au
 *      segment de parole (`item_id`) qui le portent : les deltas d'une réponse ANNULÉE ne
 *      polluent plus le transcript ni l'état, un delta d'un ANCIEN segment ne confirme jamais
 *      une nouvelle fenêtre, et un segment ne produit qu'UNE confirmation (debounce).
 *      L'interruption est NATIVE (le serveur coupe via `interrupt_response`) ; le client la
 *      confirme vite et STT-INDÉPENDANT (parole soutenue ≥ 180 ms OU mots transcrits — voir
 *      `bargeInDecision`) puis vide le tampon audio local. La robustesse à l'écho revient à
 *      l'annulation d'écho du navigateur + `semantic_vad`, plus à une gymnastique de mots qui
 *      retardait les vraies interruptions. En pièce silencieuse, un commit de bruit est
 *      SUPPRIMÉ de la conversation et la réponse auto qu'il a déclenchée est annulée avant
 *      d'avoir parlé : zéro fausse intervention.
 *
 * Le secret utilisé est ÉPHÉMÈRE (fourni par /api/assistant/voice/session) : aucune clé longue
 * durée n'existe côté navigateur.
 *
 * Découpé par responsabilité en `realtime-voice/` : `contrats` (l'interface du fournisseur, ses
 * rappels, les événements, la consommation), `refus-sdp` (le refus de l'échange SDP), `socle` (l'état
 * d'un appel, la restitution, le barge-in, les gestes publics) et `fournisseur` (la connexion WebRTC
 * et la lecture des événements). Ce fichier n'est plus que la PORTE qui les réexporte.
 */

export { type VoiceCallState, type VoiceSessionGrant, type VoiceToolUi, usageVide, cumulerUsage } from "./realtime-voice/contrats";
export { OpenAIGptRealtime21Provider } from "./realtime-voice/fournisseur";
