"use client";

import * as React from "react";
import { Copy, KeyRound, UserPlus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Retour, useRetours } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { creerCompteSalarie, renouvelerInvitation } from "@/modules/rh/actions-depart";
import type { ActionResult } from "@/lib/actions/types";

export interface EtatCompteVue {
  email: string;
  role: string;
  isActive: boolean;
  jamaisConnecte: boolean;
  invitation: { lien: string; expire: string; perimee: boolean } | null;
}

/**
 * LE COMPTE APPLICATIF DE LA FICHE (lot rhdepart) — né avec la fiche, par invitation. La carte dit où il en est : actif,
 * en attente d'activation (le lien à transmettre, à copier ; un nouveau lien s'il a expiré), fermé — ou absent, avec le
 * geste qui le crée.
 */
export function CompteSalarieCard({ employeeId, etat, roleLabel, email }: {
  employeeId: string; etat: EtatCompteVue | null; roleLabel: string | null; email: string | null;
}) {
  const { busy, err, run } = useAction();
  const retours = useRetours();
  const [msg, setMsg] = React.useState<string | null>(null);
  const geste = (fn: (fd: FormData) => Promise<ActionResult>) => {
    const fd = new FormData(); fd.set("id", employeeId);
    void run(async () => { const r = await fn(fd); if (r.ok) setMsg(r.message ?? null); return r; });
  };
  const copier = async (lien: string) => {
    try { await navigator.clipboard.writeText(`${window.location.origin}${lien}`); retours.succes("Lien d'invitation copié."); }
    catch { retours.erreur("Le lien n'a pas pu être copié : sélectionnez-le à la main."); }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Compte applicatif</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!etat ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-muted-foreground">{email ? `Aucun compte : il se crée par invitation à ${email}.` : "Aucun compte : ajoutez l'e-mail du salarié sur sa fiche."}</p>
            {email && (
              <Button size="sm" onClick={() => geste(creerCompteSalarie)} disabled={busy}>
                <UserPlus className="h-4 w-4" /> Créer son compte
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium [overflow-wrap:anywhere]">{etat.email}</span>
              {roleLabel && <Badge tone="neutral" dot={false}>{roleLabel}</Badge>}
              {!etat.isActive ? <Badge tone="danger" dot={false}>Fermé</Badge>
                : etat.jamaisConnecte ? <Badge tone="warning" dot={false}>En attente d&apos;activation</Badge>
                  : <Badge tone="success" dot={false}>Actif</Badge>}
            </div>
            {etat.isActive && etat.jamaisConnecte && (
              <div className="flex flex-wrap items-center gap-2">
                {etat.invitation && !etat.invitation.perimee ? (
                  <>
                    <code className="max-w-full truncate rounded bg-secondary px-2 py-1 text-xs">{etat.invitation.lien}</code>
                    <Button size="sm" variant="outline" onClick={() => void copier(etat.invitation!.lien)}><Copy className="h-4 w-4" /> Copier le lien</Button>
                    <span className="text-xs text-muted-foreground">valable jusqu&apos;au {etat.invitation.expire}</span>
                  </>
                ) : <span className="text-xs text-warning">Le lien d&apos;invitation a expiré.</span>}
                <Button size="sm" variant="ghost" onClick={() => geste(renouvelerInvitation)} disabled={busy}>Nouveau lien</Button>
              </div>
            )}
          </>
        )}
        {msg && <Retour ton="succes" onFermer={() => setMsg(null)}>{msg}</Retour>}
        <Retour>{err}</Retour>
      </CardContent>
    </Card>
  );
}
