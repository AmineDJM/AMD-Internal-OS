import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getValidationAdminData } from "@/lib/queries/validations";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_LABELS, PRIORITY, VALIDATION_STATUS, VALIDATION_MODE } from "@/lib/labels";
import { optionsFromMap } from "@/components/shared/form-fields";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { RuleEditor, RuleControls, type RuleDTO } from "./rules-admin";
import { BackLink } from "@/components/shared/back-link";

const dec = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export default async function AdminValidationsPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const [{ rules, requests }, users] = await Promise.all([
    getValidationAdminData(),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.name]));
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const roleOptions = optionsFromMap(ROLE_LABELS);
  const priorityOptions = optionsFromMap(PRIORITY);
  const moduleOptions = [
    "Demandes administratives", "Finances", "Espace comptable", "Sponsoring", "Ressources humaines",
    "Business Development", "Regulatory", "Logistique PCH", "Budgets",
  ].map((m) => ({ value: m, label: m }));

  const toDTO = (r: (typeof rules)[number]): RuleDTO => ({
    id: r.id, name: r.name, module: r.module ?? "", objectType: r.objectType ?? "", description: r.description ?? "",
    minAmount: dec(r.minAmount), maxAmount: dec(r.maxAmount), department: r.department ?? "",
    requesterRole: r.requesterRole ?? "", priority: r.priority ?? "", category: r.category ?? "",
    validator1Id: r.validator1Id ?? "", validator2Id: r.validator2Id ?? "", mode: r.mode, active: r.active,
  });

  const conditions = (r: (typeof rules)[number]): string => {
    const parts: string[] = [];
    if (r.objectType) parts.push(r.objectType);
    if (r.minAmount !== null && r.maxAmount !== null) parts.push(`${formatCurrency(Number(r.minAmount))}–${formatCurrency(Number(r.maxAmount))}`);
    else if (r.minAmount !== null) parts.push(`≥ ${formatCurrency(Number(r.minAmount))}`);
    else if (r.maxAmount !== null) parts.push(`≤ ${formatCurrency(Number(r.maxAmount))}`);
    if (r.requesterRole) parts.push(ROLE_LABELS[r.requesterRole] ?? r.requesterRole);
    if (r.priority) parts.push(PRIORITY[r.priority]?.label ?? r.priority);
    if (r.department) parts.push(r.department);
    if (r.category) parts.push(r.category);
    return parts.join(" · ") || "Toujours";
  };

  const validators = (r: (typeof rules)[number]): string =>
    [r.validator1Id, r.validator2Id].filter(Boolean).map((id) => userMap.get(id as string) ?? "?").join(r.mode === "PARALLEL" ? " + " : " → ");

  const activeRules = rules.filter((r) => r.active).length;
  const pendingReqs = requests.filter((r) => r.status === "PENDING").length;

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader title="Paramétrage des validations" description="Définissez qui valide quoi : module, type, montant, département, rôle, priorité… en séquentiel ou parallèle.">
        <RuleEditor users={userOptions} moduleOptions={moduleOptions} roleOptions={roleOptions} priorityOptions={priorityOptions} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Règles" value={rules.length} icon="ShieldCheck" />
        <KpiCard label="Règles actives" value={activeRules} icon="Power" tone="success" />
        <KpiCard label="Demandes en cours" value={pendingReqs} icon="Hourglass" tone={pendingReqs > 0 ? "warning" : "default"} />
        <KpiCard label="Total demandes" value={requests.length} icon="ListChecks" />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Règles de validation</h2>
        {rules.length === 0 ? (
          <EmptyState icon="ShieldCheck" title="Aucune règle définie" description="Créez une règle pour router automatiquement les demandes vers les bons validateurs." />
        ) : (
          <div className="surface overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Règle</TableHead><TableHead>Module</TableHead><TableHead>Conditions</TableHead>
                  <TableHead>Validateurs</TableHead><TableHead>Mode</TableHead><TableHead>Statut</TableHead><TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell data-sans-etiquette className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.module || "Tous"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{conditions(r)}</TableCell>
                    <TableCell className="text-sm">{validators(r) || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{VALIDATION_MODE[r.mode]}</TableCell>
                    <TableCell>{r.active ? <Badge tone="success" dot={false}>Active</Badge> : <Badge tone="neutral" dot={false}>Inactive</Badge>}</TableCell>
                    <TableCell data-sans-etiquette>
                      <div className="flex items-center justify-end gap-0.5">
                        <RuleEditor users={userOptions} moduleOptions={moduleOptions} roleOptions={roleOptions} priorityOptions={priorityOptions} rule={toDTO(r)} />
                        <RuleControls id={r.id} active={r.active} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Demandes de validation (supervision)</h2>
        {requests.length === 0 ? (
          <EmptyState icon="ListChecks" title="Aucune demande" description="Les demandes de validation routées par les règles apparaîtront ici." />
        ) : (
          <div className="surface overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Référence</TableHead><TableHead>Objet</TableHead><TableHead>Module</TableHead>
                  <TableHead>Demandeur</TableHead><TableHead>Montant</TableHead><TableHead>Circuit</TableHead><TableHead>Statut</TableHead><TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                    <TableCell data-sans-etiquette className="font-medium">{r.title}</TableCell>
                    <TableCell className="text-muted-foreground">{r.module}</TableCell>
                    <TableCell className="text-muted-foreground">{r.requester?.name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{r.amount === null ? "—" : formatCurrency(Number(r.amount))}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.steps.map((s) => `${s.validator?.name ?? "?"} (${s.status === "APPROVED" ? "✓" : s.status === "REJECTED" ? "✗" : "…"})`).join(r.mode === "PARALLEL" ? " + " : " → ")}</TableCell>
                    <TableCell><StatusBadge map={VALIDATION_STATUS} value={r.status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
