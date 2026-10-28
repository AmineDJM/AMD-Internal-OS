"use client";

import * as React from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { deposerLogo, enregistrerMarque, type ResultatMarque } from "@/lib/actions/brand-actions";
import { POLICES_SURES, TYPES_PIECE, LIBELLE_TYPE_PIECE, type Marque } from "@/lib/brand/model";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/actions/types";
import { useRafraichir } from "@/components/shared/use-rafraichir";

/**
 * LES FORMULAIRES DU REGISTRE DE MARQUE — un pour la charte (couleurs, polices, coordonnées,
 * mentions, signataires), un pour le logo (un fichier). Chaque envoi passe par l'action
 * serveur ; le message affiché est celui du serveur, refus compris. Un champ laissé vide ne
 * touche à rien ; « — » efface une valeur texte ; une case « effacer » efface une couleur ou une police.
 */
function BoutonEnvoi({ libelle }: { libelle: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" size="sm" disabled={pending}>{pending ? "…" : libelle}</Button>;
}

const Champ = ({ id, label, defaut, type = "text", placeholder, nom }: { id: string; label: string; defaut?: string | null; type?: string; placeholder?: string; nom?: string }) => (
  <label htmlFor={id} className="flex flex-col gap-1 text-xs text-muted-foreground">
    {label}
    <input id={id} name={nom ?? id} type={type} defaultValue={defaut ?? ""} placeholder={placeholder} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" />
  </label>
);

export function FormulaireMarque({ companyId, marque }: { companyId: string; marque: Marque }) {
  const { rafraichir } = useRafraichir();
  const [etat, agir] = useActionState<ResultatMarque | undefined, FormData>(async (prev, fd) => {
    const r = await enregistrerMarque(prev, fd);
    if (r.ok) rafraichir();
    return r;
  }, undefined);
  return (
    <form action={agir} className="space-y-3" data-testid="marque-form">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Couleur d&apos;accent
          <span className="flex items-center gap-2">
            <input type="color" name="couleurAccent" defaultValue={marque.couleurs.accent ? `#${marque.couleurs.accent}` : "#0B2545"} className="h-9 w-12 rounded-md border bg-background" data-testid="marque-accent" aria-label="Couleur d'accent" />
            <span className="text-sm text-foreground">{marque.couleurs.accent ? `#${marque.couleurs.accent}` : "non réglée (bleu canard de la maison)"}</span>
            <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" name="effacer_couleurAccent" /> effacer</label>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Couleur secondaire
          <span className="flex items-center gap-2">
            <input type="color" name="couleurSecondaire" defaultValue={marque.couleurs.secondaire ? `#${marque.couleurs.secondaire}` : "#1B7F79"} className="h-9 w-12 rounded-md border bg-background" aria-label="Couleur secondaire" />
            <span className="text-sm text-foreground">{marque.couleurs.secondaire ? `#${marque.couleurs.secondaire}` : "non réglée"}</span>
            <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" name="effacer_couleurSecondaire" /> effacer</label>
          </span>
        </label>
        <label htmlFor={`pt-${companyId}`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          Police des titres
          <select id={`pt-${companyId}`} name="policeTitres" defaultValue={marque.polices.titres ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" data-testid="marque-police-titres">
            <option value="">— inchangée ({marque.polices.titres ?? "Calibri"})</option>
            {POLICES_SURES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label htmlFor={`px-${companyId}`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          Police du texte
          <select id={`px-${companyId}`} name="policeTexte" defaultValue={marque.polices.texte ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
            <option value="">— inchangée ({marque.polices.texte ?? "Calibri"})</option>
            {POLICES_SURES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <Champ id={`adr-${companyId}`} nom="adresse" label="Adresse imprimée (vide = carte Legal)" defaut={marque.coordonnees.adresse} placeholder="—  pour effacer" />
        <Champ id={`tel-${companyId}`} nom="telephone" label="Téléphone" defaut={marque.coordonnees.telephone} />
        <Champ id={`eml-${companyId}`} nom="email" label="E-mail" defaut={marque.coordonnees.email} type="email" />
        <Champ id={`web-${companyId}`} nom="siteWeb" label="Site web" defaut={marque.coordonnees.siteWeb} placeholder="adventum.dz" />
      </div>
      <label htmlFor={`men-${companyId}`} className="flex flex-col gap-1 text-xs text-muted-foreground">
        Mentions de pied de page (une par ligne, huit au plus)
        <textarea id={`men-${companyId}`} name="mentionsLegales" defaultValue={marque.mentionsLegales.join("\n")} rows={3} className="rounded-md border bg-background px-2 py-1 text-sm text-foreground" data-testid="marque-mentions" />
      </label>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs text-muted-foreground">Signataires (« — » dans le nom pour retirer)</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Champ id={`sn-${companyId}`} nom="signataireNom" label="Par défaut — nom" defaut={marque.signatures.defaut?.nom} />
          <Champ id={`sq-${companyId}`} nom="signataireQualite" label="Par défaut — qualité" defaut={marque.signatures.defaut?.qualite} />
          {TYPES_PIECE.map((t) => (
            <React.Fragment key={t}>
              <Champ id={`s-${t}-n-${companyId}`} nom={`sig_${t}_nom`} label={`${LIBELLE_TYPE_PIECE[t]} — nom`} defaut={marque.signatures.parType[t]?.nom} />
              <Champ id={`s-${t}-q-${companyId}`} nom={`sig_${t}_qualite`} label={`${LIBELLE_TYPE_PIECE[t]} — qualité`} defaut={marque.signatures.parType[t]?.qualite} />
            </React.Fragment>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <BoutonEnvoi libelle="Enregistrer la charte" />
        {etat && <span className={`text-xs ${etat.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="marque-message">{etat.ok ? etat.message : etat.error}</span>}
      </div>
    </form>
  );
}

export function FormulaireLogo({ companyId, logo }: { companyId: string; logo: { nom: string; taille: number; largeurCm: number } | null }) {
  const { rafraichir } = useRafraichir();
  const [etat, agir] = useActionState<ActionResult | undefined, FormData>(async (prev, fd) => {
    const r = await deposerLogo(prev, fd);
    if (r.ok) rafraichir();
    return r;
  }, undefined);
  return (
    <form action={agir} className="flex flex-wrap items-end gap-3 rounded-md border p-3" data-testid="logo-form">
      <input type="hidden" name="companyId" value={companyId} />
      {logo ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/marque/${companyId}/logo?v=${encodeURIComponent(logo.nom)}-${logo.taille}`} alt={`Logo — ${logo.nom}`} className="h-10 max-w-[160px] object-contain" data-testid="logo-apercu" />
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{logo.nom} · {Math.round(logo.taille / 1024)} Ko · {logo.largeurCm} cm</span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Aucun logo : les pièces sans papier en-tête partent sans image ; le papier en-tête, lui, porte le sien.</span>
      )}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Logo (PNG ou JPEG, 2 Mo)
        <input type="file" name="file" accept="image/png,image/jpeg" className="max-w-full text-sm" data-testid="logo-fichier" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Largeur (cm)
        <input type="number" name="largeurCm" min={1} max={8} step={0.5} defaultValue={logo?.largeurCm ?? 4} className="h-9 w-20 rounded-md border bg-background px-2 text-sm text-foreground" />
      </label>
      {logo && <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="retirer" data-testid="logo-retirer" /> retirer le logo</label>}
      <BoutonEnvoi libelle="Déposer" />
      {etat && <span className={`text-xs ${etat.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="logo-message">{etat.ok ? etat.message : etat.error}</span>}
    </form>
  );
}
