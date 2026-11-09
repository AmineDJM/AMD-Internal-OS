"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, FileText, Loader2, Paperclip, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { PAYMENT_PIECE_KIND, PAYMENT_PIECE_KIND_OPTIONS, PAYMENT_PIECE_STATUS, PAYMENT_REQUEST_STATUS } from "@/lib/labels";
import { mesDemandesDePaiementEnCours } from "@/modules/finances/actions-pieces-paiement";
import { addPaymentPiece } from "@/modules/finances/actions-demandes";
import type { DemandeEnCours, FichierEnCours } from "@/modules/finances/partage";
import { sansBloquer } from "@/lib/journal";

/**
 * « VOS DEMANDES EN COURS » — en tête de « Demander un paiement » (Direction, 09/11/2026 : « quand il ajoute une demande,
 * il voit ses demandes précédentes et peut les modifier, en changeant les fichiers ou en en ajoutant »).
 *
 * La personne qui revient avec la facture d'une demande déjà faite l'ajoutait jusqu'ici dans une SECONDE demande : le même
 * paiement demandé deux fois, et le premier dossier resté incomplet. Ses demandes non terminées sont rappelées ici, avec :
 *   • leurs FICHIERS, chacun avec « Remplacer » — là où l'action l'accepterait (`refusDeRemplacement` : jusqu'à l'ouverture
 *     de l'examen par les Finances, puis seulement le fichier qu'elles signalent) ;
 *   • « Ajouter un fichier » — la pièce rejoint la demande qui existe (`addPaymentPiece`, mêmes gardes que sa page) ;
 *   • « Ouvrir » — la page de la demande, pour corriger ses informations.
 */

/** Ce qui est ouvert sous une demande : l'ajout d'un fichier, ou le remplacement de l'un d'eux. */
type Depot = { demandeId: string; remplace: FichierEnCours | null };

export function MesDemandesEnCours() {
  const [demandes, setDemandes] = React.useState<DemandeEnCours[] | null>(null);
  const [depot, setDepot] = React.useState<Depot | null>(null);

  const charger = React.useCallback(() => {
    void mesDemandesDePaiementEnCours().then(setDemandes).catch(sansBloquer("mes-demandes-en-cours.charger"));
  }, []);
  React.useEffect(() => { charger(); }, [charger]);

  const basculer = (demandeId: string, remplace: FichierEnCours | null) =>
    setDepot((o) => (o && o.demandeId === demandeId && (o.remplace?.id ?? null) === (remplace?.id ?? null) ? null : { demandeId, remplace }));

  if (!demandes || demandes.length === 0) return null;
  return (
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label="Vos demandes en cours">
      <div>
        <p className="text-sm font-medium">Vos demandes en cours</p>
        <p className="text-xs text-muted-foreground">La facture ou la pièce concerne l&apos;une d&apos;elles ? Remplacez son fichier ou ajoutez-en un à cette demande, plutôt que d&apos;en créer une nouvelle.</p>
      </div>
      <ul className="divide-y divide-border">
        {demandes.map((d) => {
          const bloque = d.fichiers.find((f) => !f.remplacable)?.refus ?? null;
          return (
            <li key={d.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium"><span className="font-mono text-xs text-muted-foreground">{d.reference}</span> · {d.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.payee} · {formatCurrency(d.amount)} · {PAYMENT_REQUEST_STATUS[d.status]?.label ?? d.status} · {d.pieces} pièce{d.pieces > 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button type="button" size="sm" variant="outline" onClick={() => basculer(d.id, null)} aria-expanded={depot?.demandeId === d.id && !depot.remplace}>
                    <Paperclip className="h-3.5 w-3.5" /> Ajouter un fichier
                  </Button>
                  <Link href={`/validations/paiements/${d.id}`} className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-2.5 text-sm hover:bg-secondary">
                    Ouvrir <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>

              {d.fichiers.length > 0 && (
                <ul className="space-y-1 pl-1">
                  {d.fichiers.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a href={`/api/documents/${f.documentId}?dl=1`} className="min-w-0 flex-1 truncate font-medium hover:underline">{f.nom}</a>
                      <span className="text-muted-foreground">{PAYMENT_PIECE_KIND[f.kind] ?? f.kind} · {PAYMENT_PIECE_STATUS[f.status]?.label ?? f.status}</span>
                      {f.remplacable && (
                        <Button
                          type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                          onClick={() => basculer(d.id, f)} aria-expanded={depot?.remplace?.id === f.id}
                        >
                          <RefreshCw className="h-3 w-3" /> Remplacer
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {bloque && <p className="text-xs text-muted-foreground">{bloque}</p>}

              {depot?.demandeId === d.id && (
                <DepotFichier
                  key={depot.remplace?.id ?? "ajout"}
                  demande={d} remplace={depot.remplace}
                  onFait={() => { setDepot(null); charger(); }} onAnnuler={() => setDepot(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Joindre un fichier à une demande existante — ou REMPLACER l'un des siens (`replacesId`) : la demande le reçoit comme
 * depuis sa page, l'ancien fichier sort du décompte et reste dans l'historique.
 */
function DepotFichier({ demande, remplace, onFait, onAnnuler }: {
  demande: DemandeEnCours; remplace: FichierEnCours | null; onFait: () => void; onAnnuler: () => void;
}) {
  const [kind, setKind] = React.useState(remplace?.kind ?? "INVOICE");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const envoyer = async () => {
    if (!fichier) return;
    setBusy(true); setRetour(null);
    const fd = new FormData();
    fd.set("requestId", demande.id); fd.set("kind", kind); fd.set("note", ""); fd.set("file", fichier);
    if (remplace) fd.set("replacesId", remplace.id);
    try {
      const r = await addPaymentPiece(fd);
      if (r.ok) {
        setRetour({ ok: true, texte: remplace ? `« ${remplace.nom} » remplacé dans ${demande.reference}.` : `Fichier ajouté à ${demande.reference}.` });
        window.setTimeout(onFait, 1200);
      } else {
        setRetour({ ok: false, texte: r.error ?? (remplace ? "Le fichier n'a pas été remplacé." : "Le fichier n'a pas été ajouté.") });
      }
    } catch {
      setRetour({ ok: false, texte: "L'envoi n'a peut-être pas abouti : ouvrez la demande pour le vérifier." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg bg-secondary/30 p-2">
      {remplace && <p className="text-xs font-medium">Remplacer « {remplace.nom} » par :</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Nature du fichier" className="h-9 w-auto">
          {PAYMENT_PIECE_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <input
          type="file" onChange={(e) => setFichier(e.target.files?.[0] ?? null)}
          aria-label={remplace ? `Nouveau fichier pour remplacer ${remplace.nom}` : `Fichier pour ${demande.reference}`}
          className="min-w-0 flex-1 text-sm text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-sm"
        />
        <Button type="button" size="sm" disabled={!fichier || busy} onClick={() => void envoyer()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {remplace ? "Remplacer" : "Joindre"}
        </Button>
        <button type="button" onClick={onAnnuler} aria-label="Annuler" className="rounded p-1.5 text-muted-foreground hover:bg-secondary"><X className="h-4 w-4" /></button>
      </div>
      {retour && <p className={`text-xs ${retour.ok ? "text-success" : "text-destructive"}`}>{retour.texte}</p>}
    </div>
  );
}
