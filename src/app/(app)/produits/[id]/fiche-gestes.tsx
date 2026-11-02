"use client";

import * as React from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import {
  ajouterAliasProduitCanonique, renommerProduitCanonique, retirerAliasProduitCanonique,
} from "@/lib/actions/produit-canonique-actions";

type Retour = { ok: boolean; texte: string } | null;

function RetourLigne({ retour }: { retour: Retour }) {
  if (!retour) return null;
  return (
    <p role={retour.ok ? "status" : "alert"} className={retour.ok ? "text-xs text-success" : "text-xs text-destructive"}>
      {retour.texte}
    </p>
  );
}

/** Le NOM du produit — l'identité, elle, ne se renomme pas : elle se corrige sur le dossier. */
export function RenommerProduit({ id, nom }: { id: string; nom: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [valeur, setValeur] = React.useState(nom);
  const [envoi, setEnvoi] = React.useState(false);
  const [retour, setRetour] = React.useState<Retour>(null);
  React.useEffect(() => { setValeur(nom); }, [nom]);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    setEnvoi(true); setRetour(null);
    const fd = new FormData();
    fd.set("id", id); fd.set("canonicalName", valeur);
    try {
      const r = await renommerProduitCanonique(fd);
      setRetour({ ok: r.ok, texte: r.ok ? "Nom enregistré." : r.error ?? "Enregistrement impossible." });
      if (r.ok) rafraichir();
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }

  const occupe = envoi || enCours;
  return (
    <form onSubmit={enregistrer} className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground" htmlFor="nom-produit">Nom du produit</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id="nom-produit" name="canonicalName" value={valeur} onChange={(e) => setValeur(e.target.value)} maxLength={200} disabled={occupe} />
        <Button type="submit" size="sm" disabled={occupe || !valeur.trim() || valeur.trim() === nom}>
          {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Enregistrer
        </Button>
      </div>
      <RetourLigne retour={retour} />
    </form>
  );
}

/** Les ALIAS — décisions humaines, au deuxième rang de la résolution, juste après la référence. */
export function AliasProduit({ id, aliases }: { id: string; aliases: { id: string; label: string }[] }) {
  const { enCours, rafraichir } = useRafraichir();
  const [nouveau, setNouveau] = React.useState("");
  const [envoi, setEnvoi] = React.useState(false);
  const [retour, setRetour] = React.useState<Retour>(null);
  const confirmer = useConfirmer();

  async function ajouter(e: React.FormEvent) {
    e.preventDefault();
    setEnvoi(true); setRetour(null);
    const fd = new FormData();
    fd.set("id", id); fd.set("label", nouveau);
    try {
      const r = await ajouterAliasProduitCanonique(fd);
      if (!r.ok) { setRetour({ ok: false, texte: r.error ?? "Ajout impossible." }); return; }
      setNouveau("");
      setRetour({ ok: true, texte: "Alias ajouté." });
      rafraichir();
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }

  async function retirer(aliasId: string, label: string) {
    if (!(await confirmer(`Retirer l'alias « ${label} » ?`))) return;
    setEnvoi(true); setRetour(null);
    const fd = new FormData();
    fd.set("aliasId", aliasId);
    try {
      const r = await retirerAliasProduitCanonique(fd);
      setRetour({ ok: r.ok, texte: r.ok ? "Alias retiré." : r.error ?? "Retrait impossible." });
      if (r.ok) rafraichir();
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }

  const occupe = envoi || enCours;
  return (
    <div className="space-y-2">
      {aliases.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {aliases.map((a) => (
            <li key={a.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
              {a.label}
              <button type="button" aria-label={`Retirer l'alias ${a.label}`} disabled={occupe}
                className="-my-1 rounded-full p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-50 sm:my-0 sm:p-0.5"
                onClick={() => retirer(a.id, a.label)}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={ajouter} className="flex flex-col gap-2 sm:flex-row">
        <Input name="label" placeholder="Nouvel alias (nom commercial, abréviation…)" value={nouveau}
          onChange={(e) => setNouveau(e.target.value)} maxLength={120} disabled={occupe} />
        <Button type="submit" size="sm" variant="outline" disabled={occupe || !nouveau.trim()}>
          {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Ajouter
        </Button>
      </form>
      <RetourLigne retour={retour} />
    </div>
  );
}
