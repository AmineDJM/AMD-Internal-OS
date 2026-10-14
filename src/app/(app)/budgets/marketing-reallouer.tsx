"use client";

/**
 * RÉALLOUER — déplacer un montant d'une catégorie à une autre de l'enveloppe, motif obligatoire (Direction Marketing,
 * 10/2026). L'enveloppe ne change pas ; le motif reste dans l'historique du budget.
 *
 * BORNÉ (maquette « onglets » validée) : chaque catégorie affiche ce qu'elle peut CÉDER — ce qui reste libre au-dessus
 * de son payé + engagé et de ce que ses sous-catégories répartissent (`budget/marketing-vue.ts`, `cessible`) ; le
 * serveur revérifie la même borne. Le geste passe par une SECONDE confirmation, comme le reste du module.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { reallouerCategorie } from "@/lib/actions/budget-pole-actions";
import { MOTIF_MIN, refusReallocation, type NoeudArbre } from "@/lib/budget/marketing-vue";
import { FenetreConfirmation, type Confirmation } from "./fenetre-confirmation";
import { fmt } from "./marketing-graphiques";

export interface DemandeReallocation { sourceId?: string; cibleId?: string; montant?: number; besoin?: number }

export function ReallouerSheet({ ouverte, onClose, tetes, envelopeId, initial, onFait }: {
  ouverte: boolean;
  onClose: () => void;
  /** Les catégories de tête, cumulées (`arbreCategories`). */
  tetes: NoeudArbre[];
  envelopeId: string;
  initial: DemandeReallocation;
  /** Le message de réussite, pour l'écran qui a ouvert le panneau. */
  onFait?: (message: string) => void;
}) {
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const [sourceId, setSourceId] = React.useState(initial.sourceId ?? "");
  const [cibleId, setCibleId] = React.useState(initial.cibleId ?? "");
  const [montant, setMontant] = React.useState(initial.montant ? String(Math.round(initial.montant)) : "");
  const [motif, setMotif] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null);

  React.useEffect(() => {
    if (!ouverte) return;
    setSourceId(initial.sourceId ?? "");
    setCibleId(initial.cibleId ?? "");
    setMontant(initial.montant ? String(Math.round(initial.montant)) : "");
    setMotif("");
    setErreur(null);
  }, [ouverte, initial]);

  const source = tetes.find((l) => l.id === sourceId);
  const cible = tetes.find((l) => l.id === cibleId);
  const valeur = Number(montant.replace(/\s/g, "").replace(",", "."));
  const besoin = cible ? Math.max(0, cible.paye + cible.engage - cible.alloue) : 0;

  const envoyer = async () => {
    setEnvoi(true);
    try {
      const fd = new FormData();
      fd.set("sourceId", sourceId);
      fd.set("cibleId", cibleId);
      fd.set("montant", String(valeur));
      fd.set("motif", motif.trim());
      const r = await reallouerCategorie(fd);
      if (!r.ok) { setErreur(r.error ?? "Échec."); return; }
      onFait?.(r.message ?? "Réalloué.");
      rafraichir();
      onClose();
    } finally {
      setEnvoi(false);
    }
  };

  /** Premier geste : on vérifie (même règle que le serveur), puis la seconde confirmation dit ce qui va bouger. */
  const demander = () => {
    const refus = refusReallocation({
      sourceId, cibleId, montant: Number.isFinite(valeur) ? valeur : null, motif,
      source: source ? { envelopeId, parentId: null, alloue: source.alloue, cessible: source.cessible, nom: source.nom } : null,
      cible: cible ? { envelopeId, parentId: null } : null,
    });
    if (refus || !source || !cible) { setErreur(refus ?? "Catégorie introuvable."); return; }
    setErreur(null);
    setConfirmation({
      titre: "Confirmer la réallocation ?",
      corps: (
        <div className="grid gap-1.5">
          <p><b className="tabular-nums">{fmt(valeur)} DZD</b> passent de « {source.nom} » à « {cible.nom} ». L&apos;enveloppe ne change pas.</p>
          <p className="text-xs text-muted-foreground tabular-nums">{source.nom} : {fmt(source.alloue)} → {fmt(source.alloue - valeur)} · {cible.nom} : {fmt(cible.alloue)} → {fmt(cible.alloue + valeur)}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Motif : {motif.trim()}</p>
        </div>
      ),
      bouton: "Réallouer",
      ok: envoyer,
    });
  };

  const occupe = envoi || rafraichit;
  return (
    <>
      <Sheet
        open={ouverte}
        onClose={onClose}
        title={cible ? `Réallouer vers « ${cible.nom} »` : "Réallouer"}
        description="Un montant passe d'une catégorie à une autre de la même enveloppe ; l'enveloppe ne change pas."
        footer={(
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={occupe}>Annuler</Button>
            <Button type="button" onClick={demander} disabled={occupe}>
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Réallouer…
            </Button>
          </div>
        )}
      >
        <div className="grid grid-cols-1 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="re-source" className="inline-flex items-center gap-1">
              Depuis
              <InfoBulle label="À propos de ce qu'une catégorie peut céder">Ce qui reste libre de son allocation au-dessus de son payé et de son engagé (sous-catégories comprises) et de ce que ses sous-catégories répartissent.</InfoBulle>
            </Label>
            <Select id="re-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Choisir la catégorie qui cède…</option>
              {tetes.filter((l) => l.id !== cibleId).map((l) => (
                <option key={l.id} value={l.id} disabled={l.cessible <= 0.5}>{l.nom} · {fmt(l.cessible)} cessibles</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="re-cible">Vers</Label>
            <Select id="re-cible" value={cibleId} onChange={(e) => setCibleId(e.target.value)}>
              <option value="">Choisir la catégorie qui reçoit…</option>
              {tetes.filter((l) => l.id !== sourceId).map((l) => (
                <option key={l.id} value={l.id}>{l.nom} — reste {fmt(l.reste)}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="re-montant">Montant (DZD)</Label>
            <Input id="re-montant" inputMode="decimal" value={montant} onChange={(e) => setMontant(e.target.value)} placeholder="0" />
            {cible && besoin > 0.5 && <p className="text-xs text-muted-foreground tabular-nums">Dépassement à couvrir : {fmt(besoin)} DZD</p>}
            {source && Number.isFinite(valeur) && valeur > 0 && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {source.nom} : alloué {fmt(source.alloue)} → {fmt(source.alloue - valeur)}
                {cible ? ` · ${cible.nom} : ${fmt(cible.alloue)} → ${fmt(cible.alloue + valeur)}` : ""}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="re-motif" className="inline-flex items-center gap-1">
              Motif
              <InfoBulle label="À propos du motif">Obligatoire ({MOTIF_MIN} caractères au moins). Il reste dans l&apos;historique du budget avec votre nom et la date.</InfoBulle>
            </Label>
            <Textarea id="re-motif" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex. AIDS 2026 plus cher que prévu" />
          </div>
          {erreur && <p className="text-sm text-destructive" role="alert">{erreur}</p>}
        </div>
      </Sheet>
      {confirmation && <FenetreConfirmation c={confirmation} occupe={occupe} onFermer={() => setConfirmation(null)} />}
    </>
  );
}
