"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { createPromoMessage, updatePromoMessage, deletePromoMessage } from "@/lib/actions/promo-message-actions";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { useAction } from "@/components/shared/use-action";
import { LETTRES_COMPTEES } from "@/lib/marketing-cockpit/calculs";
import type { Lettre } from "@/lib/segmentation/regles";
import { cn } from "@/lib/utils";
import { PastilleCompte, Pilule, Sparkline } from "./pastilles";

export interface MessageEcran {
  id: string;
  title: string;
  body: string | null;
  businessUnitId: string | null;
  productId: string | null;
  portee: string;
  isActive: boolean;
  sortOrder: number;
  /** Visites qui l'ont porté depuis toujours — décide entre archiver et supprimer. */
  usages: number;
  portesCycle: number;
  parLettre: Partial<Record<Lettre, number>>;
  delegues: number;
  tendance: number[];
}

const STICKY = "sticky left-0 z-[1] bg-card group-hover:bg-secondary";

/**
 * LES MESSAGES DE LA DIRECTION MARKETING, ET CE QU'ILS DEVIENNENT SUR LE TERRAIN (maquette validée, 07/10) : combien
 * de fois portés ce cycle, chez quelles lettres, par combien de délégués de la BU, la pente sur six mois, l'état.
 * Un message porté s'ARCHIVE (son historique reste) ; jamais porté, il se supprime.
 */
export function MessagesManager({
  titre, messages, deleguesBu, droits, bus, produits, defauts, cycle,
}: {
  titre: string;
  messages: MessageEcran[];
  deleguesBu: number;
  droits: { creer: boolean; modifier: boolean; retirer: boolean };
  bus: { id: string; name: string }[];
  produits: { id: string; nom: string }[];
  defauts: { businessUnitId: string | null; productId: string | null };
  cycle: string;
}) {
  const { busy, err, setErr, run: lancer } = useAction();
  const confirmer = useConfirmer();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageEcran | null>(null);

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => lancer(() => action(fd));

  const retirer = async (m: MessageEcran) => {
    const texte = m.usages > 0
      ? `Archiver « ${m.title} » ?\n\nIl quitte le menu des KAM. Ses ${m.usages} portage(s) restent dans l'historique.`
      : `Supprimer « ${m.title} » ?\n\nIl n'a jamais été porté : rien à garder.`;
    if (!(await confirmer(texte))) return;
    const fd = new FormData();
    fd.set("id", m.id);
    await run(deletePromoMessage, fd);
  };

  const reactiver = async (m: MessageEcran) => {
    const fd = new FormData();
    fd.set("id", m.id);
    fd.set("title", m.title);
    fd.set("body", m.body ?? "");
    fd.set("businessUnitId", m.businessUnitId ?? "");
    fd.set("productId", m.productId ?? "");
    fd.set("sortOrder", String(m.sortOrder));
    fd.append("isActive", "off");
    fd.append("isActive", "on");
    await run(updatePromoMessage, fd);
  };

  const fermer = () => { setCreating(false); setEditing(null); };

  return (
    <section className="surface overflow-hidden rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
          {titre}
          <InfoBulle label="Comment lire ce tableau">
            Portés : visites de {cycle} où le KAM a choisi ce message dans son rapport. Lettres : celles des médecins vus.
            Délégués : KAM de la BU qui l&apos;ont porté. Un message porté s&apos;archive au lieu d&apos;être effacé.
          </InfoBulle>
        </h2>
        {droits.creer && (
          <Button size="sm" onClick={() => { setErr(null); setCreating(true); }} disabled={busy}>
            <Plus className="h-4 w-4" /> Nouveau message
          </Button>
        )}
      </header>

      {err && <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p>}

      {messages.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Aucun message pour ce périmètre.</p>
      ) : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className={cn("px-3 py-2 font-medium", "sticky left-0 z-[1] bg-card")}>Message</th>
                <th className="px-3 py-2 text-right font-medium">Portés ce cycle</th>
                <th className="px-3 py-2 font-medium">Sur quelles lettres</th>
                <th className="px-3 py-2 text-center font-medium">Délégués</th>
                <th className="px-3 py-2 font-medium">Tendance</th>
                <th className="px-3 py-2 font-medium">État</th>
                {(droits.modifier || droits.retirer) && <th className="w-10 px-2 py-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => {
                const lettres = LETTRES_COMPTEES.filter((l) => (m.parLettre[l] ?? 0) > 0);
                const faible = m.isActive && deleguesBu >= 2 && m.delegues < deleguesBu / 2;
                return (
                  <tr key={m.id} className="group border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className={cn("max-w-[280px] px-3 py-2.5", STICKY)}>
                      <span className={cn("block font-medium [overflow-wrap:anywhere]", !m.isActive && "text-muted-foreground")}>{m.title}</span>
                      <span className="block text-xs text-muted-foreground">{m.portee}</span>
                    </td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 text-right tabular-nums", !m.isActive ? "text-muted-foreground" : faible && "text-warning")}>
                      {m.isActive || m.portesCycle ? m.portesCycle : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {lettres.length ? (
                        <span className="flex gap-1">{lettres.map((l) => <PastilleCompte key={l} lettre={l} n={m.parLettre[l] ?? 0} />)}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center tabular-nums">
                      {m.isActive || m.delegues ? `${m.delegues} / ${deleguesBu}` : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5"><Sparkline valeurs={m.tendance} label={`Portages des six derniers mois : ${m.tendance.join(", ")}`} /></td>
                    <td className="px-3 py-2.5">{m.isActive ? <Pilule ton="ok">actif</Pilule> : <Pilule ton="muet">archivé</Pilule>}</td>
                    {(droits.modifier || droits.retirer) && (
                      <td className="px-2 py-1.5">
                        <MenuDossier>
                          {droits.modifier && (
                            <button type="button" role="menuitem" className="rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary" onClick={() => { setErr(null); setEditing(m); }}>
                              Modifier
                            </button>
                          )}
                          {droits.modifier && !m.isActive && (
                            <button type="button" role="menuitem" className="rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary" onClick={() => void reactiver(m)} disabled={busy}>
                              Réactiver
                            </button>
                          )}
                          {droits.retirer && (m.isActive || m.usages === 0) && (
                            <button type="button" role="menuitem" className="rounded-md px-2.5 py-2 text-left text-sm text-destructive hover:bg-destructive/10" onClick={() => void retirer(m)} disabled={busy}>
                              {m.usages > 0 ? "Archiver" : "Supprimer"}
                            </button>
                          )}
                        </MenuDossier>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet
        open={creating || editing !== null}
        onClose={fermer}
        title={editing ? `Message « ${editing.title} »` : "Nouveau message"}
        description="L'intitulé est ce que le KAM lit dans son menu déroulant : une consigne, pas un titre de dossier."
        width="md"
      >
        <form
          key={editing?.id ?? "nouveau"}
          className="space-y-3"
          action={async (fd) => {
            if (editing) fd.set("id", editing.id);
            const ok = await run(editing ? updatePromoMessage : createPromoMessage, fd);
            if (ok) fermer();
          }}
        >
          <div>
            <Label htmlFor="msg-title">Intitulé</Label>
            <Input id="msg-title" name="title" required defaultValue={editing?.title ?? ""} placeholder="Insister sur la tolérance hépatique" />
          </div>
          <div>
            <Label htmlFor="msg-body">Texte complet (facultatif)</Label>
            <Textarea id="msg-body" name="body" rows={3} defaultValue={editing?.body ?? ""} placeholder="L'argument, les chiffres à citer, la référence de l'étude." />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="msg-product">Produit</Label>
              <Select id="msg-product" name="productId" defaultValue={editing ? editing.productId ?? "" : defauts.productId ?? ""}>
                <option value="">Tous les produits</option>
                {produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="msg-bu">Gamme</Label>
              <Select id="msg-bu" name="businessUnitId" defaultValue={editing ? editing.businessUnitId ?? "" : defauts.businessUnitId ?? ""}>
                <option value="">Toutes les gammes</option>
                {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="msg-order">Ordre d&apos;affichage</Label>
              <Input id="msg-order" name="sortOrder" type="number" inputMode="numeric" defaultValue={String(editing?.sortOrder ?? 0)} />
            </div>
          </div>
          {editing && (
            <label className="flex min-h-10 items-center gap-2 text-sm sm:min-h-0">
              {/* Le témoin caché fait qu'une case DÉCOCHÉE envoie « off » : sans lui, décocher n'aurait aucun effet. */}
              <input type="hidden" name="isActive" value="off" />
              <input type="checkbox" name="isActive" value="on" defaultChecked={editing.isActive} className="h-4 w-4 rounded border-input" />
              Actif (proposé aux KAM)
            </label>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={fermer} disabled={busy}>Annuler</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Enregistrer" : "Publier"}
            </Button>
          </div>
        </form>
      </Sheet>
    </section>
  );
}
