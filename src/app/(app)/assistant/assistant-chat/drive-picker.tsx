"use client";

/**
 * LA CONVERSATION — le sélecteur de fichiers du Drive personnel (référence, sans re-téléversement).
 */
import * as React from "react";
import { Loader2, Search, X, FolderOpen, FileText } from "lucide-react";
import { listAssistantFiles } from "./erp";
import type { AssistantFileOption } from "@/lib/assistant-attachments";

/** Sélecteur de fichiers du Drive personnel : on référence un fichier existant (aucun
 *  re-téléversement) — recherche par nom, chargée à la demande. */
export function DriveFilePicker({ onPick, onClose }: { onPick: (f: AssistantFileOption) => void; onClose: () => void }) {
  const [q, setQ] = React.useState("");
  const [files, setFiles] = React.useState<AssistantFileOption[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await listAssistantFiles(q);
        if (alive) { setFiles(res); setLoading(false); }
      } catch {
        if (alive) { setFiles([]); setLoading(false); }
      }
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 sm:py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">Mes fichiers du Drive</span>
        <button type="button" onClick={onClose} className="-mr-2 ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground sm:mr-0 sm:h-auto sm:w-auto"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Rechercher un fichier…" className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-base outline-none focus:border-primary/60 sm:py-1.5 lg:text-sm" />
        </div>
      </div>
      {/* Bornée aussi par la hauteur visible : clavier ouvert, il ne reste parfois qu'un tiers d'écran. */}
      <div className="max-h-[min(13rem,35dvh)] overflow-y-auto overscroll-contain px-2 pb-2">
        {loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Chargement…</p>
        ) : files.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Aucun fichier{q ? " pour cette recherche" : ""}.</p>
        ) : (
          files.map((f) => (
            <button key={f.id} type="button" onClick={() => { onPick(f); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-secondary sm:py-1.5">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.round(f.size / 1024))} Ko</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
