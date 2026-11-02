"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Loader2, UserPlus, ChevronRight } from "lucide-react";
import { createDepartment, updateDepartment, deleteDepartment, assignEmployeeDepartment } from "@/lib/actions/department-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/shared/page-header";
import type { DepartmentNode, DepartmentOption } from "@/lib/departments";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

type Result = { ok: boolean; error?: string };
type EmpOpt = { id: string; fullName: string; position: string | null };

type SheetState =
  | { mode: "create"; parentId: string | null; parentName: string | null }
  | { mode: "edit"; node: DepartmentNode };

function useRun() {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<Result>, onOk?: () => void) => {
    setBusy(true); setErr(null);
    let r: Result;
    try {
      r = await fn();
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    if (r.ok) { onOk?.(); rafraichir(); } else setErr(r.error ?? "Le geste n'a pas abouti.");
  };
  return { busy, err, setErr, run };
}

type CompanyOpt = { id: string; label: string };

/** L'arbre à plat, dans l'ordre de lecture (chaque département suivi de ses sous-départements). */
function aplatir(nodes: DepartmentNode[]): DepartmentNode[] {
  return nodes.flatMap((n) => [n, ...aplatir(n.children)]);
}

/**
 * LES DÉPARTEMENTS EN UNE TABLE (maquette « Employés », Direction 07/10) — l'en-tête (titre, résumé d'une ligne, geste
 * principal, « ⋯ ») vit ici parce que « Nouveau département » ouvre la fenêtre de ce composant. Une ligne par département,
 * indentée selon sa profondeur ; au téléphone la table reste une table, qui défile dans son cadre.
 */
export function DepartmentsManager({
  resume, onglets, menu, tree, options, employees, unassigned, canManage, companies, companyScope,
}: {
  resume: string;
  onglets: React.ReactNode;
  menu: React.ReactNode;
  tree: DepartmentNode[];
  options: DepartmentOption[];
  employees: EmpOpt[];
  unassigned: EmpOpt[];
  canManage: boolean;
  companies: CompanyOpt[];
  companyScope: string | null;
}) {
  const { run } = useRun();
  const confirmer = useConfirmer();
  const [sheet, setSheet] = React.useState<SheetState | null>(null);
  const lignes = React.useMemo(() => aplatir(tree), [tree]);

  const del = async (node: DepartmentNode) => {
    const msg = node.children.length > 0
      ? `Supprimer « ${node.name} » ? Ses ${node.children.length} sous-département(s) remonteront d'un niveau et ses ${node.members} membre(s) directs repasseront « non affectés ».`
      : `Supprimer « ${node.name} » ? Ses ${node.members} membre(s) repasseront « non affectés ».`;
    if (await confirmer(msg)) { const fd = new FormData(); fd.set("id", node.id); run(() => deleteDepartment(fd)); }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Départements" description={resume}>
        {canManage && (
          <Button onClick={() => setSheet({ mode: "create", parentId: null, parentName: null })}>
            <Plus className="h-4 w-4" /> Nouveau département
          </Button>
        )}
        {menu}
      </PageHeader>
      {onglets}

      {lignes.length === 0 ? (
        <p className="surface p-6 text-center text-sm text-muted-foreground">Aucun département pour l&apos;instant.</p>
      ) : (
        <div className="surface overflow-hidden">
          <Table className={canManage ? "min-w-[40rem]" : "min-w-[32rem]"}>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-[1] bg-card">Département</TableHead>
                <TableHead>Responsable</TableHead>
                <TableHead className="text-right">Personnes</TableHead>
                {canManage && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lignes.map((node) => (
                <DeptRow
                  key={node.id} node={node} canManage={canManage}
                  onAddChild={(n) => setSheet({ mode: "create", parentId: n.id, parentName: n.name })}
                  onEdit={(n) => setSheet({ mode: "edit", node: n })}
                  onDelete={del}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canManage && unassigned.length > 0 && (
        <UnassignedPanel employees={unassigned} options={options} />
      )}

      {sheet && (
        <DeptSheet sheet={sheet} options={options} employees={employees} companies={companies} companyScope={companyScope} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/** Une ligne de la table : le département (indenté selon sa profondeur), son responsable, son effectif, ses gestes. */
function DeptRow({
  node, canManage, onAddChild, onEdit, onDelete,
}: {
  node: DepartmentNode;
  canManage: boolean;
  onAddChild: (n: DepartmentNode) => void;
  onEdit: (n: DepartmentNode) => void;
  onDelete: (n: DepartmentNode) => void;
}) {
  const isRoot = node.depth === 0;
  const icone = "rounded p-2 text-muted-foreground sm:p-1.5";
  return (
    <TableRow>
      <TableCell className="sticky left-0 z-[1] max-w-[18rem] bg-card" style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}>
        <div className="flex min-w-0 items-start gap-1.5" title={node.description ?? undefined}>
          {!isRoot && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <span className={`block [overflow-wrap:anywhere] ${isRoot ? "font-semibold" : "font-medium"}`}>{node.name}</span>
            <span className="block font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">
              {node.code}{isRoot && node.companyName ? ` · ${node.companyName}` : ""}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {node.headName
          ? <span className="block">{node.headName}</span>
          : <Badge tone="warning" dot={false}>Sans responsable</Badge>}
        {node.deputyName && <span className="block text-xs text-muted-foreground">adjoint : {node.deputyName}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {node.members}
        {node.totalMembers !== node.members && <span className="block text-xs text-muted-foreground">{node.totalMembers} avec sous-dép.</span>}
      </TableCell>
      {canManage && (
        <TableCell className="whitespace-nowrap text-right">
          <button type="button" title="Ajouter un sous-département" aria-label={`Ajouter un sous-département à ${node.name}`} onClick={() => onAddChild(node)} className={`${icone} hover:bg-secondary hover:text-foreground`}><Plus className="h-4 w-4" /></button>
          <button type="button" title="Modifier" aria-label={`Modifier ${node.name}`} onClick={() => onEdit(node)} className={`${icone} hover:bg-secondary hover:text-foreground`}><Pencil className="h-4 w-4" /></button>
          <button type="button" title="Supprimer" aria-label={`Supprimer ${node.name}`} onClick={() => onDelete(node)} className={`${icone} hover:bg-destructive/10 hover:text-destructive`}><Trash2 className="h-4 w-4" /></button>
        </TableCell>
      )}
    </TableRow>
  );
}

/** Rattachement express des employés encore « non affectés ». */
function UnassignedPanel({ employees, options }: { employees: EmpOpt[]; options: DepartmentOption[] }) {
  const { busy, err, run } = useRun();
  return (
    <section className="surface space-y-3 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-warning" />
        <h2 className="text-sm font-semibold">Non affectées ({employees.length})</h2>
        <InfoBulle align="left">Rattachez chaque personne à un département : son responsable devient leur N+1 par défaut.</InfoBulle>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="divide-y divide-border">
        {employees.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-sm sm:py-2">
            <Link href={`/rh/${e.id}`} className="min-w-0 font-medium [overflow-wrap:anywhere] hover:underline">{e.fullName}</Link>
            {e.position && <span className="min-w-0 text-xs text-muted-foreground">{e.position}</span>}
            <Select
              defaultValue=""
              disabled={busy}
              className="w-full sm:ml-auto sm:h-8 sm:w-64 sm:text-xs"
              onChange={(ev) => {
                const departmentId = ev.target.value;
                if (!departmentId) return;
                const fd = new FormData();
                fd.set("employeeId", e.id); fd.set("departmentId", departmentId);
                run(() => assignEmployeeDepartment(fd));
              }}
            >
              <option value="">— Rattacher à… —</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeptSheet({
  sheet, options, employees, companies, companyScope, onClose,
}: {
  sheet: SheetState;
  options: DepartmentOption[];
  employees: EmpOpt[];
  companies: CompanyOpt[];
  companyScope: string | null;
  onClose: () => void;
}) {
  const { busy, err, run } = useRun();
  const lock = React.useRef(false);
  const editing = sheet.mode === "edit" ? sheet.node : null;
  // À l'édition, on ne propose pas le département lui-même comme parent (les cycles plus
  // profonds sont refusés côté serveur, qui connaît toute la descendance).
  const parentOptions = options.filter((o) => o.id !== editing?.id);

  return (
    <Sheet
      open onClose={onClose}
      title={editing ? `Modifier « ${editing.name} »` : sheet.mode === "create" && sheet.parentName ? `Nouveau sous-département de « ${sheet.parentName} »` : "Nouveau département"}
      description="Le responsable devient le N+1 par défaut des personnes rattachées. L'adjoint le supplée en cas d'absence."
      width="md"
    >
      <form
        action={(fd) => {
          if (lock.current) return; lock.current = true;
          const done = () => { lock.current = false; };
          if (editing) { fd.set("id", editing.id); run(() => updateDepartment(fd), onClose).finally(done); }
          else {
            if (sheet.mode === "create" && sheet.parentId) fd.set("parentId", sheet.parentId);
            run(() => createDepartment(fd), onClose).finally(done);
          }
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Nom <span className="text-destructive">*</span></Label>
          <Input name="name" required defaultValue={editing?.name ?? ""} placeholder="Ex. Commercial, Ventes Nord…" />
        </div>
        <div className="space-y-1.5">
          <Label>Code (généré si vide)</Label>
          <Input name="code" defaultValue={editing?.code ?? ""} placeholder="COMMERCIAL" />
        </div>
        {(sheet.mode === "edit" ? !editing?.parentId : !sheet.parentId) && companies.length > 0 && (
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center gap-1">
              <Label>Entité</Label>
              <InfoBulle align="left">Chaque société (Adventum, Pharmagène…) a ses propres départements. Un sous-département hérite automatiquement de l&apos;entité de son parent.</InfoBulle>
            </div>
            <Select name="companyId" defaultValue={editing ? editing.companyId ?? "" : companyScope ?? ""}>
              <option value="">— Transverse au groupe —</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Rattaché à</Label>
          <Select name="parentId" defaultValue={editing ? editing.parentId ?? "" : sheet.mode === "create" ? sheet.parentId ?? "" : ""}>
            <option value="">— Département de tête —</option>
            {parentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Responsable (N+1)</Label>
          <Select name="headId" defaultValue={editing?.headId ?? ""}>
            <option value="">— Aucun —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Adjoint (supplée)</Label>
          <Select name="deputyId" defaultValue={editing?.deputyId ?? ""}>
            <option value="">— Aucun —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Description</Label>
          <Textarea name="description" defaultValue={editing?.description ?? ""} rows={2} placeholder="Mission du département…" />
        </div>
        {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onClose}>Annuler</Button>
          <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
        </div>
      </form>
    </Sheet>
  );
}
