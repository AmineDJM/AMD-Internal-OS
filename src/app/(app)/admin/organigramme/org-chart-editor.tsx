"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Pencil, ExternalLink, Users, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { saveOrgNode } from "@/lib/actions/org-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface OrgNode {
  id: string;
  fullName: string;
  position: string | null;
  department: string | null;
  managerId: string | null;
  entity: string | null;
  color: string | null;
  orgX: number | null;
  orgY: number | null;
}

/**
 * Organigramme en arbre (RH). Rattachement (N+1) + poste modifiables par le Super Admin ;
 * `canEdit=false` rend la même hiérarchie en CONSULTATION (crayon masqué) pour les rôles et
 * personnes que l'admin a autorisés.
 */
export function OrgChartEditor({ nodes, canEdit = true }: { nodes: OrgNode[]; canEdit?: boolean }) {
  const { rafraichir } = useRafraichir();
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const childrenOf = React.useMemo(() => {
    const m = new Map<string | null, OrgNode[]>();
    for (const n of nodes) {
      const key = n.managerId && byId.has(n.managerId) ? n.managerId : null;
      const arr = m.get(key) ?? [];
      arr.push(n);
      m.set(key, arr);
    }
    return m;
  }, [nodes, byId]);

  // Descendants d'un nœud (pour interdire un rattachement qui créerait une boucle).
  const descendantsOf = React.useCallback((rootId: string) => {
    const out = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
      }
    }
    return out;
  }, [childrenOf]);

  const roots = childrenOf.get(null) ?? [];

  return (
    <div className="space-y-3">
      {nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun employé actif. Créez des employés dans Ressources humaines, puis organisez-les ici.</p>
      ) : (
        <div className="space-y-1.5">
          {roots.map((n) => (
            <OrgBranch key={n.id} node={n} depth={0} childrenOf={childrenOf} nodes={nodes} descendantsOf={descendantsOf} canEdit={canEdit} onSaved={rafraichir} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgBranch({
  node, depth, childrenOf, nodes, descendantsOf, canEdit, onSaved,
}: {
  node: OrgNode;
  depth: number;
  childrenOf: Map<string | null, OrgNode[]>;
  nodes: OrgNode[];
  descendantsOf: (id: string) => Set<string>;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const kids = childrenOf.get(node.id) ?? [];
  const [open, setOpen] = React.useState(depth < 2);
  const [editing, setEditing] = React.useState(false);
  const [managerId, setManagerId] = React.useState(node.managerId ?? "");
  const [position, setPosition] = React.useState(node.position ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const forbidden = React.useMemo(() => {
    const d = descendantsOf(node.id);
    d.add(node.id);
    return d;
  }, [descendantsOf, node.id]);
  const managerOptions = nodes.filter((n) => !forbidden.has(n.id));

  async function save() {
    setSaving(true); setError(null);
    const fd = new FormData();
    fd.set("id", node.id);
    if (managerId) fd.set("managerId", managerId);
    fd.set("position", position);
    try {
      const r = await saveOrgNode(fd);
      if (r.ok) { setEditing(false); onSaved(); }
      else setError(r.error ?? "Le rattachement n'a pas été enregistré.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={depth === 0 ? "" : "ml-2 border-l border-border pl-2 sm:ml-4 sm:pl-3"}>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2">
        {kids.length > 0 ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Replier" : "Déplier"} className="-m-1.5 mt-[-0.25rem] rounded p-1.5 text-muted-foreground hover:text-foreground">
            <ChevronRight className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : <span className="w-4" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link href={`/rh/${node.id}`} className="font-medium hover:underline">{node.fullName}</Link>
            <Link href={`/rh/${node.id}`} className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></Link>
            {node.entity && (
              <span className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={node.color ? { backgroundColor: `${node.color}22`, color: node.color } : undefined}>{node.entity}</span>
            )}
            {kids.length > 0 && <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"><Users className="h-3 w-3" /> {kids.length}</span>}
          </div>
          <p className="line-clamp-2 break-words text-xs text-muted-foreground sm:truncate">{node.position || "Poste non défini"}{node.department ? ` · ${node.department}` : ""}</p>

          {editing && (
            <div className="mt-2 space-y-2 rounded-lg bg-secondary/40 p-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Rattaché à (N+1)</Label>
                  <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} className="h-10 text-xs sm:h-8">
                    <option value="">— Racine (aucun N+1) —</option>
                    {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.fullName}{m.position ? ` — ${m.position}` : ""}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Poste</Label>
                  <Input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Intitulé du poste" className="h-10 text-xs sm:h-8" />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Enregistrer
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); setManagerId(node.managerId ?? ""); setPosition(node.position ?? ""); setError(null); }}>
                  <X className="h-3.5 w-3.5" /> Annuler
                </Button>
              </div>
            </div>
          )}
        </div>
        {canEdit && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="-m-1.5 rounded p-2 text-muted-foreground hover:text-foreground sm:m-0 sm:mt-0.5 sm:p-0" title="Éditer le rattachement / le poste" aria-label="Éditer le rattachement / le poste">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && kids.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {kids.map((k) => (
            <OrgBranch key={k.id} node={k} depth={depth + 1} childrenOf={childrenOf} nodes={nodes} descendantsOf={descendantsOf} canEdit={canEdit} onSaved={onSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
