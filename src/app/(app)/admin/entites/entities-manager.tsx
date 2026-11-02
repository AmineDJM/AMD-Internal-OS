"use client";

import * as React from "react";
import { Loader2, Plus, Pencil, Power, Building2 } from "lucide-react";
import { createCompany, updateCompany, toggleCompany } from "@/lib/actions/company-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export interface EntityRow {
  id: string;
  name: string;
  shortName: string | null;
  color: string | null;
  isActive: boolean;
  products: number;
  employees: number;
  departments: number;
}

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#475569"];

export function EntitiesManager({ rows }: { rows: EntityRow[] }) {
  const [editing, setEditing] = React.useState<EntityRow | "new" | null>(null);
  const { busy, err, setErr, run } = useAction();
  // La bascule vit dans une ligne du tableau, sans place où parler : un refus part en avis flottant.
  const bascule = useAction({ signalerErreurs: true });
  const [color, setColor] = React.useState<string>(PALETTE[0]);

  function openNew() {
    setErr(null);
    setColor(PALETTE[rows.length % PALETTE.length]);
    setEditing("new");
  }
  function openEdit(row: EntityRow) {
    setErr(null);
    setColor(row.color || PALETTE[0]);
    setEditing(row);
  }

  async function toggle(row: EntityRow) {
    const verb = row.isActive ? "désactiver" : "réactiver";
    const fd = new FormData();
    fd.set("id", row.id);
    await bascule.run(async () => {
      const r = await toggleCompany(fd);
      return r.ok ? r : { ok: false, error: r.error ?? `L'entité n'a pas pu être ${row.isActive ? "désactivée" : "réactivée"}.` };
    }, undefined, {
      confirmer: `Voulez-vous ${verb} l'entité « ${row.name} » ? (une entité inactive disparaît du sélecteur)`,
    });
  }

  const row = editing && editing !== "new" ? editing : null;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew} className="w-full sm:w-auto"><Plus className="h-4 w-4" /> Nouvelle entité</Button>
      </div>

      <div className="surface overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Entité</TableHead>
              <TableHead>Libellé court</TableHead>
              <TableHead className="text-right">Produits</TableHead>
              <TableHead className="text-right">Employés</TableHead>
              <TableHead className="text-right">Départements</TableHead>
              <TableHead className="text-center">Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} className={r.isActive ? "" : "opacity-60"}>
                <TableCell data-sans-etiquette className="py-2">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color || "#64748b" }} />
                    {r.name}
                  </span>
                </TableCell>
                <TableCell className="py-2 text-muted-foreground">{r.shortName || "—"}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{r.products}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{r.employees}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{r.departments}</TableCell>
                <TableCell className="py-2 text-center">
                  {r.isActive ? (
                    <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Active</span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Inactive</span>
                  )}
                </TableCell>
                <TableCell data-sans-etiquette className="py-2">
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => openEdit(r)} className="rounded-lg p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5" title="Modifier" aria-label={`Modifier ${r.name}`}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => toggle(r)} className="rounded-lg p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5" title={r.isActive ? "Désactiver" : "Réactiver"} aria-label={`${r.isActive ? "Désactiver" : "Réactiver"} ${r.name}`}>
                      <Power className="h-4 w-4" />
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} data-sans-etiquette className="py-6 text-center text-muted-foreground">Aucune entité. Créez-en une pour commencer.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet
        open={editing !== null}
        onClose={() => !busy && setEditing(null)}
        title={row ? `Modifier — ${row.name}` : "Nouvelle entité"}
        description="Le libellé court sert aux pastilles ; la couleur les distingue d'un coup d'œil."
        width="md"
      >
        {editing && (
          <form
            action={async (fd) => {
              fd.set("color", color);
              if (row) fd.set("id", row.id);
              await run(async () => {
                const res = row ? await updateCompany(fd) : await createCompany(undefined, fd);
                return res.ok ? res : { ok: false, error: res.error ?? "L'entité n'a pas été enregistrée." };
              }, () => setEditing(null));
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="c-name">Nom de l&apos;entité <span className="text-destructive">*</span></Label>
              <Input id="c-name" name="name" required defaultValue={row?.name} placeholder="Ex. Adventum Pharma" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-short">Libellé court</Label>
              <Input id="c-short" name="shortName" defaultValue={row?.shortName ?? ""} placeholder="Ex. Adventum" />
            </div>
            <div className="space-y-1.5">
              <Label>Couleur</Label>
              <div className="flex flex-wrap items-center gap-2">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`h-7 w-7 rounded-full ring-offset-2 ${color === c ? "ring-2 ring-foreground" : ""}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Couleur ${c}`}
                  />
                ))}
                <Input value={color} onChange={(e) => setColor(e.target.value)} className="ml-2 w-28" />
              </div>
            </div>
            {row && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> {row.products} produit·s · {row.employees} employé·s · {row.departments} département·s rattaché·s.
              </p>
            )}
            <Retour ton="erreur">{err}</Retour>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={busy}>Annuler</Button>
              <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</Button>
            </div>
          </form>
        )}
      </Sheet>
    </div>
  );
}
