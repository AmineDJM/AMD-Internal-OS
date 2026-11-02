"use client";

import * as React from "react";
import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { basculerEnrichissement, lancerPassageEnrichissement, relancerTachesEnEchec } from "@/lib/actions/enrichissement-actions";
import type { EtatFile } from "@/lib/enrichissement/lectures";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUTS: { cle: keyof EtatFile["parStatut"]; libelle: string }[] = [
  { cle: "A_FAIRE", libelle: "À faire" }, { cle: "EN_COURS", libelle: "En cours" }, { cle: "FAITE", libelle: "Faites" },
  { cle: "IGNOREE", libelle: "Ignorées" }, { cle: "ECHEC", libelle: "En échec" },
];

/** L'INTERRUPTEUR ET LA FILE DE L'ENRICHISSEMENT — ce que le Super Admin ouvre, voit et relance. */
export function PanneauEnrichissement({ etat }: { etat: EtatFile }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState(false);
  const pending = occupe || enCours;
  const [message, setMessage] = React.useState<string | null>(null);
  const agir = (geste: () => Promise<{ ok: boolean; message: string }>) => void (async () => {
    setOccupe(true);
    try {
      const r = await geste();
      setMessage(r.message);
      rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(false);
    }
  })();

  return (
    <Card data-testid="panneau-enrichissement">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Enrichissement des fiches par les pièces déposées
          <Badge tone={etat.actif ? "success" : "neutral"}>{etat.actif ? "Ouvert" : "Fermé"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Chaque pièce déposée (Drive, documents des modules) est lue sur ce serveur, classée, et ses faits sont proposés aux fiches
          Personne et Organisation ; les numéros de pièce d&apos;identité, RIB et salaires vont au coffre. Aucune pièce ne part vers un modèle externe.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={etat.actif ? "outline" : "primary"} disabled={pending} onClick={() => agir(() => basculerEnrichissement(!etat.actif))}>
            {etat.actif ? "Fermer l'enrichissement" : "Ouvrir l'enrichissement"}
          </Button>
          <Button size="sm" variant="outline" disabled={pending || !etat.actif} onClick={() => agir(lancerPassageEnrichissement)}>Traiter la file maintenant</Button>
          {etat.parStatut.ECHEC > 0 && <Button size="sm" variant="outline" disabled={pending} onClick={() => agir(relancerTachesEnEchec)}>Relancer les échecs</Button>}
          <Link href="/a-confirmer"><Button size="sm" variant="ghost">Faits à confirmer</Button></Link>
        </div>
        <div className="flex flex-wrap gap-3">
          {STATUTS.map((s) => <span key={s.cle}>{s.libelle} : <strong>{etat.parStatut[s.cle]}</strong></span>)}
        </div>
        <div className="flex flex-wrap gap-3 text-muted-foreground">
          <span>À confirmer : {etat.faits.aConfirmer}</span>
          <span>Conflits ouverts : {etat.faits.conflits}</span>
          <span>Confirmés d&apos;office : {etat.faits.confirmesDOffice}</span>
          <span>Au coffre : {etat.faits.auCoffre}</span>
          <span>Sans fiche : {etat.faits.sansSujet}</span>
        </div>
        {etat.echecs.length > 0 && (
          <ul className="space-y-1 text-xs">
            {etat.echecs.map((e) => <li key={e.id}>« {e.nomFichier} » — {e.tentatives} essai(s) : {e.erreur ?? "erreur non dite"}</li>)}
          </ul>
        )}
        {message && <p className="text-xs text-muted-foreground" data-testid="enrichissement-message">{message}</p>}
      </CardContent>
    </Card>
  );
}
