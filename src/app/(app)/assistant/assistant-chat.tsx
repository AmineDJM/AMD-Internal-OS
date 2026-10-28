"use client";

/**
 * LA CONVERSATION AVEC L'ASSISTANT (page Assistant de l'ERP et bureau d'Adam). Découpé par
 * responsabilité en `assistant-chat/` : `modele` (messages, pièces jointes, nettoyage), `texte-lie`,
 * `conversation` (le composant `AssistantChat`) et ses crochets (`dictee`, `pont-appel`), `accueil`,
 * `reponse-en-cours`, `bulle`, `tour-adam`, `carte-action`, `historique`, `panneau-contexte`,
 * `drive-picker`, et `erp` (ses emprunts à l'ERP, en un point). Ce fichier n'est plus que la PORTE.
 */

export { type ActionState, cleanReply } from "./assistant-chat/modele";
export { LinkifiedText } from "./assistant-chat/texte-lie";
export { AssistantChat } from "./assistant-chat/conversation";
export { ActionCard } from "./assistant-chat/carte-action";
