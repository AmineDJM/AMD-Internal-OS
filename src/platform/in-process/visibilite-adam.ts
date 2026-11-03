import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutVoirAdam } from "@/lib/rbac";

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
 * `exigerAdamVisible` est la porte d'un SEGMENT : elle ne demande aucun module, seulement la
 * personne et la règle, et répond comme une adresse inconnue — dire « réservé » annoncerait un
 * produit qu'on ne montre pas. Les pages, elles, gardent leur `requireModule` et lisent la règle
 * par la réexportation ci-dessous : une navigation côté client entre deux pages d'un même segment
 * ne rejoue pas le gabarit, donc chaque page porte sa propre garde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export { peutVoirAdam, REFUS_ADAM } from "@/lib/rbac";
// L'ASSISTANT IA (/assistant) n'est pas Adam : sa règle est un module ouvert personne par personne, et
// il la lit dans `@/lib/rbac` directement (lot J0) — il ne passe plus par le pont d'Adam.

// L'ÉCRAN D'ADAM EN ONGLETS (02/11/2026) — la barre et la règle des anciennes adresses `/chief-of-staff/*` passent par le
// PONT, pour la même raison que la règle : un import direct depuis une page d'Adam serait un franchissement compté.
export { versEcranAdam } from "@/lib/labels";
export { OngletsAdam } from "@/components/shared/onglets-adam";

export async function exigerAdamVisible() {
  const user = await requireUser();
  if (!peutVoirAdam(user)) notFound();
  return user;
}
