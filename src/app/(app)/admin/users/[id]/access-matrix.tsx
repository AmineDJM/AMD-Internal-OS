"use client";

import * as React from "react";
import { Loader2, Check } from "lucide-react";
import { saveAccessMatrix } from "@/lib/actions/access-actions";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { ACTION_LABELS } from "@/lib/labels";
import { AnnuairesCoches } from "@/components/admin/annuaires-coches";
import { sansBloquer } from "@/lib/journal";

/**
 * Les colonnes sont les MÊMES pour toutes les lignes (c'est un tableau), mais les cases d'une
 * ligne ne s'affichent que si SON module autorise l'action. Une case cochable sur un module qui
 * n'a pas cette capacité s'enregistrerait sans rien ouvrir — et ferait croire à un droit donné.
 */
const ACTION_COLS = ["CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD"] as const;

export interface ModuleAccessRow {
  module: string;
  label: string;
  mode: "DEFAULT" | "CUSTOM" | "BLOCKED";
  actions: Record<string, boolean>;
  scope: "ALL" | "ASSIGNED";
  /** Capacités réellement offertes par ce module (déduites des droits des rôles). */
  available: string[];
  rowScoped: boolean;
  roleSummary: string; // human description of the role default
  /** Module retiré du service : les droits s'enregistrent mais n'ouvrent rien (sauf Super Admin). */
  hidden?: boolean;
  /**
   * Les ANNUAIRES qu'ouvre un accès personnalisé au module Annuaires (§118.147). Vide ailleurs :
   * seul ce module a des sections.
   */
  sections?: string[];
}

/** Le module dont un accès personnalisé se découpe PAR ANNUAIRE. */
const MODULE_ANNUAIRES = "DIRECTORIES";

export function AccessMatrix({ userId, rows }: { userId: string; rows: ModuleAccessRow[] }) {
  const [state, setState] = React.useState(rows);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // LE REFUS SE DIT (§118.153). Le résultat de l'action était ignoré : un refus (« Réservé au
  // Super Admin », « Utilisateur manquant ») affichait quand même « Enregistré » avec la coche
  // verte — le faux succès exact, sur l'écran qui décide de ce qu'une personne peut faire.
  const [erreur, setErreur] = React.useState<string | null>(null);

  function update(module: string, patch: Partial<ModuleAccessRow>) {
    setState((s) => s.map((r) => (r.module === module ? { ...r, ...patch } : r)));
  }

  return (
    <form
      action={async (fd) => {
        setSaving(true);
        setErreur(null);
        const r = await saveAccessMatrix(fd).catch(sansBloquer("access-matrix.AccessMatrix.saveAccessMatrix", { ok: false as const, error: "Enregistrement impossible — réessayez." }));
        setSaving(false);
        if (!r.ok) { setErreur(r.error ?? "Enregistrement refusé."); return; }
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
      className="space-y-3"
    >
      <input type="hidden" name="userId" value={userId} />
      <div className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Onglet / Module</TableHead>
              <TableHead>Accès</TableHead>
              {ACTION_COLS.map((a) => (
                <TableHead key={a} className="text-center">{ACTION_LABELS[a]}</TableHead>
              ))}
              <TableHead>Portée des lignes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.map((r) => {
              const custom = r.mode === "CUSTOM";
              return (
                <React.Fragment key={r.module}>
                <TableRow>
                  <TableCell className="sticky left-0 z-10 min-w-[8.5rem] max-w-[11rem] bg-card sm:max-w-none">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{r.label}</span>
                      {/* Hors service : le droit s'enregistre, mais n'ouvre rien tant que le
                          module n'est pas remis en service (Réglages › Modules en service). */}
                      {r.hidden && (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning" title="Module retiré du service : les droits réglés ici n'ouvriront rien tant qu'il n'est pas remis en service (Administration › Réglages › Modules en service).">
                          hors service
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">Défaut&nbsp;: {r.roleSummary}</div>
                    <input type="hidden" name={`mode_${r.module}`} value={r.mode} />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={r.mode}
                      onChange={(e) => update(r.module, { mode: e.target.value as ModuleAccessRow["mode"] })}
                      className="h-10 w-32 text-xs sm:h-8"
                    >
                      <option value="DEFAULT">Par défaut</option>
                      <option value="CUSTOM">Personnalisé</option>
                      <option value="BLOCKED">Bloqué</option>
                    </Select>
                  </TableCell>
                  {ACTION_COLS.map((a) => (
                    <TableCell key={a} className="text-center">
                      {r.available.includes(a) ? (
                        <input
                          type="checkbox"
                          name={`act_${r.module}_${a}`}
                          checked={custom ? Boolean(r.actions[a]) : false}
                          disabled={!custom}
                          onChange={(e) => update(r.module, { actions: { ...r.actions, [a]: e.target.checked } })}
                          className="h-5 w-5 rounded border-input disabled:opacity-30 sm:h-4 sm:w-4"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground" title="Ce module n'offre pas cette capacité.">—</span>
                      )}
                    </TableCell>
                  ))}
                  <TableCell>
                    {r.module === "DRIVE" || r.module === "DOSSIERS" ? (
                      // Drive & Sujets : privés par conception — toujours cloisonnés
                      // (chacun ne voit que SES éléments + ceux partagés). La portée
                      // « tout » est réservée à la vue globale (Direction / Super Admin)
                      // et neutralisée ici pour un compte ordinaire (cf. getAccess).
                      <>
                        <span className="text-xs text-muted-foreground" title="Confidentialité stricte : l'utilisateur ne voit que ses propres fichiers / sujets et ceux qu'on lui a partagés ou confiés.">Privé (assignées)</span>
                        <input type="hidden" name={`scope_${r.module}`} value="ASSIGNED" />
                      </>
                    ) : r.rowScoped ? (
                      <Select
                        name={`scope_${r.module}`}
                        value={r.scope}
                        disabled={!custom}
                        onChange={(e) => update(r.module, { scope: e.target.value as "ALL" | "ASSIGNED" })}
                        className="h-10 w-40 text-xs sm:h-8"
                      >
                        <option value="ALL">Toutes les lignes</option>
                        <option value="ASSIGNED">Lignes assignées</option>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
                {r.module === MODULE_ANNUAIRES && (
                  <TableRow>
                    <TableCell colSpan={ACTION_COLS.length + 3} className="bg-secondary/20">
                      <AnnuairesCoches
                        prefixe={`sect_${r.module}`}
                        sections={r.sections ?? []}
                        actif={custom}
                        onChange={(sections) => update(r.module, { sections })}
                      />
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-6 text-muted-foreground">
          <Badge tone="neutral" dot={false}>Par défaut</Badge> applique les droits du rôle ·
          <Badge tone="info" dot={false}>Personnalisé</Badge> droits choisis ·
          <Badge tone="danger" dot={false}>Bloqué</Badge> onglet masqué.
        </p>
        {erreur && <p role="alert" className="text-sm text-destructive">{erreur}</p>}
        <Button type="submit" disabled={saving} className="w-full shrink-0 sm:w-auto">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer les accès"}
        </Button>
      </div>
    </form>
  );
}

