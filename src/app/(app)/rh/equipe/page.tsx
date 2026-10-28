import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { prisma } from "@/lib/prisma";
import { getRhData } from "@/lib/queries/hr";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { CONTRACT_TYPE, EMPLOYES_TABS } from "@/lib/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateRecordButton, type FieldDef } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createEmployee, analyzeEmployeeContract } from "@/lib/actions/hr-actions";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { getMyCompanies, companyOptions } from "@/lib/company";
import { getDepartmentOptions } from "@/lib/departments";
import { toNumber } from "@/lib/utils";
import { TeamDirectory, type DirectoryRow } from "../team-directory";
import { lireSensiblesPour } from "@/lib/coffre/lecture";

export const dynamic = "force-dynamic";

/**
 * RH › EMPLOYÉS › ÉQUIPE — qui travaille ici, où, et sous quel contrat (maquette validée par la Direction, 07/10).
 *
 * Une ligne de résumé (effectif, actifs, contrats à échéance — ce dernier filtre la table), « Nouvel employé », et la
 * table. Les quatre chiffres, le camembert, la masse salariale par entité (elle vit dans la Paie) et la carte des
 * contrats à échéance (remplacée par le filtre et la pastille de la table) ont quitté l'écran.
 */
export default async function RhTeamPage() {
  const user = await requireModule("EMPLOYEES");
  // LA MÊME RÈGLE que la fiche et la paie (`hr/confidentialite.ts`) — et le salaire n'est pas SÉRIALISÉ quand la colonne
  // est masquée : il partirait dans les données de la page, lisibles dans le navigateur (audit 360°, S5).
  const canSeeSalary = voitLesSalaires(user);
  const canCreate = userCan(user, "EMPLOYEES", "CREATE");

  const [data, tabs, companies, departmentOptions, linkableUsers] = await Promise.all([
    getRhData(user.id), visibleTabs(user, EMPLOYES_TABS),
    canCreate ? getMyCompanies(user.id) : Promise.resolve([]),
    canCreate ? getDepartmentOptions() : Promise.resolve([]),
    canCreate
      ? prisma.user.findMany({ where: { isActive: true, employee: { is: null } }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
  ]);

  // L'échéance « proche » est celle du compteur de l'en-tête — une seule règle, calculée côté serveur.
  const echeances = new Set(data.contractsExpiring.map((e) => e.id));
  // LE COFFRE (refonte V2-E) : la colonne « Salaire » se lit par la politique, journalisée — et pas du tout
  // quand elle est masquée (rien n'est lu, rien n'est sérialisé).
  const salaires = canSeeSalary
    ? await lireSensiblesPour(user, { modele: "Employee", champs: ["baseSalary"], geste: "Équipe — liste des salaires", lignes: data.employees.map((e) => ({ id: e.id, clair: e })) })
    : null;
  const rows: DirectoryRow[] = data.employees.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    position: e.position,
    department: e.department,
    contractType: e.contractType,
    contractEnd: e.contractEnd?.toISOString() ?? null,
    echeanceProche: echeances.has(e.id),
    baseSalary: salaires?.get(e.id)?.baseSalary.lu ? Number(salaires.get(e.id)!.baseSalary.valeur ?? 0) : null,
    leaveBalanceDays: toNumber(e.leaveBalanceDays),
    hasAccount: Boolean(e.user),
    isActive: e.isActive,
    email: e.email,
    phone: e.phone,
  }));

  const employeeFields: FieldDef[] = [
    { type: "text", name: "fullName", label: "Nom complet", required: true, full: true },
    { type: "text", name: "position", label: "Poste" },
    // Rattachement STRUCTURÉ (département ou sous-département) — remplace l'ancien texte libre.
    { type: "select", name: "departmentId", label: "Département", options: departmentOptions.map((o) => ({ value: o.id, label: o.label })), placeholder: "— Non affecté —" },
    { type: "select", name: "companyId", label: "Entité", options: companyOptions(companies), placeholder: "— Entité —" },
    { type: "select", name: "contractType", label: "Type de contrat", options: optionsFromMap(CONTRACT_TYPE), placeholder: "—" },
    { type: "number", name: "baseSalary", label: "Salaire de base (DZD)" },
    { type: "number", name: "leaveBalanceDays", label: "Solde congés (jours)", defaultValue: 30 },
    { type: "date", name: "hireDate", label: "Date d'embauche" },
    { type: "date", name: "contractStart", label: "Début de contrat" },
    { type: "date", name: "contractEnd", label: "Fin de contrat (échéance)" },
    { type: "date", name: "birthDate", label: "Date de naissance" },
    { type: "text", name: "email", label: "Email", inputMode: "email", autoComplete: "off" },
    { type: "text", name: "phone", label: "Téléphone", inputMode: "tel", autoComplete: "off" },
    { type: "text", name: "iban", label: "RIB / IBAN" },
    { type: "text", name: "nationalId", label: "NIN" },
    { type: "text", name: "cnasNumber", label: "N° CNAS" },
    { type: "text", name: "address", label: "Adresse", full: true },
    { type: "select", name: "managerId", label: "Manager (N+1)", options: data.employees.map((e) => ({ value: e.id, label: e.fullName })), placeholder: "—" },
    { type: "select", name: "userId", label: "Compte applicatif lié", options: linkableUsers.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })), placeholder: "Aucun" },
  ];

  const { total, active, expiring } = data.stats;

  return (
    <div className="space-y-5">
      {/* L'en-tête de `PageHeader`, avec un résumé qui porte un lien (sa description n'est qu'un texte). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="break-words text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Équipe</h1>
          <p className="text-sm text-muted-foreground">
            <b className="font-semibold text-foreground">{total}</b> salarié{total > 1 ? "s" : ""}
            {" · "}<b className="font-semibold text-foreground">{active}</b> actif{active > 1 ? "s" : ""}
            {expiring > 0 && (
              <>
                {" · "}
                <Link href="/rh/equipe?contrat=echeance" className="text-warning hover:underline">
                  {expiring} contrat{expiring > 1 ? "s arrivent" : " arrive"} à échéance
                </Link>
              </>
            )}
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap items-center gap-2">
            <CreateRecordButton label="Nouvel employé" title="Ajouter un employé" redirectBase="/rh"
              description="Dossier complet : contrat, état civil, solde de congés et compte applicatif." action={createEmployee} fields={employeeFields}
              analyze={{
                action: analyzeEmployeeContract,
                buttonLabel: "Analyser le contrat",
                title: "Pré-remplir depuis un contrat de travail (IA)",
                hint: "Téléversez le contrat (PDF ou image) : l'OCR Mistral + l'IA extraient nom, poste, type de contrat, dates, salaire de base, NIN, CNAS… Tout reste modifiable avant l'enregistrement.",
                accept: ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff",
                disabled: !aiConfigured(),
                disabledHint: phraseIaNonConfiguree(cleModeleRequise(), "l'analyse automatique d'un contrat de travail"),
              }} />
          </div>
        )}
      </div>
      <ModuleTabs tabs={tabs} />

      {rows.length === 0 ? (
        <EmptyState icon="Users" title="Aucun employé" description={canCreate ? "Ajoutez-les avec « Nouvel employé »." : undefined} />
      ) : (
        <TeamDirectory rows={rows} canSeeSalary={canSeeSalary} />
      )}
    </div>
  );
}
