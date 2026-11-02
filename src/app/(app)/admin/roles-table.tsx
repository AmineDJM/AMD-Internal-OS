"use client";

import * as React from "react";
import { Loader2, Check } from "lucide-react";
import { setSecondaryRole } from "@/lib/actions/admin-actions";
import { Select } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ROLE_LABELS } from "@/lib/labels";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export type RoleRowData = { id: string; name: string; email: string; role: string; secondaryRole: string | null };

// Rôles proposables comme « autre rôle » (Super Admin exclu : réservé, anti-escalade).
const SECONDARY_OPTIONS = Object.entries(ROLE_LABELS).filter(([v]) => v !== "SUPER_ADMIN");

/**
 * Tableau clair « Rôle principal + Autre rôle » par utilisateur, réglable en ligne
 * par le Super Admin. Le rôle secondaire CUMULE ses capacités (cf. rbac.getAccess).
 */
export function RolesTable({ users, canManage }: { users: RoleRowData[]; canManage: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Utilisateur</TableHead>
          <TableHead>Rôle principal</TableHead>
          <TableHead>Autre rôle (fonction secondaire)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => <RoleRow key={u.id} u={u} canManage={canManage} />)}
      </TableBody>
    </Table>
  );
}

function RoleRow({ u, canManage }: { u: RoleRowData; canManage: boolean }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [value, setValue] = React.useState(u.secondaryRole ?? "");

  const change = async (next: string) => {
    setValue(next);
    setBusy(true); setErr(null); setSaved(false);
    const fd = new FormData();
    fd.set("id", u.id);
    fd.set("secondaryRole", next);
    try {
      const r = await setSecondaryRole(fd);
      if (r.ok) { setSaved(true); rafraichir(); setTimeout(() => setSaved(false), 1500); }
      else { setErr(r.error ?? "Le rôle secondaire n'a pas été changé."); setValue(u.secondaryRole ?? ""); }
    } catch {
      setErr(actionFailureMessage("THROWN")); setValue(u.secondaryRole ?? "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell data-sans-etiquette className="">
        <div className="min-w-0 text-left">
          <p className="font-medium">{u.name}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.email}</p>
        </div>
      </TableCell>
      <TableCell>
        <span className="inline-flex rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium">{ROLE_LABELS[u.role] ?? u.role}</span>
      </TableCell>
      <TableCell label="Autre rôle">
        {canManage ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:justify-start">
            <Select value={value} onChange={(e) => void change(e.target.value)} disabled={busy} className="h-10 w-full max-w-[16rem] text-xs sm:h-8 sm:w-64">
              <option value="">— Aucun —</option>
              {SECONDARY_OPTIONS.map(([v, l]) => <option key={v} value={v} disabled={v === u.role}>{l}</option>)}
            </Select>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {saved && <Check className="h-4 w-4 text-success" />}
            {err && <span className="text-xs text-destructive">{err}</span>}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{u.secondaryRole ? (ROLE_LABELS[u.secondaryRole] ?? u.secondaryRole) : "—"}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
