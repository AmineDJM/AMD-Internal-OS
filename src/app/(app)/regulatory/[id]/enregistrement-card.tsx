"use client";

import * as React from "react";
import Link from "next/link";
import { FileUp, RefreshCw, Sparkles } from "lucide-react";
import {
  joindrePieceEnregistrement, relirePieceEnregistrement, confirmerValiditeEnregistrement, confirmerPrixAttestation,
} from "@/lib/actions/regulatory-validite-actions";
import { useKeyedAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Retour } from "@/components/ui/retour";
import { TextField } from "@/components/shared/form-fields";
import { LIBELLE_SOURCE_DATE, STATUT_VALIDITE, estSourceDate, type StatutValidite } from "@/lib/regulatory/validite-enregistrement";
import { LIBELLE_PRIX } from "@/lib/products/fiche-360";
import type { ChampPropose, LecturesEnregistrement, NaturePieceEnregistrement } from "@/lib/regulatory/decision-lue";

/**
 * LA DÉCISION D'ENREGISTREMENT DU DOSSIER (Super Admin, 24/11/2026) — sa validité (5 ans), ses deux pièces,
 * ce que l'IA y a lu, et le renouvellement.
 *
 * Joindre une pièce la fait lire ; ce que l'IA propose s'affiche DANS les champs, avec la phrase du document
 * qui le dit. Un clic confirme ; tout reste modifiable. L'IA coupée ou en échec ne bloque rien : les champs
 * restent ouverts à la saisie.
 */

export interface ValiditeVue {
  numero: string | null;
  dateDecision: string | null;
  debut: string | null;
  fin: string | null;
  sources: { decision: string | null; debut: string | null; fin: string | null };
  statut: StatutValidite | null;
  confirmeLe: string | null;
}

export interface PieceVue { id: string; name: string; nature: NaturePieceEnregistrement }

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.docx";

function Source({ propose, confirmee }: { propose: ChampPropose<unknown> | null | undefined; confirmee: string | null }) {
  if (propose) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {LIBELLE_SOURCE_DATE[propose.source]}{propose.extrait ? <> — <q className="italic">{propose.extrait}</q></> : null}
      </p>
    );
  }
  if (confirmee && estSourceDate(confirmee)) return <p className="mt-1 text-xs text-muted-foreground">{LIBELLE_SOURCE_DATE[confirmee]}</p>;
  return null;
}

export function EnregistrementCard({
  productId, validite, lectures, pieces, canUpload, canUpdate, aUnProduit, renouvelerHref,
}: {
  productId: string;
  validite: ValiditeVue;
  lectures: LecturesEnregistrement;
  pieces: PieceVue[];
  canUpload: boolean;
  canUpdate: boolean;
  aUnProduit: boolean;
  renouvelerHref: string | null;
}) {
  const { busy, error, run } = useKeyedAction();
  const fichierDecision = React.useRef<HTMLInputElement>(null);
  const fichierPrix = React.useRef<HTMLInputElement>(null);
  const dec = lectures.decision ?? null;
  const prix = lectures.prix ?? null;
  const statut = validite.statut ? STATUT_VALIDITE[validite.statut] : null;

  const joindre = (nature: NaturePieceEnregistrement, input: HTMLInputElement | null) => {
    const f = input?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set("productId", productId); fd.set("nature", nature); fd.set("file", f);
    void run(`joindre-${nature}`, () => joindrePieceEnregistrement(fd)).finally(() => { if (input) input.value = ""; });
  };
  const relire = (p: PieceVue) => {
    const fd = new FormData();
    fd.set("productId", productId); fd.set("documentId", p.id); fd.set("nature", p.nature);
    void run(`relire-${p.id}`, () => relirePieceEnregistrement(fd));
  };
  const confirmerDates = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("productId", productId);
    void run("dates", () => confirmerValiditeEnregistrement(fd), { succes: "Décision d'enregistrement confirmée." });
  };
  const confirmerPrix = (e: React.FormEvent<HTMLFormElement>, type: string) => {
    e.preventDefault();
    const lu = new FormData(e.currentTarget);
    const fd = new FormData();
    fd.set("productId", productId); fd.set("kind", type);
    fd.set("amountDzd", String(lu.get(`montant-${type}`) ?? "")); fd.set("validFrom", String(lu.get(`depuis-${type}`) ?? ""));
    void run(`prix-${type}`, () => confirmerPrixAttestation(fd), { succes: "Prix enregistré sur le produit." });
  };

  // Les champs reprennent la proposition en attente, sinon les valeurs confirmées. La clé force leur remise
  // à zéro quand une nouvelle lecture arrive (champs non contrôlés).
  const v = {
    numero: dec?.numero?.valeur ?? validite.numero ?? "",
    dateDecision: dec?.dateDecision?.valeur ?? validite.dateDecision ?? "",
    debut: dec?.debut?.valeur ?? validite.debut ?? "",
    fin: dec?.fin?.valeur ?? validite.fin ?? "",
  };

  return (
    <Card id="enregistrement">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Décision d&apos;enregistrement</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {statut && <Badge tone={statut.tone}>{statut.label}</Badge>}
          {renouvelerHref && (
            <Link href={renouvelerHref} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              <RefreshCw className="h-3.5 w-3.5" /> Lancer le renouvellement
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Retour>{error}</Retour>}

        {canUpload && (
          <div className="flex flex-wrap gap-2">
            <input ref={fichierDecision} type="file" accept={ACCEPT} className="hidden" onChange={(e) => joindre("DECISION", e.currentTarget)} />
            <input ref={fichierPrix} type="file" accept={ACCEPT} className="hidden" onChange={(e) => joindre("PRIX", e.currentTarget)} />
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fichierDecision.current?.click()}>
              <FileUp className="h-4 w-4" /> {busy === "joindre-DECISION" ? "Lecture en cours…" : "Joindre la décision"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fichierPrix.current?.click()}>
              <FileUp className="h-4 w-4" /> {busy === "joindre-PRIX" ? "Lecture en cours…" : "Joindre l'attestation de prix"}
            </Button>
          </div>
        )}

        {pieces.length > 0 && (
          <ul className="space-y-1 text-sm">
            {pieces.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{p.nature === "DECISION" ? "Décision" : "Attestation"}</span>
                <span className="min-w-0 break-all">{p.name}</span>
                {canUpdate && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => relire(p)}>
                    <Sparkles className="h-3.5 w-3.5" /> {busy === `relire-${p.id}` ? "Lecture…" : "Faire lire"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {dec && (dec.erreur
          ? <Retour ton="alerte">{dec.erreur}</Retour>
          : <Retour ton="info">{`Lu par l'IA dans « ${dec.nomFichier} » (${dec.methode}) : vérifiez puis confirmez.`}</Retour>)}

        <form key={dec?.luLe ?? validite.confirmeLe ?? "vide"} onSubmit={confirmerDates} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <TextField label="N° de la décision" name="numero" defaultValue={v.numero} />
              <Source propose={dec?.numero} confirmee={null} />
            </div>
            <div>
              <TextField label="Date de la décision" name="dateDecision" type="date" defaultValue={v.dateDecision} />
              <Source propose={dec?.dateDecision} confirmee={validite.sources.decision} />
            </div>
            <div>
              <TextField label="Début de validité" name="debut" type="date" defaultValue={v.debut} />
              <Source propose={dec?.debut} confirmee={validite.sources.debut} />
            </div>
            <div>
              <TextField label="Fin de validité" name="fin" type="date" defaultValue={v.fin} hint="Vide : début + 5 ans." />
              <Source propose={dec?.fin} confirmee={validite.sources.fin} />
            </div>
          </div>
          {canUpdate && (
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={busy !== null}>{busy === "dates" ? "Enregistrement…" : "Confirmer"}</Button>
            </div>
          )}
        </form>

        {prix && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">Attestation de prix — « {prix.nomFichier} »</p>
            {prix.erreur && <Retour ton="alerte">{prix.erreur}</Retour>}
            {!aUnProduit && prix.prix.length > 0 && <Retour ton="alerte">Créez d&apos;abord le produit du dossier (en-tête), puis confirmez le prix.</Retour>}
            {prix.prix.map((l) => (
              <form key={`${prix.luLe}-${l.type}`} onSubmit={(e) => confirmerPrix(e, l.type)} className="space-y-1">
                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
                  <TextField label={`${LIBELLE_PRIX[l.type]} (DZD)`} name={`montant-${l.type}`} defaultValue={String(l.valeur)} inputMode="decimal" />
                  <TextField label="À compter du" name={`depuis-${l.type}`} type="date" defaultValue={prix.date?.valeur ?? ""} />
                  {canUpdate && aUnProduit && (
                    <Button type="submit" size="sm" disabled={busy !== null}>{busy === `prix-${l.type}` ? "Enregistrement…" : "Confirmer le prix"}</Button>
                  )}
                </div>
                <Source propose={l} confirmee={null} />
              </form>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
