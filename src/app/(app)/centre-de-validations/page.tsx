import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { getPendingValidations } from "@/lib/queries/validations";
import { ouvreLeCentreDeValidations, centreCounters, sortForCentre } from "@/lib/validations/centre";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { ValidationCentreBoard, type CentreRow } from "./centre-board";
import { SeuilBCCentre } from "./seuil-bc";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de validations — AMD Internal OS" };

/**
 * LE CENTRE DE VALIDATIONS — le pendant du centre de paiement, côté décisions.
 *
 * Le Directeur Général et le Super Admin reçoivent des demandes de validation de tous les modules.
 * Elles se noyaient dans l'écran commun des validations, entre leurs propres demandes et les blocs
 * de suivi — au point qu'on découvrait une signature attendue depuis six jours en cherchant autre
 * chose. Cet écran ne contient QUE ce qu'on attend d'eux, avec de quoi décider sur place : le
 * contexte, les pièces (aperçu inclus) et le lien vers la demande SOURCE.
 *
 * `/validations` ne disparaît pas : c'est là qu'on DEMANDE une validation et qu'on suit les
 * siennes. Ici, on ne fait que décider.
 */
export default async function CentreDeValidationsPage() {
  // LA CLÉ SEULE (24/11/2026) : `VALIDATION_CENTRE`, réglée dans Administration › Accès. Accorder ouvre, bloquer ferme —
  // hier, le rôle principal s'ajoutait au module et l'accès donné par la console menait à une page introuvable. La porte
  // du module (`requireModule`, qui tient aussi le masquage) puis la règle nommée, qui écarte un geste prêté. Le centre ne
  // donne aucun droit de trancher pour autrui : il ne montre que les étapes adressées à la personne.
  const user = await requireModule("VALIDATION_CENTRE");
  if (!ouvreLeCentreDeValidations(user)) notFound();

  const [pending, reglages] = await Promise.all([getPendingValidations(user.id), getAppSettings()]);
  const rows: CentreRow[] = sortForCentre(pending);
  const c = centreCounters(rows, new Date());

  return (
    <div className="space-y-5">
      <PageHeader
        title="Centre de validations"
        description="Toutes les demandes de validation qui vous sont adressées, tous modules confondus, la plus urgente en tête. Chaque ligne porte son contexte, ses pièces et le lien vers la demande d'origine : on décide ici, sans aller chercher ailleurs. Ce que vous demandez, vous, reste dans « Demandes de validations »."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="À décider" value={c.aDecider} icon="ShieldCheck"
          tone={c.aDecider > 0 ? "warning" : "default"}
          hint={c.aDecider > 0 ? "C'est ce qui bloque quelqu'un" : undefined}
        />
        <KpiCard
          label="En retard" value={c.enRetard} icon="AlarmClock"
          tone={c.enRetard > 0 ? "danger" : "default"}
          hint="Échéance dépassée"
        />
        <KpiCard
          label="Sans décision depuis 7 j" value={c.dormantes} icon="Hourglass"
          tone={c.dormantes > 0 ? "warning" : "default"}
          hint="Y compris celles sans échéance"
        />
        <KpiCard label="En attente du validateur précédent" value={c.aVenir} icon="Users" tone="info" />
      </div>

      <ValidationCentreBoard rows={rows} />

      {/* LE SEUIL DES BC HORS AD & PRO (Direction, 10/2026) — réglé ici, par les sièges du centre. */}
      <SeuilBCCentre seuil={reglages.bcValidationThresholdCentre} />
    </div>
  );
}
