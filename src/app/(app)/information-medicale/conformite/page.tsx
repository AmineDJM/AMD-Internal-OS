import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { hasRole } from "@/lib/rbac/roles";
import { PageHeader } from "@/components/shared/page-header";
import { fileConformite } from "@/modules/ad-pro/api";
import { BatAControler } from "../bat-a-controler";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contrôles de conformité — AMD Internal OS" };

/**
 * CONTRÔLES DE CONFORMITÉ (Direction, 15/11/2026) — les BAT que la Direction Marketing a transmis à l'information médicale.
 * LA file de travail du pharmacien (Super Admin, 24/11/2026) : les BAT ne vivent plus qu'ici — l'onglet « À faire » de
 * l'information médicale y renvoie d'une ligne. Décision sur la ligne (le pharmacien) ; la Direction Marketing y lit où en
 * sont ses BAT.
 */
export default async function ConformitePage() {
  const user = await requireUser();
  const file = await fileConformite(user);
  if (!file) notFound();
  return (
    <div className="space-y-5">
      <PageHeader title="Contrôles de conformité" />
      <BatAControler file={file} peutDecider={hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN")} />
    </div>
  );
}
