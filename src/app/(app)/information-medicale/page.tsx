import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Onglets } from "@/components/produits/ui-360";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { CIRCUIT_LABEL, CIRCUIT_HINT } from "@/lib/medical-info/circuits";
import { declarationsAFaire } from "@/lib/queries/information-medicale-a-faire";
import { fileConformite } from "@/modules/ad-pro/api";
import { CreateDeclarationButton } from "./[id]/panels";
import { Registre } from "./registre";
import { BatAControler } from "./bat-a-controler";
import { DeclarationsAFaire } from "./declarations-a-faire";

export const dynamic = "force-dynamic";

/**
 * INFORMATION MÉDICALE — deux onglets (Direction, 23/11/2026) :
 *   • « À faire » (par défaut pour le pharmacien) : les BAT à contrôler, décidés sur la ligne, puis ses déclarations
 *     rangées par TOUR — à lui, chez d'autres, à venir — chacune avec UNE phrase et UN geste ;
 *   • « Registre » : tous les dossiers et leurs tuiles (`registre.tsx`), comme avant.
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
      <PageHeader
        title="Information médicale"
        description="Déclarations à l'ANPP, visas publicitaires, bons de versement, contrôle des BAT"
      >
        <InfoBulle label="Les deux circuits">
          <strong>{CIRCUIT_LABEL.EVENT}</strong> — {CIRCUIT_HINT.EVENT}
          <br /><br />
          <strong>{CIRCUIT_LABEL.PROMO}</strong> — {CIRCUIT_HINT.PROMO}
        </InfoBulle>
        {/* LE PHARMACIEN N'ATTEND PAS TOUJOURS QU'UN DOSSIER LUI ARRIVE : une obligation se
            découvre aussi de son côté, et ce qui n'entre pas dans l'ERP se traite dans un carnet. */}
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
  const peutDecider = hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN");
  return (
    <div className="space-y-8">
      {bat && <BatAControler file={bat} peutDecider={peutDecider} />}
      <DeclarationsAFaire tours={declarations.tours} aVenir={declarations.aVenir} gestionnaire={declarations.gestionnaire} />
    </div>
  );
}

