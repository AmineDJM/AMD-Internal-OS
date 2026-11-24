"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import { ALGERIA_WILAYAS } from "@/lib/labels";
import { addDirectoryDoctor } from "@/lib/actions/medical-directory-actions";
import { cleDeNom, plier } from "@/modules/referentiels/partage";
import type { Lettre } from "@/lib/segmentation/regles";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { filtrerPanel, homonymesDansLePanel, phraseDernierPassage, type FiltreLettre } from "./regles-panel";

export interface MedecinDuPanel {
  id: string;
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  wilaya: string | null;
  lettre: Lettre | null;
  /** Visites rapportées ce mois, et ce que la lettre demande. */
  faites: number;
  attendues: number;
  /** ISO de la dernière visite connue. */
  derniereVisite: string | null;
  /** La raison chiffrée quand la fréquence n'est pas tenue ce mois (la tournée le propose). */
  retard: string | null;
}

const LETTRES: FiltreLettre[] = ["Toutes", "H", "A", "B", "C", "D", "NA"];

const PUCE = "inline-flex h-9 items-center rounded-full border px-3 text-sm";

/**
 * LE PANEL DU DÉLÉGUÉ — chercher (nom, spécialité, établissement), filtrer par lettre ou « en retard seulement », ouvrir la
 * fiche. Les règles d'affichage sont pures (`regles-panel.ts`) et testées.
 */
export function MesMedecins({
  medecins, maintenant, peutAjouter, ouvrirAjout, rechercheInitiale,
}: {
  medecins: MedecinDuPanel[];
  /** ISO — l'heure du serveur, pour que « il y a n j » soit le même au rendu et à l'hydratation. */
  maintenant: string;
  peutAjouter: boolean;
  ouvrirAjout: boolean;
  rechercheInitiale: string;
}) {
  const [q, setQ] = React.useState(rechercheInitiale);
  const [lettre, setLettre] = React.useState<FiltreLettre>("Toutes");
  const [retardSeul, setRetardSeul] = React.useState(false);
  const [ajout, setAjout] = React.useState(ouvrirAjout && peutAjouter);
  const liste = filtrerPanel(medecins, { q, lettre, retardSeul });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, spécialité, établissement" className="pl-8" aria-label="Chercher dans mon panel" />
        </div>
        {peutAjouter && (
          <Button className="h-10 sm:h-9" onClick={() => setAjout(true)}><Plus className="h-4 w-4" /> Ajouter un médecin</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrer">
        {LETTRES.map((l) => (
          <button key={l} type="button" aria-pressed={lettre === l} onClick={() => setLettre(l)}
            className={cn(PUCE, lettre === l ? "border-primary bg-primary/10 font-medium text-primary" : "border-input hover:bg-secondary")}>
            {l}
          </button>
        ))}
        <button type="button" aria-pressed={retardSeul} onClick={() => setRetardSeul((r) => !r)}
          className={cn(PUCE, retardSeul ? "border-primary bg-primary/10 font-medium text-primary" : "border-input hover:bg-secondary")}>
          En retard seulement
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{medecins.length} médecin{medecins.length > 1 ? "s" : ""} dans votre panel · {liste.length} affiché{liste.length > 1 ? "s" : ""}</p>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {liste.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Aucun médecin de votre panel ne correspond.
            {peutAjouter && <> <button type="button" className="font-medium text-primary hover:underline" onClick={() => setAjout(true)}>L&apos;ajouter</button></>}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {liste.map((d) => (
              <li key={d.id}>
                <Link href={`/praticiens/${d.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-3 hover:bg-secondary/50 sm:px-4">
                  {d.lettre && <LettreBadge lettre={d.lettre} className="h-5 min-w-[22px] shrink-0" />}
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="block truncate font-medium">{d.nom}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[d.specialite, [d.etablissement, d.wilaya].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}
                    </span>
                    {d.retard && <span className="block text-xs text-warning">{d.retard}</span>}
                  </span>
                  {d.attendues > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">vu {d.faites} · requis {d.attendues} ce mois</span>}
                  <Badge tone={d.retard ? "danger" : "neutral"}>{phraseDernierPassage(d.derniereVisite, maintenant)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ajout && <AjouterMedecin medecins={medecins} rechercheInitiale={q} onClose={() => setAjout(false)} />}
    </div>
  );
}

/**
 * AJOUTER UN MÉDECIN À SON PANEL — la fiche entre dans l'annuaire par le geste de l'annuaire (`addDirectoryDoctor`), le
 * délégué en est propriétaire. Avant de créer, les HOMONYMES de son panel (mêmes mots du nom, titres et accents ignorés —
 * `cleDeNom`, la règle des doublons de l'annuaire) se montrent : un médecin ne doit exister qu'une fois.
 */
function AjouterMedecin({ medecins, rechercheInitiale, onClose }: { medecins: MedecinDuPanel[]; rechercheInitiale: string; onClose: () => void }) {
  const { run, saving, err } = useAction();
  const [nom, setNom] = React.useState(rechercheInitiale);
  const [prenom, setPrenom] = React.useState("");
  const [specialite, setSpecialite] = React.useState("");
  const [wilaya, setWilaya] = React.useState("");
  const homonymes = homonymesDansLePanel(medecins, `${prenom} ${nom}`, cleDeNom, plier);
  return (
    <Sheet open onClose={onClose} title="Ajouter un médecin à mon panel" width="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => addDirectoryDoctor({ lastName: nom, firstName: prenom, specialty: specialite, wilaya }), onClose, { succes: "Médecin ajouté à votre panel." });
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><Label htmlFor="aj-nom">Nom</Label><Input id="aj-nom" value={nom} onChange={(e) => setNom(e.target.value)} autoFocus /></div>
          <div><Label htmlFor="aj-prenom">Prénom</Label><Input id="aj-prenom" value={prenom} onChange={(e) => setPrenom(e.target.value)} /></div>
          <div><Label htmlFor="aj-spe">Spécialité</Label><Input id="aj-spe" value={specialite} onChange={(e) => setSpecialite(e.target.value)} /></div>
          <div>
            <Label htmlFor="aj-wilaya">Wilaya</Label>
            <Select id="aj-wilaya" value={wilaya} onChange={(e) => setWilaya(e.target.value)}>
              <option value="">—</option>
              {ALGERIA_WILAYAS.map((w) => <option key={w} value={w}>{w}</option>)}
            </Select>
          </div>
        </div>
        {homonymes.length > 0 && (
          <div role="status" className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            <p className="font-medium">Déjà dans votre panel sous ce nom — vérifiez la spécialité et l&apos;établissement :</p>
            <ul className="space-y-1">
              {homonymes.map((h) => (
                <li key={h.id}>
                  <Link href={`/praticiens/${h.id}`} className="text-primary hover:underline">{h.nom}</Link>
                  <span className="text-muted-foreground"> · {[h.specialite, h.etablissement, h.wilaya].filter(Boolean).join(", ") || "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {err && <Retour ton="erreur">{err}</Retour>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={onClose} disabled={saving}>Annuler</Button>
          <Button type="submit" className="h-10 sm:h-9" disabled={saving || !(nom.trim() || prenom.trim())}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {homonymes.length > 0 ? "Ce n'est pas lui · l'ajouter" : "Ajouter à mon panel"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
