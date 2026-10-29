import { Stethoscope } from "lucide-react";
import type { SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { medecinsConcernesDe } from "../infra/requetes/medecins";
import type { TypeMedecinsConcernes } from "../domaine/medecins-concernes";
import { MedecinsConcernesClient, type PuceMedecin } from "./medecins-concernes-client";

const ORIGINE = {
  LIEN: null, INVITE_CONGRES: "invité du congrès", PRISE_EN_CHARGE: "prise en charge du congrès", ORIGINE_DEMANDE: "à l'origine de la demande",
} as const;

/**
 * LA CARTE « MÉDECINS CONCERNÉS » d'une demande Ad & Pro (Direction, 08/10) — les praticiens de l'annuaire que la demande
 * désigne. C'est ce lien que le cockpit marketing (Leaders d'opinion › Ad & Pro 12 mois, Investi, lettre H·A·B des dépenses) et
 * la fiche du praticien lisent. Modifiable par qui peut MODIFIER la demande.
 */
export async function MedecinsConcernes({ user, entityType, entityId }: { user: SessionUser; entityType: TypeMedecinsConcernes; entityId: string }) {
  const [medecins, peutModifier] = await Promise.all([
    medecinsConcernesDe(entityType, entityId),
    canAccessEntity(user, entityType, entityId, "UPDATE"),
  ]);
  const puces: PuceMedecin[] = medecins.map((m) => ({
    doctorId: m.doctorId, nom: m.nom, specialite: m.specialite, etablissement: m.etablissement, role: m.role, montant: m.montant,
    modifiable: m.source === "LIEN", origine: ORIGINE[m.source],
  }));
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
        <Stethoscope className="h-4 w-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-base">Médecins concernés</CardTitle>
        <InfoBulle label="À propos des médecins concernés">
          Les praticiens de l&apos;annuaire que cette demande désigne. Ils relient la demande à la fiche du médecin, au cockpit marketing (leaders d&apos;opinion, investissements) et aux produits.
        </InfoBulle>
      </CardHeader>
      <CardContent>
        <MedecinsConcernesClient entityType={entityType} entityId={entityId} medecins={puces} peutModifier={peutModifier} />
      </CardContent>
    </Card>
  );
}
