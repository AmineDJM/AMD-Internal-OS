"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, Plus, Star, Trash2, Upload } from "lucide-react";
import { updateLetterhead, deleteLetterhead } from "@/lib/actions/letterhead-actions";
import { definirModeleDePiece, definirPapierParDefaut, televerserModele, televerserModeleDePiece } from "@/lib/actions/direction-artistique-actions";
import { KIND_EXTENSION, KIND_LABEL } from "@/lib/office/letterhead";
import { LIBELLE_TYPE_MODELE, TYPES_MODELE, type ModeleLu, type TypeModele } from "@/lib/direction-artistique/modeles";
import type { OfficeKind } from "@/lib/office-templates";
import { explorerSize } from "@/lib/drive/explorer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/types";

/**
 * LES GESTES DE LA DIRECTION ARTISTIQUE — une liste de modèles par type (Word, Excel, PowerPoint)
 * pour l'entité ouverte, et le choix du modèle de chaque nature de pièce. Le message affiché est
 * celui du serveur, refus compris. Tout dépôt est rattaché à l'entité ouverte (`companyId`).
 */

interface Droits { televerser: boolean; modifier: boolean; supprimer: boolean }

function Message({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return (
    <p className={cn("rounded-lg px-3 py-2 text-sm", r.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")} role="status">
      {r.ok ? r.message ?? "Enregistré." : r.error ?? "Échec."}
    </p>
  );
}

function useGeste() {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [resultat, setResultat] = React.useState<ActionResult | null>(null);
  const agir = async (cle: string, fn: () => Promise<ActionResult>) => {
    setBusy(cle); setResultat(null);
    const r = await fn();
    setBusy(null); setResultat(r);
    if (r.ok) router.refresh();
    return r;
  };
  return { busy, resultat, agir };
}

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** La liste des modèles d'un type (Word, Excel, PowerPoint) pour l'entité, et le dépôt d'un nouveau. */
export function PapeterieParType({
  companyId, kind, modeles, papierParDefautId, droits, aide,
}: {
  companyId: string;
  kind: OfficeKind;
  modeles: ModeleLu[];
  /** Word seulement : le papier par défaut de l'entité. */
  papierParDefautId?: string | null;
  droits: Droits;
  aide: string;
}) {
  const { busy, resultat, agir } = useGeste();
  const formRef = React.useRef<HTMLFormElement>(null);
  const ext = KIND_EXTENSION[kind];

  return (
    <div className="space-y-3" data-testid={`da-liste-${kind}`}>
      <p className="text-xs text-muted-foreground">{aide}</p>
      {modeles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Aucun modèle {KIND_LABEL[kind]} pour cette entité.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {modeles.map((m) => {
            const parDefaut = kind === "word" && papierParDefautId === m.id;
            return (
              <li key={m.id} className={cn("flex flex-wrap items-center gap-2 px-3 py-2", !m.isActive && "opacity-60")}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{m.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {m.companyId ? "Propre à l'entité" : "Commun au groupe"} · {explorerSize(m.size, true)}
                    {m.uploadedBy ? ` · déposé par ${m.uploadedBy}` : ""}
                  </span>
                </span>
                {parDefaut && <Badge tone="success">Par défaut</Badge>}
                {!m.isActive && <Badge tone="warning">Retiré</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  {kind === "word" && droits.modifier && m.isActive && !parDefaut && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} title="Définir comme papier par défaut de l'entité"
                      onClick={() => agir(`def-${m.id}`, () => definirPapierParDefaut(fd({ companyId, letterheadId: m.id })))}>
                      {busy === `def-${m.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />} Par défaut
                    </Button>
                  )}
                  {droits.modifier && (
                    <button type="button" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" disabled={busy !== null}
                      title={m.isActive ? "Retirer de la liste proposée" : "Reproposer"} aria-label={m.isActive ? "Retirer de la liste proposée" : "Reproposer"}
                      onClick={() => agir(`act-${m.id}`, () => updateLetterhead(fd({ id: m.id, isActive: m.isActive ? "0" : "1" })))}>
                      {busy === `act-${m.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : m.isActive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  )}
                  {droits.supprimer && (
                    <button type="button" className="rounded-lg p-2 text-destructive hover:bg-secondary" disabled={busy !== null}
                      title="Supprimer définitivement" aria-label="Supprimer définitivement"
                      onClick={() => {
                        if (!window.confirm(`Supprimer le modèle « ${m.name} » ? Les documents déjà créés dessus ne changent pas.`)) return;
                        void agir(`del-${m.id}`, () => deleteLetterhead(fd({ id: m.id })));
                      }}>
                      {busy === `del-${m.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {droits.televerser && (
        <form
          ref={formRef}
          className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:flex-wrap sm:items-end"
          action={async (f) => {
            f.set("companyId", companyId);
            f.set("kind", kind);
            const r = await agir(`up-${kind}`, () => televerserModele(undefined, f));
            if (r.ok) formRef.current?.reset();
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Fichier .{ext}
            <Input name="file" type="file" accept={`.${ext}`} required />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Nom affiché
            <Input name="name" placeholder="Vide : le nom du fichier" />
          </label>
          {kind === "word" && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" name="parDefaut" /> par défaut
            </label>
          )}
          <Button type="submit" size="sm" disabled={busy !== null}>
            {busy === `up-${kind}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Téléverser
          </Button>
        </form>
      )}
      <Message r={resultat} />
    </div>
  );
}

/** Le modèle Word de chaque nature de pièce : choisi dans la papeterie de l'entité, ou déposé exprès. */
export function ModelesDePieces({
  companyId, papiers, modelesParType, papierParDefautId, droits,
}: {
  companyId: string;
  papiers: { id: string; name: string; commun: boolean }[];
  modelesParType: Partial<Record<TypeModele, string>>;
  papierParDefautId: string | null;
  droits: Droits;
}) {
  const { busy, resultat, agir } = useGeste();
  const nomDefaut = papiers.find((p) => p.id === papierParDefautId)?.name ?? papiers[0]?.name ?? null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        La pièce émise par la plateforme porte le modèle de SA nature ; sans modèle dédié, le papier par défaut de l&apos;entité
        {nomDefaut ? ` (« ${nomDefaut} »)` : ""}. Un papier choisi à la main sur la pièce passe avant.
      </p>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {TYPES_MODELE.map((type) => {
          const actuel = modelesParType[type] ?? "";
          const actif = papiers.some((p) => p.id === actuel);
          return (
            <li key={type} className="space-y-2 px-3 py-3" data-testid={`da-modele-${type}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{LIBELLE_TYPE_MODELE[type]}</span>
                {actuel && !actif && <Badge tone="warning">modèle retiré — papier par défaut</Badge>}
                {droits.modifier ? (
                  <Select
                    className="ml-auto w-full sm:w-72" aria-label={`Modèle — ${LIBELLE_TYPE_MODELE[type]}`}
                    value={actif ? actuel : ""} disabled={busy !== null}
                    onChange={(e) => agir(`sel-${type}`, () => definirModeleDePiece(fd({ companyId, type, letterheadId: e.target.value })))}
                  >
                    <option value="">Papier par défaut de l&apos;entité</option>
                    {papiers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.commun ? " — commun au groupe" : ""}</option>)}
                  </Select>
                ) : (
                  <span className="ml-auto text-sm text-muted-foreground">{papiers.find((p) => p.id === actuel)?.name ?? "Papier par défaut de l'entité"}</span>
                )}
              </div>
              {droits.televerser && droits.modifier && (
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                  action={async (f) => {
                    f.set("companyId", companyId);
                    f.set("type", type);
                    await agir(`up-${type}`, () => televerserModeleDePiece(undefined, f));
                  }}
                >
                  <Input name="file" type="file" accept=".docx" required aria-label={`Modèle dédié — ${LIBELLE_TYPE_MODELE[type]}`} className="sm:flex-1" />
                  <Button type="submit" size="sm" variant="outline" disabled={busy !== null}>
                    {busy === `up-${type}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer un modèle dédié
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      <Message r={resultat} />
    </div>
  );
}
