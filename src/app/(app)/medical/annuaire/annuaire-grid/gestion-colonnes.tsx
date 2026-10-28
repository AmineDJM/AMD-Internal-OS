"use client";

/**
 * L'ANNUAIRE — la gestion des colonnes sur mesure (créer, supprimer).
 */
import * as React from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { CustomColumnVue } from "@/lib/medical/directory-grid";
import { createDirectoryColumn, deleteDirectoryColumn } from "@/lib/actions/medical-directory-crud-actions";

/**
 * LES COLONNES PROPRES À L'ANNUAIRE — enfin gérables depuis la feuille.
 *
 * Ajouter (« Dernier congrès », « Numéro d'officine »), typer (texte, nombre, date, choix),
 * retirer. Les actions existaient (`createDirectoryColumn`, `deleteDirectoryColumn`) ; il leur
 * manquait un écran. Retirer une colonne ne détruit pas les valeurs déjà saisies dans les fiches
 * (elles restent dans le JSON de chaque praticien), elle les rend simplement invisibles — la
 * confirmation le dit.
 */
export function GestionColonnes({ directoryId, colonnes, onDone }: { directoryId: string; colonnes: CustomColumnVue[]; onDone: () => void }) {
  const [label, setLabel] = React.useState("");
  const [kind, setKind] = React.useState<CustomColumnVue["kind"]>("TEXT");
  const [options, setOptions] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const ajouter = () => {
    const fd = new FormData();
    fd.set("directoryId", directoryId);
    fd.set("label", label);
    fd.set("kind", kind);
    if (kind === "CHOICE") fd.set("options", options);
    setBusy(true); setErr(null);
    void createDirectoryColumn(fd).then((r) => {
      setBusy(false);
      if (r.ok) { setLabel(""); setOptions(""); setKind("TEXT"); onDone(); }
      else setErr(r.error ?? "Ajout impossible.");
    });
  };

  const retirer = (c: CustomColumnVue) => {
    if (!window.confirm(`Retirer la colonne « ${c.label} » de cet annuaire ? Les valeurs déjà saisies ne seront plus affichées.`)) return;
    const fd = new FormData();
    fd.set("id", c.id);
    setBusy(true); setErr(null);
    void deleteDirectoryColumn(fd).then((r) => {
      setBusy(false);
      if (r.ok) onDone(); else setErr(r.error ?? "Suppression impossible.");
    });
  };

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="gestion-colonnes">
      <p className="text-sm font-medium">Colonnes propres à cet annuaire</p>
      {colonnes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucune pour l&apos;instant. Une colonne ajoutée ici n&apos;existe que dans cet annuaire.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {colonnes.map((c) => (
            <li key={c.id} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border py-1 pl-2 pr-1 text-xs">
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{c.label}</span>
              <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                · {c.kind === "TEXT" ? "texte" : c.kind === "NUMBER" ? "nombre" : c.kind === "DATE" ? "date" : `choix : ${c.options.join(", ")}`}
              </span>
              <button type="button" onClick={() => retirer(c)} disabled={busy} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-6 sm:w-6" aria-label={`Retirer la colonne ${c.label}`}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Input placeholder="Nom de la colonne" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Select value={kind} onChange={(e) => setKind(e.target.value as CustomColumnVue["kind"])}>
          <option value="TEXT">Texte</option>
          <option value="NUMBER">Nombre</option>
          <option value="DATE">Date</option>
          <option value="CHOICE">Choix</option>
        </Select>
        {kind === "CHOICE" && (
          <Input placeholder="Options séparées par |" value={options} onChange={(e) => setOptions(e.target.value)} className="sm:col-span-2" />
        )}
        <Button size="sm" disabled={busy || !label.trim()} onClick={ajouter} className={kind === "CHOICE" ? "sm:col-span-4 sm:w-fit" : ""}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Ajouter la colonne
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
