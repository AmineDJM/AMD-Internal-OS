"use client";

import * as React from "react";
import { Loader2, Trash2, QrCode, Check, Search, Download, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { cn } from "@/lib/utils";
import { PARTICIPANT_ROLE, REGISTRATION_STATUS } from "@/lib/labels";
import { addRegistration, setRegistrationStatus, deleteRegistration } from "@/lib/actions/event-actions";
import type { RegistrationDTO } from "@/lib/queries/events";
import { estStatutInscriptionRetire } from "@/lib/events/externe";
import { useFormAction, useKeyedAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * LES STATUTS PROPOSÉS — sans la liste d'attente (Direction, 27/10) : un événement externe n'a pas de capacité à tenir.
 * Une inscription qui la porte déjà la garde (et l'affiche) ; on ne la propose plus.
 */
const statutsProposes = (actuel?: string) =>
  Object.entries(REGISTRATION_STATUS).filter(([v]) => !estStatutInscriptionRetire(v) || v === actuel);

export function RegistrationsManager({ eventId, registrations, canManage }: { eventId: string; registrations: RegistrationDTO[]; canManage: boolean }) {
  // Les gestes d'une ligne (statut, suppression) n'ont pas de place où parler : un refus part en avis flottant.
  const { run } = useKeyedAction({ signalerErreurs: true });
  const [q, setQ] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [qrToken, setQrToken] = React.useState<string | null>(null);
  const { action: ajouter, busy: saving, err, setErr } = useFormAction(addRegistration, {
    prepare: (fd) => fd.set("eventId", eventId),
    onOk: () => setAdding(false),
  });

  const list = registrations.filter((r) =>
    !q || `${r.fullName} ${r.specialty ?? ""} ${r.institution ?? ""} ${r.email ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );

  const setStatus = (id: string, status: string) => {
    const fd = new FormData(); fd.set("id", id); fd.set("status", status);
    void run(`statut-${id}`, () => setRegistrationStatus(fd));
  };

  return (
    <div className="space-y-3">
      {/* Actions — plus de lien d'inscription publique : l'événement est externe, on s'y inscrit chez l'organisateur. */}
      <div className="surface flex flex-wrap items-center justify-end gap-2 p-3">
        <a href={`/api/events/${eventId}/export`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium hover:bg-secondary sm:py-1.5"><Download className="h-4 w-4" /> Export Excel</a>
        {canManage && <Button size="sm" onClick={() => { setErr(null); setAdding(true); }}><UserPlus className="h-4 w-4" /> Ajouter</Button>}
      </div>

      {/* Recherche + check-in */}
      <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        {/* 16 px au téléphone : en dessous, iOS zoome sur le champ au moment du check-in. */}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un participant (check-in)…" className="h-11 w-full min-w-0 bg-transparent text-base focus:outline-none sm:h-9 sm:text-sm" />
      </div>

      {list.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">Aucun participant. Ajoutez ceux de l'équipe ou les praticiens qui y assistent.</p>
      ) : (
        <div className="surface divide-y divide-border">
          {list.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 break-words text-sm font-medium">{r.fullName} <span className="text-xs font-normal text-muted-foreground">{PARTICIPANT_ROLE[r.role]}</span></p>
                <p className="line-clamp-2 break-words text-xs text-muted-foreground sm:line-clamp-none sm:truncate">{[r.specialty, r.institution, r.city, r.email].filter(Boolean).join(" · ") || "—"}</p>
              </div>
              <StatusBadge map={REGISTRATION_STATUS} value={r.status} />
              {canManage && (
                // Au téléphone, les actions passent sur leur propre ligne, pleine largeur, au format du doigt.
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  {r.status !== "PRESENT" && <Button size="sm" variant="outline" onClick={() => setStatus(r.id, "PRESENT")} className="flex-1 sm:flex-none"><Check className="h-4 w-4 text-success" /> Présent</Button>}
                  <Select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className="h-9 w-32 text-xs sm:h-8" aria-label="Statut de l'inscription">
                    {statutsProposes(r.status).map(([v, x]) => <option key={v} value={v}>{x.label}</option>)}
                  </Select>
                  <button onClick={() => setQrToken(r.qrToken)} title="QR code" aria-label="QR code" className="rounded p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"><QrCode className="h-4 w-4" /></button>
                  <button onClick={() => { const fd = new FormData(); fd.set("id", r.id); void run(`suppr-${r.id}`, () => deleteRegistration(fd), { confirmer: "Supprimer cet inscrit ?" }); }} aria-label="Supprimer cet inscrit" className="rounded p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"><Trash2 className="h-4 w-4" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* QR d'un participant */}
      <Sheet open={qrToken !== null} onClose={() => setQrToken(null)} title="Badge QR du participant" description="À scanner à l'entrée pour le check-in." width="md">
        {qrToken && (
          <div className="flex flex-col items-center gap-3 py-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/events/qr/${qrToken}`} alt="QR code" className="h-60 w-60 max-w-full rounded-lg border border-border object-contain" />
            <a href={`/api/events/qr/${qrToken}`} download className="text-sm text-primary hover:underline">Télécharger le QR</a>
          </div>
        )}
      </Sheet>

      {/* Ajout d'un participant */}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Ajouter un participant" width="md">
        <form action={ajouter} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Prénom</Label><Input name="firstName" required /></div>
          <div className="space-y-1.5"><Label>Nom</Label><Input name="lastName" required /></div>
          <div className="space-y-1.5"><Label>Rôle</Label><Select name="role" defaultValue="DOCTOR">{Object.entries(PARTICIPANT_ROLE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
          <div className="space-y-1.5"><Label>Statut</Label><Select name="status" defaultValue="CONFIRMED">{statutsProposes().map(([v, x]) => <option key={v} value={v}>{x.label}</option>)}</Select></div>
          <div className="space-y-1.5"><Label>Spécialité</Label><Input name="specialty" /></div>
          <div className="space-y-1.5"><Label>Établissement</Label><Input name="institution" /></div>
          <div className="space-y-1.5"><Label>Ville</Label><Input name="city" /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input name="email" type="email" inputMode="email" /></div>
          <div className="space-y-1.5"><Label>Téléphone</Label><Input name="phone" type="tel" inputMode="tel" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Commentaire</Label><Textarea name="comment" rows={2} /></div>
          <Retour ton="erreur" className="sm:col-span-2">{err}</Retour>
          <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setAdding(false)} className="w-full sm:w-auto">Annuler</Button><Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Ajouter</Button></div>
        </form>
      </Sheet>
    </div>
  );
}
