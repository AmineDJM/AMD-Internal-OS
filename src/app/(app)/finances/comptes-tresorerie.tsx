"use client";

import * as React from "react";
import { Landmark, Loader2, AlertCircle, Trash2, Pencil, Anchor, Plus } from "lucide-react";
import {
  setTreasuryOpeningBalance, modifierCompteTresorerie, corrigerAncrageTresorerie, deleteTreasuryAccount,
} from "@/modules/finances/actions-tresorerie";
import type { ActionResult } from "@/lib/actions/types";
import type { CompteLu } from "@/modules/finances/api";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { TextField, TextAreaField, SelectField } from "@/components/shared/form-fields";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { formatCurrency } from "@/lib/utils";

/**
 * LES COMPTES DE TRÉSORERIE ANCRÉS (§118.176) — « SGA Birkhadem, compte Adventum, 2 966 153 DZD au
 * 28 sept. 2026 ».
 *
 * Un compte s'OUVRE une fois, ancré à un relevé (un solde, une date, en fin de journée). Ensuite il
 * se MODIFIE (nom, banque, RIB, entité, principal, notes) sans jamais toucher à l'ancrage, et
 * l'ancrage se CORRIGE à part, avec un motif. L'ancien écran faisait tout par un seul formulaire
 * qui réécrivait l'ouverture en silence : on ne savait plus d'où partait le solde affiché.
 *
 * Un seul formulaire est ouvert à la fois : deux formulaires côte à côte porteraient les mêmes noms
 * de champs, donc les mêmes identifiants, et un libellé désignerait le champ de l'autre.
 */

type Mode = { type: "liste" } | { type: "ouvrir" } | { type: "modifier"; compte: CompteLu } | { type: "ancrage"; compte: CompteLu };

const jour = (iso: string) => {
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

export function ComptesTresorerieButton({ comptes, entites, canUpdate }: {
  comptes: CompteLu[];
  entites: { value: string; label: string }[];
  canUpdate: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>({ type: "liste" });
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [occupe, setOccupe] = React.useState(false);
  const { enCours, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  // Tant que l'écran n'a pas reçu l'état écrit, ses gestes restent fermés : une fiche ouverte sur
  // l'état d'avant réécrirait l'ancien ancrage par-dessus le nouveau (§118.172).
  const bloque = occupe || enCours;

  const executer = async (fn: () => Promise<ActionResult>) => {
    setOccupe(true);
    setErreur(null);
    setMessage(null);
    try {
      const r = await fn();
      if (!r.ok) { setErreur(r.error ?? "L'opération a été refusée."); return; }
      setMessage(r.message ?? "Enregistré.");
      setMode({ type: "liste" });
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(false);
    }
  };

  const total = comptes.reduce((t, c) => t + c.solde, 0);

  return (
    <>
      <Button variant="outline" onClick={() => { setOpen(true); setMode({ type: "liste" }); setErreur(null); setMessage(null); }}>
        <Landmark className="h-4 w-4" /> Comptes de trésorerie
      </Button>

      <Sheet
        open={open}
        onClose={() => { setOpen(false); setMode({ type: "liste" }); }}
        title="Comptes de trésorerie"
        description="Chaque compte part d'un relevé : son solde à une date, en fin de journée. Le solde actuel = ce relevé + les écritures réglées postérieures."
        width="md"
      >
        <div className="space-y-5">
          {message && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success" role="status">{message}</p>}
          {erreur && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              <AlertCircle className="h-4 w-4 shrink-0" /> {erreur}
            </div>
          )}

          {mode.type === "liste" && (
            <>
              {comptes.length === 0 ? (
                <p className="surface p-4 text-sm text-muted-foreground">
                  Aucun compte ancré : la trésorerie ne se calcule pas encore. Ouvrez un compte avec le solde d&apos;un relevé.
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                    <span className="font-medium">{comptes.length} compte(s)</span>
                    <span className="text-muted-foreground">Total : <strong className="tabular-nums text-foreground">{formatCurrency(total)}</strong></span>
                  </div>
                  <ul className="divide-y rounded-lg border">
                    {comptes.map((c) => (
                      <li key={c.id} className="space-y-1.5 px-3 py-2.5" data-compte={c.nom}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {c.nom} {c.principal && <Badge tone="info" dot={false}>Principal</Badge>}
                            </p>
                            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                              {[c.banque, c.rib ? `RIB ${c.rib}` : null, c.societe].filter(Boolean).join(" · ") || "—"}
                            </p>
                          </div>
                          <span className={`shrink-0 font-semibold tabular-nums ${c.solde >= 0 ? "text-foreground" : "text-destructive"}`}>{formatCurrency(c.solde)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Ancré à {formatCurrency(c.ancrage)} au {jour(c.jourAncrage)} (fin de journée)
                          {c.nombreMouvements > 0 ? ` · ${c.mouvements >= 0 ? "+" : "−"} ${formatCurrency(Math.abs(c.mouvements))} depuis (${c.nombreMouvements} écriture(s))` : " · aucune écriture depuis"}
                        </p>
                        {canUpdate && (
                          <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="ghost" disabled={bloque} onClick={() => { setErreur(null); setMode({ type: "modifier", compte: c }); }}>
                              <Pencil className="h-3.5 w-3.5" /> Modifier
                            </Button>
                            <Button size="sm" variant="ghost" disabled={bloque} onClick={() => { setErreur(null); setMode({ type: "ancrage", compte: c }); }}>
                              <Anchor className="h-3.5 w-3.5" /> Corriger l&apos;ancrage
                            </Button>
                            <Button
                              size="sm" variant="ghost" disabled={bloque} aria-label={`Supprimer le compte ${c.nom}`}
                              onClick={async () => {
                                if (!(await confirmer(`Supprimer le compte « ${c.nom} » ? Refusé si des écritures le nomment.`))) return;
                                const fd = new FormData();
                                fd.set("id", c.id);
                                void executer(() => deleteTreasuryAccount(fd));
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Supprimer
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canUpdate && (
                <Button disabled={bloque} onClick={() => { setErreur(null); setMode({ type: "ouvrir" }); }}>
                  <Plus className="h-4 w-4" /> Ouvrir un compte
                </Button>
              )}
            </>
          )}

          {mode.type === "ouvrir" && (
            <form
              className="space-y-4"
              action={(fd) => { void executer(() => setTreasuryOpeningBalance(undefined, fd)); }}
            >
              <p className="text-sm font-medium">Ouvrir un compte — ancré à un relevé</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Nom du compte" name="name" required placeholder="SGA Birkhadem — Adventum" className="sm:col-span-2" />
                <TextField label="Banque / agence" name="bank" placeholder="SGA Birkhadem" />
                <TextField label="RIB" name="rib" placeholder="20 chiffres" />
                <TextField label="Solde du relevé (DZD)" name="openingBalance" type="number" step="any" required placeholder="2966153" />
                <TextField label="Date du relevé" name="openingDate" type="date" required hint="Le solde s'entend en fin de cette journée." />
                <SelectField label="Entité titulaire" name="companyId" options={entites} placeholder="— Aucune —" className="sm:col-span-2" />
              </div>
              <CasePrincipal defaultChecked={false} />
              <TextAreaField label="Notes" name="notes" placeholder="Ex. relevé du 28/09/2026" />
              <BarreActions occupe={occupe} libelle="Ouvrir le compte" onAnnuler={() => setMode({ type: "liste" })} />
            </form>
          )}

          {mode.type === "modifier" && (
            <form
              className="space-y-4"
              action={(fd) => { fd.set("id", mode.compte.id); void executer(() => modifierCompteTresorerie(fd)); }}
            >
              <p className="text-sm font-medium">Modifier « {mode.compte.nom} » — l&apos;ancrage ne se change pas ici</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Nom du compte" name="name" required defaultValue={mode.compte.nom} className="sm:col-span-2" />
                <TextField label="Banque / agence" name="bank" defaultValue={mode.compte.banque ?? ""} />
                <TextField label="RIB" name="rib" defaultValue={mode.compte.rib ?? ""} />
                <SelectField label="Entité titulaire" name="companyId" options={entites} defaultValue={mode.compte.societeId ?? ""} placeholder="— Aucune —" className="sm:col-span-2" />
              </div>
              <CasePrincipal defaultChecked={mode.compte.principal} />
              <TextAreaField label="Notes" name="notes" defaultValue={mode.compte.notes ?? ""} />
              <BarreActions occupe={occupe} libelle="Enregistrer" onAnnuler={() => setMode({ type: "liste" })} />
            </form>
          )}

          {mode.type === "ancrage" && (
            <form
              className="space-y-4"
              action={(fd) => { fd.set("id", mode.compte.id); void executer(() => corrigerAncrageTresorerie(fd)); }}
            >
              <p className="text-sm font-medium">Corriger l&apos;ancrage de « {mode.compte.nom} »</p>
              <p className="text-xs text-muted-foreground">
                Actuel : {formatCurrency(mode.compte.ancrage)} au {jour(mode.compte.jourAncrage)}. Tous les soldes de ce compte en découlent :
                la correction est tracée, avec son motif.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Solde du relevé (DZD)" name="openingBalance" type="number" step="any" required defaultValue={mode.compte.ancrage} />
                <TextField label="Date du relevé" name="openingDate" type="date" required defaultValue={mode.compte.jourAncrage} />
              </div>
              <TextAreaField label="Motif de la correction" name="motif" required placeholder="Ex. relevé du 28/09 reçu, l'ancien chiffre était provisoire" />
              <BarreActions occupe={occupe} libelle="Corriger l'ancrage" onAnnuler={() => setMode({ type: "liste" })} />
            </form>
          )}
        </div>
      </Sheet>
    </>
  );
}

/** La case « compte principal », avec son témoin : décochée, elle doit pouvoir DIRE non (§118.172). */
function CasePrincipal({ defaultChecked }: { defaultChecked: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="hidden" name="principal" value="off" />
      <input type="checkbox" name="principal" defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Compte principal de son entité
        <span className="block text-xs text-muted-foreground">Les paiements de l&apos;entité partent de ce compte quand ils n&apos;en nomment pas un autre. Un seul par entité.</span>
      </span>
    </label>
  );
}

function BarreActions({ occupe, libelle, onAnnuler }: { occupe: boolean; libelle: string; onAnnuler: () => void }) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onAnnuler} disabled={occupe}>Annuler</Button>
      <Button type="submit" className="w-full sm:w-auto" disabled={occupe}>
        {occupe && <Loader2 className="h-4 w-4 animate-spin" />}
        {libelle}
      </Button>
    </div>
  );
}
