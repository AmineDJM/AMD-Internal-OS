import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { ouvreLeBureauAdam, peutUtiliserAssistantIA } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÈGLE « ADAM N'EST VISIBLE QUE DU SUPER ADMIN », TENDUE PAR LE PONT (§118.153).
 *
 * La règle vit au socle (`lib/rbac.ts` : `peutVoirAdam`) parce que l'ERP la lit aussi — menu,
 * accueil, fiches qui posent « Demander au Chief ». Les écrans d'Adam en ont besoin à leur tour,
 * et un import direct de `lib/rbac` ou de `lib/session` depuis une page d'Adam est un
 * franchissement que le cliquet de frontière compte : mesuré, 431 pour un plafond de 427, les
 * quatre venant de ce lot (les deux pages et la porte du segment). Le pont est le seul endroit
 * d'Adam autorisé à connaître l'ERP ; c'est donc lui qui la tend (§118.114, §118.136).
 *
 * `exigerBureauAdam` est la porte d'un SEGMENT : la personne et la clé du bureau, et elle répond
 * comme une adresse inconnue — dire « réservé » annoncerait un produit qu'on ne montre pas. Les pages, elles, gardent leur `requireModule` et lisent la règle
 * par la réexportation ci-dessous : une navigation côté client entre deux pages d'un même segment
 * ne rejoue pas le gabarit, donc chaque page porte sa propre garde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export { REFUS_ADAM, ouvreLeBureauAdam } from "@/lib/rbac";
// L'ASSISTANT IA (/assistant) n'est pas Adam : sa règle est un module ouvert personne par personne, et
// il la lit dans `@/lib/rbac` directement (lot J0) — il ne passe plus par le pont d'Adam.

// L'ÉCRAN D'ADAM EN ONGLETS (02/11/2026) — la barre et la règle des anciennes adresses `/chief-of-staff/*` passent par le
// PONT, pour la même raison que la règle : un import direct depuis une page d'Adam serait un franchissement compté.
export { versEcranAdam } from "@/lib/labels";
export { OngletsAdam } from "@/components/shared/onglets-adam";

/**
 * LA PORTE DU BUREAU D'ADAM (segments `/adam` et `/chief-of-staff`) — la clé `CHIEF_OF_STAFF` réglée dans la console
 * (`ouvreLeBureauAdam`, 24/11/2026), et non plus le rôle Super Admin : accorder le bureau l'ouvre réellement, le bloquer le
 * ferme. Par défaut, le Super Admin seul — l'état d'hier. Le refus répond comme une adresse inconnue.
 */
export async function exigerBureauAdam() {
  const user = await requireUser();
  if (!ouvreLeBureauAdam(user)) notFound();
  // L'onglet « Conversation » mène à `/assistant`, qui suit son propre module : il ne s'affiche qu'à qui l'a.
  return { user, conversation: peutUtiliserAssistantIA(user) };
}
