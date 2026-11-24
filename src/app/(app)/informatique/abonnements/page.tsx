import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { vueAbonnements } from "@/modules/informatique/api";
import { RegistreAbonnements } from "@/modules/informatique/ecrans/abonnements";

export const metadata = { title: "Abonnements & licences — AMD Internal OS" };
export const dynamic = "force-dynamic";

/** ABONNEMENTS & LICENCES — le registre du département Informatique (24/11/2026), borné aux sociétés de la personne. */
export default async function AbonnementsPage({ searchParams }: { searchParams: Promise<{ abonnement?: string }> }) {
  const user = await requireModule("INFORMATIQUE_ABONNEMENTS", "VIEW");
  const [vue, { abonnement }] = await Promise.all([vueAbonnements(user.id), searchParams]);
  return (
    <div className="space-y-5">
      <PageHeader title="Abonnements & licences" />
      <RegistreAbonnements
        vue={vue} ouvrir={abonnement ?? null}
        peutCreer={userCan(user, "INFORMATIQUE_ABONNEMENTS", "CREATE")} peutModifier={userCan(user, "INFORMATIQUE_ABONNEMENTS", "UPDATE")}
      />
    </div>
  );
}
