import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, ChevronRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, estPrete } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { prisma } from "@/lib/prisma";
import { getFieldDefs } from "@/lib/custom-fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { CustomFieldsCard } from "@/components/shared/custom-fields-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CONTRACT_TYPE, LEAVE_TYPE, LEAVE_STATUS, PAYROLL_STATUS } from "@/lib/labels";
import { formatCurrency, formatDate, formatDateTime, toNumber } from "@/lib/utils";
import { getEmployeeHrDossier } from "@/lib/queries/hr-documents";
import { getMyCompanies, companyOptions, entitePermisePourFiche } from "@/lib/company";
import { getDepartmentOptions, getDepartmentPath, getManagerOf } from "@/lib/departments";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { EmployeeForm, type EmployeeFormValues } from "./employee-form";
import { HrDossier } from "./hr-dossier";
import { referenceOrdreMissionSuggeree } from "@/lib/ordre-mission-depot";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { seesWholeGroup } from "@/lib/company-access";
import { CompanyAccessCard, type CompanyAccessRow } from "./company-access-card";
import { BackLink } from "@/components/shared/back-link";
import { lireSensiblesPour } from "@/lib/coffre/lecture";

const d10 = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");

export default async function EmployeeDetailPage({ params }: { params: { id: string } }) {
  const user = await requireModule("EMPLOYEES");
  const canUpdate = userCan(user, "EMPLOYEES", "UPDATE");

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    include: {
      manager: { select: { id: true, fullName: true } },
      user: { select: { id: true, name: true, email: true } },
      leaveRequests: { orderBy: { startDate: "desc" }, take: 20 },
      payrolls: { orderBy: [{ year: "desc" }, { month: "desc" }], take: 5 },
    },
  });
  if (!employee) notFound();
  // LA FICHE NE S'OUVRE PAS PLUS LARGE QUE LA LISTE (§118.184, audit 360° S6) : la liste des salariés
  // est bornée à la société, la fiche se lisait par son seul identifiant.
  if (!(await entitePermisePourFiche(user.id, employee.companyId))) notFound();
  // LA PAIE N'EST PAS DANS LA LECTURE SEULE (S5) : salaire, nets des bulletins, NIN, n° CNAS.
  const salairesVisibles = voitLesSalaires(user);

  const [fieldDefs, otherEmployees, unlinkedUsers, hrDossier, companies, departmentOptions, manager] = await Promise.all([
    getFieldDefs("EMPLOYEE"),
    prisma.employee.findMany({ where: { id: { not: employee.id } }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
    prisma.user.findMany({ where: { isActive: true, employee: { is: null } }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    getEmployeeHrDossier(employee.id),
    getMyCompanies(user.id),
    getDepartmentOptions(),
    // N+1 EFFECTIF, résolu par la cascade (manager désigné → responsable de département → parent).
    getManagerOf(employee.id),
  ]);
  const departmentPath = employee.departmentId ? await getDepartmentPath(employee.departmentId) : [];

  // LE COFFRE (refonte V2-E) : IBAN, NIN et salaires lus par la politique, chaque lecture journalisée — et
  // seulement ce que la page montre (le formulaire à qui modifie, salaire et NIN à qui voit la paie).
  const SENSIBLES = ["iban", "nationalId", "baseSalary", "grossSalary", "netToPay", "employerCost"] as const;
  const lus = new Set<(typeof SENSIBLES)[number]>([...(canUpdate ? SENSIBLES : []), ...(salairesVisibles ? (["baseSalary", "nationalId"] as const) : [])]);
  const sensibles = (await lireSensiblesPour(user, {
    modele: "Employee", champs: [...lus], geste: "Fiche employé — consultation",
    lignes: [{ id: employee.id, clair: employee }],
  })).get(employee.id) ?? {};
  const texte = (c: (typeof SENSIBLES)[number]) => sensibles[c]?.valeur ?? "";
  const montant = (c: (typeof SENSIBLES)[number]) => (sensibles[c]?.valeur ? String(Number(sensibles[c].valeur)) : "");
  const masques: EmployeeFormValues["masques"] = Object.fromEntries(
    SENSIBLES.filter((c) => sensibles[c] && !sensibles[c].lu).map((c) => [c, sensibles[c].masque ?? ""]),
  );

  const managerOptions = otherEmployees.map((e) => ({ value: e.id, label: e.fullName }));
  const userOptions = [
    ...(employee.user ? [{ value: employee.user.id, label: `${employee.user.name} (${employee.user.email})` }] : []),
    ...unlinkedUsers.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
  ];

  const formValues: EmployeeFormValues = {
    id: employee.id,
    fullName: employee.fullName,
    position: employee.position ?? "",
    department: employee.department ?? "",
    departmentId: employee.departmentId ?? "",
    contractType: employee.contractType ?? "",
    baseSalary: montant("baseSalary") || "0",
    retSS9: employee.retSS9 != null ? String(toNumber(employee.retSS9)) : "",
    retSS35: employee.retSS35 != null ? String(toNumber(employee.retSS35)) : "",
    tfp: employee.tfp != null ? String(toNumber(employee.tfp)) : "",
    retIrg: employee.retIrg != null ? String(toNumber(employee.retIrg)) : "",
    expenseRefund: employee.expenseRefund != null ? String(toNumber(employee.expenseRefund)) : "",
    netToPay: montant("netToPay"),
    grossSalary: montant("grossSalary"),
    employerCost: montant("employerCost"),
    leaveBalanceDays: String(toNumber(employee.leaveBalanceDays)),
    hireDate: d10(employee.hireDate),
    contractStart: d10(employee.contractStart),
    contractEnd: d10(employee.contractEnd),
    trialStart: d10(employee.trialStart),
    trialEnd: d10(employee.trialEnd),
    trialRenewable: employee.trialRenewable,
    trialRenewed: employee.trialRenewed,
    trialRenewalStart: d10(employee.trialRenewalStart),
    trialRenewalEnd: d10(employee.trialRenewalEnd),
    birthDate: d10(employee.birthDate),
    email: employee.email ?? "",
    phone: employee.phone ?? "",
    iban: texte("iban"),
    nationalId: texte("nationalId"),
    cnasNumber: employee.cnasNumber ?? "",
    address: employee.address ?? "",
    companyId: employee.companyId ?? "",
    managerId: employee.managerId ?? "",
    userId: employee.userId ?? "",
    isActive: employee.isActive,
    masques,
  };

  // Accès aux entités : l'ensemble des sociétés, croisé avec ce qui est réellement accordé.
  const [allCompanies, targetUser] = employee.userId
    ? await Promise.all([
        getMyCompanies(user.id),
        prisma.user.findUnique({
          where: { id: employee.userId },
          select: { role: true, secondaryRole: true, companyAccess: { select: { companyId: true, canEdit: true } } },
        }),
      ])
    : [[], null];
  const targetSeesGroup = targetUser ? seesWholeGroup({ role: String(targetUser.role), secondaryRole: targetUser.secondaryRole ? String(targetUser.secondaryRole) : null }) : false;
  const grantByCompany = new Map((targetUser?.companyAccess ?? []).map((g) => [g.companyId, g.canEdit]));
  const accessRows: CompanyAccessRow[] = allCompanies.map((c) => ({
    companyId: c.id,
    name: c.name,
    mode: grantByCompany.has(c.id) ? (grantByCompany.get(c.id) ? "edit" : "view") : "none",
    isHome: employee.companyId === c.id,
  }));

  return (
    <div className="space-y-5">
      <BackLink href="/rh">
        <ArrowLeft className="h-4 w-4" /> Retour aux RH
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{employee.fullName}</h1>
          <p className="text-muted-foreground">
            {employee.position || "Poste non défini"}{employee.department ? ` · ${employee.department}` : ""}
          </p>
          {/* La fiche Personne 360° (refonte des données) : ses autres rôles, derrière leurs propres portes. */}
          {employee.personneId && <Link href={`/personnes/${employee.personneId}`} className="text-sm text-primary underline">Fiche Personne</Link>}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          {employee.isActive ? <Badge tone="success" dot={false}>Actif</Badge> : <Badge tone="danger" dot={false}>Inactif</Badge>}
          <SuperAdminDeleteButton
            kind="EMPLOYEE"
            id={employee.id}
            name={employee.fullName}
            enabled={user.role === "SUPER_ADMIN"}
            label="Supprimer la fiche employé"
            warning="⚠ Ceci supprime l'employé ET tout son dossier RH (demandes, congés, paie, documents). Pour supprimer une seule demande RH, utilisez la corbeille sur la demande concernée."
          />
        </div>
      </div>

      {/* Accès aux entités du groupe : l'appartenance (sa fiche) et le droit d'accès (ce
          qu'elle voit) sont deux choses distinctes. */}
      {/* Un droit RH qui ne tient qu'à un INTÉRIM n'ouvre pas d'entité à un tiers (§118.196) : la carte ne
          s'offre pas à qui l'action refuserait — la même règle que `canManage` de l'action. */}
      {canUpdate && (hasGlobalView(user) || !estPrete(user, "RH", "UPDATE")) && employee.userId && (
        <CompanyAccessCard userId={employee.userId} rows={accessRows} seesWholeGroup={targetSeesGroup} />
      )}

      {/* Rattachement dans la structure + responsable hiérarchique EFFECTIF (N+1 résolu). */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Building2 className="h-4 w-4" /> Rattachement &amp; hiérarchie</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Département</p>
            {departmentPath.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1 font-medium">
                {departmentPath.map((p, i) => (
                  <span key={p.id} className="inline-flex items-center gap-1">
                    {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                    {p.name}
                  </span>
                ))}
              </p>
            ) : (
              <p className="font-medium text-warning">Non affecté — <Link href="/rh/departements" className="text-primary hover:underline">rattacher</Link></p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Responsable hiérarchique (N+1)</p>
            {manager ? (
              <p className="font-medium [overflow-wrap:anywhere]">
                {manager.fullName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {manager.source === "MANAGER" ? "manager désigné (organigramme)"
                    : manager.source === "DEPARTMENT_HEAD" ? "responsable du département"
                      : manager.source === "DEPARTMENT_DEPUTY" ? "adjoint du département"
                        : "responsable du département parent"}
                </span>
              </p>
            ) : (
              <p className="font-medium text-muted-foreground">Aucun — sommet de la hiérarchie ou département sans responsable.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>{canUpdate ? "Dossier employé" : "Informations"}</CardTitle></CardHeader>
            <CardContent>
              {canUpdate ? (
                <EmployeeForm employee={formValues} managerOptions={managerOptions} departmentOptions={departmentOptions.map((o) => ({ value: o.id, label: o.label }))} userOptions={userOptions} companyOptions={companyOptions(companies)} aiConfigured={aiConfigured()} cleIa={cleModeleRequise()} />
              ) : (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <Info label="Poste" value={employee.position} />
                  <Info label="Département" value={employee.department} />
                  <Info label="Contrat" value={employee.contractType ? CONTRACT_TYPE[employee.contractType] : null} />
                  <Info
                    label="Période d'essai"
                    value={employee.trialStart || employee.trialEnd
                      ? `${employee.trialStart ? formatDate(employee.trialStart) : "?"} → ${employee.trialEnd ? formatDate(employee.trialEnd) : "?"}${employee.trialRenewable ? " · renouvelable" : ""}`
                      : null}
                  />
                  {employee.trialRenewed && (
                    <Info
                      label="2ᵉ période d'essai"
                      value={`${employee.trialRenewalStart ? formatDate(employee.trialRenewalStart) : "?"} → ${employee.trialRenewalEnd ? formatDate(employee.trialRenewalEnd) : "?"}`}
                    />
                  )}
                  {salairesVisibles && <Info label="Salaire de base" value={sensibles.baseSalary?.lu ? formatCurrency(Number(sensibles.baseSalary.valeur ?? 0)) : sensibles.baseSalary?.masque} />}
                  <Info label="Solde congés" value={`${toNumber(employee.leaveBalanceDays)} j`} />
                  <Info label="Embauche" value={employee.hireDate ? formatDate(employee.hireDate) : null} />
                  <Info label="Fin de contrat" value={employee.contractEnd ? formatDate(employee.contractEnd) : null} />
                  <Info label="Email" value={employee.email} />
                  <Info label="Téléphone" value={employee.phone} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Champs personnalisés</CardTitle></CardHeader>
            <CardContent>
              <CustomFieldsCard
                entityType="EMPLOYEE"
                entityId={employee.id}
                defs={fieldDefs.map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }))}
                values={(employee.custom as Record<string, unknown>) ?? {}}
                canEdit={canUpdate}
              />
            </CardContent>
          </Card>

          {canUpdate && (
            <Card>
              <CardHeader><CardTitle>Documents & demandes RH</CardTitle></CardHeader>
              <CardContent>
                <HrDossier employeeId={employee.id} employeeName={employee.fullName} employeePosition={employee.position} referenceOrdreMission={await referenceOrdreMissionSuggeree()} documents={hrDossier.documents} requests={hrDossier.requests} currentUserId={user.id} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Historique des congés</CardTitle></CardHeader>
            <CardContent className="p-0">
              {employee.leaveRequests.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Aucune demande de congé.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead><TableHead>Période</TableHead>
                      <TableHead className="text-right">Jours</TableHead><TableHead>Statut</TableHead>
                      {user.role === "SUPER_ADMIN" && <TableHead className="text-right"></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employee.leaveRequests.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{LEAVE_TYPE[l.type] ?? l.type}</TableCell>
                        <TableCell>{formatDate(l.startDate)} → {formatDate(l.endDate)}</TableCell>
                        <TableCell className="text-right">{toNumber(l.days)}</TableCell>
                        <TableCell><StatusBadge map={LEAVE_STATUS} value={l.status} /></TableCell>
                        {/* Supprimer un congé approuvé (saisi en double, posé par erreur) restitue
                            les jours au solde — registre de suppression, corbeille restaurable. */}
                        {user.role === "SUPER_ADMIN" && (
                          <TableCell className="text-right">
                            <SuperAdminDeleteButton
                              compact
                              stay
                              kind="LEAVE_REQUEST"
                              id={l.id}
                              name={`${employee.fullName} — ${formatDate(l.startDate)} → ${formatDate(l.endDate)} (${toNumber(l.days)} j)`}
                              enabled
                              warning={l.status === "APPROVED" && l.type === "ANNUAL" ? "Congé annuel approuvé : les jours seront restitués au solde de l'employé." : undefined}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Compte & traçabilité</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Info label="Compte applicatif" value={employee.user ? `${employee.user.name} (${employee.user.email})` : "Non lié"} />
              <Info label="Manager (N+1)" value={employee.manager?.fullName} />
              {salairesVisibles && <Info label="NIN" value={sensibles.nationalId?.lu ? sensibles.nationalId.valeur : sensibles.nationalId?.masque} />}
              {salairesVisibles && <Info label="N° CNAS" value={employee.cnasNumber} />}
              <Info label="Créé le" value={formatDateTime(employee.createdAt)} />
              <Info label="Modifié le" value={formatDateTime(employee.updatedAt)} />
            </CardContent>
          </Card>

          {salairesVisibles && <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Derniers bulletins</CardTitle>
              <Link href="/rh/paie" className="text-xs text-primary hover:underline">Voir la paie</Link>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {employee.payrolls.length === 0 ? (
                <p className="text-muted-foreground">Aucun bulletin.</p>
              ) : (
                employee.payrolls.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-muted-foreground">{String(p.month).padStart(2, "0")}/{p.year}</span>
                    <span className="font-medium">{formatCurrency(toNumber(p.net))}</span>
                    <StatusBadge map={PAYROLL_STATUS} value={p.status} dot={false} />
                  </div>
                ))
              )}
            </CardContent>
          </Card>}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium [overflow-wrap:anywhere]">{value || "—"}</p>
    </div>
  );
}
