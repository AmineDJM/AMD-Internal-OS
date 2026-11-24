"use client";

import * as React from "react";
import { Loader2, Paperclip, Send, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { postDossierMessage } from "@/lib/actions/dossier-actions";
import type { FilSujetVue } from "../../infra/requetes/achats-pec";

/**
 * LA DISCUSSION EN BAS DES FICHES « CHIFFRER » ET « ACHETER » (bureau du secrétariat, 24/11/2026 : « elle doit rester sur
 * chaque fiche ») — le sujet de l'assistante pour cette prise en charge : messages et fichiers. L'écrivain est celui des
 * sujets (`postDossierMessage`), qui garde sa porte (membres du sujet).
 */
export function FilSujetPec({ fil }: { fil: FilSujetVue | null }) {
  const { saving, err, setErr, run } = useAction();
  const [corps, setCorps] = React.useState("");
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  if (!fil) {
    return <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">La discussion s&apos;ouvre avec la première demande de chiffrage.</p>;
  }
  const envoyer = () => run(() => {
    const f = new FormData();
    f.set("id", fil.dossierId);
    f.set("body", corps);
    for (const x of fichiers) f.append("files", x);
    return postDossierMessage(f);
  }, () => { setCorps(""); setFichiers([]); });

  return (
    <section aria-labelledby="fil-pec" className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
      <h2 id="fil-pec" className="text-base font-semibold">Discussion <span className="text-xs font-normal text-muted-foreground">· sujet {fil.reference}</span></h2>
      <ul className="space-y-2">
        {fil.messages.length === 0 && <li className="text-sm text-muted-foreground">Aucun message.</li>}
        {fil.messages.map((m) => (
          <li key={m.id} className="rounded-lg bg-secondary/40 px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">{m.auteur ?? "—"} · {new Date(m.quand).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
            {m.corps && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{m.corps}</p>}
            {m.pieces.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2">
                {m.pieces.map((p) => (
                  <a key={p.id} href={`/api/dossiers/message-attachment/${p.id}?dl=1`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-secondary">
                    <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{p.nom}</span>
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {err && <Retour ton="erreur" onFermer={() => setErr(null)}>{err}</Retour>}
      <Textarea value={corps} onChange={(e) => setCorps(e.target.value)} placeholder="Une question, une précision, un fichier…" className="min-h-[70px]" aria-label="Message" />
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs hover:bg-secondary">
          <Paperclip className="h-3.5 w-3.5" /> {fichiers.length ? `${fichiers.length} fichier(s)` : "Joindre"}
          <input type="file" multiple className="sr-only" onChange={(e) => setFichiers(Array.from(e.target.files ?? []))} />
        </label>
        <Button type="button" size="sm" className="ml-auto" disabled={saving || (!corps.trim() && fichiers.length === 0)} onClick={envoyer}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
        </Button>
      </div>
    </section>
  );
}
