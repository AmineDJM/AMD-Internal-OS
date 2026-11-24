import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { vueParc } from "@/modules/informatique/api";
import { RegistreParc } from "@/modules/informatique/ecrans/parc";

export const metadata = { title: "Parc informatique — AMD Internal OS" };
export const dynamic = "force-dynamic";

/** PARC INFORMATIQUE — le matériel du groupe (24/11/2026), borné aux sociétés de la personne. */
export default async function ParcPage() {
  const user = await requireModule("INFORMATIQUE_PARC", "VIEW");
  const vue = await vueParc(user.id);
  return (
    <div className="space-y-5">
      <PageHeader title="Parc informatique" />
      <RegistreParc vue={vue} peutCreer={userCan(user, "INFORMATIQUE_PARC", "CREATE")} peutModifier={userCan(user, "INFORMATIQUE_PARC", "UPDATE")} />
    </div>
  );
}
