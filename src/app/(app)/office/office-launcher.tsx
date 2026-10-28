"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pin, PinOff, Loader2, Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createOfficeNode } from "@/lib/actions/drive-actions";
import { executerCreationOffice } from "@/lib/office/creation-ui";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { OFFICE_APPS, OFFICE_PINS_KEY, parsePinned, togglePinned, type OfficeAppKey } from "@/lib/office/apps";
import { LetterheadChoice } from "@/components/office/letterhead-choice";
import { lireStockagePersonnel, useIdentiteEcran } from "@/components/layout/identite-vue";
import { cleParPersonne } from "@/lib/vue-exacte-ui";
import type { LetterheadOption } from "@/lib/queries/letterheads";

/**
 * LE LANCEUR — trois applications, et le geste qu'on vient faire : créer un document.
 *
 * On n'ouvre pas « un module bureautique », on ouvre Word pour écrire une note. Chaque vignette
 * crée donc directement un document neuf dans le Drive et bascule dans l'éditeur, sans étape
 * intermédiaire où il faudrait choisir un emplacement — le document atterrit chez soi, et se
 * range ensuite comme n'importe quel fichier.
 *
 * L'épingle met l'application dans le menu de gauche. C'est une préférence D'AFFICHAGE, propre à
 * chacun : elle ne donne aucun droit et n'a donc pas à voyager en base. Le menu l'écoute en direct
 * (évènement `amd:office-pins`), pour que l'entrée apparaisse au moment du clic et non au
 * rechargement suivant.
 */
export function OfficeLauncher({
  officeEnabled, focus, letterheads = [], companyId = null,
}: {
  officeEnabled: boolean;
  focus?: OfficeAppKey;
  letterheads?: LetterheadOption[];
  companyId?: string | null;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [pins, setPins] = React.useState<OfficeAppKey[]>([]);
  const [open, setOpen] = React.useState<OfficeAppKey | null>(focus ?? null);
  const [name, setName] = React.useState("");
  const [letterheadId, setLetterheadId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Épingles rangées par PERSONNE À L'ÉCRAN (Vue exacte : celles de la personne visualisée).
  const ident = useIdentiteEcran();
  React.useEffect(() => {
    setPins(parsePinned(lireStockagePersonnel(OFFICE_PINS_KEY, ident)));
  }, [ident]);

  React.useEffect(() => {
    if (!open) return;
    setName(OFFICE_APPS.find((a) => a.key === open)?.defaultName ?? "Sans titre");
    setLetterheadId(null);
    setErr(null);
  }, [open]);

  const pin = (key: OfficeAppKey) => {
    const next = togglePinned(pins, key);
    setPins(next);
    try {
      window.localStorage.setItem(cleParPersonne(OFFICE_PINS_KEY, ident.id), JSON.stringify(next));
      window.dispatchEvent(new CustomEvent("amd:office-pins", { detail: { pins: next } }));
    } catch { /* refusé : sans mémoire, l'écran reste utilisable */ }
  };

  const create = async () => {
    if (!open || busy) return;
    const clean = name.trim();
    if (!clean) { setErr("Donnez un nom au document."); return; }
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("kind", open);
    fd.set("name", clean);
    if (letterheadId) fd.set("letterheadId", letterheadId);
    // Un appel qui REJETTE laissait `busy` à vrai pour toujours : la roue tournait, sans un mot.
    try {
      const r = await executerCreationOffice(() => createOfficeNode(fd));
      if (!r.ok) { setErr(r.error); return; }
      setOpen(null);
      if (officeEnabled) router.push(`/drive/${r.id}`);
      else rafraichir();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {OFFICE_APPS.map((a) => {
          const pinned = pins.includes(a.key);
          return (
            <div key={a.key} className="surface relative flex flex-col gap-2 p-4">
              <button
                type="button"
                onClick={() => pin(a.key)}
                aria-pressed={pinned}
                title={pinned ? "Retirer du menu" : "Épingler dans le menu de gauche"}
                className={`absolute right-2 top-2 rounded-lg p-2.5 transition-colors sm:p-1.5 ${pinned ? "text-primary" : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground"}`}
              >
                {pinned ? <Pin className="h-4 w-4 fill-current" /> : <PinOff className="h-4 w-4" />}
              </button>
              <Icon name={a.icon} className={`h-9 w-9 ${a.tone}`} />
              <div>
                <p className="text-base font-semibold">{a.label}</p>
                <p className="text-xs text-muted-foreground">{a.hint}</p>
              </div>
              <Button type="button" className="mt-1 w-full" onClick={() => setOpen(a.key)}>
                <Plus className="h-4 w-4" /> Nouveau
              </Button>
            </div>
          );
        })}
      </div>

      <Sheet
        open={open !== null}
        onClose={() => !busy && setOpen(null)}
        title={open ? `Nouveau document ${OFFICE_APPS.find((a) => a.key === open)?.label}` : ""}
        description="Le document est créé dans votre Drive. Vous pourrez ensuite le ranger ou le partager."
        width="md"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="office-name">Nom du document</Label>
            <Input
              id="office-name" value={name} autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }}
            />
          </div>
          {open && (
            <LetterheadChoice
              kind={open} letterheads={letterheads} companyId={companyId}
              value={letterheadId} onChange={setLetterheadId} disabled={busy}
            />
          )}
          {!officeEnabled && (
            <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
              L&apos;éditeur en ligne n&apos;est pas encore activé sur ce serveur : le document sera créé dans
              votre Drive et téléchargeable. L&apos;édition dans le navigateur s&apos;ouvrira dès qu&apos;il le sera.
            </p>
          )}
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(null)} disabled={busy}>Annuler</Button>
            <Button type="button" onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {officeEnabled ? "Créer et ouvrir" : "Créer"}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
