"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { useAction } from "@/components/shared/use-action";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { formatCurrency, formatDate } from "@/lib/utils";
import { setAdProDgThreshold, setBcValidationThreshold } from "@/lib/actions/settings-actions";
import { reexaminerVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
import type { DecisionCentre, EtatDecide } from "@/modules/ad-pro/partage";

const ETAT: Record<EtatDecide, { libelle: string; ton: "success" | "danger" | "warning" }> = {
  VALIDE: { libelle: "Validé", ton: "success" },
  VISE: { libelle: "Visé", ton: "success" },
  AUTORISE: { libelle: "Autorisé", ton: "success" },
  RENVOYE: { libelle: "Renvoyé", ton: "warning" },
  REFUSE: { libelle: "Refusé", ton: "danger" },
};

/**
 * LE MENU ⋯ DU CENTRE AD & PRO (maquette du 24/11/2026) — ce qu'on consulte rarement et qui encombrait l'écran :
 * les décisions récentes (un refus s'y RÉEXAMINE, motif à l'appui) et le réglage des deux seuils.
 */
export function MenuCentreAdPro({ decides, seuil, seuilBC }: { decides: DecisionCentre[]; seuil: number; seuilBC: number }) {
  const [panneau, setPanneau] = React.useState<"decides" | "seuils" | null>(null);
  const fermer = React.useCallback(() => setPanneau(null), []);
  return (
    <>
      <MenuDossier label="Autres : déjà décidés, réglage des seuils" doigt>
        <button type="button" role="menuitem" onClick={() => setPanneau("decides")} className="rounded-md px-2 py-2 text-left text-sm hover:bg-secondary">
          Déjà décidés · {decides.length}
        </button>
        <button type="button" role="menuitem" onClick={() => setPanneau("seuils")} className="rounded-md px-2 py-2 text-left text-sm hover:bg-secondary">
          Réglage des seuils
        </button>
      </MenuDossier>
      {panneau === "decides" && (
        <Sheet open onClose={fermer} title="Déjà décidés" width="lg">
          {decides.length === 0 ? <p className="text-sm text-muted-foreground">Aucune décision récente.</p> : (
            <ul className="divide-y divide-border">
              {decides.map((d) => <LigneDecidee key={d.cle} d={d} />)}
            </ul>
          )}
        </Sheet>
      )}
      {panneau === "seuils" && (
        <Sheet open onClose={fermer} title="Réglage des seuils" width="md">
          <ReglageSeuils seuil={seuil} seuilBC={seuilBC} onFermer={fermer} />
        </Sheet>
      )}
    </>
  );
}

function LigneDecidee({ d }: { d: DecisionCentre }) {
  const { busy, err, run } = useAction();
  const [ouvert, setOuvert] = React.useState(false);
  const [note, setNote] = React.useState("");
  const e = ETAT[d.etat];
  return (
    <li className="flex flex-col gap-2 py-2.5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-[1_1_280px]">
          <Link href={d.href} className="font-medium text-foreground hover:underline [overflow-wrap:anywhere]">{d.objet}</Link>
          <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
            {d.montant != null ? `${formatCurrency(d.montant)} · ` : ""}{d.decideur ?? "Le centre"}{d.le ? `, le ${formatDate(d.le, { day: "numeric", month: "short" })}` : ""}{d.note ? ` · « ${d.note} »` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={e.ton} dot={false}>{e.libelle}</Badge>
          {d.reexaminable && !ouvert && <Button type="button" size="sm" variant="outline" onClick={() => setOuvert(true)}>Réexaminer</Button>}
        </div>
      </div>
      {ouvert && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={note} onChange={(ev) => setNote(ev.target.value)} aria-label={`Motif du réexamen — ${d.objet}`} placeholder="Pourquoi le centre réexamine" className="min-w-0 flex-1" />
          <BoutonDecisif
            size="sm" variant="outline" className="max-sm:w-full" disabled={busy || !note.trim()}
            onClick={() => void run(() => {
              const fd = new FormData();
              fd.set("entityType", d.entityType); fd.set("entityId", d.entityId); fd.set("note", note);
              return reexaminerVisaCentreAdPro(fd);
            }, () => setOuvert(false), { succes: "Repasse dans « À décider »." })}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Réexaminer
          </BoutonDecisif>
        </div>
      )}
      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </li>
  );
}

/**
 * LES DEUX SEUILS, UN SEUL BOUTON (§118.149) — celui des DEMANDES (qui arbitre une opération) et celui des BONS DE
 * COMMANDE nés d'Ad & Pro (quelle pièce se vise avant la signature des Finances). Chaque action garde sa porte et dit
 * ce que le changement a déplacé ; seul ce qui a changé part.
 */
function ReglageSeuils({ seuil, seuilBC, onFermer }: { seuil: number; seuilBC: number; onFermer: () => void }) {
  const { busy, err, run } = useAction();
  const [d, setD] = React.useState(String(seuil));
  const [b, setB] = React.useState(String(seuilBC));
  const [message, setMessage] = React.useState<string | null>(null);
  const enregistrer = () => void run(async () => {
    setMessage(null);
    const messages: string[] = [];
    if (Number(d) !== seuil) {
      const fd = new FormData(); fd.set("adProDgThreshold", d);
      const r = await setAdProDgThreshold(fd);
      if (!r.ok) return r;
      if (r.message) messages.push(r.message);
    }
    if (Number(b) !== seuilBC) {
      const fd = new FormData(); fd.set("bcValidationThreshold", b);
      const r = await setBcValidationThreshold(fd);
      if (!r.ok) return r;
      if (r.message) messages.push(r.message);
    }
    setMessage(messages.join(" ") || "Enregistré.");
    return { ok: true };
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="adProDgThreshold">Total d&apos;une demande (DZD)</Label>
          <Input id="adProDgThreshold" type="number" inputMode="numeric" min="0" step="any" value={d} onChange={(e) => setD(e.target.value)} />
          <p className="text-xs text-muted-foreground">0 = aucune demande ne passe ici</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="bcValidationThreshold">Bon de commande (DZD)</Label>
          <Input id="bcValidationThreshold" type="number" inputMode="numeric" min="0" step="any" value={b} onChange={(e) => setB(e.target.value)} />
          <p className="text-xs text-muted-foreground">0 = tous les BC passent ici</p>
        </div>
      </div>
      {message && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm">{message}</p>}
      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onFermer}>Fermer</Button>
        <Button type="button" disabled={busy} onClick={enregistrer}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</Button>
      </div>
    </div>
  );
}
