"use client";

import * as React from "react";
import { Loader2, Send, HandHelping, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { takeSupportRequest, answerSupportRequest, updateSupportStatus } from "@/lib/actions/support-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";


const Err = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /> {msg}</div> : null;

export function SupportActions({ id, status, isResponder, isRequester, assigned }: { id: string; status: string; isResponder: boolean; isRequester: boolean; assigned: boolean }) {
  const { saving, err, run } = useAction();
  const closed = status === "CLOSED";
  const setStatus = (s: string) => { const fd = new FormData(); fd.set("id", id); fd.set("status", s); return updateSupportStatus(fd); };
  const take = () => { const fd = new FormData(); fd.set("id", id); return takeSupportRequest(fd); };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {isResponder && !assigned && !closed && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(take)}><HandHelping className="h-4 w-4" /> Prendre en charge</Button>
        )}
        {isResponder && !closed && status !== "ANSWERED" && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => setStatus("ANSWERED"))}><CheckCircle2 className="h-4 w-4" /> Marquer répondu</Button>
        )}
        {(isResponder || isRequester) && !closed && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => run(() => setStatus("CLOSED"))}><XCircle className="h-4 w-4" /> Clôturer</Button>
        )}
        {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
      </div>
      <Err msg={err} />
    </div>
  );
}

export function SupportMessageForm({ id }: { id: string }) {
  const { saving, err, run } = useAction();
  const ref = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      action={(fd) => { fd.set("id", id); run(() => answerSupportRequest(fd), () => ref.current?.reset()); }}
      className="space-y-2"
    >
      <Textarea name="body" required placeholder="Votre réponse ou un complément…" className="min-h-[70px]" />
      <Err msg={err} />
      <Button type="submit" size="sm" disabled={saving} className="w-full sm:w-auto">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer</Button>
    </form>
  );
}
