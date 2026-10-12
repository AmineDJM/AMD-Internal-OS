"use client";

import * as React from "react";
import { AlertTriangle, Check, FileCog, Info, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { testerEditeurOffice } from "@/lib/actions/onlyoffice-diagnostic-actions";
import {
  rapportOk, verdictNavigateur, type IssueNavigateur, type PointDiagnostic, type RapportEditeurOffice,
} from "@/lib/onlyoffice-diagnostic";

/**
 * ÉDITEUR OFFICE — « Tester l'éditeur Office » (Super Admin).
 *
 * Deux moitiés, parce que la panne n'est pas au même endroit selon qui regarde : l'action serveur
 * vérifie les variables, la forme des adresses et ce que NOTRE serveur atteint ; ce composant
 * essaie ensuite de charger `api.js` DANS CE NAVIGATEUR — c'est lui qui voit le contenu mixte,
 * le réseau interne, le certificat refusé que le serveur, lui, ne voit pas.
 */

const DELAI_NAVIGATEUR_MS = 15_000;

function essayerDansLeNavigateur(url: string): Promise<IssueNavigateur> {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `${url}${url.includes("?") ? "&" : "?"}diagnostic=${Date.now()}`;
    s.async = true;
    let fini = false;
    const finir = (issue: IssueNavigateur) => {
      if (fini) return;
      fini = true;
      window.clearTimeout(minuteur);
      s.remove();
      resolve(issue);
    };
    const minuteur = window.setTimeout(() => finir("delai"), DELAI_NAVIGATEUR_MS);
    s.onload = () => finir((window as unknown as { DocsAPI?: unknown }).DocsAPI ? "ok" : "sans-api");
    s.onerror = () => finir("erreur");
    document.head.appendChild(s);
  });
}

function Icone({ etat }: { etat: PointDiagnostic["etat"] }) {
  if (etat === "ok") return <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  if (etat === "echec") return <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  if (etat === "attention") return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />;
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function OnlyofficePanel({ configure, adresse }: { configure: boolean; adresse: string | null }) {
  const [busy, setBusy] = React.useState(false);
  const [rapport, setRapport] = React.useState<RapportEditeurOffice | null>(null);
  const [navigateur, setNavigateur] = React.useState<PointDiagnostic | "en-cours" | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);

  const lancer = async () => {
    setBusy(true); setRapport(null); setNavigateur(null); setErreur(null);
    try {
      const r = await testerEditeurOffice();
      if (r.error) { setErreur(r.error); return; }
      setRapport(r);
      if (r.apiJs) {
        setNavigateur("en-cours");
        const issue = await essayerDansLeNavigateur(r.apiJs);
        setNavigateur(verdictNavigateur(issue, { url: r.apiJs, pageHttps: window.location.protocol === "https:", serveurJoint: r.serveurJoint }));
      }
    } catch {
      setErreur("Le test n'a pas pu être lancé. Rechargez la page puis réessayez.");
    } finally {
      setBusy(false);
    }
  };

  const points = rapport ? [...rapport.points, ...(navigateur && navigateur !== "en-cours" ? [navigateur] : [])] : [];
  const ok = rapport ? rapportOk(points) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <FileCog className="h-4 w-4 text-muted-foreground" />
        {configure
          ? <Badge tone="success" dot={false}>Configuré</Badge>
          : <Badge tone="neutral" dot={false}>Non configuré</Badge>}
        {adresse && <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{adresse}</span>}
        <InfoBulle label="Ce que vérifie le test">
          Les variables (le secret n&apos;est jamais affiché), la forme des adresses, la réponse du Document Server
          depuis notre serveur (/healthcheck, api.js), l&apos;adresse publique de l&apos;application, puis le chargement
          d&apos;api.js dans ce navigateur. Rien n&apos;est écrit. Guide : docs/ONLYOFFICE_SETUP.md.
        </InfoBulle>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void lancer()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCog className="h-4 w-4" />} Tester l&apos;éditeur Office
        </Button>
      </div>

      {erreur && <p className="text-xs text-destructive" role="status">{erreur}</p>}

      {rapport && (
        <ul className="surface divide-y divide-border text-sm" aria-live="polite">
          {points.map((p) => (
            <li key={p.cle} className="flex items-start gap-3 px-3 py-2">
              <Icone etat={p.etat} />
              <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <p><span className="font-medium">{p.libelle}</span> <span className="text-xs text-muted-foreground">— {p.detail}</span></p>
                {p.correctif && p.etat !== "ok" && <p className="text-xs text-muted-foreground">→ {p.correctif}</p>}
              </div>
            </li>
          ))}
          {navigateur === "en-cours" && (
            <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Essai de chargement dans ce navigateur…
            </li>
          )}
          <li className="px-3 py-2 text-xs text-muted-foreground">
            {ok ? "Aucun blocage détecté." : "Au moins un point bloque l'éditeur — corriger le premier ✗ de la liste."}
          </li>
        </ul>
      )}
    </div>
  );
}
