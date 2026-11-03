/**
 * L'assainissement des mails a DÉMÉNAGÉ au socle partagé (`src/platform/mail/assainir.ts`, lot I1, décision 0063) :
 * c'est une règle pure, sans import, que l'ERP (affichage d'un mail reçu) et l'Assistant IA (mail composé) partagent.
 */
export { assainirStyle, htmlToText, sanitizeMailHtml } from "@/platform/mail/assainir";
