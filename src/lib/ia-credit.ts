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

/**
 * LES IA DE SECOURS N'ONT PAS RÉPONDU NON PLUS (19/11/2026) — la passerelle ajoute « — secours : Claude : … ; MiMo : … »
 * à l'échec d'origine. L'écran le dit, court : sans cela, personne ne savait qu'un relais avait été tenté, ni pourquoi il
 * avait échoué. Vide quand aucun secours n'a été tenté.
 */
export function phraseDuSecours(erreur: string | null | undefined): string {
  const m = /—\s*secours\s*:\s*(.+)$/s.exec(erreur ?? "");
  if (!m) return "";
  const raison = m[1].replace(/\s+/g, " ").trim().slice(0, 220);
  return ` Les IA de secours n'ont pas répondu non plus (${raison}).`;
}

/** Ce que l'écran dit quand le crédit est épuisé — le remède et qui l'applique, puis ce qu'on fait en attendant. */
export function phraseCreditIaEpuise(enAttendant: string): string {
  return `Le crédit du service d'IA (compte OpenAI) est épuisé : la lecture n'a pas pu se faire. Prévenez l'administrateur pour qu'il le recharge (platform.openai.com › Billing) — ${enAttendant}`;
}
