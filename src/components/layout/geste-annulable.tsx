"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { COOKIE_GESTE_ANNULABLE, lireGesteAnnulable, type GesteAnnulable } from "@/lib/effets/ecran-ui";
import { annulerMonGeste } from "@/modules/assistant-ia/actions-gestes";

type Compte = { resume: string; details: { issue: string; quoi: string; pourquoi: string }[]; retablirGesteId?: string | null };

const oublier = () => { document.cookie = `${COOKIE_GESTE_ANNULABLE}=; max-age=0; path=/`; };

/**
 * LE BANDEAU « ANNULER » (lot K10a, décision 0035) — après une action d'argent faite à l'écran, le geste journalisé
 * est offert à l'annulation pendant deux minutes ; ensuite il reste dans « Ce que j'ai fait » (`/assistant/gestes`).
 * Le compte rendu dit, effet par effet, ce qui est défait, compensé (contre-passation, « à récupérer ») ou impossible
 * — jamais un « annulé » de façade — et « Rétablir » défait l'annulation. Lit un témoin court posé par l'action.
 */
export function GesteAnnulable() {
  const router = useRouter();
  const [geste, setGeste] = React.useState<GesteAnnulable | null>(null);
  const [compte, setCompte] = React.useState<Compte | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [enCours, setEnCours] = React.useState(false);

  React.useEffect(() => {
    const lire = () => {
      const g = lireGesteAnnulable(document.cookie);
      if (g) setGeste((cur) => (cur?.id === g.id ? cur : g));
    };
    lire();
    const t = window.setInterval(lire, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Un NOUVEAU geste remplace le compte rendu du précédent.
  React.useEffect(() => { setCompte(null); setErreur(null); }, [geste?.id]);

  const defaire = async (id: string) => {
    setEnCours(true);
    setErreur(null);
    const r = await annulerMonGeste(id).catch(() => ({ ok: false as const, error: "L'annulation n'a pas abouti — rien n'a été écrit." }));
    setEnCours(false);
    oublier();
    if (!r.ok) { setErreur(r.error); return; }
    setCompte(r.compte);
    router.refresh();
  };

  if (!geste) return null;
  const fermer = () => { oublier(); setGeste(null); setCompte(null); setErreur(null); };
  const restes = compte?.details.filter((d) => d.issue === "IMPOSSIBLE" || d.issue === "COMPENSE") ?? [];
  return (
    <div role="status" aria-live="polite" className="fixed bottom-20 right-4 z-[60] w-[min(26rem,calc(100vw-2rem))] rounded-xl border bg-background p-3 text-sm shadow-lg md:bottom-4">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium">{compte ? compte.resume : `« ${geste.libelle} » — fait.`}</p>
        <button type="button" onClick={fermer} aria-label="Fermer" className="text-muted-foreground hover:text-foreground">×</button>
      </div>
      {!compte && geste.mode === "compensation" && (
        <p className="mt-1 text-xs text-muted-foreground">L&apos;argent ne s&apos;efface pas : annuler passe une écriture inverse (ou « à récupérer »), datée et liée.</p>
      )}
      {restes.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
          {restes.map((d, i) => <li key={i}><span className="font-medium">{d.issue === "COMPENSE" ? "Compensé" : "Impossible"}</span> — {d.quoi} : {d.pourquoi}</li>)}
        </ul>
      )}
      {erreur && <p className="mt-1 text-xs text-destructive">{erreur}</p>}
      <div className="mt-2 flex gap-2">
        {!compte && <button type="button" disabled={enCours} onClick={() => defaire(geste.id)} className="rounded-md border px-3 py-1 font-medium hover:bg-muted disabled:opacity-50">Annuler</button>}
        {compte?.retablirGesteId && <button type="button" disabled={enCours} onClick={() => defaire(compte.retablirGesteId!)} className="rounded-md border px-3 py-1 font-medium hover:bg-muted disabled:opacity-50">Rétablir</button>}
        <Link href="/assistant/gestes" className="ml-auto self-center text-xs underline text-muted-foreground">Historique</Link>
      </div>
    </div>
  );
}
