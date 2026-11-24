import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { Onglets } from "@/components/produits/ui-360";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { CHEMIN_CONFORMITE } from "@/lib/chemins/ad-pro";
import { declarationsAFaire } from "@/lib/queries/information-medicale-a-faire";
import { fileConformite } from "@/modules/ad-pro/api";
import { CreateDeclarationButton } from "./[id]/panels";
import { Registre } from "./registre";
import { DeclarationsAFaire } from "./declarations-a-faire";
import { AncreBatVersConformite } from "./ancre-bat";

export const dynamic = "force-dynamic";

/**
 * INFORMATION MÉDICALE — les DOSSIERS et leurs déclarations, en deux onglets : « À faire » (par défaut pour le pharmacien),
 * rangé par tour, et « Registre » (tous les dossiers). Les BAT ne s'y répètent plus (Super Admin, 24/11/2026) : ils vivent
 * dans « Contrôles de conformité », vers lequel « À faire » renvoie d'une ligne quand il y en a à contrôler.
 */
export default async function MedicalInfoPage(props: { searchParams?: Promise<{ vue?: string }> }) {
  const user = await requireModule("MEDICAL_INFO");
  const vue = (await props.searchParams)?.vue;
  const pharmacien = hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN");
  const registre = vue === "registre" || (vue !== "a-faire" && !pharmacien);

  // LE PHARMACIEN OUVRE, LES AUTRES LISENT. Le geste appartient à qui instruit le dossier.
  const canOpen = hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");

  return (
    <div className="space-y-5">
      <AncreBatVersConformite />
      <PageHeader title="Information médicale">
        {canOpen && <CreateDeclarationButton />}
      </PageHeader>

      <Onglets
        label="Vues de l'information médicale" actif={registre ? "registre" : "a-faire"}
        items={[
          { cle: "a-faire", label: "À faire", href: "/information-medicale?vue=a-faire" },
          { cle: "registre", label: "Registre", href: "/information-medicale?vue=registre" },
        ]}
      />

      {registre ? <Registre user={user} /> : <AFaire user={user} />}
    </div>
  );
}

async function AFaire({ user }: { user: SessionUser }) {
  const [bat, declarations] = await Promise.all([fileConformite(user), declarationsAFaire(user)]);
  const nbBat = bat?.aControler.length ?? 0;
  return (
    <div className="space-y-5">
      {nbBat > 0 && (
        <Link
          href={CHEMIN_CONFORMITE}
          className="flex items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/[0.03] px-3 py-2.5 text-sm font-medium hover:bg-primary/[0.06] sm:px-4"
        >
          {nbBat} BAT à contrôler <span className="inline-flex items-center gap-1 text-primary">Contrôles de conformité <ArrowUpRight className="h-4 w-4" /></span>
        </Link>
      )}
      <DeclarationsAFaire tours={declarations.tours} aVenir={declarations.aVenir} gestionnaire={declarations.gestionnaire} />
    </div>
  );
}
