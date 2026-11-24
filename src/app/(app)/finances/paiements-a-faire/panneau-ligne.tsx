"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { FileText, FolderOpen, Loader2, Paperclip, Send, BellRing, Banknote } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { poserQuestionAuDemandeur, relancerQuestionDemandeur, marquerReponseLue } from "@/modules/finances/actions-questions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { formatCurrency } from "@/lib/utils";
import type { LigneBanque } from "./orders-table";

// L'aperçu (visionneuses PDF, image, Office) ne se charge qu'à la première ouverture d'un panneau.
const ApercuUniversel = dynamic(() => import("@/components/documents/apercu-universel").then((m) => m.ApercuUniversel), {
  ssr: false,
  loading: () => <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</div>,
});

const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * LE PANNEAU D'UNE LIGNE — ce qu'on ouvre en cliquant le bénéficiaire (Super Admin, 24/11/2026).
 *
 * DIRECTEMENT le justificatif (aperçu de la pièce principale ; les autres pièces à un clic), le RIB du bénéficiaire
 * s'il est connu, et les ÉCHANGES avec le demandeur : le fil de son dossier, le seul. Les Finances y posent leur
 * question (RIB, mode de règlement, acompte…, avec une pièce si besoin) ; le demandeur est prévenu et répond depuis sa
 * demande. Ouvrir le panneau sur une réponse non lue la marque lue — « Réponse reçue » s'éteint sur la ligne.
 */
export function PanneauLigne({ ligne, onClose, canSettle, onPayer }: { ligne: LigneBanque; onClose: () => void; canSettle: boolean; onPayer: () => void }) {
  const open = true;
  const p = ligne.panneau;
  const pieces = React.useMemo(() => (p.justificatif ? [p.justificatif, ...p.autresPieces] : p.autresPieces), [p]);
  const [vue, setVue] = React.useState(0);
  const piece = pieces[vue] ?? null;
  const [message, setMessage] = React.useState("");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const envoi = useAction();
  const rappel = useAction();
  const enAttente = ligne.question === "EN_ATTENTE_DEMANDEUR";

  // La lecture de la réponse : une seule fois par ouverture, sans bloquer l'aperçu.
  const lu = React.useRef(false);
  React.useEffect(() => {
    if (!open || lu.current || ligne.question !== "REPONSE_RECUE") return;
    lu.current = true;
    const fd = new FormData();
    fd.set("orderId", ligne.id);
    void marquerReponseLue(fd).catch(() => undefined);
  }, [open, ligne.id, ligne.question]);

  const envoyer = (texte: string, piece: File | null) => envoi.run(async () => {
    const fd = new FormData();
    fd.set("orderId", ligne.id);
    fd.set("message", texte);
    if (piece) fd.set("file", piece);
    return poserQuestionAuDemandeur(fd);
  }, () => { setMessage(""); setFichier(null); }, { succes: `Message envoyé${p.demandeur ? ` à ${p.demandeur}` : " au demandeur"}.` });
  const peutEcrire = canSettle && Boolean(p.dossierId) && ligne.status === "PENDING";

  return (
    <Sheet open={open} onClose={onClose} title={`${ligne.beneficiaire} — ${formatCurrency(ligne.montant)}`} description={`${ligne.objet}${p.demandeur ? ` · demandé par ${p.demandeur}` : ""}`} width="xl">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="Justificatif" className="space-y-2">
          {piece ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium"><FileText className="h-4 w-4 text-muted-foreground" /> {piece.nature} — <span className="truncate">{piece.nom}</span></p>
              <ApercuUniversel key={piece.documentId} src={`/api/documents/${piece.documentId}`} name={piece.nom} mime={piece.mime} telechargement={`/api/documents/${piece.documentId}?dl=1`} />
            </>
          ) : (
            <p className="surface p-4 text-sm text-warning">Aucun justificatif joint à ce paiement. Demandez-le au demandeur ci-contre.</p>
          )}
          {pieces.length > 1 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Autres pièces">
              {pieces.map((x, i) => (
                <li key={x.documentId}>
                  <button
                    type="button" onClick={() => setVue(i)} aria-current={i === vue ? "true" : undefined}
                    className={`flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs ${i === vue ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                  >
                    <Paperclip className="h-3 w-3" /> {x.nature} · <span className="max-w-[10rem] truncate">{x.nom}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Bénéficiaire et échanges" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="text-muted-foreground">RIB du bénéficiaire : </span>
              <span className={`font-mono [overflow-wrap:anywhere] ${p.rib ? "" : "text-destructive"}`}>{p.rib ?? "absent"}</span>
            </span>
            {/* DEMANDER LE RIB : une question toute faite au demandeur, sur le même fil. */}
            {!p.rib && peutEcrire && (
              <Button type="button" variant="outline" size="sm" disabled={envoi.busy} onClick={() => void envoyer(`Merci de joindre le RIB de ${ligne.beneficiaire} pour pouvoir payer.`, null)}>
                Demander le RIB
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold">Échanges avec le demandeur</h3>
            {p.fil.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun échange pour l&apos;instant.</p>
            ) : (
              <ol className="max-h-72 space-y-1.5 overflow-y-auto" data-fil-ordre={ligne.id}>
                {p.fil.map((m) => (
                  <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.deFinances ? "ml-6 bg-primary/10" : "mr-6 bg-secondary/70"}`}>
                    <p className="text-xs text-muted-foreground">{m.auteur} · {m.genre} · {quand(m.at)}</p>
                    {m.message && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.message}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {peutEcrire && (
            <div className="space-y-2">
              <Label htmlFor={`q-${ligne.id}`}>Écrire au demandeur</Label>
              <Textarea
                id={`q-${ligne.id}`} value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[70px]"
                placeholder="Une question au demandeur : RIB, mode de règlement souhaité, acompte…"
              />
              <Input type="file" aria-label="Pièce jointe (facultatif)" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} />
              <Retour ton="erreur">{envoi.err ?? rappel.err}</Retour>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={envoi.busy || !message.trim()} onClick={() => void envoyer(message.trim(), fichier)}>
                  {envoi.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
                </Button>
                {enAttente && (
                  <Button
                    type="button" variant="outline" disabled={rappel.busy}
                    onClick={() => void rappel.run(() => { const fd = new FormData(); fd.set("orderId", ligne.id); return relancerQuestionDemandeur(fd); }, undefined, { succes: "Rappel envoyé au demandeur." })}
                  >
                    <BellRing className="h-4 w-4" /> Relancer
                  </Button>
                )}
              </div>
            </div>
          )}
          {!p.dossierId && <p className="text-xs text-muted-foreground">Ce paiement n&apos;a pas de dossier : contactez le demandeur directement.</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {ligne.dossierHref && (
              <Link href={ligne.dossierHref} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 text-sm font-medium hover:bg-secondary">
                <FolderOpen className="h-4 w-4" /> Ouvrir le dossier
              </Link>
            )}
            {canSettle && ligne.status === "PENDING" && !ligne.deferredUntil && (
              <Button type="button" onClick={onPayer}><Banknote className="h-4 w-4" /> Payer</Button>
            )}
          </div>
        </section>
      </div>
    </Sheet>
  );
}

const MODE_LIBELLE: Record<string, string> = { BANK_TRANSFER: "Virement", CHEQUE: "Chèque", CASH: "Espèces", CARD: "Carte", OTHER: "Autre" };

/**
 * LE PAIEMENT FAIT — ce qu'on ouvre depuis « Payés » : quand, depuis quel compte, par quel mode, sous quelle référence,
 * et le justificatif. Un ordre ANNULÉ le dit, sans montant débité. L'annulation d'un paiement se fait par la barre
 * d'annulation du geste « Marquer payé » (contre-passation tracée), pas d'ici.
 */
export function DetailPaiement({ ligne, onClose }: { ligne: LigneBanque; onClose: () => void }) {
  const f = ligne.paiement;
  const annule = ligne.status === "CANCELLED";
  const rang = (dt: string, dd: React.ReactNode) => (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 py-1.5"><dt className="text-muted-foreground">{dt}</dt><dd className="[overflow-wrap:anywhere]">{dd}</dd></div>
  );
  return (
    <Sheet open onClose={onClose} title={`${ligne.beneficiaire} — ${formatCurrency(ligne.montant)}`} description={ligne.objet} width="md">
      <div className="space-y-4">
        {annule && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">Annulé — l&apos;ordre n&apos;a jamais été débité.</p>}
        <dl className="divide-y divide-border text-sm">
          {rang("Payé le", annule ? "jamais payé" : f?.le ?? "—")}
          {rang("Depuis", f?.depuis ?? "—")}
          {rang("Mode", f?.mode ? MODE_LIBELLE[f.mode] ?? f.mode : "—")}
          {rang("Référence", f?.reference ?? "—")}
          {rang("Justificatif", ligne.justification)}
          {ligne.bv && rang("Quittance", ligne.bv.quittanceJointe ? `${ligne.bv.nature} — quittance jointe au dossier` : "—")}
        </dl>
        <div className="flex flex-wrap gap-2">
          {ligne.dossierHref && (
            <Link href={ligne.dossierHref} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 text-sm font-medium hover:bg-secondary">
              <FolderOpen className="h-4 w-4" /> Ouvrir le dossier
            </Link>
          )}
          <Button type="button" variant="outline" onClick={onClose}>Fermer</Button>
        </div>
      </div>
    </Sheet>
  );
}
