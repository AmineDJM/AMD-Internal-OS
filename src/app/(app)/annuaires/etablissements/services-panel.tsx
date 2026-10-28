"use client";

import * as React from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { ajouterServicesEtablissement, renommerServiceEtablissement, supprimerServiceEtablissement } from "@/lib/actions/etablissement-services-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { EtablissementRow, ServiceEtablissementRow } from "@/lib/annuaires/types";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";

const SUGGESTIONS_ID = "services-suggestions";

/**
 * LES SERVICES D'UN ÉTABLISSEMENT — le panneau qui les tient (§118.172).
 *
 * « Pour chaque établissement hospitalier, on doit pouvoir renseigner les services qu'il a,
 * ajouter ou supprimer ces services. » Le panneau liste les services, les renomme en place, les
 * supprime en DISANT ce que la suppression emporte (praticiens sans service, secteurs qui le
 * perdent), et en ajoute un ou plusieurs d'un coup — une liste collée depuis un fichier se lit
 * telle quelle (virgules, points-virgules, retours à la ligne).
 *
 * Les spécialités connues sont PROPOSÉES à la saisie, jamais imposées : « Urgences » ou
 * « Pharmacie centrale » sont des services sans être des spécialités.
 *
 * Qui ne peut pas modifier l'annuaire voit la liste, sans aucun bouton : un bouton qu'une action
 * refusera n'est pas un bouton (§118.83).
 */
export function ServicesPanel({
  etablissement, canEdit, suggestions, onClose,
}: {
  etablissement: EtablissementRow | null;
  canEdit: boolean;
  /** Les spécialités connues, proposées à la saisie. */
  suggestions: string[];
  onClose: () => void;
}) {
  // Un service renommé ou supprimé reste affiché sous son ancien nom tant que les nouvelles
  // données ne sont pas là : les gestes attendent leur arrivée (§118.172).
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [saisie, setSaisie] = React.useState("");
  const [enAction, setBusy] = React.useState(false);
  const busy = enAction || rafraichit;
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [renomme, setRenomme] = React.useState<{ id: string; name: string } | null>(null);

  React.useEffect(() => { setSaisie(""); setMsg(null); setRenomme(null); }, [etablissement?.id]);

  const executer = async (action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, fd: FormData) => {
    setBusy(true); setMsg(null);
    try {
      const r = await action(fd);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "Le service n'a pas été modifié.") });
      if (r.ok) rafraichir();
      return r.ok;
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ajouter = async () => {
    if (!etablissement || !saisie.trim()) return;
    const fd = new FormData();
    fd.set("institutionId", etablissement.id);
    fd.set("noms", saisie);
    if (await executer(ajouterServicesEtablissement, fd)) setSaisie("");
  };

  const renommer = async () => {
    if (!renomme) return;
    const fd = new FormData();
    fd.set("id", renomme.id);
    fd.set("name", renomme.name);
    if (await executer(renommerServiceEtablissement, fd)) setRenomme(null);
  };

  const supprimer = async (s: ServiceEtablissementRow) => {
    const suites = [
      s.doctorCount > 0 ? `• ${s.doctorCount} praticien(s) resteront rattachés à l'établissement, SANS service (ils ne sont pas supprimés)` : null,
      s.sectorCount > 0 ? `• ${s.sectorCount} secteur(s) commercial(aux) qui le choisissaient ne le couvriront plus` : null,
    ].filter(Boolean);
    if (!(await confirmer(`Supprimer le service « ${s.name} » de « ${etablissement?.name ?? ""} » ?${suites.length ? `\n\n${suites.join("\n")}` : ""}`))) return;
    const fd = new FormData();
    fd.set("id", s.id);
    await executer(supprimerServiceEtablissement, fd);
  };

  const services = etablissement?.services ?? [];

  return (
    <Sheet
      open={etablissement !== null}
      onClose={onClose}
      title={etablissement ? `Services — ${etablissement.name}` : "Services"}
      description="Les services de l'établissement : un praticien s'y rattache, et un secteur de Business Unit peut couvrir tous les services ou seulement certains."
      width="md"
    >
      <div className="space-y-4">
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "rounded-lg bg-success/10 px-3 py-2 text-sm text-success" : "rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"}>
            {msg.text}
          </p>
        )}

        {services.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            Aucun service renseigné pour cet établissement.
            {canEdit ? " Ajoutez-les ci-dessous — un praticien pourra ensuite y être rattaché." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label={`Services de ${etablissement?.name ?? ""}`}>
            {services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                {renomme?.id === s.id ? (
                  <>
                    <Input
                      value={renomme.name} autoFocus
                      onChange={(e) => setRenomme({ id: s.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void renommer(); }
                        if (e.key === "Escape") { e.preventDefault(); setRenomme(null); }
                      }}
                      aria-label={`Nouveau nom du service ${s.name}`}
                      className="h-10 min-w-0 flex-1 sm:h-8"
                    />
                    <button type="button" onClick={() => void renommer()} disabled={busy} aria-label="Enregistrer le nom"
                      className="rounded-md p-2.5 sm:p-1.5 text-success hover:bg-success/10">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button type="button" onClick={() => setRenomme(null)} disabled={busy} aria-label="Annuler le renommage"
                      className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted">
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 break-words font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.doctorCount} praticien(s){s.sectorCount > 0 ? ` · ${s.sectorCount} secteur(s)` : ""}
                    </span>
                    {canEdit && (
                      <>
                        <button type="button" onClick={() => { setMsg(null); setRenomme({ id: s.id, name: s.name }); }} disabled={busy}
                          aria-label={`Renommer le service ${s.name}`}
                          className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => void supprimer(s)} disabled={busy}
                          aria-label={`Supprimer le service ${s.name}`}
                          className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && etablissement && (
          <div className="space-y-2">
            <Label htmlFor="services-ajout">Ajouter un ou plusieurs services</Label>
            <datalist id={SUGGESTIONS_ID}>
              {suggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
            {/* UNE LIGNE, avec les spécialités proposées. Une liste COLLÉE depuis un fichier (une
                par ligne) se range en virgules au collage — un champ d'une ligne effacerait sinon
                les retours à la ligne, et « Cardiologie Oncologie » deviendrait un seul service. */}
            <Input
              id="services-ajout" value={saisie} list={SUGGESTIONS_ID}
              onChange={(e) => setSaisie(e.target.value)}
              onPaste={(e) => {
                const texte = e.clipboardData.getData("text");
                if (!/[\r\n]/.test(texte)) return;
                e.preventDefault();
                const liste = texte.split(/[\r\n]+/).map((t) => t.trim()).filter(Boolean).join(", ");
                setSaisie((avant) => (avant.trim() ? `${avant.trim()}, ${liste}` : liste));
              }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void ajouter(); } }}
              placeholder="Cardiologie — ou plusieurs, séparés par des virgules"
            />
            <div className="flex justify-end">
              <Button type="button" onClick={() => void ajouter()} disabled={busy || !saisie.trim()} className="w-full sm:w-auto">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
