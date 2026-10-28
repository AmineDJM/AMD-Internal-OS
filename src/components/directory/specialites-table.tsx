"use client";

import * as React from "react";
import { Check, GitMerge, Link2, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  createSpecialty, updateSpecialty, deleteSpecialty, fusionnerSpecialite, rattacherLibelleSpecialite,
} from "@/lib/actions/medical-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import type { LibelleHerite, SpecialiteRow } from "@/lib/annuaires/types";

/**
 * LE RÉFÉRENTIEL DES SPÉCIALITÉS — l'écran qui le tient (§118.180).
 *
 * Deux blocs. Le référentiel : ajouter, renommer, fusionner deux doublons, retirer — chaque ligne
 * avec le nombre de praticiens qui s'y rattachent. Puis les LIBELLÉS HÉRITÉS : une spécialité
 * écrite en texte sur des fiches, sans lien ; chacun se rattache d'un geste à la spécialité qu'il
 * désigne (proposée quand l'écriture la désigne à coup sûr, choisie par la personne sinon —
 * « Cardio » ne se devine pas, il se décide).
 *
 * Les gestes attendent que les nouvelles données soient là (`useRafraichir`, §118.172) : une ligne
 * renommée ne se renomme pas une seconde fois sur l'état d'avant. Qui n'a pas le droit voit la
 * liste, sans bouton (§118.83).
 */
export function SpecialitesTable({
  specialites, heritees, heriteesTotal, canCreate, canEdit, canDelete,
}: {
  specialites: SpecialiteRow[];
  heritees: LibelleHerite[];
  heriteesTotal: number;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [enAction, setEnAction] = React.useState(false);
  const busy = enAction || rafraichit;
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [nouveau, setNouveau] = React.useState("");
  const [renomme, setRenomme] = React.useState<{ id: string; name: string } | null>(null);
  const [fusion, setFusion] = React.useState<{ id: string; cibleId: string } | null>(null);
  const [cibles, setCibles] = React.useState<Record<string, string>>({});

  const executer = async (action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, champs: Record<string, string>) => {
    setEnAction(true); setMsg(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    try {
      const r = await action(fd);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "La spécialité n'a pas été modifiée.") });
      if (r.ok) rafraichir();
      return r.ok;
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      return false;
    } finally {
      setEnAction(false);
    }
  };

  const autres = (id: string) => specialites.filter((s) => s.id !== id);

  return (
    <div className="space-y-6">
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "rounded-lg bg-success/10 px-3 py-2 text-sm text-success" : "rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"}>
          {msg.text}
        </p>
      )}

      <section aria-labelledby="referentiel-titre" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="referentiel-titre" className="text-base font-semibold">Référentiel</h2>
            <p className="text-sm text-muted-foreground">{specialites.length} spécialité(s). Le nombre de praticiens se compte dans ce que vous voyez de l&apos;annuaire.</p>
          </div>
          {canCreate && (
            <form
              className="flex w-full flex-wrap items-end gap-2 sm:w-auto"
              onSubmit={async (e) => { e.preventDefault(); if (nouveau.trim() && await executer(createSpecialty, { name: nouveau })) setNouveau(""); }}
            >
              <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                <Label htmlFor="specialite-nouvelle">Nouvelle spécialité</Label>
                <Input id="specialite-nouvelle" value={nouveau} onChange={(e) => setNouveau(e.target.value)} placeholder="Ex. Néphrologie" />
              </div>
              <Button type="submit" disabled={busy || !nouveau.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
              </Button>
            </form>
          )}
        </div>

        {specialites.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            Le référentiel est vide.{canCreate ? " Ajoutez les spécialités que la promotion médicale emploie." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Spécialités du référentiel">
            {specialites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                {renomme?.id === s.id ? (
                  <>
                    <Input
                      value={renomme.name} autoFocus
                      onChange={(e) => setRenomme({ id: s.id, name: e.target.value })}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") { e.preventDefault(); if (await executer(updateSpecialty, { id: s.id, name: renomme.name })) setRenomme(null); }
                        if (e.key === "Escape") { e.preventDefault(); setRenomme(null); }
                      }}
                      aria-label={`Nouveau nom de la spécialité ${s.name}`}
                      className="h-10 min-w-0 flex-1 sm:h-8"
                    />
                    <button type="button" disabled={busy} aria-label="Enregistrer le nom"
                      onClick={async () => { if (await executer(updateSpecialty, { id: s.id, name: renomme.name })) setRenomme(null); }}
                      className="rounded-md p-2.5 sm:p-1.5 text-success hover:bg-success/10">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button type="button" onClick={() => setRenomme(null)} disabled={busy} aria-label="Annuler le renommage"
                      className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted">
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : fusion?.id === s.id ? (
                  <>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted-foreground">→</span>
                    <Select
                      aria-label={`Fusionner ${s.name} dans`}
                      value={fusion.cibleId}
                      onChange={(e) => setFusion({ id: s.id, cibleId: e.target.value })}
                      className="h-10 min-w-0 flex-1 text-sm sm:h-8"
                    >
                      <option value="">— Fusionner dans… —</option>
                      {autres(s.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </Select>
                    <Button
                      type="button" size="sm" disabled={busy || !fusion.cibleId}
                      onClick={async () => {
                        const cible = specialites.find((o) => o.id === fusion.cibleId);
                        if (!cible) return;
                        if (!(await confirmer(`Fusionner « ${s.name} » dans « ${cible.name} » ?\n\n• ${s.praticiens} praticien(s) passeront à « ${cible.name} »${s.bu.length ? `\n• ${s.bu.length} Business Unit(s) viseront « ${cible.name} »` : ""}\n• « ${s.name} » disparaîtra du référentiel`))) return;
                        if (await executer(fusionnerSpecialite, { id: s.id, cibleId: fusion.cibleId })) setFusion(null);
                      }}
                    >
                      <GitMerge className="h-4 w-4" /> Fusionner
                    </Button>
                    <button type="button" onClick={() => setFusion(null)} disabled={busy} aria-label="Annuler la fusion"
                      className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted">
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 basis-40 break-words font-medium">{s.name}</span>
                    {s.bu.length > 0 && (
                      // LES BU QUI LA VISENT (§118.183) — dites AVANT le clic : un retrait sera refusé, une
                      // fusion les fera suivre.
                      <span className="min-w-0 break-words text-xs text-muted-foreground" title="Business Units qui visent cette spécialité (★ : principale)">
                        BU : {s.bu.map((b) => `${b.nom}${b.principale ? " ★" : ""}`).join(", ")}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{s.praticiens} praticien(s)</span>
                    {canEdit && (
                      <button type="button" disabled={busy} aria-label={`Renommer ${s.name}`}
                        onClick={() => { setMsg(null); setFusion(null); setRenomme({ id: s.id, name: s.name }); }}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {canDelete && specialites.length > 1 && (
                      <button type="button" disabled={busy} aria-label={`Fusionner ${s.name} dans une autre spécialité`}
                        onClick={() => { setMsg(null); setRenomme(null); setFusion({ id: s.id, cibleId: "" }); }}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <GitMerge className="h-4 w-4" />
                      </button>
                    )}
                    {canDelete && (
                      <button type="button" disabled={busy} aria-label={`Retirer ${s.name} du référentiel`}
                        onClick={async () => {
                          const suite = s.praticiens > 0
                            ? `\n\n• ${s.praticiens} praticien(s) GARDENT « ${s.name} » écrite sur leur fiche, sans lien — à rattacher.\n• Pour réunir deux doublons, utilisez plutôt « Fusionner ».`
                            : "";
                          if (!(await confirmer(`Retirer « ${s.name} » du référentiel ?${suite}`))) return;
                          await executer(deleteSpecialty, { id: s.id });
                        }}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="heritees-titre" className="space-y-3">
        <div>
          <h2 id="heritees-titre" className="text-base font-semibold">Libellés hérités, à rattacher</h2>
          <p className="text-sm text-muted-foreground">
            Une spécialité écrite en texte sur des fiches, sans lien vers le référentiel. Tant qu&apos;elle n&apos;est pas rattachée, rien de ce qui lit le référentiel ne la voit.
            {heriteesTotal > heritees.length ? ` ${heritees.length} libellés affichés sur ${heriteesTotal}.` : ""}
          </p>
        </div>
        {heritees.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">Aucun libellé hérité dans ce que vous voyez de l&apos;annuaire : chaque spécialité écrite est rattachée.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Libellés hérités">
            {heritees.map((h) => {
              const cible = cibles[h.libelle] ?? h.designe?.id ?? "";
              return (
                <li key={h.libelle} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">« {h.libelle} »</span>
                    {h.variantes.length > 0 && <span className="text-xs text-muted-foreground"> (aussi écrit {h.variantes.map((v) => `« ${v} »`).join(", ")})</span>}
                  </span>
                  <Badge tone="neutral">{h.praticiens} fiche(s)</Badge>
                  {h.designe && <Badge tone="info">désigne « {h.designe.name} »</Badge>}
                  {canEdit && specialites.length > 0 && (
                    <>
                      <Select
                        aria-label={`Rattacher « ${h.libelle} » à`}
                        value={cible}
                        onChange={(e) => setCibles((c) => ({ ...c, [h.libelle]: e.target.value }))}
                        className="h-10 w-full text-sm sm:h-8 sm:w-56"
                      >
                        <option value="">— Rattacher à… —</option>
                        {specialites.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </Select>
                      <Button
                        type="button" size="sm" variant="outline" disabled={busy || !cible}
                        onClick={() => void executer(rattacherLibelleSpecialite, { libelle: h.libelle, specialtyId: cible })}
                      >
                        <Link2 className="h-4 w-4" /> Rattacher
                      </Button>
                    </>
                  )}
                  {canCreate && !h.designe && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} className="h-auto min-h-9 max-w-full whitespace-normal text-left sm:min-h-8"
                      onClick={() => void executer(createSpecialty, { name: h.libelle })}>
                      <Plus className="h-4 w-4" /> Créer « {h.libelle} »
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
