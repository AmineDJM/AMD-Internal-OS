import { ArrowLeft } from "lucide-react";
import { hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { CHEMIN_AGENCES, LIBELLE_AGENCES } from "@/lib/chemins/ad-pro";
import { BackLink } from "@/components/shared/back-link";

/**
 * LE RETOUR DES PAGES « DEVIS » ET « BILLETS » D'UNE PRISE EN CHARGE — la fiche de la demande pour qui l'ouvre ; sinon la page de
 * l'assistante de direction (« Prospection d'agences », où ces tâches sont listées — 23/11/2026), ou ses sujets. Jamais une
 * page que la personne n'ouvre pas.
 */
export async function RetourPriseEnCharge({ user, scope, id }: { user: SessionUser; scope: "NATIONAL" | "INTERNATIONAL"; id: string }) {
  const module = scope === "NATIONAL" ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";
  const ficheVisible = hasGlobalView(user) || (await canAccessEntity(user, module, id, "VIEW"));
  const [href, libelle] = ficheVisible
    ? [`${scope === "NATIONAL" ? "/congress-national" : "/congress-international"}/${id}`, "La demande"]
    : hasRole(user, "DIRECTION_ASSISTANT") ? [CHEMIN_AGENCES, LIBELLE_AGENCES] : ["/dossiers", "Mes sujets"];
  return <BackLink href={href}><ArrowLeft className="h-4 w-4" /> {libelle}</BackLink>;
}
