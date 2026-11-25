"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { formatCurrency } from "@/lib/utils";
import { actionFailureMessage } from "@/lib/action-outcome";
import { nomAvecSociete } from "@/lib/budget/enveloppe-cle";
import { nomConfirme } from "@/lib/budget/suppression-enveloppe-regle";
import { apercuSuppressionEnveloppe, deleteEnvelope } from "@/lib/actions/budget-envelope-actions";

type Apercu = Awaited<ReturnType<typeof apercuSuppressionEnveloppe>>;

/**
 * « ⋯ » DE L'ENVELOPPE → « Supprimer l'enveloppe » — la Direction générale seule (Super Admin ou Directeur général).
 *
 * `peutSupprimer` vient du serveur (la règle de l'action, `budget/suppression-enveloppe-regle.ts`) ; l'action revérifie
 * tout. Le panneau LIT d'abord ce que le geste touche — lignes et alloué, dépenses imputées, engagements, ce qui redevient
 * « à imputer » — puis fait RETAPER le nom. La suppression est réversible (corbeille du Super Admin).
 */
export function MenuEnveloppe({ envelopeId, peutSupprimer }: { envelopeId: string; peutSupprimer: boolean }) {
  const [ouvert, setOuvert] = React.useState(false);
  if (!peutSupprimer) return null;
  return (
    <>
      <MenuDossier label="Autres actions sur l'enveloppe">
        <Button variant="ghost" size="sm" className="justify-start text-destructive" onClick={() => setOuvert(true)}>
          <Trash2 className="h-4 w-4" /> Supprimer l&apos;enveloppe
        </Button>
      </MenuDossier>
      {ouvert && <Panneau envelopeId={envelopeId} onClose={() => setOuvert(false)} />}
    </>
  );
}

function Panneau({ envelopeId, onClose }: { envelopeId: string; onClose: () => void }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [lu, setLu] = React.useState<Apercu | null>(null);
  const [saisie, setSaisie] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);

  // Relu à chaque ouverture : une dépense a pu être imputée, un ordre engagé, depuis la dernière.
  React.useEffect(() => {
    let vivant = true;
    const fd = new FormData();
    fd.set("id", envelopeId);
    apercuSuppressionEnveloppe(fd)
      .then((r) => { if (vivant) setLu(r); })
      .catch(() => { if (vivant) setLu({ ok: false, error: actionFailureMessage("THROWN") }); });
    return () => { vivant = false; };
  }, [envelopeId]);

  const a = lu?.ok ? lu.apercu : null;
  const conforme = !!a && nomConfirme(saisie, a.nom);
  const armable = !!a && conforme && !busy && !a.refus;

  async function supprimer() {
    if (!a) return;
    setBusy(true);
    setErreur(null);
    const fd = new FormData();
    fd.set("id", envelopeId);
    fd.set("nom", saisie);
    try {
      const r = await deleteEnvelope(fd);
      if (!r.ok) { setBusy(false); setErreur(r.error ?? "Suppression impossible."); return; }
      onClose();
      router.push(r.redirect ?? "/budgets");
      rafraichir();
    } catch {
      setBusy(false);
      setErreur(actionFailureMessage("THROWN"));
    }
  }

  return (
    <Sheet open onClose={() => !busy && onClose()} title="Supprimer l'enveloppe" description="Réversible — elle va à la corbeille du Super Admin.">
      <div className="space-y-4 text-sm">
        <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>L&apos;enveloppe et ses lignes partent à la corbeille. Les dépenses ne sont pas effacées : elles redeviennent « à imputer », et s&apos;y rattachent de nouveau si l&apos;enveloppe est restaurée.</p>
        </div>

        {!lu && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de ce que la suppression touche…</p>}
        {lu && !lu.ok && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{lu.error}</p>}
        {a && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
              <p className="text-xs text-muted-foreground">Enveloppe · {formatCurrency(a.total)}</p>
              <p className="break-words font-medium">{nomAvecSociete(a.nom, a.societe)}</p>
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
              <dt>Lignes (catégories)</dt><dd className="text-right tabular-nums">{a.lignes} · {formatCurrency(a.alloue)} alloués</dd>
              <dt>Dépenses imputées</dt><dd className="text-right tabular-nums">{a.depenses.nombre} · {formatCurrency(a.depenses.montant)}</dd>
              <dt>Engagements en cours</dt><dd className="text-right tabular-nums">{a.engagements.nombre} · {formatCurrency(a.engagements.montant)}</dd>
            </dl>
            {a.aImputer.length > 0 && (
              <div>
                <p className="mb-1 font-medium">Redeviennent « à imputer »</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">{a.aImputer.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            )}
            {a.refus && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{a.refus}</p>}
          </div>
        )}

        {a && !a.refus && (
          <label className="block space-y-1">
            <span className="text-muted-foreground">Retapez le nom <span className="font-semibold text-foreground">{a.nom}</span> pour confirmer</span>
            <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={saisie.length > 0 && !conforme} />
          </label>
        )}
        {erreur && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{erreur}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
          <BoutonDecisif variant="destructive" onClick={supprimer} disabled={!armable} confirmation="Confirmer la suppression de l'enveloppe">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Supprimer l&apos;enveloppe
          </BoutonDecisif>
        </div>
      </div>
    </Sheet>
  );
}
