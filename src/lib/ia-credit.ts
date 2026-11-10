/**
 * LE CRÉDIT DU FOURNISSEUR D'IA EST-IL ÉPUISÉ ? — reconnu sur son message d'erreur (OpenAI : HTTP 429 « You have no
 * credits remaining », « insufficient_quota » ; Anthropic : « credit_balance »).
 *
 * Un compte à recharger n'est pas un « refus » ni une panne passagère : réessayer n'y peut rien, et la personne doit
 * savoir qu'il faut prévenir l'administrateur (Moyens généraux, 09/11/2026 : un ticket « refusé » toute une journée,
 * alors que le crédit OpenAI était à zéro depuis le matin). Module PUR : lisible partout.
 */
import { estCreditEpuise } from "@/lib/models/errors";

/** La règle vit dans la passerelle (`models/errors.ts`), qui s'en sert pour passer au secours Claude. */
export function creditIaEpuise(erreur: string | null | undefined): boolean {
  return estCreditEpuise(erreur);
}

/** Ce que l'écran dit quand le crédit est épuisé — le remède et qui l'applique, puis ce qu'on fait en attendant. */
export function phraseCreditIaEpuise(enAttendant: string): string {
  return `Le crédit du service d'IA (compte OpenAI) est épuisé : la lecture n'a pas pu se faire. Prévenez l'administrateur pour qu'il le recharge (platform.openai.com › Billing) — ${enAttendant}`;
}
