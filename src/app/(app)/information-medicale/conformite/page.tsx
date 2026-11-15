import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { hasRole } from "@/lib/rbac/roles";
import { PageHeader } from "@/components/shared/page-header";
import { fileConformite } from "@/modules/ad-pro/api";
import { ListeAgences } from "../../agences/liste-agences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contrôles de conformité — AMD Internal OS" };

/**
 * CONTRÔLES DE CONFORMITÉ (Direction, 15/11/2026) — les BAT que la Direction Marketing a transmis à l'information médicale,
 * le plus ancien en tête. Chaque ligne ouvre le poste, où le BAT se lit et la conformité se décide.
 */
export default async function ConformitePage() {
  const user = await requireUser();
  if (!hasRole(user, "MEDICAL_INFO_PHARMACIST") && !hasRole(user, "SUPER_ADMIN") && !hasRole(user, "PRODUCT_MANAGER")) notFound();
  const lignes = await fileConformite();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Contrôles de conformité"
        description="Les BAT des agences à vérifier avant impression : mentions légales, visa publicitaire, allégations."
      />
      <ListeAgences lignes={lignes.map((l) => ({ ...l, aMoi: hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN") }))} vide="Aucun BAT à contrôler." action="Contrôler" />
    </div>
  );
}
