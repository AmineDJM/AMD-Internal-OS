"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Shield, Lock, Unlock, Loader2, Search, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setLegalReaders } from "@/lib/actions/legal-actions";
import { readersCaption, readersManagerHint } from "@/lib/lecteurs/legal";

/**
 * LES ACCÈS D'UN DOCUMENT LÉGAL — gérés ICI, sur le document, et nulle part ailleurs.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * La restriction existait déjà : un bail, un protocole d'accord, un contrat de cadre se déposent
 * avec une liste de lecteurs nommés. Mais cette liste ne se choisissait qu'À LA CRÉATION. Une
 * fois le document versé, plus aucun écran ne permettait d'y ajouter quelqu'un, d'en retirer une
 * personne partie, ni de lever la restriction : l'action serveur existait, seul l'assistant
 * pouvait l'appeler.
 *
 * En pratique, cela veut dire qu'on redéposait le document pour corriger une liste — donc deux
 * exemplaires du même contrat, dont un avec les mauvais accès — ou qu'on renonçait et qu'on
 * envoyait le fichier par mail, ce que la restriction sert précisément à éviter.
 *
 * ── QUI GÈRE ────────────────────────────────────────────────────────────────────────────────
 *
 * Le DÉPOSANT et le Super Admin. Pas celui qui a le droit d'écriture sur le module : pouvoir
 * corriger une date d'échéance n'est pas pouvoir s'ouvrir un document qu'on ne devrait pas lire —
 * il suffirait de s'ajouter à la liste. La règle est celle du module `lecteurs/legal.ts`, la MÊME
 * que revérifie l'action : un bouton qu'on voit et qui refuse ensuite fait chercher la panne au
 * lieu de faire demander à la bonne personne. Ceux qui ne gèrent pas voient donc l'état, et le
 * nom de qui s'en occupe.
 */
export function LegalAccessPanel({
  documentId, createdById, depositorName, people, readers, canManage,
}: {
  documentId: string;
  createdById: string | null;
  depositorName: string | null;
  /** Comptes actifs désignables, déposant exclu — il a déjà accès par sa porte. */
  people: { id: string; name: string }[];
  readers: { id: string; name: string }[];
  canManage: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>(() => readers.map((r) => r.id));

  // Rouvrir le panneau après un enregistrement repart de l'état RÉEL, pas de la dernière saisie.
  React.useEffect(() => { setPicked(readers.map((r) => r.id)); }, [readers]);

  const caption = readersCaption({ createdById, readerIds: readers.map((r) => r.id) });
  const restricted = readers.length > 0;

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
    // Les personnes déjà nommées restent en tête : on les retire plus souvent qu'on ne les cherche.
    return [...rows].sort((a, b) => Number(picked.includes(b.id)) - Number(picked.includes(a.id)) || a.name.localeCompare(b.name));
  }, [people, query, picked]);

  const submit = async (ids: string[], okText: string) => {
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("id", documentId);
    for (const id of ids) fd.append("readerId", id);
    try {
      const r = await setLegalReaders(fd);
      setMsg({ ok: r.ok, text: r.ok ? okText : (r.error ?? "Les accès n'ont pas été enregistrés.") });
      if (r.ok) { setOpen(false); rafraichir(); }
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          {restricted ? <Lock className="h-4 w-4 text-warning" /> : <Unlock className="h-4 w-4 text-muted-foreground" />}
          Accès au document
        </CardTitle>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => { setOpen((o) => !o); setMsg(null); }}>
            <Shield className="h-4 w-4" /> {open ? "Fermer" : "Gérer les accès"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-medium">{caption}</p>
          {readers.length > 0 ? (
            <p className="mt-1 flex flex-wrap gap-1">
              {readers.map((r) => <Badge key={r.id} tone="info" dot={false}>{r.name}</Badge>)}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Toute personne ayant le module Legal — et l&apos;entité de ce document — peut l&apos;ouvrir.
              Nommez des lecteurs pour le réserver.
            </p>
          )}
          {depositorName && (
            <p className="mt-1 text-xs text-muted-foreground">
              Déposé par <strong>{depositorName}</strong>, qui y garde accès quoi qu&apos;il arrive.
            </p>
          )}
        </div>

        {/* CELUI QUI NE GÈRE PAS SAIT À QUI DEMANDER. Sans ce nom, on suppose une panne. */}
        {!canManage && <p className="text-xs text-muted-foreground">{readersManagerHint(depositorName)}</p>}

        {canManage && open && (
          <div className="space-y-2 rounded-xl border border-border bg-secondary/30 p-3">
            <p className="text-xs text-muted-foreground">
              Cochez qui peut ouvrir ce document. <strong>Aucun nom coché</strong> = visible de tout le module Legal.
              Le déposant et le Super Admin y gardent accès dans tous les cas.
            </p>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Chercher une personne…" aria-label="Chercher une personne"
                className="h-9 pl-7"
              />
            </label>
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background">
              {visible.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">Aucune personne à ce nom.</li>
              ) : visible.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <li key={p.id}>
                    <label className="flex min-h-10 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary sm:min-h-0">
                      <input
                        type="checkbox" checked={on} className="h-4 w-4 rounded border-input"
                        onChange={() => setPicked((prev) => (on ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                      />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{p.name}</span>
                      {on && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void submit(picked, picked.length > 0
                ? `${picked.length} personne(s) autorisée(s).`
                : "Restriction levée — le document est visible de tout le module.")}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />} Enregistrer les accès
              </Button>
              <span className="text-xs text-muted-foreground">
                {picked.length === 0 ? "Visible de tout le module Legal" : `${picked.length} lecteur(s) désigné(s)`}
              </span>
              {/* LEVER LA RESTRICTION est une décision, pas un oubli : elle a son propre bouton,
                  sa confirmation, et le journal retiendra qui l'a prise. */}
              {restricted && (
                <Button
                  size="sm" variant="outline" disabled={busy}
                  className="ml-auto"
                  onClick={async () => {
                    if (!(await confirmer("Rendre ce document visible de tout le module Legal ? Les lecteurs désignés seront retirés."))) return;
                    void submit([], "Restriction levée — le document est visible de tout le module.");
                  }}
                >
                  <Unlock className="h-4 w-4" /> Ouvrir à tout le module
                </Button>
              )}
            </div>
          </div>
        )}

        {msg && (
          <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
