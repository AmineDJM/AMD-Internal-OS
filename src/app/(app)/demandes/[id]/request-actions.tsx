"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, CheckCircle2, Wallet, RotateCcw, MoreHorizontal, BellRing, UserCog, XCircle, Trash2 } from "lucide-react";
import {
  startRequestProcessing, finishRequest, deleteRequests, rouvrirDemande, annulerDemandeAuSecretariat, assignRequest,
} from "@/lib/actions/admin-request-actions";
import { relancerDemande } from "@/lib/actions/secretariat-devis-actions";
import type { GesteSuivant } from "@/lib/secretariat/bureau";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * LE GESTE SUIVANT, EN TÊTE DE LA FICHE (maquette validée, 10/2026).
 *
 * La carte « Traitement » vivait en bas de page ; le geste qui fait avancer la demande est désormais
 * UN bouton dans l'en-tête, qui dit ce qu'il fait (`gesteSuivant`) : « Commencer le traitement »,
 * « Terminer la demande » (facture et imputation au budget dans la même fenêtre), « Relancer »,
 * « Rouvrir… ». Les gestes rares passent dans le menu « ⋯ » : rouvrir, réassigner, annuler,
 * supprimer — chacun avec sa garde et son motif, les mêmes actions qu'avant.
 */
export function GestesEnTete({
  requestId, status, type, geste, gere, peutRelancer, commencee,
  departments = [], defaultDepartmentId = null, fromAdPro = false, alreadyImputed = false, factureManquante = false,
  refusAnnulation = null, users = [], assignedToId = null, refusFin = null,
}: {
  requestId: string;
  status: string;
  type: string;
  geste: GesteSuivant;
  /** La personne gère la demande (assistante, responsable, vue globale) : le menu « ⋯ » est le sien. */
  gere: boolean;
  /** « Relancer » est offert (demandeur ou secrétariat, demande ouverte). */
  peutRelancer: boolean;
  commencee: boolean;
  departments?: { id: string; name: string }[];
  defaultDepartmentId?: string | null;
  fromAdPro?: boolean;
  alreadyImputed?: boolean;
  /** Un achat sans facture encore jointe : la fenêtre « Terminer » la demande. */
  factureManquante?: boolean;
  refusAnnulation?: string | null;
  /** Pourquoi « Terminer » n'est pas offert : la dernière décision du validateur (refus, modification demandée,
   *  validation en attente — `refusFinApresDecision`, audit du 14/10/2026). La raison se lit à la place du bouton. */
  refusFin?: string | null;
  users?: { id: string; name: string }[];
  assignedToId?: string | null;
}) {
  const router = useRouter();
  // Rafraîchir sans laisser rouvrir une fenêtre sur l'état d'avant (§118.172).
  const { enCours, rafraichir } = useRafraichir();
  const [enVol, setBusy] = React.useState(false);
  const busy = enVol || enCours;
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [fenetre, setFenetre] = React.useState<null | "terminer" | "rouvrir" | "annuler" | "supprimer" | "reassigner">(null);
  const [menu, setMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menu) return;
    const fermer = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", fermer);
    document.addEventListener("keydown", echap);
    return () => { document.removeEventListener("mousedown", fermer); document.removeEventListener("keydown", echap); };
  }, [menu]);

  const isPurchase = type === "PURCHASE";
  // L'imputation est due pour un achat qui ne vient pas d'Ad & Pro et n'a pas déjà été imputé.
  const needsImputation = isPurchase && !fromAdPro && !alreadyImputed && departments.length > 0;
  const ouverte = status !== "DONE" && status !== "CANCELLED";

  async function run(fd: FormData, action: (f: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, apres?: () => void) {
    setBusy(true); setErr(null); setNote(null);
    fd.set("id", requestId);
    const r = await action(fd);
    setBusy(false);
    if (r.ok) { setNote(r.message ?? null); apres?.(); rafraichir(); } else setErr(r.error ?? "Erreur.");
  }
  const ouvrir = (f: typeof fenetre) => { setErr(null); setMenu(false); setFenetre(f); };

  const relancer = (
    <Button type="button" variant={geste === "RELANCER" ? "primary" : "outline"} size="sm" disabled={busy} onClick={() => run(new FormData(), relancerDemande)}>
      <BellRing className="h-4 w-4" /> Relancer
    </Button>
  );

  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        {peutRelancer && ouverte && relancer}
        {geste === "COMMENCER" && (
          <Button type="button" size="sm" disabled={busy} onClick={() => run(new FormData(), startRequestProcessing)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Commencer le traitement
          </Button>
        )}
        {geste === "TERMINER" && refusFin !== null && <p className="text-xs text-muted-foreground sm:text-right">{refusFin}</p>}
        {geste === "TERMINER" && refusFin === null && (
          <Button type="button" size="sm" disabled={busy} onClick={() => ouvrir("terminer")}><CheckCircle2 className="h-4 w-4" /> Terminer la demande</Button>
        )}
        {geste === "ROUVRIR" && (
          <Button type="button" size="sm" disabled={busy} onClick={() => ouvrir("rouvrir")}><RotateCcw className="h-4 w-4" /> Rouvrir…</Button>
        )}
        {gere && (
          <div className="relative" ref={menuRef}>
            <Button type="button" variant="outline" size="sm" aria-haspopup="menu" aria-expanded={menu} aria-label="Autres gestes" onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
            {menu && (
              <div role="menu" className="absolute right-0 top-full z-20 mt-1.5 grid min-w-[14rem] gap-0.5 rounded-lg border border-border bg-card p-1.5 shadow-lg">
                {ouverte && geste !== "TERMINER" && commencee && refusFin === null && (
                  <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary" onClick={() => ouvrir("terminer")}><CheckCircle2 className="h-4 w-4" /> Terminer la demande…</button>
                )}
                {status === "DONE" && geste !== "ROUVRIR" && (
                  <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary" onClick={() => ouvrir("rouvrir")}><RotateCcw className="h-4 w-4" /> Rouvrir…</button>
                )}
                {ouverte && (
                  <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary" onClick={() => ouvrir("reassigner")}><UserCog className="h-4 w-4" /> Réassigner…</button>
                )}
                {ouverte && refusAnnulation === null && (
                  <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-destructive hover:bg-secondary" onClick={() => ouvrir("annuler")}><XCircle className="h-4 w-4" /> Annuler la demande…</button>
                )}
                {ouverte && refusAnnulation !== null && <p className="px-2.5 py-2 text-xs text-muted-foreground">{refusAnnulation}</p>}
                <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-destructive hover:bg-secondary" onClick={() => ouvrir("supprimer")}><Trash2 className="h-4 w-4" /> Supprimer…</button>
              </div>
            )}
          </div>
        )}
      </div>
      {note && <p className="text-xs text-success sm:text-right">{note}</p>}
      {err && !fenetre && <p className="text-xs text-destructive sm:text-right">{err}</p>}

      {/* TERMINER — la facture et l'imputation au budget dans la MÊME fenêtre. Terminer un achat sans dire qui le paie
          laissait le budget intact pendant que l'argent, lui, était sorti. */}
      <Sheet open={fenetre === "terminer"} onClose={() => setFenetre(null)} title="Terminer la demande"
        description={needsImputation ? "Joignez la facture finale et choisissez le budget de moyens généraux à débiter." : "La demande passe « Traitée » ; le demandeur est prévenu."} width="md">
        <form action={(fd) => run(fd, finishRequest, () => setFenetre(null))} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rq-facture">Facture finale {isPurchase && factureManquante ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(facultatif)</span>}</Label>
            <Input id="rq-facture" name="facture" type="file" required={isPurchase && factureManquante} />
            {isPurchase && !factureManquante && <p className="text-xs text-muted-foreground">Une facture est déjà jointe à la demande : elle sert de justificatif.</p>}
          </div>
          {needsImputation && (
            <>
              <div className="space-y-1.5">
                <Label>Budget de moyens généraux <span className="text-destructive">*</span></Label>
                <Select name="budgetDepartmentId" defaultValue={defaultDepartmentId ?? ""} required>
                  <option value="">— Choisir le département à débiter —</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Montant réellement dépensé (DZD) <span className="text-destructive">*</span></Label>
                <Input name="budgetAmount" inputMode="decimal" placeholder="0" required className="text-right tabular-nums" />
              </div>
              <div className="space-y-1.5">
                <Label>Précision (facultatif)</Label>
                <Input name="budgetNote" placeholder="Ex. fournisseur, n° de facture" />
              </div>
              <p className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0" /> <span>Chaque département a ses moyens généraux : c&apos;est celui qui a demandé qui consomme.</span>
              </p>
            </>
          )}
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setFenetre(null)}>Fermer</Button>
            <BoutonDecisif type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Fin du traitement</BoutonDecisif>
          </div>
        </form>
      </Sheet>

      <Sheet open={fenetre === "rouvrir"} onClose={() => setFenetre(null)} title="Rouvrir la demande" description="La demande repart en cours ; le demandeur est prévenu, avec votre motif." width="md">
        <form action={(fd) => run(fd, rouvrirDemande, () => setFenetre(null))} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="rq-reopen">Pourquoi la rouvrir</Label><Textarea id="rq-reopen" name="motif" rows={3} required /></div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setFenetre(null)}>Fermer</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Rouvrir</Button></div>
        </form>
      </Sheet>

      <Sheet open={fenetre === "reassigner"} onClose={() => setFenetre(null)} title="Réassigner la demande" description="La personne choisie en devient responsable ; elle est prévenue." width="md">
        <form action={(fd) => run(fd, assignRequest, () => setFenetre(null))} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rq-assign">Responsable</Label>
            <Select id="rq-assign" name="assignedToId" defaultValue={assignedToId ?? ""} required>
              <option value="">— Choisir —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setFenetre(null)}>Fermer</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Réassigner</Button></div>
        </form>
      </Sheet>

      <Sheet open={fenetre === "annuler"} onClose={() => setFenetre(null)} title="Annuler la demande" description="La validation, l'approbation et le paiement en attente sont retirés avec elle ; le demandeur est prévenu." width="md">
        <form action={(fd) => run(fd, annulerDemandeAuSecretariat, () => setFenetre(null))} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="rq-cancel">Motif de l&apos;annulation</Label><Textarea id="rq-cancel" name="motif" rows={3} required /></div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setFenetre(null)}>Fermer</Button><BoutonDecisif type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Annuler la demande</BoutonDecisif></div>
        </form>
      </Sheet>

      <Sheet open={fenetre === "supprimer"} onClose={() => setFenetre(null)} title="Supprimer la demande" width="md">
        <form action={(fd) => { fd.set("ids", requestId); return run(fd, deleteRequests, () => { setFenetre(null); router.push("/demandes"); }); }} className="space-y-3">
          <p className="text-xs text-muted-foreground">La suppression est <strong>tracée</strong> (qui, quand, pourquoi). La demande est archivée et masquée des listes, mais reste consultable en corbeille.</p>
          <div className="space-y-1"><Label htmlFor="rq-del">Motif de suppression (obligatoire)</Label><Textarea id="rq-del" name="reason" required placeholder="Ex. Doublon, demande annulée par le service…" /></div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setFenetre(null)}>Fermer</Button><BoutonDecisif type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Supprimer</BoutonDecisif></div>
        </form>
      </Sheet>
    </div>
  );
}
