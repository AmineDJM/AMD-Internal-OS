"use client";

import * as React from "react";
import { ArrowUp, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { decideLeave, demanderAvisN1Conge } from "@/modules/rh/actions";
import type { CongeADecider } from "@/lib/queries/my-team";

/**
 * DÉCIDER D'UN CONGÉ DEPUIS MON ÉQUIPE (Direction, 06/10) — valider, refuser, ou DEMANDER À SON N+1. La trace de ce qui
 * a été remonté et redescendu se lit sous la ligne : qui a demandé l'avis de qui, et ce qui est revenu.
 */
export function DecisionConge({ conge }: { conge: CongeADecider }) {
  const { enCours, rafraichir } = useRafraichir();
  const [mode, setMode] = React.useState<"REFUSER" | "REMONTER" | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const agir = async (quoi: "APPROVED" | "REJECTED" | "REMONTER") => {
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("id", conge.leaveId);
    if (note.trim()) fd.set("note", note.trim());
    if (quoi !== "REMONTER") fd.set("decision", quoi);
    const r = quoi === "REMONTER" ? await demanderAvisN1Conge(fd) : await decideLeave(fd);
    setBusy(false);
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? (quoi === "APPROVED" ? "Congé validé." : "Congé refusé.")) : (r.error ?? "Échec.") });
    if (r.ok) { setMode(null); setNote(""); rafraichir(); }
  };
  const occupe = busy || enCours;

  return (
    <div className="basis-full space-y-2 text-xs">
      {conge.trace.length > 0 && (
        <ol className="space-y-0.5 rounded-md bg-secondary/40 px-2 py-1.5 text-muted-foreground [overflow-wrap:anywhere]">
          {conge.trace.map((t, i) => (
            <li key={i}>
              <ArrowUp className="mr-1 inline h-3 w-3" /> {t.de} a demandé l&apos;avis de <b className="text-foreground">{t.a}</b>{t.note ? ` — « ${t.note} »` : ""}
              {t.decision && (
                <span className={t.decision === "APPROVED" ? "text-success" : "text-destructive"}>
                  {" "}· {t.decision === "APPROVED" ? "validé" : "refusé"}{t.decideLe ? ` le ${new Date(t.decideLe).toLocaleDateString("fr-FR")}` : ""}{t.noteDecision ? ` (« ${t.noteDecision} »)` : ""}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!conge.aMoi ? (
        <p className="text-muted-foreground">En attente de l&apos;avis de {conge.attendDe} — la demande vous reviendra avec sa décision.</p>
      ) : (
        <>
          {/* Au pouce : une décision par ligne, pleine largeur et 40 px de haut. Pas de `w-full` sur
              le bouton décisif — il élargirait aussi son enveloppe sur ordinateur. */}
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <BoutonDecisif size="sm" className="min-h-10 max-sm:flex-1 max-sm:text-sm sm:min-h-0" onClick={() => void agir("APPROVED")} disabled={occupe || mode !== null}>
              {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Valider
            </BoutonDecisif>
            <Button size="sm" variant="outline" className="min-h-10 max-sm:text-sm sm:min-h-0" onClick={() => setMode(mode === "REFUSER" ? null : "REFUSER")} disabled={occupe}>
              <XCircle className="h-3.5 w-3.5" /> Refuser
            </Button>
            <Button size="sm" variant="outline" className="min-h-10 max-sm:text-sm sm:min-h-0" onClick={() => setMode(mode === "REMONTER" ? null : "REMONTER")} disabled={occupe}>
              <ArrowUp className="h-3.5 w-3.5" /> Demander à mon N+1
            </Button>
          </div>
          {mode && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={note} onChange={(e) => setNote(e.target.value)} aria-label={mode === "REFUSER" ? "Motif du refus" : "Message à votre N+1"}
                placeholder={mode === "REFUSER" ? "Motif du refus (conseillé)" : "Ce que vous attendez de votre N+1 (facultatif)"}
                className="min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:flex-1 sm:px-2 sm:py-1"
              />
              {mode === "REFUSER" ? (
                <BoutonDecisif size="sm" variant="secondary" className="min-h-10 max-sm:flex-1 max-sm:text-sm sm:min-h-0" onClick={() => void agir("REJECTED")} disabled={occupe}>Confirmer le refus</BoutonDecisif>
              ) : (
                <Button size="sm" className="min-h-10 max-sm:text-sm sm:min-h-0" onClick={() => void agir("REMONTER")} disabled={occupe}>Envoyer à mon N+1</Button>
              )}
            </div>
          )}
        </>
      )}
      {msg && <p className={msg.ok ? "text-success" : "text-destructive"}>{msg.texte}</p>}
    </div>
  );
}
