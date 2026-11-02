"use client";

import * as React from "react";
import Link from "next/link";
import { FilePen, Loader2, ExternalLink, Undo2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { useAction } from "@/components/shared/use-action";
import { signerBonDeCommande, renvoyerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { LIBELLE_CENTRE_BC } from "@/lib/bons-de-commande/regle";
import type { LigneBCFinances } from "@/lib/queries/bons-de-commande";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { ancreBonDeCommande } from "@/lib/chemins/bons-de-commande";

/**
 * LA FILE DES SIGNATAIRES — chaque BC avec ce qu'il faut pour le signer en connaissance de cause :
 * la pièce elle-même (on signe ce qu'on a LU, §104.7), la partie en face, le montant, et
 * POURQUOI il est là — validé par tel centre, ou sous le seuil. Un BC sans cette raison se lirait
 * comme un BC qui a sauté la validation.
 *
 * Le module de la règle (`regle.ts`) n'importe rien : l'afficher côté navigateur ne tire aucune
 * dépendance serveur (CLAUDE.md, frontière client / serveur).
 */
export function FileBonsDeCommande({
  aSigner, renvoyes, signes, peutSigner, refus, tronquee, bcAOuvrir,
}: {
  aSigner: LigneBCFinances[];
  renvoyes: LigneBCFinances[];
  signes: LigneBCFinances[];
  peutSigner: boolean;
  refus: string | null;
  tronquee: boolean;
  /** Le BC dont parle la notification (`?bc=`) : sa ligne vient sous les yeux et s'entoure. */
  bcAOuvrir?: string | null;
}) {
  return (
    <div className="space-y-5">
      <SurlignerCible ids={[bcAOuvrir ? ancreBonDeCommande(bcAOuvrir) : null]} />
      <Card>
        <CardHeader>
          <CardTitle>À signer</CardTitle>
          <CardDescription>
            {aSigner.length === 0
              ? "Aucun bon de commande n'attend votre signature."
              : `${aSigner.length} bon(s) de commande, le plus ancien en tête : c'est lui qui retient une commande.`}
            {refus ? ` ${refus}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {aSigner.length === 0 ? (
            <EmptyState
              icon="FilePen"
              title="Rien à signer"
              description="Un bon de commande arrive ici une fois validé par son centre de validation, ou directement s'il est sous le seuil de validation."
            />
          ) : (
            <ul className="space-y-3">
              {aSigner.map((l) => <LigneASigner key={l.id} ligne={l} peutSigner={peutSigner} />)}
            </ul>
          )}
          {tronquee && (
            <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground">
              La file a été bornée aux 200 bons de commande en cours les plus anciens : d&apos;autres existent, ils apparaîtront à mesure que ceux-ci seront signés.
            </p>
          )}
        </CardContent>
      </Card>

      {/* CE QUI A ÉTÉ RENVOYÉ À SON ÉMETTEUR (audit 360°, R09) : sorti de la file, pas perdu de vue —
          avec ce qui a été demandé. Il revient « à signer » dès que la pièce est modifiée. */}
      {renvoyes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Renvoyés à l&apos;émetteur</CardTitle>
            <CardDescription>Ils reviennent dans la file « À signer » dès que leur émetteur les a modifiés.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {renvoyes.map((l) => (
                <li key={l.id} id={ancreBonDeCommande(l.id)} className="space-y-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">
                      <Link href={`/legal/${l.id}`} className="font-medium hover:underline">{l.reference ?? l.title}</Link>
                      {l.counterparty ? <span className="text-muted-foreground"> — {l.counterparty}</span> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {montant(l.montant)}{l.renvoi ? ` · renvoyé le ${new Date(l.renvoi.le).toLocaleDateString("fr-FR")}${l.renvoi.par ? ` par ${l.renvoi.par}` : ""}` : ""}
                    </span>
                  </div>
                  {l.renvoi?.note && <p className="text-xs [overflow-wrap:anywhere]">À corriger : « {l.renvoi.note} »</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Signés récemment</CardTitle>
          <CardDescription>Les derniers bons de commande signés — ils peuvent partir chez le fournisseur.</CardDescription>
        </CardHeader>
        <CardContent>
          {signes.length === 0 ? (
            <EmptyState icon="CircleCheck" title="Aucune signature pour l'instant" />
          ) : (
            <ul className="divide-y divide-border">
              {signes.map((l) => (
                <li key={l.id} id={ancreBonDeCommande(l.id)} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">
                    <Link href={`/legal/${l.id}`} className="font-medium hover:underline">{l.reference ?? l.title}</Link>
                    {l.counterparty ? <span className="text-muted-foreground"> — {l.counterparty}</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {montant(l.montant)} · signé {l.signeLe ? `le ${new Date(l.signeLe).toLocaleDateString("fr-FR")}` : ""}
                    {l.signePar ? ` par ${l.signePar}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const montant = (m: number | null) => (m != null && m > 0 ? `${m.toLocaleString("fr-FR")} DZD` : "montant non renseigné");

/** POURQUOI ce BC est à signer : validé par un centre, ou sous le seuil — jamais laissé implicite. */
function raison(l: LigneBCFinances): string {
  if (l.porte?.etat === "VALIDE") {
    return l.porte.source === "POSTE"
      ? "Poste Ad & Pro validé par le centre de validation Ad & Pro"
      : `Validé par le ${LIBELLE_CENTRE_BC[l.porte.centre]}`;
  }
  return "Sous le seuil de validation — aucun centre n'avait à le valider";
}

function LigneASigner({ ligne: l, peutSigner }: { ligne: LigneBCFinances; peutSigner: boolean }) {
  const { saving, err, run } = useAction();
  const [fait, setFait] = React.useState<string | null>(null);
  // RENVOYER AU LIEU DE SIGNER (audit 360°, R09) : le motif est exigé, à l'écran comme à l'action.
  const [renvoi, setRenvoi] = React.useState<string | null>(null);
  // LE BC SIGNÉ SUR PAPIER (Direction, 06/10) : la copie signée et le nom du signataire sont exigés.
  const [signataire, setSignataire] = React.useState("");
  const [copie, setCopie] = React.useState<File | null>(null);
  const jours = Math.floor((Date.now() - new Date(l.creeLe).getTime()) / 86_400_000);
  return (
    <li id={ancreBonDeCommande(l.id)} className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-medium [overflow-wrap:anywhere] sm:truncate">
            {l.reference ? `${l.reference} — ` : ""}{l.title}
          </p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {l.counterparty ?? "Fournisseur non renseigné"}{l.societe ? ` · ${l.societe}` : ""}
            {l.creePar ? ` · établi par ${l.creePar}` : ""}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="whitespace-nowrap font-semibold tabular-nums">{montant(l.montant)}</p>
          <p className="text-xs text-muted-foreground">{jours <= 0 ? "aujourd'hui" : `il y a ${jours} j`}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={l.porte ? "success" : "info"} dot={false}>{raison(l)}</Badge>
        {l.porte?.note ? <span className="text-xs text-muted-foreground">« {l.porte.note} »</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/legal/${l.id}`} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Ouvrir la fiche
        </Link>
        {/* LIRE AVANT DE SIGNER. Le fichier émis vit dans le Drive personnel de celui qui a émis le
            BC : l'ouvrir par le Drive répondait 403 aux Finances. Il s'ouvre sous la porte de la
            PIÈCE ; un fichier rattaché à la main garde la porte du Drive (§118.152). */}
        {/* LE PDF, ET LUI SEUL (Direction, 11/2026) : le signataire télécharge le BC en PDF, le signe et dépose la version signée. */}
        {l.fichiers.pdf ? (
          <a href={lienFichierEmis(l.id, "pdf", true)} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary">
            Télécharger le PDF
          </a>
        ) : l.driveNodeId ? (
          <a href={`/api/drive/${l.driveNodeId}/raw`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary">
            Lire la pièce
          </a>
        ) : null}
      </div>
      {peutSigner && !fait && renvoi === null && (
        <div className="grid grid-cols-1 gap-2 rounded-lg bg-secondary/40 p-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium text-foreground">BC signé (scan ou photo) — obligatoire</span>
            <input
              type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" aria-label="Bon de commande signé"
              onChange={(e) => setCopie(e.target.files?.[0] ?? null)} className="block w-full text-xs"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-foreground">Signé par — obligatoire</span>
            <Input value={signataire} onChange={(e) => setSignataire(e.target.value)} placeholder="Nom et fonction du signataire" aria-label="Signataire" />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Luna regarde le bas de la copie : sans signature repérée, rien n&apos;est enregistré. La copie signée remplace le BC non signé dans Ad &amp; Pro, et la facture peut alors être déposée.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {peutSigner && !fait && renvoi === null && (
          <BoutonDecisif
            size="sm" className="h-11 w-full text-sm sm:h-8 sm:w-auto sm:text-xs" disabled={saving || !copie || !signataire.trim()}
            onClick={() => {
              const fd = new FormData();
              fd.set("id", l.id);
              fd.set("signataire", signataire.trim());
              if (copie) fd.set("copieSignee", copie);
              void run(async () => {
                const r = await signerBonDeCommande(fd);
                if (r.ok) setFait(r.message ?? "Signé.");
                return r;
              });
            }}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePen className="h-4 w-4" />}
            Enregistrer le BC signé
          </BoutonDecisif>
        )}
        {peutSigner && !fait && renvoi === null && (
          <Button size="sm" variant="secondary" className="w-full sm:w-auto" disabled={saving} onClick={() => setRenvoi("")}>
            <Undo2 className="h-4 w-4" /> Renvoyer à l&apos;émetteur
          </Button>
        )}
      </div>
      {peutSigner && !fait && renvoi !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={renvoi} onChange={(e) => setRenvoi(e.target.value)} aria-label="Ce qu'il faut corriger"
            placeholder="Ce qu'il faut corriger (obligatoire)" className="min-w-0 flex-1 basis-full sm:basis-auto"
          />
          <BoutonDecisif
            size="sm" variant="secondary" disabled={saving || !renvoi.trim()}
            onClick={() => {
              const fd = new FormData();
              fd.set("id", l.id);
              fd.set("note", renvoi);
              void run(async () => {
                const r = await renvoyerBonDeCommande(fd);
                if (r.ok) setFait(r.message ?? "Renvoyé.");
                return r;
              });
            }}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Confirmer le renvoi
          </BoutonDecisif>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setRenvoi(null)}>Annuler</Button>
        </div>
      )}
      {fait && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground">{fait}</p>}
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </li>
  );
}
