"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { formatCurrency } from "@/lib/utils";
import { actionFailureMessage } from "@/lib/action-outcome";
import {
  apercuSuppressionDefinitiveAdPro, supprimerDefinitivementDemandeAdPro, type ApercuSuppressionDefinitive,
} from "../actions-suppression-definitive";

/**
 * « SUPPRIMER DÉFINITIVEMENT » — menu ⋯ d'une fiche Ad & Pro, Super Admin seul (24/11/2026).
 *
 * `enabled` vient du serveur (`refusSuppressionDefinitive`, la règle de l'action) ; l'action revérifie tout. Le
 * panneau LIT d'abord ce qui va disparaître — postes, ordres (dont payés), budget rendu ligne par ligne, écritures
 * de trésorerie, pièces — puis demande de RETAPER la référence : un geste qui ne se défait pas ne s'arme pas d'un clic.
 */
export function SupprimerDefinitivementDemandeAdPro({ kind, id, enabled }: { kind: string; id: string; enabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  if (!enabled) return null;
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" /> Supprimer définitivement
      </Button>
      {open && <Panneau kind={kind} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

function Panneau({ kind, id, onClose }: { kind: string; id: string; onClose: () => void }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [lu, setLu] = React.useState<ApercuSuppressionDefinitive | null>(null);
  const [saisie, setSaisie] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);

  // Relu à chaque ouverture : un paiement a pu partir, un poste naître, depuis la dernière.
  React.useEffect(() => {
    let vivant = true;
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", id);
    apercuSuppressionDefinitiveAdPro(fd)
      .then((r) => { if (vivant) setLu(r); })
      .catch(() => { if (vivant) setLu({ ok: false, error: actionFailureMessage("THROWN") }); });
    return () => { vivant = false; };
  }, [kind, id]);

  const a = lu?.ok ? lu : null;
  const conforme = !!a && saisie.trim().toUpperCase() === a.reference.toUpperCase();
  const armable = !!a && conforme && !busy && a.apercu.bloquants.length === 0;

  async function detruire() {
    if (!a) return;
    setBusy(true);
    setErreur(null);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", id);
    fd.set("reference", saisie);
    try {
      const r = await supprimerDefinitivementDemandeAdPro(fd);
      if (!r.ok) { setBusy(false); setErreur(r.error ?? "Suppression impossible."); return; }
      onClose();
      router.push(r.redirect ?? "/ad-pro");
      rafraichir();
    } catch {
      setBusy(false);
      setErreur(actionFailureMessage("THROWN"));
    }
  }

  return (
    <Sheet open onClose={() => !busy && onClose()} title="Supprimer définitivement" description="Irréversible — sans corbeille.">
      <div className="space-y-4 text-sm">
        <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>La demande et tout ce qui lui est lié disparaissent, ordres payés compris. Seule une ligne d&apos;audit reste.</p>
        </div>

        {!lu && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de ce qui va disparaître…</p>}
        {lu && !lu.ok && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{lu.error}</p>}
        {a && <Inventaire a={a} />}

        {a && (
          <label className="block space-y-1">
            <span className="text-muted-foreground">Retapez la référence <span className="font-mono font-semibold text-foreground">{a.reference}</span> pour confirmer</span>
            <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={saisie.length > 0 && !conforme} />
          </label>
        )}
        {erreur && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{erreur}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
          <BoutonDecisif variant="destructive" onClick={detruire} disabled={!armable} confirmation="Confirmer la suppression définitive">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Supprimer définitivement
          </BoutonDecisif>
        </div>
      </div>
    </Sheet>
  );
}

const dzd = (n: number) => formatCurrency(n);

/** CE QUI VA DISPARAÎTRE, chiffré — les nombres mêmes que la trace d'audit gardera. */
function Inventaire({ a }: { a: Extract<ApercuSuppressionDefinitive, { ok: true }> }) {
  const x = a.apercu;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">{a.nature} · {a.reference}</p>
        <p className="break-words font-medium">{a.titre}</p>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <dt>Postes</dt><dd className="text-right tabular-nums">{x.postes}</dd>
        <dt>Ordres de dépense</dt><dd className="text-right tabular-nums">{x.ordres.nombre} · {dzd(x.ordres.montantTotal)}</dd>
        <dt className="pl-3 text-muted-foreground">dont payés</dt><dd className="text-right tabular-nums text-destructive">{x.ordres.payes} · {dzd(x.ordres.montantPaye)}</dd>
        <dt className="pl-3 text-muted-foreground">dont en circuit</dt><dd className="text-right tabular-nums">{x.ordres.enCircuit} · {dzd(x.ordres.montantEnCircuit)}</dd>
        <dt>Écritures de trésorerie</dt><dd className="text-right tabular-nums">{x.ecritures.nombre} · {dzd(x.ecritures.sorties)}</dd>
        <dt>Pièces Legal · jointes · fichiers</dt><dd className="text-right tabular-nums">{x.pieces.legal} · {x.pieces.jointes} · {x.pieces.fichiers}</dd>
      </dl>

      {x.budget.length > 0 && (
        <div>
          <p className="mb-1 font-medium">Rendu au budget</p>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground"><tr><th className="text-left font-normal">Ligne</th><th className="text-right font-normal">Engagé</th><th className="text-right font-normal">Consommé</th></tr></thead>
            <tbody>
              {x.budget.map((b) => (
                <tr key={b.categorieId}><td className="break-words pr-2">{b.libelle}</td><td className="text-right tabular-nums">{dzd(b.engagement)}</td><td className="text-right tabular-nums">{dzd(b.consommation)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {x.gardees.length > 0 && (
        <div>
          <p className="mb-1 font-medium">Gardé — seul le lien part</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">{x.gardees.map((g, i) => <li key={i}>{g.libelle} — {g.pourquoi}</li>)}</ul>
        </div>
      )}
      {x.autres.length > 0 && <p className="text-muted-foreground">Aussi : {x.autres.join(", ")}.</p>}
      {x.bloquants.length > 0 && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">Impossible pour l&apos;instant : {x.bloquants.join(" ; ")}.</p>}
    </div>
  );
}
