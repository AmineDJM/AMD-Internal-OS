"use client";

import * as React from "react";
import { History, Loader2, Download } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { listerVersionsDuDocument } from "@/lib/actions/document-actions";
import { nomDeVersion, type LigneVersionDocument } from "@/lib/document-versions-partage";
import { explorerSize } from "@/lib/drive/explorer";
import { formatDateTime } from "@/lib/utils";

/**
 * LE PETIT « VERSIONS » DE LA FICHE D'UN DOCUMENT (audit du Drive, 24/11, point A4) : chaque enregistrement dans
 * l'éditeur Office ou l'éditeur de texte garde la version précédente ; ce panneau la liste et la télécharge. Rien ne
 * s'y modifie — revenir à une version, c'est la télécharger puis la redéposer.
 */
export function VersionsDocument({ id, name, className }: { id: string; name: string; className: string }) {
  const [open, setOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<LigneVersionDocument[] | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setVersions(null);
    setErreur(null);
    listerVersionsDuDocument(id)
      .then((r) => { if (r.ok) setVersions(r.versions); else { setErreur(r.error); setVersions([]); } })
      .catch(() => { setErreur("Les versions n'ont pas pu être lues : réessayez."); setVersions([]); });
  }, [open, id]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} title="Versions">
        <History className="h-4 w-4" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Versions — « ${name} »`} width="md">
        {versions === null ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : erreur ? (
          <p className="text-sm text-destructive">{erreur}</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune version enregistrée.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                <span className="flex items-center gap-2">
                  v{v.version}
                  {v.courante && <Badge tone="success" dot={false}>actuelle</Badge>}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {[v.auteur, formatDateTime(v.date), v.taille !== null ? explorerSize(v.taille, true) : null].filter(Boolean).join(" · ")}
                </span>
                <BoutonTelecharger
                  href={v.courante ? `/api/documents/${id}?dl=1` : `/api/documents/${id}?dl=1&version=${v.version}`}
                  nom={v.courante ? name : nomDeVersion(name, v.version)}
                  sansChoix
                  className="rounded-lg p-2.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:p-1.5"
                  title={`Télécharger la version ${v.version}`}
                >
                  <Download className="h-4 w-4" />
                </BoutonTelecharger>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  );
}
