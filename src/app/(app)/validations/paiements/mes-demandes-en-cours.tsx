"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { PAYMENT_PIECE_KIND_OPTIONS, PAYMENT_REQUEST_STATUS } from "@/lib/labels";
import { mesDemandesDePaiementEnCours } from "@/modules/finances/actions-pieces-paiement";
import { addPaymentPiece } from "@/modules/finances/actions-demandes";
import type { DemandeEnCours } from "@/modules/finances/partage";
import { sansBloquer } from "@/lib/journal";

/**
 * « VOS DEMANDES EN COURS » — en tête de « Demander un paiement » (Direction, 09/11/2026 : « quand il ajoute une demande,
 * il voit ses demandes précédentes et peut les modifier, en changeant les fichiers ou en en ajoutant »).
 *
 * La personne qui revient avec la facture d'une demande déjà faite l'ajoutait jusqu'ici dans une SECONDE demande : le même
 * paiement demandé deux fois, et le premier dossier resté incomplet. Ses demandes non terminées sont rappelées ici, avec :
 *   • « Ajouter un fichier » — la pièce rejoint la demande qui existe (\`addPaymentPiece\`, mêmes gardes que sa page) ;
 *   • « Ouvrir » — la page de la demande, où l'on remplace un fichier (tant que les Finances n'ont pas ouvert l'examen) et
 *     corrige ses informations.
 */
export function MesDemandesEnCours() {
  const [demandes, setDemandes] = React.useState<DemandeEnCours[] | null>(null);
  const [ajout, setAjout] = React.useState<string | null>(null);

  const charger = React.useCallback(() => {
    void mesDemandesDePaiementEnCours().then(setDemandes).catch(sansBloquer("mes-demandes-en-cours.charger"));
  }, []);
  React.useEffect(() => { charger(); }, [charger]);

  if (!demandes || demandes.length === 0) return null;
  return (
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label="Vos demandes en cours">
      <div>
        <p className="text-sm font-medium">Vos demandes en cours</p>
        <p className="text-xs text-muted-foreground">La facture ou la pièce concerne l&apos;une d&apos;elles ? Ajoutez-la à cette demande plutôt que d&apos;en créer une nouvelle.</p>
      </div>
      <ul className="divide-y divide-border">
        {demandes.map((d) => (
          <li key={d.id} className="space-y-2 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium"><span className="font-mono text-xs text-muted-foreground">{d.reference}</span> · {d.title}</p>
                <p className="text-xs text-muted-foreground">
                  {d.payee} · {formatCurrency(d.amount)} · {PAYMENT_REQUEST_STATUS[d.status]?.label ?? d.status} · {d.pieces} pièce{d.pieces > 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setAjout((a) => (a === d.id ? null : d.id))} aria-expanded={ajout === d.id}>
                  <Paperclip className="h-3.5 w-3.5" /> Ajouter un fichier
                </Button>
                <Link href={`/validations/paiements/${d.id}`} className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-2.5 text-sm hover:bg-secondary">
                  Ouvrir <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
            {ajout === d.id && <AjoutFichier demande={d} onFait={() => { setAjout(null); charger(); }} onAnnuler={() => setAjout(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Joindre un fichier à une demande existante : sa nature, le fichier — la demande le reçoit comme depuis sa page. */
function AjoutFichier({ demande, onFait, onAnnuler }: { demande: DemandeEnCours; onFait: () => void; onAnnuler: () => void }) {
  const [kind, setKind] = React.useState("INVOICE");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const joindre = async () => {
    if (!fichier) return;
    setBusy(true); setRetour(null);
    const fd = new FormData();
    fd.set("requestId", demande.id); fd.set("kind", kind); fd.set("note", ""); fd.set("file", fichier);
    try {
      const r = await addPaymentPiece(fd);
      if (r.ok) {
        setRetour({ ok: true, texte: `Fichier ajouté à ${demande.reference}.` });
        window.setTimeout(onFait, 1200);
      } else {
        setRetour({ ok: false, texte: r.error ?? "Le fichier n'a pas été ajouté." });
      }
    } catch {
      setRetour({ ok: false, texte: "Le fichier n'a peut-être pas été ajouté : ouvrez la demande pour le vérifier." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/30 p-2">
      <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Nature du fichier" className="h-9 w-auto">
        {PAYMENT_PIECE_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      <input type="file" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} aria-label={`Fichier pour ${demande.reference}`} className="min-w-0 flex-1 text-sm text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-sm" />
      <Button type="button" size="sm" disabled={!fichier || busy} onClick={() => void joindre()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Joindre
      </Button>
      <button type="button" onClick={onAnnuler} aria-label="Annuler" className="rounded p-1.5 text-muted-foreground hover:bg-secondary"><X className="h-4 w-4" /></button>
      {retour && <p className={`w-full text-xs ${retour.ok ? "text-success" : "text-destructive"}`}>{retour.texte}</p>}
    </div>
  );
}
