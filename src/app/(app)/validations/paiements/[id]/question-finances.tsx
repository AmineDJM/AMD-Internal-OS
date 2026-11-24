"use client";

import * as React from "react";
import { Loader2, MessageCircleQuestion, Send } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { addPaymentPiece } from "@/modules/finances/actions-demandes";
import { repondreAuxFinances } from "@/modules/finances/actions-questions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { PAYMENT_PIECE_KIND_OPTIONS } from "@/lib/labels/finance";

/**
 * LA QUESTION DES FINANCES, CÔTÉ DEMANDEUR — en tête de sa demande (Banque & paiements, 24/11/2026).
 *
 * Il répond par un message, et/ou une pièce (RIB, proforma, facture corrigée…). La pièce entre au DOSSIER par le dépôt
 * ordinaire (`addPaymentPiece` : ses gardes — facture déjà connue, écart de montant — s'appliquent), puis la réponse
 * la nomme (`repondreAuxFinances`) : les Finances sont prévenues, et leur ligne passe « Réponse reçue ».
 */
export function QuestionFinances({ requestId, question, auteur, le, enAttente }: {
  requestId: string;
  question: string;
  auteur: string | null;
  le: string;
  /** La question attend encore sa réponse ; sinon, elle est rappelée pour mémoire. */
  enAttente: boolean;
}) {
  const [message, setMessage] = React.useState("");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [nature, setNature] = React.useState("OTHER");
  const { busy, err, run } = useAction();

  const repondre = () => run(async () => {
    let pieceId: string | null = null;
    if (fichier) {
      const fd = new FormData();
      fd.set("requestId", requestId);
      fd.set("file", fichier);
      fd.set("kind", nature);
      fd.set("note", "Jointe en réponse à la question des Finances.");
      const r = await addPaymentPiece(fd);
      if (!r.ok) return r;
      pieceId = r.id ?? null;
    }
    const fd = new FormData();
    fd.set("requestId", requestId);
    if (message.trim()) fd.set("message", message.trim());
    if (pieceId) fd.set("pieceId", pieceId);
    return repondreAuxFinances(fd);
  }, () => { setMessage(""); setFichier(null); }, { succes: "Réponse envoyée aux Finances." });

  return (
    <section id="question-finances" className={`scroll-mt-24 space-y-3 rounded-xl border p-4 ${enAttente ? "border-warning/50 bg-warning/10" : "border-border"}`}>
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{enAttente ? "Les Finances vous posent une question" : "Question des Finances (répondue)"}</h2>
          <p className="text-xs text-muted-foreground">{auteur ?? "Les Finances"} · {le}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{question}</p>
        </div>
      </div>
      {enAttente && (
        <div className="space-y-2">
          <Label htmlFor="reponse-finances">Votre réponse</Label>
          <Textarea id="reponse-finances" value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[70px]" placeholder="Ex. le fournisseur préfère un chèque ; RIB ci-joint." />
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Input type="file" aria-label="Pièce jointe (facultatif)" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} />
            <Select aria-label="Nature de la pièce" value={nature} onChange={(e) => setNature(e.target.value)} disabled={!fichier}>
              {PAYMENT_PIECE_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
          <Retour ton="erreur">{err}</Retour>
          <Button type="button" disabled={busy || (!message.trim() && !fichier)} onClick={() => void repondre()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Répondre aux Finances
          </Button>
        </div>
      )}
    </section>
  );
}
